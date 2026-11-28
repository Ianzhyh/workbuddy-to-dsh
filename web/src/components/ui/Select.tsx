import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { useNativeInputSync } from '../../lib/useDomSync';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface CustomSelectProps {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  className?: string;
  menuMinWidth?: number;
}

/**
 * Frosted-glass dropdown select menu
 * that keeps a real native `<select>` in the DOM for 100% test & form parity
 * while presenting a crisp floating listbox with smooth animation, checkmark
 * active state, auto flip-up positioning, and full keyboard navigation.
 */
export const Select: React.FC<CustomSelectProps> = ({
  id,
  value,
  options,
  onChange,
  disabled = false,
  title,
  ariaLabel,
  size = 'sm',
  className = '',
  menuMinWidth = 156,
}) => {
  const [open, setOpen] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number; flipUp: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const openMenu = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setRendered(true);
    setOpen(true);
  };

  const closeMenu = () => {
    if (!open) return;
    setOpen(false);
    setClosing(true);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, 150);
  };

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  const nativeSyncRef = useNativeInputSync<HTMLSelectElement>((el) => {
    onChange(el.value);
  });

  const selectedOpt = options.find((o) => o.value === value) || options[0];

  const updatePosition = () => {
    const trig = triggerRef.current;
    if (!trig) return;
    const rect = trig.getBoundingClientRect();
    const menuEstH = Math.min(280, options.length * 34 + 14);
    const spaceBelow = window.innerHeight - rect.bottom - 10;
    const flipUp = spaceBelow < menuEstH && rect.top > spaceBelow;
    const w = Math.max(rect.width, menuMinWidth);
    const maxLeft = Math.max(8, window.innerWidth - w - 8);
    const left = Math.min(rect.left, maxLeft);
    const top = flipUp ? Math.max(8, rect.top - 6) : rect.bottom + 6;
    setCoords({ top, left, width: w, flipUp });
  };

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const curIdx = Math.max(0, options.findIndex((o) => o.value === value));
    setHighlightIdx(curIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, options.length, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onScrollOrResize = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIdx((i) => (options.length ? (i + 1) % options.length : 0));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIdx((i) => (options.length ? (i - 1 + options.length) % options.length : 0));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setHighlightIdx(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setHighlightIdx(Math.max(0, options.length - 1));
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const opt = options[highlightIdx];
        if (opt) {
          onChange(opt.value);
          closeMenu();
          triggerRef.current?.focus();
        }
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIdx, onChange, open, options]);

  const hClass = size === 'sm' ? 'h-[28px] text-[12px] px-2.5 rounded-[8px]' : 'h-[32px] text-[12.5px] px-3 rounded-[9px]';

  return (
    <span className={`dd relative inline-flex items-center ${className}`}>
      {/* Native <select> preserved silently for tests, forms & value parity */}
      <select
        ref={nativeSyncRef}
        id={id}
        value={value}
        disabled={disabled}
        title={title}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => onChange(e.target.value)}
        className="dd-native sr-only"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Precision Custom Trigger */}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={ariaLabel || title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && (open ? closeMenu() : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openMenu();
          }
        }}
        className={`dd-trigger inline-flex w-full items-center justify-between gap-2 font-medium transition-all cursor-pointer select-none ${hClass}`}
        style={{
          background: open ? 'var(--surface)' : 'var(--surface-subtle)',
          border: `1px solid ${open ? 'var(--primary)' : 'var(--border)'}`,
          color: 'var(--text)',
          boxShadow: open ? 'var(--ring)' : 'var(--shadow-xs)',
          opacity: disabled ? 0.45 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span className="dd-label truncate">{selectedOpt?.label ?? value}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          style={{ color: open ? 'var(--primary-text)' : 'var(--muted)' }}
        />
      </button>

      {/* Floating Frosted-Glass Listbox Portal with Enter + Exit Animation */}
      {rendered && coords && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          className={`dd-menu wb-popover fixed rounded-xl p-1 overflow-y-auto ${closing ? 'wb-pop-out pointer-events-none' : 'wb-pop-in'}`}
          style={{
            zIndex: 'var(--z-dropdown)',
            left: coords.left,
            top: coords.top,
            minWidth: coords.width,
            maxWidth: Math.min(340, window.innerWidth - 16),
            maxHeight: 280,
            transform: coords.flipUp ? 'translateY(-100%)' : undefined,
          }}
        >
          {options.map((opt, idx) => {
            const isSel = opt.value === value;
            const isHi = idx === highlightIdx;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSel}
                onMouseEnter={() => setHighlightIdx(idx)}
                onClick={() => {
                  onChange(opt.value);
                  closeMenu();
                  triggerRef.current?.focus();
                }}
                className={`dd-item flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-colors cursor-pointer ${isSel ? 'on' : ''}`}
                style={{
                  background: isSel
                    ? 'var(--primary-soft)'
                    : isHi
                      ? 'var(--surface-hover)'
                      : 'transparent',
                  color: isSel ? 'var(--primary-text)' : 'var(--text)',
                  fontWeight: isSel ? 600 : 400,
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{opt.label}</span>
                  {opt.description && (
                    <span className="block truncate text-[11px]" style={{ color: 'var(--muted)' }}>
                      {opt.description}
                    </span>
                  )}
                </span>
                <Check
                  className="h-3.5 w-3.5 shrink-0 transition-opacity"
                  style={{ opacity: isSel ? 1 : 0, color: 'var(--primary-text)' }}
                />
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </span>
  );
};
