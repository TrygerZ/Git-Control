/**
 * Node context menu (FEAT-03).
 *
 * Opens on right-click and from the keyboard (`ContextMenu` / `Shift+F10`).
 * Availability is derived from `status` + the selected node, so an invalid
 * action is never shown — this is cheaper to understand than a disabled list.
 *
 * Destructive items carry a risk glyph AND the word `berisiko`, never colour
 * alone. Force push is not offered here or anywhere else.
 *
 * Two groups, not one list
 * ------------------------
 * A flat list of git verbs is the most frightening thing in this extension: nothing
 * on it says which entries only LOOK at the commit and which rewrite the working
 * folder. So the items are split into `jelajah` (read-only: open the diff, copy the
 * hash, open GitHub) and `ubah` (anything that touches the repository), each in its
 * own `role="group"` with a heading. A user who only wants to read a commit never has
 * to hover over `Reset hard` to find out what it does.
 *
 * Every item also carries a `hint` naming the CONSEQUENCE rather than restating the
 * verb — `Salin hash lengkap` is obvious, "40 karakter, dipakai di perintah git atau
 * tautan" is the part worth knowing.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
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

/**
 * Which half of the menu an item belongs to.
 *
 * `jelajah` items cannot change anything — the worst case is a wasted click.
 * `ubah` items run git against the repository. The split is the whole reason the
 * grouping exists, so it is a required field: a new item has to declare which side
 * it is on rather than defaulting into the harmless half.
 */
export type MenuGroup = 'jelajah' | 'ubah';

export const MENU_GROUP_LABEL: Readonly<Record<MenuGroup, string>> = {
  jelajah: 'Lihat dan salin',
  ubah: 'Ubah repository',
};

/** One sentence per group, so the heading is a promise rather than a category name. */
export const MENU_GROUP_HINT: Readonly<Record<MenuGroup, string>> = {
  jelajah: 'Tidak mengubah apa pun di repository Anda.',
  ubah: 'Menjalankan perintah git. Sebagian akan meminta konfirmasi dulu.',
};

/** Groups in display order: read-only first, because it is the safe half. */
const MENU_GROUP_ORDER: readonly MenuGroup[] = ['jelajah', 'ubah'] as const;

export interface MenuItem {
  id: string;
  label: string;
  command: MenuCommand;
  /** Which half of the menu this belongs to; see {@link MenuGroup}. */
  group: MenuGroup;
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
 *
 * Every `hint` states what the item DOES to the user's folder or repository, in the
 * same voice as the button titles elsewhere. The order here is the order the items
 * appear within their group, so the cheap and common entries come before the ones a
 * newcomer should think about.
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
      group: 'ubah',
      hint: 'Pindah ke branch ini; isi folder kerja diganti sesuai branch tersebut.',
      command: { kind: 'action', request: { action: 'checkout-branch', branch: ref.shortName } },
    });
  }

  if (!isHead) {
    items.push({
      id: 'checkout-commit',
      label: `Checkout commit ${node.shortHash}`,
      group: 'ubah',
      hint: 'Isi folder kerja diganti sesuai commit ini, dan Anda masuk mode detached HEAD — commit baru tidak menempel pada branch mana pun.',
      risky: true,
      command: { kind: 'action', request: { action: 'checkout-commit', hash: node.hash } },
    });
  }

  items.push({
    id: 'create-branch',
    label: 'Buat branch di sini',
    group: 'ubah',
    hint: 'Menambah nama branch baru pada commit ini. Anda tetap di branch sekarang dan tidak ada file yang berubah.',
    command: { kind: 'createBranch', startPoint: node.hash },
  });

  const mergeable = branchesHere.find((r) => r.shortName !== currentBranch);
  if (mergeable !== undefined && currentBranch !== null && !busy) {
    items.push({
      id: 'merge',
      label: `Merge ${sanitizeGitText(mergeable.shortName)} ke ${sanitizeGitText(currentBranch)}`,
      group: 'ubah',
      hint: 'Menggabungkan isi branch itu ke branch aktif. Bila keduanya mengubah baris yang sama, akan muncul konflik yang harus Anda selesaikan.',
      command: { kind: 'action', request: { action: 'merge', branch: mergeable.shortName } },
    });
  }

  if (!busy) {
    items.push({
      id: 'revert',
      label: 'Revert commit ini',
      group: 'ubah',
      hint: 'Membuat commit baru yang membatalkan perubahan commit ini. Histori tetap utuh, jadi ini cara paling aman untuk mundur.',
      risky: true,
      command: { kind: 'action', request: { action: 'revert', hash: node.hash } },
    });
    items.push({
      id: 'reset-soft',
      label: 'Reset soft ke sini',
      group: 'ubah',
      hint: 'Branch pindah ke commit ini, tapi semua perubahan sesudahnya tetap tersimpan di staging area — tidak ada yang hilang.',
      risky: true,
      command: { kind: 'action', request: { action: 'reset-soft', hash: node.hash } },
    });
    items.push({
      id: 'reset-hard',
      label: 'Reset hard ke sini',
      group: 'ubah',
      hint: 'Membuang SEMUA perubahan setelah commit ini, termasuk file yang belum di-commit. Permanen — git sendiri tidak bisa mengembalikannya.',
      risky: true,
      command: { kind: 'action', request: { action: 'reset-hard', hash: node.hash } },
    });
  }

  const remote = githubRemoteName(refs);
  if (node.local && currentBranch !== null && remote !== null && !busy) {
    items.push({
      id: 'push-up-to',
      label: 'Push sampai commit ini',
      group: 'ubah',
      hint: 'Mengirim histori sampai commit ini ke remote, sehingga rekan Anda bisa melihatnya. Hanya berjalan bila fast-forward — histori remote tidak akan ditimpa.',
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
    group: 'jelajah',
    hint: 'Membuka panel detail: siapa penulisnya, pesan lengkapnya, dan file apa saja yang berubah.',
    command: { kind: 'viewDiff', hash: node.hash },
  });
  items.push({
    id: 'copy-full',
    label: 'Salin hash lengkap',
    group: 'jelajah',
    hint: '40 karakter penuh, untuk dipakai di perintah git atau tautan.',
    command: { kind: 'copy', text: node.hash, toast: 'Hash disalin.' },
  });
  items.push({
    id: 'copy-short',
    label: `Salin hash pendek (${shortHash(node.hash)})`,
    group: 'jelajah',
    hint: 'Cukup untuk menyebut commit ini di percakapan atau catatan.',
    command: { kind: 'copy', text: shortHash(node.hash), toast: 'Hash disalin.' },
  });

  if (githubUrl !== null) {
    items.push({
      id: 'open-github',
      label: 'Buka di GitHub',
      group: 'jelajah',
      hint: 'Membuka commit ini di browser. Repository lokal Anda tidak disentuh.',
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
  const items = menuItemsFor(node, status, refs, githubUrl);
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
  let flatIndex = -1;

  return (
    <div
      className="gc-menu"
      role="menu"
      aria-orientation="vertical"
      aria-label={`Tindakan untuk commit ${node.shortHash}`}
      ref={listRef}
      onKeyDown={onKeyDown}
      style={{ left: `${placed.x}px`, top: `${placed.y}px` }}
    >
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
           * the group directly keeps the tree legal and stops the heading and its
           * hint being announced a second time as stray text.
           */
          aria-label={`${MENU_GROUP_LABEL[group]}. ${MENU_GROUP_HINT[group]}`}
        >
          {/* Rule between the halves only, so the first group has no stray line. */}
          {groupIndex > 0 && <span className="gc-menu__separator" aria-hidden="true" />}
          <span className="gc-menu__group-title" aria-hidden="true">
            {MENU_GROUP_LABEL[group]}
            <span className="gc-menu__group-hint">{MENU_GROUP_HINT[group]}</span>
          </span>
          {members.map((item) => {
            flatIndex += 1;
            const index = flatIndex;
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
                    ? `${item.label} — berisiko. ${item.hint ?? ''}`.trim()
                    : undefined
                }
                className={
                  item.risky === true ? 'gc-menu__item gc-menu__item--risky' : 'gc-menu__item'
                }
                onFocus={() => setActive(index)}
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
                  <span>{item.label}</span>
                  {item.risky === true && <span className="gc-menu__risk-word">berisiko</span>}
                </span>
                {item.hint !== undefined && <span className="gc-menu__hint">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
