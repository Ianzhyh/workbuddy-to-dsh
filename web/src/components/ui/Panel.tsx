import React, { useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import { Collapse } from './Collapse';

interface PanelProps {
  id?: string;
  section?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  helpText?: React.ReactNode;
  icon?: React.ReactNode;
  stamp?: string;
  stampId?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export const Panel: React.FC<PanelProps> = ({
  id,
  section,
  title,
  subtitle,
  helpText,
  icon,
  stamp,
  stampId,
  actions,
  className = '',
  children,
}) => {
  const { t } = useI18n();
  const [showHelp, setShowHelp] = useState(false);

  return (
    <section
      id={id}
      data-section={section}
      className={`wb-card wb-animate-in p-5 sm:p-6 flex flex-col ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 mb-4">
        <div className="flex items-start gap-2.5 min-w-0">
          {icon && (
            <span
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
              style={{ color: 'var(--muted)' }}
            >
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-[15px] font-semibold tracking-[-0.015em] truncate" style={{ color: 'var(--text)' }}>
                {title}
              </h2>
              {helpText && (
                <button
                  type="button"
                  onClick={() => setShowHelp((v) => !v)}
                  aria-expanded={showHelp}
                  aria-label={t('展开说明', 'Toggle details')}
                  title={t('展开说明', 'Toggle details')}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors cursor-pointer"
                  style={{
                    color: showHelp ? 'var(--primary-text)' : 'var(--faint)',
                    background: showHelp ? 'var(--primary-soft)' : 'transparent',
                  }}
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {subtitle && (
              <p className="text-[12px] leading-snug mt-0.5" style={{ color: 'var(--muted)' }}>
                {subtitle}
              </p>
            )}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          {stamp && (
            <span id={stampId} className="mono text-[11px] font-medium" style={{ color: 'var(--faint)' }}>
              {stamp}
            </span>
          )}
          {actions}
        </div>
      </div>

      {helpText && (
        <Collapse open={showHelp} unmountOnExit>
          <div
            className="wb-inset mb-4 px-3.5 py-2.5 text-[12.5px] leading-relaxed"
            style={{ color: 'var(--text-secondary)' }}
          >
            {helpText}
          </div>
        </Collapse>
      )}

      {children}
    </section>
  );
};

export const SkeletonBlock: React.FC<{ lines?: number; label?: string }> = ({ lines = 3, label }) => {
  const { t } = useI18n();
  const widths = ['78%', '94%', '62%', '86%', '70%'];
  return (
    <div role="status" aria-label={label || t('正在读取…', 'Loading…')} className="space-y-2.5 py-2">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="wb-skeleton h-3.5" style={{ width: widths[i % widths.length] }} />
      ))}
    </div>
  );
};

export const EmptyState: React.FC<{ icon?: React.ReactNode; title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }> = ({
  icon,
  title,
  description,
  action,
}) => (
  <div
    className="flex flex-col items-center justify-center text-center rounded-[14px] px-5 py-8"
    style={{
      background: 'var(--surface-tint)',
      border: '1px dashed var(--border-strong)',
    }}
  >
    {icon && (
      <div className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
        {icon}
      </div>
    )}
    <div className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>{title}</div>
    {description && <div className="mt-1 text-[12px] max-w-md" style={{ color: 'var(--muted)' }}>{description}</div>}
    {action && <div className="mt-3.5">{action}</div>}
  </div>
);
