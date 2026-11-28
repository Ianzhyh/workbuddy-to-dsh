import React, { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, Copy, Download, Radio, RefreshCw, X } from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { copyToClipboard, downloadCsv, fmtClock, fmtDateTime, fmtDuration, fmtNum, fmtRunMs, localDateStr } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { RequestEntry } from '../../types/api';
import { EmptyState, Panel, SkeletonBlock } from '../ui/Panel';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';

export const RequestsPanel: React.FC = () => {
  const {
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
    loadRequests,
    setMsg,
  } = useConsole();
  const { en, t } = useI18n();

  const [now, setNow] = useState(() => Date.now());
  const activeReqs = requests?.active || [];
  const alertMs = requests?.activeAlertMs ?? 300_000;

  useEffect(() => {
    if (activeReqs.length === 0) return;
    const id = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [activeReqs.length]);

  const allRows = requests?.requests || [];

  const modelOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of allRows) {
      if (r.model) s.add(r.model);
    }
    if (reqModelFilter) s.add(reqModelFilter);
    return [...s].sort();
  }, [allRows, reqModelFilter]);

  const visibleRows = useMemo(
    () =>
      allRows.filter((r) => {
        if (reqModelFilter && r.model !== reqModelFilter) return false;
        if (reqFailOnly && r.ok) return false;
        return true;
      }),
    [allRows, reqFailOnly, reqModelFilter],
  );

  // Failure summary over all recent non-probe failures
  const failSummary = useMemo(() => {
    const nonProbeFails = allRows.filter((r) => !r.ok && r.probe !== true);
    if (!nonProbeFails.length) return null;
    const counts = new Map<string, number>();
    for (const r of nonProbeFails) {
      const codeStr = r.code != null && r.code !== '' ? String(r.code) : r.status ? `HTTP ${r.status}` : t('无状态码', 'no status code');
      const k = `${codeStr} · ${r.model || '—'}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const pct = allRows.length > 0 ? ((nonProbeFails.length / allRows.length) * 100).toFixed(1) : '0';
    return { count: nonProbeFails.length, pct, top };
  }, [allRows, t]);

  const handleCopyFailure = async (r: RequestEntry) => {
    const head = [
      r.status ? `HTTP ${r.status}` : t('失败', 'Failed'),
      r.code != null && r.code !== '' ? String(r.code) : '',
      r.model || '',
    ]
      .filter(Boolean)
      .join(' · ');
    const full = `${head}\n${r.error || ''}`.trim();
    const ok = await copyToClipboard(full);
    setMsg(ok ? t(`已复制错误详情：${r.model}`, `Copied error details: ${r.model}`) : t('复制失败', 'Copy failed'), ok ? 'good' : 'err', full);
  };

  const handleExportCsv = () => {
    if (!visibleRows.length) {
      setMsg(t('当前筛选下没有可导出的记录。', 'No filtered rows to export.'), 'err');
      return;
    }
    const rows: unknown[][] = [
      [
        t('时间', 'Time'),
        t('模型', 'Model'),
        t('方式', 'Mode'),
        t('耗时(ms)', 'Duration (ms)'),
        'TTFT(ms)',
        t('桥开销(ms)', 'Bridge overhead (ms)'),
        t('输入 tokens', 'Input tokens'),
        t('输出 tokens', 'Output tokens'),
        t('缓存命中 tokens', 'Cached tokens'),
        t('缓存未命中 tokens', 'Uncached tokens'),
        t('积分', 'Credit'),
        t('结果', 'Result'),
        t('失败归因', 'Failure class'),
        t('状态码', 'Status'),
        t('错误码', 'Error code'),
        t('错误原文', 'Raw error'),
      ],
    ];
    for (const r of visibleRows) {
      rows.push([
        fmtDateTime(r.t),
        r.model || '',
        r.stream ? t('流式', 'Streaming') : t('非流式', 'Non-streaming'),
        r.ms ?? '',
        r.ttfbMs ?? '',
        r.bridgeOverheadMs ?? '',
        r.promptTokens ?? '',
        r.completionTokens ?? '',
        r.cachedTokens ?? '',
        r.uncachedTokens ?? '',
        r.credit ?? '',
        r.ok ? t('成功', 'Success') : t('失败', 'Failed'),
        r.failureClass || '',
        r.status || '',
        r.code ?? '',
        r.error ? String(r.error).replace(/\s+/g, ' ').slice(0, 300) : '',
      ]);
    }
    downloadCsv(`workbuddy-requests-${localDateStr()}.csv`, rows);
    setMsg(t(`已导出 ${visibleRows.length} 条请求明细 CSV。`, `Exported ${visibleRows.length} request rows to CSV.`), 'good');
  };

  return (
    <Panel
      section="overview"
      title={t('最近请求', 'Recent requests')}
      subtitle={t('只含元数据（模型、耗时、token、结果），不含对话内容', 'Metadata only (model, latency, tokens, verdict) — no conversation content')}
      icon={<Activity className="h-4 w-4" />}
      stamp={
        reqPause
          ? t('已暂停自动刷新', 'Auto-refresh paused')
          : reqStamp
            ? t(`更新于 ${reqStamp}`, `Updated ${reqStamp}`)
            : undefined
      }
      stampId="reqStamp"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            id="reqModelFilter"
            title={t('只看某个模型的请求', 'Show requests for one model only')}
            value={reqModelFilter}
            onChange={setReqModelFilter}
            options={[
              { value: '', label: t('全部模型', 'All models') },
              ...modelOptions.map((m) => ({ value: m, label: m })),
            ]}
            className="max-w-[180px]"
            menuMinWidth={176}
          />
          <Switch
            id="reqFailOnly"
            checked={reqFailOnly}
            onChange={setReqFailOnly}
            label={t('仅看失败', 'Failures only')}
          />
          <Select
            id="reqLimit"
            title={t('显示条数', 'Rows')}
            value={String(reqLimit)}
            onChange={(v) => setReqLimit(Number(v) || 40)}
            options={[
              { value: '40', label: t('40 条', '40 rows') },
              { value: '100', label: t('100 条', '100 rows') },
              { value: '200', label: t('200 条', '200 rows') },
            ]}
            menuMinWidth={112}
          />
          <Switch
            id="reqPause"
            checked={reqPause}
            onChange={setReqPause}
            label={t('暂停刷新', 'Pause')}
            title={t('暂停后 20 秒轮询不再刷新本面板；手动「刷新」仍然可用', 'While paused, 20s polling skips this panel; manual Refresh still works')}
          />
          <button type="button" id="exportReqBtn" onClick={handleExportCsv} className="wb-btn wb-btn-sm">
            <Download className="h-3.5 w-3.5" />
            {t('导出 CSV', 'Export CSV')}
          </button>
          <button type="button" id="reqRefreshBtn" onClick={() => void loadRequests()} className="wb-btn wb-btn-sm">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('刷新', 'Refresh')}
          </button>
        </div>
      }
    >
      {/* Active Filter Chip */}
      <div id="reqFilterChip" className={reqModelFilter || reqFailOnly ? 'mb-3 flex flex-wrap items-center gap-2' : ''}>
        {(reqModelFilter || reqFailOnly) && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium"
            style={{ background: 'var(--primary-soft)', color: 'var(--primary-text)', border: '1px solid var(--primary-border)' }}
          >
            <span>
              {t('已筛选：', 'Filtered: ')}
              {reqModelFilter || t('全部模型', 'All models')}
              {reqFailOnly ? t(' · 仅失败', ' · failures only') : ''}
            </span>
            <button
              type="button"
              onClick={() => {
                setReqModelFilter('');
                setReqFailOnly(false);
              }}
              aria-label={t('清除筛选', 'Clear filter')}
              className="inline-flex items-center hover:opacity-75 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>

      {/* Live In-Flight Requests Strip */}
      {activeReqs.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {activeReqs.map((ar, idx) => {
            const elapsed = ar.startedAt ? Math.max(0, now - ar.startedAt) : (ar.runningMs || 0);
            const hot = elapsed >= alertMs;
            return (
              <div
                key={ar.id || idx}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-3.5 py-2 text-[12.5px]"
                style={{
                  background: hot ? 'var(--warn-soft)' : 'var(--info-soft)',
                  border: `1px solid ${hot ? 'var(--warn-border)' : 'var(--info-border)'}`,
                  color: hot ? 'var(--warn)' : 'var(--info)',
                }}
              >
                <span className="inline-flex items-center gap-2 font-medium">
                  <Radio className="h-3.5 w-3.5 wb-dot-pulse" />
                  <code className="font-semibold">{ar.model}</code>
                  <span className="wb-tag">{ar.stream ? t('流式', 'Streaming') : t('非流式', 'Non-streaming')}</span>
                  {hot && (
                    <span className="text-[12px]">
                      {t(`疑似卡死（超过 ${fmtDuration(alertMs, en)}）—— 桥不会主动打断`, `Possible stall (>${fmtDuration(alertMs, en)}) — bridge does not abort`)}
                    </span>
                  )}
                </span>
                <span className="mono font-semibold">{fmtRunMs(elapsed)}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Failure Summary Banner */}
      {failSummary && (
        <div
          className="mb-3 flex flex-wrap items-center gap-2 rounded-xl px-3.5 py-2.5 text-[12.5px]"
          style={{ background: 'var(--fail-soft)', border: '1px solid var(--fail-border)', color: 'var(--fail)' }}
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {en
              ? `${failSummary.count} failure(s) in recent rows (${failSummary.pct}%). Top: ${failSummary.top.map(([k, n]) => `${k} (${n})`).join(', ')}. Click a red badge to copy details.`
              : `最近记录里有 ${failSummary.count} 条失败（${failSummary.pct}%），最多：${failSummary.top.map(([k, n]) => `${k}（${n} 次）`).join('、')}。点击红色标签可复制错误详情。`}
          </span>
        </div>
      )}

      {/* Requests Table */}
      <div id="reqBox">
        {!requests ? (
          <SkeletonBlock lines={5} />
        ) : visibleRows.length === 0 ? (
          <EmptyState
            icon={<Activity className="h-5 w-5" />}
            title={
              allRows.length === 0
                ? t('还没有请求记录。', 'No requests recorded yet.')
                : reqModelFilter && !allRows.some((r) => r.model === reqModelFilter)
                  ? t(`最近 ${reqLimit} 条里没有 ${reqModelFilter} 的记录，可把条数调大到 200。`, `No rows for ${reqModelFilter} in the last ${reqLimit}; try 200 rows.`)
                  : t('当前筛选下没有记录。', 'No records under the current filter.')
            }
          />
        ) : (
          <div id="reqTableWrap" className="wb-table-wrap tablewrap max-h-[420px] overflow-y-auto">
            <table className="wb-table">
              <thead className="sticky top-0" style={{ zIndex: 5 }}>
                <tr>
                  <th>{t('时间', 'Time')}</th>
                  <th>{t('模型', 'Model')}</th>
                  <th>{t('方式', 'Mode')}</th>
                  <th className="num">{t('耗时', 'Duration')}</th>
                  <th className="num">{t('输入/输出', 'Input / output')}</th>
                  <th className="num">{t('积分', 'Credit')}</th>
                  <th>{t('结果', 'Result')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, idx) => {
                  const cachePct =
                    typeof r.cachedTokens === 'number' && (r.promptTokens || 0) > 0
                      ? Math.round((r.cachedTokens / Number(r.promptTokens)) * 100)
                      : null;
                  const latencyTip =
                    typeof r.ttfbMs === 'number'
                      ? `TTFT ${r.ttfbMs} ms${typeof r.bridgeOverheadMs === 'number' ? ` · bridge overhead ${r.bridgeOverheadMs} ms` : ''}`
                      : '';
                  return (
                    <tr
                      key={`${r.t}-${idx}`}
                      className={!r.ok ? 'rowfail' : ''}
                      style={!r.ok ? { background: 'var(--fail-soft)' } : undefined}
                    >
                      <td className="mono text-[12px]" style={{ color: 'var(--muted)' }} title={fmtDateTime(r.t)}>
                        {fmtClock(r.t)}
                      </td>
                      <td className="mono font-medium" data-i18n-skip="" style={{ color: 'var(--text)' }}>
                        {r.model || '—'}
                      </td>
                      <td>
                        <span className="wb-tag">{r.stream ? t('流式', 'Stream') : t('非流式', 'Sync')}</span>
                      </td>
                      <td className="num mono" title={latencyTip}>
                        {fmtNum(r.ms)} ms
                      </td>
                      <td
                        className="num mono"
                        title={
                          typeof r.cachedTokens === 'number'
                            ? t(`缓存命中 ${fmtNum(r.cachedTokens)} / ${fmtNum(r.promptTokens)} tokens`, `Cache hit ${fmtNum(r.cachedTokens)} / ${fmtNum(r.promptTokens)} tokens`)
                            : ''
                        }
                      >
                        {r.promptTokens != null || r.completionTokens != null ? (
                          <span>
                            {fmtNum(r.promptTokens || 0)}
                            {cachePct != null && cachePct > 0 && (
                              <span className="ml-1 text-[11px]" style={{ color: 'var(--ok)' }}>
                                ({cachePct}%)
                              </span>
                            )}{' '}
                            / {fmtNum(r.completionTokens || 0)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num mono">{r.credit != null ? Number(Number(r.credit).toFixed(4)) : '—'}</td>
                      <td>
                        {r.ok ? (
                          <span className="wb-tag wb-tag-ok">{t('成功', 'OK')}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleCopyFailure(r)}
                            title={r.error || t('点击复制错误详情', 'Click to copy error details')}
                            className="wb-tag wb-tag-fail copyfail cursor-pointer hover:opacity-85"
                          >
                            <Copy className="h-3 w-3" />
                            <span>
                              {r.status ? `HTTP ${r.status}` : t('失败', 'Fail')}
                              {r.code != null && r.code !== '' ? ` · ${r.code}` : ''}
                            </span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
};
