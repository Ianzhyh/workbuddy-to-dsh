import React, { useMemo } from 'react';
import { RefreshCw, Stethoscope } from 'lucide-react';
import { useConsole } from '../../context/ConsoleContext';
import { useI18n } from '../../lib/i18n';
import { Panel, SkeletonBlock } from '../ui/Panel';

const ORDER: Record<string, number> = { fail: 0, warn: 1, ok: 2 };
const MARK: Record<string, string> = { fail: '✗', warn: '!', ok: '✓' };

export const DiagnosticsPanel: React.FC = () => {
  const { diagnose, diagStamp, loadDiag } = useConsole();
  const { t, tu } = useI18n();

  const sorted = useMemo(() => {
    const items = diagnose?.items || [];
    return [...items].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  }, [diagnose?.items]);

  const summary = diagnose?.summary;

  return (
    <Panel
      section="playground"
      title={t('环境诊断', 'Environment diagnostics')}
      subtitle={t('按严重度排序：红色项不解决，模型在选择器里就不会出现', 'Ordered by priority: resolve red items so models appear in selectors')}
      icon={<Stethoscope className="h-4 w-4" />}
      stamp={diagStamp ? t(`更新于 ${diagStamp}`, `Updated ${diagStamp}`) : undefined}
      stampId="diagStamp"
      actions={
        <div className="flex items-center gap-2">
          {summary && (
            <div className="flex items-center gap-1.5">
              {summary.fail > 0 && <span className="wb-tag wb-tag-fail">✗ {summary.fail}</span>}
              {summary.warn > 0 && <span className="wb-tag wb-tag-warn">! {summary.warn}</span>}
              <span className="wb-tag wb-tag-ok">✓ {summary.ok}</span>
            </div>
          )}
          <button type="button" onClick={() => void loadDiag()} className="wb-btn wb-btn-sm">
            <RefreshCw className="h-3.5 w-3.5" />
            {t('重新诊断', 'Re-run')}
          </button>
        </div>
      }
    >
      <div id="diagList" className="space-y-2">
        {!diagnose ? (
          <SkeletonBlock lines={4} label={t('正在检测…', 'Checking…')} />
        ) : sorted.length === 0 ? (
          <div className="text-[12.5px] py-3" style={{ color: 'var(--muted)' }}>
            {t('暂无诊断项。', 'No diagnostic entries.')}
          </div>
        ) : (
          sorted.map((item) => {
            const tone =
              item.status === 'fail'
                ? { bg: 'var(--fail-soft)', border: 'var(--fail-border)', fg: 'var(--fail)' }
                : item.status === 'warn'
                  ? { bg: 'var(--warn-soft)', border: 'var(--warn-border)', fg: 'var(--warn)' }
                  : { bg: 'var(--surface-subtle)', border: 'var(--border)', fg: 'var(--ok)' };
            return (
              <div
                key={item.id + item.detail}
                className="diag-row rounded-xl px-3.5 py-2.5 flex items-start gap-3"
                style={{ background: tone.bg, border: `1px solid ${tone.border}` }}
              >
                <span
                  aria-label={item.status}
                  className={`s-dot s-${item.status} mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold`}
                  style={{
                    background: 'var(--surface)',
                    color: tone.fg,
                    border: `1px solid ${item.status === 'ok' ? 'var(--ok-border)' : tone.border}`,
                  }}
                >
                  {MARK[item.status] || '?'}
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                    <span className="label font-semibold text-[13px]" style={{ color: 'var(--text)' }}>
                      {tu(item.label)}
                    </span>
                    <span className="mono text-[12px] break-all" style={{ color: 'var(--text-secondary)' }}>
                      {tu(item.detail)}
                    </span>
                  </div>
                  {item.hint && (
                    <div className="text-[12px] leading-relaxed" style={{ color: item.status === 'ok' ? 'var(--muted)' : tone.fg }}>
                      {t('建议：', 'Hint: ')}{tu(item.hint)}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </Panel>
  );
};
