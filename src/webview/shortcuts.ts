/**
 * Shortcut inventory shown by the Help panel (P17).
 *
 * Pure data. No file paths and no code references: the evidence that each key
 * still exists lives in `test/shortcuts.test.ts`, which is the only place that
 * may name a handler. `labelKey` points into the `help` catalog namespace.
 */
import type { IconName } from './icons';

export type ShortcutGroupId = 'graph' | 'changes' | 'menus' | 'anywhere';

export type ShortcutId =
  | 'graph.commit'
  | 'graph.lane'
  | 'graph.page'
  | 'graph.edge'
  | 'graph.open'
  | 'graph.zoom'
  | 'graph.menu'
  | 'graph.wheelZoom'
  | 'graph.pan'
  | 'minimap.scroll'
  | 'changes.rows'
  | 'changes.folder'
  | 'changes.edge'
  | 'changes.open'
  | 'menu.close'
  | 'menu.move'
  | 'menu.edge'
  | 'dialog.tab'
  | 'anywhere.quick';

export interface ShortcutEntry {
  id: ShortcutId;
  group: ShortcutGroupId;
  /** Key chips, in reading order. Never a chord string: the renderer joins them. */
  keys: readonly string[];
  joiner: 'or' | '+' | null;
  /** Key in the `help` catalog namespace, one per entry. */
  labelKey: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: 'graph.commit', group: 'graph', keys: ['Left', 'Right'], joiner: null, labelKey: 'skGraphCommit' },
  { id: 'graph.lane', group: 'graph', keys: ['Up', 'Down'], joiner: null, labelKey: 'skGraphLane' },
  { id: 'graph.page', group: 'graph', keys: ['PageUp', 'PageDown'], joiner: null, labelKey: 'skGraphPage' },
  { id: 'graph.edge', group: 'graph', keys: ['Home', 'End'], joiner: null, labelKey: 'skGraphEdge' },
  { id: 'graph.open', group: 'graph', keys: ['Enter', 'Space'], joiner: 'or', labelKey: 'skGraphOpen' },
  { id: 'graph.zoom', group: 'graph', keys: ['+', '-', '0'], joiner: null, labelKey: 'skGraphZoom' },
  { id: 'graph.menu', group: 'graph', keys: ['Menu', 'Shift F10'], joiner: 'or', labelKey: 'skGraphMenu' },
  { id: 'graph.wheelZoom', group: 'graph', keys: ['Ctrl', 'Scroll'], joiner: '+', labelKey: 'skGraphWheelZoom' },
  { id: 'graph.pan', group: 'graph', keys: ['Space', 'Drag'], joiner: '+', labelKey: 'skGraphPan' },
  { id: 'minimap.scroll', group: 'graph', keys: ['Left', 'Right', 'PageUp', 'PageDown', 'Home', 'End'], joiner: null, labelKey: 'skMinimapScroll' },
  { id: 'changes.rows', group: 'changes', keys: ['Up', 'Down'], joiner: null, labelKey: 'skChangesRows' },
  { id: 'changes.folder', group: 'changes', keys: ['Right', 'Left'], joiner: null, labelKey: 'skChangesFolder' },
  { id: 'changes.edge', group: 'changes', keys: ['Home', 'End'], joiner: null, labelKey: 'skChangesEdge' },
  { id: 'changes.open', group: 'changes', keys: ['Enter'], joiner: null, labelKey: 'skChangesOpen' },
  { id: 'menu.close', group: 'menus', keys: ['Esc'], joiner: null, labelKey: 'skMenuClose' },
  { id: 'menu.move', group: 'menus', keys: ['Up', 'Down'], joiner: null, labelKey: 'skMenuMove' },
  { id: 'menu.edge', group: 'menus', keys: ['Home', 'End'], joiner: null, labelKey: 'skMenuEdge' },
  { id: 'dialog.tab', group: 'menus', keys: ['Tab'], joiner: null, labelKey: 'skDialogTab' },
  { id: 'anywhere.quick', group: 'anywhere', keys: ['Ctrl', 'K', 'G'], joiner: '+', labelKey: 'skAnywhereQuick' },
];

export const SHORTCUT_GROUP_ICON: Record<ShortcutGroupId, IconName> = {
  graph: 'graph',
  changes: 'changes',
  menus: 'ellipsis',
  anywhere: 'search',
};
