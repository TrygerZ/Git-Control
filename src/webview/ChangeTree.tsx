/**
 * File tree with tri-state checkboxes (FEAT-02).
 *
 * Folders derive their state from their descendants (`tree.triState`) and a
 * folder toggle applies recursively (`tree.toggleNode`). Status is shown as a
 * letter, an Indonesian word, and a glyph, so nothing depends on colour.
 */
import { type JSX } from 'react';
import { displayPath, entryStatus, sanitizeGitText } from './format';
import { buildTree, flattenTree, triState, type FolderNode, type TreeNode } from './tree';
import type { ChangeEntry } from '../messages';

interface Props {
  entries: readonly ChangeEntry[];
  selection: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  busy: boolean;
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
  onToggleFile,
  onToggleFolder,
  onToggleCollapsed,
  onOpenDiff,
  fileAction,
}: Props): JSX.Element {
  const root: FolderNode = buildTree(entries);
  const rows = flattenTree(root, collapsed);

  return (
    <ul className="gc-tree" role="tree" aria-label="Daftar perubahan">
      {rows.map(({ node, depth }) => {
        const state = triState(node, selection);
        // Folder names and paths are derived from git paths, so they carry the
        // same risk as any other git-sourced string.
        const safeName = sanitizeGitText(node.name);
        const safePath = sanitizeGitText(node.path);
        return (
          <li
            key={`${node.kind}:${node.path}`}
            className="gc-tree__row"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={state === 'checked'}
            aria-expanded={node.kind === 'folder' ? !collapsed.has(node.path) : undefined}
            style={{ paddingLeft: `${depth * 14}px` }}
          >
            <TriCheckbox
              state={state}
              disabled={busy}
              label={node.kind === 'folder' ? `Pilih semua di ${safeName}` : `Pilih ${safePath}`}
              onChange={() => (node.kind === 'folder' ? onToggleFolder(node) : onToggleFile(node.path))}
            />

            {node.kind === 'folder' ? (
              <button
                type="button"
                className="gc-tree__folder"
                onClick={() => onToggleCollapsed(node.path)}
              >
                <span aria-hidden="true">{collapsed.has(node.path) ? '▸' : '▾'}</span>
                <span className="gc-tree__name">{safeName}</span>
              </button>
            ) : (
              <FileRow entry={node.entry} onOpenDiff={onOpenDiff} fileAction={fileAction} busy={busy} />
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
}: {
  entry: ChangeEntry;
  onOpenDiff(entry: ChangeEntry): void;
  fileAction: { label: string; run(entry: ChangeEntry): void } | null;
  busy: boolean;
}): JSX.Element {
  const status = entryStatus(entry);
  return (
    <>
      <span className="gc-tree__status">
        <span className="gc-status__glyph" aria-hidden="true">
          {status.glyph}
        </span>
        <code className="gc-status__code">{status.code}</code>
        <span className="gc-status__label">{status.label}</span>
      </span>
      <button
        type="button"
        className="gc-tree__file"
        title={displayPath(entry)}
        onClick={() => onOpenDiff(entry)}
      >
        <span className="gc-tree__name">{displayPath(entry)}</span>
      </button>
      {entry.binary ? (
        <span className="gc-tree__binary">binary</span>
      ) : (
        <span className="gc-tree__stats">
          <span className="gc-stat gc-stat--add">+{entry.additions ?? 0}</span>
          <span className="gc-stat gc-stat--del">−{entry.deletions ?? 0}</span>
        </span>
      )}
      {fileAction !== null && (
        <button
          type="button"
          className="gc-button gc-button--quiet"
          disabled={busy}
          onClick={() => fileAction.run(entry)}
        >
          {fileAction.label}
        </button>
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
