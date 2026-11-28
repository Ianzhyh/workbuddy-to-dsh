import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import type { ToastMessage } from '../../context/ConsoleContext';

interface FloatingToastProps {
  message: ToastMessage;
}

/**
 * Floating HUD capsule toast with smooth spring enter and
 * graceful slide-down fade exit (never pops abruptly out of existence).
 */
export const FloatingToast: React.FC<FloatingToastProps> = ({ message }) => {
  const [displayMsg, setDisplayMsg] = useState<ToastMessage>(message);
  const [phase, setPhase] = useState<'hidden' | 'in' | 'out'>('hidden');
  const hideTimerRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);

  const dismiss = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setPhase('out');
    if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current);
    unmountTimerRef.current = window.setTimeout(() => setPhase('hidden'), 220);
  };

  useEffect(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current);

    if (!message.text) {
      setPhase((cur) => (cur === 'hidden' ? 'hidden' : 'out'));
      unmountTimerRef.current = window.setTimeout(() => setPhase('hidden'), 220);
      return undefined;
    }

    setDisplayMsg(message);
    setPhase('in');
    hideTimerRef.current = window.setTimeout(() => {
      setPhase('out');
      unmountTimerRef.current = window.setTimeout(() => setPhase('hidden'), 220);
    }, message.tone === 'err' ? 5200 : 3200);

    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current);
    };
  }, [message]);

  if (phase === 'hidden' || !displayMsg.text) return null;

  const tone =
    displayMsg.tone === 'good'
      ? { color: 'var(--ok-dot)', bg: 'var(--ok-soft)', icon: <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> }
      : displayMsg.tone === 'err'
        ? { color: 'var(--fail-dot)', bg: 'var(--fail-soft)', icon: <AlertCircle className="h-3.5 w-3.5 shrink-0" /> }
        : { color: 'var(--primary)', bg: 'var(--primary-soft)', icon: <Info className="h-3.5 w-3.5 shrink-0" /> };

  return (
    <div
      className={`wb-popover fixed bottom-5 left-1/2 -translate-x-1/2 sm:left-auto sm:translate-x-0 sm:right-5 flex items-center gap-2.5 rounded-full pl-2.5 pr-3 py-2 max-w-[92vw] sm:max-w-[420px] ${
        phase === 'out' ? 'wb-toast-out' : 'wb-toast-in'
      }`}
      style={{ zIndex: 'var(--z-toast)' }}
      role="status"
    >
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{ background: tone.bg, color: tone.color }}
      >
        {tone.icon}
      </span>
      <span
        className="text-[12.5px] font-medium truncate"
        style={{ color: 'var(--text)' }}
        title={displayMsg.title || displayMsg.text}
      >
        {displayMsg.text}
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full opacity-55 hover:opacity-100 transition-opacity cursor-pointer"
        style={{ color: 'var(--muted)' }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
};
