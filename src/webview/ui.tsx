/**
 * Small shared primitives: skeletons, banners, and the error boundary.
 * Kept in one file because none of them own state worth isolating.
 */
import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';
import { presentError, remedyLabel } from './format';
import type { ErrorBody } from '../messages';

// ------------------------------------------------------------------ skeleton

/** Generic shimmer block. Width/height are geometry, so they ride the style attr. */
export function Skeleton({ width, height }: { width: string; height: number }): JSX.Element {
  return <span className="gc-skeleton" style={{ width, height: `${height}px` }} aria-hidden="true" />;
}

/** Lane skeleton: what the canvas shows before the first graph page lands. */
export function GraphSkeleton(): JSX.Element {
  return (
    <div className="gc-skeleton-graph" role="status" aria-label="Memuat grafik commit">
      {Array.from({ length: 12 }, (_, i) => (
        <div className="gc-skeleton-row" key={i}>
          <Skeleton width="12px" height={12} />
          <Skeleton width={`${30 + ((i * 13) % 45)}%`} height={10} />
          <Skeleton width="60px" height={10} />
        </div>
      ))}
    </div>
  );
}

/** File skeleton for the pending panel and the inspector file list. */
export function FileListSkeleton({ rows = 6 }: { rows?: number }): JSX.Element {
  return (
    <div className="gc-skeleton-files" role="status" aria-label="Memuat daftar file">
      {Array.from({ length: rows }, (_, i) => (
        <div className="gc-skeleton-row" key={i}>
          <Skeleton width="14px" height={14} />
          <Skeleton width={`${40 + ((i * 17) % 40)}%`} height={10} />
        </div>
      ))}
    </div>
  );
}

/** Metadata skeleton for the inspector header. */
export function MetadataSkeleton(): JSX.Element {
  return (
    <div className="gc-skeleton-meta" role="status" aria-label="Memuat metadata commit">
      <Skeleton width="55%" height={14} />
      <Skeleton width="35%" height={10} />
      <Skeleton width="45%" height={10} />
    </div>
  );
}

/** Inline spinner used for diff loads and pagination. */
export function Spinner({ label }: { label: string }): JSX.Element {
  return (
    <span className="gc-spinner" role="status">
      <span className="gc-spinner__dot" aria-hidden="true" />
      <span className="gc-spinner__label">{label}</span>
    </span>
  );
}

// -------------------------------------------------------------------- states

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="gc-empty" role="note">
      <p className="gc-empty__title">{title}</p>
      {hint !== undefined && <p className="gc-empty__hint">{hint}</p>}
      {action}
    </div>
  );
}

/** Error banner driven entirely by `ErrorBody.code`. */
export function ErrorBanner({
  error,
  onRemedy,
  onShowLogs,
}: {
  error: ErrorBody;
  onRemedy?(remedy: string): void;
  onShowLogs?(): void;
}): JSX.Element {
  const view = presentError(error);
  return (
    <div className="gc-banner gc-banner--error" role="alert">
      <span className="gc-banner__glyph" aria-hidden="true">
        !
      </span>
      <div className="gc-banner__body">
        <strong>{view.title}</strong>
        <span>{view.explanation}</span>
        {error.detail !== undefined && <code className="gc-banner__detail">{error.detail}</code>}
      </div>
      <div className="gc-banner__actions">
        {onRemedy !== undefined &&
          view.remedies.map((remedy) => (
            <button
              key={remedy}
              type="button"
              className="gc-button gc-button--quiet"
              onClick={() => onRemedy(remedy)}
            >
              {remedyLabel(remedy)}
            </button>
          ))}
        {view.showLogs && onShowLogs !== undefined && (
          <button type="button" className="gc-button gc-button--quiet" onClick={onShowLogs}>
            Show Logs
          </button>
        )}
      </div>
    </div>
  );
}

/** Neutral informational banner (truncation, stale data, operation in progress). */
export function InfoBanner({
  tone,
  glyph,
  children,
}: {
  tone: 'info' | 'warning';
  glyph: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`gc-banner gc-banner--${tone}`} role="status">
      <span className="gc-banner__glyph" aria-hidden="true">
        {glyph}
      </span>
      <div className="gc-banner__body">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------ error boundary

interface BoundaryState {
  error: Error | null;
  /** Correlation id shown to the user so a log line can be matched to a crash. */
  errorId: string;
}

/**
 * Global boundary (PRD §9). A render crash must never leave a blank webview:
 * it always degrades to a message plus a reload button.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null, errorId: '' };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, errorId: crypto.randomUUID().slice(0, 8) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The webview console is the only sink available under `connect-src 'none'`.
    console.error('[git-control] render crash', error, info.componentStack);
  }

  private reload = (): void => {
    this.setState({ error: null, errorId: '' });
  };

  override render(): ReactNode {
    const { error, errorId } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="gc-crash" role="alert">
        <p className="gc-crash__title">UI gagal dimuat</p>
        <p className="gc-crash__detail">{error.message}</p>
        <p className="gc-crash__id">ID kesalahan: {errorId}</p>
        <button type="button" className="gc-button gc-button--primary" onClick={this.reload}>
          Muat ulang
        </button>
      </div>
    );
  }
}
