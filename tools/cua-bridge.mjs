#!/usr/bin/env node
/**
 * cua-bridge: drive the Windows Computer Use helper directly, over its own
 * named pipe, with approval prompts answered from a terminal.
 *
 * WHY THIS EXISTS
 * The `computer-use@openai-bundled` plugin reaches its native helper through
 * the `node_repl` MCP server using freeform `@oai/sky` calls. An
 * OpenAI-compatible bridge that only speaks chat/completions does not forward
 * freeform tools, so that path is unavailable there. This tool speaks the
 * helper's documented JSON-RPC protocol itself.
 *
 * PROTOCOL (read from @oai/sky v0.7.6 Windows client source)
 *   - Length-prefixed frames: 4-byte little-endian length, then JSON body.
 *   - Request:  {id, jsonrpc:"2.0", method:"request",
 *                params:{method:<sky method>, params:<args>, codexTurnMetadata}}
 *   - Approval: the helper may push
 *                {id:"computer-use-approval:...", method:"requestComputerUseApproval",
 *                 params:{message, meta:{tool_params, persist:[...]}}}
 *                which must be answered with a result frame echoing that id.
 *
 * SAFETY: this tool deliberately refuses the input categories the plugin's own
 * guidance marks as non-negotiable, and asks before anything that mutates UI.
 * It is a narrow command runner, not an autonomous agent.
 */

import net from "node:net";
import fs from "node:fs";
import { createInterface } from "node:readline";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const ALLOWED_METHODS = new Set([
  "list_apps",
  "list_windows",
  "get_window",
  "get_window_state",
  "activate_window",
  "click",
  "scroll",
]);

/** Methods the plugin's guidance forbids this tool from ever issuing. */
const DENIED_METHODS = new Map([
  ["press_key", "keyboard input is refused by this tool"],
  ["type_text", "keyboard input is refused by this tool"],
  ["drag", "drag input is refused by this tool"],
  ["set_value", "value mutation is refused by this tool"],
  ["perform_secondary_action", "secondary actions are refused by this tool"],
]);

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

// --------------------------------------------------------------------------
// Framing
// --------------------------------------------------------------------------

function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`frame too large: ${payload.length} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------

/**
 * The helper does not listen on the `SKY_CUA_NATIVE_PIPE_DIRECTORY` value from
 * config.toml; that path belongs to a per-process instance. The live helper
 * pipe is found by scanning the pipe namespace and confirmation-probing each
 * candidate, so a stale pipe cannot be mistaken for the active one.
 */
function discoverHelperPipes() {
  const explicit = process.env.CUA_PIPE?.trim();
  if (explicit) return [explicit];
  const prefix = process.env.CUA_PIPE_PREFIX?.trim() || "codex-computer-use-";
  try {
    return fs
      .readdirSync("\\\\.\\pipe\\")
      .filter((name) => name.startsWith(prefix))
      .map((name) => `\\\\.\\pipe\\${name}`);
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------
// Terminal prompting
// --------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stderr });

function ask(question) {
  return rl.question(question);
}

function confirm(question) {
  return ask(`${question} [y/N] `).then((answer) => /^y(es)?$/i.test(answer.trim()));
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

class CuaClient {
  #socket = null;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();
  #pipePath;

  constructor(pipePath) {
    this.#pipePath = pipePath;
  }

  get pipePath() {
    return this.#pipePath;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.#pipePath);
      const onFail = (error) => {
        socket.destroy();
        reject(new Error(`connect ${this.#pipePath}: ${error.code || error.message}`));
      };
      socket.once("error", onFail);
      socket.once("connect", () => {
        socket.off("error", onFail);
        socket.on("error", () => {});
        socket.on("data", (chunk) => this.#onData(chunk));
        this.#socket = socket;
        resolve();
      });
    });
  }

  close() {
    this.#socket?.end();
    this.#socket = null;
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > 64 * 1024 * 1024) {
        throw new Error(`helper sent an oversized frame: ${length}`);
      }
      if (this.#buffer.length < length + 4) return;
      const body = this.#buffer.subarray(4, length + 4).toString("utf8");
      this.#buffer = this.#buffer.subarray(length + 4);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message?.method === "requestComputerUseApproval" && typeof message.id === "string") {
      this.#handleApproval(message);
      return;
    }
    const id = Number(message?.id);
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "helper returned an error"));
    } else {
      pending.resolve(message.result);
    }
  }

  async #handleApproval(message) {
    const params = message.params || {};
    const meta = params.meta || {};
    const lines = ["", "  the helper is asking for approval:", `    ${params.message || "(no message)"}`];
    if (meta.connector_name) lines.push(`    connector: ${meta.connector_name}`);
    for (const entry of meta.tool_params_display || []) {
      lines.push(`    ${entry.display_name || entry.name}: ${entry.value}`);
    }
    if (Array.isArray(meta.persist) && meta.persist.length) {
      lines.push(`    may be remembered for: ${meta.persist.join(", ")}`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
    process.stderr.write(
      "    note: this build answers each prompt once and never persists a grant\n",
    );
    const allow = await confirm("    allow this?");
    const frame = allow
      ? { id: message.id, jsonrpc: "2.0", result: { action: "accept" } }
      : {
          id: message.id,
          jsonrpc: "2.0",
          error: { code: -32001, message: "denied by the user" },
        };
    this.#socket?.write(encodeFrame(frame));
    process.stderr.write(allow ? "    approved\n" : "    denied\n");
  }

  request(method, params) {
    if (DENIED_METHODS.has(method)) {
      return Promise.reject(new Error(DENIED_METHODS.get(method)));
    }
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`method not supported by this tool: ${method}`));
    }
    const id = this.#nextId++;
    const envelope = {
      id,
      jsonrpc: "2.0",
      method: "request",
      params: {
        codexTurnMetadata: { thread_id: "cua-bridge", turn_id: `turn-${id}` },
        method,
        params,
      },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`no answer to ${method} within ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.write(encodeFrame(envelope));
    });
  }
}

// --------------------------------------------------------------------------
// Probing and selection
// --------------------------------------------------------------------------

async function probePipe(pipePath) {
  const client = new CuaClient(pipePath);
  try {
    await client.connect();
    const apps = await client.request("list_apps", {});
    client.close();
    return { client: null, apps };
  } catch (error) {
    client.close();
    return { error: error.message };
  }
}

async function connectToLiveHelper() {
  const candidates = discoverHelperPipes();
  if (candidates.length === 0) {
    fail(
      "no computer-use helper pipe found.\n" +
        "hint: the helper is hosted by the running Codex desktop app; start it, or set CUA_PIPE to a known pipe path.",
    );
  }
  const attempts = [];
  for (const pipePath of candidates) {
    const probe = await probePipe(pipePath);
    if (probe.apps) {
      const client = new CuaClient(pipePath);
      await client.connect();
      return { client, apps: probe.apps, pipePath, attempts };
    }
    attempts.push({ pipePath, error: probe.error });
  }
  const detail = attempts.map((a) => `  ${a.pipePath}: ${a.error}`).join("\n");
  fail(`none of the helper pipes answered list_apps:\n${detail}`);
}

function pickWindow(apps, appQuery, titleQuery) {
  const appNeedle = String(appQuery).toLowerCase();
  const matches = [];
  for (const app of apps) {
    const appHit =
      String(app.id || "").toLowerCase().includes(appNeedle) ||
      String(app.displayName || "").toLowerCase().includes(appNeedle);
    if (!appHit) continue;
    for (const window of app.windows || []) {
      if (
        titleQuery != null &&
        !String(window.title || "").toLowerCase().includes(String(titleQuery).toLowerCase())
      ) {
        continue;
      }
      matches.push({ app, window });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `no open window matched app="${appQuery}"` +
        (titleQuery != null ? ` title~="${titleQuery}"` : ""),
    );
  }
  if (matches.length > 1) {
    const rendered = matches
      .map(({ app, window }) => `    app=${app.id}  window=${window.id}  title=${JSON.stringify(window.title ?? "")}`)
      .join("\n");
    throw new Error(`matched ${matches.length} windows; narrow it down:\n${rendered}`);
  }
  return matches[0];
}

// --------------------------------------------------------------------------
// Output shaping
// --------------------------------------------------------------------------

function shapeWindowState(state, includeScreenshot) {
  const out = { window: state?.window ?? null };
  const accessibility = state?.accessibility;
  if (accessibility) {
    out.focused_element = accessibility.focused_element || null;
    out.selected_text = accessibility.selected_text || null;
    out.document_text = accessibility.document_text || null;
    out.tree = accessibility.tree || null;
  }
  const shots = state?.screenshots || [];
  out.screenshot_count = shots.length;
  if (includeScreenshot && shots.length) {
    out.screenshots = shots.map((shot) => ({
      id: shot.id,
      width: shot.width,
      height: shot.height,
      originX: shot.originX,
      originY: shot.originY,
      url_bytes: String(shot.url || "").length,
    }));
  }
  return out;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const USAGE = `cua-bridge: drive the Windows Computer Use helper over its named pipe

usage:
  cua-bridge.mjs list
  cua-bridge.mjs windows
  cua-bridge.mjs state --app <query> [--title <query>] [--text] [--screenshot]
  cua-bridge.mjs click --app <query> [--title <query>] (--index <n> | --x <n> --y <n>)
  cua-bridge.mjs scroll --app <query> [--title <query>] --x <n> --y <n> --dy <n> [--dx <n>]
  cua-bridge.mjs activate --app <query> [--title <query>]

notes:
  - read-only commands (list, windows, state) never need approval
  - click / scroll / activate ask for approval in this terminal first
  - keyboard input is intentionally not implemented by this tool
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (value == null || value === true) fail(`--${name} is required`);
  return value;
}

function requireNumber(flags, name) {
  const raw = requireFlag(flags, name);
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${name} must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || command === "help" || flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  const { client, pipePath, apps: initialApps } = await connectToLiveHelper();

  const resolveWindow = (apps, flags_) => {
    const app = requireFlag(flags_, "app");
    const title = flags_.title === true ? undefined : flags_.title;
    return pickWindow(apps, app, title).window;
  };

  try {
    switch (command) {
      case "list": {
        printJson({
          pipe: pipePath,
          apps: initialApps.map((app) => ({
            id: app.id,
            displayName: app.displayName,
            isRunning: app.isRunning,
            windows: (app.windows || []).map((window) => ({
              id: window.id,
              title: window.title,
            })),
          })),
        });
        return;
      }

      case "windows": {
        const windows = await client.request("list_windows", {});
        printJson({ pipe: pipePath, windows });
        return;
      }

      case "state": {
        const window = resolveWindow(initialApps, flags);
        const wantText = Boolean(flags.text);
        const wantShot = Boolean(flags.screenshot);
        if (!wantText && !wantShot) {
          process.stderr.write(
            "note: neither --text nor --screenshot was given, so the request carries no observable payload\n",
          );
        }
        const state = await client.request("get_window_state", {
          window,
          include_screenshot: wantShot,
          include_text: wantText,
        });
        printJson(shapeWindowState(state, wantShot));
        return;
      }

      case "click": {
        const window = resolveWindow(initialApps, flags);
        const target =
          flags.index != null && flags.index !== true
            ? { element_index: requireNumber(flags, "index") }
            : { x: requireNumber(flags, "x"), y: requireNumber(flags, "y") };
        const describe =
          "element_index" in target
            ? `element index ${target.element_index}`
            : `coordinates (${target.x}, ${target.y})`;
        const ok = await confirm(
          `about to click in app="${flags.app}" window=${window.id} at ${describe}.\n    the helper may then ask for app-level approval. proceed?`,
        );
        if (!ok) {
          process.stderr.write("aborted before sending any input\n");
          return;
        }
        await client.request("click", { window, ...target });
        printJson({ clicked: { window: window.id, ...target } });
        return;
      }

      case "scroll": {
        const window = resolveWindow(initialApps, flags);
        const payload = {
          window,
          x: requireNumber(flags, "x"),
          y: requireNumber(flags, "y"),
          scrollX: flags.dx != null && flags.dx !== true ? requireNumber(flags, "dx") : 0,
          scrollY: requireNumber(flags, "dy"),
        };
        const ok = await confirm(
          `about to scroll in app="${flags.app}" window=${window.id} by (dx=${payload.scrollX}, dy=${payload.scrollY}).\n    the helper may then ask for app-level approval. proceed?`,
        );
        if (!ok) {
          process.stderr.write("aborted before sending any input\n");
          return;
        }
        await client.request("scroll", payload);
        printJson({ scrolled: payload });
        return;
      }

      case "activate": {
        const window = resolveWindow(initialApps, flags);
        const ok = await confirm(
          `about to bring app="${flags.app}" window=${window.id} to the foreground. proceed?`,
        );
        if (!ok) {
          process.stderr.write("aborted before sending any input\n");
          return;
        }
        await client.request("activate_window", { window });
        printJson({ activated: window.id });
        return;
      }

      default:
        fail(`unknown command: ${command}\n\n${USAGE}`);
    }
  } finally {
    client.close();
    rl.close();
  }
}

main().catch((error) => {
  fail(error.message);
});
