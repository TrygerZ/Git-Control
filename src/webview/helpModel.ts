/**
 * Help panel row model (P17).
 *
 * Pure. The panel may only advertise features this build can actually open, so
 * the rows are filtered by the capability set the host already publishes. A row
 * carries a key into the `help` catalog namespace, never a literal sentence.
 */
import type { ChangesSub, RouteId } from '../messages';
import type { Capability } from '../quickActions';
import type { IconName } from './icons';
import { SHORTCUTS, type ShortcutEntry, type ShortcutGroupId } from './shortcuts';

export type HelpTarget =
  | { kind: 'navigate'; route: RouteId; sub?: ChangesSub; focus?: 'publish' | 'create-pr' }
  | { kind: 'openExplorer' };

export type HelpGroupId = 'everyday' | 'github' | 'organize';

export interface HelpFeatureRow {
  id: string;
  group: HelpGroupId;
  icon: IconName;
  /** Key in the `help` catalog namespace. */
  titleKey: string;
  /** Key in the `help` catalog namespace. */
  descKey: string;
  target: HelpTarget;
}

export interface ShortcutGroup {
  id: ShortcutGroupId;
  entries: readonly ShortcutEntry[];
}

/** Reading order of the shortcut groups. */
const SHORTCUT_GROUPS: readonly ShortcutGroupId[] = ['graph', 'changes', 'menus', 'anywhere'];

/**
 * Fixed row order. `gate` is the capability that must be registered for the row
 * to appear; the graph row has none because the Explorer always exists. Publish
 * and Stashes ride the `changes` route, so they are gated on `changes` too.
 */
const FEATURES: ReadonlyArray<{ row: HelpFeatureRow; gate?: Capability }> = [
  {
    row: {
      id: 'graph',
      group: 'everyday',
      icon: 'graph',
      titleKey: 'fCommitGraph',
      descKey: 'fCommitGraphDesc',
      target: { kind: 'openExplorer' },
    },
  },
  {
    gate: 'changes',
    row: {
      id: 'changes',
      group: 'everyday',
      icon: 'changes',
      titleKey: 'fChanges',
      descKey: 'fChangesDesc',
      target: { kind: 'navigate', route: 'changes' },
    },
  },
  {
    gate: 'changes',
    row: {
      id: 'publish',
      group: 'everyday',
      icon: 'cloud',
      titleKey: 'fPublish',
      descKey: 'fPublishDesc',
      target: { kind: 'navigate', route: 'changes', focus: 'publish' },
    },
  },
  {
    gate: 'prs',
    row: {
      id: 'prs',
      group: 'github',
      icon: 'pr',
      titleKey: 'fPrs',
      descKey: 'fPrsDesc',
      target: { kind: 'navigate', route: 'prs' },
    },
  },
  {
    gate: 'create-pr',
    row: {
      id: 'createPr',
      group: 'github',
      icon: 'pr',
      titleKey: 'fCreatePr',
      descKey: 'fCreatePrDesc',
      target: { kind: 'navigate', route: 'prs', focus: 'create-pr' },
    },
  },
  {
    gate: 'issues',
    row: {
      id: 'issues',
      group: 'github',
      icon: 'issue',
      titleKey: 'fIssues',
      descKey: 'fIssuesDesc',
      target: { kind: 'navigate', route: 'issues' },
    },
  },
  {
    gate: 'actions',
    row: {
      id: 'actions',
      group: 'github',
      icon: 'play',
      titleKey: 'fActions',
      descKey: 'fActionsDesc',
      target: { kind: 'navigate', route: 'actions' },
    },
  },
  {
    gate: 'branches',
    row: {
      id: 'branches',
      group: 'organize',
      icon: 'git-branch',
      titleKey: 'fBranches',
      descKey: 'fBranchesDesc',
      target: { kind: 'navigate', route: 'branches' },
    },
  },
  {
    gate: 'changes',
    row: {
      id: 'stashes',
      group: 'organize',
      icon: 'archive',
      titleKey: 'fStashes',
      descKey: 'fStashesDesc',
      target: { kind: 'navigate', route: 'changes', sub: 'stashes' },
    },
  },
];

export function helpFeatureRows(available: ReadonlySet<Capability>): HelpFeatureRow[] {
  return FEATURES.filter((feature) => feature.gate === undefined || available.has(feature.gate)).map(
    (feature) => feature.row,
  );
}

export function shortcutGroups(): ShortcutGroup[] {
  return SHORTCUT_GROUPS.map((id) => ({
    id,
    entries: SHORTCUTS.filter((entry) => entry.group === id),
  }));
}
