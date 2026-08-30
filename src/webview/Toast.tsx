/**
 * Toast region. `aria-live="polite"` so a screen reader announces outcomes
 * without stealing focus. Auto-dismiss pauses while the pointer or keyboard
 * focus is inside the stack, otherwise a long message is unreadable.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { sanitizeGitText } from './format';
import { TOAST_TIMEOUT_MS, useOperationStore, type Toast } from './store';

export function ToastRegion(): JSX.Element {
  const toasts = useOperationStore((s) => s.toasts);
  const dismiss = useOperationStore((s) => s.dismissToast);
  const showLogs = useOperationStore((s) => s.showLogs);
  const [paused, setPaused] = useState(false);

  return (
    <div
      className="gc-toasts"
      role="status"
      aria-live="polite"
      aria-label="Notifikasi"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          paused={paused}
          onDismiss={() => dismiss(toast.id)}
          onShowLogs={showLogs}
        />
      ))}
    </div>
  );
}

interface ItemProps {
  toast: Toast;
  paused: boolean;
  onDismiss(): void;
  onShowLogs(): void;
}

const LEVEL_LABEL: Record<Toast['level'], string> = {
  info: 'Info',
  warning: 'Peringatan',
  error: 'Kesalahan',
};

const LEVEL_GLYPH: Record<Toast['level'], string> = {
  info: 'i',
  warning: '!',
  error: '×',
};

function ToastItem({ toast, paused, onDismiss, onShowLogs }: ItemProps): JSX.Element {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (paused) return undefined;
    const timer = setTimeout(() => dismissRef.current(), TOAST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [paused, toast.id]);

  return (
    <div className={`gc-toast gc-toast--${toast.level}`}>
      <span className="gc-toast__glyph" aria-hidden="true">
        {LEVEL_GLYPH[toast.level]}
      </span>
      <div className="gc-toast__body">
        <span className="gc-visually-hidden">{LEVEL_LABEL[toast.level]}: </span>
        {/* Both can be git stderr — hook output reaches `detail` verbatim. */}
        <span className="gc-toast__message">{sanitizeGitText(toast.message)}</span>
        {toast.detail !== undefined && (
          <span className="gc-toast__detail">{sanitizeGitText(toast.detail)}</span>
        )}
      </div>
      {toast.showLogs === true && (
        <button type="button" className="gc-button gc-button--quiet" onClick={onShowLogs}>
          Show Logs
        </button>
      )}
      <button
        type="button"
        className="gc-icon-button"
        aria-label="Tutup notifikasi"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
