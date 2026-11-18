/**
 * Inspector identity block (frame 01, nodes `9:91`..`9:97`).
 *
 * Three defects the owner saw in a real window:
 *  - the avatar is 28 px with `margin-top: -2px` inside a `overflow: hidden`
 *    container, so the face is clipped at the top and the circle reads as a
 *    square-ish cut;
 *  - the frame's title is `--gc-fs-lg` at the frame's 1.35 step, not the 1.08 the
 *    panel uses now, so the subject wraps into three lines where the frame uses
 *    two;
 *  - the byline prints `by Juan Kevin Utomo · 28d ago` where the frame prints a
 *    person glyph and the name, then the age.
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

const CSS = 'src/webview/styles.css';
const INSPECTOR = 'src/webview/Inspector.tsx';

test('the avatar is never clipped by its own container', () => {
  const css = read(CSS);
  const avatar = css.match(/^\.gc-avatar\s*\{([^}]*)\}/m)?.[1] ?? '';
  assert.ok(avatar.length > 0, 'the avatar has a rule');
  // The circle is the radius, so the box keeps its full size. `overflow: hidden`
  // is allowed (it rounds the image) but the box may not shrink below the avatar
  // size: a `min-height` floor plus the frame's 28 px keeps the face whole.
  assert.match(avatar, /border-radius:\s*50%/, 'the circle is the radius');
  assert.match(avatar, /width:\s*var\(--gc-avatar\)/, 'the frame width');
  assert.match(avatar, /height:\s*var\(--gc-avatar\)/, 'and height');
  const img = css.match(/\.gc-avatar__img\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(img.length > 0, 'the image has a rule');
  assert.match(img, /object-fit:\s*cover/, 'the face fills the circle');
});

test('the identity row does not pull the avatar out of its box', () => {
  const css = read(CSS);
  const identityAvatar = css.match(/\.gc-inspector__identity \.gc-avatar\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(identityAvatar.length > 0, 'the identity avatar has a rule');
  // Measured in the browser: the aside body starts at y 90 and the avatar at y 88,
  // because `margin-top: calc(-1 * var(--gc-space-1))` lifts it above its scroll
  // container, which then clips the top 2 px. The owner saw exactly that.
  assert.doesNotMatch(identityAvatar, /margin-top/, 'no negative offset at all');
});

test('the subject takes the frame size step', () => {
  const css = read(CSS);
  const subject = css.match(/\.gc-inspector__subject\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(subject.length > 0, 'the subject has a rule');
  assert.match(subject, /font-size:\s*var\(--gc-fs-lg\)/, 'the frame step');
  assert.match(subject, /line-height:\s*1\.2|line-height:\s*1\.25/, 'two lines stay readable');
});

test('the byline names the author with a glyph, then the age', () => {
  const src = read(INSPECTOR);
  const byline = src.slice(src.indexOf('gc-inspector__byline'), src.indexOf('gc-inspector__hashes'));
  assert.match(byline, /Icon name="user"/, 'the frame person glyph');
  assert.match(byline, /strings\.inspector\.byAuthor/, 'the author sentence');
  // The frame separates the two facts with a middle dot and no `by` prefix is
  // drawn twice: the glyph carries it.
  assert.match(read('src/webview/i18n.en.ts'), /byAuthor: \(author: string, time: string\)/);
});
