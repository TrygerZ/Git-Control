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
import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
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
  /** Inline label rendered inside the bordered trigger button (Figma Frame 01/15: `Checkout`). */
  inlineLabel?: string;
  /** Optional handler to open the Create Branch flow from the bottom of the Checkout popover (Frame 15). */
  onCreateBranch?: () => void;
  /**
   * Accessible name for the select. Defaults to the catalog's checkout name, so a
   * host that renders no visible label still gets a named control.
   */
  'aria-label'?: string;
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
 * never `value`: the ref that checkout acts on. Suffix-aware truncation measures
 * the current marker inside `computeBranchOptions` so the FINAL label stays bounded.
 */
const BRANCH_LABEL_LIMIT = 32;

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
  inlineLabel,
  onCreateBranch,
  'aria-label': ariaLabel,
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [placed, setPlaced] = useState({ x: 0, y: 0, width: 310 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (trigger === null || popover === null) return;
    const anchor = trigger.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(300, Math.min(356, Math.max(anchor.width, box.width)));
    const x = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    const y = Math.max(margin, Math.min(anchor.bottom + 4, window.innerHeight - box.height - margin));
    setPlaced({ x, y, width });
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const onSelect = (branch: string) => {
    setOpen(false);
    setQuery('');
    const payload = checkoutActionPayload(branch, currentBranch, busy);
    if (!payload) return;
    void runAction(payload);
  };

  const localRefs = refs.filter(
    (ref) => ref.kind === 'local' && !ref.shortName.startsWith('refs/remotes/'),
  );
  const q = query.trim().toLowerCase();
  const filteredRefs = q.length === 0
    ? localRefs
    : localRefs.filter((ref) => ref.shortName.toLowerCase().includes(q));
  const displayLabel =
    currentBranch !== null
      ? sanitizeGitText(currentBranch)
      : strings.graph.checkoutBranchDetached;

  const select = (
    <span className="gc-toolbar__branch-select-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="gc-toolbar__branch-select gc-popover-trigger"
        disabled={state.disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        {...(!showLabel ? { 'aria-label': ariaLabel ?? strings.graph.checkoutBranchAria } : {})}
        title={strings.graph.checkoutBranchTitle}
        onClick={() => {
          setOpen((prev) => !prev);
          setQuery('');
        }}
      >
        <span className="gc-popover-trigger__icon" aria-hidden="true">
          <Icon name="git-branch" />
        </span>
        {inlineLabel !== undefined && (
          <span className="gc-toolbar__label" aria-hidden="true">
            {inlineLabel}
          </span>
        )}
        <span className="gc-popover-trigger__label">{displayLabel}</span>
        <span className="gc-popover-trigger__chevron" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>
      {open && (
        <div
          id={listId}
          ref={popoverRef}
          className="gc-menu gc-branch-popover"
          role="dialog"
          aria-label={strings.graph.checkoutBranchAria}
          style={{ left: `${placed.x}px`, top: `${placed.y}px`, width: `${placed.width}px` }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <div className="gc-branch-popover__search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              className="gc-branch-popover__input"
              value={query}
              placeholder={strings.graph.branchPopoverFilter}
              aria-label={strings.graph.branchPopoverFilter}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="gc-menu__group-title" aria-hidden="true">
            {strings.graph.branchPopoverGroup}
          </span>
          <div className="gc-branch-popover__list" role="listbox" aria-label={strings.graph.branchPopoverGroup}>
            {filteredRefs.map((ref) => {
              const isCurrent = ref.shortName === currentBranch;
              const safeName = sanitizeGitText(ref.shortName);
              return (
                <button
                  key={ref.refName}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  className={
                    isCurrent
                      ? 'gc-menu__item gc-menu__item--compact gc-branch-popover__option gc-branch-popover__option--selected'
                      : 'gc-menu__item gc-menu__item--compact gc-branch-popover__option'
                  }
                  onClick={() => onSelect(ref.shortName)}
                >
                  <span className="gc-branch-popover__check" aria-hidden="true">
                    {isCurrent && <Icon name="check" />}
                  </span>
                  <span className="gc-menu__icon" aria-hidden="true">
                    <Icon name="git-branch" />
                  </span>
                  <span className="gc-branch-popover__name">{safeName}</span>
                  {ref.gone ? (
                    <span className="gc-branch-popover__pill gc-branch-popover__pill--warning">
                      {strings.branches.chipUpstreamGone}
                    </span>
                  ) : ref.upstream === null ? (
                    <span className="gc-branch-popover__pill">{strings.branches.chipLocalOnly}</span>
                  ) : !isCurrent ? (
                    <span className="gc-menu__hint">{sanitizeGitText(ref.upstream)}</span>
                  ) : null}
                  {isCurrent && (
                    <span className="gc-menu__hint">{strings.graph.branchPopoverCurrent}</span>
                  )}
                </button>
              );
            })}
            {filteredRefs.length === 0 && (
              <p className="gc-branch-popover__empty">{strings.branches.emptyFilter}</p>
            )}
          </div>
          {onCreateBranch !== undefined && (
            <>
              <span className="gc-menu__separator" aria-hidden="true" />
              <button
                type="button"
                className="gc-menu__item gc-menu__item--compact gc-branch-popover__create"
                onClick={() => {
                  setOpen(false);
                  setQuery('');
                  onCreateBranch();
                }}
              >
                <span className="gc-menu__icon" aria-hidden="true">
                  <Icon name="add" />
                </span>
                <span className="gc-menu__label">{strings.graph.branchPopoverCreate}</span>
              </button>
            </>
          )}
          <span className="gc-menu__separator" aria-hidden="true" />
          <div className="gc-branch-popover__note">
            <Icon name="info" />
            <span>{strings.graph.branchPopoverNote}</span>
          </div>
        </div>
      )}
    </span>
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

/**
 * Searchable lane filter popover for the Explorer toolbar ("Show: All branches", frame 16).
 */
export function LaneFilterSelector({
  branchFilter,
  branches,
  lanes,
  laneCommitCounts,
  inlineLabel,
  onBranchFilter,
  'aria-label': ariaLabel,
}: {
  branchFilter: string;
  branches: readonly RefInfo[];
  lanes: readonly GraphLane[];
  laneCommitCounts?: ReadonlyMap<number, number>;
  inlineLabel?: string;
  onBranchFilter: (branch: string) => void;
  'aria-label'?: string;
}): JSX.Element {
  const strings = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [placed, setPlaced] = useState({ x: 0, y: 0, width: 290 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (trigger === null || popover === null) return;
    const anchor = trigger.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const margin = 8;
    const width = Math.max(280, Math.min(340, Math.max(anchor.width, box.width)));
    const x = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
    const y = Math.max(margin, Math.min(anchor.bottom + 4, window.innerHeight - box.height - margin));
    setPlaced({ x, y, width });
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const laneByShortName = new Map<string, GraphLane>();
  for (const lane of lanes) {
    if (lane.ref !== undefined) {
      const short = lane.ref.replace(/^refs\/(?:heads|remotes|tags)\//, '');
      laneByShortName.set(short, lane);
      laneByShortName.set(lane.ref, lane);
    }
  }

  // Frame 16 (`155:1888`): list the graph's lanes with their colour dot and commit count;
  // fall back to branch refs if lanes have no named refs.
  const laneEntries: { key: string; value: string; label: string; color?: string; count?: number }[] = [];
  const seenValues = new Set<string>();
  for (const lane of lanes) {
    if (lane.ref === undefined) continue;
    const value = lane.ref.replace(/^refs\/(?:heads|remotes|tags)\//, '');
    if (seenValues.has(value)) continue;
    seenValues.add(value);
    const count = laneCommitCounts?.get(lane.index);
    laneEntries.push({
      key: `lane-${lane.index}-${value}`,
      value,
      label: sanitizeGitText(value),
      color: lane.color,
      ...(count !== undefined ? { count } : {}),
    });
  }
  for (const ref of branches) {
    if (seenValues.has(ref.shortName)) continue;
    seenValues.add(ref.shortName);
    const lane = laneByShortName.get(ref.shortName);
    const count = lane !== undefined ? laneCommitCounts?.get(lane.index) : undefined;
    laneEntries.push({
      key: ref.refName,
      value: ref.shortName,
      label: sanitizeGitText(ref.shortName),
      ...(lane !== undefined ? { color: lane.color } : {}),
      ...(count !== undefined ? { count } : {}),
    });
  }

  const q = query.trim().toLowerCase();
  const filtered = q.length === 0
    ? laneEntries
    : laneEntries.filter((entry) => entry.label.toLowerCase().includes(q));
  const activeLabel =
    branchFilter.length === 0 ? strings.graph.branchFilterAll : sanitizeGitText(branchFilter);

  const pick = (val: string): void => {
    setOpen(false);
    setQuery('');
    onBranchFilter(val);
  };

  return (
    <div className="gc-toolbar__branch-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="gc-toolbar__branch-select gc-popover-trigger"
        aria-label={ariaLabel ?? strings.graph.branchFilterAria}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((prev) => !prev);
          setQuery('');
        }}
      >
        {inlineLabel !== undefined && (
          <span className="gc-toolbar__label" aria-hidden="true">
            {inlineLabel}
          </span>
        )}
        <span className="gc-popover-trigger__label">{activeLabel}</span>
        <span className="gc-popover-trigger__chevron" aria-hidden="true">
          <Icon name="chevron-down" />
        </span>
      </button>
      {open && (
        <div
          id={listId}
          ref={popoverRef}
          className="gc-menu gc-branch-popover"
          role="dialog"
          aria-label={ariaLabel ?? strings.graph.branchFilterAria}
          style={{ left: `${placed.x}px`, top: `${placed.y}px`, width: `${placed.width}px` }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <div className="gc-branch-popover__search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              className="gc-branch-popover__input"
              value={query}
              placeholder={strings.graph.lanePopoverFilter}
              aria-label={strings.graph.lanePopoverFilter}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className="gc-menu__group-title" aria-hidden="true">
            {strings.graph.lanePopoverGroup}
          </span>
          <div className="gc-branch-popover__list" role="listbox" aria-label={strings.graph.lanePopoverGroup}>
            {q.length === 0 && (
              <button
                type="button"
                role="option"
                aria-selected={branchFilter === ''}
                className={
                  branchFilter === ''
                    ? 'gc-menu__item gc-menu__item--compact gc-branch-popover__option gc-branch-popover__option--selected'
                    : 'gc-menu__item gc-menu__item--compact gc-branch-popover__option'
                }
                onClick={() => pick('')}
              >
                <span className="gc-branch-popover__check" aria-hidden="true">
                  {branchFilter === '' && <Icon name="check" />}
                </span>
                <span className="gc-branch-popover__name">{strings.graph.branchFilterAll}</span>
                <span className="gc-menu__hint">{strings.graph.lanePopoverCount(lanes.length)}</span>
              </button>
            )}
            {filtered.map((entry) => {
              const selected = branchFilter === entry.value;
              return (
                <button
                  key={entry.key}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={
                    selected
                      ? 'gc-menu__item gc-menu__item--compact gc-branch-popover__option gc-branch-popover__option--selected'
                      : 'gc-menu__item gc-menu__item--compact gc-branch-popover__option'
                  }
                  onClick={() => pick(entry.value)}
                >
                  <span className="gc-branch-popover__check" aria-hidden="true">
                    {selected ? (
                      <Icon name="check" />
                    ) : (
                      <span
                        className="gc-menu__commit-dot"
                        style={entry.color ? { background: entry.color } : undefined}
                      />
                    )}
                  </span>
                  <span className="gc-branch-popover__name">{entry.label}</span>
                  {entry.count !== undefined && (
                    <span className="gc-menu__hint">{entry.count}</span>
                  )}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="gc-branch-popover__empty">{strings.branches.emptyFilter}</p>
            )}
          </div>
          <span className="gc-menu__separator" aria-hidden="true" />
          <div className="gc-branch-popover__note">
            <Icon name="info" />
            <span>{strings.graph.lanePopoverNote}</span>
          </div>
        </div>
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

        </dl>

        <h3 className="gc-legend__heading">{strings.legend.sectionRefLabels}</h3>
        <dl className="gc-legend__list">
          <dt>
            <span className="gc-chip gc-chip--current"><Icon name="git-branch" /><span>main</span></span>
          </dt>
          <dd>
            {strings.legend.currentBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--local"><Icon name="circle-filled" /><span>fitur</span></span>
          </dt>
          <dd>
            {strings.legend.localBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--remote"><Icon name="cloud" /><span>origin/main</span></span>
          </dt>
          <dd>
            {strings.legend.remoteBranchDesc}
          </dd>
          <dt>
            <span className="gc-chip gc-chip--tag"><Icon name="tag" /><span>v1.0</span></span>
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
