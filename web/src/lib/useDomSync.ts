import { useCallback, useRef } from 'react';

/**
 * Callback ref that attaches native `input` and `change` listeners directly to
 * an input/select/textarea as soon as it mounts (even inside conditional branches).
 * Keeps React state synchronized when external scripts or autofill mutate
 * `.value` / `.checked` directly and dispatch non-bubbling DOM events.
 */
export function useNativeInputSync<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  onSync: (el: T) => void,
) {
  const cbRef = useRef(onSync);
  cbRef.current = onSync;
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((el: T | null) => {
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (!el) return;
    const handler = () => cbRef.current(el);
    el.addEventListener('change', handler);
    el.addEventListener('input', handler);
    cleanupRef.current = () => {
      el.removeEventListener('change', handler);
      el.removeEventListener('input', handler);
    };
  }, []);
}
