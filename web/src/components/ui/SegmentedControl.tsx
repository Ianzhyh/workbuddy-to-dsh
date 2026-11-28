import React, { useLayoutEffect, useRef, useState } from 'react';

export interface SegmentedOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  dataAttr?: Record<string, string>;
  buttonClassName?: string;
}

interface SegmentedControlProps<T extends string = string> {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  mono?: boolean;
  className?: string;
}

/**
 * Precision Segmented Control with a live sliding thumb pill
 * driven by measured offsetLeft/offsetWidth and spring cubic-bezier interpolation.
 */
export function SegmentedControl<T extends string = string>({
  value,
  options,
  onChange,
  ariaLabel,
  mono = false,
  className = '',
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const btnRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [thumb, setThumb] = useState<{ left: number; width: number; ready: boolean }>({
    left: 0,
    width: 0,
    ready: false,
  });
  const animatedRef = useRef(false);

  const measure = () => {
    const activeBtn = btnRefs.current.get(value);
    if (!activeBtn) return;
    const left = activeBtn.offsetLeft;
    const width = activeBtn.offsetWidth;
    if (width > 0) {
      setThumb({ left, width, ready: true });
      if (!animatedRef.current) {
        requestAnimationFrame(() => {
          animatedRef.current = true;
        });
      }
    }
  };

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options.length]);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div
      ref={trackRef}
      role="group"
      aria-label={ariaLabel}
      className={`wb-segmented relative ${className}`}
    >
      {/* Live Sliding Elevated Pill Thumb */}
      {thumb.ready && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[2px] bottom-[2px] left-0 rounded-[7px]"
          style={{
            width: thumb.width,
            transform: `translateX(${thumb.left}px)`,
            background: 'var(--surface-elevated)',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.16), 0 0 0 0.5px var(--border)',
            transition: animatedRef.current
              ? 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1), width 260ms cubic-bezier(0.32, 0.72, 0, 1)'
              : 'none',
          }}
        />
      )}

      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) btnRefs.current.set(opt.value, el);
              else btnRefs.current.delete(opt.value);
            }}
            type="button"
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={`wb-seg-btn relative z-[1] ${mono ? 'mono' : ''} ${active ? 'active-sliding' : ''} ${opt.buttonClassName || ''}`}
            style={{
              color: active ? 'var(--text)' : 'var(--text-secondary)',
              fontWeight: active ? 600 : 500,
              background: 'transparent',
              boxShadow: 'none',
            }}
            {...(opt.dataAttr || {})}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
