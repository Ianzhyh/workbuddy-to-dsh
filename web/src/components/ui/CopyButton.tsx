import React, { useState } from 'react';
import { Check, Copy, AlertCircle } from 'lucide-react';
import { copyToClipboard } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

interface CopyButtonProps {
  text: string;
  label: string;
  ariaLabel?: string;
  buttonText?: string;
  size?: 'sm' | 'md';
  variant?: 'default' | 'ghost';
  className?: string;
  onCopied?: (ok: boolean, label: string) => void;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label,
  ariaLabel,
  buttonText,
  size = 'sm',
  variant = 'default',
  className = '',
  onCopied,
}) => {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await copyToClipboard(text);
    setState(ok ? 'ok' : 'fail');
    onCopied?.(ok, label);
    setTimeout(() => setState('idle'), 1600);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={ariaLabel || t(`复制 ${label}`, `Copy ${label}`)}
      className={`wb-btn ${size === 'sm' ? 'wb-btn-sm' : ''} ${variant === 'ghost' ? 'wb-btn-ghost' : ''} ${className}`}
      style={
        state === 'ok'
          ? { color: 'var(--ok)', borderColor: 'var(--ok-border)', background: 'var(--ok-soft)' }
          : state === 'fail'
            ? { color: 'var(--fail)', borderColor: 'var(--fail-border)', background: 'var(--fail-soft)' }
            : undefined
      }
    >
      {state === 'ok' ? (
        <Check className="h-3.5 w-3.5" />
      ) : state === 'fail' ? (
        <AlertCircle className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      <span>
        {state === 'ok'
          ? t('已复制', 'Copied')
          : state === 'fail'
            ? t('失败', 'Failed')
            : buttonText || t('复制', 'Copy')}
      </span>
    </button>
  );
};
