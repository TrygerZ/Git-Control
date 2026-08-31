/**
 * File tree with tri-state checkboxes (FEAT-02).
 *
 * Folders derive their state from their descendants (`tree.triState`) and a
 * folder toggle applies recursively (`tree.toggleNode`). Status is shown as a
 * letter, an Indonesian word, and a glyph, so nothing depends on colour.
 *
 * Accessibility
 * -------------
 * `role="treegrid"`, not `role="tree"`: a row here holds several independently
 * operable controls (checkbox, name, per-file action), which a plain tree cannot
 * express. The grid owns one tab stop; `ArrowUp`/`ArrowDown` move the row cursor,
 * `ArrowLeft`/`ArrowRight` collapse and expand, `Home`/`End` jump, and `Tab` inside
 * a focused row reaches that row's controls. Every control carries a name built
 * from the pure helpers in `format.ts`, so no button is called just "Stage".
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import {
  UNKNOWN_CHURN,
  baseName,
  churnUnknownReason,
  displayPath,
  entryStatus,
  fileRowLabel,
  folderRowLabel,
  sanitizeGitText,
  statusTone,
} from './format';
import { buildTree, collectPaths, flattenTree, triState, type FolderNode, type TreeNode } from './tree';
import type { ChangeEntry } from '../messages';

interface Props {
  entries: readonly ChangeEntry[];
  selection: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  busy: boolean;
  /** Names the surrounding section, so the treegrid is not just "Daftar perubahan". */
  label: string;
  /**
   * True when the host could not count every file's lines. Passed down rather than
   * read from the store so `format.ts` stays pure and the row titles can be tested.
   */
  churnTruncated: boolean;
  onToggleFile(path: string): void;
  onToggleFolder(node: TreeNode): void;
  onToggleCollapsed(prefix: string): void;
  onOpenDiff(entry: ChangeEntry): void;
  /** Per-file primary action, e.g. stage or unstage depending on the section. */
  fileAction: { label: string; run(entry: ChangeEntry): void } | null;
}

export function ChangeTree({
  entries,
  selection,
  collapsed,
  busy,
  label,
  churnTruncated,
  onToggleFile,
  onToggleFolder,
  onToggleCollapsed,
  onOpenDiff,
  fileAction,
}: Props): JSX.Element {
  const root: FolderNode = buildTree(entries);
  const rows = flattenTree(root, collapsed);
  const listRef = useRef<HTMLUListElement>(null);
  const [cursor, setCursor] = useState(0);

  // Rows come and go as files are staged; keep the cursor inside the list.
  useEffect(() => {
    if (cursor > rows.length - 1) setCursor(Math.max(0, rows.length - 1));
  }, [cursor, rows.length]);

  const focusRow = (index: number): void => {
    const clamped = Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
    setCursor(clamped);
    listRef.current?.querySelector<HTMLElement>(`[data-tree-row="${clamped}"]`)?.focus();
  };

  /**
   * Row-level keys. Handled on the row so a keystroke aimed at a control inside it
   * (typing is impossible here, but Space on the checkbox is not) still reaches that
   * control first; only the navigation keys are intercepted.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>, index: number): void => {
    const row = rows[index];
    if (row === undefined) return;
    const node = row.node;
    const isCollapsed = node.kind === 'folder' && collapsed.has(node.path);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRow(index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusRow(index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusRow(0);
        return;
      case 'End':
        event.preventDefault();
        focusRow(rows.length - 1);
        return;
      case 'ArrowRight':
        // Expand, or step into the first child of an already-open folder.
        if (node.kind === 'folder' && isCollapsed) {
          event.preventDefault();
          onToggleCollapsed(node.path);
        } else if (node.kind === 'folder') {
          event.preventDefault();
          focusRow(index + 1);
        }
        return;
      case 'ArrowLeft':
        if (node.kind === 'folder' && !isCollapsed) {
          event.preventDefault();
          onToggleCollapsed(node.path);
          return;
        }
        // A file (or a closed folder) steps out to its parent row.
        event.preventDefault();
        for (let i = index - 1; i >= 0; i -= 1) {
          const candidate = rows[i];
          if (candidate !== undefined && candidate.depth < row.depth) {
            focusRow(i);
            return;
          }
        }
        return;
      case 'Enter':
        event.preventDefault();
        if (node.kind === 'folder') onToggleCollapsed(node.path);
        else onOpenDiff(node.entry);
        return;
      default:
    }
  };

  return (
    <ul
      className="gc-tree"
      role="treegrid"
      aria-label={label}
      aria-rowcount={rows.length}
      ref={listRef}
    >
      {rows.map(({ node, depth }, index) => {
        const state = triState(node, selection);
        // Folder names and paths are derived from git paths, so they carry the
        // same risk as any other git-sourced string.
        const safeName = sanitizeGitText(node.name);
        const safePath = sanitizeGitText(node.path);
        const isCollapsed = node.kind === 'folder' && collapsed.has(node.path);
        const rowClasses = index === cursor ? 'gc-tree__row gc-tree__row--active' : 'gc-tree__row';
        return (
          <li
            key={`${node.kind}:${node.path}`}
            className={rowClasses}
            role="row"
            aria-level={depth + 1}
            aria-rowindex={index + 1}
            aria-selected={state === 'checked'}
            aria-expanded={node.kind === 'folder' ? !isCollapsed : undefined}
            data-tree-row={index}
            tabIndex={index === cursor ? 0 : -1}
            style={{ paddingLeft: `${depth * 14}px` }}
            onKeyDown={(event) => onKeyDown(event, index)}
            onFocus={() => setCursor(index)}
          >
            <span role="gridcell" aria-colindex={1}>
              <TriCheckbox
                state={state}
                disabled={busy}
                label={
                  node.kind === 'folder'
                    ? `Pilih semua file di folder ${safeName}`
                    : `Pilih ${safePath}`
                }
                onChange={() =>
                  node.kind === 'folder' ? onToggleFolder(node) : onToggleFile(node.path)
                }
              />
            </span>

            {node.kind === 'folder' ? (
              <span className="gc-tree__folder-cell" role="gridcell" aria-colindex={2}>
                <button
                  type="button"
                  className="gc-tree__folder"
                  aria-label={`${isCollapsed ? 'Buka' : 'Tutup'} ${folderRowLabel(
                    node.name,
                    collectPaths(node).length,
                  )}`}
                  onClick={() => onToggleCollapsed(node.path)}
                >
                  <span className="gc-tree__twisty" aria-hidden="true">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="gc-tree__name">{safeName}</span>
                </button>
              </span>
            ) : (
              <FileRow
                entry={node.entry}
                onOpenDiff={onOpenDiff}
                fileAction={fileAction}
                busy={busy}
                churnTruncated={churnTruncated}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FileRow({
  entry,
  onOpenDiff,
  fileAction,
  busy,
  churnTruncated,
}: {
  entry: ChangeEntry;
  onOpenDiff(entry: ChangeEntry): void;
  fileAction: { label: string; run(entry: ChangeEntry): void } | null;
  busy: boolean;
  churnTruncated: boolean;
}): JSX.Element {
  const status = entryStatus(entry);
  const tone = statusTone(status.code);
  const path = displayPath(entry);
  // Visible text is the basename: the row already sits under its folder, and the
  // name column ellipsises at the END, so a full path hid the one part that
  // identifies the file. `title` and the accessible name keep the full path.
  const name =
    entry.origPath === undefined || entry.origPath.length === 0
      ? baseName(entry.path)
      : `${baseName(entry.origPath)} → ${baseName(entry.path)}`;
  const churnUnknown = entry.additions === null && entry.deletions === null;
  return (
    <>
      {/*
        Four channels for one fact, and the colour is the last of them: a filled box
        (the Unity reference's `C`/`D`/`A` chip) holding the porcelain LETTER, the
        text glyph beside it, and the Indonesian word after that. Drop the colour and
        all three still read; drop the word and the letter and glyph still read.

        The composite is hidden from AT because `fileRowLabel` on the button below
        already carries all of it, in order, without repeating the letter.
      */}
      <span className="gc-tree__status" role="gridcell" aria-colindex={2} aria-hidden="true">
        <span className={`gc-status__box gc-status__box--${tone}`}>{status.code}</span>
        <span className="gc-status__glyph">{status.glyph}</span>
        <span className="gc-status__label">{status.label}</span>
      </span>
      <span role="gridcell" aria-colindex={3} className="gc-tree__file-cell">
        <button
          type="button"
          className="gc-tree__file"
          title={`${path} — klik untuk membuka diff`}
          aria-label={`Buka diff ${fileRowLabel(entry, churnTruncated)}`}
          onClick={() => onOpenDiff(entry)}
        >
          <span className="gc-tree__name">{name}</span>
        </button>
      </span>
      {entry.binary ? (
        <span className="gc-tree__binary" role="gridcell" aria-colindex={4} aria-hidden="true">
          binary
        </span>
      ) : churnUnknown ? (
        // `+0 / −0` would claim the file is unchanged; an untracked file is simply
        // absent from every diff.
        <span
          className="gc-tree__stats"
          role="gridcell"
          aria-colindex={4}
          title={churnUnknownReason(entry, churnTruncated)}
          aria-hidden="true"
        >
          <span className="gc-stat gc-stat--unknown">{UNKNOWN_CHURN}</span>
        </span>
      ) : (
        <span className="gc-tree__stats" role="gridcell" aria-colindex={4} aria-hidden="true">
          <span className="gc-stat gc-stat--add">+{entry.additions ?? 0}</span>
          <span className="gc-stat gc-stat--del">−{entry.deletions ?? 0}</span>
        </span>
      )}
      {fileAction !== null && (
        <span role="gridcell" aria-colindex={5}>
          <button
            type="button"
            className="gc-button gc-button--quiet gc-tree__action"
            // Without the path every row's button is called `Stage`, and a screen
            // reader user tabbing a long list hears the same word repeatedly.
            aria-label={`${fileAction.label} ${sanitizeGitText(entry.path)}`}
            title={
              fileAction.label === 'Stage'
                ? 'Masukkan file ini ke staging area.'
                : 'Keluarkan file ini dari staging area. Isinya tidak diubah.'
            }
            disabled={busy}
            onClick={() => fileAction.run(entry)}
          >
            {fileAction.label}
          </button>
        </span>
      )}
    </>
  );
}

/**
 * Tri-state checkbox. `indeterminate` is not an HTML attribute, so it is set on
 * the DOM node via a ref callback; `aria-checked="mixed"` carries it to AT.
 */
function TriCheckbox({
  state,
  disabled,
  label,
  onChange,
}: {
  state: 'checked' | 'unchecked' | 'indeterminate';
  disabled: boolean;
  label: string;
  onChange(): void;
}): JSX.Element {
  return (
    <input
      type="checkbox"
      className="gc-checkbox__input"
      aria-label={label}
      aria-checked={state === 'indeterminate' ? 'mixed' : state === 'checked'}
      checked={state === 'checked'}
      disabled={disabled}
      ref={(node) => {
        if (node !== null) node.indeterminate = state === 'indeterminate';
      }}
      onChange={onChange}
    />
  );
}
