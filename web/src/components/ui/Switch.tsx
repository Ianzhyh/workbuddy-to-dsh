import React from 'react';
import { useNativeInputSync } from '../../lib/useDomSync';

interface SwitchProps {
  id?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: React.ReactNode;
  badge?: React.ReactNode;
  title?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Precision pill toggle switch backed by a real
 * `<input type="checkbox">` so accessibility, labels, and automated DOM scripts
 * all work identically.
 */
export const Switch: React.FC<SwitchProps> = ({
  id,
  checked,
  onChange,
  label,
  badge,
  title,
  disabled = false,
  className = '',
}) => {
  const syncRef = useNativeInputSync<HTMLInputElement>((el) => onChange(el.checked));

  return (
    <label
      title={title}
      className={`inline-flex items-center gap-2 text-[12px] select-none ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}
      style={{ color: 'var(--text-secondary)' }}
    >
      <span className="relative inline-flex items-center">
        <input
          ref={syncRef}
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          className="block h-[18px] w-[32px] rounded-full transition-colors duration-200 peer-focus-visible:shadow-[var(--ring)]"
          style={{
            background: checked ? 'var(--primary)' : 'var(--seg-track)',
            border: `1px solid ${checked ? 'transparent' : 'var(--border)'}`,
          }}
        />
        <span
          className="pointer-events-none absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full bg-white"
          style={{
            transform: checked ? 'translateX(14px)' : 'translateX(0)',
            transition: 'transform 220ms cubic-bezier(0.34, 1.45, 0.64, 1)',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.24), 0 0.5px 1px rgba(0, 0, 0, 0.12)',
          }}
        />
      </span>
      {label && <span className="font-medium">{label}</span>}
      {badge}
    </label>
  );
};
