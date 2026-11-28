import React, { useEffect, useRef, useState } from 'react';
import { Collapse } from './Collapse';

interface AnimatedDetailsProps {
  id?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  style?: React.CSSProperties;
  summary: React.ReactNode;
  summaryClassName?: string;
  summaryStyle?: React.CSSProperties;
  children: React.ReactNode;
}

/**
 * Drop-in smooth-animating `<details>` disclosure drawer.
 * Native `<details>` snaps closed instantly before CSS transitions can run;
 * this keeps the DOM `[open]` attribute active during the 280ms collapse glide
 * while syncing external `el.open = true` mutations via MutationObserver for
 * full accessibility & automated test parity.
 */
export const AnimatedDetails: React.FC<AnimatedDetailsProps> = ({
  id,
  open,
  onOpenChange,
  className = '',
  style,
  summary,
  summaryClassName = '',
  summaryStyle,
  children,
}) => {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [domOpen, setDomOpen] = useState(open);
  const [expanded, setExpanded] = useState(open);
  const timerRef = useRef<number | null>(null);
  const internalMutRef = useRef(false);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (open) {
      internalMutRef.current = true;
      setDomOpen(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        internalMutRef.current = false;
        raf2 = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setExpanded(false);
    timerRef.current = window.setTimeout(() => {
      internalMutRef.current = true;
      setDomOpen(false);
      requestAnimationFrame(() => {
        internalMutRef.current = false;
      });
    }, 285);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [open]);

  // Observe external programmatic `details.open = true/false` mutations
  useEffect(() => {
    const el = detailsRef.current;
    if (!el || typeof MutationObserver === 'undefined') return undefined;
    const obs = new MutationObserver(() => {
      if (internalMutRef.current) return;
      const next = el.hasAttribute('open');
      if (next !== open) onOpenChange(next);
    });
    obs.observe(el, { attributes: true, attributeFilter: ['open'] });
    return () => obs.disconnect();
  }, [onOpenChange, open]);

  return (
    <details
      ref={detailsRef}
      id={id}
      open={domOpen}
      className={className}
      style={style}
    >
      <summary
        onClick={(e) => {
          e.preventDefault();
          onOpenChange(!open);
        }}
        className={`wb-summary list-none [&::-webkit-details-marker]:hidden ${summaryClassName}`}
        style={summaryStyle}
      >
        {summary}
      </summary>
      <Collapse open={expanded}>
        {children}
      </Collapse>
    </details>
  );
};
