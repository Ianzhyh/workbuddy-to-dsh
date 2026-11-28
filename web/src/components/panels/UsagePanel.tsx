import React, { useMemo, useState } from 'react';
import { Activity, BarChart3, Download, PieChart, Trash2, TrendingUp } from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import {
  api,
  downloadCsv,
  fmtCompact,
  fmtCredit,
  fmtNum,
  localDateStr,
  MODEL_CHART_PALETTE,
  toWeekBuckets,
} from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { useNativeInputSync } from '../../lib/useDomSync';
import type { UsageBucket } from '../../types/api';
import { useDialog } from '../ui/Dialog';
import { EmptyState, Panel, SkeletonBlock } from '../ui/Panel';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';

type Metric = 'calls' | 'tokens' | 'credit';
type ChartKind = 'auto' | 'bar' | 'line' | 'bymodel';

interface ChartSeries {
  name: string;
  color: string;
  values: number[];
  dashed?: boolean;
}

/** Smooth Catmull-Rom to Cubic Bezier SVG path generator (clamped to baseline) */
function buildSmoothPath(pts: Array<{ x: number; y: number }>, minY: number, maxY: number): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  if (pts.length === 2) {
    return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;
  }
  const clamp = (v: number) => Math.max(minY, Math.min(maxY, v));
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = clamp(p1.y + (p2.y - p0.y) / 6);
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = clamp(p2.y - (p3.y - p1.y) / 6);
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

export const UsagePanel: React.FC = () => {
  const {
    usageDays,
    setUsageDays,
    trendGran,
    setTrendGran,
    usageDay,
    usageView,
    usageStamp,
    usageLoading,
    loadUsage,
    loadRequests,
    reqModelFilter,
    setReqModelFilter,
    setMsg,
  } = useConsole();
  const { en, t } = useI18n();
  const { confirm } = useDialog();

  const [metric, setMetric] = useState<Metric>('calls');
  const [kind, setKind] = useState<ChartKind>('auto');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [donutHover, setDonutHover] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  // Hidden native <select> sync refs for controls driven by segmented pills
  const metricRef = useNativeInputSync<HTMLSelectElement>((el) => setMetric(el.value as Metric));
  const granRef = useNativeInputSync<HTMLSelectElement>((el) => setTrendGran(el.value as 'day' | 'week' | 'hour'));

  const data = usageView || usageDay;

  // Deterministic per-model colors seeded from usage.models
  const modelColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const list = (data?.models || usageDay?.models || []).map((m) => m.model);
    list.forEach((name, idx) => {
      if (!map.has(name)) map.set(name, MODEL_CHART_PALETTE[idx % MODEL_CHART_PALETTE.length]);
    });
    return map;
  }, [data?.models, usageDay?.models]);

  const getColor = (name: string) => {
    if (modelColorMap.has(name)) return modelColorMap.get(name)!;
    let h = 0;
    for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return MODEL_CHART_PALETTE[h % MODEL_CHART_PALETTE.length];
  };

  // Compute time buckets based on granularity
  const buckets = useMemo<UsageBucket[]>(() => {
    if (!data) return [];
    if (trendGran === 'hour') return Array.isArray(data.hours) ? data.hours : [];
    if (trendGran === 'week') return toWeekBuckets(data.days || []);
    return Array.isArray(data.days) ? data.days : [];
  }, [data, trendGran]);

  const bucketLabels = useMemo(
    () =>
      buckets.map((b) => {
        if (trendGran === 'hour') {
          const hr = String(b.hour || b.label || '').slice(-2);
          return en ? `${hr}:00` : `${hr} 时`;
        }
        const mmdd = String(b.day || b.label || '').slice(5);
        return trendGran === 'week' ? (en ? `Wk ${mmdd}` : `${mmdd} 周`) : mmdd;
      }),
    [buckets, en, trendGran],
  );

  // Build chart series & chart mode
  const chartSpec = useMemo(() => {
    if (!buckets.length) return { mode: 'bar' as 'bar' | 'stackBar' | 'line', series: [] as ChartSeries[], maxVal: 0 };

    const effectiveMode: 'bar' | 'stackBar' | 'line' =
      kind === 'bymodel'
        ? 'stackBar'
        : kind === 'line'
          ? 'line'
          : kind === 'bar'
            ? metric === 'tokens'
              ? 'stackBar'
              : 'bar'
            : metric === 'tokens'
              ? 'stackBar'
              : metric === 'credit'
                ? 'line'
                : 'bar';

    const series: ChartSeries[] = [];

    if (kind === 'bymodel') {
      const totals = new Map<string, number>();
      for (const b of buckets) {
        for (const m of b.byModel || []) {
          const val =
            metric === 'calls'
              ? Number(m.calls) || 0
              : metric === 'tokens'
                ? (Number(m.promptTokens) || 0) + (Number(m.completionTokens) || 0)
                : Number(m.credit) || 0;
          totals.set(m.model, (totals.get(m.model) || 0) + val);
        }
      }
      const ordered = [...totals.entries()]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name]) => name);
      for (const mName of ordered) {
        series.push({
          name: mName,
          color: getColor(mName),
          values: buckets.map((b) => {
            const hit = (b.byModel || []).find((x) => x.model === mName);
            if (!hit) return 0;
            return metric === 'calls'
              ? Number(hit.calls) || 0
              : metric === 'tokens'
                ? (Number(hit.promptTokens) || 0) + (Number(hit.completionTokens) || 0)
                : Number(hit.credit) || 0;
          }),
        });
      }
    } else if (metric === 'calls') {
      series.push({
        name: t('调用次数', 'Calls'),
        color: 'var(--primary)',
        values: buckets.map((b) => Number(b.calls) || 0),
      });
    } else if (metric === 'tokens') {
      series.push(
        { name: t('输入', 'Input'), color: '#0a84ff', values: buckets.map((b) => Number(b.promptTokens) || 0) },
        { name: t('输出', 'Output'), color: '#30d158', values: buckets.map((b) => Number(b.completionTokens) || 0) },
      );
    } else {
      const raw = buckets.map((b) => Number(b.credit) || 0);
      let acc = 0;
      const cum = raw.map((v) => {
        acc = Number((acc + v).toFixed(4));
        return acc;
      });
      series.push(
        { name: t('积分', 'Credit'), color: '#ff9f0a', values: raw },
        { name: t('累计', 'Cumulative'), color: 'var(--primary)', values: cum, dashed: true },
      );
    }

    let maxVal = 0;
    if (effectiveMode === 'stackBar') {
      for (let i = 0; i < buckets.length; i += 1) {
        let sum = 0;
        for (const s of series) {
          if (!s.dashed) sum += s.values[i] || 0;
        }
        maxVal = Math.max(maxVal, sum);
      }
    }
    for (const s of series) {
      for (const v of s.values) maxVal = Math.max(maxVal, v || 0);
    }
    return { mode: effectiveMode, series, maxVal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, kind, metric, modelColorMap, t]);

  // Period Analytics Insights (Peak / Avg / Active buckets)
  const insights = useMemo(() => {
    if (!buckets.length) return null;
    const perBucket = buckets.map((b, i) => {
      const val =
        metric === 'calls'
          ? Number(b.calls) || 0
          : metric === 'tokens'
            ? (Number(b.promptTokens) || 0) + (Number(b.completionTokens) || 0)
            : Number(b.credit) || 0;
      return { val, label: bucketLabels[i] || '' };
    });
    const total = perBucket.reduce((s, x) => s + x.val, 0);
    let peak = perBucket[0];
    for (const item of perBucket) {
      if (item.val > peak.val) peak = item;
    }
    const activeCount = perBucket.filter((x) => x.val > 0).length;
    const avg = activeCount > 0 ? total / activeCount : 0;
    return { total, peak, avg, activeCount, totalBuckets: perBucket.length };
  }, [bucketLabels, buckets, metric]);

  const tot = data?.total;
  const isCompletelyEmpty =
    !tot ||
    ((tot.calls || 0) === 0 &&
      (tot.failed || 0) === 0 &&
      (tot.searches || 0) === 0 &&
      (tot.searchFailed || 0) === 0 &&
      (tot.videos || 0) === 0 &&
      (tot.videoFailed || 0) === 0 &&
      (tot.images || 0) === 0 &&
      (tot.imageFailed || 0) === 0);

  const hasVideo = tot && ((tot.videos || 0) > 0 || (tot.videoFailed || 0) > 0 || (tot.videoCreditKnown || 0) > 0);
  const hasImage = tot && ((tot.images || 0) > 0 || (tot.imageFailed || 0) > 0 || (tot.imageCreditKnown || 0) > 0);
  const hasSearchMetric = tot && Number.isFinite(Number(tot.searches));

  // Token Composition Donut Breakdown (Uncached Input / Cached Input / Output)
  const tokenMix = useMemo(() => {
    if (!tot) return null;
    const prompt = Math.max(0, Number(tot.promptTokens) || 0);
    const completion = Math.max(0, Number(tot.completionTokens) || 0);
    const cachedRaw =
      typeof tot.cachedTokens === 'number' && tot.cachedTokens > 0
        ? Math.min(prompt, tot.cachedTokens)
        : (tot.cacheKnownCalls || 0) > 0 && typeof tot.cacheHitRate === 'number'
          ? Math.round(prompt * Math.max(0, Math.min(1, tot.cacheHitRate)))
          : 0;
    const uncached = Math.max(0, prompt - cachedRaw);
    const sum = uncached + cachedRaw + completion;
    const segments = [
      { id: 'uncached', label: t('未命中输入', 'Uncached in'), value: uncached, color: '#0a84ff' },
      { id: 'cached', label: t('缓存命中', 'Cached hit'), value: cachedRaw, color: '#64d2ff' },
      { id: 'output', label: t('模型输出', 'Output'), value: completion, color: '#30d158' },
    ].filter((s) => s.value > 0);
    return { sum, prompt, completion, cached: cachedRaw, uncached, segments };
  }, [t, tot]);

  // Health & Efficiency metrics
  const health = useMemo(() => {
    if (!tot) return null;
    const okCalls = Math.max(0, Number(tot.calls) || 0);
    const failCalls = Math.max(0, Number(tot.failed) || 0);
    const all = okCalls + failCalls;
    const successRate = all > 0 ? (okCalls / all) * 100 : 100;
    const avgLatency = okCalls > 0 ? Math.round((tot.ms || 0) / okCalls) : null;
    const totalTokens = (Number(tot.promptTokens) || 0) + (Number(tot.completionTokens) || 0);
    const tokPerCall = okCalls > 0 ? Math.round(totalTokens / okCalls) : null;
    const creditPerCall = (tot.creditCalls || 0) > 0 ? Number((tot.credit / tot.creditCalls).toFixed(4)) : null;
    return { okCalls, failCalls, all, successRate, avgLatency, tokPerCall, creditPerCall };
  }, [tot]);

  // Credit ranking split
  const ranking = useMemo(() => {
    const rows = data?.models || [];
    const reported = rows.filter((m) => (m.creditCalls || 0) > 0).sort((a, b) => (b.credit || 0) - (a.credit || 0));
    const unreported = rows.filter((m) => (m.creditCalls || 0) === 0 && (m.calls || 0) > 0);
    const totalCredit = reported.reduce((s, m) => s + (Number(m.credit) || 0), 0);
    const top8 = reported.slice(0, 8);
    const rest = reported.slice(8);
    const restCredit = rest.reduce((s, m) => s + (Number(m.credit) || 0), 0);
    const restCalls = rest.reduce((s, m) => s + (Number(m.calls) || 0), 0);
    return { top8, restCount: rest.length, restCredit, restCalls, totalCredit, unreported };
  }, [data?.models]);

  const handleFilterModel = (modelId: string) => {
    const next = reqModelFilter === modelId ? '' : modelId;
    setReqModelFilter(next);
    if (next) {
      document.getElementById('reqBox')?.scrollIntoView({ block: 'start' });
    }
  };

  const handleExportCsv = () => {
    const src = usageDay || data;
    if (!src || !src.models?.length) {
      setMsg(t('暂无可导出的用量数据。', 'No usage data to export.'), 'err');
      return;
    }
    const rows: unknown[][] = [
      [
        t('模型', 'Model'),
        t('调用次数', 'Calls'),
        t('输入 tokens', 'Input tokens'),
        t('输出 tokens', 'Output tokens'),
        t('消耗积分', 'Credit spent'),
        t('积分回报次数', 'Credit reports'),
        t('积分/次', 'Credit / call'),
        t('总耗时(ms)', 'Total time (ms)'),
      ],
    ];
    for (const m of src.models) {
      rows.push([
        m.model,
        m.calls,
        m.promptTokens,
        m.completionTokens,
        m.creditCalls > 0 ? m.credit : '',
        m.creditCalls,
        m.creditCalls > 0 ? Number((m.credit / m.creditCalls).toFixed(4)) : '',
        m.ms,
      ]);
    }
    const tt = src.total;
    rows.push([
      t('合计', 'Total'),
      tt.calls,
      tt.promptTokens,
      tt.completionTokens,
      tt.creditCalls > 0 ? tt.credit : '',
      tt.creditCalls,
      tt.creditCalls > 0 ? Number((tt.credit / tt.creditCalls).toFixed(4)) : '',
      tt.ms,
    ]);
    downloadCsv(`workbuddy-usage-${localDateStr()}.csv`, rows);
    setMsg(t('已导出用量 CSV。', 'Usage CSV exported.'), 'good');
  };

  const handleClearLedger = async () => {
    const ok = await confirm(
      t('确定清空本地用量账本？清空后用量统计与最近请求记录将归零，无法恢复。', 'Clear the local usage ledger? Usage statistics and recent requests will reset to zero and cannot be undone.'),
      { danger: true },
    );
    if (!ok) return;
    setClearing(true);
    try {
      const r = await api<{ cleared?: boolean; ok?: boolean; error?: string }>('/api/usage', { method: 'DELETE' });
      if (r.cleared || r.ok || r._httpOk) {
        setMsg(t('已清空用量账本。', 'Usage ledger cleared.'), 'good');
        await Promise.all([loadUsage({ force: true }), loadRequests()]);
      } else {
        setMsg(t('清空失败：', 'Clear failed: ') + (r.error || ''), 'err');
      }
    } finally {
      setClearing(false);
    }
  };

  // SVG Chart Geometry
  const W = 780;
  const H = 224;
  const PAD = { top: 20, right: 16, bottom: 30, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const fmtAxis = (v: number) => {
    if (metric === 'tokens') return fmtCompact(v);
    if (metric === 'credit') return Number(v.toFixed(2)).toString();
    return String(Math.round(v));
  };

  const fmtMetricVal = (v: number) => {
    if (metric === 'tokens') return fmtCompact(Math.round(v));
    if (metric === 'credit') return Number(v.toFixed(3)).toString();
    return fmtNum(Math.round(v));
  };

  const fmtTipVal = (v: number) => {
    if (metric === 'tokens') return fmtNum(Math.round(v));
    if (metric === 'credit') return Number(v.toFixed(4)).toString();
    return fmtNum(Math.round(v));
  };

  const xStep = buckets.length > 20 ? 4 : buckets.length > 12 ? 2 : 1;

  // Active quick range pill helper
  const activeRangeKey = trendGran === 'hour' ? '24h' : trendGran === 'week' ? '12w' : `${usageDays}d`;
  const selectRangePreset = (key: '24h' | '1d' | '7d' | '30d' | '12w') => {
    if (key === '24h') {
      setTrendGran('hour');
    } else if (key === '12w') {
      setTrendGran('week');
    } else {
      const d = key === '1d' ? 1 : key === '30d' ? 30 : 7;
      setTrendGran('day');
      setUsageDays(d);
    }
  };

  // Hovered bucket per-model mini breakdown for floating tooltip
  const hoveredModels = useMemo(() => {
    if (hoverIdx === null || !buckets[hoverIdx]?.byModel?.length) return [];
    return [...buckets[hoverIdx].byModel!]
      .map((m) => ({
        model: m.model,
        val:
          metric === 'calls'
            ? Number(m.calls) || 0
            : metric === 'tokens'
              ? (Number(m.promptTokens) || 0) + (Number(m.completionTokens) || 0)
              : Number(m.credit) || 0,
      }))
      .filter((x) => x.val > 0)
      .sort((a, b) => b.val - a.val)
      .slice(0, 3);
  }, [buckets, hoverIdx, metric]);

  return (
    <Panel
      section="overview"
      title={t('用量与消耗分析', 'Usage & Analytics')}
      subtitle={t('本地账本元数据趋势、Token 构成与模型成本归因（不含任何对话内容）', 'Local ledger trends, token mix & per-model attribution (no conversation content)')}
      icon={<BarChart3 className="h-4 w-4" />}
      stamp={usageStamp ? t(`更新于 ${usageStamp}`, `Updated ${usageStamp}`) : undefined}
      stampId="usageStamp"
      actions={
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Hidden parity selects for programmatic/test manipulation */}
          <select
            ref={metricRef}
            id="trendMetric"
            title={t('趋势图指标', 'Trend metric')}
            value={metric}
            onChange={(e) => setMetric(e.target.value as Metric)}
            aria-hidden="true"
            tabIndex={-1}
            className="sr-only"
          >
            <option value="calls">{t('调用次数', 'Calls')}</option>
            <option value="tokens">tokens</option>
            <option value="credit">{t('积分', 'Credit')}</option>
          </select>
          <select
            ref={granRef}
            id="trendGran"
            title={t('趋势图粒度', 'Trend granularity')}
            value={trendGran}
            onChange={(e) => setTrendGran(e.target.value as 'day' | 'week' | 'hour')}
            aria-hidden="true"
            tabIndex={-1}
            className="sr-only"
          >
            <option value="day">{t('按天', 'By day')}</option>
            <option value="week">{t('按周', 'Weekly')}</option>
            <option value="hour">{t('最近 24 小时', 'Last 24 hours')}</option>
          </select>

          <Select
            id="usageDays"
            title={t('统计天数', 'Number of days')}
            value={String(usageDays)}
            onChange={(v) => {
              setTrendGran('day');
              setUsageDays(Number(v) || 7);
            }}
            options={[
              { value: '1', label: t('最近 1 天', 'Last 1d') },
              { value: '7', label: t('最近 7 天', 'Last 7d') },
              { value: '30', label: t('最近 30 天', 'Last 30d') },
            ]}
            menuMinWidth={130}
          />

          <Select
            id="trendKind"
            title={t('趋势图形态', 'Trend chart type')}
            value={kind}
            onChange={(v) => setKind(v as ChartKind)}
            options={[
              { value: 'auto', label: t('形态自动', 'Auto') },
              { value: 'bar', label: t('柱状图', 'Bar chart') },
              { value: 'line', label: t('曲线图', 'Curve chart') },
              { value: 'bymodel', label: t('按模型堆叠', 'Stack by model') },
            ]}
            menuMinWidth={148}
          />

          <button type="button" id="usageCsvBtn" onClick={handleExportCsv} className="wb-btn wb-btn-sm">
            <Download className="h-3.5 w-3.5" />
            {t('导出 CSV', 'Export CSV')}
          </button>
          <button
            type="button"
            id="usageClearBtn"
            disabled={clearing}
            onClick={() => void handleClearLedger()}
            className="wb-btn wb-btn-danger wb-btn-sm"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('清空账本', 'Clear ledger')}
          </button>
        </div>
      }
    >
      <div id="usageBox" className="space-y-4">
        {!data && usageLoading ? (
          <SkeletonBlock lines={5} label={t('加载中…', 'Loading…')} />
        ) : isCompletelyEmpty ? (
          <EmptyState
            icon={<BarChart3 className="h-5 w-5" />}
            title={t('暂无数据（桥未运行或还没有请求过）。', 'No data (bridge not running, or no requests yet).')}
          />
        ) : (
          <>
            {/* Optional Media Generation Metrics */}
            {(hasVideo || hasImage) && tot && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {hasVideo && (
                  <>
                    <div className="wb-inset p-3.5">
                      <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('视频提交', 'Video submissions')}</div>
                      <div className="mt-1 text-[18px] font-bold">{fmtNum(tot.videos || 0)}</div>
                      {(tot.videoFailed || 0) > 0 && (
                        <div className="text-[11px]" style={{ color: 'var(--fail)' }}>
                          {t(`视频失败 ${tot.videoFailed}`, `Video failures ${tot.videoFailed}`)}
                        </div>
                      )}
                    </div>
                    <div className="wb-inset p-3.5">
                      <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('视频消耗积分', 'Video credit used')}</div>
                      <div className="mt-1 text-[18px] font-bold">{fmtCredit(tot.videoCredit, tot.videoCreditKnown)}</div>
                      <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{t('余额差估算', 'estimated from balance delta')}</div>
                    </div>
                  </>
                )}
                {hasImage && (
                  <>
                    <div className="wb-inset p-3.5">
                      <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('图片提交', 'Image submissions')}</div>
                      <div className="mt-1 text-[18px] font-bold">{fmtNum(tot.images || 0)}</div>
                      {(tot.imageFailed || 0) > 0 && (
                        <div className="text-[11px]" style={{ color: 'var(--fail)' }}>
                          {t(`图片失败 ${tot.imageFailed}`, `Image failures ${tot.imageFailed}`)}
                        </div>
                      )}
                    </div>
                    <div className="wb-inset p-3.5">
                      <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('图片消耗积分', 'Image credit used')}</div>
                      <div className="mt-1 text-[18px] font-bold">{fmtCredit(tot.imageCredit, tot.imageCreditKnown)}</div>
                      <div className="text-[11px]" style={{ color: 'var(--faint)' }}>{t('余额差估算', 'estimated from balance delta')}</div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Main 6-Tile Metric Strip */}
            {tot && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
                <div className="wb-inset px-3.5 py-3">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('调用次数', 'Calls')}</div>
                  <div className="mt-1 text-[19px] font-bold tracking-tight">{fmtNum(tot.calls)}</div>
                  <div className="mt-0.5 text-[11px]" style={{ color: 'var(--faint)' }}>
                    {trendGran === 'week'
                      ? t('最近 12 周', 'Last 12w')
                      : trendGran === 'hour'
                        ? t('最近 24 小时', 'Last 24h')
                        : t(`最近 ${data.windowDays || usageDays} 天`, `Last ${data.windowDays || usageDays}d`)}
                  </div>
                </div>

                <div className="wb-inset px-3.5 py-3">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('输入 tokens', 'Input tokens')}</div>
                  <div className="mt-1 text-[19px] font-bold tracking-tight">{fmtCompact(tot.promptTokens)}</div>
                  <div className="mt-0.5 mono text-[11px] truncate" style={{ color: 'var(--faint)' }}>{fmtNum(tot.promptTokens)}</div>
                </div>

                <div className="wb-inset px-3.5 py-3">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('输出 tokens', 'Output tokens')}</div>
                  <div className="mt-1 text-[19px] font-bold tracking-tight">{fmtCompact(tot.completionTokens)}</div>
                  <div className="mt-0.5 mono text-[11px] truncate" style={{ color: 'var(--faint)' }}>{fmtNum(tot.completionTokens)}</div>
                </div>

                <div className="wb-inset px-3.5 py-3">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('缓存命中率', 'Cache hit rate')}</div>
                  <div className="mt-1 text-[19px] font-bold tracking-tight" style={{ color: (tot.cacheKnownCalls || 0) > 0 ? 'var(--ok)' : 'var(--text)' }}>
                    {(tot.cacheKnownCalls || 0) > 0 && typeof tot.cacheHitRate === 'number'
                      ? `${(tot.cacheHitRate * 100).toFixed(1)}%`
                      : '—'}
                  </div>
                  <div className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--faint)' }}>
                    {t('上游回报口径', 'Upstream reported')}
                  </div>
                </div>

                <div className="wb-inset px-3.5 py-3">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('平均耗时', 'Avg latency')}</div>
                  <div className="mt-1 text-[19px] font-bold tracking-tight">
                    {tot.calls > 0 ? `${Math.round(tot.ms / tot.calls)} ms` : '—'}
                  </div>
                  <div className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--faint)' }}>
                    {hasSearchMetric && (tot.searches || 0) > 0
                      ? t(`搜索 ${tot.searches} 次`, `Search ${tot.searches}`)
                      : t('成功调用均值', 'Avg of successes')}
                  </div>
                </div>

                <div className="wb-inset px-3.5 py-3">
                  <div className="text-[11px] font-medium" style={{ color: 'var(--muted)' }}>{t('消耗积分', 'Credit spent')}</div>
                  <div className="mt-1 text-[19px] font-bold tracking-tight" style={{ color: 'var(--warn)' }}>
                    {fmtCredit(tot.credit, tot.creditCalls)}
                  </div>
                  <div className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--faint)' }}>
                    {tot.creditCalls > 0
                      ? t(`已回报 ${tot.creditCalls}/${tot.calls}`, `Reported ${tot.creditCalls}/${tot.calls}`)
                      : t('上游未回报', 'Not reported')}
                    {(tot.failed || 0) > 0 && (
                      <span className="ml-1 font-semibold" style={{ color: 'var(--fail)' }}>
                        · {t(`失败 ${tot.failed}`, `${tot.failed} fail`)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Flagship Interactive Trend Canvas ── */}
            <div className="wb-inset p-4 sm:p-5 space-y-3.5">
              {/* Chart Control Bar: Segmented Metric Switch + Segmented Range Switch + Insights */}
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold mr-1" style={{ color: 'var(--text)' }}>
                    <TrendingUp className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
                    {t('消耗趋势', 'Consumption trend')}
                  </span>

                  {/* Smooth Sliding Segmented Metric Switch */}
                  <SegmentedControl
                    value={metric}
                    ariaLabel={t('指标切换', 'Metric selector')}
                    onChange={(v) => setMetric(v as Metric)}
                    options={[
                      { value: 'calls', label: t('调用', 'Calls') },
                      { value: 'tokens', label: 'Tokens' },
                      { value: 'credit', label: t('积分', 'Credit') },
                    ]}
                  />
                </div>

                {/* Smooth Sliding Segmented Time Range Switch */}
                <SegmentedControl
                  value={activeRangeKey}
                  ariaLabel={t('时间范围', 'Time range')}
                  mono
                  onChange={(v) => selectRangePreset(v as '24h' | '1d' | '7d' | '30d' | '12w')}
                  options={[
                    { value: '24h', label: '24H' },
                    { value: '1d', label: '1D' },
                    { value: '7d', label: '7D' },
                    { value: '30d', label: '30D' },
                    { value: '12w', label: '12W' },
                  ]}
                />
              </div>

              {/* Insight Callout Strip + Series Legend */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px]" style={{ color: 'var(--muted)' }}>
                {insights && insights.total > 0 ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span>
                      {t('峰值', 'Peak')}{' '}
                      <strong className="mono" style={{ color: 'var(--text)' }}>
                        {fmtMetricVal(insights.peak.val)}
                      </strong>{' '}
                      <span className="mono" style={{ color: 'var(--faint)' }}>({insights.peak.label})</span>
                    </span>
                    <span>
                      {t('活跃均值', 'Active avg')}{' '}
                      <strong className="mono" style={{ color: 'var(--text)' }}>
                        {fmtMetricVal(insights.avg)}
                      </strong>
                    </span>
                    <span>
                      {t('窗口合计', 'Window total')}{' '}
                      <strong className="mono" style={{ color: 'var(--text)' }}>
                        {fmtMetricVal(insights.total)}
                      </strong>
                    </span>
                  </div>
                ) : (
                  <span />
                )}

                {chartSpec.series.length >= 2 && (
                  <div className="flex flex-wrap items-center gap-3">
                    {chartSpec.series.map((s) => (
                      <span key={s.name} className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block h-2 w-2.5 rounded-xs"
                          style={{
                            background: s.dashed ? 'transparent' : s.color,
                            borderTop: s.dashed ? `2px dashed ${s.color}` : 'none',
                          }}
                        />
                        <span>{s.name}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* SVG Chart Body */}
              {buckets.length === 0 || chartSpec.maxVal <= 0 ? (
                <div className="py-10 text-center text-[12.5px]" style={{ color: 'var(--muted)' }}>
                  {t('这段时间没有调用。', 'No calls in this period.')}
                </div>
              ) : buckets.length === 1 ? (
                <div className="py-10 text-center text-[12.5px]" style={{ color: 'var(--muted)' }}>
                  {t('这段时间只有 1 个时间点，换个粒度能看到更多。', 'Only one data point in this period — try a different granularity.')}
                </div>
              ) : (
                <div className="relative" onMouseLeave={() => setHoverIdx(null)}>
                  <svg
                    viewBox={`0 0 ${W} ${H}`}
                    className="w-full h-auto block overflow-visible"
                    role="img"
                    aria-label={t('用量图表', 'Usage chart')}
                  >
                    <defs>
                      {chartSpec.series.map((s, si) => (
                        <linearGradient key={s.name} id={`wb-area-${si}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={s.color} stopOpacity="0.14" />
                          <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                        </linearGradient>
                      ))}
                    </defs>

                    {/* Horizontal Grid Lines + Y Labels */}
                    {[0, 0.33, 0.66, 1].map((ratio, gi) => {
                      const y = PAD.top + plotH * (1 - ratio);
                      const val = chartSpec.maxVal * ratio;
                      return (
                        <g key={gi}>
                          <line
                            x1={PAD.left}
                            y1={y}
                            x2={W - PAD.right}
                            y2={y}
                            stroke="var(--border)"
                            strokeDasharray={ratio === 0 ? undefined : '2 4'}
                            strokeWidth="1"
                          />
                          <text
                            x={PAD.left - 8}
                            y={y + 3.5}
                            textAnchor="end"
                            fill="var(--faint)"
                            fontSize="10"
                            fontFamily="var(--font-mono)"
                          >
                            {fmtAxis(val)}
                          </text>
                        </g>
                      );
                    })}

                    {/* Hover Column Spotlight & Crosshair */}
                    {hoverIdx !== null && buckets.length > 0 && (() => {
                      const colW = plotW / buckets.length;
                      const cx =
                        chartSpec.mode === 'line'
                          ? PAD.left + (hoverIdx / Math.max(1, buckets.length - 1)) * plotW
                          : PAD.left + hoverIdx * colW + colW / 2;
                      return (
                        <g>
                          {chartSpec.mode !== 'line' && (
                            <rect
                              x={PAD.left + hoverIdx * colW + 1}
                              y={PAD.top}
                              width={Math.max(4, colW - 2)}
                              height={plotH}
                              rx="6"
                              fill="var(--surface-hover)"
                              opacity="0.65"
                            />
                          )}
                          <line
                            x1={cx}
                            y1={PAD.top}
                            x2={cx}
                            y2={PAD.top + plotH}
                            stroke="var(--primary)"
                            strokeWidth="1"
                            strokeOpacity="0.55"
                            strokeDasharray="3 3"
                          />
                        </g>
                      );
                    })()}

                    {/* Bars / Stacked Bars */}
                    {(chartSpec.mode === 'bar' || chartSpec.mode === 'stackBar') && (() => {
                      const colW = plotW / buckets.length;
                      const barW = Math.max(5, Math.min(26, colW * 0.56));
                      const barSeries = chartSpec.series.filter((s) => !s.dashed);
                      return buckets.map((_, bi) => {
                        const x = PAD.left + bi * colW + (colW - barW) / 2;
                        let stackY = PAD.top + plotH;
                        const activeBar = hoverIdx === null || hoverIdx === bi;
                        return (
                          <g key={bi}>
                            {barSeries.map((s, si) => {
                              const v = s.values[bi] || 0;
                              const h = chartSpec.maxVal > 0 ? (v / chartSpec.maxVal) * plotH : 0;
                              const y = stackY - h;
                              stackY = y;
                              const isTop = si === barSeries.length - 1;
                              return h > 0 ? (
                                <rect
                                  key={s.name}
                                  x={x}
                                  y={y}
                                  width={barW}
                                  height={Math.max(1.5, h)}
                                  rx={isTop ? Math.min(4.5, barW / 2) : 1}
                                  fill={s.color}
                                  opacity={activeBar ? 0.94 : 0.36}
                                  style={{ transition: 'opacity 140ms ease' }}
                                />
                              ) : null;
                            })}
                          </g>
                        );
                      });
                    })()}

                    {/* Smooth Bezier Curves + Glowing Area Fill */}
                    {chartSpec.series.map((s, si) => {
                      if (chartSpec.mode !== 'line' && !s.dashed) return null;
                      const colW = plotW / buckets.length;
                      const pts = s.values.map((v, bi) => {
                        const x =
                          chartSpec.mode === 'line'
                            ? PAD.left + (bi / Math.max(1, buckets.length - 1)) * plotW
                            : PAD.left + bi * colW + colW / 2;
                        const y = PAD.top + plotH - (chartSpec.maxVal > 0 ? (v / chartSpec.maxVal) * plotH : 0);
                        return { x, y, v };
                      });
                      const lineD = buildSmoothPath(pts, PAD.top, PAD.top + plotH);
                      const areaD =
                        !s.dashed && pts.length > 1
                          ? `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)} L${pts[0].x.toFixed(1)},${(PAD.top + plotH).toFixed(1)} Z`
                          : '';
                      return (
                        <g key={s.name}>
                          {areaD && <path d={areaD} fill={`url(#wb-area-${si})`} />}
                          <path
                            d={lineD}
                            fill="none"
                            stroke={s.color}
                            strokeWidth={s.dashed ? 1.6 : 2.1}
                            strokeDasharray={s.dashed ? '5 4' : undefined}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          {pts.map((p, bi) => {
                            const isHot = hoverIdx === bi;
                            if (!isHot && pts.length > 18) return null;
                            return (
                              <circle
                                key={bi}
                                cx={p.x}
                                cy={p.y}
                                r={isHot ? 4.2 : 2.5}
                                fill={s.color}
                                stroke="var(--surface)"
                                strokeWidth="1.75"
                              />
                            );
                          })}
                        </g>
                      );
                    })}

                    {/* X Axis Labels */}
                    {bucketLabels.map((lbl, bi) => {
                      const show = bi % xStep === 0 || bi === bucketLabels.length - 1;
                      if (!show) return null;
                      const colW = plotW / buckets.length;
                      const x =
                        chartSpec.mode === 'line'
                          ? PAD.left + (bi / Math.max(1, buckets.length - 1)) * plotW
                          : PAD.left + bi * colW + colW / 2;
                      return (
                        <text
                          key={bi}
                          x={x}
                          y={H - 8}
                          textAnchor="middle"
                          fill={hoverIdx === bi ? 'var(--text)' : 'var(--faint)'}
                          fontWeight={hoverIdx === bi ? 600 : 400}
                          fontSize="10"
                          fontFamily="var(--font-mono)"
                        >
                          {lbl}
                        </text>
                      );
                    })}

                    {/* Invisible hover hit targets */}
                    {buckets.map((_, bi) => {
                      const colW = plotW / buckets.length;
                      return (
                        <rect
                          key={bi}
                          x={PAD.left + bi * colW}
                          y={PAD.top}
                          width={colW}
                          height={plotH}
                          fill="transparent"
                          onMouseEnter={() => setHoverIdx(bi)}
                        />
                      );
                    })}
                  </svg>

                  {/* Cursor-Anchored Floating Frosted-Glass Tooltip */}
                  {hoverIdx !== null && buckets[hoverIdx] && (() => {
                    const pctX = buckets.length > 1 ? (hoverIdx / (buckets.length - 1)) * 100 : 50;
                    const flipLeft = pctX > 56;
                    return (
                      <div
                        className="wb-popover wb-pop-in pointer-events-none absolute top-2 rounded-xl px-3.5 py-2.5 text-[11.5px] space-y-1.5 min-w-[172px]"
                        style={{
                          zIndex: 12,
                          left: flipLeft ? undefined : `min(calc(${pctX.toFixed(1)}% + 14px), calc(100% - 190px))`,
                          right: flipLeft ? `min(calc(${(100 - pctX).toFixed(1)}% + 14px), calc(100% - 190px))` : undefined,
                        }}
                      >
                        <div className="flex items-center justify-between gap-3 pb-1" style={{ borderBottom: '1px solid var(--border)' }}>
                          <span className="font-semibold mono" style={{ color: 'var(--text)' }}>
                            {bucketLabels[hoverIdx]}
                          </span>
                          <span className="mono text-[10.5px]" style={{ color: 'var(--faint)' }}>
                            {buckets[hoverIdx].calls || 0} {t('次', 'req')}
                          </span>
                        </div>
                        <div className="space-y-1">
                          {chartSpec.series.map((s) => (
                            <div key={s.name} className="flex items-center justify-between gap-4">
                              <span className="inline-flex items-center gap-1.5 truncate" style={{ color: 'var(--muted)' }}>
                                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color }} />
                                <span className="truncate">{s.name}</span>
                              </span>
                              <span className="mono font-semibold shrink-0" style={{ color: 'var(--text)' }}>
                                {fmtTipVal(s.values[hoverIdx] || 0)}
                              </span>
                            </div>
                          ))}
                        </div>
                        {hoveredModels.length > 0 && kind !== 'bymodel' && (
                          <div className="pt-1.5 space-y-0.5" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
                              {t('主要模型', 'Top models')}
                            </div>
                            {hoveredModels.map((hm) => (
                              <div key={hm.model} className="flex items-center justify-between gap-3 text-[11px]">
                                <span className="mono truncate max-w-[115px]" style={{ color: 'var(--text-secondary)' }}>
                                  {hm.model}
                                </span>
                                <span className="mono font-medium" style={{ color: 'var(--muted)' }}>
                                  {fmtTipVal(hm.val)}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* ── 3-Column Deep Analytics Bento: Token Mix Donut + Request Health + Credit Ranking ── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Module 1: Token Mix Donut Ring (4 cols) */}
              <div className="lg:col-span-4 wb-inset p-4 flex flex-col justify-between gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                    <PieChart className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
                    {t('Token 构成', 'Token composition')}
                  </span>
                  {tokenMix && tokenMix.cached > 0 && tokenMix.prompt > 0 && (
                    <span className="wb-tag wb-tag-ok">
                      {t('缓存省', 'Cache')} {Math.round((tokenMix.cached / tokenMix.prompt) * 100)}%
                    </span>
                  )}
                </div>

                {!tokenMix || tokenMix.sum === 0 ? (
                  <div className="py-6 text-center text-[12px]" style={{ color: 'var(--muted)' }}>
                    {t('暂无 Token 统计数据', 'No token data yet')}
                  </div>
                ) : (
                  <div className="flex items-center gap-4">
                    {/* Crisp SVG Donut */}
                    <div className="relative shrink-0">
                      <svg width="114" height="114" viewBox="0 0 114 114" aria-hidden="true">
                        <circle cx="57" cy="57" r="44" fill="none" stroke="var(--surface-muted)" strokeWidth="11" />
                        {(() => {
                          const r = 44;
                          const circ = 2 * Math.PI * r;
                          let offset = 0;
                          return tokenMix.segments.map((seg) => {
                            const frac = seg.value / tokenMix.sum;
                            const dash = Math.max(2, frac * circ - 2);
                            const curOff = offset;
                            offset += frac * circ;
                            const active = donutHover === null || donutHover === seg.id;
                            return (
                              <circle
                                key={seg.id}
                                cx="57"
                                cy="57"
                                r={r}
                                fill="none"
                                stroke={seg.color}
                                strokeWidth={donutHover === seg.id ? 13 : 11}
                                strokeLinecap="butt"
                                strokeDasharray={`${dash} ${circ}`}
                                strokeDashoffset={-curOff}
                                transform="rotate(-90 57 57)"
                                opacity={active ? 1 : 0.32}
                                style={{ transition: 'opacity 150ms ease, stroke-width 150ms ease', cursor: 'pointer' }}
                                onMouseEnter={() => setDonutHover(seg.id)}
                                onMouseLeave={() => setDonutHover(null)}
                              />
                            );
                          });
                        })()}
                      </svg>
                      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                        <span className="mono text-[15px] font-bold tracking-tight" style={{ color: 'var(--text)' }}>
                          {fmtCompact(tokenMix.sum)}
                        </span>
                        <span className="text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--faint)' }}>
                          TOTAL
                        </span>
                      </div>
                    </div>

                    {/* Interactive Breakdown Legend */}
                    <div className="flex-1 min-w-0 space-y-2">
                      {tokenMix.segments.map((seg) => {
                        const pct = tokenMix.sum > 0 ? Math.round((seg.value / tokenMix.sum) * 100) : 0;
                        return (
                          <div
                            key={seg.id}
                            onMouseEnter={() => setDonutHover(seg.id)}
                            onMouseLeave={() => setDonutHover(null)}
                            className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[11.5px] transition-colors cursor-default"
                            style={{ background: donutHover === seg.id ? 'var(--surface-hover)' : 'transparent' }}
                          >
                            <span className="inline-flex items-center gap-1.5 min-w-0">
                              <span className="h-2 w-2 rounded-full shrink-0" style={{ background: seg.color }} />
                              <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{seg.label}</span>
                            </span>
                            <span className="mono shrink-0 font-semibold" style={{ color: 'var(--text)' }}>
                              {pct}%
                              <span className="ml-1 font-normal" style={{ color: 'var(--faint)' }}>
                                ({fmtCompact(seg.value)})
                              </span>
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Module 2: Request Health & Efficiency (4 cols) */}
              <div className="lg:col-span-4 wb-inset p-4 flex flex-col justify-between gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                    <Activity className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
                    {t('请求健康度与效率', 'Health & Efficiency')}
                  </span>
                  {health && (
                    <span
                      className={`mono text-[12px] font-bold`}
                      style={{ color: health.successRate >= 98 ? 'var(--ok)' : health.successRate >= 90 ? 'var(--warn)' : 'var(--fail)' }}
                    >
                      {health.successRate.toFixed(1)}%
                    </span>
                  )}
                </div>

                {health && (
                  <div className="space-y-3">
                    {/* Visual Success vs Failure Ratio Bar */}
                    <div className="space-y-1.5">
                      <div className="h-2 w-full overflow-hidden rounded-full flex" style={{ background: 'var(--surface-muted)' }}>
                        <div
                          className="h-full transition-all duration-500"
                          style={{ width: `${health.successRate}%`, background: 'var(--ok-dot)' }}
                        />
                        {health.failCalls > 0 && (
                          <div
                            className="h-full transition-all duration-500"
                            style={{ width: `${Math.max(1.5, 100 - health.successRate)}%`, background: 'var(--fail-dot)' }}
                          />
                        )}
                      </div>
                      <div className="flex items-center justify-between text-[11px] mono" style={{ color: 'var(--faint)' }}>
                        <span>{t('成功', 'OK')} {fmtNum(health.okCalls)}</span>
                        <span style={{ color: health.failCalls > 0 ? 'var(--fail)' : 'var(--faint)' }}>
                          {t('失败', 'Fail')} {fmtNum(health.failCalls)}
                        </span>
                      </div>
                    </div>

                    {/* 2x2 Micro Efficiency Grid */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface)', border: '1px solid var(--border-subtle)' }}>
                        <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>{t('单次均耗', 'Tokens / call')}</div>
                        <div className="mono mt-0.5 text-[13.5px] font-semibold" style={{ color: 'var(--text)' }}>
                          {health.tokPerCall != null ? fmtCompact(health.tokPerCall) : '—'}
                        </div>
                      </div>
                      <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface)', border: '1px solid var(--border-subtle)' }}>
                        <div className="text-[10.5px]" style={{ color: 'var(--faint)' }}>{t('单次积分', 'Credit / call')}</div>
                        <div className="mono mt-0.5 text-[13.5px] font-semibold" style={{ color: 'var(--text)' }}>
                          {health.creditPerCall != null ? health.creditPerCall : '—'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Module 3: Credit Ranking by Model (4 cols) */}
              <div className="lg:col-span-4 wb-inset p-4 flex flex-col">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <span className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>
                    {t('积分排行（按模型）', 'Credit ranking (by model)')}
                  </span>
                  {ranking.totalCredit > 0 && (
                    <span className="mono text-[11px]" style={{ color: 'var(--faint)' }}>
                      Σ {Number(ranking.totalCredit.toFixed(2))}
                    </span>
                  )}
                </div>

                {ranking.top8.length === 0 ? (
                  <div className="text-[12px] py-4" style={{ color: 'var(--muted)' }}>
                    {t('暂无积分消耗数据。', 'No reported credit spending yet.')}
                  </div>
                ) : (
                  <div className="space-y-2 flex-1">
                    {ranking.top8.map((m, idx) => {
                      const pct = ranking.totalCredit > 0 ? Math.max(2, (m.credit / ranking.totalCredit) * 100) : 0;
                      const sharePct = ranking.totalCredit > 0 ? Math.round((m.credit / ranking.totalCredit) * 100) : 0;
                      const active = reqModelFilter === m.model;
                      return (
                        <button
                          key={m.model}
                          type="button"
                          onClick={() => handleFilterModel(m.model)}
                          title={t('点击筛选「最近请求」', 'Click to filter Recent requests')}
                          className="w-full text-left group cursor-pointer rounded-lg px-2 py-1.5 -mx-2 transition-colors"
                          style={{ background: active ? 'var(--primary-soft)' : 'transparent' }}
                        >
                          <div className="flex items-center justify-between gap-2 text-[11.5px]">
                            <span className="inline-flex items-center gap-1.5 min-w-0">
                              <span className="mono text-[10px] w-4 shrink-0" style={{ color: 'var(--faint)' }}>
                                {String(idx + 1).padStart(2, '0')}
                              </span>
                              <span className="mono font-medium truncate" style={{ color: active ? 'var(--primary-text)' : 'var(--text)' }}>
                                {m.model}
                              </span>
                            </span>
                            <span className="mono shrink-0" style={{ color: 'var(--muted)' }}>
                              {Number(m.credit.toFixed(2))}
                              <span className="ml-1 text-[10.5px]" style={{ color: 'var(--faint)' }}>
                                ({sharePct}%)
                              </span>
                            </span>
                          </div>
                          <div className="mt-1 h-[4px] w-full rounded-full overflow-hidden" style={{ background: 'var(--surface-muted)' }}>
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{ width: `${pct}%`, background: getColor(m.model) }}
                            />
                          </div>
                        </button>
                      );
                    })}
                    {ranking.restCount > 0 && (
                      <div className="pt-1 text-[11px] flex justify-between" style={{ color: 'var(--muted)' }}>
                        <span>{t(`其它（${ranking.restCount} 个）`, `Others (${ranking.restCount})`)}</span>
                        <span className="mono">{Number(ranking.restCredit.toFixed(2))} ({ranking.restCalls})</span>
                      </div>
                    )}
                  </div>
                )}

                {ranking.unreported.length > 0 && (
                  <div className="mt-2.5 pt-2 text-[11px]" style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--faint)' }}>
                    {t(
                      `未回报扣分：${ranking.unreported.map((x) => x.model).join('、')}`,
                      `Unreported: ${ranking.unreported.map((x) => x.model).join(', ')}`,
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Per-Model Breakdown Table */}
            {(data?.models?.length || 0) > 0 && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text)' }}>
                    {t('按模型明细', 'Per-model details')}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--faint)' }}>
                    {t('点击任意行可联动筛选「最近请求」', 'Click any row to filter Recent requests')}
                  </span>
                </div>
                <div className="wb-table-wrap tablewrap">
                  <table className="wb-table">
                    <thead>
                      <tr>
                        <th>{t('模型', 'Model')}</th>
                        <th className="num">{t('次数', 'Calls')}</th>
                        <th className="num">{t('输入', 'Input')}</th>
                        <th className="num">{t('输出', 'Output')}</th>
                        <th className="num">{t('积分', 'Credit')}</th>
                        <th className="num">{t('积分/次', 'Credit / call')}</th>
                        <th className="num">{t('总耗时', 'Total time')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.models.map((m) => {
                        const active = reqModelFilter === m.model;
                        return (
                          <tr
                            key={m.model}
                            onClick={() => handleFilterModel(m.model)}
                            title={t('点击筛选「最近请求」', 'Click to filter Recent requests')}
                            className={`pickrow cursor-pointer ${active ? 'rowactive' : ''}`}
                            style={{ background: active ? 'var(--primary-soft)' : undefined }}
                          >
                            <td className="mono font-semibold" style={{ color: active ? 'var(--primary-text)' : 'var(--text)' }}>
                              <span className="inline-flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: getColor(m.model) }} />
                                {m.model}
                              </span>
                            </td>
                            <td className="num">{fmtNum(m.calls)}</td>
                            <td className="num">{fmtNum(m.promptTokens)}</td>
                            <td className="num">{fmtNum(m.completionTokens)}</td>
                            <td
                              className="num"
                              title={m.creditCalls === 0 ? t('上游未回报该模型的扣分', 'Upstream reported no credit for this model') : ''}
                            >
                              {fmtCredit(m.credit, m.creditCalls)}
                            </td>
                            <td className="num">
                              {m.creditCalls > 0 ? Number((m.credit / m.creditCalls).toFixed(4)) : '—'}
                            </td>
                            <td className="num">{fmtNum(m.ms)} ms</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
};
