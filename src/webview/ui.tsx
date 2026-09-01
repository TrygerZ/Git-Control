/**
 * Small shared primitives: skeletons, banners, and the error boundary.
 * Kept in one file because none of them own state worth isolating.
 */
import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';
import {
  presentError,
  remedyConsequence,
  remedyLabel,
  repoName,
  sanitizeGitText,
  shortHash,
  syncSummary,
} from './format';
import { useT } from './useT';
import { useSettingsStore } from './store';
import type { ErrorBody, Remedy, RepoStatus } from '../messages';
import type { IconName } from './icons';
import { ICON_PATHS } from './iconPaths';

export type { IconName };

// ---------------------------------------------------------------------- icon

/**
 * Reusable icon component rendering custom inline SVGs.
 *
 * Decorative by default (`aria-hidden="true"`). When given a `label`, it exposes
 * `role="img"` with `aria-label` matching the existing a11y contract.
 */
export function Icon({
  name,
  label,
}: {
  name: IconName;
  label?: string;
}): JSX.Element | null {
  const renderPath = ICON_PATHS[name];
  if (!renderPath) return null;

  const content = renderPath();
  const hasLabel = label !== undefined && label.length > 0;

  return (
    <svg
      className="gc-icon"
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      aria-hidden={hasLabel ? undefined : 'true'}
      role={hasLabel ? 'img' : undefined}
      aria-label={hasLabel ? label : undefined}
      focusable="false"
    >
      {content}
    </svg>
  );
}

// ------------------------------------------------------------------ skeleton

/** Generic shimmer block. Width/height are geometry, so they ride the style attr. */
export function Skeleton({ width, height }: { width: string; height: number }): JSX.Element {
  return <span className="gc-skeleton" style={{ width, height: `${height}px` }} aria-hidden="true" />;
}

/**
 * Lane skeleton: what the canvas shows before the first graph page lands.
 *
 * Shaped like `.gc-row` — dot, subject bar, date bar, at the same row height and
 * gaps — so the first real paint replaces it in place instead of shifting the
 * layout. `aria-busy` marks the region as loading rather than as content.
 */
export function GraphSkeleton(): JSX.Element {
  const strings = useT();
  return (
    <div className="gc-skeleton-graph" role="status" aria-busy="true" aria-label={strings.ui.graphSkeletonAria}>
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
  const strings = useT();
  return (
    <div className="gc-skeleton-files" role="status" aria-busy="true" aria-label={strings.ui.fileListSkeletonAria}>
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
  const strings = useT();
  return (
    <div className="gc-skeleton-meta" role="status" aria-busy="true" aria-label={strings.ui.metadataSkeletonAria}>
      <Skeleton width="55%" height={14} />
      <Skeleton width="35%" height={10} />
      <Skeleton width="45%" height={10} />
    </div>
  );
}

/**
 * Inline spinner used for diff loads and pagination.
 *
 * The label is visible text, not an `aria-label`: under `prefers-reduced-motion`
 * the ring stops moving, and the words are then the only thing still saying
 * "working".
 */
export function Spinner({ label }: { label: string }): JSX.Element {
  return (
    <span className="gc-spinner" role="status">
      <span className="gc-spinner__dot" aria-hidden="true" />
      <span className="gc-spinner__label">{label}</span>
    </span>
  );
}

// ------------------------------------------------------------------- context

/**
 * Context breadcrumb: which repository, which branch, where that branch stands.
 *
 * Taken from the Unity reference, which puts the workspace and the current
 * changeset on one quiet line above every panel. The reason it earns the space is
 * that both of this extension's surfaces act on "the current branch of the current
 * repository" without ever naming it — so a user with two windows open has no way
 * to tell which repository a `Commit` press is about to touch.
 *
 * Hierarchy, deliberately three steps: the repository is the loudest crumb, the
 * branch sits beside it as a chip because it is the thing that changes, and the
 * sync sentence is the quietest because it is context rather than identity.
 *
 * `subject` is optional: the graph knows the newest commit's subject, the pending
 * panel does not fetch commits at all, and a short hash is still a true answer to
 * "where am I".
 *
 * ponytail: no repository switcher here — the reference has one, but picking a
 * repository is `gitControl.pickRepository` on the host and wiring a dropdown to
 * it is flow work, not visual work. Add when the panel needs to manage several
 * repositories at once.
 */
export function ContextBar({
  status,
  subject,
}: {
  status: RepoStatus | null;
  subject?: string | undefined;
}): JSX.Element | null {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  if (status === null) return null;
  const branch =
    status.branch === null
      ? status.head === null
        ? strings.ui.noBranch
        : strings.ui.detachedAt(shortHash(status.head))
      : sanitizeGitText(status.branch);
  const head = status.head === null ? null : shortHash(status.head);
  const line = subject === undefined ? null : sanitizeGitText(subject);

  return (
    <header className="gc-context">
      <div className="gc-context__crumbs">
        <span className="gc-context__repo" title={sanitizeGitText(status.repoRoot)}>
          {repoName(status.repoRoot)}
        </span>
        <span className="gc-context__sep" aria-hidden="true">
          ›
        </span>
        {/*
          The word "branch" is in the text, not only in the shape: a chip on its own
          does not say what kind of name it holds, and `detached` is exactly the
          state a newcomer needs told in words.
        */}
        <span className={status.detached ? 'gc-chip gc-chip--detached' : 'gc-chip gc-chip--current'}>
          {status.detached ? <Icon name="tag" /> : <Icon name="git-branch" />}
          {' '}{strings.ui.branchLabel(branch)}
        </span>
        {head !== null && (
          <code className="gc-context__hash" aria-label={strings.ui.headAtCommit(head)}>
            {head}
          </code>
        )}
      </div>
      {line !== null && (
        <p className="gc-context__subject" title={line}>
          {strings.ui.lastCommit(line)}
        </p>
      )}
      <p className="gc-context__sync">{syncSummary(status, language)}</p>
    </header>
  );
}

// -------------------------------------------------------------------- states

/**
 * Empty state.
 *
 * `title` states what is true; `hint` says what to do next. An empty panel that
 * only says "nothing here" makes the user guess, which in a git UI means guessing
 * about their own repository.
 *
 * `steps` exists because a hint is one sentence and a first run is a sequence. When
 * the next move takes more than one action ("open the panel, tick the file, write a
 * message, press Commit") a prose sentence buries the order; an ordered list keeps
 * it countable and lets the user stop halfway and come back.
 */
export function EmptyState({
  title,
  hint,
  steps,
  action,
}: {
  title: string;
  hint?: string;
  steps?: readonly string[];
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="gc-empty" role="note">
      <p className="gc-empty__title">{title}</p>
      {hint !== undefined && <p className="gc-empty__hint">{hint}</p>}
      {steps !== undefined && steps.length > 0 && (
        <ol className="gc-empty__steps">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {action !== undefined && <div className="gc-empty__actions">{action}</div>}
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
  onRemedy?(remedy: Remedy): void;
  onShowLogs?(): void;
}): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  const view = presentError(error, language);
  return (
    <div className="gc-banner gc-banner--error" role="alert">
      <span className="gc-banner__glyph" aria-hidden="true">
        <Icon name="error" />
      </span>
      <div className="gc-banner__body">
        {/* "Error" / "Kesalahan" spells the severity out; the border colour is only backup. */}
        <span className="gc-visually-hidden">{strings.ui.errorSeverity}</span>
        <strong>{view.title}</strong>
        <span>{view.explanation}</span>
        {/* `detail` carries git stderr, including hook output. */}
        {error.detail !== undefined && (
          <code className="gc-banner__detail">{sanitizeGitText(error.detail)}</code>
        )}
      </div>
      <div className="gc-banner__actions">
        {onRemedy !== undefined &&
          view.remedies.map((remedy) => (
            <button
              key={remedy}
              type="button"
              className="gc-button gc-button--quiet"
              // Same consequence sentences the guard dialog uses. The banner offers
              // the same words for the same buttons, so `Fetch` here cannot mean
              // something different from `Fetch` there.
              title={remedyConsequence(remedy, language)}
              onClick={() => onRemedy(remedy)}
            >
              {remedyLabel(remedy, language)}
            </button>
          ))}
        {view.showLogs && onShowLogs !== undefined && (
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title={strings.ui.viewLogsTitle}
            onClick={onShowLogs}
          >
            {strings.ui.viewLogs}
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
  glyph: IconName;
  children: ReactNode;
}): JSX.Element {
  const strings = useT();
  return (
    <div className={`gc-banner gc-banner--${tone}`} role="status">
      <span className="gc-banner__glyph" aria-hidden="true">
        <Icon name={glyph} />
      </span>
      <div className="gc-banner__body">
        {/* Warnings say so in words; `role="status"` alone conveys no severity. */}
        {tone === 'warning' && <span className="gc-visually-hidden">{strings.ui.warningSeverity}</span>}
        {children}
      </div>
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
    const strings = useT();
    return (
      <div className="gc-crash" role="alert">
        <p className="gc-crash__title">{strings.ui.crashTitle}</p>
        <p className="gc-crash__detail">{sanitizeGitText(error.message)}</p>
        <p className="gc-crash__id">
          {strings.ui.crashErrorId(errorId)}
        </p>
        <div className="gc-crash__actions">
          <button
            type="button"
            className="gc-button gc-button--primary"
            title={strings.ui.crashReloadTitle}
            onClick={this.reload}
          >
            {strings.ui.crashReload}
          </button>
        </div>
      </div>
    );
  }
}
