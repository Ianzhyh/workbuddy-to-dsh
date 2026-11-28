import React, { useEffect, useState } from 'react';

interface CollapseProps {
  open: boolean;
  /** Optional delay in ms before unmounting children after collapse (default 280ms). Set false to keep mounted. */
  unmountOnExit?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * Smooth height + opacity collapse/expand transition using CSS Grid
 * `grid-template-rows: 0fr <-> 1fr` interpolation (zero JS height measurement jitter).
 */
export const Collapse: React.FC<CollapseProps> = ({
  open,
  unmountOnExit = false,
  className = '',
  children,
}) => {
  const [rendered, setRendered] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      setRendered(true);
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setExpanded(false);
    if (!unmountOnExit) return undefined;
    const id = window.setTimeout(() => setRendered(false), 290);
    return () => clearTimeout(id);
  }, [open, unmountOnExit]);

  if (unmountOnExit && !rendered) return null;

  return (
    <div
      className={`wb-collapse ${expanded ? 'open' : ''} ${className}`}
      aria-hidden={!open}
    >
      <div className="wb-collapse-inner">
        {children}
      </div>
    </div>
  );
};
