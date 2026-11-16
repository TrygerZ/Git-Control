/**
 * Lane gutter text (frame 01, node `10:127`).
 *
 * Two facts the app got wrong, both visible in the same row:
 *  - the meta line printed the full ref (`refs/remotes/origin/main`) where the
 *    frame prints the tracking name (`origin/main`), so a 150 px column showed
 *    `133 commits - refs/remot...`;
 *  - the merged row's `+15 more` count is not in the frame at all: frame 01 prints
 *    one name per lane. The full list stays in the tooltip, which is not a visual
 *    difference and is what keeps 41 branches reachable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripRemotePrefix } from '../src/webview/laneGutter';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const MODEL = 'src/webview/laneGutter.ts';
const VIEW = 'src/webview/LaneGutterView.tsx';

test('an upstream lane prints the tracking name, not the full ref', () => {
  // `laneSummaries` stores `ref.upstream` straight from `for-each-ref`, which is
  // `refs/remotes/origin/main`. The frame prints `origin/main`.
  const src = read(MODEL);
  const at = src.indexOf("status = 'upstream'");
  assert.ok(at > 0, 'the upstream arm exists');
  const arm = src.slice(at, at + 400);
  assert.match(arm, /stripRemotePrefix|slice\(|stripRefPrefix/, 'the ref is shortened');
  assert.doesNotMatch(arm, /detail = upstream;/, 'the raw ref is no longer the detail');
});

test('stripRemotePrefix turns a remote-tracking ref into the frame name', () => {
  assert.equal(stripRemotePrefix('refs/remotes/origin/main'), 'origin/main');
  assert.equal(stripRemotePrefix('origin/main'), 'origin/main', 'idempotent');
  assert.equal(stripRemotePrefix('refs/remotes/up/feat/a'), 'up/feat/a');
  assert.equal(stripRemotePrefix(''), '', 'empty stays empty');
});

test('the merged row prints one name, with the full list kept in the tooltip', () => {
  const src = read(VIEW);
  // The `+N more` span is gone from the row: the frame draws the name alone.
  assert.doesNotMatch(src, /gc-gutter__more/, 'no overflow count in the row');
  assert.doesNotMatch(src, /laneMoreOthers/, 'and no string for it');
  // The tooltip still carries every name, so nothing is lost.
  assert.match(src, /row\.names\.join/, 'the tooltip lists them all');
  assert.match(src, /title=/, 'and it is a real tooltip');
});
