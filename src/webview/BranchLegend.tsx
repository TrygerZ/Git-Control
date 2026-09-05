/**
 * Legend: the teaching surface.
 *
 * Every glyph, dash pattern, line weight, and badge the canvas draws is explained
 * here in Indonesian — not as a key ("dashed = local") but as a short answer to
 * "what does this tell me, and what should I do about it?". Understanding git is
 * the point of this extension, so this panel is a feature, not a footnote.
 *
 * Rules held here: each swatch is built from the same CSS the canvas uses, so a
 * sample cannot drift from reality; every entry names at least two visual channels
 * (shape plus badge, weight plus curve), which is why the graph stays readable with
 * no colour at all.
 */
import { useEffect, useId, useRef, type JSX, type KeyboardEvent } from 'react';
import { sanitizeGitText } from './format';
import { Icon } from './ui';
import { t, type Lang } from './i18n';
import { useT } from './useT';
import { useOperationStore, useSettingsStore } from './store';
import type { GraphLane, RefInfo } from '../messages';

export interface BranchSelectorProps {
  currentBranch: string | null;
  refs: readonly RefInfo[];
  busy?: boolean;
  /** When true, renders a visible label above the select (graph toolbar). Omit in narrow sidebars. */
  showLabel?: boolean;
}

export interface BranchOption {
  value: string;
  label: string;
  /** Full branch name when label is truncated, so the option keeps its tooltip. */
  hint?: string;
}

export interface BranchSelectorState {
  options: BranchOption[];
  disabled: boolean;
  selectedValue: string;
}

/**
 * Branch labels set the flex item's intrinsic width; a single 60-char name would
 * force `.gc-toolbar__branch-select` wider than any sidebar. Truncate display only,
 * never `value` — the ref that checkout acts on.
 */
const BRANCH_LABEL_LIMIT = 32;

function truncateBranchLabel(label: string): { display: string; full: string } {
  if (label.length <= BRANCH_LABEL_LIMIT) return { display: label, full: label };
  return { display: `${label.slice(0, BRANCH_LABEL_LIMIT - 1)}\u2026`, full: label };
}

export function computeBranchOptions(
  refs: readonly RefInfo[],
  currentBranch: string | null,
  busy: boolean,
  formatCurrent: (name: string) => string = (n) => `${n} (current)`,
  detachedLabel: string = 'Detached HEAD',
): BranchSelectorState {
  const localBranches = refs.filter((r) => r.kind === 'local');
  const options: BranchOption[] = [];

  if (currentBranch === null) {
    // No `disabled` here: the placeholder is the selected option while detached,
    // and the native popup renders disabled options with dimmed foreground,
    // making the visible selection unreadable. Non-checkout is enforced by
    // checkoutActionPayload (empty value never fires an action).
    options.push({
      value: '',
      label: detachedLabel,
    });
  }

  // Suffix length is locale-dependent: " (current)" is 10, " (aktif)" is 8.
  // Measuring it lets us truncate the NAME so the FINAL rendered label
  // (name + suffix) stays bounded by BRANCH_LABEL_LIMIT, not name alone.
  const suffixLen = isSuffixBranch(formatCurrent) ? formatCurrent('').length : 0;

  for (const ref of localBranches) {
    const isCurrent = ref.shortName === currentBranch;
    const sanitized = sanitizeGitText(ref.shortName);
    // Budget for the name shrinks when the suffix will be appended, so a
    // 32-char name + " (current)" does not become 42 chars on screen.
    const nameBudget = isCurrent ? Math.max(1, BRANCH_LABEL_LIMIT - suffixLen) : BRANCH_LABEL_LIMIT;
    const truncated = truncateBranchLabelWithLimit(sanitized, nameBudget);
    const display = truncated.display;
    const label = isCurrent ? formatCurrent(display) : display;
    // Full name stays in title so the OS dropdown (unstyleable) still reveals it.
    const fullLabel = isCurrent ? formatCurrent(truncated.full) : truncated.full;
    const needsTitle = truncated.display !== truncated.full;
    // No `disabled` even for the current branch: the native `<select>` popup
    // renders disabled options with dimmed foreground, so the selected item
    // (the current branch) is unreadable at first paint. Redundant checkout is
    // instead blocked by checkoutActionPayload via onSelect.
    options.push({
      value: ref.shortName,
      label,
      ...(needsTitle ? { hint: fullLabel } : {}),
    });
  }

  return {
    options,
    disabled: busy || localBranches.length === 0,
    selectedValue: currentBranch ?? '',
  };
}

function isSuffixBranch(fn: (name: string) => string): boolean {
  try {
    const probe = fn('__probe__');
    return probe.includes('__probe__');
  } catch {
    return false;
  }
}

function truncateBranchLabelWithLimit(label: string, limit: number): { display: string; full: string } {
  if (label.length <= limit) return { display: label, full: label };
  return { display: `${label.slice(0, limit - 1)}\u2026`, full: label };
}

/** Determines whether a branch checkout action should fire. */
export function checkoutActionPayload(
  targetBranch: string,
  currentBranch: string | null,
  busy: boolean,
): { action: 'checkout-branch'; branch: string } | null {
  if (!targetBranch || targetBranch === currentBranch || busy) return null;
  return { action: 'checkout-branch', branch: targetBranch };
}

/**
 * Interactive branch checkout dropdown.
 * Offers only local branches (kind === 'local'), disables the select on busy state
 * or when no local branches exist, triggers `checkout-branch` action on select.
 */
export function BranchSelector({
  currentBranch,
  refs,
  busy = false,
  showLabel = false,
}: BranchSelectorProps): JSX.Element {
  const strings = useT();
  const runAction = useOperationStore((s) => s.runAction);
  const state = computeBranchOptions(
    refs,
    currentBranch,
    busy,
    (name) => strings.graph.checkoutBranchCurrent(name),
    strings.graph.checkoutBranchDetached,
  );

  const onSelect = (branch: string) => {
    const payload = checkoutActionPayload(branch, currentBranch, busy);
    if (!payload) return;
    void runAction(payload);
  };

  // showLabel: graph toolbar — visual label distinguishes the mutating
  // checkout action from the view-only filter. When a proper <label> is
  // present the accessible name comes from that label, so aria-label would
  // overwrite it and break label-in-name — omit it in the labelled variant.
  // Default (sidebar) keeps aria-label to save vertical space.
  const select = (
    <select
      className="gc-toolbar__branch-select"
      value={state.selectedValue}
      disabled={state.disabled}
      {...(!showLabel ? { 'aria-label': strings.graph.checkoutBranchAria } : {})}
      title={strings.graph.checkoutBranchTitle}
      onChange={(e) => onSelect(e.target.value)}
    >
      {state.options.map((opt) => (
        <option key={opt.value || '__detached'} value={opt.value} title={opt.hint ?? opt.label}>
          {opt.label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="gc-toolbar__branch-wrap">
      {showLabel ? (
        <label className="gc-field gc-toolbar__field">
          <span className="gc-field__label">{strings.graph.checkoutBranchLabel}</span>
          {select}
        </label>
      ) : (
        select
      )}
    </div>
  );
}

interface Props {
  lanes: readonly GraphLane[];
  id?: string;
  onClose?(): void;
}

/** Short display name for a lane's seed ref. Sanitised: refs come from git. */
export function laneLabel(lane: GraphLane, lang: Lang = 'en'): string {
  if (lane.ref === undefined) return t(lang).legend.laneDefault(lane.index + 1);
  const name = sanitizeGitText(lane.ref);
  if (name.startsWith('refs/tags/')) return t(lang).legend.laneTagPrefix(name.slice(10));
  if (name.startsWith('refs/remotes/')) return t(lang).legend.laneRemotePrefix(name.slice(13));
  if (name.startsWith('refs/heads/')) return name.slice(11);
  return name;
}

export function BranchLegend({ lanes, id, onClose }: Props): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const panelRef = useRef<HTMLElement>(null);
  const titleId = useId();

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
    }
  };

  return (
    <section
      ref={panelRef}
      id={id}
      className="gc-legend"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="gc-legend__header">
        <h2 id={titleId} className="gc-legend__title">{strings.legend.title}</h2>
        {onClose !== undefined && (
          <button
            type="button"
            className="gc-icon-button gc-legend__close"
            aria-label={strings.legend.closeAria}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        )}
      </div>

      <div className="gc-legend__body">
        <p className="gc-legend__intro">
          {strings.legend.intro}
        </p>

        <h3 className="gc-legend__heading">{strings.legend.sectionCommitShapes}</h3>
        <dl className="gc-legend__list">
          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--head" aria-hidden="true" />
            {strings.legend.headTitle}
          </dt>
          <dd>
            {strings.legend.headDesc}
          </dd>

          <dt>
            <span className="gc-avatar gc-legend__avatar" aria-hidden="true">
              S
            </span>
            {strings.legend.initialTitle}
          </dt>
          <dd>
            {strings.legend.initialDesc}
          </dd>

          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--remote" aria-hidden="true" />
            {strings.legend.remoteTitle}
          </dt>
          <dd>
            {strings.legend.remoteDesc}
          </dd>

          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--local" aria-hidden="true" />
            {strings.legend.localTitle}
          </dt>
          <dd>
            {strings.legend.localDesc}
          </dd>

          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--merge" aria-hidden="true" />
            {strings.legend.mergeTitle}
          </dt>
          <dd>
            {strings.legend.mergeDesc}
          </dd>

          <dt>
            <span className="gc-legend__swatch gc-legend__swatch--ribbon" aria-hidden="true" />
            {strings.legend.ribbonTitle}
          </dt>
          <dd>
            {strings.legend.ribbonDesc}
          </dd>
        </dl>

        <h3 className="gc-legend__heading">{strings.legend.sectionRefLabels}</h3>
        <dl className="gc-legend__list">
          <dt>
            <span className="gc-chip gc-chip--current"><Icon name="git-branch" /> main</span>
          </dt>
          <dd>
            {strings.legend.currentBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--local"><Icon name="circle-filled" /> fitur</span>
          </dt>
          <dd>
            {strings.legend.localBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--remote"><Icon name="cloud" /> origin/main</span>
          </dt>
          <dd>
            {strings.legend.remoteBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--tag"><Icon name="tag" /> v1.0</span>
          </dt>
          <dd>
            {strings.legend.tagDesc}
          </dd>
        </dl>

        {lanes.length > 0 && (
          <>
            <h3 className="gc-legend__heading">{strings.legend.sectionActiveLanes}</h3>
            <ul className="gc-legend__lanes">
              {lanes.map((lane) => (
                <li key={lane.index}>
                  <span
                    className="gc-legend__lane-color"
                    style={{ background: lane.color }}
                    aria-hidden="true"
                  />
                  <span>{laneLabel(lane, language)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 className="gc-legend__heading">{strings.legend.sectionShortcuts}</h3>
        <ul className="gc-legend__keys">
          <li><kbd>←</kbd> <kbd>→</kbd> {strings.legend.keyMoveCommit}</li>
          <li><kbd>↑</kbd> <kbd>↓</kbd> {strings.legend.keyMoveLane}</li>
          <li><kbd>Enter</kbd> {strings.legend.keyOpenDetail}</li>
          <li><kbd>+</kbd> <kbd>-</kbd> {strings.legend.keyZoom}</li>
        </ul>
      </div>
    </section>
  );
}
