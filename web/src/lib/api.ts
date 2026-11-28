import type { QuotaInfo, UsageBucket, UsageModelRow } from '../types/api';

const API_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 15_000;

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
}

export async function api<T = Record<string, unknown>>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T & { _httpOk?: boolean; _status?: number; error?: string }> {
  const { timeoutMs = API_TIMEOUT_MS, signal: userSignal, headers, ...rest } = options;
  const signal = userSignal ?? (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(timeoutMs)
    : undefined);

  try {
    const res = await fetch(path, {
      ...rest,
      signal,
      headers: {
        'x-workbuddy-panel': '1',
        ...(headers || {}),
      },
    });
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { error: text || `HTTP ${res.status}` };
    }
    return {
      ...parsed,
      _httpOk: res.ok,
      _status: res.status,
    } as T & { _httpOk?: boolean; _status?: number; error?: string };
  } catch (err) {
    const e = err as Error;
    const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ok: false,
      _httpOk: false,
      _status: 0,
      error: isTimeout ? '请求超时（20 秒），请重试' : String(e?.message || err),
    } as unknown as T & { _httpOk?: boolean; _status?: number; error?: string };
  }
}

export async function connectRead<T = Record<string, unknown>>(
  path: string,
  options: RequestInit = {},
): Promise<{ status: number; ok: boolean; body: T | null; netError?: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      ...options,
      signal: ac.signal,
      headers: {
        'x-workbuddy-panel': '1',
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let body: T | null = null;
    try {
      body = text ? (JSON.parse(text) as T) : null;
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    const e = err as Error;
    const msg = e?.name === 'AbortError' ? 'timeout' : String(e?.message || err);
    return { status: 0, ok: false, body: null, netError: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function singleFlight<T extends (...args: never[]) => Promise<unknown>>(fn: T): T {
  let inflight: Promise<unknown> | null = null;
  return ((...args: Parameters<T>) => {
    if (inflight) return inflight;
    inflight = Promise.resolve(fn(...args)).finally(() => {
      inflight = null;
    });
    return inflight;
  }) as T;
}

export function lsGet(key: string, fallback = ''): string {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore private mode / quota errors */
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallback below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function csvCell(value: unknown): string {
  const shared = (window as unknown as { csvCell?: (v: unknown) => string }).csvCell;
  if (typeof shared === 'function') return shared(value);
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function downloadCsv(filename: string, rows: unknown[][]): void {
  const shared = (window as unknown as { downloadCsv?: (f: string, r: unknown[][]) => void }).downloadCsv;
  if (typeof shared === 'function') {
    shared(filename, rows);
    return;
  }
  const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function localDateStr(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '0';
  return Number(n).toLocaleString('en-US');
}

export function fmtCompact(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${Number(m.toFixed(1))}M`;
  }
  if (v >= 1_000) {
    const k = Math.round(v / 1_000);
    return `${k}K`;
  }
  return String(v);
}

export function fmtCredit(value: number | null | undefined, reported: boolean | number | null | undefined): string {
  if (!reported) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return String(Number(n.toFixed(4)));
}

export function fmtDuration(ms: number | null | undefined, en = false): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return en ? 'Expired' : '已过期';
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return en ? `${days}d ${hours}h` : `${days} 天 ${hours} 小时`;
  if (hours > 0) return en ? `${hours}h ${mins}m` : `${hours} 小时 ${mins} 分`;
  if (mins > 0) return en ? `${mins}m` : `${mins} 分钟`;
  return en ? '< 1m' : '不到 1 分钟';
}

export function fmtUptime(ms: number | null | undefined, en = false): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return en ? `${sec}s` : `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return en ? `${min}m` : `${min} 分钟`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return en ? `${hr}h ${remMin}m` : `${hr} 小时 ${remMin} 分`;
  const days = Math.floor(hr / 24);
  const remHr = hr % 24;
  return en ? `${days}d ${remHr}h` : `${days} 天 ${remHr} 小时`;
}

export function fmtClock(t: number | Date | string = new Date()): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtShortClock(t: number | Date | string): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDateTime(t: number | Date | string): string {
  const d = t instanceof Date ? t : new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtAgo(t: number | null | undefined, en = false): string {
  if (!t || !Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return en ? `${sec}s ago` : `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return en ? `${min}m ago` : `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return en ? `${hr}h ago` : `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  return en ? `${days}d ago` : `${days} 天前`;
}

export function fmtCountdown(ms: number, en = false): string {
  if (ms <= 0) return en ? 'Recovering now' : '即将恢复';
  if (ms < 120_000) {
    const s = Math.max(1, Math.ceil(ms / 1000));
    return en ? `${s}s` : `${s} 秒`;
  }
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return en ? `${d}d ${h}h` : `${d} 天 ${h} 小时`;
  if (h > 0) return en ? `${h}h ${m}m` : `${h} 小时 ${m} 分`;
  if (m > 0) return en ? `${m}m` : `${m} 分`;
  return en ? '< 1m' : '不到 1 分钟';
}

export function fmtRunMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseQuotaExpiryMs(value: string | undefined): number {
  if (!value) return NaN;
  const s = String(value).trim().replace(' ', 'T');
  return Date.parse(s);
}

export interface QuotaExpiringSummary {
  remain: number;
  days: number;
  dateStr: string;
  signature: string;
}

export function quotaExpiringInfo(
  quota: QuotaInfo | null | undefined,
  warnDays = 7,
  now = Date.now(),
): QuotaExpiringSummary | null {
  if (!quota || quota.unlimited === true || Number(quota.total) < 0) return null;
  const pkgs = Array.isArray(quota.packages) ? quota.packages : [];
  const todayStart = localDayStart(now);
  const candidates: Array<{ dayMs: number; days: number; remain: number }> = [];
  for (const p of pkgs) {
    const remain = Number(p.remain);
    if (!Number.isFinite(remain) || remain <= 0) continue;
    const ms = parseQuotaExpiryMs(p.expiresAt);
    if (!Number.isFinite(ms)) continue;
    const dayMs = localDayStart(ms);
    const days = Math.round((dayMs - todayStart) / 86_400_000);
    if (days >= 0 && days <= warnDays) {
      candidates.push({ dayMs, days, remain });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.days - b.days || b.remain - a.remain);
  const firstDay = candidates[0].dayMs;
  const firstDays = candidates[0].days;
  const remain = candidates
    .filter((c) => c.dayMs === firstDay)
    .reduce((sum, c) => sum + c.remain, 0);
  const d = new Date(firstDay);
  const dateStr = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const signature = [...new Set(candidates.map((c) => c.dayMs))].sort((a, b) => a - b).join(',');
  return { remain, days: firstDays, dateStr, signature };
}

/** Natural Monday-first weekly aggregation over local YYYY-MM-DD day buckets. */
export function toWeekBuckets(days: UsageBucket[]): UsageBucket[] {
  if (!Array.isArray(days) || !days.length) return [];
  const parseLocal = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  const mondayOf = (dt: Date) => {
    const d = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return d;
  };
  const keyOf = (dt: Date) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

  const sorted = [...days].filter((d) => d.day).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  if (!sorted.length) return [];

  const firstMon = mondayOf(parseLocal(String(sorted[0].day)));
  const lastDayMon = mondayOf(parseLocal(String(sorted[sorted.length - 1].day)));
  const todayMon = mondayOf(new Date());
  const endMon = lastDayMon.getTime() > todayMon.getTime() ? lastDayMon : todayMon;

  const map = new Map<string, UsageBucket & { _byModel: Map<string, UsageModelRow> }>();
  const cur = new Date(firstMon.getTime());
  while (cur.getTime() <= endMon.getTime()) {
    const k = keyOf(cur);
    map.set(k, {
      day: k,
      label: k.slice(5),
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      credit: 0,
      creditCalls: 0,
      searches: 0,
      searchFailed: 0,
      videos: 0,
      videoFailed: 0,
      byModel: [],
      _byModel: new Map(),
    });
    cur.setDate(cur.getDate() + 7);
  }

  for (const d of sorted) {
    const monKey = keyOf(mondayOf(parseLocal(String(d.day))));
    const bucket = map.get(monKey);
    if (!bucket) continue;
    bucket.calls += Number(d.calls) || 0;
    bucket.promptTokens += Number(d.promptTokens) || 0;
    bucket.completionTokens += Number(d.completionTokens) || 0;
    bucket.credit = Number((bucket.credit + (Number(d.credit) || 0)).toFixed(4));
    bucket.creditCalls += Number(d.creditCalls) || 0;
    bucket.searches = (bucket.searches || 0) + (Number(d.searches) || 0);
    bucket.searchFailed = (bucket.searchFailed || 0) + (Number(d.searchFailed) || 0);
    bucket.videos = (bucket.videos || 0) + (Number(d.videos) || 0);
    bucket.videoFailed = (bucket.videoFailed || 0) + (Number(d.videoFailed) || 0);
    for (const m of d.byModel || []) {
      const prev = bucket._byModel.get(m.model) || {
        model: m.model,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        ms: 0,
        credit: 0,
        creditCalls: 0,
      };
      prev.calls += Number(m.calls) || 0;
      prev.promptTokens += Number(m.promptTokens) || 0;
      prev.completionTokens += Number(m.completionTokens) || 0;
      prev.ms += Number(m.ms) || 0;
      prev.credit = Number((prev.credit + (Number(m.credit) || 0)).toFixed(4));
      prev.creditCalls += Number(m.creditCalls) || 0;
      bucket._byModel.set(m.model, prev);
    }
  }

  return [...map.values()].map(({ _byModel, ...rest }) => ({
    ...rest,
    byModel: [..._byModel.values()].sort((a, b) => b.credit - a.credit || b.calls - a.calls),
  }));
}

export const MODEL_CHART_PALETTE = [
  '#0a84ff',
  '#30d158',
  '#ff9f0a',
  '#bf5af2',
  '#64d2ff',
  '#ff375f',
  '#5e5ce6',
  '#ff6961',
];
