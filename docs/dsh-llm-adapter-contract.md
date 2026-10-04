# dsh `llm` service — adapter contract for a local OpenAI-compatible endpoint

Target: a dsh plugin that registers the route `local-openai` backed by
`http://127.0.0.1:8790/v1/chat/completions` (SSE streaming only, local token header, no OAuth).

**Provenance.** Every claim below was read from the unpacked application bundle
`E:\harness\resources\app.asar` (inner prefix `/dsh/...`) or from the live Host inspect oracle.
Paths are written relative to the asar root, e.g.
`node_modules/@deepseek-ai/dsh-llm/lib/index.js:1833`. The live `llm` service contract was read with
`cordis_inspect_query {platform: host, provider: Service, method: listService, input: {service: "llm"}}`;
its TypeScript declarations (quoted verbatim below as *oracle*) are authoritative for signatures.
Where a shipped `.d.ts` would be the source of truth note that **no `.d.ts` file is packaged at all**
(`node_modules/@deepseek-ai/dsh-llm/**/*.d.ts` → 0 matches), so interface declarations come from the
oracle plus the compiled runtime.

Primary references read in full:
`node_modules/@deepseek-ai/dsh-llm-pi-ai/README.md` (247 lines, read fully),
`.../dsh-llm-pi-ai/lib/index.js` (2639 lines, read in full for the cited regions),
`.../dsh-llm/README.md` (178 lines, read fully),
`.../dsh-llm/lib/index.js` (2390 lines, read in full for the cited regions),
`.../dsh-llm/lib/types/{adapter-failure,retry-policy,error,assembler,message}.js`,
`.../dsh-llm-deepseek/lib/index.js` and `.../dsh-llm-deepseek-api-key/lib/index.js` (the direct-fetch twin —
the closest published template for a hand-written wire adapter),
`.../dsh-llm-retry/README.md`, `.../dsh-client-ui-settings-models/README.md`,
`.../dsh-client-ui-model-selection/README.md`, `.../dsh-agent-default-model/README.md`,
`.../dsh-token-meter/README.md`, `.../dsh-credentials/lib/index.js`,
`.../@earendil-works/pi-ai/dist/api/openai-completions.js` (the only OpenAI Chat-Completions wire code in the bundle).

---

## 0. The service in one screen

```ts
// oracle: host/Service/listService("llm") — verbatim
export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo;
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
    imageRequestPricing(_provider: string, _model: string): LlmImageRequestPricing | undefined;
    listModels(_provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

Only `stream` is `abstract`. Every other method has a real default
(`node_modules/@deepseek-ai/dsh-llm/lib/index.js:1670-1740`):

| method | default | line |
|---|---|---|
| `providerInfo(provider)` | `{ id: provider, name: provider }` | 1676 |
| `providerRetryPolicy(_provider)` | `undefined` → runtime substitutes normal/5-retry defaults | 1687 |
| `imageRequestPricing(_provider, _model)` | `undefined` | 1697 |
| `listModels(_provider)` | `Promise.resolve([])` | 1706 |
| `resolveModel(provider, model, _signal)` | `Promise.resolve({provider, id: model, name: model})` | 1718 |
| `prepareCall(provider, model, signal)` | `{ model: await this.resolveModel(...), stream: o => this.stream(o) }` | 1734 |

```ts
// oracle, verbatim
export interface GenerateOptions {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
    messages: RequestMessage[];
    system?: string;
    tools?: ToolSchema[];
    toolHistory?: ToolHistory;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
    sessionId?: Branded<'SessionId'>;
    purpose?: 'compaction' | 'session-title';
}
```

Lifecycle: one `stream()` call is **one provider attempt**. `dsh-llm` never retries
(`dsh-llm/README.md:74`, `:157`); `@deepseek-ai/dsh-llm-retry` re-runs the failed *step* at the agent
loop's `agent/request-error` waterfall (`dsh-llm-retry/README.md:72-73`). Direct `ctx.llm.stream()`
callers stay single-attempt.

---

## 1. Registration

### 1.1 `registerAdapter(providers, adapter)`

```ts
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
// oracle: "Register an adapter for the given provider routes. Throws `LlmError` with code
//          `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
//          Disposed with the fiber."
export interface AdapterRegistrationHandle {
    (): void;
    replace(providers: string[]): void;
}
```

Implementation: `node_modules/@deepseek-ai/dsh-llm/lib/index.js:1833-1852`. Exact validation performed
**synchronously at registration**, in `prepareRoutes` (`:1858-1878`):

1. `providers.length === 0` → `LlmError(..., 'INVALID_ADAPTER')` (`:1837`).
2. Per provider: `provider.length === 0` → `INVALID_ADAPTER` (`:1862`).
3. Per provider: `unique.has(provider) || this.adapters.has(provider) && !owned.has(provider)` →
   `DUPLICATE_ADAPTER` (`:1863`). So a duplicate inside your own array *and* a collision with another
   adapter's route both fail. Nothing is mutated when any entry fails (`commitRoutes` runs last, `:1886`).
4. **`adapter.providerInfo(provider)` is called here, eagerly** (`:1864`). It must be synchronous and
   return `{ id, name }` with `info.id === provider` and `typeof info.name === 'string' && info.name.length > 0`,
   else `LlmError('adapter metadata for provider "..." must preserve its id and have a non-empty name', 'INVALID_ADAPTER')` (`:1865`).
5. **`adapter.providerRetryPolicy(provider)` is called here too** (`:1867`) and its result is captured into
   the registration record. `undefined` → `resolveRetryPolicy(undefined, ...)` → normal mode, 5 retries
   (`dsh-llm/lib/types/retry-policy.js:84-92`). Because it is captured once, a policy change needs
   `handle.replace(routes)` — this is exactly what `dsh-llm-deepseek` does on `loader/volatile-update`
   (`dsh-llm-deepseek/lib/index.js:2267-2280`) and what `llm-pi-ai` does via `ensureRegistrationFacts`
   (`dsh-llm-pi-ai/lib/index.js:2612-2627`).

Registration is disposed with the fiber (`ctx.effect(...)`, `:1836`). `handle.replace(providers)` releases
and re-adds in one synchronous section and emits `llm/adapters-updated` (`:1847-1850`, `:1886-1894`).
After disposal `replace` throws `REGISTRATION_DISPOSED` (`:1848`).

`ctx.llm.listProviders(): LlmProviderInfo[]` returns `[{id, name}]` in registration order (`:1899-1901`),
so `providerInfo().name` is the display name the rest of the system sees for a registered route
(`node_modules/@deepseek-ai/dsh-llm/lib/index.js:1900`). This is also what a provider-grouped picker can
label a group with (see §1.4).

### 1.2 Provider id naming rules

The `llm` service itself enforces exactly one rule: **the id must be a non-empty string** (`:1862`). Two
adjacent grammars constrain it in practice:

* **Credential *reference* grammar** (an `apiKeyEnv`-style env-var name):
  `/^[A-Za-z_][A-Za-z0-9_]*$/` — `node_modules/@deepseek-ai/dsh-credentials/lib/index.js:13`,
  enforced by `credentialRef()` (`:21-24`, throws `TypeError`).
* **Stored-credential *record* grammar** (a `<scope>/<id>` key segment):
  `/^[a-z][a-z0-9-]*$/` — `node_modules/@deepseek-ai/dsh-credentials/lib/index.js:15`,
  predicate `isCredentialKeySegment` (`:46-48`). `llm-pi-ai` refuses a sign-in for a route outside it with
  `LlmError(..., 'UNSTORABLE_PROVIDER_ID')` (`dsh-llm-pi-ai/lib/index.js:2059`; README:95).

Practical consequence for a local route:

* `local-openai` is a legal id and a legal record segment.
* If you want the Web Models page to derive a credential reference for the row, it derives
  `<ROUTE>_API_KEY` when the profile names none (`dsh-client-ui-settings-models/README.md:44`). A hyphen
  in the route survives into that string and would break the `^[A-Za-z_][A-Za-z0-9_]*$` reference
  grammar, so prefer an underscore-only or hyphen-free route id if you rely on that derivation. Give the
  profile an explicit `apiKeyEnv` and the question disappears.
* The route id is also a settings-dict key (`providers` dict key in `llm-pi-ai`) and a `settingsPath`
  segment; `registerConfigurableProviders` only requires non-empty segments (`dsh-llm/lib/index.js:1925`).

**UNVERIFIED:** there is no published grammar for provider route ids beyond "non-empty"; the two regexes
above are the only enforced adjacent grammars found in the bundle.

### 1.3 `registerConfigurableProviders(entries)`

```ts
registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle

// oracle, verbatim
export interface LlmConfigurableProvider {
    provider: string;
    displayName: string;
    settingsNs: string;
    settingsPath: readonly string[];
    declared?: boolean;
    error?: string;
}
export interface DirectoryRegistrationHandle {
    (): void;
    replace(entries: readonly LlmConfigurableProvider[]): void;
}
```

Validation (`node_modules/@deepseek-ai/dsh-llm/lib/index.js:1910-1953`):

* empty `entries` → `INVALID_DIRECTORY` (`:1938`);
* `entry.provider`, `entry.displayName`, `entry.settingsNs` must each be non-empty → `INVALID_DIRECTORY` (`:1924`);
* every `settingsPath` segment must be non-empty (`[]` is legal) → `INVALID_DIRECTORY` (`:1925`);
* an entry whose `provider` is already declared by another registration, or repeated within the candidate
  set → `DUPLICATE_DIRECTORY` (`:1926`).

`listConfigurableProviders(): LlmConfigurableProvider[]` returns detached entries in declaration order
(`:1958-1963`). `handle.replace(next)` validates the whole candidate set then swaps, so a refused change
leaves the previous entries serving (`:1920-1936`, `:1948-1951`).

**`settingsNs` / `settingsPath` meaning.** `settingsNs` is the *settings namespace* — the key a
configuration surface holds to address this provider family. `settingsPath` is the path **inside that
settings section** at which one provider's profile lives. Two shipped spellings:

| plugin | `settingsNs` | `settingsPath` | meaning |
|---|---|---|---|
| `dsh-llm-deepseek-api-key` (`lib/index.js:41-46`) | `ctx.fiber.entry?.options.id ?? 'llm-deepseek-api-key'` | `[]` | the whole section *is* this provider's profile |
| `dsh-llm-pi-ai` (`lib/index.js:2513-2528`) | `ctx.fiber.entry?.options.id ?? 'llm-pi-ai'` | `['providers', provider]` | one key in a multi-provider dict |

`settingsNs` is also the **key for model discovery**: `registerModelDiscovery(settingsNs, discover)`
(`:1974-1984`), and `discoverModels(settingsNs, request, signal)` looks the offer up by that namespace
(`:1995-1997`) — the rationale is documented at `:1964-1973`: a configuration surface already holds the
namespace from the directory, and a provider being *added* has no route to name yet.

**Is it required for a plugin with no settings UI?** No — `registerAdapter` is fully independent of the
directory. But it is the only thing that gives the route a settings address, and the Models page is built
entirely on that address:

* "Undeclared live routes render nowhere — a route registered without a configurable-provider declaration
  has no settings address; it stays visible in pickers but not on this page's rows."
  (`dsh-client-ui-settings-models/README.md:130`)
* "Add actions are offered only for registered settings namespaces" (`:36`); a mode of the Add-provider
  card is offered "only while its namespace is mounted" (`:56`).
* The page "joins the provider directory, the settings document, and the credential descriptions into one
  shared snapshot" (`:14`), and the first-run readiness check reads that same joined snapshot (`:60`).

So: omit it only if you are content with the route being invisible to Models settings, its API key
uneditable in the GUI, and the custom-API add form unavailable for it. **Recommendation: declare it.**
It is three lines.

### 1.4 How the provider shows up in the model selector

* **Catalog membership is mandatory for the GUI.** "The GUI requires catalog membership for selection and
  submission; adapters intended for GUI use must implement `listModels` and advertise their available
  models. The base implementation returns an empty list and therefore offers no GUI models."
  (`dsh-llm/README.md:28`). Same text in the adapter JSDoc at `dsh-llm/lib/index.js:1698-1708`.
* Both selection entries (`/model` popup and the composer model seat) "group models by provider"
  (`dsh-client-ui-model-selection/README.md:44`); group order is DeepSeek Account first, DeepSeek second,
  third-party providers in catalog order (`:44`; `dsh-client-ui-settings-models/README.md:32`).
* "a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row
  until reload" (`:102`). Both `listModels` **and** `resolveModel` must succeed for every advertised model.
* The reasoning-effort row is driven purely by `LlmResolvedModelInfo.reasoning`: "An adapter without
  reasoning metadata leaves the Effort row absent; there is no arbitrary effort input" (`:44`, `:103`).
* Names are presentation-only; selection and persistence use `provider/model/effort` ids (`:102`).

**UNVERIFIED:** which exact field the picker renders as the provider group heading (most likely
`LlmProviderInfo.name` from `ctx.llm.listProviders()`, since the client bundle
`dsh-client-ui-model-selection/lib/client.js` contains no `listProviders`/`resolveModelInfo`/`displayName`
symbols and reads a Host-built directory through `session.models`; the Host-side builder of that directory
was not located). Both plausible sources exist: `listProviders()` (`:1899`, `@Remote`) and the directory's
`displayName`. Set both to the same string and the question is moot.

---

## 2. Config schema

### 2.1 Which schema library, and how the plugin declares it

`@deepseek-ai/schemastery` (`~3.18.4`), imported as `import z from '@deepseek-ai/schemastery'`
(`dsh-llm-pi-ai/package.json:43`; `dsh-llm-pi-ai/lib/index.js:1-16`). The plugin module exports
`Config` as a named export alongside `name`, `inject`, `apply`
(`dsh-llm-pi-ai/lib/index.js:2639`) — the Cordis loader reads it. The **live projected JSON Schema** of a
mounted plugin is readable with the Host `Config` inspect provider
(`{platform: host, provider: Config, method: listConfigs, input: {entry: "include:llm-pi-ai"}}`), which is
how you can diff an authored schema against what a settings surface actually sees.

### 2.2 `dsh-llm-pi-ai`'s exact schema

Authored at `node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:940-1051`:

```js
// :1051  — the outermost shape
const Config = z.object({ providers: z.dict(profile).default({}).volatile() });

// :1017-1049
const profile = z.object({
  apiKeyEnv:            z.string().role('credential-ref'),   // :1018
  displayName:          z.string(),                          // :1019
  api:                  z.union(supportedProtocols()),       // :1020  'openai-completions' | 'openai-responses' | 'anthropic-messages'
  baseURL:              z.string(),                          // :1021
  models:               z.array(modelProfile),               // :1022
  modelOverrides:       z.dict(modelOverride),               // :1023
  compat:               compatProfile,                       // :1024
  defaultContextWindow: z.number().step(1).min(1).default(262144),   // :1025, DEFAULT_CONTEXT_WINDOW :927
  defaultMaxTokens:     z.number().step(1).min(1).default(32768),    // :1026, DEFAULT_MAX_TOKENS :929
  defaultInput:         z.array(z.union(MODALITIES)).default(['text']), // :1027, DEFAULT_INPUT :940
  headers:              z.dict(z.string()),                  // :1028
  reasoning:            z.union(THINKING_LEVELS),            // :1029
  thinkingBudgets,                                           // :1030, :941-946 {minimal,low,medium,high}: number
  cacheRetention:       z.union(['none','short','long']),    // :1031-1035
  transport:            z.union(['sse','websocket','websocket-cached','auto']), // :1036-1041
  timeoutMs:            z.natural(),                         // :1042
  websocketConnectTimeoutMs: z.natural(),                    // :1043
  streamIdleTimeoutMs:  z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS)
                          .default(300_000),                 // :1044, DEFAULT_STREAM_IDLE_TIMEOUT_MS :911
  maxRequestImageBytes: z.number().step(1).min(1).default(20*1024*1024),  // :1045, :921
  requestImagePixelBudget: z.number().step(1).min(1).default(2048*2048),  // :1046, :923
  requestImageMaxBytes: z.number().step(1).min(1).default(1024*1024),     // :1047, :925
  retryPolicy:          RetryPolicySchema,                   // :1048
});

// :1003-1010  the shared model fields
const modelFields = {
  name:             z.string(),
  contextWindow:    z.number().step(1).min(1),
  maxTokens:        z.number().step(1).min(1),
  input:            z.array(z.union(MODALITIES)),            // MODALITIES = ['text','image'] (:279-282)
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat:           compatProfile,
};
// :1011-1014
const modelProfile  = z.object({ id: z.string().required(), ...modelFields });
// :1016
const modelOverride = z.object(modelFields);                 // id lives in the dict key
// :1001 — keys are the offered levels, values the wire spellings
const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS));
// THINKING_LEVELS (:296-304) = off, minimal, low, medium, high, xhigh, max
```

`compatProfile` (`:963-990`) is the wire-compatibility switch bag; the ones that matter for a local
OpenAI-compatible endpoint are `supportsDeveloperRole` (`:965`), `maxTokensField: 'max_tokens' |
'max_completion_tokens'` (`:969`, `MAX_TOKENS_FIELDS` at `:320-323`), `supportsUsageInStreaming` (`:967`),
`supportsFinishReason` (`:968`), `requiresToolResultName` (`:970`), `requiresAssistantAfterToolResult`
(`:971`), `requiresThinkingAsText` (`:972`), `requiresReasoningContentOnAssistantMessages` (`:973`),
`thinkingFormat` (`:974`), `thinkingTokenBudgetField` (`:978`), `vllmPriority` (`:979`),
`supportsTemperature` (`:986`), `supportsStrictMode` (`:981`). The README documents them at
`dsh-llm-pi-ai/README.md:103-105`.

### 2.3 How the plugin reads config at runtime

Three distinct reads, and the difference matters:

```js
// dsh-llm-pi-ai/lib/index.js:2547-2554
const profiles = () => {
    const raw = config.providers.get();            // <-- schemastery live reference
    if (raw === lastRaw && memoized !== undefined) return memoized;
    const next = resolveProfiles(structuredClone(raw), 'deferred');
    lastRaw = raw; memoized = next; return next;
};
profiles();                                        // eager first resolution at mount (:2555)
```

* `config.<field>.get()` reads the **live** value, not a snapshot — that is what makes a settings change
  reach the next request without a restart (`dsh-llm-pi-ai/README.md:12`, `:109`).
* `.volatile()` on `providers` (`:1051`) marks it as a volatile reference; the plugin then re-registers
  routes on `loader/volatile-update` when the *registration facts* change
  (`:2628-2636`; facts = `{provider, displayName, retryPolicy}` sorted by provider, `:2498-2504` — sorted
  so that reordering dict keys is not mistaken for a route change).
* Scalar validation runs twice: eagerly at mount (`profiles()`, `:2555`) and on every config write via the
  `internal/config` waterfall listener (`:2556-2562`) which calls `assertServiceable` on the changed
  subset (`:1060-1062`).
* `dsh-llm-deepseek-api-key` shows the minimal form:
  `const options = () => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx)); options();`
  (`lib/index.js:37-38`).

Scalar defaults are re-materialized by hand inside `resolveProfiles` rather than trusted from the schema
(`:1085-1153`), e.g. `source.defaultContextWindow ?? 262144` (`:1118`), `source.streamIdleTimeoutMs ?? 3e5`
(`:1095`), `source.maxRequestImageBytes ?? 20971520` (`:1097`), with explicit range checks that throw
plain `Error` naming the route (`:1091-1104`). This matters because `resolveProfiles` is also called with
`validation: 'deferred'` for stored reads so a catalog failure becomes a retained diagnostic instead of a
mount failure (`:1130-1133`, `:1121`).

---

## 3. Model metadata

```ts
// oracle, verbatim
export interface LlmProviderInfo { id: string; name: string; }

export interface LlmModelInfo {
    provider: string;
    id: string;
    name: string;
    description?: string;
    inputModalities?: readonly ModelModality[];   // 'text' | 'image'
}

export interface LlmModelContext { contextWindow: number; }

export interface LlmModelReasoningInfo {
    efforts: readonly LlmReasoningEffortInfo[];
    defaultEffort?: ReasoningEffortId;
}
export interface LlmReasoningEffortInfo { id: ReasoningEffortId; name: string; description?: string; }

export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext;
    defaultMaxTokens?: number;
    reasoning?: LlmModelReasoningInfo;
    systemPromptUpdate?: SystemPromptUpdate;   // 'in-history'
    toolUpdate?: ToolUpdate;                   // 'in-history' | 'addition-only'
}
```

### 3.1 What the runtime does with each

`ctx.llm.listModels(provider)` (`dsh-llm/lib/index.js:2073-2088`) validates every entry and **throws**
`INVALID_CATALOG` if any entry breaks the shape:

> `model.provider` must be a string **equal to `provider`**; `model.id` non-empty; `model.name` non-empty;
> `model.description` string when present; duplicate `id` rejected (`:2077`). `inputModalities` is copied
> (`:2079`).

`ctx.llm.resolveModelInfo(provider, model, signal)` (`:2098-2104`) → `normalizeModelInfo` (`:2106-2150`):

| condition | error code | line |
|---|---|---|
| `resolved.provider !== provider`, `resolved.id !== model`, `name` empty/absent, `description` non-string | `INVALID_MODEL_INFO` | 2108 |
| `context` present but `contextWindow` not a positive integer | `INVALID_MODEL_CONTEXT` | 2110 |
| `systemPromptUpdate` present and `!== 'in-history'` | `INVALID_MODEL_INFO` | 2113 |
| `toolUpdate` present and not `'in-history'`/`'addition-only'` | `INVALID_MODEL_INFO` | 2115 |
| `defaultMaxTokens` present but not a positive safe integer | `INVALID_MODEL_MAX_TOKENS` | 2117 |
| `reasoning.efforts` empty | `INVALID_MODEL_REASONING` | 2131 |
| an effort with empty/duplicate `id`, empty `name`, non-string `description` | `INVALID_MODEL_REASONING` | 2134 |
| `reasoning.defaultEffort` not among the advertised ids | `INVALID_MODEL_REASONING` | 2142 |

`LlmModelInfo` (`listModels`) has **no** `context`, `reasoning`, or `defaultMaxTokens` — those exist only
on the resolved form. `resolveModel` may return them for models that are *not* in the catalog, because
"catalog membership remains advisory and does not control request routing" (`:2090-2092`).

**Missing model.** There is no runtime-side "unknown model" check. Core routing accepts any id: the base
`resolveModel` synthesizes `{provider, id: model, name: model}`, and `dsh-llm-deepseek` resolves an
unlisted model to text-only with the route's `defaultContextWindow` / `maxTokens`
(`dsh-llm-deepseek/lib/index.js:503-525`; README:52 "core calls still pass unlisted model ids through as
text-only routes"). It is the **adapter's** choice to refuse: `dsh-llm-pi-ai` throws
`LlmError('pi-ai provider "..." has no configured model "..."', 'UNKNOWN_MODEL')` in `modelOf`
(`:1786`) and `INVALID_CONFIG` when the model carries a configuration error (`:1784`). Refusing an unknown
model only at dispatch is what keeps the catalog honest.

### 3.2 `resolveCall` — the step between metadata and dispatch

`resolveCallWithInfo(config, info)` (`:2169-2189`) does exactly two things:

1. **Materializes the output cap**: `config.maxTokens === undefined && info.defaultMaxTokens !== undefined`
   → `{...config, maxTokens: info.defaultMaxTokens}` (`:2170-2173`). So `defaultMaxTokens` is how an
   adapter supplies a per-route default the loop then logs and sends.
2. **Validates the reasoning effort before any provider I/O** (`:2174-2188`):
   * `info.reasoning === undefined` and the request names an effort → `UNSUPPORTED_REASONING_EFFORT`;
   * otherwise `effective = requested ?? reasoning.defaultEffort`; an effort outside `efforts` →
     `UNSUPPORTED_REASONING_EFFORT`; and when only the default applied, the resolved config **gains**
     `reasoningEffort: effective`.
   No clamping, no aliasing (`:2153-2155`).

### 3.3 `registerModelDiscovery`

```ts
registerModelDiscovery(
    settingsNs: string,
    discover: (request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<readonly LlmDiscoveredModel[]>,
): () => void

// oracle, verbatim
export interface LlmModelDiscoveryRequest { provider?: string; baseURL?: string; api?: string; apiKey?: string; }
export interface LlmDiscoveredModel {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    inputModalities?: readonly ModelModality[];
}
```

Runtime rules (`dsh-llm/lib/index.js:1974-2014`):

* empty `settingsNs` → `INVALID_DISCOVERY`; a second registration for the same namespace →
  `DUPLICATE_DISCOVERY` (`:1976-1977`).
* `discoverModels(settingsNs, request, signal)`: no offer registered → `NO_DISCOVERY`; both
  `request.provider` and `request.baseURL` empty → `INVALID_DISCOVERY` (`:1997-1998`).
* The runtime **post-processes** the reply: entries without a non-empty `id` are dropped, duplicates by
  `id` are dropped, and `name`/`contextWindow`/`maxTokens`/`inputModalities` are copied only when present
  (`:2000-2013`). So the callback may be loose; the service is strict.
* Remote exposure is `remoteDiscoverModels` → `RemoteError('llm/model-discovery-rejected', ...)` (`:2023-2032`).

How `llm-pi-ai` does it (`dsh-llm-pi-ai/lib/index.js:2286-2337`, registered at `:2608-2611`):

* a route the **installed catalog ships** is answered from the catalog with **no network call**,
  preserving `input` as `inputModalities` (`:2287-2296`);
* otherwise `GET {baseURL}/models` — `listingUrl()` treats `baseURL` as a **prefix**, not a URL to resolve
  against, so deployment path segments survive (`:2176-2180`); bearer auth
  `authorization: Bearer <key>` for the OpenAI protocols (`:2311`), `accept: application/json` (`:2307`),
  **plus `attributionHeaders()`** (`:2312`);
* replies are read bounded at 4 MiB (`:2156`, `:2187-2218`), parsed as JSON, and normalized by
  `readListing` (`:2233-2262`), which accepts either a standard `data` array or an enriched `models`
  object map, and reads capacity from `contextWindow | context_window | context_length |
  max_input_tokens | limit.context` and `maxOutputTokens | max_output_tokens | maxTokens | max_tokens |
  limit.output | top_provider.max_completion_tokens`;
* failures: `DISCOVERY_UNSUPPORTED` for an unreadable protocol (`:2299`), `DISCOVERY_FAILED` for
  unreachable / non-2xx / non-JSON / oversized / unparseable listing (`:2320`, `:2322`, `:2334`, `:2188`,
  `:2240`), `ABORTED` when the signal fired (`:2319`, `:2327`), `INVALID_CREDENTIAL` for a key no header
  can carry (`:2274`).

**Is it required for a good UI experience?** For the *Models settings page* add/edit flows, yes it is what
makes discovery work: "Interrogation covers OpenAI-compatible and Anthropic Messages endpoints"
(`dsh-client-ui-settings-models/README.md:129`); the custom-API form can interrogate the endpoint and
offer the reply as candidate rows to adopt; "Discovery does not change configured models — adopt discovery
results explicitly into the route configuration" (`dsh-llm-pi-ai/README.md:223`). It is **not** required
for the model *selector*: that reads `listModels` (§1.4). If your plugin's catalog is one hand-written
model, `listModels` alone gives a fully working picker. Register discovery if you want the endpoint's own
`GET /v1/models` to be queryable from the Models page for your namespace.

---

## 4. Streaming

### 4.1 The chunk protocol

```ts
// oracle, verbatim
export type StreamChunk =
  | { type: 'block-start';   index: number; blockType: ContentBlockType }
  | { type: 'text-delta';    index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end';     index: number; block: ContentBlock }
  | { type: 'usage';         usage: TokenUsage }
  | { type: 'finish';        reason: FinishReason; replayState?: ReplayEnvelope };

export type FinishReason =
  | { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error';   failure: LlmFailure };

export type ContentBlockType = keyof ContentBlockMap;
// ContentBlockMap: 'text' | 'reasoning' | 'image' | 'file' | 'tool-call'
//                | 'tool-addition' | 'tool-removal'
// ToolCallBlock  = { type: 'tool-call'; id: ToolCallId; name: string; arguments: string }  // arguments = RAW JSON STRING
// TextBlock      = { type: 'text'; text: string }
// ReasoningBlock = { type: 'reasoning'; text: string }
```

### 4.2 What order is actually required

The consuming algorithm is `BlockAssembler` (`node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.js`).
It is deliberately tolerant, and its tolerances define the contract:

* `block-start` is **optional**: `push` creates a partial on first sight either way (`:35-45` vs `ensure`, `:85-93`).
  A delta-only protocol works. `block-start` is what fixes a block's *type* before its first delta.
* `index` is an adapter-assigned, monotonic block ordinal. Block order in the assembled message is
  **first-seen index order** (`order.push(chunk.index)`, `:37`, `:90`) — *not* ascending index order, so an
  adapter that opens index 1 before index 0 gets `[block1, block0]`.
* Deltas must precede the `block-end` for their index. A delta or second `block-end` after `block-end` is
  silently dropped ("closed by block-end; ignore stragglers", `:49-50`, `:56-57`, `:66-71`) — so a
  mis-ordered close *loses data* rather than throwing.
* **`block-end` wins over accumulated deltas.** `assemble()` returns `partial.block` when set (`:94-96`),
  so the `block` you put in `block-end` is the durable block. It must contain the full final text /
  arguments, not just the last delta.
* An open block whose type is not text/reasoning/tool-call makes `blocks()` **throw**
  (`:106`: `cannot assemble incomplete block of type "..."`). This is the documented limitation
  `dsh-llm/README.md:160`.
* `usage` and `finish` are terminal bookkeeping: last one wins (`:73-81`).
* `finish` is **required by the service** but the assembler defaults to `{kind:'stop'}` when absent
  (`:170-173`) — a silent lie, so always emit it.
* Invariant: "`usage` precedes `finish`, tool arguments stay raw JSON strings, and nothing follows the
  terminal `finish`" (`dsh-llm/README.md:119`).
* On `max-tokens`, the assembler **drops tool-call blocks** from the assembled message (`:123-126`),
  because a truncated argument JSON cannot be executed.

The canonical shape an adapter emits, distilled from `dsh-llm-pi-ai/lib/index.js:1469-1585` and
`dsh-llm-deepseek/lib/index.js:1938-2003`:

```
block-start(text, i)  →  text-delta(i)*  →  block-end(text, i)
block-start(reasoning, j) → reasoning-delta(j)* → block-end(reasoning, j)
block-start(tool-call, k) → tool-call-delta(k, id, name?, args)* → block-end(tool-call, k)
usage
finish
```

`dsh-llm-pi-ai` yields exactly that (`:1473-1558`) and terminates with `usage` then `finish` for both the
`done` and the `error` path (`:1559-1582`). `dsh-llm-deepseek` does the same, plus a strictness check that
each `content_block_stop` had a matching open block and that every block was closed before the stop reason
settled (`:1961-1982`).

### 4.3 Tool calls

* `block-start {index, blockType: 'tool-call'}` opens.
* Every `tool-call-delta` carries `id` (required by the type) and `argumentsDelta`; `name` is optional and
  should be repeated once known. `dsh-llm-pi-ai` reproduces `name` on every delta while it is non-empty
  (`:1542`) and `dsh-llm-deepseek` sends it once on the opening delta with an empty `argumentsDelta`
  (`:1954-1960`). The assembler keeps the last non-empty `name` it saw (`:59-60`).
* `argumentsDelta` fragments are **concatenated verbatim** (`partial.toolCallArguments += chunk.argumentsDelta`,
  `:61`). They are *not* parsed per delta — that is a deliberate performance property
  (`dsh-llm-pi-ai/README.md:232`, referencing the patched `@earendil-works/pi-ai`).
* `block-end` must carry the **complete** arguments as a raw JSON string
  (`{type:'tool-call', id, name, arguments: <string>}`). If no `block-end` arrives the assembler
  concatenates the deltas into `arguments` (`:100-105`) and defaults `id` to `call-${index}` and `name` to
  `''` — a tool call with an empty name is unusable, so close your blocks.
* Pi-ai holds parsed objects internally and re-stringifies on the way out:
  `arguments: JSON.stringify(event.toolCall.arguments)` (`:1555`) — the harness convention is raw JSON.
* The harness never checks that the final arguments parse. `dsh-llm-deepseek` does, and turns a bad
  payload into `MALFORMED_RESPONSE` (`:1983-1992`); pi-ai does not. Choose deliberately.

**Finalization:** all tool-call blocks are closed before `usage`/`finish` (the `for (const block of blocks)
finishBlock(block)` at `pi-ai-openai-completions.js:469-471` is the wire-side analogue). A tool call that
arrives with `finish_reason: 'tool_calls'` maps to `{kind:'tool-calls'}`.

### 4.4 Choosing the finish reason

Reference mapping, OpenAI Chat Completions → harness (derived from
`dsh-llm-pi-ai/lib/index.js:1402-1456` and `dsh-llm-deepseek/lib/index.js:1901-1907`):

| wire signal | harness `FinishReason` |
|---|---|
| `stop` / `end_turn` / `stop_sequence`, with ≥1 content block | `{kind:'stop'}` |
| `stop`, with **zero** content blocks | `{kind:'error', failure:{code:'EMPTY_RESPONSE', ...}}` |
| `length` / `max_tokens` | `{kind:'max-tokens'}` |
| `tool_calls` / `tool_use` | `{kind:'tool-calls'}` |
| caller signal aborted | `{kind:'aborted', failure:{code:'ABORTED', ...}}` |
| anything else (HTTP error, in-band error event, transport death) | `{kind:'error', failure:{...}}` |

Additional reasons `llm-pi-ai` synthesizes: content detected as context overflow →
`CONTEXT_WINDOW_EXCEEDED` (`:1403-1411`); a terminal `pending`/`deferred` provider state → non-retryable
`PI_AI_ERROR` (`:1424-1437`). `EMPTY_RESPONSE` is a real, useful classification: "Providers occasionally
emit a degenerate completion (a terminal stop with zero output); adapters classify it as this failure
instead of yielding an empty assistant message … The attempt produced nothing durable, so retry policy
treats it as safe to repeat." (`dsh-llm/lib/types/error.js:27-36`). Both shipped adapters implement it
(`pi-ai/lib/index.js:1414-1420`, `deepseek/lib/index.js:1982`).

### 4.5 `replayState`

```ts
// oracle, verbatim
export interface ReplayEnvelope { response: unknown; blocks?: readonly unknown[]; }
export interface AssistantProviderMetadata { provider: string; model: string; replayState?: unknown; }
```

* It travels on the terminal `finish` chunk (`{type:'finish', reason, replayState?}`) and is stored on the
  assistant message's `source.replayState` by the assembler (`assembler.js:79`, `:179-181`).
* Purpose: let an adapter round-trip **provider-native** response facts (native response ids, thinking
  signatures, encrypted reasoning blobs) through durable history so a later turn can reuse them.
  `dsh-llm-pi-ai` stores "a versioned, lossless-JSON replay state beside the provider and model that
  produced them — response-level facts plus one per-block entry per streamed block"
  (`dsh-llm-pi-ai/README.md:159`); `dsh-llm-deepseek` preserves model identity and thinking signatures
  (`dsh-llm-deepseek/README.md:84`).
* It is delivered **only when the same adapter instance owns both routes** — the runtime strips it
  otherwise (`forAdapter`, `dsh-llm/lib/index.js:2242-2263`), and the invariant is stated at
  `dsh-llm/README.md:115`: "assistant replay state rides along only when the same adapter instance owns
  the historical and target routes; otherwise it is dropped before dispatch".
* **It can be omitted, and for a plain OpenAI-compatible local endpoint it should be.** Omitting it means
  the next request rebuilds provider-neutral blocks from the durable content. Both shipped adapters handle
  absent/unusable replay by degrading rather than failing: `dsh-llm-pi-ai/README.md:159` "Absent or
  unusable replay state degrades to provider-neutral content while preserving the assistant source's
  required provider and model", with a warning through `onReplayDegrade` (`:2581-2583`).
* If you do emit it, note `BlockAssembler.assembled()` discards the whole envelope when
  `envelope.blocks.length !== allBlocks.length` (`assembler.js:130-131`) and prunes it in step with
  max-token tool-call dropping (`:136`). So `blocks` must be positional and complete or absent.

### 4.6 Cancellation

* `options.signal` is caller cancellation. Every shipped adapter also builds its own consumer controller
  and combines: `AbortSignal.any([options.signal, consumer.signal])` (`dsh-llm-pi-ai/lib/index.js:1853-1854`,
  `dsh-llm-deepseek/lib/index.js:2117-2118`) and aborts the consumer in `finally` when iteration stops
  early (`pi-ai/lib/index.js:1901-1915`).
* On abort the adapter must **throw**, and the thrown error must be an `ABORTED` `LlmError`. The runtime
  converts it: `adapterFailureChunk` (`dsh-llm/lib/index.js:2376-2388`) yields
  `{type:'finish', reason:{kind:'aborted', failure}}` whenever `options.signal?.aborted` **or** the
  normalized code is `ABORTED`; otherwise `{kind:'error', failure}`.
* Do **not** return normally on abort and do not swallow it: the runtime's post-hoc check
  (`options.signal?.aborted`) is what keeps a caller abort from being reported as a provider error.
  `dsh-llm-pi-ai` throws `LlmError('pi-ai request aborted by caller', 'ABORTED', {cause})` (`:1911`);
  `dsh-llm-deepseek` throws `LlmError('DeepSeek Messages request aborted', 'ABORTED', {cause})` (`:2130`).
* Also close your upstream iterator: the runtime calls `iterator.return()` on early consumer exit
  (`dsh-llm/lib/index.js:2349-2354`), and the adapters abort the underlying fetch from their own `finally`
  so the socket does not leak.
* Optional hardening the shipped adapters add: an **idle watchdog** that fails a stream with `TIMEOUT`
  after `streamIdleTimeoutMs` (default 300 s) with no read progress
  (`pi-ai/lib/index.js:1856`, `:1910`; `deepseek/lib/index.js:2118`, `:2129`).

---

## 5. Errors and retries

### 5.1 `LlmFailure` and how a throw becomes it

```ts
// oracle, verbatim
export interface LlmFailure {
    readonly message: string;
    readonly code: string;
    readonly status?: number;
    readonly providerRetryAfterMs?: number;
    readonly requestId?: ProviderRequestId;
    readonly offloadImages?: number;
}
```

`LlmError` is exported from the package root (`dsh-llm/lib/index.js:1615-1640`, also
`lib/types/index.js:66-102`). It extends `HarnessError` and **retains the serializable facts on a public
own data property `failure`**:

```js
// dsh-llm/lib/index.js:1623-1639
constructor(message, code, options) {
    if (typeof message !== 'string' || message.length === 0) throw new Error('LlmError message must be a non-empty string');
    if (typeof code    !== 'string' || code.length    === 0) throw new Error('LlmError code must be a non-empty string');
    if (options?.status !== undefined && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599))
        throw new Error('LlmError status must be an integer from 100 through 599');
    if (options?.providerRetryAfterMs !== undefined && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0))
        throw new Error('LlmError providerRetryAfterMs must be a positive finite number');
    if (options?.requestId !== undefined && (typeof options.requestId !== 'string' || options.requestId.length === 0))
        throw new Error('LlmError requestId must be a non-empty string');
    super(message, code, options);
    this.name = 'LlmError';
    this.failure = Object.freeze({ message, code, ...status..., ...providerRetryAfterMs..., ...requestId..., ...offloadImages... });
}
```

`normalizeLlmFailure` (`dsh-llm/lib/types/adapter-failure.js:13-26`) is what the runtime applies to a
thrown value (`dsh-llm/lib/index.js:2377`). Its rules, in order:

1. Non-`Error` throws are wrapped in `HarnessError(String(value) || 'LLM adapter failed', 'UNKNOWN')` (`:16`).
2. It reads the error's **own `failure` data property** (never an accessor) and validates it
   (`failureSnapshot`, `:60-91`): `message` non-empty string, `code` non-empty string, `status` integer
   100..599, `providerRetryAfterMs` finite and `> 0`, `requestId` non-empty string, `offloadImages`
   positive safe integer. Any violation discards the whole snapshot.
3. It **trusts that snapshot only when its `code` equals the error's own `code` property** (`:20-21`).
   That equality check exists for cross-package copies: "Cross-package copies preserve own data but not
   class identity."
4. Otherwise it falls back to `{ message: error.message || 'LLM adapter failed', code: error instanceof HarnessError ? error.code : 'UNKNOWN' }`
   (`:22-25`, `:105-107`). **A plain `Error` with a custom `.code` therefore normalizes to `UNKNOWN`** — the
   only way to get your code through is a `failure` own property whose `code` matches your own `code`.

**Consequence for a plugin author:** import `LlmError` from `@deepseek-ai/dsh-llm` and construct it with
the options bag. That sets both `code` and `failure.code`, satisfies rule 3, and preserves
`status` / `providerRetryAfterMs` / `requestId`. Do not hand-roll `Object.assign(new Error(...), {code})`.

### 5.2 Mapping HTTP/upstream failures

The exact classifier used by the direct-fetch shipped adapter
(`dsh-llm-deepseek/lib/index.js:1743-1765`), which is the pattern to copy:

```js
function providerError(raw, status, headers) {
  const error  = /* envelope.error if object */ {};
  const message = typeof error.message === 'string' ? error.message : `… request failed (${status ?? 'stream error'})`;
  const type    = typeof error.type === 'string' ? error.type : '';
  const detail  = `${type} ${error.code ?? ''} ${message}`;
  let code;
  if (status === 401 || status === 403 || ['authentication_error','permission_error'].includes(type)) code = 'AUTH';
  else if (isQuotaExceededError(detail) || status === 402)                                    code = 'QUOTA';
  else if (status === 429 || type === 'rate_limit_error')                                     code = 'RATE_LIMIT';
  else if (isContextWindowExceededError(detail))                                              code = 'CONTEXT_WINDOW_EXCEEDED';
  else if (status === 400 || status === 413 || type === 'invalid_request_error')              code = 'INVALID_REQUEST';
  else if ((status !== undefined && status >= 500) || ['api_error','overloaded_error'].includes(type)) code = 'SERVER';
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`;

  const retry = headers?.get('retry-after');
  const delay = retry == null ? NaN
              : /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1e3 : Date.parse(retry) - Date.now();
  const id = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('x-deepseek-request-id');
  return new LlmError(message, code, {
    ...status === undefined ? {} : { status },
    ...id ? { requestId: ProviderRequestId(id) } : {},
    ...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {},
  });
}
```

`isQuotaExceededError` and `isContextWindowExceededError` are exported from
`@deepseek-ai/dsh-llm` (`lib/types/error.js:63-82`; they take one joined detail string — `code type
message`). The README restates the taxonomy: "`AUTH` (401/403), `QUOTA`, `RATE_LIMIT`,
`CONTEXT_WINDOW_EXCEEDED`, `INVALID_REQUEST`, `SERVER`, and `HTTP_<status>` otherwise; pre-response
transport failures throw `TRANSPORT`, caller aborts throw `ABORTED`, and stream-idle expiry throws
`TIMEOUT`." (`dsh-llm-deepseek/README.md:118`)

Canonical codes exported by `dsh-llm` (`lib/types/error.js`):
`CONTEXT_WINDOW_EXCEEDED` (`:22`), `QUOTA` (`:24`), `ACCOUNT_QUOTA` (`:26`), `EMPTY_RESPONSE` (`:36`),
`INVALID_CREDENTIAL` (`:44`), `IMAGE_OFFLOAD_REQUIRED` (`:154`), plus service-level `NO_ADAPTER` (`:2238`),
`MISSING_CREDENTIAL` (`:2569` in pi-ai; api-key plugin `:31`), `UNSUPPORTED_CONTENT`, `UNSUPPORTED_OPTION`,
`UNSUPPORTED_REASONING_EFFORT`, `INVALID_REQUEST`, `MALFORMED_RESPONSE`, `STREAM_CLOSED`,
`INVALID_REPLAY_STATE`. `QUOTA` is "provider-neutral exhaustion", `ACCOUNT_QUOTA` is reserved for a
replenishable first-party balance (`dsh-llm/README.md:74`).

**For `http://127.0.0.1:8790/v1`:** expect no `retry-after` header; parse one anyway if present. A local
server that is simply down produces a `fetch` rejection → `TRANSPORT`. A local model that is loading may
answer `503` → `SERVER`. Both are in the default retryable set.

### 5.3 Thrown vs terminal chunk — the exact boundary

> "Adapter selection, dispatch, and iteration failures become terminal `error` or `aborted` finish chunks;
> middleware, nested-call, cleanup, and consumer failures remain thrown."
> (`dsh-llm/lib/index.js:2356-2363`, `dsh-llm/README.md:74`)

Mechanically (`adapterStream`, `:2283-2354`):

* a throw from `adapter.prepareCall(...)` or `adapterCall.stream(...)` → `adapterFailureChunk` → one
  terminal `finish` chunk, generator returns (`:2324-2327`);
* a throw from `iterator.next()` → same (`:2338-2342`);
* a throw from `iterator.return()` during early close is **not** caught (`:2350-2353`) → propagates;
* a `stream()` method that returns a non-iterable throws inside dispatch → the same terminal chunk.

So an adapter has **exactly one obligation**: make `stream()` either (a) yield a well-formed chunk sequence
ending in `finish`, or (b) throw an `LlmError`. Both failure-delivery styles are legal; the service
converts. `dsh-llm-pi-ai` uses style (b) almost exclusively — "pi-ai never throws mid-stream — failures
arrive as `error` events, which become error/aborted `finish` chunks (the harness protocol's other
error-delivery style)" (`pi-ai/lib/index.js:1457-1460`) — while `dsh-llm-deepseek` yields terminal
`usage`+`finish` for in-band outcomes and throws for everything else. Style (b) is simpler: **throw**.

Never yield anything after a terminal `finish` (`dsh-llm/README.md:119`), and never swallow a failure into
a `{kind:'stop'}` — the assembler's missing-finish default would then hide it (`assembler.js:170-173`).

### 5.4 `providerRetryPolicy` × `dsh-llm-retry`

* The policy is **captured at registration** (`dsh-llm/lib/index.js:1867`) and readable back with
  `ctx.llm.providerRetryPolicy(provider): ResolvedRetryPolicy` (`:2038-2039`).
* `ResolvedRetryPolicy` is `ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy`:
  `{mode:'always', initialDelayMs, maxDelayMs, jitterRatio}` or
  `{mode:'normal', maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}` (oracle).
* Defaults when you return `undefined` (`dsh-llm/lib/types/retry-policy.js:12-22`, `:84-92`):
  `mode:'normal'`, `maxRetries: 5`, `retryableCodes: ['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`,
  backoff `initialDelayMs: 500`, `maxDelayMs: 10_000`, `jitterRatio: 0.1`.
* The schema to embed in your Config is `RetryPolicySchema` (exported from `@deepseek-ai/dsh-llm`,
  `retry-policy.js:39-42`). `resolveRetryPolicy(config, path)` validates and freezes (`:84-126`).
* `dsh-llm-retry` is the executor and has **no configuration of its own**
  (`dsh-llm-retry/README.md:28`). It listens on the agent loop's `agent/request-error` waterfall, checks
  the failed step's provider policy, computes the delay (a valid provider `Retry-After` replaces local
  backoff when it fits the policy bounds), appends a durable `llm/retry` event **before** waiting, then
  `llm/retry-started`, then `{kind:'retry'}` (`:54`, `:85`). Direct `ctx.llm.stream()` calls remain
  single-attempt (`:32`, `:132`).
* Therefore your code choices have direct observable effect: get the **code** right and the failure is
  retried with backoff; emit `providerRetryAfterMs` from `Retry-After` and the retry respects the server's
  instruction. Normal mode's eligibility is by code, and `retryableCodes` is adapter-owned config.
* "Retry policy is provider-owned, not an SDK retry — pi-ai SDK retries stay disabled so durable agent
  steps and `llm/retry` events own every visible attempt" (`dsh-llm-pi-ai/README.md:231`). pi-ai passes
  `maxRetries: 0` (`pi-ai/lib/index.js:1684`). **Do not retry inside your adapter.**

---

## 6. Usage / accounting

```ts
// oracle, verbatim
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
```

* Emit it as `{type:'usage', usage}` **immediately before** `finish`. Nothing validates the object at the
  service boundary: `BlockAssembler.push` stores it verbatim (`assembler.js:73-75`) and
  `AssistantStreamAccumulator.push` records it as an opaque `{type:'chunk', time, chunk}` (`:104-106`).
  Invalid numbers therefore travel a long way before they hurt; keep them finite non-negative integers.
* **If you omit it and never emit a `usage` chunk:** `BlockAssembler.usage` stays `undefined`
  (`assembler.js:26`, `:166-168`); the durable attempt records no usage; `dsh-token-meter`'s
  `tokenUsage` projection loses its exact provider sample and the whole measurement falls back to the
  approximate fixed heuristic for those tokens. The turn-usage fold "returns no result when lifecycle
  evidence is missing, counts are unsafe, or exact totals conflict"
  (`dsh-token-meter/README.md:55`), so per-turn exact usage simply disappears for that attempt.
  Nothing errors. Do not substitute a zeros object: a zero claim is *worse* than absence, because it is a
  provider anchor claiming the request cost nothing.
* Mapping from an OpenAI-compatible stream (with `stream_options: {include_usage: true}` the endpoint sends
  one final chunk carrying `usage` and an empty `choices` array):

  | wire | harness |
  |---|---|
  | `usage.prompt_tokens` | `inputTokens` |
  | `usage.completion_tokens` | `outputTokens` |
  | `usage.total_tokens` | `totalTokens` |
  | `usage.prompt_tokens_details.cached_tokens` | `cacheReadTokens` (omit when 0) |
  | `usage.completion_tokens_details.reasoning_tokens` | `reasoningTokens` (omit when 0) |

  Reference behaviour: `dsh-llm-pi-ai` maps `{input, output, totalTokens}` and includes the cache fields
  **only when non-zero**, "cache fields appear only when non-zero (pi-ai reports zeros, not absence)"
  (`pi-ai/lib/index.js:1366-1379`). Its README adds that it "folds reasoning tokens into output usage when
  the provider does not report them separately, and preserves its exact `totalTokens` value unchanged"
  (`dsh-llm-pi-ai/README.md:204`). `dsh-llm-deepseek` instead **computes** the total:
  `usage.totalTokens = inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)`
  (`deepseek/lib/index.js:1993`). Either is acceptable; be consistent, because the token meter's anchor
  comparison depends on the total.

### 6.1 Cost / context display — what actually exists

There is **no dollar-cost surface and no billing record** in the harness. What exists:

* **Token counts.** `dsh-token-meter` registers the `tokenUsage` projection carrying the complete durable
  log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`; "A final
  assistant-message sample replaces streaming usage from the same attempt; `llm/retry-started` ends that
  replacement scope, so a retry in the same step contributes another billed attempt"
  (`dsh-token-meter/README.md:49`).
* **Context occupancy.** `contextPressure` carries `pressureTokens` (the newest provider-reported prompt
  size), `projectedTokens`, and `contextWindow`. "A UI computes occupancy by dividing measured pressure by
  the separately resolved capacity for the selected model" (`dsh-token-meter/README.md:68`).
  **That separately-resolved capacity is `LlmResolvedModelInfo.context.contextWindow`** — "model capacity
  belongs to the adapter that owns the exact provider/model route and is available through
  `ctx.llm.resolveModelInfo().context`" (`dsh-token-meter/README.md:28`). So if your `resolveModel`
  omits `context`, occupancy and every capacity-derived display lose their denominator. This is the single
  most important metadata field to get right.
* **Image pricing.** `imageRequestPricing(provider, model): LlmImageRequestPricing | undefined` exists so
  the token meter can price request images before the call instead of using a neutral estimate
  (`dsh-llm/lib/index.js:1688-1697`, `dsh-token-meter/README.md:43`, `:105`). "Implementations must answer
  synchronously without I/O; the token meter resolves this per measurement" (`:1690-1692`).
  `ctx.llm.imageRequestPricing(provider, model)` degrades to `undefined` for an unregistered route rather
  than throwing (`:2050-2051`). For a text-only local endpoint, **omit it** — the default returning
  `undefined` is correct.
* `contextBreakdown` (`systemTokens`/`toolsTokens`/`messageTokens`) is the fixed 4-chars-per-token
  heuristic, explicitly "approximate composition, not billing or `projectedTokens`"
  (`dsh-token-meter/README.md:53`). Do not try to influence it from the adapter.

---

## 7. Message conversion → OpenAI chat-completions JSON

### 7.1 The harness side

```ts
// oracle, verbatim (abridged to the members that matter)
export interface GenerateOptions { messages: RequestMessage[]; system?: string; tools?: ToolSchema[]; /* … */ }
export type RequestMessage = Message | RequestUserInput;
export type Message = SystemMessage | DeveloperMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSchema { deferLoading?: true; name: string; description: string; parameters: Record<string, unknown>; }
export interface ToolCallBlock { type: 'tool-call'; id: ToolCallId; name: string; arguments: string; }  // raw JSON string
export interface ToolResultMessage extends MessageBase {
    readonly role: 'tool';
    readonly source: ToolMessageSource;   // { kind: 'tool'; callId: ToolCallId }
    readonly toolCallId: ToolCallId;
    readonly isError?: boolean;
}
export interface RequestUserInput { readonly role: 'user'; readonly content: UserMessage['content']; readonly id?: never; readonly source?: never; }
```

Created by `createToolResultMessage({callId, content, isError})` and `createAssistantMessage({content, source})`
(`dsh-llm/lib/types/message.js`), both deep-frozen.

### 7.2 What the runtime has already done before your adapter sees it

`adapterStream` projects input before dispatch (`dsh-llm/lib/index.js:2309-2323`):

* every durable `FileBlock` is replaced by deterministic handle text — "Durable `FileBlock` references
  never reach any adapter" (`dsh-llm/README.md:118`; `projectFilesToText`, `:2310`);
* if your `resolveModel` did **not** include `'image'` in `inputModalities`, image blocks are replaced by
  stable per-image placeholders — "A text-only route receives deterministic per-image placeholders,
  including tool-role result images, without rewriting append-only session history"
  (`dsh-llm/README.md:108`; `projectImagesForTextModel`, `:2311`);
* `toolHistory` is folded into `tools` by `projectToolUpdates` according to `toolUpdate`
  (`:2312`; `dsh-llm/README.md:162`). If you declare no `toolUpdate`, you get the active tool set with
  deferred declarations honoured and **no** `tool-addition`/`tool-removal` blocks.

So: **declare `inputModalities: ['text']` and every image arrives as text.** That is the right choice for a
plain local endpoint, and it means you never need `image`. Do not declare `'image'` unless you also
implement base64 image parts — a misdeclared modality is refused by the provider *after* the message is
durable (`dsh-llm-pi-ai/README.md:226`).

### 7.3 Message → wire

The reference conversion is `dsh-llm-pi-ai/lib/index.js:1162-1352` →
`@earendil-works/pi-ai`'s `convertMessages` (`pi-ai/dist/api/openai-completions.js:866-1124`). The
OpenAI-facing facts:

**System prompt.** `GenerateOptions.system` is a *separate top-level field*, not a message.
`splitSystemPrompt` (`pi-ai/lib/index.js:1244-1258`) decides:

* `options.system` defined → it is the system prompt; **every** history message is converted, including a
  leading `system` message, which then folds into a `user` message;
* otherwise, if the **first** history message is `role: 'system'`, its flattened text becomes the system
  prompt and it is removed from the converted history; empty text means *no* system prompt;
* otherwise no system prompt and history is converted as-is.

This is a documented limitation (`dsh-llm-pi-ai/README.md:229`): "Only a leading in-history `system`
message becomes pi-ai's `systemPrompt` … a later `system` message, or a leading one when
`GenerateOptions.system` is also set, folds into a `user` message at its position." A direct OpenAI bridge
should do better and is free to: emit a `system` message for `options.system`, and emit each
`role: 'system'` history message as its own `system` message at its position. The system-prompt
*placement* question is what `LlmResolvedModelInfo.systemPromptUpdate: 'in-history'` is about — that mode
means "the model reads the latest `system` message at any position as the effective system prompt", and
only declare it if your endpoint really behaves that way (`dsh-llm/README.md:68`; `dsh-llm-deepseek/README.md:52`).
For a stock OpenAI-compatible server, **omit `systemPromptUpdate`**.

**`developer` → `system`.** Two facts, and they point in opposite directions — resolve them deliberately:

1. The harness can carry `role: 'developer'` messages (`DeveloperMessage`, and `createDeveloperMessage` is
   exported). `dsh-llm-pi-ai` **refuses them**:
   `if (message.role === 'developer') throw new LlmError('Developer messages are not supported yet', 'UNSUPPORTED_CONTENT')`
   (`pi-ai/lib/index.js:1183`), along with `tool-addition`/`tool-removal` blocks (`:1184`).
2. On the OpenAI wire, pi-ai chooses the instruction role as
   `const instructionRole = model.reasoning && compat.supportsDeveloperRole ? 'developer' : 'system'`
   (`pi-ai-openai-completions.js:896`) and emits the system prompt with that role (`:919`). For a generic
   endpoint not in its provider-detection list, `detectCompat` yields
   `supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter)` → **`true`**
   (`:1261`), i.e. pi-ai would use `developer` for a reasoning model on a bare local endpoint.

For your bridge: **map `role: 'developer'` → `role: 'system'`** and send the instruction prompt as
`system`. Local OpenAI-compatible servers (llama.cpp, vLLM, Ollama, LM Studio) universally accept
`system`; `developer` is an OpenAI o-series convention that many of them reject or ignore. If you copy
pi-ai's `compat.supportsDeveloperRole` switch, default it to `false`.

**Roles and content.**

| harness | OpenAI wire |
|---|---|
| `system` (history) | `{role:'system', content:<flattened text>}` |
| `developer` | `{role:'system', content:<flattened text>}` (see above) |
| `user` | `{role:'user', content:<string>}` when every block is text — join with `''` (`pi-ai/lib/index.js:1202,1212`); otherwise `{role:'user', content:[{type:'text',text}, {type:'image_url',image_url:{url:'data:<mime>;base64,<b64>'}}]}` (`pi-ai-openai-completions.js:929-953`) |
| `assistant` | `{role:'assistant', content:<string>, tool_calls?:[…]}` — **content is a plain string**, and `null`/`''` when the turn was tool-calls-only (`:956-961`, `:1016`) |
| `tool` | `{role:'tool', content:<text>, tool_call_id:<callId>}`, plus `name` only if the endpoint requires it (`:1077-1084`) |

Detail worth copying: `assistantMsg.content` is deliberately a **string**, never a `[{type:'text'}]` array —
"Sending as an array of `{type:"text", text:"..."}` objects is non-standard and causes some models to mirror
the content-block structure literally in their output, producing recursive nesting like
`[{'type':'text','text':'[{...}]'}]`" (`pi-ai-openai-completions.js:989-996`). Use a plain string.

Also: assistant messages with neither content nor tool calls are **skipped** because "Some providers require
`either content or tool_calls`, but not none. Other providers also don't accept empty assistant messages.
This handles aborted assistant responses that got no content." (`:1049-1059`). Do the same or an aborted
turn poisons the next request.

**Tool calls (assistant → wire).**

```js
{ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }
// pi-ai-openai-completions.js:1031-1038
```
The harness `ToolCallBlock.arguments` is already a raw JSON **string**, so a direct bridge passes it
through unchanged (`arguments: tc.arguments`). pi-ai's re-stringify is only because pi-ai internals hold
parsed objects (`pi-ai/lib/index.js:1555`, `dsh-llm-pi-ai/README.md:200`).

**Tool results.**

* Harness `tool` messages are matched to the call by `toolCallId`/`source.callId`. pi-ai recovers the tool
  **name** by remembering every assistant `toolCall` id→name it has seen
  (`appendAssistant`, `:1271`; `toolResultOf`, `:1167-1179`) and defaults an unknown name to `"unknown"`.
  A direct bridge can do the same or read the name from the preceding assistant message in the same pass.
* Adjacent tool results are grouped: pi-ai walks a run of consecutive `toolResult` messages, emits one
  `{role:'tool'}` per result, then if any carried images emits a synthetic
  `{role:'user', content:[{type:'text', text:'Attached image(s) from tool result:'}, ...image_urls]}`
  (`:1062-1122`). Text-only routes skip that entirely (`:1086`).
* Empty tool output becomes `"(no tool output)"` (`:1075`); pi-ai's own empty text becomes `"(no output)"`
  (`pi-ai/lib/index.js:1174`). Keep *some* placeholder, since `content: ''` is rejected by some servers.
* `requiresAssistantAfterToolResult` — some providers reject a `user` message directly after tool results —
  inserts `{role:'assistant', content:'I have processed the tool results.'}` between them
  (`pi-ai-openai-completions.js:900-907`, `:1101-1106`). Config switch; leave off for a local server.
* `isError` has **no OpenAI wire representation** — it is dropped. The text is what the model reads.

**Tool schemas (§ wire).** `options.tools: ToolSchema[]` with `{name, description, parameters}` maps to
`{type:'function', function:{name, description, parameters}}` (`pi-ai` uses `convertTools`,
`dsh-llm-pi-ai/lib/index.js:1231-1235`). Two traps:

* pi-ai **throws** on deferred loading: `if (options.tools?.some(t => t.deferLoading === true)) throw new
  LlmError('Deferred tool loading is not supported yet', 'UNSUPPORTED_CONTENT')` (`:1230`). A direct bridge
  can just drop the `deferLoading` hint and send the schema.
* If the conversation contains tool calls/results but the *current* request has no tools, pi-ai still sends
  `params.tools = []` because "Anthropic (via LiteLLM/proxy) requires tools param when conversation has
  tool_calls/tool_results" (`pi-ai-openai-completions.js:598-607`). Cheap insurance; consider it.
* `tool_choice` is **not** in the harness vocabulary at all (`dsh-llm/README.md:158`,
  `dsh-llm-deepseek/README.md:205`) — never send it.

**Images.** If you do declare `'image'` input, the OpenAI encoding is
`{type:'image_url', image_url:{url:'data:<mimeType>;base64,<data>'}}` (`pi-ai-openai-completions.js:940-946`,
`:1089-1094`). But the harness gives you `ImageBlock.attachment` as an **`ImageAttachmentRef`**, not bytes:

```ts
// oracle, verbatim
export interface ImageAttachmentRef {
    attachmentId: AttachmentId; mediaType: ImageMediaType; bytes: number;
    width: number; height: number; name?: string; originalDimensions?: { width: number; height: number };
}
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
```

Reading bytes requires the durable `attachments` service: `ctx.get('attachments')` and
`attachments.readImageRequest(ref, {maxPixels, maxBytes}, signal)` (`pi-ai/lib/index.js:1220-1228`,
`:1860-1880`), plus `image/offload` accounting against `maxRequestImageBytes` via `requiredImageOffload`
(`:1330-1334`) and `projectOffloadedImages` (`:1336`). **None of that is worth doing for a local text
endpoint.** Declare text-only and skip the entire subsystem; the runtime's placeholder projection
(`dsh-llm/lib/index.js:2311`) is deterministic and keeps history intact.

### 7.4 Bridge requirements specific to OpenAI Chat Completions

* **`stream: true` is mandatory.** "streaming SSE only" is the stated endpoint contract, and dsh's whole
  protocol is token-level deltas; a non-streaming JSON body has no chunk mapping. pi-ai hardcodes
  `stream: true` in the params (`pi-ai-openai-completions.js:574`). There is no non-streaming path.
* **`stream_options: {include_usage: true}`** so the endpoint reports usage at all — pi-ai sends it when
  `compat.supportsUsageInStreaming !== false`, default `true` (`:581-583`, `:1263`). Without it most
  servers report no usage and §6's accounting is lost.
* **Output-cap field name.** `GenerateOptions.maxTokens` → `max_tokens` **or** `max_completion_tokens`.
  pi-ai's rule: `compat.maxTokensField === 'max_tokens' ? params.max_tokens : params.max_completion_tokens`
  (`:587-594`), where the auto-detected default is `'max_tokens'` only for chutes.ai, DeepSeek, Moonshot,
  Cloudflare AI Gateway, Together, NVIDIA, Ant Ling, and Z.ai, and **`'max_completion_tokens'` otherwise**
  (`:1248-1265`). A bare `http://127.0.0.1:8790/v1` falls into the `else`, so pi-ai would send
  `max_completion_tokens`. **Local servers overwhelmingly want `max_tokens`.** Make it a config field with
  default `max_tokens`, and be prepared to omit it entirely — a strict local server rejects an unknown
  field with a 400.
* **`stop`.** The harness supports it (`GenerateOptions.stop?: string[]`, mapped straight to `stop`), but
  pi-ai rejects it: `if (options.stop !== undefined) throw new LlmError('llm-pi-ai does not support
  GenerateOptions.stop', 'UNSUPPORTED_OPTION')` (`pi-ai/lib/index.js:1848`; README:117) because pi-ai's
  common streaming API cannot guarantee it across providers. Your direct bridge has no such excuse — map it
  to `stop`. Note the agent loop rarely sets it.
* **Attribution headers are mandatory.** "Every provider HTTP request must include `attributionHeaders()`"
  (`dsh-llm/lib/index.js:1666-1668`). `attributionHeaders(identity?)` returns
  `{ 'user-agent': '<product>/<version> (+<url>)' }` (`:877-879`); "omission cannot suppress attribution"
  (`:853`). The rationale note is referenced at `dsh-llm-deepseek/README.md:161`
  (`Mandatory app attribution headers`). Merge it into every request — the model call *and* discovery
  (`pi-ai/lib/index.js:2312`).
* **Deployment headers.** pi-ai merges configured `headers` last so they can override defaults, after
  removing case-insensitive collisions with its own attribution headers (`requestHeaders`,
  `pi-ai/lib/index.js:1737-1744`). Same idea for your token header.
* **Reasoning content.** If your endpoint emits `reasoning_content` / `reasoning` / `reasoning_text` deltas,
  pi-ai reads the **first non-empty** of those three fields to avoid duplication when a server sends two of
  them with identical content (`pi-ai-openai-completions.js:395-424`). Mirror that if you support reasoning
  at all; otherwise ignore those fields and map them to nothing.

---

## 8. Minimal skeleton

Copy-pasteable ESM plugin. Real protocol code, no placeholders. Imports resolve from the dsh install
(`@deepseek-ai/dsh-llm` exports `LlmAdapter`, `LlmError`, `ToolCallId`, `attributionHeaders`, `RetryPolicySchema`;
`@deepseek-ai/schemastery` exports the schema builder; `@deepseek-ai/dsh-launch-environment` exports
`launchEnvironmentOf`).

```js
// plugin: dsh-llm-local-openai — one route 'local-openai' over an OpenAI-compatible SSE endpoint.
import { LlmAdapter, LlmError, ToolCallId, attributionHeaders, assertUsableApiKey } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'

const PROVIDER = 'local-openai'
const CONFIGURED_MODEL = 'local-model'

export const name = 'llm-local-openai'
export const inject = ['llm']

export const Config = z.object({
  baseURL: z.string().default('http://127.0.0.1:8790/v1').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default('LOCAL_OPENAI_TOKEN').volatile(),
  modelName: z.string().default(CONFIGURED_MODEL).volatile(),
  contextWindow: z.number().step(1).min(1).default(131072).volatile(),
  maxTokens: z.number().step(1).min(1).default(8192).volatile(),
  maxTokensField: z.union(['max_tokens', 'max_completion_tokens']).default('max_tokens').volatile(),
})

class LocalOpenAiAdapter extends LlmAdapter {
  constructor(readConfig, resolveToken) { super(); this.readConfig = readConfig; this.resolveToken = resolveToken }

  // Called synchronously by registerAdapter(); must return {id: provider, name: non-empty}.
  providerInfo(provider) { return { id: provider, name: 'Local OpenAI' } }

  // Default is normal/5-retries; returning undefined is fine. Return a resolved policy to change it.
  providerRetryPolicy(_provider) { return undefined }

  // Must list every model the GUI may select; entries are validated (provider/id/name non-empty, ids unique).
  listModels(provider) {
    const { modelName } = this.readConfig()
    return Promise.resolve([{ provider, id: modelName, name: modelName, inputModalities: ['text'] }])
  }

  // Must echo provider and model back exactly; context.contextWindow drives occupancy display.
  resolveModel(provider, model) {
    const { contextWindow, maxTokens } = this.readConfig()
    return Promise.resolve({
      provider, id: model, name: model, inputModalities: ['text'],
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
    })
  }

  async *stream(options) {
    if (options.stop !== undefined && !Array.isArray(options.stop)) {
      throw new LlmError('local-openai: malformed stop list', 'INVALID_REQUEST')
    }
    const cfg = this.readConfig()
    const token = await this.resolveToken()

    // ---- request ----------------------------------------------------------
    const body = {
      model: options.model,
      stream: true,                                   // mandatory: this adapter is SSE-only
      stream_options: { include_usage: true },         // without this most servers report no usage
      messages: toWireMessages(options),
      ...(options.tools?.length ? {
        tools: options.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      } : {}),
      ...(options.maxTokens !== undefined ? { [cfg.maxTokensField]: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.stop !== undefined ? { stop: options.stop } : {}),
    }

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])

    let response
    try {
      response = await fetch(`${cfg.baseURL.replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...attributionHeaders(),                     // mandatory on every provider request
        },
        body: JSON.stringify(body),
        signal: upstream,
      })
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('local-openai request aborted by caller', 'ABORTED', { cause: error })
      throw new LlmError('local-openai transport failed', 'TRANSPORT', { cause: error })
    }
    if (!response.ok) throw await httpFailure(response)
    if (response.body === null) throw new LlmError('local-openai returned no response body', 'EMPTY_RESPONSE')

    // ---- stream -----------------------------------------------------------
    let nextIndex = 0
    let text = null            // { index, text }
    let reasoning = null       // { index, text }
    const toolCalls = new Map() // wire tool_calls[].index -> { index, id, name, args }
    let usage = null
    let finishReason = null
    let sawTerminal = false

    const openText = () => (text ??= { index: nextIndex++, text: '' })
    const openReasoning = () => (reasoning ??= { index: nextIndex++, text: '' })
    const openToolCall = (wireIndex, id, callName) => {
      let call = toolCalls.get(wireIndex)
      if (call === undefined) {
        call = { index: nextIndex++, id: ToolCallId(id ?? ''), name: callName ?? '', args: '' }
        toolCalls.set(wireIndex, call)
        return { call, started: true }
      }
      if (id !== undefined && id !== '') call.id = ToolCallId(id)
      if (callName !== undefined && callName !== '') call.name = callName
      return { call, started: false }
    }

    try {
      for await (const event of sseEvents(response.body, upstream)) {
        if (event === '[DONE]') { sawTerminal = true; break }
        let chunk
        try { chunk = JSON.parse(event) } catch {
          throw new LlmError('local-openai SSE contains invalid JSON', 'MALFORMED_RESPONSE')
        }
        if (chunk?.usage) usage = chunk.usage                       // final chunk, choices: []
        const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
        if (choice === undefined) continue

        const delta = choice.delta ?? {}
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          const block = openText()
          if (block.text === '') yield { type: 'block-start', index: block.index, blockType: 'text' }
          block.text += delta.content
          yield { type: 'text-delta', index: block.index, text: delta.content }
        }
        // first non-empty of the three spellings avoids duplication when a server sends two
        const reasoningText = ['reasoning_content', 'reasoning', 'reasoning_text']
          .map((f) => delta[f]).find((v) => typeof v === 'string' && v.length > 0)
        if (reasoningText !== undefined) {
          const block = openReasoning()
          if (block.text === '') yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
          block.text += reasoningText
          yield { type: 'reasoning-delta', index: block.index, text: reasoningText }
        }
        for (const call of delta.tool_calls ?? []) {
          const wireIndex = typeof call.index === 'number' ? call.index : 0
          const { call: block, started } = openToolCall(wireIndex, call.id, call.function?.name)
          if (started) yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          const argumentsDelta = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
          block.args += argumentsDelta
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: block.id,
            ...(block.name === '' ? {} : { name: block.name }),
            argumentsDelta,
          }
        }
        if (typeof choice.finish_reason === 'string') { finishReason = choice.finish_reason; sawTerminal = true }
      }
      if (options.signal?.aborted) throw new LlmError('local-openai request aborted by caller', 'ABORTED')

      // close every open block, in opening order; block-end's block is the durable block
      if (reasoning !== null) yield { type: 'block-end', index: reasoning.index, block: { type: 'reasoning', text: reasoning.text } }
      if (text !== null) yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.text } }
      for (const block of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
        yield { type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id, name: block.name, arguments: block.args } }
      }

      if (!sawTerminal) throw new LlmError('local-openai stream ended without a finish_reason', 'STREAM_CLOSED')

      const reason = mapFinish(finishReason, nextIndex === 0)
      if (usage !== null) yield { type: 'usage', usage: mapUsage(usage) }   // usage precedes finish
      yield { type: 'finish', reason }                                     // no replayState: omit it
    } finally {
      consumer.abort('local-openai stream consumer stopped')               // drop the socket on early exit
    }
  }
}

// ---- helpers ---------------------------------------------------------------
function toWireMessages(options) {
  const messages = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  const toolNames = new Map()      // toolCallId -> name, so role:'tool' can name its call
  for (const message of options.messages) {
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    if (message.role === 'system' || message.role === 'developer') {
      if (text.length > 0) messages.push({ role: 'system', content: text })  // developer -> system
      continue
    }
    if (message.role === 'assistant') {
      const calls = message.content.filter((b) => b.type === 'tool-call')
      for (const call of calls) toolNames.set(call.id, call.name)
      if (text.length === 0 && calls.length === 0) continue                  // never send an empty assistant turn
      messages.push({
        role: 'assistant',
        content: text,                                                       // plain string, never a block array
        ...(calls.length === 0 ? {} : {
          tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        }),
      })
      continue
    }
    if (message.role === 'tool') {
      messages.push({
        role: 'tool',
        content: text.length > 0 ? text : (message.isError === true ? '(tool failed)' : '(no tool output)'),
        tool_call_id: message.toolCallId,
      })
      continue
    }
    messages.push({ role: 'user', content: text })
  }
  return messages
}

async function* sseEvents(body, signal) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) break
        const line = buffer.slice(0, nl).replace(/\r$/u, '')
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue                               // ignore comments/blank/event: lines
        const payload = line.slice(5).trim()
        if (payload.length === 0) continue
        yield payload
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim()
      if (payload.length > 0) yield payload
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

function mapUsage(usage) {
  const input = Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0
  const output = Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : 0
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : input + output,
    ...(Number.isSafeInteger(cacheRead) && cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(Number.isSafeInteger(reasoningTokens) && reasoningTokens > 0 ? { reasoningTokens } : {}),
  }
}

function mapFinish(finishReason, empty) {
  switch (finishReason) {
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return { kind: 'error', failure: { message: 'local-openai filtered the response', code: 'CONTENT_FILTER' } }
    case 'stop':
      return empty
        ? { kind: 'error', failure: { message: 'local-openai returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
        : { kind: 'stop' }
    default:
      return { kind: 'stop' }
  }
}

async function httpFailure(response) {
  let detail = ''
  try {
    const body = await response.text()
    if (body.length > 0) detail = ` ${body.slice(0, 2000)}`
  } catch { /* the status alone still classifies */ }
  const status = response.status
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 402 ? 'QUOTA'
      : status === 429 ? 'RATE_LIMIT'
        : status === 400 || status === 413 || status === 422 ? 'INVALID_REQUEST'
          : status >= 500 ? 'SERVER'
            : `HTTP_${status}`
  const retryAfter = response.headers.get('retry-after')
  const seconds = retryAfter === null ? NaN : Number(retryAfter)
  const requestId = response.headers.get('request-id') ?? response.headers.get('x-request-id')
  return new LlmError(`local-openai endpoint answered ${status}${detail}`, code, {
    status,
    ...(Number.isFinite(seconds) && seconds > 0 ? { providerRetryAfterMs: seconds * 1000 } : {}),
    ...(requestId === null || requestId === '' ? {} : { requestId }),
  })
}

// ---- plugin ----------------------------------------------------------------
export function apply(ctx, config) {
  const readConfig = () => ({
    baseURL: config.baseURL.get(),
    apiKeyEnv: config.apiKeyEnv.get(),
    modelName: config.modelName.get(),
    contextWindow: config.contextWindow.get(),
    maxTokens: config.maxTokens.get(),
    maxTokensField: config.maxTokensField.get(),
  })
  readConfig()                                       // fail fast on an invalid stored configuration

  const resolveToken = async () => {
    const { apiKeyEnv: ref } = readConfig()
    if (ref === undefined || ref === '') return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit === undefined || hit.length === 0) {
      throw new LlmError(`llm-local-openai: ${ref} is not set; store it through the credentials service or export it`, 'MISSING_CREDENTIAL')
    }
    return assertUsableApiKey(hit, 'llm-local-openai', ref)
  }

  const settingsNs = ctx.fiber.entry?.options.id ?? name

  // Optional but recommended: without this the route has no settings address (see §1.3).
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'Local OpenAI',
    settingsNs,
    settingsPath: [],
  }])

  // Optional: lets the Models page interrogate GET {baseURL}/models for this namespace.
  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    const { baseURL, modelName } = readConfig()
    const url = `${(request.baseURL ?? baseURL).replace(/\/+$/u, '')}/models`
    const token = request.apiKey ?? await resolveToken().catch(() => undefined)
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...attributionHeaders(),
      },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new LlmError(`${url} answered ${response.status}`, 'DISCOVERY_FAILED')
    const listing = await response.json()
    const rows = Array.isArray(listing?.data) ? listing.data : []
    const models = rows
      .filter((row) => typeof row?.id === 'string' && row.id.length > 0)
      .map((row) => ({ id: row.id, name: typeof row.name === 'string' ? row.name : row.id }))
    return models.length > 0 ? models : [{ id: modelName, name: modelName }]
  })

  const adapter = new LocalOpenAiAdapter(readConfig, resolveToken)
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)

  // retryPolicy is captured at registration; re-register in place when it changes.
  ctx.on('loader/volatile-update', () => {
    try { registration.replace([PROVIDER]) } catch (error) { ctx.logger.error(error) }
  })

  ctx.logger.info(`llm-local-openai: route "${PROVIDER}" registered for ${readConfig().baseURL}`)
}
```

Notes on the skeleton:

* `ToolCallId(...)` is the exported brand constructor (`dsh-llm/lib/index.js:906-908`); at runtime it is the
  identity function, but using it keeps the type honest.
* `registerModelDiscovery` is registered **before** `registerAdapter` only for readability; the two are
  independent. Both are disposed with the fiber.
* The `finally { consumer.abort(...) }` is what stops the HTTP body when the loop stops iterating early —
  the runtime calls `iterator.return()` on early consumer exit (`dsh-llm/lib/index.js:2350-2353`).
* Deliberately omitted: an idle watchdog (`TIMEOUT`), a `RetryPolicySchema` config field, replay state,
  image handling, and a per-request `maxRequestImageBytes` budget. Add the first two if you need them; skip
  the rest for a text-only local endpoint.

---

## 9. Gotchas

1. **`providerInfo` is required eagerly and synchronously.** It is called inside `registerAdapter` before
   anything is committed (`dsh-llm/lib/index.js:1864`). It must not be `async`, must not do I/O, and must
   return `{id: <the exact provider string>, name: <non-empty>}` or registration throws
   `INVALID_ADAPTER`. Same for `providerRetryPolicy` (`:1867`).
2. **`providerInfo` / `providerRetryPolicy` results are frozen at registration time.** A later config
   change is invisible until `handle.replace(routes)` runs. `llm-pi-ai` solves this by comparing
   *registration facts* (`{provider, displayName, retryPolicy}`, sorted by provider) on every
   `loader/volatile-update` and calling `replace` only on a real change
   (`dsh-llm-pi-ai/lib/index.js:2498-2504`, `:2612-2627`); `dsh-llm-deepseek` does the same for the policy
   alone (`deepseek/lib/index.js:2267-2280`). Wrap the `replace` in try/catch and log — `llm-pi-ai` logs
   "configuration conflicts with an existing provider route" rather than failing the update (`:2628-2636`).
3. **Duplicate registration is a hard failure, all-or-nothing.** `DUPLICATE_ADAPTER` for a route another
   adapter owns (`:1863`) — "registering a route another adapter already owns fails plugin loading"
   (`dsh-llm-pi-ai/README.md:34`). `DUPLICATE_DIRECTORY` for a provider already in the directory (`:1926`);
   `DUPLICATE_DISCOVERY` for a namespace already offered (`:1977`). Note the asymmetry: an adapter *may*
   re-register its own routes via `replace`, but a directory entry owned by another registration never
   becomes available.
4. **Register before agents resolve models — and expect the GUI to be live immediately.** Registrations
   publish `llm/adapters-updated` on every commit (`:1804-1819`, `:1893`, `:1935`, `:1944`); the Models
   page and every resident model directory refetch on that event
   (`dsh-client-ui-settings-models/README.md:84`, `dsh-client-ui-model-selection/README.md:68`). Nothing
   needs a restart. But an agent step that has already assembled its route keeps it: "A complete selection
   applies to the next request; a running step keeps the model and effort it started with"
   (`dsh-client-ui-model-selection/README.md:14`), and `prepareCall` deliberately pins one adapter
   generation across logging and dispatch (`dsh-llm/lib/index.js:2155-2157`, `:2224-2235`).
   So a newly registered route is selectable for the next step, not the current one.
5. **Hot reload / disposal.** Both registrations are `ctx.effect(...)`-scoped and disappear with the fiber
   (`:1836`, `:1937`, `:1975`). On HMR the old adapter's route is released *before* the new one registers,
   in one synchronous section (`commitRoutes`, `:1886-1894`), so no request observes a gap — but a
   `prepared` call captured under the old generation will still dispatch through the old adapter, which is
   the point. Do not cache state on the module (module-level state survives a reload while the fiber does
   not); keep it on the plugin instance or in `Config`. `llm-pi-ai` also notes that "Replay state travels
   only within one adapter" — a new adapter instance means replay state from the previous generation is
   stripped before dispatch (`dsh-llm/README.md:115`), so an adapter that *does* use replay state must
   tolerate its sudden absence after a reload.
6. **Never retry inside the adapter.** `maxRetries: 0` in pi-ai's options (`pi-ai/lib/index.js:1684`),
   "Retry policy is provider-owned, not an SDK retry" (`dsh-llm-pi-ai/README.md:231`). Retrying inside
   `stream()` would double-bill invisibly and defeat the durable `llm/retry` event.
7. **`GenerateOptions.stop`:** supported by the service and by `dsh-llm-deepseek`'s vocabulary, rejected by
   pi-ai with `UNSUPPORTED_OPTION` (`pi-ai/lib/index.js:1848`). Your direct bridge should map it; just be
   aware a strict local server may 400 on it.
8. **`reasoningEffort` is a live trap if you declare no reasoning metadata.** `resolveCallWithInfo`
   throws `UNSUPPORTED_REASONING_EFFORT` before any provider I/O when the request names an effort and
   `info.reasoning` is undefined (`:2177-2178`), and equally when the effort is not among `efforts`
   (`:2182`). A saved session selection or `dsh-agent-default-model.reasoningEffort` can supply one. The
   defensive choice for a non-reasoning endpoint is to advertise a **single `off` effort with
   `defaultEffort: 'off'`** — exactly `dsh-llm-deepseek`'s disabled-thinking shape
   (`deepseek/lib/index.js:517-519`) — which satisfies `resolveCallWithInfo` for the omitted case and
   rejects an explicit non-off effort with a clear code. Advertising nothing at all leaves the Effort row
   absent (good UI) but fails the same request.
9. **Reasoning deltas must still be closed.** A `reasoning` block left open without `block-end` still
   assembles from its deltas (`assembler.js:99`), but a *tool-call* block left open with an empty name is
   unusable (§4.3). Close everything before `finish`.
10. **`totalTokens` is not derived for you.** `BlockAssembler` stores the usage object verbatim; the
    token-meter anchors on it (`dsh-token-meter/README.md:45`). Supply it, or accept that a consumer
    folding your usage may treat the totals as conflicting.
11. **`MISSING_CREDENTIAL` vs `INVALID_CREDENTIAL`.** A reference that resolves to nothing →
    `MISSING_CREDENTIAL`; a value that is blank or carries characters no HTTP header can carry →
    `INVALID_CREDENTIAL`. Use the shared `assertUsableApiKey(raw, pkg, ref)` (`dsh-llm/lib/index.js:1659-1663`,
    `api-key.js` backing it) and never put the key or any part of it in the message
    (`pi-ai/lib/index.js:2569` is the model wording). "A route whose `apiKeyEnv` reference resolves to
    nothing fails the request with `MISSING_CREDENTIAL`" (`dsh-llm-pi-ai/README.md:38`).
12. **A keyless endpoint still needs a credential unless you handle it.** pi-ai's OpenAI-compatible
    implementation requires an API key or an `Authorization` header, "so a keyless local server needs a
    placeholder credential referenced by `apiKeyEnv` or an `Authorization` entry in `headers`"
    (`dsh-llm-pi-ai/README.md:227`). Your own bridge has no such constraint — the skeleton above simply
    omits the header when the reference is empty — but if you *do* point `apiKeyEnv` at an unset
    reference, expect `MISSING_CREDENTIAL` by design.
13. **`headers` are deployment config, not model-visible text.** `llm-pi-ai` warns that "`headers` can
    carry a credential the redactor never sees … store credentials as `apiKeyEnv` references"
    (`dsh-llm-pi-ai/README.md:222`). Same applies to your token header.
14. **The models page edits pi-ai routes only.** "Only pi-ai routes can be hand-declared — the custom-API
    form writes into `llm-pi-ai`" (`dsh-client-ui-settings-models/README.md:127`). Your plugin's config
    fields live in `cordis.patch.yml` (or an overriding home patch / CLI overlay) unless you register a
    client-side slot (`settings.models.provider-card`, `:64`). Editing configuration is followed by HMR or
    a profile restart of the adapter's own `internal/config` validation — the pattern
    `llm-pi-ai` uses is a waterfall listener that re-validates the candidate and lets a throw reject the
    write (`pi-ai/lib/index.js:2556-2562`).
15. **Do not read the request as mutable.** "Loop-built requests arrive deep-frozen, so listeners and
    adapters read them and never rewrite them" (`dsh-llm/README.md:88`, `:114`). Build new objects.
    `Object.isFrozen(options)` is even used by the runtime to decide how to re-freeze after projection
    (`:2302-2308`, `:2321`).
16. **`GenerateOptions.messages` may contain request-only inputs.** `RequestUserInput` has `role: 'user'`,
    `content`, and **no** `id`/`source` (`oracle`; `dsh-llm/README.md:61`). Your conversion must not assume
    `message.id` or `message.source` exist. Do not mutate or retain them — "Callers keep auxiliary inputs
    unchanged until the stream settles."
17. **HTTP status is not always available.** pi-ai's limitation — "Provider HTTP status is unavailable"
    (`dsh-llm-pi-ai/README.md:230`) — is a consequence of routing through a library that reports errors as
    terminal events. A direct `fetch` bridge **does** have the status; put it in `LlmFailure.status` so a
    UI or a later analysis can see it. That is a strict improvement over the library path.

---

## 10. UNVERIFIED

1. **UNVERIFIED: the exact field the model picker uses for a provider's group heading.** The client
   bundle `dsh-client-ui-model-selection/lib/client.js` contains no `listProviders` / `resolveModelInfo` /
   `displayName` / `settingsNs` symbols, so it renders a Host-built directory fetched through
   `session.models` (`dsh-client-ui-model-selection/README.md:68`); the Host-side builder of that directory
   was not located in the bundle. Missing: which of `LlmProviderInfo.name` (`ctx.llm.listProviders()`,
   `dsh-llm/lib/index.js:1899`) or `LlmConfigurableProvider.displayName` supplies the heading. Mitigation
   in §1.4: set both to the same string. Also missing: whether the picker can show a provider that has a
   registered adapter but **no** directory entry (the READMEs say such a route "stays visible in pickers",
   `dsh-client-ui-settings-models/README.md:130`, which implies yes, but the mechanism is unlocated).
2. **UNVERIFIED: the exact interface declarations of `TextBlock`, `MessageBase`, `ContentBlock`, and the
   content-block union.** No `.d.ts` file is packaged (`node_modules/@deepseek-ai/dsh-llm/**/*.d.ts` → 0
   matches in the asar) and the live `Service.listService` oracle returns only *referenced* declarations,
   which excludes these. Reconstructed shapes come from runtime use: `TextBlock = {type:'text', text:string}`
   (`assembler.js:98`), `ToolCallBlock = {type:'tool-call', id, name, arguments:string}` (`assembler.js:100-105`,
   oracle), `ReasoningBlock = {type:'reasoning', text:string}` (oracle). Missing: the declared optional
   members of `MessageBase` (only `content` and, for `Message`, `id` plus `source` are confirmed by use).
3. **UNVERIFIED: `dsh/docs/subsystems/llm-streaming.md`, `dsh/docs/config-catalog.md`, and the
   `.agents/notes/...` documents.** Every README in this area links to them as the definitive
   `StreamChunk`/adapter contract and the exhaustive config catalog, but the asar contains no `docs/` or
   `.agents/` tree at all (0 matches for `llm-streaming`, 0 for `docs/subsystems/`). This document
   reconstructs the protocol from the runtime and both shipped adapters instead.
4. **UNVERIFIED: whether a non-`llm` Host inspect provider can enumerate the projected `Config` JSON
   Schema of an *unmounted* plugin.** The `Config.listConfigs` query only listed the live
   `include:llm-pi-ai` entry in this profile, so the schema was read from source
   (`dsh-llm-pi-ai/lib/index.js:940-1051`) and cross-checked against the live projection for that one
   entry. Missing: a way to validate a to-be-written plugin's schema without mounting it.
5. **UNVERIFIED: the exact behaviour of OpenAI-compatible local servers at
   `http://127.0.0.1:8790/v1`.** The endpoint was not contacted; no request was made to it. Every
   wire-level claim in §7 is sourced from `@earendil-works/pi-ai/dist/api/openai-completions.js` and
   `dsh-llm-deepseek`, not from the live server. Specifically unverified for this endpoint: whether it
   sends `usage` even with `stream_options.include_usage`, whether it accepts `developer`, whether it wants
   `max_tokens` or `max_completion_tokens`, and whether it emits `reasoning_content`. The config field
   `maxTokensField` in the skeleton exists precisely because this is unknown.
6. **UNVERIFIED: cost display.** The task asked how "cost/context display" is derived. There is **no
   monetary cost surface** in the bundle: `dsh-token-meter` exposes token counts and context pressure
   (`dsh-token-meter/README.md:49`, `:68`) and states outright that "Occupancy is a reference figure, not a
   billing record" (`:68`). Missing: any package that converts `TokenUsage` into currency, or any UI that
   displays a price. If a price display is expected, it does not exist in this build.
7. **UNVERIFIED: `LlmFailure.code` taxonomy completeness for local-server failure modes.** The canonical
   code list was assembled from `dsh-llm/lib/types/error.js`, `dsh-llm/lib/index.js`, and
   `dsh-llm-deepseek/README.md:118`; there is no single exported enumeration of all codes, so a code used
   elsewhere in the tree (e.g. by a compaction or auth plugin) may be missing from §5.2. Codes used by the
   skeleton outside the confirmed set: none — `CONTENT_FILTER` appears in `mapFinish` as an
   adapter-local code, which is legal (codes are opaque non-empty strings to the service) but is not part
   of any documented taxonomy and therefore will not be retried by the default `retryableCodes`.
