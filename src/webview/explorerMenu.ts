/**
 * Explorer More menu model (P18).
 *
 * Pure. The component draws whatever this returns; nothing here can request,
 * navigate, or touch the host, so the menu cannot grow into a command channel.
 */
import type { Route, RouteId } from '../messages';
import { SHORTCUTS } from './shortcuts';

export type MenuItemId =
  | 'quick'
  | 'view.changes'
  | 'view.prs'
  | 'view.issues'
  | 'view.actions'
  | 'view.branches'
  | 'refresh'
  | 'logs'
  | 'github.connect'
  | 'github.disconnect'
  | 'repository';

export type MenuGroupId = 'quick' | 'views' | 'tools' | 'github' | 'repo';

export interface MoreMenuItem {
  id: MenuItemId;
  /** Route the item opens, or null when the item does something else. */
  route: Route | null;
  /** Badge number, or null to draw none. */
  count: number | null;
  /** Extra text after the label: the palette chord, or the signed-in login. */
  hint: 'shortcut' | 'login' | null;
  /** Login shown on the Disconnect row; null on every other row. */
  login: string | null;
}

export interface MoreMenuContext {
  available: ReadonlySet<RouteId>;
  quickActionsAvailable: boolean;
  counts: { changes: number | null; prs: number | null };
  github: { linked: boolean; connected: boolean; login: string | null };
}

/** Chip text for the Quick actions chord, read from the one shortcut inventory. */
export function quickActionsHint(): string {
  const row = SHORTCUTS.find((s) => s.id === 'anywhere.quick');
  return row === undefined ? '' : row.keys.join(row.joiner === '+' ? ' ' : ' / ');
}

export function buildMoreMenu(ctx: MoreMenuContext): MoreMenuItem[][] {
  const item = (
    id: MenuItemId,
    route: Route | null = null,
    count: number | null = null,
    hint: 'shortcut' | 'login' | null = null,
    login: string | null = null,
  ): MoreMenuItem => ({ id, route, count, hint, login });

  const groups: MoreMenuItem[][] = [];

  if (ctx.quickActionsAvailable) {
    groups.push([item('quick', null, null, 'shortcut')]);
  }

  const views: MoreMenuItem[] = [];
  if (ctx.available.has('changes')) {
    views.push(item('view.changes', { id: 'changes', sub: 'changes' }, ctx.counts.changes));
  }
  if (ctx.available.has('prs')) {
    views.push(item('view.prs', { id: 'prs' }, ctx.counts.prs));
  }
  if (ctx.available.has('issues')) {
    views.push(item('view.issues', { id: 'issues' }));
  }
  if (ctx.available.has('actions')) {
    views.push(item('view.actions', { id: 'actions' }));
  }
  if (ctx.available.has('branches')) {
    views.push(item('view.branches', { id: 'branches', sub: 'local' }));
  }
  if (views.length > 0) {
    groups.push(views);
  }

  groups.push([item('refresh'), item('logs')]);

  if (ctx.github.linked) {
    groups.push([
      ctx.github.connected
        ? item('github.disconnect', null, null, 'login', ctx.github.login)
        : item('github.connect'),
    ]);
  }

  groups.push([item('repository')]);

  return groups;
}
