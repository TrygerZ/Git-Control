/**
 * Toast region.
 *
 * Two regions, not one: informational outcomes go to a `polite` region that waits
 * for a pause, and warnings and errors go to an `assertive` one that interrupts.
 * A single `polite` region would queue a failed push behind three "Commit
 * berhasil" messages, which is the wrong order for the only message that needs
 * acting on.
 *
 * Auto-dismiss pauses while the pointer or keyboard focus is inside the stack,
 * otherwise a long message is unreadable. Errors never auto-dismiss at all: a
 * message that names a failed git operation has to survive long enough to be read
 * and acted on.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { sanitizeGitText } from './format';
import { TOAST_TIMEOUT_MS, useOperationStore, type Toast } from './store';

export function ToastRegion(): JSX.Element {
  const toasts = useOperationStore((s) => s.toasts);
  const dismiss = useOperationStore((s) => s.dismissToast);
  const showLogs = useOperationStore((s) => s.showLogs);
  const [paused, setPaused] = useState(false);

  const polite = toasts.filter((t) => t.level === 'info');
  const urgent = toasts.filter((t) => t.level !== 'info');

  const render = (toast: Toast): JSX.Element => (
    <ToastItem
      key={toast.id}
      toast={toast}
      paused={paused}
      onDismiss={() => dismiss(toast.id)}
      onShowLogs={showLogs}
    />
  );

  return (
    <div
      className="gc-toasts"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/*
        `role="alert"` implies `aria-live="assertive"`, and it is on the CONTAINER
        rather than each toast: a live region has to exist in the DOM before its
        content changes, otherwise the insertion is not announced at all.
      */}
      <div className="gc-toasts__urgent" role="alert" aria-label="Peringatan dan kesalahan">
        {urgent.map(render)}
      </div>
      <div
        className="gc-toasts__polite"
        role="status"
        aria-live="polite"
        aria-label="Notifikasi"
      >
        {polite.map(render)}
      </div>
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

/**
 * Level glyphs. Deliberately none of them is `×`.
 *
 * The close button on the same row is a `×`, so an error toast used to render two
 * `×` side by side meaning entirely different things — one "this failed", one "make
 * this go away". `✕` versus `×` would not have helped: they are the same shape at
 * 12 px. `⛌` is a distinct glyph, and the pairing is glyph → word → colour, in that
 * order of precedence.
 *
 * The tone per level lives in the stylesheet, keyed off `.gc-toast--<level>`, and
 * reuses the `--gc-tone-*` tokens the status boxes use: error → `removed`, warning →
 * `pending`, info → `changed`. One colour vocabulary for the whole extension rather
 * than a second palette invented for notifications.
 */
const LEVEL_GLYPH: Record<Toast['level'], string> = {
  info: 'i',
  warning: '!',
  error: '⛌',
};

function ToastItem({ toast, paused, onDismiss, onShowLogs }: ItemProps): JSX.Element {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  /** An error stays until dismissed, so it says so rather than leaving the user waiting. */
  const persistent = toast.level === 'error';

  useEffect(() => {
    // An error stays until dismissed. Everything else is transient by design.
    if (paused || toast.level === 'error') return undefined;
    const timer = setTimeout(() => dismissRef.current(), TOAST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [paused, toast.id, toast.level]);

  return (
    <div className={`gc-toast gc-toast--${toast.level}`}>
      <span className="gc-toast__glyph" aria-hidden="true">
        {LEVEL_GLYPH[toast.level]}
      </span>
      <div className="gc-toast__body">
        {/*
          The severity word, now visible rather than screen-reader-only.

          It used to be `.gc-visually-hidden`, which left a sighted newcomer with a
          border colour and a glyph as the only difference between "saved" and
          "failed" — and the border is 3 px of a hue some themes barely distinguish.
          The word is the channel that works in every theme, so it is on screen.

          It sits on its own line (the body is a column), so the trailing colon the
          hidden version carried is gone: a colon dangling at the end of a standalone
          label reads as a missing value. AT still gets `Kesalahan` before the message
          because they are separate elements in reading order.
        */}
        <span className="gc-toast__level">{LEVEL_LABEL[toast.level]}</span>
        {/* Both can be git stderr — hook output reaches `detail` verbatim. */}
        <span className="gc-toast__message">{sanitizeGitText(toast.message)}</span>
        {toast.detail !== undefined && (
          <span className="gc-toast__detail">{sanitizeGitText(toast.detail)}</span>
        )}
        {/*
          Errors do not auto-dismiss, and silence about that is its own problem: the
          user waits for the toast to disappear, it does not, and they conclude the UI
          is stuck. Saying it out loud turns a broken expectation into an instruction.
        */}
        {persistent && (
          <span className="gc-toast__persist">
            Notifikasi ini menunggu tindakan Anda dan tidak hilang sendiri. Tutup setelah dibaca.
          </span>
        )}
      </div>
      {toast.showLogs === true && (
        <button
          type="button"
          className="gc-button gc-button--quiet"
          title="Buka panel Output berisi keluaran lengkap dari git."
          onClick={onShowLogs}
        >
          Lihat log
        </button>
      )}
      <button
        type="button"
        className="gc-icon-button"
        // Names which notification is being closed, so a stack of three does not
        // read as three identical `Tutup notifikasi` buttons.
        aria-label={`Tutup notifikasi: ${sanitizeGitText(toast.message)}`}
        title="Tutup notifikasi ini."
        onClick={onDismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}
