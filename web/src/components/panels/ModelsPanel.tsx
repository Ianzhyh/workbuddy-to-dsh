import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  Check,
  CheckSquare,
  Copy,
  Cpu,
  Download,
  Eye,
  Gauge,
  Info,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import {
  api,
  copyToClipboard,
  downloadCsv,
  fmtAgo,
  fmtCompact,
  fmtNum,
  fmtShortClock,
  localDateStr,
  lsGet,
  lsSet,
} from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { useNativeInputSync } from '../../lib/useDomSync';
import type { ModelItem, ProbeRecord, TpsResponse } from '../../types/api';
import { EmptyState, Panel, SkeletonBlock } from '../ui/Panel';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';

interface SharedProbeBridge {
  CHOICES: number[];
  ANCHORS: Array<[number, number]>;
  getValue: () => number;
  setValue: (v: number) => void;
}

const SHARED_PROBE: SharedProbeBridge = (window as unknown as { __WB_PROBE?: SharedProbeBridge }).__WB_PROBE || {
  CHOICES: [5000, 10000, 20000, 30000, 50000],
  ANCHORS: [
    [5000, 0.26],
    [10000, 0.45],
    [12000, 1.86],
    [20000, 3.3],
    [30000, 4.91],
    [50000, 8.16],
  ],
  getValue: () => {
    const saved = Number(lsGet('wb.probeInputTokens', '10000'));
    return [5000, 10000, 20000, 30000, 50000].includes(saved) ? saved : 10000;
  },
  setValue: (v: number) => lsSet('wb.probeInputTokens', String(v)),
};

const PROBE_SIZES = SHARED_PROBE.CHOICES;
const PROBE_COST_ANCHORS = SHARED_PROBE.ANCHORS;

function estimateProbeCostPerModel(tokens: number): number {
  for (let i = 0; i < PROBE_COST_ANCHORS.length; i += 1) {
    if (tokens <= PROBE_COST_ANCHORS[i][0]) {
      if (i === 0) return PROBE_COST_ANCHORS[0][1];
      const [x0, y0] = PROBE_COST_ANCHORS[i - 1];
      const [x1, y1] = PROBE_COST_ANCHORS[i];
      return y0 + ((tokens - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return PROBE_COST_ANCHORS[PROBE_COST_ANCHORS.length - 1][1];
}

function getBusyLevel(m: ModelItem): string {
  if (typeof m.busy_level === 'string' && m.busy_level) return m.busy_level;
  if (typeof m.busyLevel === 'string' && m.busyLevel) return m.busyLevel;
  if (typeof m.busy === 'string') return m.busy;
  if (m.busy && typeof m.busy === 'object') return String(m.busy.level || m.busy.status || '');
  return '';
}

interface TpsCellState {
  loading: boolean;
  seq: number;
  data?: TpsResponse;
  error?: string;
}

export const ModelsPanel: React.FC = () => {
  const {
    overview,
    models,
    modelsStamp,
    usageDay,
    probeResults,
    probeUpdatedAt,
    probeLastRun,
    probeRunning,
    setProbeRunning,
    setProbeResultsState,
    setProbeMeta,
    resetProbeState,
    loadModels,
    setMsg,
  } = useConsole();
  const { en, t, tu } = useI18n();

  const catalog = models?.models || [];
  const registeredSet = useMemo(() => new Set(overview?.dsh?.registeredModels || []), [overview?.dsh?.registeredModels]);

  // Persistent table filters (preserved across 20s catalog refreshes!)
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [hideUnlisted, setHideUnlisted] = useState(false);
  const [sortByCredits, setSortByCredits] = useState(false);
  const [probeSort, setProbeSort] = useState<'' | 'ok' | 'ms' | 'msdesc'>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedInitRef = useRef(false);

  const searchRef = useNativeInputSync<HTMLInputElement>((el) => setSearch(el.value));

  // Client default models selector
  const [defaultMode, setDefaultMode] = useState<'curated' | 'all' | 'ids'>('curated');
  const [defaultTouched, setDefaultTouched] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);

  // Detail inspector & copy state
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Probe controls
  const [probeScope, setProbeScope] = useState<'checked' | 'registered' | 'all'>('all');
  const [probeScopeTouched, setProbeScopeTouched] = useState(false);
  const [probeSize, setProbeSize] = useState<number>(() => SHARED_PROBE.getValue());
  const [probeProgress, setProbeProgress] = useState<{ done: number; total: number; ok: number; active: string[]; startedAt: number } | null>(null);
  const [probingIds, setProbingIds] = useState<Set<string>>(new Set());
  const probeCtrlRef = useRef<AbortController | null>(null);

  // Speed test (memory-only, NEVER persisted to localStorage, per-model seq guard!)
  const [tpsMap, setTpsMap] = useState<Record<string, TpsCellState>>({});

  // Action busy states
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [regMsg, setRegMsg] = useState<{ text: string; tone: '' | 'good' | 'err' }>({ text: '', tone: '' });

  // Sync initial selection from registered models once overview + catalog arrive
  useEffect(() => {
    if (!selectedInitRef.current && catalog.length > 0 && overview) {
      selectedInitRef.current = true;
      const valid = new Set(catalog.map((m) => m.id));
      setSelectedIds(new Set((overview.dsh?.registeredModels || []).filter((id) => valid.has(id))));
    }
  }, [catalog, overview]);

  // Auto-default probeScope until user manually changes it
  useEffect(() => {
    if (!probeScopeTouched) {
      setProbeScope(selectedIds.size > 0 ? 'checked' : 'all');
    }
  }, [probeScopeTouched, selectedIds.size]);

  // Sync client default models mode from backend until user edits
  useEffect(() => {
    const md = models?.modelsDefault;
    if (!md || defaultTouched) return;
    if (md.mode === 'all' || md.mode === 'ids' || md.mode === 'curated') {
      setDefaultMode(md.mode);
    }
  }, [defaultTouched, models?.modelsDefault]);

  // Close open detail on Escape
  useEffect(() => {
    if (!openDetailId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenDetailId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openDetailId]);

  // Measured cost lookup from usageDay.models
  const costMap = useMemo(() => {
    const m = new Map<string, { per1k: number | null; samples: number; reason: string }>();
    const usageRows = usageDay?.models || [];
    for (const row of usageRows) {
      const totalTok = (row.promptTokens || 0) + (row.completionTokens || 0);
      if (row.calls <= 0) continue;
      if (row.creditCalls <= 0) {
        m.set(row.model, { per1k: null, samples: 0, reason: t('上游未回报该模型的扣分', 'Upstream reported no credit for this model') });
      } else if (totalTok <= 0) {
        m.set(row.model, { per1k: null, samples: row.creditCalls, reason: t('没有可计入的 token', 'No countable tokens') });
      } else {
        m.set(row.model, { per1k: (row.credit / totalTok) * 1000, samples: row.creditCalls, reason: '' });
      }
    }
    return m;
  }, [t, usageDay?.models]);

  const unlistedCount = useMemo(() => catalog.filter((m) => m.official === false).length, [catalog]);

  // Filter + Sort visible models
  const { visibleModels, hiddenUnlistedCount } = useMemo(() => {
    const q = search.trim().toLowerCase();
    let hiddenU = 0;
    let list = catalog.filter((m) => {
      if (hideUnlisted && m.official === false) {
        hiddenU += 1;
        return false;
      }
      if (q && !m.id.toLowerCase().includes(q) && !(m.name || '').toLowerCase().includes(q)) {
        return false;
      }
      if (kind === 'free' && !(m.free || Number(m.credits) === 0)) return false;
      if (kind === 'registered' && !selectedIds.has(m.id)) return false;
      if (kind === 'unregistered' && selectedIds.has(m.id)) return false;
      if (kind === 'probe-ok' && probeResults[m.id]?.ok !== true) return false;
      if (kind === 'probe-fail' && probeResults[m.id]?.ok !== false) return false;
      if (kind === 'probe-none' && probeResults[m.id] !== undefined) return false;
      if (kind === 'unlisted' && m.official !== false) return false;
      return true;
    });

    if (sortByCredits) {
      list = [...list].sort((a, b) => {
        const ca = a.free ? 0 : typeof a.credits === 'number' ? a.credits : Number.POSITIVE_INFINITY;
        const cb = b.free ? 0 : typeof b.credits === 'number' ? b.credits : Number.POSITIVE_INFINITY;
        return ca - cb || a.id.localeCompare(b.id);
      });
    } else if (probeSort) {
      list = [...list].sort((a, b) => {
        const pa = probeResults[a.id];
        const pb = probeResults[b.id];
        if (probeSort === 'ok') {
          const ra = pa ? (pa.ok ? 0 : 1) : 2;
          const rb = pb ? (pb.ok ? 0 : 1) : 2;
          if (ra !== rb) return ra - rb;
          return (pa?.ms ?? Number.POSITIVE_INFINITY) - (pb?.ms ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id);
        }
        const ma = pa?.ms ?? Number.POSITIVE_INFINITY;
        const mb = pb?.ms ?? Number.POSITIVE_INFINITY;
        return probeSort === 'ms' ? ma - mb : mb - ma;
      });
    }

    return { visibleModels: list, hiddenUnlistedCount: hiddenU };
  }, [catalog, hideUnlisted, kind, probeResults, probeSort, search, selectedIds, sortByCredits]);

  const badCheckedIds = useMemo(
    () => [...selectedIds].filter((id) => probeResults[id]?.ok === false),
    [probeResults, selectedIds],
  );
  const usableIds = useMemo(
    () => catalog.filter((m) => probeResults[m.id]?.ok === true).map((m) => m.id),
    [catalog, probeResults],
  );
  const registeredInCatalogIds = useMemo(
    () => catalog.filter((m) => registeredSet.has(m.id)).map((m) => m.id),
    [catalog, registeredSet],
  );

  const probeTargetIds = useMemo(() => {
    if (probeScope === 'checked') return catalog.filter((m) => selectedIds.has(m.id)).map((m) => m.id);
    if (probeScope === 'registered') return registeredInCatalogIds;
    return catalog.map((m) => m.id);
  }, [catalog, probeScope, registeredInCatalogIds, selectedIds]);

  const perModelCost = estimateProbeCostPerModel(probeSize);
  const estTotalCost = perModelCost * probeTargetIds.length;

  // Bulk selection actions
  const handleSelectVisible = () => {
    const next = new Set(selectedIds);
    let skipped = 0;
    for (const m of visibleModels) {
      if (probeResults[m.id]?.ok === false) {
        skipped += 1;
        continue;
      }
      next.add(m.id);
    }
    setSelectedIds(next);
    setRegMsg({
      text: skipped > 0
        ? t(`已选可见模型（跳过 ${skipped} 个已知不可用）`, `Selected visible (skipped ${skipped} known unavailable)`)
        : t(`已勾选 ${next.size} 个模型`, `${next.size} selected`),
      tone: 'good',
    });
  };

  const handleAddFree = () => {
    const next = new Set(selectedIds);
    let added = 0;
    let skipped = 0;
    for (const m of catalog) {
      if (!(m.free || Number(m.credits) === 0)) continue;
      if (probeResults[m.id]?.ok === false) {
        skipped += 1;
        continue;
      }
      if (!next.has(m.id)) {
        next.add(m.id);
        added += 1;
      }
    }
    setSelectedIds(next);
    setRegMsg({
      text: t(
        `已追加 ${added} 个免费模型${skipped ? `（跳过 ${skipped} 个不可用）` : ''}`,
        `Added ${added} free models${skipped ? ` (skipped ${skipped} unavailable)` : ''}`,
      ),
      tone: 'good',
    });
  };

  const handleUncheckBad = () => {
    const next = new Set(selectedIds);
    for (const id of badCheckedIds) next.delete(id);
    setSelectedIds(next);
    setRegMsg({
      text: t(`已取消勾选 ${badCheckedIds.length} 个不可用模型`, `Unchecked ${badCheckedIds.length} unavailable models`),
      tone: '',
    });
  };

  const handleSaveDefaultMode = async () => {
    if (defaultMode === 'ids' && selectedIds.size === 0) {
      setRegMsg({ text: t('请先在表格中勾选至少 1 个模型。', 'Select at least 1 model in the table first.'), tone: 'err' });
      return;
    }
    setSavingDefault(true);
    try {
      const body = defaultMode === 'ids' ? { ids: [...selectedIds] } : { value: defaultMode };
      const r = await api<{ ok?: boolean; error?: string }>('/api/models/default', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok || r._httpOk) {
        setDefaultTouched(false);
        setMsg(t('客户端默认拉取范围已保存并立即生效。', 'Default client model list saved and active immediately.'), 'good');
        await loadModels();
      } else {
        setMsg(t('保存失败：', 'Save failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setSavingDefault(false);
    }
  };

  const handleRefreshCatalog = async () => {
    setRefreshingCatalog(true);
    try {
      const d = await loadModels({ refresh: true });
      if (d?.error) {
        const clk = d.staleMs != null ? fmtShortClock(Date.now() - d.staleMs) : overview?.bridge?.catalogAt ? fmtShortClock(overview.bridge.catalogAt) : '';
        setMsg(
          t(`目录刷新失败：${d.error}${clk ? `（仍显示 ${clk} 的缓存）` : ''}`, `Catalog refresh failed: ${d.error}${clk ? ` (showing ${clk} cache)` : ''}`),
          'err',
        );
      } else {
        setMsg(t('上游模型目录已刷新。', 'Upstream model catalog refreshed.'), 'good');
      }
    } finally {
      setRefreshingCatalog(false);
    }
  };

  // Concurrent Availability Probe (concurrency 3, preserves inputTokens & promptTokens on save!)
  const handleRunProbe = async () => {
    if (!probeTargetIds.length || probeRunning) return;
    const ctrl = new AbortController();
    probeCtrlRef.current = ctrl;
    setProbeRunning(true);
    const startedAt = Date.now();
    const queue = [...probeTargetIds];
    const dirty: Record<string, ProbeRecord> = {};
    let done = 0;
    let okCount = 0;
    const active = new Set<string>();

    setProbeProgress({ done: 0, total: queue.length, ok: 0, active: [], startedAt });

    const worker = async () => {
      while (queue.length > 0 && !ctrl.signal.aborted) {
        const id = queue.shift()!;
        active.add(id);
        setProbingIds(new Set(active));
        setProbeProgress({ done, total: probeTargetIds.length, ok: okCount, active: [...active], startedAt });
        try {
          const res = await fetch('/api/probe', {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'content-type': 'application/json', 'x-workbuddy-panel': '1' },
            body: JSON.stringify({ model: id, inputTokens: probeSize }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            ms?: number;
            credit?: number;
            error?: string;
            inputTokens?: number;
            promptTokens?: number;
          };
          const rec: ProbeRecord = {
            ok: body.ok === true,
            ms: Number(body.ms) || 0,
            at: Date.now(),
            credit: body.credit ?? null,
            error: body.ok ? null : String(body.error || `HTTP ${res.status}`).slice(0, 200),
            inputTokens: body.inputTokens ?? probeSize,
            promptTokens: body.promptTokens ?? null,
          };
          if (rec.ok) okCount += 1;
          dirty[id] = rec;
          setProbeResultsState((prev) => ({ ...prev, [id]: rec }));
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') break;
          const rec: ProbeRecord = {
            ok: false,
            ms: 0,
            at: Date.now(),
            error: String((err as Error)?.message || err).slice(0, 200),
            inputTokens: probeSize,
          };
          dirty[id] = rec;
          setProbeResultsState((prev) => ({ ...prev, [id]: rec }));
        } finally {
          active.delete(id);
          done += 1;
          setProbingIds(new Set(active));
          setProbeProgress({ done, total: probeTargetIds.length, ok: okCount, active: [...active], startedAt });
        }
      }
    };

    try {
      await Promise.all([worker(), worker(), worker()]);
      if (Object.keys(dirty).length > 0) {
        const saved = await api<{ updatedAt?: number }>('/api/probe-results', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            results: dirty,
            lastRun: { scope: probeScope, count: Object.keys(dirty).length },
          }),
        });
        setProbeMeta(saved.updatedAt || Date.now(), { scope: probeScope, count: Object.keys(dirty).length });
      }
      setMsg(
        ctrl.signal.aborted
          ? t(`体检已取消（已完成 ${done} / ${probeTargetIds.length}，结果已保留）`, `Probe cancelled (${done}/${probeTargetIds.length} completed and kept)`)
          : t(`体检完成：可用 ${okCount} / ${done}`, `Probe complete: ${okCount}/${done} available`),
        okCount > 0 ? 'good' : '',
      );
    } finally {
      probeCtrlRef.current = null;
      setProbeRunning(false);
      setProbingIds(new Set());
      setProbeProgress(null);
    }
  };

  const handleClearProbe = async () => {
    const r = await api('/api/probe-results', { method: 'DELETE' });
    if (r._httpOk) {
      resetProbeState();
      setMsg(t('已清除体检存档。', 'Probe results cleared.'), 'good');
    }
  };

  // Manual Speed Test (per-model seq guard, NEVER stored in localStorage)
  const runTps = async (id: string) => {
    const nextSeq = (tpsMap[id]?.seq || 0) + 1;
    setTpsMap((prev) => ({ ...prev, [id]: { loading: true, seq: nextSeq } }));
    const d = await api<TpsResponse>(`/api/tps?model=${encodeURIComponent(id)}`, { timeoutMs: 185_000 });
    setTpsMap((prev) => {
      if ((prev[id]?.seq || 0) !== nextSeq) return prev;
      return {
        ...prev,
        [id]: {
          loading: false,
          seq: nextSeq,
          data: d,
          error: !d.ok ? d.error || 'failed' : undefined,
        },
      };
    });
  };

  const renderTpsCell = (id: string) => {
    const st = tpsMap[id];
    if (st?.loading) {
      return <span className="wb-tag wb-tag-info">{t('测速中…', 'Testing…')}</span>;
    }
    if (st?.data) {
      const sample = st.data.sample;
      if (st.data.ok && sample && typeof sample.tokensPerSecond === 'number') {
        const ttfb = typeof sample.timeToFirstTokenMs === 'number' ? `${Math.round(sample.timeToFirstTokenMs)}ms` : '';
        const incomplete = sample.complete === false;
        return (
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="mono font-semibold text-[12px]" style={{ color: 'var(--ok)' }}>
                {Math.round(sample.tokensPerSecond)} tok/s
              </span>
              <button
                type="button"
                onClick={() => void runTps(id)}
                className="tpsbtn text-[11px] underline opacity-70 hover:opacity-100 cursor-pointer"
              >
                {t('重测', 'Retest')}
              </button>
            </div>
            {(ttfb || incomplete) && (
              <span className="text-[11px] mono" style={{ color: incomplete ? 'var(--warn)' : 'var(--muted)' }}>
                {ttfb ? `${t('首字节', 'TTFT')} ${ttfb}` : ''}
                {incomplete ? ` · ${t(`样本 ${sample.samples || 0}/3`, `${sample.samples || 0}/3`)}` : ''}
              </span>
            )}
          </div>
        );
      }
      const reason = sample?.reason;
      const reasonText =
        reason === 'all-failed'
          ? t('三次都失败了', 'All three runs failed')
          : reason === 'no-usage'
            ? t('上游没回报用量', 'Upstream reported no usage')
            : reason === 'few-chunks'
              ? t('输出太短，量不准', 'Output too short to measure')
              : st.data.error || t('测速失败', 'Speed test failed');
      return (
        <div className="flex items-center justify-end gap-1.5" title={reasonText}>
          <span className="wb-tag wb-tag-fail">{t('测速失败', 'Speed test failed')}</span>
          <button
            type="button"
            onClick={() => void runTps(id)}
            className="tpsbtn text-[11px] underline opacity-75 hover:opacity-100 cursor-pointer"
          >
            {t('重测', 'Retest')}
          </button>
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={() => void runTps(id)}
        title={t('输出速度（tokens/second）：点击测这个模型，三次取中位数。会消耗少量积分（约 0.01–0.15），结果缓存 30 分钟', 'Click to measure output speed (median of 3 runs; costs ~0.01–0.15 credits, cached 30m)')}
        className="tpsbtn wb-btn h-[25px] px-2 text-[11.5px] rounded-[6px]"
      >
        <Gauge className="h-3 w-3" />
        {t('测速', 'Speed')}
      </button>
    );
  };

  const renderBusyTag = (m: ModelItem) => {
    const lvl = getBusyLevel(m);
    if (!lvl || lvl === 'unknown') return <span style={{ color: 'var(--faint)' }}>—</span>;
    if (lvl === 'idle') return <span className="wb-tag wb-tag-ok">{t('空闲', 'Idle')}</span>;
    if (lvl === 'normal') return <span className="wb-tag">{t('负载正常', 'Normal')}</span>;
    if (lvl === 'busy') return <span className="wb-tag wb-tag-warn">{t('轻微拥堵', 'Busy')}</span>;
    if (lvl === 'congested') return <span className="wb-tag wb-tag-fail">{t('极度拥堵', 'Congested')}</span>;
    if (lvl === 'unavailable') return <span className="wb-tag wb-tag-fail">{t('不可用', 'Unavailable')}</span>;
    return <span className="wb-tag">{lvl}</span>;
  };

  const handleExportCsv = () => {
    if (!catalog.length) return;
    const rows: unknown[][] = [
      [
        t('模型 id', 'Model id'),
        t('显示名', 'Display name'),
        t('上下文', 'Context'),
        t('最大输出', 'Max output'),
        t('倍率', 'Multiplier'),
        t('免费', 'Free'),
        t('已注册 dsh', 'Registered in dsh'),
        t('体检结论', 'Probe verdict'),
        t('体检耗时(ms)', 'Probe time (ms)'),
        t('支持图片(空=未声明)', 'Vision'),
        t('实测成本(每千 token)', 'Measured cost (/1k)'),
        t('成本样本(次)', 'Cost samples'),
      ],
    ];
    for (const m of catalog) {
      const p = probeResults[m.id];
      const c = costMap.get(m.id);
      rows.push([
        m.id,
        m.name || m.id,
        m.context_window ?? '',
        m.max_output_tokens ?? '',
        m.credits ?? '',
        m.free || Number(m.credits) === 0 ? 'yes' : 'no',
        registeredSet.has(m.id) ? 'yes' : 'no',
        p ? (p.ok ? 'ok' : 'fail') : '',
        p?.ms ?? '',
        m.supports_images === true ? 'yes' : m.supports_images === false ? 'no' : '',
        c?.per1k != null ? Number(c.per1k.toFixed(4)) : '',
        c?.samples ?? 0,
      ]);
    }
    downloadCsv(`workbuddy-models-${localDateStr()}.csv`, rows);
    setMsg(t(`已导出 ${catalog.length} 个模型目录 CSV。`, `Exported ${catalog.length} catalog models to CSV.`), 'good');
  };

  const catalogClock = overview?.bridge?.catalogAt ? fmtShortClock(overview.bridge.catalogAt) : '';
  const probeSummaryText = probeUpdatedAt
    ? `${t('上次体检', 'Last probe')} ${fmtAgo(probeUpdatedAt, en)}${probeLastRun?.count ? ` · ${t(`本轮 ${probeLastRun.count} 个`, `${probeLastRun.count} run`)}` : ''} · ${t('可用', 'OK')} ${usableIds.length}/${Object.keys(probeResults).length}`
    : '';

  return (
    <Panel
      section="models"
      title={t('可用模型', 'Available models')}
      subtitle={t('从上游实时获取的模型目录，支持批量体检、手动测速、筛选与客户端拉取范围配置', 'Live upstream catalog with batch availability probing, on-demand speed tests & client model scope')}
      icon={<Cpu className="h-4 w-4" />}
      stamp={[modelsStamp ? t(`更新于 ${modelsStamp}`, `Updated ${modelsStamp}`) : '', catalogClock ? t(`目录 ${catalogClock}`, `Catalog ${catalogClock}`) : ''].filter(Boolean).join(' · ') || undefined}
      stampId="modelStamp"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {probeSummaryText && (
            <span id="probeStamp" className="text-[11.5px] font-medium mr-1" style={{ color: 'var(--muted)' }}>
              {probeSummaryText}
            </span>
          )}
          <button type="button" onClick={handleExportCsv} disabled={!catalog.length} className="wb-btn wb-btn-sm">
            <Download className="h-3.5 w-3.5" />
            {t('导出 CSV', 'Export CSV')}
          </button>
          <button
            type="button"
            id="refreshCatalogBtn"
            disabled={refreshingCatalog}
            onClick={() => void handleRefreshCatalog()}
            className="wb-btn wb-btn-sm"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshingCatalog ? 'animate-spin' : ''}`} />
            {t('刷新目录', 'Refresh catalog')}
          </button>
        </div>
      }
    >
      {/* Probe Progress Ribbon */}
      {probeProgress && (
        <div
          id="probeProgress"
          className="mb-4 rounded-xl p-3.5 space-y-2"
          style={{ background: 'var(--primary-soft)', border: '1px solid var(--primary-border)' }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]" style={{ color: 'var(--primary-text)' }}>
            <span id="probeText" className="font-semibold">
              {t(`体检进度 ${probeProgress.done} / ${probeProgress.total} · 可用 ${probeProgress.ok}`, `Probing ${probeProgress.done}/${probeProgress.total} · OK ${probeProgress.ok}`)}
              {probeProgress.active.length > 0 && (
                <span className="ml-2 mono font-normal opacity-80">
                  ({probeProgress.active.join(', ')})
                </span>
              )}
              {probeProgress.done > 0 && probeProgress.done < probeProgress.total && (() => {
                const elapsedSec = (Date.now() - probeProgress.startedAt) / 1000;
                const etaSec = Math.max(1, Math.round((elapsedSec / probeProgress.done) * (probeProgress.total - probeProgress.done)));
                return <span className="ml-2 font-normal">· ETA ~{etaSec}s</span>;
              })()}
            </span>
            <button
              type="button"
              id="probeCancelBtn"
              onClick={() => probeCtrlRef.current?.abort()}
              className="wb-btn wb-btn-danger wb-btn-sm"
            >
              <Square className="h-3 w-3" />
              {t('取消测试', 'Cancel test')}
            </button>
          </div>
          <div className="h-2 w-full rounded-full overflow-hidden" style={{ background: 'var(--surface)' }}>
            <div
              id="probeFill"
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${probeProgress.total > 0 ? Math.round((probeProgress.done / probeProgress.total) * 100) : 0}%`,
                background: 'var(--primary)',
              }}
            />
          </div>
        </div>
      )}

      <div id="modelWrap" className="space-y-3.5">
        {!models ? (
          <SkeletonBlock lines={5} />
        ) : catalog.length === 0 ? (
          <EmptyState
            icon={<Cpu className="h-5 w-5" />}
            title={t('桥未运行，暂无模型目录数据。', 'Bridge is not running; no model catalog yet.')}
          />
        ) : (
          <>
            {/* Row 1: Search, Filters & Bulk Selection */}
            <div className="wb-inset p-3 flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[170px] max-w-[240px]">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--faint)' }} />
                <input
                  ref={searchRef}
                  type="text"
                  id="modelFilter"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('搜索模型 id 或名称…', 'Search model id or name…')}
                  className="wb-input wb-input-sm w-full pl-8"
                />
              </div>

              <Select
                id="modelKind"
                title={t('筛选模型类型', 'Filter models')}
                value={kind}
                onChange={setKind}
                options={[
                  { value: '', label: t('全部', 'All') },
                  { value: 'free', label: t('仅免费', 'Free only') },
                  { value: 'registered', label: t('仅已注册', 'Registered only') },
                  { value: 'unregistered', label: t('仅未注册', 'Unregistered only') },
                  { value: 'probe-ok', label: t('仅可用', 'Available only') },
                  { value: 'probe-fail', label: t('仅不可用', 'Unavailable only') },
                  { value: 'probe-none', label: t('未测', 'Untested') },
                  { value: 'unlisted', label: t('仅未列出', 'Not listed only') },
                ]}
                menuMinWidth={154}
              />

              <Switch
                id="modelHideUnlisted"
                checked={hideUnlisted}
                onChange={setHideUnlisted}
                label={t('隐藏未列出', 'Hide not-listed')}
                badge={unlistedCount > 0 ? <span className="wb-tag">{unlistedCount}</span> : undefined}
                title={t('隐藏 WorkBuddy 官方模型选择器未列出的档位/灰度模型', 'Hide gray-release models not listed in official picker')}
              />

              <Switch
                id="sortByCredits"
                checked={sortByCredits}
                onChange={(checked) => {
                  setSortByCredits(checked);
                  if (checked) setProbeSort('');
                }}
                label={t('按倍率排序', 'Sort by cost')}
              />

              <div className="flex-1" />

              {(search || kind || hideUnlisted) && (
                <span id="filterInfo" className="text-[12px] font-medium" style={{ color: 'var(--primary-text)' }}>
                  {t(`显示 ${visibleModels.length} / ${catalog.length}`, `Showing ${visibleModels.length} / ${catalog.length}`)}
                  {hiddenUnlistedCount > 0 ? t(`，已隐藏 ${hiddenUnlistedCount}`, `, hidden ${hiddenUnlistedCount}`) : ''}
                </span>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <button type="button" id="checkAll" onClick={handleSelectVisible} className="wb-btn wb-btn-sm">
                  <CheckSquare className="h-3.5 w-3.5" />
                  {t('全选', 'Select visible')}
                </button>
                <button type="button" id="selectFreeBtn" onClick={handleAddFree} className="wb-btn wb-btn-sm">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t('加选免费', 'Add free')}
                </button>
                <button
                  type="button"
                  id="clearSelBtn"
                  onClick={() => setSelectedIds(new Set())}
                  className="wb-btn wb-btn-sm"
                >
                  {t('清空勾选', 'Clear')}
                </button>
                {badCheckedIds.length > 0 && (
                  <button type="button" id="uncheckBadBtn" onClick={handleUncheckBad} className="wb-btn wb-btn-danger wb-btn-sm">
                    {t(`取消勾选不可用的（${badCheckedIds.length}）`, `Uncheck failed (${badCheckedIds.length})`)}
                  </button>
                )}
              </div>
            </div>

            {/* Row 2: Client Default Model Scope + Availability Probe Controls */}
            <div className="wb-inset p-3 flex flex-wrap items-center gap-2">
              <div id="modelDefaultBar" className="flex flex-wrap items-center gap-2">
                <span className="text-[12px] font-medium" style={{ color: 'var(--muted)' }}>
                  {t('客户端默认拉取范围', 'Client /v1/models')}
                </span>
                <Select
                  title={t('客户端默认拉取范围', 'Client /v1/models scope')}
                  value={defaultMode}
                  disabled={!models.modelsDefault}
                  onChange={(v) => {
                    setDefaultTouched(true);
                    setDefaultMode(v as 'curated' | 'all' | 'ids');
                  }}
                  options={[
                    { value: 'curated', label: t('精选（默认）', 'Curated (default)') },
                    { value: 'all', label: t('全部目录', 'All catalog') },
                    { value: 'ids', label: t(`表格里勾选的（${selectedIds.size}）`, `Selected (${selectedIds.size})`) },
                  ]}
                  menuMinWidth={164}
                />
                <button
                  type="button"
                  disabled={!models.modelsDefault || savingDefault || (defaultMode === 'ids' && selectedIds.size === 0)}
                  onClick={() => void handleSaveDefaultMode()}
                  className="wb-btn wb-btn-primary wb-btn-sm"
                >
                  {t('保存范围', 'Save scope')}
                </button>
                {models.modelsDefault && (
                  <span className="mono text-[11.5px]" style={{ color: 'var(--faint)' }}>
                    {t(
                      `当前 ${models.modelsDefault.count ?? '—'}/${models.modelsDefault.total ?? catalog.length}`,
                      `${models.modelsDefault.count ?? '—'}/${models.modelsDefault.total ?? catalog.length}`,
                    )}
                  </span>
                )}
              </div>

              <span className="hidden sm:inline-block h-4 w-px mx-1" style={{ background: 'var(--border)' }} />

              <Select
                id="probeScope"
                title={t('体检范围', 'Probe scope')}
                value={probeScope}
                onChange={(v) => {
                  setProbeScopeTouched(true);
                  setProbeScope(v as 'checked' | 'registered' | 'all');
                }}
                options={[
                  { value: 'checked', label: t(`勾选的（${selectedIds.size}）`, `Checked (${selectedIds.size})`) },
                  ...(registeredInCatalogIds.length > 0
                    ? [{ value: 'registered', label: t(`已注册的（${registeredInCatalogIds.length}）`, `Registered (${registeredInCatalogIds.length})`) }]
                    : []),
                  { value: 'all', label: t(`全部（${catalog.length}）`, `All (${catalog.length})`) },
                ]}
                menuMinWidth={148}
              />

              <Select
                id="probeInputTokens"
                title={t('体检发出的输入体积，体积越大越接近长对话真实限流口径', 'Probe input size; larger volume better reflects long-context rate limits')}
                value={String(probeSize)}
                onChange={(v) => {
                  const num = Number(v) || 10000;
                  setProbeSize(num);
                  SHARED_PROBE.setValue(num);
                }}
                options={PROBE_SIZES.map((sz) => ({
                  value: String(sz),
                  label: t(`体积 ${sz / 1000}k`, `Size ${sz / 1000}k`),
                }))}
                menuMinWidth={118}
              />

              <button
                type="button"
                id="probeAllBtn"
                disabled={probeRunning || probeTargetIds.length === 0}
                onClick={() => void handleRunProbe()}
                title={
                  en
                    ? `Probing ${probeTargetIds.length} model(s) (~${estTotalCost.toFixed(1)} credits)`
                    : `将探测 ${probeTargetIds.length} 个模型（约 ${estTotalCost.toFixed(1)} 积分）`
                }
                className="wb-btn wb-btn-accent wb-btn-sm"
              >
                <Play className="h-3 w-3" />
                {t(`测试可用性（${probeTargetIds.length} 个）`, `Probe (${probeTargetIds.length})`)}
              </button>

              {probeUpdatedAt && (
                <button
                  type="button"
                  id="probeClearBtn"
                  onClick={() => void handleClearProbe()}
                  className="wb-btn wb-btn-ghost wb-btn-sm"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('清除体检', 'Clear probes')}
                </button>
              )}

              <span id="probeCostHint" className="text-[11.5px] mono ml-auto" style={{ color: 'var(--faint)' }}>
                {t(`约 ${perModelCost.toFixed(2)}/个 · 共 ≈ ${estTotalCost.toFixed(1)} 积分`, `~${perModelCost.toFixed(2)}/ea · total ≈ ${estTotalCost.toFixed(1)} cr`)}
              </span>
            </div>

            {regMsg.text && (
              <div
                id="regMsg"
                className="px-1 text-[12px] font-medium"
                style={{ color: regMsg.tone === 'good' ? 'var(--ok)' : regMsg.tone === 'err' ? 'var(--fail)' : 'var(--muted)' }}
              >
                {regMsg.text}
              </div>
            )}

            {/* Aligned Clean 10-Column Models Table */}
            <div className="wb-table-wrap tablewrap">
              <table id="modelTable" className="wb-table [&_th]:px-2 [&_td]:px-2 [&_th]:py-2 [&_td]:py-2 text-[12px]">
                <thead>
                  <tr>
                    <th className="w-8" aria-label={t('选择', 'Select')} />
                    <th>{t('模型 id', 'Model id')}</th>
                    <th>{t('显示名', 'Display name')}</th>
                    <th className="num">{t('上下文', 'Context')}</th>
                    <th className="num">{t('最大输出', 'Max output')}</th>
                    <th className="num">{t('倍率', 'Multiplier')}</th>
                    <th title={t('上游 /v2/chat/busy 实时负载探测', 'Live load from upstream /v2/chat/busy')}>
                      {t('拥堵', 'Load')}
                    </th>
                    <th className="num">{t('实测成本', 'Measured cost')}</th>
                    <th
                      id="probeSortTh"
                      onClick={() => {
                        setSortByCredits(false);
                        setProbeSort((cur) => (cur === '' ? 'ok' : cur === 'ok' ? 'ms' : cur === 'ms' ? 'msdesc' : ''));
                      }}
                      className="cursor-pointer select-none"
                      title={t('点击按可用性与耗时循环排序', 'Click to cycle sort by availability & latency')}
                    >
                      {t('可用性', 'Availability')}
                      {probeSort === 'ok' ? ' ↓' : probeSort === 'ms' ? ' ↑ms' : probeSort === 'msdesc' ? ' ↓ms' : ''}
                    </th>
                    <th className="num">{t('速度', 'Speed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleModels.map((m) => {
                    const checked = selectedIds.has(m.id);
                    const p = probeResults[m.id];
                    const isProbing = probingIds.has(m.id);
                    const cost = costMap.get(m.id);
                    const isDetailOpen = openDetailId === m.id;
                    const isFree = m.free === true || Number(m.credits) === 0;

                    return (
                      <React.Fragment key={m.id}>
                        <tr data-model-id={m.id}>
                          <td>
                            <input
                              type="checkbox"
                              data-id={m.id}
                              checked={checked}
                              aria-label={en ? `Select ${m.name || m.id}` : `选中 ${m.name || m.id}`}
                              onChange={(e) => {
                                const next = new Set(selectedIds);
                                if (e.target.checked) next.add(m.id);
                                else next.delete(m.id);
                                setSelectedIds(next);
                              }}
                              className="accent-[var(--primary)] cursor-pointer"
                            />
                          </td>
                          <td className="whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={async () => {
                                  const ok = await copyToClipboard(m.id);
                                  if (ok) {
                                    setCopiedId(m.id);
                                    setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1400);
                                  }
                                }}
                                title={t(`复制 ${m.id}`, `Copy ${m.id}`)}
                                className="idcopy inline-flex items-center gap-1.5 mono font-semibold text-[12px] whitespace-nowrap hover:underline cursor-pointer"
                                style={{ color: copiedId === m.id ? 'var(--ok)' : 'var(--text)' }}
                              >
                                <span>{m.id}</span>
                                {copiedId === m.id ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0 opacity-45" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => setOpenDetailId(isDetailOpen ? null : m.id)}
                                aria-expanded={isDetailOpen}
                                aria-label={t(`查看 ${m.id} 详情`, `Inspect ${m.id}`)}
                                title={t('查看模型详情', 'Model details')}
                                className="infobtn inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors cursor-pointer"
                                style={{
                                  background: isDetailOpen ? 'var(--primary-soft)' : 'transparent',
                                  color: isDetailOpen ? 'var(--primary-text)' : 'var(--faint)',
                                }}
                              >
                                <Info className="h-3.5 w-3.5" />
                              </button>
                              {m.supports_images && (
                                <span title={t('支持图片 / 多模态', 'Vision supported')} style={{ color: 'var(--info)' }}>
                                  <Eye className="h-3.5 w-3.5" />
                                </span>
                              )}
                              {m.supports_reasoning && (
                                <span title={t('支持深度思考', 'Reasoning supported')} style={{ color: 'var(--promo)' }}>
                                  <Brain className="h-3.5 w-3.5" />
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5">
                              <span className="truncate max-w-[106px]" data-i18n-skip="" title={m.name || m.id} style={{ color: 'var(--text-secondary)' }}>
                                {m.name || m.id}
                              </span>
                              {m.official === false && (
                                <span
                                  className="tag unlisted wb-tag wb-tag-warn"
                                  title={t('网关目录里有，但 WorkBuddy 官方模型选择器未列出', 'Present in gateway catalog, not in official picker')}
                                >
                                  {t('未列出', 'Not listed')}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="num mono" title={m.context_window ? fmtNum(m.context_window) : ''}>
                            {fmtCompact(m.context_window)}
                          </td>
                          <td className="num mono" title={m.max_output_tokens ? fmtNum(m.max_output_tokens) : ''}>
                            {fmtCompact(m.max_output_tokens)}
                          </td>
                          <td className="num">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {isFree ? (
                                <span className="wb-tag wb-tag-promo">{t('免费', 'Free')}</span>
                              ) : typeof m.credits === 'number' ? (
                                <span className="mono">{m.credits}</span>
                              ) : (
                                <span style={{ color: 'var(--faint)' }}>—</span>
                              )}
                              {m.badge && (
                                <span
                                  className="tag promo wb-tag wb-tag-promo"
                                  title={[m.promotion_active ? t('促销进行中', 'Promo active') : '', m.promotion_text || ''].filter(Boolean).join(' · ')}
                                >
                                  {tu(m.badge)}
                                </span>
                              )}
                            </div>
                          </td>
                          <td>{renderBusyTag(m)}</td>
                          <td
                            className="num mono text-[12px] whitespace-nowrap"
                            title={cost?.reason || (cost?.per1k != null ? `${cost.per1k.toFixed(4)} / 1k tokens (${cost.samples})` : t('暂无成功调用样本', 'No successful call samples yet'))}
                          >
                            {cost?.per1k != null
                              ? en
                                ? `${cost.per1k === 0 ? '0' : Number(cost.per1k.toFixed(3))} / 1k tokens (${cost.samples})`
                                : `${cost.per1k === 0 ? '0' : Number(cost.per1k.toFixed(3))} / 千 token（${cost.samples} 次）`
                              : '—'}
                          </td>
                          <td data-probe={m.id}>
                            {isProbing ? (
                              <span className="tag wb-tag wb-tag-info">{t('测试中…', 'Testing…')}</span>
                            ) : !p ? (
                              <span style={{ color: 'var(--faint)' }}>{t('未测', 'Untested')}</span>
                            ) : p.ok ? (
                              <span
                                className="tag wb-tag wb-tag-ok"
                                title={`${t('测得时间', 'Measured')} ${p.at ? fmtAgo(p.at, en) : ''}`}
                              >
                                {t('可用', 'OK')} {p.ms ? `${p.ms}ms` : ''}
                                {p.inputTokens ? ` · ${Math.round(p.inputTokens / 1000)}k` : ''}
                              </span>
                            ) : (
                              <span
                                className="tag wb-tag wb-tag-fail"
                                title={`${p.error || t('不可用', 'Unavailable')}${p.at ? ` (${fmtAgo(p.at, en)})` : ''}`}
                              >
                                {t('不可用', 'Fail')}
                              </span>
                            )}
                          </td>
                          <td className="num" data-tps={m.id} data-fn="renderTpsCell">
                            {renderTpsCell(m.id)}
                          </td>
                        </tr>

                        {/* Expandable Model Detail Inspector Row */}
                        {isDetailOpen && (
                          <tr className="detail-row">
                            <td colSpan={10} style={{ background: 'var(--surface-subtle)' }}>
                              <div className="detail-body wb-animate-in p-3.5 rounded-xl space-y-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2">
                                    <code className="font-bold text-[13px]">{m.id}</code>
                                    {m.vendor && <span className="wb-tag">{m.vendor}</span>}
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => setOpenDetailId(null)}
                                    className="wb-btn wb-btn-ghost wb-btn-sm px-1.5"
                                    aria-label={t('关闭详情', 'Close details')}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                                <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-[12px]">
                                  {m.description_zh && (!en || !m.description_en) && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('中文描述', 'Description (ZH)')}</dt>
                                      <dd data-i18n-skip="" style={{ color: 'var(--text)' }}>{m.description_zh}</dd>
                                    </div>
                                  )}
                                  {m.description_en && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('英文描述', 'Description (EN)')}</dt>
                                      <dd data-i18n-skip="" style={{ color: 'var(--text)' }}>{m.description_en}</dd>
                                    </div>
                                  )}
                                  <div>
                                    <dt style={{ color: 'var(--muted)' }}>{t('官方目录', 'Official catalog')}</dt>
                                    <dd style={{ color: 'var(--text)' }}>
                                      {m.official === false
                                        ? t('未列出（网关有、官方模型选择器不铺；默认不进 dsh 选择器）', 'Not listed in official picker (off by default in DSH)')
                                        : t('已列出', 'Listed')}
                                    </dd>
                                  </div>
                                  {m.context_window_default != null && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('官方默认上下文', 'Official default context')}</dt>
                                      <dd className="mono">{fmtNum(m.context_window_default)}</dd>
                                    </div>
                                  )}
                                  {m.context_window_max != null && m.context_window_max !== m.context_window_default && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('上下文上限', 'Context ceiling')}</dt>
                                      <dd className="mono">{fmtNum(m.context_window_max)}</dd>
                                    </div>
                                  )}
                                  {Array.isArray(m.context_window_options) && m.context_window_options.length > 0 && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('官方可选档位', 'Official context options')}</dt>
                                      <dd className="mono">{m.context_window_options.map((x) => fmtCompact(x)).join(' / ')}</dd>
                                    </div>
                                  )}
                                  {Array.isArray(m.reasoning_efforts) && m.reasoning_efforts.length > 0 && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('思考档位', 'Reasoning levels')}</dt>
                                      <dd className="mono">
                                        {m.reasoning_efforts.join(' · ')}
                                        {m.default_reasoning_effort ? ` (${t('默认', 'default')}: ${m.default_reasoning_effort})` : ''}
                                      </dd>
                                    </div>
                                  )}
                                  {m.default_temperature != null && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('官方默认 temperature', 'Official default temperature')}</dt>
                                      <dd className="mono">{m.default_temperature}</dd>
                                    </div>
                                  )}
                                  {m.context_window != null && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('上下文（精确）', 'Context (exact)')}</dt>
                                      <dd className="mono">{fmtNum(m.context_window)}</dd>
                                    </div>
                                  )}
                                  {m.max_output_tokens != null && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('最大输出（精确）', 'Max output (exact)')}</dt>
                                      <dd className="mono">{fmtNum(m.max_output_tokens)}</dd>
                                    </div>
                                  )}
                                  {m.supports_images && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('支持图片', 'Vision')}</dt>
                                      <dd>{t('是', 'Yes')}</dd>
                                    </div>
                                  )}
                                  {m.promotion_text && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('促销说明', 'Promotion')}</dt>
                                      <dd>
                                        {tu(m.promotion_text)}
                                        {m.promotion_until ? ` (${m.promotion_until})` : ''}
                                      </dd>
                                    </div>
                                  )}
                                  {p && (
                                    <div>
                                      <dt style={{ color: 'var(--muted)' }}>{t('体检结论', 'Probe verdict')}</dt>
                                      <dd style={{ color: p.ok ? 'var(--ok)' : 'var(--fail)' }}>
                                        {p.ok ? `${t('可用', 'OK')} (${p.ms}ms)` : `${t('不可用', 'Fail')}: ${p.error || ''}`}
                                      </dd>
                                    </div>
                                  )}
                                </dl>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
};
