/**
 * Commit inspector order and sections (frame 01, node `9:83`).
 *
 * The frame reads top to bottom: title with author, one row of hash chips
 * (short hash + copy, parent, GitHub), ref chips, the pull request card, the
 * description, the changed-file list, then the `Details` key-value block, then
 * `Contributors`. The app put `Details` above the refs and gave the message its
 * own scroll box, so the panel opened with metadata instead of the commit.
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

const INSPECTOR = 'src/webview/Inspector.tsx';
const CSS = 'src/webview/styles.css';

test('the sections follow the frame order: refs, PR card, message, files, details', () => {
  const src = read(INSPECTOR);
  const at = (needle: string): number => {
    const index = src.indexOf(needle);
    assert.ok(index > 0, `${needle} must render`);
    return index;
  };
  const hashes = at('gc-inspector__hashes');
  const refs = at('sectionRefs');
  const prCard = at('gc-inspector__pr-card');
  const body = at('sectionBody');
  const files = at('sectionFiles');
  const details = at('sectionDetails');

  assert.ok(refs > hashes, 'refs follow the hash row');
  assert.ok(prCard > refs, 'the pull request card follows the refs');
  assert.ok(body > prCard, 'the message follows the card');
  assert.ok(files > body, 'the changed files follow the message');
  assert.ok(details > files, 'Details closes the panel, as the frame orders it');
});

test('the parent hash sits in the hash row, not in the Details block', () => {
  const src = read(INSPECTOR);
  const hashRow = src.slice(src.indexOf('gc-inspector__hashes'), src.indexOf('gc-inspector__block'));
  assert.match(hashRow, /gc-inspector__parent/, 'the parent chip is in the hash row');
  assert.match(hashRow, /strings\.inspector\.parentChip/, 'and names itself as a parent');

  // `Details` keeps author, authored, committed; parents moved out.
  const details = src.slice(src.indexOf('sectionDetails'), src.indexOf('sectionRefs'));
  assert.doesNotMatch(details, /labelParents/, 'the parent row left Details');
});

test('the message is plain text, not a scroll box', () => {
  const css = read(CSS);
  const body = css.match(/\.gc-inspector__body\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(body.length > 0, 'the message has a rule');
  assert.doesNotMatch(body, /max-height/, 'the frame lets the panel scroll, not the message');
  assert.doesNotMatch(body, /overflow:\s*auto/, 'no nested scroller');
});

test('the changed-file heading carries its count and churn on one line', () => {
  const src = read(INSPECTOR);
  const heading = src.slice(src.indexOf('gc-inspector__block--files'), src.indexOf('gc-filelist'));
  assert.match(heading, /gc-inspector__heading-row/, 'a heading row exists');
  assert.match(heading, /formatCount\(detail\.files\.length/, 'the file count sits in the heading');
  assert.match(heading, /gc-stat--add/, 'and the additions');
  assert.match(heading, /gc-stat--del/, 'and the deletions');
});

test('both catalogs name the parent chip', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    assert.ok(catalog.includes('    parentChip:'), `${lang} catalog is missing parentChip`);
  }
});
