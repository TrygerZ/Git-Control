/**
 * Explorer top bar (frame 01, node `9:3`).
 *
 * The frame draws ONE 48 px row: logo, repository wordmark, chevron, branch chip,
 * short hash, a divider, a state dot, and the branch's standing against the remote
 * (`Not published · 3 local commits`). Fetch, Pull, and Publish sit at the far end
 * of that same row, and Help and More follow them.
 *
 * The implementation stacked three rows (crumbs, `Last commit: ...`, sync sentence)
 * in 82 px, which pushed the graph down and made the header read as a panel rather
 * than a title bar. These contracts pin the single-row shape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const UI = 'src/webview/ui.tsx';
const CSS = 'src/webview/styles.css';

/** The `ContextBar` body, so a match cannot come from a neighbour. */
function contextBar(): string {
  const src = read(UI);
  const start = src.indexOf('export function ContextBar');
  assert.ok(start > 0, 'ContextBar exists');
  return src.slice(start, src.indexOf('\n}\n', start));
}

test('the context bar is one row: logo, wordmark, chevron, chip, hash, status', () => {
  const bar = contextBar();
  // The frame's 24 px logo, then the wordmark, then the chevron the frame draws
  // between them. The chevron already exists as `gc-context__sep`.
  assert.match(bar, /gc-context__logo/, 'the logo tile is drawn');
  assert.match(bar, /<Icon name="git-branch"/, 'and it carries the branch glyph');
  assert.match(bar, /gc-context__sep/, 'the chevron separates wordmark from chip');
  assert.match(bar, /gc-context__repo/, 'the wordmark is the repository name');
  assert.match(bar, /gc-chip--current|gc-chip--detached/, 'the branch chip follows');
  assert.match(bar, /gc-context__hash/, 'then the short hash');
  assert.match(bar, /gc-context__dot/, 'the state dot precedes the sentence');

  // One row means one child line: the subject paragraph and the separate sync
  // paragraph are what made three rows out of one.
  assert.doesNotMatch(bar, /gc-context__subject/, 'no subject line');
  assert.doesNotMatch(bar, /strings\.ui\.lastCommit/, 'the last-commit sentence is gone');
  assert.doesNotMatch(bar, /gc-context__sync\b/, 'no stacked sync paragraph');
});

test('the standing against the remote reads as the frame writes it', () => {
  const bar = contextBar();
  // Frame 01: `Not published · 3 local commits`. The count is the commits that
  // exist only on this machine, which is the `local` flag the layout already sets.
  assert.match(bar, /strings\.ui\.notPublished/, 'the unpublished state is named');
  assert.match(bar, /strings\.ui\.localCommits/, 'and the local commit count is shown');
  assert.match(bar, /localCommits/, 'the count arrives as a prop, not recomputed here');

  const app = read('src/webview/ExplorerApp.tsx');
  assert.match(app, /localCommits=\{/, 'the Explorer supplies the count');
  assert.match(app, /\.local\)/, 'from the graph nodes that are local only');
});

test('the top bar is 48 px tall and lays its children out in a row', () => {
  const css = read(CSS);
  const top = css.match(/\.gc-explorer__top\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(top.length > 0, 'the top container has a rule');
  assert.match(top, /min-height:\s*(48px|var\(--gc-space-8\))/, 'the frame height');
  assert.match(top, /flex-direction:\s*row/, 'one row');
  assert.match(top, /align-items:\s*center/);

  const bar = css.match(/\.gc-context\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(bar.length > 0, 'the bar has a rule');
  assert.match(bar, /flex-direction:\s*row/, 'the crumbs sit on one line');
  assert.match(bar, /align-items:\s*center/);
  assert.doesNotMatch(bar, /flex-direction:\s*column/, 'never a stack');

  // A row that cannot wrap is what keeps it one line at any width.
  assert.match(bar, /flex-wrap:\s*nowrap|white-space:\s*nowrap/, 'the row does not wrap');
});

test('both catalogs carry the unpublished state and its count', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['notPublished', 'localCommits']) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing ${key}`);
    }
  }
});
