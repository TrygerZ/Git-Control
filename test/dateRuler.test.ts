/**
 * Date ruler (frame 01, node `10:148`).
 *
 * The frame labels each day as a calendar day and names today separately:
 * `Thu 29 Oct`, `Fri 30 Oct`, `Today · Sat 31 Oct`. The app printed numeric
 * dates (`29/10/2026`), which is a log timestamp rather than the frame's ruler.
 *
 * The label is built in the host (`src/layout.ts`) so both the ruler and the day
 * bands share one string; `formatDateLabel` is the function under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatDateLabel, formatDateLabelFor } from '../src/layout';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

/** Local noon, so a timezone west of UTC cannot roll the date backwards. */
const at = (y: number, m: number, d: number): number => new Date(y, m - 1, d, 12, 0, 0).getTime();

test('a past day reads as the frame writes it: weekday, day, short month', () => {
  assert.equal(formatDateLabel(at(2026, 10, 29), 'en'), 'Thu 29 Oct');
  assert.equal(formatDateLabel(at(2026, 10, 30), 'en'), 'Fri 30 Oct');
  assert.equal(formatDateLabel(at(2026, 1, 5), 'en'), 'Mon 5 Jan');
});

test('today is named, with the date kept beside it', () => {
  const now = at(2026, 10, 31);
  assert.equal(formatDateLabelFor(at(2026, 10, 31), now, 'en'), 'Today · Sat 31 Oct');
  // A day that is not today is never called today.
  assert.equal(formatDateLabelFor(at(2026, 10, 30), now, 'en'), 'Fri 30 Oct');
});

test('the Indonesian catalog keeps its own weekday and month names', () => {
  // The ruler is host-built, so its words live in `hostText`, not the webview
  // catalog. Both languages must answer, and neither may borrow English.
  const id = formatDateLabel(at(2026, 10, 29), 'id');
  assert.match(id, /29/);
  assert.doesNotMatch(id, /Oct/);
});

test('an unknown timestamp keeps its word instead of a 1970 date', () => {
  assert.equal(formatDateLabel(0, 'en'), 'Unknown date');
  assert.equal(formatDateLabelFor(0, at(2026, 10, 31), 'en'), 'Unknown date');
});

test('the ruler cell renders the label the layout produced', () => {
  const src = read('src/webview/GraphCanvas.tsx');
  const ruler = src.slice(src.indexOf('gc-ruler__track'), src.indexOf('gc-canvas__world'));
  assert.match(ruler, /bucket\.label/, 'the cell prints the bucket label');
  assert.doesNotMatch(ruler, /bucket\.commitCount/, 'no commit count in the ruler');
});
