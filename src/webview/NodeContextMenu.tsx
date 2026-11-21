/**
 * Node context menu (FEAT-03, frame 03 `15:2`).
 *
 * Opens on right-click and from the keyboard (`ContextMenu` / `Shift+F10`).
 * Availability is derived from `status` + the selected node, so an invalid
 * action is never shown — this is cheaper to understand than a disabled list.
 *
 * Destructive items carry a risk glyph AND the word `risky`, never colour alone.
 * Force push is not offered here or anywhere else.
 *
 * Three groups, in the frame order
 * --------------------------------
 * A flat list of git verbs is the most frightening thing in this extension: nothing
 * on it says which entries only LOOK at the commit and which rewrite the working
 * folder. So the items are filed as `inspect` (read-only: open the diff, copy the
 * hash, open GitHub), `branch` (move a branch to this commit), and `rewrite`
 * (rewrite history), each in its own `role="group"` with a heading. A user who only
 * wants to read a commit never has to hover over `Reset hard` to find out what it
 * does, and the read-only group can never run git.
 *
 * One focus hint, not a sub-line per row
 * --------------------------------------
 * The frame draws a single hint box under the last group (`15:91`, 286x46) that
 * explains whichever row the pointer or the keyboard cursor is on. `focusHintFor`
 * owns those sentences, so every item says something and the risky ones name the
 * risk in words rather than relying on the glyph.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { sanitizeGitText, shortHash } from './format';
import { Icon, type IconName } from './ui';
import { t, type Lang } from './i18n';
import { useT } from './useT';
import { useSettingsStore } from './store';
import type { GitActionRequest, GraphNode, RefInfo, RemoteInfo, RepoStatus } from '../messages';

export interface MenuAnchor {
  x: number;
  y: number;
}

export type MenuCommand =
  | { kind: 'action'; request: GitActionRequest }
  | { kind: 'copy'; text: string; toast: string }
  | { kind: 'openGitHub'; url: string }
  | { kind: 'viewDiff'; hash: string }
  | { kind: 'createBranch'; startPoint: string }
  | { kind: 'mergeInto'; source: string; targets: readonly string[] };

/**
 * Which of the frame's three groups an item belongs to.
 *
 * `inspect` items cannot change anything — the worst case is a wasted click.
 * `branch` items move a branch or a ref. `rewrite` items rewrite history. The
 * split is the whole reason the grouping exists, so it is a required field: a new
 * item has to declare where it goes rather than defaulting into the harmless group.
 */
export type MenuGroup = 'inspect' | 'branch' | 'rewrite';

export function menuGroupLabel(group: MenuGroup, lang: Lang = 'en'): string {
  return t(lang).menu.groupLabels[group];
}

/**
 * The leading wayfinding glyph for a menu item, keyed off its stable id.
 *
 * Purely a visual aid: the icon sits in a muted slot beside the label and is
 * `aria-hidden`, so the accessible name is unchanged. Destructive items keep their
 * own risk glyph inside the label, so their leading icon is the action verb
 * (`reset`, `revert`, ...) rather than a second warning.
 */
const MENU_ITEM_ICONS: Readonly<Record<string, IconName>> = {
  'view-diff': 'eye',
  'copy-full': 'copy',
  'copy-short': 'copy',
  'open-github': 'external',
  'create-branch': 'branch-add',
  merge: 'merge',
  'merge-into': 'merge',
  'cherry-pick': 'cherry-pick',
  revert: 'revert',
  'reset-soft': 'reset',
  'reset-hard': 'reset',
  'push-up-to': 'push',
};

/** Leading icon for a menu item, or `null` for one that carries no glyph. */
function menuItemIcon(item: MenuItem): IconName | null {
  if (item.id.startsWith('checkout-')) return item.id === 'checkout-commit' ? 'history' : 'git-branch';
  return MENU_ITEM_ICONS[item.id] ?? null;
}

/** Groups in display order, as frame 03 draws them: read-only first. */
const MENU_GROUP_ORDER: readonly MenuGroup[] = ['inspect', 'branch', 'rewrite'] as const;

export interface MenuItem {
  id: string;
  label: string;
  command: MenuCommand;
  /** Which group of the menu this belongs to; see {@link MenuGroup}. */
  group: MenuGroup;
  /** `true` marks the item as destructive; the UI adds a glyph + `risky`. */
  risky?: boolean;
  /** Extra explanation, kept for the accessible name of a risky row. */
  hint?: string;
}

/**
 * The sentence the frame 03 footer box shows for one item.
 *
 * One line each, so the box never grows into a paragraph. Items that already
 * carried a `hint` keep that text; the rest get a sentence of their own, because a
 * box that repeats one generic line for every row would be worse than none. A
 * risky item always names its risk: `permanent` for the resets, `detach` for the
 * detached checkout, `discard` for the rewrites, `risky` as the fallback.
 */
export function focusHintFor(item: MenuItem, lang: Lang = 'en'): string {
  const strings = t(lang).menu;
  if (item.hint !== undefined) return item.hint;
  switch (item.id) {
    case 'view-diff':
      return strings.hintViewDiff;
    case 'copy-full':
      return strings.hintCopyFull;
    case 'copy-short':
      return strings.hintCopyShort;
    case 'open-github':
      return strings.hintOpenGitHub;
    case 'create-branch':
      return strings.hintCreateBranch;
    case 'merge':
      return strings.hintMerge;
    default:
      if (item.id.startsWith('checkout-')) return strings.hintCheckoutBranch;
      return item.risky === true ? strings.hintRisky : strings.hintPlain;
  }
}

interface Props {
  node: GraphNode;
  status: RepoStatus | null;
  refs: readonly RefInfo[];
  /** `https://github.com/owner/repo`, or `null` when no GitHub remote exists. */
  githubUrl: string | null;
  anchor: MenuAnchor;
  onSelect(item: MenuItem): void;
  onClose(): void;
}

/** First remote-tracking ref's remote name, used as the default push/fetch remote. */
export function firstRemoteName(refs: readonly RefInfo[]): string | null {
  for (const ref of refs) {
    if (ref.kind !== 'remote') continue;
    const remote = ref.shortName.split('/')[0];
    if (remote !== undefined && remote.length > 0) return remote;
  }
  return null;
}

/**
 * Compute the menu for a node. Pure, so the availability rules are readable in
 * one place and could be unit-tested later without a DOM.
 *
 * Every ref name reaching a `label` is sanitised; the `request` keeps the raw
 * value, because that is what the host validates and passes to git. A bidi
 * override in a branch name must not be able to make one menu item read as
 * another.
 *
 * Short single-line `hint`s are provided only for items with non-obvious or
 * destructive consequences. The order here is the order the items appear within
 * their group.
 */
export function menuItemsFor(
  node: GraphNode,
  status: RepoStatus | null,
  refs: readonly RefInfo[],
  githubUrl: string | null,
  lang: Lang = 'en',
): MenuItem[] {
  const strings = t(lang).menu;
  const items: MenuItem[] = [];
  const branchesHere = refs.filter((r) => r.kind === 'local' && r.objectName === node.hash);
  const currentBranch = status?.branch ?? null;
  const isHead = node.isHead;
  const busy = status !== null && status.operation !== 'idle';

  for (const ref of branchesHere) {
    if (ref.shortName === currentBranch) continue;
    items.push({
      id: `checkout-${ref.shortName}`,
      label: strings.checkoutBranch(sanitizeGitText(ref.shortName)),
      group: 'branch',
      command: { kind: 'action', request: { action: 'checkout-branch', branch: ref.shortName } },
    });
  }

  if (!isHead) {
    items.push({
      id: 'checkout-commit',
      label: strings.checkoutCommit(node.shortHash),
      group: 'branch',
      hint: strings.checkoutCommitHint,
      risky: true,
      command: { kind: 'action', request: { action: 'checkout-commit', hash: node.hash } },
    });
  }

  if (!busy) {
    items.push({
      id: 'create-branch',
      label: strings.createBranch,
      group: 'branch',
      command: { kind: 'createBranch', startPoint: node.hash },
    });
  }

  const mergeable = branchesHere.find((r) => r.shortName !== currentBranch);
  if (mergeable !== undefined && currentBranch !== null && !busy) {
    items.push({
      id: 'merge',
      label: strings.merge(sanitizeGitText(mergeable.shortName), sanitizeGitText(currentBranch)),
      group: 'branch',
      command: { kind: 'action', request: { action: 'merge', branch: mergeable.shortName } },
    });
  }

  const localBranches = Array.from(
    new Set(refs.filter((r) => r.kind === 'local').map((r) => r.shortName)),
  ).sort((a, b) => {
    if (a === currentBranch) return -1;
    if (b === currentBranch) return 1;
    return a.localeCompare(b);
  });
  if (localBranches.length > 0 && !busy) {
    const singleBranch = branchesHere.length === 1 ? branchesHere[0] : undefined;
    const source = singleBranch !== undefined ? singleBranch.shortName : node.hash;
    items.push({
      id: 'merge-into',
      label: strings.mergeInto,
      group: 'branch',
      hint: strings.mergeIntoHint,
      risky: true,
      command: { kind: 'mergeInto', source, targets: localBranches },
    });
  }

  if (!busy) {
    items.push({
      id: 'cherry-pick',
      label: strings.cherryPick,
      group: 'rewrite',
      hint: strings.cherryPickHint,
      risky: true,
      command: { kind: 'action', request: { action: 'cherry-pick', hash: node.hash } },
    });
    items.push({
      id: 'revert',
      label: strings.revert,
      group: 'rewrite',
      hint: strings.revertHint,
      risky: true,
      command: { kind: 'action', request: { action: 'revert', hash: node.hash } },
    });
    items.push({
      id: 'reset-soft',
      label: strings.resetSoft,
      group: 'rewrite',
      hint: strings.resetSoftHint,
      risky: true,
      command: { kind: 'action', request: { action: 'reset-soft', hash: node.hash } },
    });
    items.push({
      id: 'reset-hard',
      label: strings.resetHard,
      group: 'rewrite',
      hint: strings.resetHardHint,
      risky: true,
      command: { kind: 'action', request: { action: 'reset-hard', hash: node.hash } },
    });
  }

  const remote = firstRemoteName(refs);
  if (node.local && currentBranch !== null && remote !== null && !busy) {
    items.push({
      id: 'push-up-to',
      label: strings.pushUpTo,
      group: 'branch',
      hint: strings.pushUpToHint,
      risky: true,
      command: {
        kind: 'action',
        request: { action: 'push-up-to', remote, branch: currentBranch, hash: node.hash },
      },
    });
  }

  items.push({
    id: 'view-diff',
    label: strings.viewDiff,
    group: 'inspect',
    command: { kind: 'viewDiff', hash: node.hash },
  });
  items.push({
    id: 'copy-full',
    label: strings.copyFull,
    group: 'inspect',
    command: { kind: 'copy', text: node.hash, toast: strings.toastHashCopied },
  });
  items.push({
    id: 'copy-short',
    label: strings.copyShort(shortHash(node.hash)),
    group: 'inspect',
    command: { kind: 'copy', text: shortHash(node.hash), toast: strings.toastHashCopied },
  });

  if (githubUrl !== null) {
    items.push({
      id: 'open-github',
      label: strings.openGitHub,
      group: 'inspect',
      command: { kind: 'openGitHub', url: `${githubUrl}/commit/${node.hash}` },
    });
  }

  return items;
}

/**
 * Split the flat item list into display groups, dropping any group that ended up
 * empty.
 *
 * Pure and exported so the grouping can be asserted without a DOM, and so the render
 * has no branching left to get wrong. Order inside a group is the order
 * `menuItemsFor` produced; only the groups themselves are reordered.
 */
export function groupedMenuItems(
  items: readonly MenuItem[],
): Array<{ group: MenuGroup; items: MenuItem[] }> {
  const groups: Array<{ group: MenuGroup; items: MenuItem[] }> = [];
  for (const group of MENU_GROUP_ORDER) {
    const members = items.filter((item) => item.group === group);
    if (members.length > 0) groups.push({ group, items: members });
  }
  return groups;
}

/**
 * Turn the host-parsed remotes into a browsable base URL.
 *
 * The host already parsed and credential-stripped every URL, so this only picks
 * the first GitHub remote (falling back to any parsed host, which covers GitHub
 * Enterprise) and assembles the base.
 */
export function githubBaseUrl(remotes: readonly RemoteInfo[]): string | null {
  const usable = remotes.filter((r) => r.host !== null && r.owner !== null && r.repo !== null);
  const preferred = usable.find((r) => r.isGitHub) ?? usable[0];
  if (preferred === undefined) return null;
  return `https://${preferred.host}/${preferred.owner}/${preferred.repo}`;
}

export function NodeContextMenu({
  node,
  status,
  refs,
  githubUrl,
  anchor,
  onSelect,
  onClose,
}: Props): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((x) => x.language);
  const items = menuItemsFor(node, status, refs, githubUrl, language);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);
  // Roving tabindex: exactly one item is tabbable, and the arrow keys move it.
  const [active, setActive] = useState(0);
  const [placed, setPlaced] = useState<MenuAnchor>(anchor);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    const first = listRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  /**
   * Keep the menu on screen.
   *
   * Opened from a row near the bottom edge — which is where `Shift+F10` puts it,
   * since the anchor is the row's `bottom` — a 12-item menu would otherwise run off
   * the viewport with no way to scroll to the rest.
   */
  useLayoutEffect(() => {
    const element = listRef.current;
    if (element === null) return;
    const box = element.getBoundingClientRect();
    const margin = 8;
    const maxX = window.innerWidth - box.width - margin;
    const maxY = window.innerHeight - box.height - margin;
    const x = Math.max(margin, Math.min(anchor.x, Math.max(margin, maxX)));
    const y = Math.max(margin, Math.min(anchor.y, Math.max(margin, maxY)));
    if (x !== placed.x || y !== placed.y) setPlaced({ x, y });
  }, [anchor.x, anchor.y, placed.x, placed.y]);

  // Any outside click closes; pointerdown beats the next context menu opening.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (listRef.current !== null && !listRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [onClose]);

  const move = (delta: number): void => {
    const node_ = listRef.current;
    if (node_ === null) return;
    const buttons = Array.from(node_.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = buttons.findIndex((b) => b === document.activeElement);
    const nextIndex = (index + delta + buttons.length) % buttons.length;
    setActive(nextIndex);
    buttons[nextIndex]?.focus();
  };

  const jump = (to: 'first' | 'last'): void => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const index = to === 'first' ? 0 : buttons.length - 1;
    setActive(index);
    buttons[index]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        onClose();
        return;
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      // A vertical menu closes on Left and activates on Right in the ARIA pattern;
      // there are no submenus here, so Left simply dismisses.
      case 'ArrowLeft':
        event.preventDefault();
        onClose();
        return;
      case 'Home':
        event.preventDefault();
        jump('first');
        return;
      case 'End':
        event.preventDefault();
        jump('last');
        return;
      case 'Tab':
        // A menu is not part of the tab ring; close and let focus return.
        event.preventDefault();
        onClose();
        return;
      default:
    }
  };

  /*
   * Groups, plus the flat order they render in.
   *
   * `move`/`jump` above walk `[role="menuitem"]` in DOM order, so `active` has to
   * index into that same flattened order — not into `items`, which is grouped
   * differently. Deriving both from one call keeps them from drifting.
   */
  const groups = groupedMenuItems(items);
  /** The flat render order, which is what `active` indexes and the hint box reads. */
  const flat = groups.flatMap((group) => group.items);
  const activeItem = flat[active] ?? flat[0];
  let flatIndex = -1;

  return (
    <div
      className="gc-menu"
      role="menu"
      aria-orientation="vertical"
      aria-label={strings.menu.menuAria(node.shortHash)}
      ref={listRef}
      onKeyDown={onKeyDown}
      style={{ left: `${placed.x}px`, top: `${placed.y}px` }}
    >
      <div className="gc-menu__commit-header" aria-hidden="true">
        <span
          className="gc-menu__commit-dot"
          style={node.branchColor ? { background: node.branchColor } : undefined}
        />
        <code className="gc-menu__commit-hash">{node.shortHash}</code>
        <span className="gc-menu__commit-subject">{sanitizeGitText(node.subject)}</span>
      </div>
      <span className="gc-menu__separator" aria-hidden="true" />
      {groups.map(({ group, items: members }, groupIndex) => (
        <div
          key={group}
          role="group"
          className="gc-menu__group"
          /*
           * The heading below is `aria-hidden` and the label rides here instead.
           *
           * `aria-labelledby` pointing at the heading would work, but a `menu` may
           * only own `menuitem`, `group`, and `separator`, so a visible heading node
           * inside it is already outside the pattern — hiding it from AT and naming
           * the group directly keeps the tree legal and stops the heading
           * being announced a second time as stray text.
           */
          aria-label={menuGroupLabel(group, language)}
        >
          {/* Rule between the halves only, so the first group has no stray line. */}
          {groupIndex > 0 && <span className="gc-menu__separator" aria-hidden="true" />}
          <span className="gc-menu__group-title" aria-hidden="true">
            {menuGroupLabel(group, language)}
          </span>
          {members.map((item) => {
            flatIndex += 1;
            const index = flatIndex;
            const icon = menuItemIcon(item);
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={index === active ? 0 : -1}
                // The hint is teaching copy, not a second name: it rides in
                // `aria-describedby` territory conceptually, but a menuitem cannot own a
                // description reliably across AT, so the name carries both — the risk word
                // included, because that is the fact that must not be missed.
                aria-label={
                  item.risky === true
                    ? strings.menu.riskyAria(item.label, item.hint ?? '')
                    : undefined
                }
                className={
                  item.risky === true ? 'gc-menu__item gc-menu__item--risky' : 'gc-menu__item'
                }
                onFocus={() => setActive(index)}
                onPointerEnter={() => setActive(index)}
                onClick={() => {
                  onSelect(item);
                  onClose();
                }}
              >
                {icon !== null && (
                  <span className="gc-menu__icon" aria-hidden="true">
                    <Icon name={icon} />
                  </span>
                )}
                <span className="gc-menu__body">
                  <span className="gc-menu__label">
                    {item.risky === true && (
                      <span className="gc-menu__risk" aria-hidden="true">
                        <Icon name="warning" />
                      </span>
                    )}
                    <span>{item.label}</span>
                    {item.risky === true && <span className="gc-menu__risk-word">{strings.menu.riskyWord}</span>}
                  </span>
                </span>
                {(item.id === 'view-diff' ||
                  item.id === 'copy-full' ||
                  item.id === 'create-branch') && (
                  <span className="gc-menu__hint gc-menu__shortcut" aria-hidden="true">
                    {item.id === 'view-diff'
                      ? 'Enter'
                      : item.id === 'copy-full'
                        ? 'Ctrl C'
                        : 'B'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
      {/*
        Frame 03's single hint box (`15:91`), after the last group. It names the row
        the pointer or the keyboard cursor is on, so it is a live region rather than
        decoration: a menu is one AT context and a menuitem cannot reliably own a
        description. `activeItem` falls back to the first row, which is where focus
        lands on open.
      */}
      <div className="gc-menu__focus-hint" aria-live="polite" aria-label={strings.menu.focusHintAria}>
        {activeItem === undefined ? '' : focusHintFor(activeItem, language)}
      </div>
    </div>
  );
}
