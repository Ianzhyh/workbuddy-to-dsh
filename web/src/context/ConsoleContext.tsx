import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  api,
  connectRead,
  fmtClock,
  fmtDateTime,
  fmtDuration,
  fmtUptime,
  lsGet,
  lsSet,
  singleFlight,
} from '../lib/api';
import { useI18n } from '../lib/i18n';
import type {
  AccentId,
  AccountsResponse,
  AutoSwitchResponse,
  CheckinAccountsResponse,
  CheckinResponse,
  ClientsResponse,
  ConnectResponse,
  DiagnoseResponse,
  IdentityResponse,
  LimitsResponse,
  ModelsResponse,
  NavTab,
  OverviewResponse,
  PluginLoginResponse,
  ProbeRecord,
  ProbeResultsResponse,
  RequestsResponse,
  Theme,
  UsageData,
  UsageResponse,
} from '../types/api';

export interface ToastMessage {
  text: string;
  tone: '' | 'good' | 'err';
  title?: string;
}

export interface ConsoleContextValue {
  // Navigation & UI chrome
  activeTab: NavTab;
  setActiveTab: (tab: NavTab) => void;
  theme: Theme;
  toggleTheme: () => void;
  accent: AccentId;
  setAccent: (a: AccentId) => void;

  // Global feedback
  actionMsg: ToastMessage;
  setMsg: (text: string, tone?: '' | 'good' | 'err', title?: string) => void;
  liveAnnouncement: string;
  announce: (text: string) => void;

  // Data slices
  overview: OverviewResponse | null;
  overviewStamp: string;
  models: ModelsResponse | null;
  modelsStamp: string;
  probeResults: Record<string, ProbeRecord>;
  probeUpdatedAt: number | null;
  probeLastRun: { scope?: string; count?: number; at?: number } | null;
  probeRunning: boolean;
  setProbeRunning: React.Dispatch<React.SetStateAction<boolean>>;
  setProbeResultsState: React.Dispatch<React.SetStateAction<Record<string, ProbeRecord>>>;
  setProbeMeta: (updatedAt: number | null, lastRun?: { scope?: string; count?: number; at?: number } | null) => void;

  accounts: AccountsResponse | null;
  accountsStamp: string;
  autoSwitch: AutoSwitchResponse | null;
  pluginLogin: PluginLoginResponse | null;
  limits: LimitsResponse | null;
  limitsError: string;
  limitsStamp: string;

  usageDays: number;
  setUsageDays: (d: number) => void;
  trendGran: 'day' | 'week' | 'hour';
  setTrendGran: (g: 'day' | 'week' | 'hour') => void;
  usageDay: UsageData | null;
  usageView: UsageData | null;
  usageStamp: string;
  usageLoading: boolean;

  requests: RequestsResponse | null;
  reqLimit: number;
  setReqLimit: (n: number) => void;
  reqPause: boolean;
  setReqPause: (p: boolean) => void;
  reqModelFilter: string;
  setReqModelFilter: (m: string) => void;
  reqFailOnly: boolean;
  setReqFailOnly: (f: boolean) => void;
  reqStamp: string;
  failSeenTs: number;
  advanceFailWatermark: () => void;
  countNewFailures: () => number;

  checkin: CheckinResponse | null;
  checkinStamp: string;
  checkinAccounts: CheckinAccountsResponse | null;
  checkinAccountsStamp: string;

  diagnose: DiagnoseResponse | null;
  diagStamp: string;
  clients: ClientsResponse | null;
  clientsStamp: string;
  connect: ConnectResponse | null;
  connectError: { status: number; message: string; netError?: string } | null;

  // Loaders
  refreshingAll: boolean;
  refreshAll: () => Promise<void>;
  loadOverview: () => Promise<boolean>;
  loadModels: (opts?: { refresh?: boolean }) => Promise<ModelsResponse | null>;
  loadProbeResults: () => Promise<void>;
  resetProbeState: () => void;
  loadAccounts: () => Promise<void>;
  loadAutoSwitch: () => Promise<void>;
  loadPluginLogin: () => Promise<void>;
  loadLimits: (opts?: { refresh?: boolean }) => Promise<void>;
  loadUsage: (opts?: { days?: number; gran?: 'day' | 'week' | 'hour'; force?: boolean }) => Promise<void>;
  loadRequests: (limitOverride?: number) => Promise<void>;
  loadCheckin: () => Promise<void>;
  loadCheckinAccounts: () => Promise<void>;
  loadDiag: () => Promise<void>;
  loadClients: () => Promise<void>;
  loadConnect: (queryString?: string) => Promise<ConnectResponse | null>;

  // Utilities
  buildDiagReport: () => string;
}

const ConsoleContext = createContext<ConsoleContextValue | null>(null);

function withViewTransition(mutate: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduced && typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(mutate);
  } else {
    mutate();
  }
}

export const ACCENT_PRESETS: Array<{ id: AccentId; swatch: string; zh: string; en: string }> = [
  { id: 'blue', swatch: '#007aff', zh: '系统蓝（默认）', en: 'System Blue' },
  { id: 'violet', swatch: '#af52de', zh: '紫罗兰', en: 'Purple' },
  { id: 'teal', swatch: '#30b0c7', zh: '青碧', en: 'Teal' },
  { id: 'moss', swatch: '#34c759', zh: '系统绿', en: 'Green' },
  { id: 'terracotta', swatch: '#ff9500', zh: '系统橙', en: 'Orange' },
];

export const ConsoleProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { en, t, tu } = useI18n();

  const [activeTab, setActiveTabState] = useState<NavTab>('all');
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = lsGet('wb.theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [accent, setAccentState] = useState<AccentId>(() => {
    const saved = lsGet('wb.accent') as AccentId;
    return ACCENT_PRESETS.some((p) => p.id === saved) ? saved : 'blue';
  });

  const [actionMsg, setActionMsg] = useState<ToastMessage>({ text: '', tone: '' });
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [overviewStamp, setOverviewStamp] = useState('');
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [modelsStamp, setModelsStamp] = useState('');
  const [probeResults, setProbeResultsState] = useState<Record<string, ProbeRecord>>({});
  const [probeUpdatedAt, setProbeUpdatedAt] = useState<number | null>(null);
  const [probeLastRun, setProbeLastRun] = useState<{ scope?: string; count?: number; at?: number } | null>(null);
  const [probeRunning, setProbeRunning] = useState(false);

  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [accountsStamp, setAccountsStamp] = useState('');
  const [autoSwitch, setAutoSwitch] = useState<AutoSwitchResponse | null>(null);
  const [pluginLogin, setPluginLogin] = useState<PluginLoginResponse | null>(null);

  const [limits, setLimits] = useState<LimitsResponse | null>(null);
  const [limitsError, setLimitsError] = useState('');
  const [limitsStamp, setLimitsStamp] = useState('');

  const [usageDays, setUsageDays] = useState<number>(7);
  const [trendGran, setTrendGran] = useState<'day' | 'week' | 'hour'>('day');
  const [usageDay, setUsageDay] = useState<UsageData | null>(null);
  const [usageView, setUsageView] = useState<UsageData | null>(null);
  const [usageStamp, setUsageStamp] = useState('');
  const [usageLoading, setUsageLoading] = useState(false);
  const usageCacheRef = useRef<{ day: Map<number, UsageData>; week: UsageData | null }>({ day: new Map(), week: null });

  const [requests, setRequests] = useState<RequestsResponse | null>(null);
  const [reqLimit, setReqLimit] = useState<number>(40);
  const [reqPause, setReqPause] = useState<boolean>(false);
  const [reqModelFilter, setReqModelFilter] = useState<string>('');
  const [reqFailOnly, setReqFailOnly] = useState<boolean>(false);
  const [reqStamp, setReqStamp] = useState('');
  const [failSeenTs, setFailSeenTs] = useState<number>(() => Number(lsGet('wb.failSeenTs', '0')) || 0);

  const [checkin, setCheckin] = useState<CheckinResponse | null>(null);
  const [checkinStamp, setCheckinStamp] = useState('');
  const [checkinAccounts, setCheckinAccounts] = useState<CheckinAccountsResponse | null>(null);
  const [checkinAccountsStamp, setCheckinAccountsStamp] = useState('');

  const [diagnose, setDiagnose] = useState<DiagnoseResponse | null>(null);
  const [diagStamp, setDiagStamp] = useState('');
  const [clients, setClients] = useState<ClientsResponse | null>(null);
  const [clientsStamp, setClientsStamp] = useState('');
  const [connect, setConnect] = useState<ConnectResponse | null>(null);
  const [connectError, setConnectError] = useState<{ status: number; message: string; netError?: string } | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  // Refs for stable polling without recreating timers
  const overviewRef = useRef(overview);
  overviewRef.current = overview;
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const reqPauseRef = useRef(reqPause);
  reqPauseRef.current = reqPause;
  const reqLimitRef = useRef(reqLimit);
  reqLimitRef.current = reqLimit;
  const usageDaysRef = useRef(usageDays);
  usageDaysRef.current = usageDays;
  const trendGranRef = useRef(trendGran);
  trendGranRef.current = trendGran;
  const seenAutoCheckinAtRef = useRef<number | string | null | undefined>(undefined);
  const lastIdentityKeyRef = useRef<string | null>(null);
  const identityPollingRef = useRef(false);

  const announce = useCallback((text: string) => {
    setLiveAnnouncement('');
    requestAnimationFrame(() => setLiveAnnouncement(text));
  }, []);

  const setMsg = useCallback((text: string, tone: '' | 'good' | 'err' = '', title?: string) => {
    setActionMsg({ text, tone, title });
    if (text) announce(text);
  }, [announce]);

  // Apply theme & follow OS preference live until user toggles explicitly
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      const saved = lsGet('wb.theme');
      if (saved === 'light' || saved === 'dark') return;
      const next: Theme = e.matches ? 'dark' : 'light';
      withViewTransition(() => {
        document.documentElement.setAttribute('data-theme', next);
        setThemeState(next);
      });
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    lsSet('wb.theme', next);
    withViewTransition(() => {
      document.documentElement.setAttribute('data-theme', next);
      setThemeState(next);
    });
  }, [theme]);

  useEffect(() => {
    if (accent === 'blue') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.setAttribute('data-accent', accent);
  }, [accent]);

  const setAccent = useCallback((next: AccentId) => {
    lsSet('wb.accent', next);
    withViewTransition(() => {
      if (next === 'blue') document.documentElement.removeAttribute('data-accent');
      else document.documentElement.setAttribute('data-accent', next);
      setAccentState(next);
    });
  }, []);

  const setActiveTab = useCallback((tab: NavTab) => {
    setActiveTabState(tab);
    if (window.scrollY > 8) window.scrollTo({ top: 0 });
  }, []);

  const setProbeMeta = useCallback((updatedAt: number | null, lastRun?: { scope?: string; count?: number; at?: number } | null) => {
    setProbeUpdatedAt(updatedAt);
    if (lastRun !== undefined) setProbeLastRun(lastRun);
  }, []);

  const resetProbeState = useCallback(() => {
    setProbeResultsState({});
    setProbeUpdatedAt(null);
    setProbeLastRun(null);
  }, []);

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadCheckin = useCallback(
    singleFlight(async () => {
      const d = await api<CheckinResponse>('/api/checkin');
      setCheckin(d);
      setCheckinStamp(fmtClock());
    }),
    [],
  );

  const loadOverview = useCallback(
    singleFlight(async () => {
      const d = await api<OverviewResponse>('/api/overview');
      if (!d._httpOk && !d.bridge) {
        setOverview({ error: d.error || 'Overview unavailable' } as OverviewResponse);
        return false;
      }
      setOverview(d);
      setOverviewStamp(fmtClock());
      const acAt = d.bridge?.autoCheckin?.at;
      if (acAt != null) {
        if (seenAutoCheckinAtRef.current !== undefined && seenAutoCheckinAtRef.current !== acAt) {
          void loadCheckin();
        }
        seenAutoCheckinAtRef.current = acAt;
      }
      return true;
    }),
    [loadCheckin],
  );

  const loadModels = useCallback(async (opts?: { refresh?: boolean }) => {
    const refresh = opts?.refresh === true;
    const url = refresh ? '/api/models?refresh=1' : '/api/models';
    const d = await api<ModelsResponse>(url, { timeoutMs: 30_000 });
    if (d && Array.isArray(d.models)) {
      if (refresh && d.error && modelsRef.current?.models?.length) {
        setModels((prev) => (prev ? { ...prev, staleMs: d.staleMs, error: d.error } : d));
      } else {
        setModels(d);
      }
      setModelsStamp(fmtClock());
      // Drop probe verdicts for models no longer in catalog
      const idSet = new Set(d.models.map((m) => m.id));
      if (idSet.size > 0) {
        setProbeResultsState((prev) => {
          let changed = false;
          const next: Record<string, ProbeRecord> = {};
          for (const [k, v] of Object.entries(prev)) {
            if (idSet.has(k)) next[k] = v;
            else changed = true;
          }
          return changed ? next : prev;
        });
      }
      return d;
    }
    return null;
  }, []);

  const loadProbeResults = useCallback(async () => {
    const d = await api<ProbeResultsResponse>('/api/probe-results');
    if (d && d.results && typeof d.results === 'object') {
      setProbeResultsState(d.results);
      setProbeUpdatedAt(typeof d.updatedAt === 'number' ? d.updatedAt : null);
      setProbeLastRun(d.lastRun || null);
    }
  }, []);

  const loadAutoSwitch = useCallback(async () => {
    const d = await api<AutoSwitchResponse>('/api/auto-switch');
    if (d && typeof d.after === 'number') setAutoSwitch(d);
  }, []);

  const loadAccounts = useCallback(
    singleFlight(async () => {
      void loadAutoSwitch();
      const d = await api<AccountsResponse>('/api/accounts');
      if (d) {
        setAccounts(d);
        setAccountsStamp(fmtClock());
      }
    }),
    [loadAutoSwitch],
  );

  const loadPluginLogin = useCallback(async () => {
    const d = await api<PluginLoginResponse>('/api/login');
    if (d) setPluginLogin(d);
  }, []);

  const loadLimits = useCallback(async (opts?: { refresh?: boolean }) => {
    const url = opts?.refresh ? '/api/limits?refresh=1' : '/api/limits';
    const d = await api<LimitsResponse>(url);
    if (d && d.ok && Array.isArray(d.limiting)) {
      setLimits(d);
      setLimitsError('');
      setLimitsStamp(fmtClock());
    } else {
      setLimits(null);
      setLimitsError(d?.error || '读取失败：桥未运行');
    }
  }, []);

  const loadUsage = useCallback(async (opts?: { days?: number; gran?: 'day' | 'week' | 'hour'; force?: boolean }) => {
    const days = opts?.days ?? usageDaysRef.current;
    const gran = opts?.gran ?? trendGranRef.current;
    const force = opts?.force === true;

    if (!force && gran === 'day' && usageCacheRef.current.day.has(days)) {
      const cached = usageCacheRef.current.day.get(days)!;
      setUsageDay(cached);
      setUsageView(cached);
    } else if (!force && gran === 'week' && usageCacheRef.current.week) {
      setUsageView(usageCacheRef.current.week);
    }

    setUsageLoading(true);
    try {
      const query = gran === 'hour'
        ? '/api/usage?days=1&hours=1'
        : gran === 'week'
          ? '/api/usage?days=84'
          : `/api/usage?days=${days}`;
      const d = await api<UsageResponse>(query);
      // Race guard: drop stale response if user switched gran/days mid-flight
      if (gran !== trendGranRef.current || (gran === 'day' && days !== usageDaysRef.current)) return;

      const u = d?.usage || null;
      if (u) {
        if (gran === 'day') {
          usageCacheRef.current.day.set(days, u);
          setUsageDay(u);
        } else if (gran === 'week') {
          usageCacheRef.current.week = u;
        }
        setUsageView(u);
      } else {
        setUsageView(null);
        if (gran === 'day') setUsageDay(null);
      }
      setUsageStamp(fmtClock());
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const loadRequests = useCallback(async (limitOverride?: number) => {
    const limit = limitOverride ?? reqLimitRef.current;
    const d = await api<RequestsResponse>(`/api/requests?limit=${limit}`);
    if (d && Array.isArray(d.requests)) {
      setRequests(d);
      setReqStamp(fmtClock());
    }
  }, []);

  const loadCheckinAccounts = useCallback(async () => {
    const d = await api<CheckinAccountsResponse>('/api/checkin/accounts', { timeoutMs: 65_000 });
    if (d) {
      setCheckinAccounts(d);
      setCheckinAccountsStamp(fmtClock());
    }
  }, []);

  const loadDiag = useCallback(
    singleFlight(async () => {
      const d = await api<DiagnoseResponse>('/api/diagnose');
      if (d) {
        setDiagnose(d);
        setDiagStamp(fmtClock());
      }
    }),
    [],
  );

  const loadConnect = useCallback(async (queryString = '') => {
    const path = queryString ? `/api/connect?${queryString}` : '/api/connect';
    const r = await connectRead<ConnectResponse>(path);
    if (r.ok && r.body && Array.isArray(r.body.clients)) {
      setConnect(r.body);
      setConnectError(null);
      return r.body;
    }
    const msg = r.status === 404
      ? '控制台服务版本过旧（缺少 /api/connect 接口），请重启控制台进程。'
      : r.netError === 'timeout'
        ? '读取接入状态超时（15 秒），请重试。'
        : r.body?.error || r.netError || `HTTP ${r.status || 'network error'}`;
    setConnectError({ status: r.status, message: msg, netError: r.netError });
    return null;
  }, []);

  const loadClients = useCallback(async () => {
    const d = await api<ClientsResponse>('/api/clients');
    if (d && d.baseUrlOpenAI) {
      setClients(d);
      setClientsStamp(fmtClock());
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshingAll(true);
    setMsg(t('正在刷新全部面板…', 'Refreshing all panels…'));
    try {
      await Promise.all([
        loadOverview(),
        loadModels(),
        loadDiag(),
        loadAccounts(),
        loadPluginLogin(),
        loadCheckin(),
        loadCheckinAccounts(),
        loadLimits({ refresh: true }),
        loadUsage({ force: true }),
        loadRequests(),
        loadClients(),
        loadConnect(),
      ]);
      setMsg(t(`已刷新全部面板（${fmtClock()}）`, `All panels refreshed (${fmtClock()})`), 'good');
    } finally {
      setRefreshingAll(false);
    }
  }, [
    loadAccounts,
    loadCheckin,
    loadCheckinAccounts,
    loadClients,
    loadConnect,
    loadDiag,
    loadLimits,
    loadModels,
    loadOverview,
    loadPluginLogin,
    loadRequests,
    loadUsage,
    setMsg,
    t,
  ]);

  // Failure watermark helpers
  const countNewFailures = useCallback(() => {
    const list = requests?.requests || [];
    return list.filter((r) => !r.ok && r.probe !== true && Number(r.t) > failSeenTs).length;
  }, [failSeenTs, requests]);

  const advanceFailWatermark = useCallback(() => {
    const list = requestsRef.current?.requests || [];
    const maxTs = list.reduce((mx, r) => (!r.ok && r.probe !== true ? Math.max(mx, Number(r.t) || 0) : mx), failSeenTs);
    const next = Math.max(maxTs, Date.now());
    setFailSeenTs(next);
    lsSet('wb.failSeenTs', String(next));
  }, [failSeenTs]);

  // Document title synchronization (never includes PID or uptime)
  useEffect(() => {
    const b = overview?.bridge;
    let head = '';
    if (!b || overview?.error) head = t('⚠ 控制台异常', '⚠ Console error');
    else if (!b.running) head = t('⚠ 桥未运行', '⚠ Bridge not running');
    else if (!b.ok) head = t('⚠ 桥有响应但异常', '⚠ Responds but unhealthy');
    else {
      const count = Array.isArray(models?.models) ? models.models.length : (Number(b.catalogSize) || 0);
      head = en ? `Bridge running · ${count} models` : `桥运行中 · ${count} 模型`;
    }
    const newFails = countNewFailures();
    const failPart = newFails > 0 ? (en ? ` · ${newFails} new fail` : ` · 新失败 ${newFails}`) : '';
    const suffix = en ? 'WorkBuddy Local API Bridge' : 'WorkBuddy 本地 API 桥';
    document.title = `${head}${failPart} · ${suffix}`;
  }, [countNewFailures, en, models, overview, t]);

  // Initial boot sequence
  useEffect(() => {
    let alive = true;
    (async () => {
      await loadProbeResults();
      await loadOverview();
      if (!alive) return;
      void Promise.all([
        loadModels(),
        loadDiag(),
        loadAccounts(),
        loadPluginLogin(),
        loadCheckin(),
        loadCheckinAccounts(),
        loadLimits(),
        loadUsage(),
        loadRequests(),
        loadClients(),
        loadConnect(),
      ]);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload usage when user changes usageDays or trendGran
  const firstUsageRenderRef = useRef(true);
  useEffect(() => {
    if (firstUsageRenderRef.current) {
      firstUsageRenderRef.current = false;
      return;
    }
    void loadUsage({ days: usageDays, gran: trendGran, force: trendGran === 'hour' });
  }, [loadUsage, trendGran, usageDays]);

  // Reload requests when reqLimit changes
  const firstReqRenderRef = useRef(true);
  useEffect(() => {
    if (firstReqRenderRef.current) {
      firstReqRenderRef.current = false;
      return;
    }
    void loadRequests(reqLimit);
  }, [loadRequests, reqLimit]);

  // Visibility-aware polling scheduler
  useEffect(() => {
    const pollIdentity = async () => {
      if (identityPollingRef.current) return;
      identityPollingRef.current = true;
      try {
        const d = await api<IdentityResponse>('/api/identity', { timeoutMs: 4000 });
        if (!d || !d.ok) return;
        const key = [
          d.pid ?? '',
          d.build ?? '',
          d.auth?.source ?? '',
          d.auth?.userId ?? '',
          d.auth?.enterpriseId ?? '',
          d.auth?.tenantId ?? '',
          d.desktopUserId ?? '',
        ].join('|');
        if (lastIdentityKeyRef.current === null) {
          lastIdentityKeyRef.current = key;
          const prevUid = overviewRef.current?.bridge?.auth?.userId;
          if (!prevUid || prevUid === d.auth?.userId) return;
        } else if (lastIdentityKeyRef.current === key) {
          return;
        }
        lastIdentityKeyRef.current = key;
        setMsg(t('检测到账号或桥已切换，正在刷新…', 'Account or bridge change detected; refreshing…'));
        await Promise.all([loadOverview(), loadModels(), loadAccounts(), loadPluginLogin(), loadCheckin()]);
        setMsg(t(`已按新账号刷新（${fmtClock()}）`, `Refreshed for updated account (${fmtClock()})`), 'good');
      } finally {
        identityPollingRef.current = false;
      }
    };

    const pollers: Array<{ every: number; run: () => void }> = [
      { every: 2_000, run: () => void pollIdentity() },
      { every: 15_000, run: () => void loadLimits() },
      { every: 20_000, run: () => {
        void loadOverview();
        void loadModels();
        void loadUsage({ force: true });
        if (!reqPauseRef.current) void loadRequests();
      } },
      { every: 60_000, run: () => void loadAccounts() },
      { every: 300_000, run: () => void loadCheckinAccounts() },
    ];

    const factory = (window as unknown as {
      createPollScheduler?: (cfg: {
        pollers: Array<{ every: number; run: () => void }>;
        isHidden: () => boolean;
        setTimer: (fn: () => void, ms: number) => number;
        clearTimer: (id: number) => void;
        subscribe: (sync: () => void) => () => void;
      }) => { dispose: () => void };
    }).createPollScheduler;

    if (typeof factory === 'function') {
      const sched = factory({
        pollers,
        isHidden: () => document.hidden,
        setTimer: (fn, ms) => window.setInterval(fn, ms),
        clearTimer: (id) => clearInterval(id),
        subscribe: (sync) => {
          document.addEventListener('visibilitychange', sync);
          window.addEventListener('focus', sync);
          window.addEventListener('pageshow', sync);
          return () => {
            document.removeEventListener('visibilitychange', sync);
            window.removeEventListener('focus', sync);
            window.removeEventListener('pageshow', sync);
          };
        },
      });
      return () => sched.dispose();
    }

    return undefined;
  }, [loadAccounts, loadCheckin, loadCheckinAccounts, loadLimits, loadModels, loadOverview, loadPluginLogin, loadRequests, loadUsage, setMsg, t]);

  // Exact token-free Markdown Diagnostic Report builder
  const buildDiagReport = useCallback(() => {
    const b = overview?.bridge;
    const c = overview?.console;
    const cred = overview?.credentials;
    const active = cred?.active;
    const dsh = overview?.dsh;
    const modelList = models?.models || [];
    const reqList = requests?.requests || [];
    const diagItems = diagnose?.items || [];

    const bridgeState = !b || !b.running
      ? t('未运行', 'Not running')
      : b.ok
        ? t('正常', 'Healthy')
        : t('有响应但异常', 'Responds but unhealthy');
    const errSuffix = b?.error ? `（${String(b.error).replace(/\s+/g, ' ').trim()}）` : '';

    const lines: string[] = [
      t('# WorkBuddy 本地 API 桥 · 控制台诊断报告', '# WorkBuddy Local API Bridge · Diagnostics Report'),
      '',
      `- ${t('时间', 'Time')}：${fmtDateTime(Date.now())}`,
      `- ${t('控制台', 'Console')} v${c?.version || '?'} · Node ${c?.node || '?'}`,
      `- ${t('桥', 'Bridge')}：${b?.endpoint || '—'}（PID ${b?.pid ?? '—'} / ${t('运行', 'Uptime')} ${fmtUptime(b?.uptimeMs, en)} / ${t('目录', 'Catalog')} ${b?.catalogSize ?? '—'}）`,
      `- ${t('桥状态', 'Bridge status')}：${bridgeState}${errSuffix}`,
      '',
      t('## 账号与凭据', '## Account & Credentials'),
    ];

    if (active) {
      const uidPart = active.userId ? `（uid ${active.userId.slice(0, 8)}…）` : '';
      lines.push(`- ${t('账号', 'Account')}：${active.account || active.alias || '—'}${uidPart}`);
      lines.push(`- ${t('域名', 'Domain')}：${active.domain || '—'}`);
      lines.push(`- ${t('令牌剩余', 'Token TTL')}：${fmtDuration(active.remainingMs, en)}`);
    } else {
      lines.push(`- ${t('未取到有效凭据', 'No valid credential found')}${cred?.error ? `：${tu(cred.error)}` : ''}`);
    }
    const atrest = diagItems.find((i) => i.id === 'atrest');
    if (atrest) lines.push(`- AtRest：${tu(atrest.detail)}`);

    lines.push('', t('## 诊断逐项', '## Diagnostic Checks'));
    if (diagItems.length) {
      const markMap: Record<string, string> = { ok: '✓', warn: '!', fail: '✗' };
      for (const item of diagItems) {
        const hintPart = item.hint ? `（${t('建议', 'Hint')}：${tu(item.hint)}）` : '';
        lines.push(`- [${markMap[item.status] || '?'}] ${tu(item.label)}：${tu(item.detail)}${hintPart}`);
      }
    } else {
      lines.push(`- ${t('（未取到诊断结果）', '(No diagnostic results)')}`);
    }

    const reg = dsh?.registeredModels || [];
    const catIds = new Set(modelList.map((m) => m.id));
    const stale = reg.filter((id) => !catIds.has(id));
    const dropped = b?.upstreamShape?.droppedNonChat || [];
    lines.push(
      '',
      t('## 目录摘要', '## Catalog Summary'),
      `- ${t('目录模型数', 'Catalog models')}：${modelList.length || '—'}`,
      `- ${t('被排除的非对话模型', 'Excluded non-chat models')}：${dropped.length ? dropped.join('、') : t('无', 'None')}`,
      `- ${t('已注册', 'Registered')}：${reg.length}${stale.length ? `（${t('已不在目录', 'no longer in catalog')}：${stale.join('、')}）` : ''}`,
    );

    const recentFails = reqList.filter((r) => !r.ok && r.probe !== true).slice(0, 5);
    lines.push('', t('## 最近 5 条失败', '## Last 5 Failures'));
    if (recentFails.length) {
      for (const r of recentFails) {
        const parts = [fmtDateTime(r.t), r.model || '—'];
        if (r.status) parts.push(`HTTP ${r.status}`);
        if (r.code != null && r.code !== '') parts.push(String(r.code));
        if (r.error) parts.push(String(r.error).replace(/\s+/g, ' ').slice(0, 200));
        lines.push(`- ${parts.join(' · ')}`);
      }
    } else {
      lines.push(`- ${t('（最近明细里没有失败）', '(No failures in recent requests)')}`);
    }
    return lines.join('\n');
  }, [diagnose, en, models, overview, requests, t, tu]);

  // Expose targeted hooks on window for automated parity / i18n E2E tests
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.loadLimits = loadLimits;
    w.renderModelSection = () => void loadModels();
    w.switchTab = setActiveTab;
    w.buildDiagReport = buildDiagReport;
    w.lastClients = clients;
    w.translateMultiline = (s: string) => String(s || '');
    w.clientsCheatSheet = (c: ClientsResponse | null | undefined) => {
      if (!c) return '';
      return [
        t('# WorkBuddy 本地 API 桥 · 客户端接入信息', '# WorkBuddy Local API Bridge · Client Setup'),
        `Base URL (OpenAI): ${c.baseUrlOpenAI}`,
        `Base URL (Anthropic): ${c.baseUrlAnthropic}`,
        `API Key: ${c.token || 'local-bridge'}`,
        `${t('推荐模型', 'Default model')}: ${c.anthropicModel || c.models?.[0] || '—'}`,
      ].join('\n');
    };
  }, [buildDiagReport, clients, loadLimits, loadModels, setActiveTab, t]);

  return (
    <ConsoleContext.Provider
      value={{
        activeTab,
        setActiveTab,
        theme,
        toggleTheme,
        accent,
        setAccent,
        actionMsg,
        setMsg,
        liveAnnouncement,
        announce,
        overview,
        overviewStamp,
        models,
        modelsStamp,
        probeResults,
        probeUpdatedAt,
        probeLastRun,
        probeRunning,
        setProbeRunning,
        setProbeResultsState,
        setProbeMeta,
        accounts,
        accountsStamp,
        autoSwitch,
        pluginLogin,
        limits,
        limitsError,
        limitsStamp,
        usageDays,
        setUsageDays,
        trendGran,
        setTrendGran,
        usageDay,
        usageView,
        usageStamp,
        usageLoading,
        requests,
        reqLimit,
        setReqLimit,
        reqPause,
        setReqPause,
        reqModelFilter,
        setReqModelFilter,
        reqFailOnly,
        setReqFailOnly,
        reqStamp,
        failSeenTs,
        advanceFailWatermark,
        countNewFailures,
        checkin,
        checkinStamp,
        checkinAccounts,
        checkinAccountsStamp,
        diagnose,
        diagStamp,
        clients,
        clientsStamp,
        connect,
        connectError,
        refreshingAll,
        refreshAll,
        loadOverview,
        loadModels,
        loadProbeResults,
        resetProbeState,
        loadAccounts,
        loadAutoSwitch,
        loadPluginLogin,
        loadLimits,
        loadUsage,
        loadRequests,
        loadCheckin,
        loadCheckinAccounts,
        loadDiag,
        loadClients,
        loadConnect,
        buildDiagReport,
      }}
    >
      {children}
    </ConsoleContext.Provider>
  );
};

export function useConsole(): ConsoleContextValue {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error('useConsole must be used inside ConsoleProvider');
  return ctx;
}
