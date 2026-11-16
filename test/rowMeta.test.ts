/**
 * Commit label meta line (frame 01, node `10:29`).
 *
 * The frame prints `Julia G. · 3d`, `Tryger · 12m`, `release-bot · 9d`: an author
 * and a compact age with no `ago`. The app reused the long `relativeTime`
 * sentence, so the same row read `T… · 160d ago` and the author lost its name to
 * the truncation the extra words forced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { compactAge } from '../src/webview/format';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

const now = Date.UTC(2026, 9, 31, 12, 0);
const ago = (ms: number): string => new Date(now - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('a compact age is the frame token: number plus unit, no words', () => {
  assert.equal(compactAge(ago(12 * MIN), now), '12m');
  assert.equal(compactAge(ago(5 * HOUR), now), '5h');
  assert.equal(compactAge(ago(3 * DAY), now), '3d');
  assert.equal(compactAge(ago(45 * DAY), now), '1mo');
  assert.equal(compactAge(ago(400 * DAY), now), '1y');
});

test('a fresh commit reads `now`, and an unparseable date keeps its word', () => {
  assert.equal(compactAge(ago(5_000), now), 'now');
  assert.equal(compactAge('not a date', now), 'unknown');
});

test('the commit label uses the compact age, not the long sentence', () => {
  const src = read('src/webview/GraphCanvas.tsx');
  const meta = src.slice(src.indexOf('gc-row__meta'), src.indexOf('gc-row__meta') + 400);
  assert.match(meta, /compactAge\(/, 'the meta line asks for the short form');
  assert.doesNotMatch(meta, /relativeTime\(/, 'not the sentence with `ago`');
});

test('the row label keeps the long form: a screen reader wants the sentence', () => {
  // `rowLabel` is the accessible name, where "160d ago" is clearer than "160d".
  const src = read('src/webview/format.ts');
  const label = src.slice(src.indexOf('export function rowLabel'), src.indexOf('export function refNamesLabel'));
  assert.match(label, /relativeTime\(/, 'the accessible name keeps the sentence');
});
