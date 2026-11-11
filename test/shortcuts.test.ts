/**
 * Shortcut inventory (P17).
 *
 * The help panel promises keys. A promise that drifts from the handler is worse
 * than no help at all, so every listed shortcut carries evidence: a file and a
 * literal string that must still be there. The evidence map lives in this test,
 * never in the bundle, so `shortcuts.ts` stays free of file paths and code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SHORTCUTS, type ShortcutId } from '../src/webview/shortcuts';
import { t } from '../src/webview/i18n';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

interface Evidence {
  file: string;
  includes: readonly string[];
}

/**
 * Each id names the handler that proves it. `graph.pan` is the only entry whose
 * drag half is inferred: the Space flag is read in `onPointerDown`, and the
 * pointer move is the drag itself.
 */
const EVIDENCE: Record<ShortcutId, readonly Evidence[]> = {
  'graph.commit': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["case 'ArrowRight':", "case 'ArrowLeft':"] }],
  'graph.lane': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["case 'ArrowDown':", "case 'ArrowUp':"] }],
  'graph.page': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["case 'PageDown':", "case 'PageUp':"] }],
  'graph.edge': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["case 'Home':", "case 'End':"] }],
  'graph.open': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["case 'Enter':", "case ' '"] }],
  'graph.zoom': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["case '+':", "case '-':", "case '0':"] }],
  'graph.menu': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["case 'ContextMenu':", "case 'F10':"] }],
  'graph.wheelZoom': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["event.ctrlKey || event.metaKey", "addEventListener('wheel'"] }],
  'graph.pan': [{ file: 'src/webview/GraphCanvas.tsx', includes: ["event.code === 'Space'", 'onPointerMove'] }],
  'minimap.scroll': [{ file: 'src/webview/GraphMinimap.tsx', includes: ["case 'ArrowRight':", "case 'ArrowLeft':", "case 'PageDown':", "case 'PageUp':", "case 'Home':", "case 'End':"] }],
  'changes.rows': [{ file: 'src/webview/ChangeTree.tsx', includes: ["case 'ArrowDown':", "case 'ArrowUp':"] }],
  'changes.folder': [{ file: 'src/webview/ChangeTree.tsx', includes: ["case 'ArrowRight':", "case 'ArrowLeft':"] }],
  'changes.edge': [{ file: 'src/webview/ChangeTree.tsx', includes: ["case 'Home':", "case 'End':"] }],
  'changes.open': [{ file: 'src/webview/ChangeTree.tsx', includes: ["case 'Enter':"] }],
  'menu.close': [
    { file: 'src/webview/NodeContextMenu.tsx', includes: ["case 'Escape':"] },
    { file: 'src/webview/useDialogFocusTrap.ts', includes: ["event.key === 'Escape'"] },
    { file: 'src/webview/BranchLegend.tsx', includes: ["event.key === 'Escape'"] },
  ],
  'menu.move': [{ file: 'src/webview/NodeContextMenu.tsx', includes: ["case 'ArrowDown':", "case 'ArrowUp':"] }],
  'menu.edge': [{ file: 'src/webview/NodeContextMenu.tsx', includes: ["case 'Home':", "case 'End':"] }],
  'dialog.tab': [{ file: 'src/webview/useDialogFocusTrap.ts', includes: ["event.key !== 'Tab'", 'trapTabTarget('] }],
  'anywhere.quick': [{ file: 'package.json', includes: ['"command": "gitControl.quickActions"', '"key": "ctrl+k g"'] }],
};

test('every shortcut id has evidence and every evidence string is still in its file', () => {
  for (const entry of SHORTCUTS) {
    const evidence = EVIDENCE[entry.id];
    assert.ok(evidence !== undefined, `${entry.id} has no evidence`);
    for (const item of evidence) {
      const source = read(item.file);
      for (const needle of item.includes) {
        assert.ok(
          source.includes(needle),
          `${entry.id}: ${JSON.stringify(needle)} is gone from ${item.file}. Update the shortcut, do not delete the check.`,
        );
      }
    }
  }
});

test('the evidence map covers exactly the shipped ids, no orphans', () => {
  assert.deepEqual(
    [...new Set(SHORTCUTS.map((s) => s.id))].sort(),
    (Object.keys(EVIDENCE) as ShortcutId[]).sort(),
  );
});

test('every shortcut has a non-empty ASCII key chip and a known group', () => {
  const groups = new Set(['graph', 'changes', 'menus', 'anywhere']);
  for (const entry of SHORTCUTS) {
    assert.ok(entry.keys.length > 0, `${entry.id} lists no keys`);
    for (const key of entry.keys) {
      assert.ok(key.length > 0, `${entry.id} has an empty chip`);
      // eslint-disable-next-line no-control-regex
      assert.match(key, /^[\x20-\x7e]+$/, `${entry.id}: ${key} is not ASCII`);
    }
    assert.ok(groups.has(entry.group), `${entry.id}: unknown group ${entry.group}`);
    assert.ok(
      entry.joiner === 'or' || entry.joiner === '+' || entry.joiner === null,
      `${entry.id}: unknown joiner ${String(entry.joiner)}`,
    );
  }
});

test('every labelKey exists in both catalogs', () => {
  for (const entry of SHORTCUTS) {
    for (const lang of ['en', 'id'] as const) {
      const label = (t(lang).help as Record<string, unknown>)[entry.labelKey];
      assert.equal(typeof label, 'string', `${lang}.help.${entry.labelKey} is missing`);
      assert.ok((label as string).length > 0, `${lang}.help.${entry.labelKey} is empty`);
    }
  }
});

test('the Quick actions chips are the contributed chord, not a stale literal', () => {
  const manifest = JSON.parse(read('package.json')) as {
    contributes?: { keybindings?: Array<{ command?: string; key?: string }> };
  };
  const binding = (manifest.contributes?.keybindings ?? []).find(
    (b) => b.command === 'gitControl.quickActions',
  );
  assert.ok(binding?.key !== undefined, 'the quick actions chord is contributed');
  // `ctrl+k g` is a chord: Ctrl and K together, then G.
  const chips = binding.key
    .split(' ')
    .flatMap((chord) => chord.split('+'))
    .map((chip) => (chip === 'ctrl' ? 'Ctrl' : chip.toUpperCase()));
  const row = SHORTCUTS.find((s) => s.id === 'anywhere.quick');
  assert.ok(row !== undefined, 'the Anywhere row exists');
  assert.deepEqual([...row.keys], chips, 'the panel shows the contributed chord');
  assert.equal(row.joiner, '+');
});

test('the shortcut catalog copy names no key that the code does not handle', () => {
  // A `Ctrl` or `Cmd` hint in a label would promise a chord the panel does not
  // list. Only the Anywhere row may mention Ctrl, and only because it is the
  // contributed keybinding.
  for (const lang of ['en', 'id'] as const) {
    const help = t(lang).help as Record<string, unknown>;
    for (const entry of SHORTCUTS) {
      if (entry.id === 'anywhere.quick') continue;
      const label = help[entry.labelKey] as string;
      assert.doesNotMatch(label, /\b(Ctrl|Cmd)\b/, `${lang}.help.${entry.labelKey} names a chord`);
    }
  }
});
