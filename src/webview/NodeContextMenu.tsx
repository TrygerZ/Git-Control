/**
 * Node context menu (FEAT-03).
 *
 * Opens on right-click and from the keyboard (`ContextMenu` / `Shift+F10`).
 * Availability is derived from `status` + the selected node, so an invalid
 * action is never shown — this is cheaper to understand than a disabled list.
 *
 * Destructive items carry a risk glyph AND the word `berisiko`, never colour
 * alone. Force push is not offered here or anywhere else.
 */
import { useEffect, useRef, type JSX, type KeyboardEvent } from 'react';
import { sanitizeGitText, shortHash } from './format';
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
  | { kind: 'createBranch'; startPoint: string };

export interface MenuItem {
  id: string;
  label: string;
  command: MenuCommand;
  /** `true` marks the item as destructive; the UI adds a glyph + `berisiko`. */
  risky?: boolean;
  /** Extra explanation shown under the label for teaching purposes. */
  hint?: string;
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

/** First remote-tracking ref's remote name, used as the push target. */
export function githubRemoteName(refs: readonly RefInfo[]): string | null {
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
 */
export function menuItemsFor(
  node: GraphNode,
  status: RepoStatus | null,
  refs: readonly RefInfo[],
  githubUrl: string | null,
): MenuItem[] {
  const items: MenuItem[] = [];
  const branchesHere = refs.filter((r) => r.kind === 'local' && r.objectName === node.hash);
  const currentBranch = status?.branch ?? null;
  const isHead = node.isHead;
  const busy = status !== null && status.operation !== 'idle';

  for (const ref of branchesHere) {
    if (ref.shortName === currentBranch) continue;
    items.push({
      id: `checkout-${ref.shortName}`,
      label: `Checkout branch ${sanitizeGitText(ref.shortName)}`,
      hint: 'Pindah ke branch ini.',
      command: { kind: 'action', request: { action: 'checkout-branch', branch: ref.shortName } },
    });
  }

  if (!isHead) {
    items.push({
      id: 'checkout-commit',
      label: `Checkout commit ${node.shortHash}`,
      hint: 'Masuk mode detached HEAD — commit baru tidak menempel pada branch.',
      risky: true,
      command: { kind: 'action', request: { action: 'checkout-commit', hash: node.hash } },
    });
  }

  items.push({
    id: 'create-branch',
    label: 'Buat branch di sini',
    hint: 'Membuat branch baru pada commit ini.',
    command: { kind: 'createBranch', startPoint: node.hash },
  });

  const mergeable = branchesHere.find((r) => r.shortName !== currentBranch);
  if (mergeable !== undefined && currentBranch !== null && !busy) {
    items.push({
      id: 'merge',
      label: `Merge ${sanitizeGitText(mergeable.shortName)} ke ${sanitizeGitText(currentBranch)}`,
      hint: 'Menggabungkan branch itu ke branch aktif.',
      command: { kind: 'action', request: { action: 'merge', branch: mergeable.shortName } },
    });
  }

  if (!busy) {
    items.push({
      id: 'revert',
      label: 'Revert commit ini',
      hint: 'Membuat commit pembatal. Histori tetap utuh.',
      risky: true,
      command: { kind: 'action', request: { action: 'revert', hash: node.hash } },
    });
    items.push({
      id: 'reset-soft',
      label: 'Reset soft ke sini',
      hint: 'Branch pindah, perubahan tetap di staging.',
      risky: true,
      command: { kind: 'action', request: { action: 'reset-soft', hash: node.hash } },
    });
    items.push({
      id: 'reset-hard',
      label: 'Reset hard ke sini',
      hint: 'Membuang semua perubahan setelah commit ini. Permanen.',
      risky: true,
      command: { kind: 'action', request: { action: 'reset-hard', hash: node.hash } },
    });
  }

  const remote = githubRemoteName(refs);
  if (node.local && currentBranch !== null && remote !== null && !busy) {
    items.push({
      id: 'push-up-to',
      label: 'Push sampai commit ini',
      hint: 'Mengirim histori sampai commit ini. Hanya bila fast-forward.',
      risky: true,
      command: {
        kind: 'action',
        request: { action: 'push-up-to', remote, branch: currentBranch, hash: node.hash },
      },
    });
  }

  items.push({
    id: 'view-diff',
    label: 'Lihat diff commit',
    command: { kind: 'viewDiff', hash: node.hash },
  });
  items.push({
    id: 'copy-full',
    label: 'Salin hash lengkap',
    command: { kind: 'copy', text: node.hash, toast: 'Hash disalin.' },
  });
  items.push({
    id: 'copy-short',
    label: `Salin hash pendek (${shortHash(node.hash)})`,
    command: { kind: 'copy', text: shortHash(node.hash), toast: 'Hash disalin.' },
  });

  if (githubUrl !== null) {
    items.push({
      id: 'open-github',
      label: 'Buka di GitHub',
      command: { kind: 'openGitHub', url: `${githubUrl}/commit/${node.hash}` },
    });
  }

  return items;
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
  const items = menuItemsFor(node, status, refs, githubUrl);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    const first = listRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    return () => {
      const previous = returnFocus.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

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
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    next?.focus();
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
      case 'Home': {
        event.preventDefault();
        listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        return;
      }
      case 'End': {
        event.preventDefault();
        const all = listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
        all?.[all.length - 1]?.focus();
        return;
      }
      case 'Tab':
        // A menu is not part of the tab ring; close and let focus return.
        event.preventDefault();
        onClose();
        return;
      default:
    }
  };

  return (
    <div
      className="gc-menu"
      role="menu"
      aria-label={`Tindakan untuk commit ${node.shortHash}`}
      ref={listRef}
      onKeyDown={onKeyDown}
      style={{ left: `${anchor.x}px`, top: `${anchor.y}px` }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={item.risky === true ? 'gc-menu__item gc-menu__item--risky' : 'gc-menu__item'}
          onClick={() => {
            onSelect(item);
            onClose();
          }}
        >
          <span className="gc-menu__label">
            {item.risky === true && (
              <span className="gc-menu__risk" aria-hidden="true">
                ⚠
              </span>
            )}
            {item.label}
            {item.risky === true && <span className="gc-menu__risk-word"> — berisiko</span>}
          </span>
          {item.hint !== undefined && <span className="gc-menu__hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
