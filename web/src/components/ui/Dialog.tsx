import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { RequestsResponse } from '../../types/api';

interface ConfirmOptions {
  title?: string;
  danger?: boolean;
  okText?: string;
  cancelText?: string;
}

interface PromptOptions {
  placeholder?: string;
  maxLength?: number;
  okText?: string;
  cancelText?: string;
}

type ModalState =
  | { kind: 'confirm'; message: string; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; defaultValue: string; opts: PromptOptions; resolve: (v: string | null) => void }
  | null;

interface DialogContextValue {
  confirm: (message: string, opts?: ConfirmOptions) => Promise<boolean>;
  prompt: (title: string, defaultValue?: string, opts?: PromptOptions) => Promise<string | null>;
  confirmDangerous: (title: string, extraLines?: string[]) => Promise<boolean>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export const DialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useI18n();
  const [modal, setModal] = useState<ModalState>(null);
  const [closing, setClosing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const okBtnRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const finishClose = useCallback((cb: () => void) => {
    if (closing) return;
    setClosing(true);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      cb();
      setModal(null);
      setClosing(false);
    }, 160);
  }, [closing]);

  const restoreFocus = useCallback(() => {
    const el = prevFocusRef.current;
    prevFocusRef.current = null;
    if (el && typeof el.focus === 'function') {
      requestAnimationFrame(() => el.focus());
    }
  }, []);

  const confirm = useCallback((message: string, opts: ConfirmOptions = {}) => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    return new Promise<boolean>((resolve) => {
      setModal({ kind: 'confirm', message, opts, resolve });
    });
  }, []);

  const prompt = useCallback((title: string, defaultValue = '', opts: PromptOptions = {}) => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setInputVal(defaultValue);
    return new Promise<string | null>((resolve) => {
      setModal({ kind: 'prompt', title, defaultValue, opts, resolve });
    });
  }, []);

  const confirmDangerous = useCallback(async (title: string, extraLines: string[] = []) => {
    const lines: string[] = [title, ''];
    try {
      const r = await api<RequestsResponse>('/api/requests?limit=10', { timeoutMs: 4000 });
      if (r._httpOk && Array.isArray(r.requests)) {
        const cutoff = Date.now() - 60_000;
        const recent = r.requests.filter((x) => Number(x.t) >= cutoff).length;
        lines.push(
          recent > 0
            ? t(
                `最近 60 秒内有 ${recent} 条请求，会打断正在进行的调用。`,
                `${recent} request(s) in the last 60s; this will interrupt in-flight calls.`,
              )
            : t('最近 60 秒没有请求。', 'No requests in the last 60 seconds.'),
        );
      } else {
        lines.push(t('无法检查最近请求状态，操作可能会中断正在进行的调用。', 'Could not check recent requests; in-flight calls may be interrupted.'));
      }
    } catch {
      lines.push(t('无法检查最近请求状态，操作可能会中断正在进行的调用。', 'Could not check recent requests; in-flight calls may be interrupted.'));
    }
    for (const extra of extraLines) {
      if (extra) lines.push(extra);
    }
    return confirm(lines.join('\n'), { danger: true });
  }, [confirm, t]);

  useEffect(() => {
    if (!modal) return;
    if (modal.kind === 'prompt') {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    } else {
      requestAnimationFrame(() => okBtnRef.current?.focus());
    }
  }, [modal]);

  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (modal.kind === 'confirm') modal.resolve(false);
        else modal.resolve(null);
        setModal(null);
        restoreFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, restoreFocus]);

  const closeCancel = () => {
    if (!modal) return;
    const cur = modal;
    finishClose(() => {
      if (cur.kind === 'confirm') cur.resolve(false);
      else cur.resolve(null);
      restoreFocus();
    });
  };

  const closeOk = () => {
    if (!modal) return;
    const cur = modal;
    const val = inputVal;
    finishClose(() => {
      if (cur.kind === 'confirm') cur.resolve(true);
      else cur.resolve(val);
      restoreFocus();
    });
  };

  return (
    <DialogContext.Provider value={{ confirm, prompt, confirmDangerous }}>
      {children}
      {modal && (
        <div
          className={`fixed inset-0 flex items-center justify-center p-4 ${closing ? 'wb-backdrop-out pointer-events-none' : 'wb-backdrop-in'}`}
          style={{
            zIndex: 'var(--z-modal)',
            background: 'rgba(0, 0, 0, 0.44)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeCancel();
          }}
        >
          <div
            role={modal.kind === 'confirm' ? 'alertdialog' : 'dialog'}
            aria-modal="true"
            className={`wb-popover w-full max-w-md rounded-2xl p-5 ${closing ? 'wb-modal-out' : 'wb-modal-in'}`}
          >
            <div className="flex items-start gap-3">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                style={{
                  background: modal.kind === 'confirm' && modal.opts.danger ? 'var(--fail-soft)' : 'var(--primary-soft)',
                  color: modal.kind === 'confirm' && modal.opts.danger ? 'var(--fail)' : 'var(--primary-text)',
                  border: `1px solid ${modal.kind === 'confirm' && modal.opts.danger ? 'var(--fail-border)' : 'var(--primary-border)'}`,
                }}
              >
                {modal.kind === 'confirm' && modal.opts.danger ? <AlertTriangle className="h-4.5 w-4.5" /> : <HelpCircle className="h-4.5 w-4.5" />}
              </div>
              <div className="min-w-0 flex-1">
                {modal.kind === 'confirm' ? (
                  <div className="space-y-1.5 text-[13.5px] leading-relaxed" style={{ color: 'var(--text)' }}>
                    {modal.message.split('\n').map((line, i) =>
                      line.trim() === '' ? (
                        <div key={i} className="h-1.5" />
                      ) : (
                        <p key={i} className={i === 0 ? 'font-semibold text-[14.5px]' : 'text-[13px]'} style={{ color: i === 0 ? 'var(--text)' : 'var(--text-secondary)' }}>
                          {line}
                        </p>
                      ),
                    )}
                  </div>
                ) : (
                  <div>
                    <h3 className="text-[14.5px] font-semibold" style={{ color: 'var(--text)' }}>
                      {modal.title}
                    </h3>
                    <input
                      ref={inputRef}
                      type="text"
                      value={inputVal}
                      maxLength={modal.opts.maxLength ?? 24}
                      placeholder={modal.opts.placeholder || ''}
                      onChange={(e) => setInputVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          closeOk();
                        }
                      }}
                      className="wb-input mt-3 w-full"
                    />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={closeCancel}
                aria-label={t('关闭', 'Close')}
                className="wb-btn wb-btn-ghost wb-btn-icon -mt-1 -mr-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={closeCancel} className="wb-btn">
                {modal.opts.cancelText || t('取消', 'Cancel')}
              </button>
              <button
                ref={okBtnRef}
                type="button"
                onClick={closeOk}
                className={`wb-btn ${modal.kind === 'confirm' && modal.opts.danger ? 'wb-btn-danger' : 'wb-btn-primary'}`}
              >
                {modal.opts.okText || t('确定', 'OK')}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
};

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used inside DialogProvider');
  return ctx;
}
