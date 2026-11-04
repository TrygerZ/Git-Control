/**
 * Design token layer (plan P01).
 *
 * Checks that every `--gc-*` design token is defined in `:root`, that the layer
 * holds no colour literal, and that the Figma text pairs the layer targets reach
 * WCAG 1.4.3 (4.5:1). Theme-derived values depend on the user theme and cannot be
 * checked here; the Figma hex table below is the visual target, not shipped CSS.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS = path.join(__dirname, '..', '..', 'src', 'webview', 'styles.css');

const REQUIRED_TOKENS = [
  '--gc-bg-editor',
  '--gc-bg-sidebar',
  '--gc-bg-surface',
  '--gc-bg-raised',
  '--gc-bg-hover',
  '--gc-bg-selected',
  '--gc-bg-scrim',
  '--gc-border-default',
  '--gc-border-subtle',
  '--gc-border-strong',
  '--gc-text-primary',
  '--gc-text-secondary',
  '--gc-text-muted',
  '--gc-text-on-accent',
  '--gc-accent-primary',
  '--gc-accent-hover',
  '--gc-accent-solid',
  '--gc-status-added',
  '--gc-status-modified',
  '--gc-status-deleted',
  '--gc-status-renamed',
  '--gc-status-conflict',
  '--gc-status-added-subtle',
  '--gc-status-modified-subtle',
  '--gc-status-conflict-subtle',
  '--gc-status-renamed-subtle',
  '--gc-state-warning',
  '--gc-state-warning-subtle',
  '--gc-state-danger',
  '--gc-state-danger-subtle',
  '--gc-state-danger-solid',
  '--gc-state-success',
  '--gc-state-merged',
  '--gc-state-merged-subtle',
] as const;

function rootBlock(): { raw: string; layer: string } {
  const css = fs.readFileSync(CSS, 'utf8');
  const start = css.indexOf(':root {');
  assert.ok(start >= 0, ':root block not found');
  const end = css.indexOf('\n}', start);
  assert.ok(end > start, ':root block is not closed');
  const raw = css.slice(start, end);
  const marker = raw.indexOf('Design token layer');
  assert.ok(marker >= 0, '"Design token layer" comment not found in :root');
  const commentStart = raw.lastIndexOf('/*', marker);
  return { raw, layer: raw.slice(commentStart).replace(/\/\*[\s\S]*?\*\//g, '') };
}

// ---------------------------------------------------------------- contrast

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Composite `fg` at `alpha` over opaque `bg`. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const mix = (i: 0 | 1 | 2): number => Math.round(fg[i] * alpha + bg[i] * (1 - alpha));
  return [mix(0), mix(1), mix(2)];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

test('contrastRatio returns 21:1 for black on white and 1:1 for equal colours', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), 21);
  assert.equal(contrastRatio([128, 64, 32], [128, 64, 32]), 1);
});

test('over composites alpha onto an opaque background', () => {
  assert.deepEqual(over([255, 255, 255], 0.5, [0, 0, 0]), [128, 128, 128]);
  assert.deepEqual(over([10, 20, 30], 1, [0, 0, 0]), [10, 20, 30]);
});

// ------------------------------------------------------------- definitions

test('every design token is defined inside :root', () => {
  const { raw } = rootBlock();
  const missing = REQUIRED_TOKENS.filter((name) => !new RegExp(`^\\s*${name}\\s*:`, 'm').test(raw));
  assert.deepEqual(missing, [], `tokens missing from :root:\n${missing.join('\n')}`);
});

test('the design token layer defines nothing beyond the required list', () => {
  const { layer } = rootBlock();
  const defined = [...layer.matchAll(/^\s*(--gc-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
  assert.deepEqual([...defined].sort(), [...REQUIRED_TOKENS].sort());
});

test('the design token layer holds no colour literal', () => {
  const { layer } = rootBlock();
  const offenders = [...layer.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/g)].map((m) => m[0]);
  assert.deepEqual(offenders, []);
});

// ------------------------------------------------------------- Figma pairs

type Paint = readonly [hex: string, alpha: number];
type Mode = 'Dark' | 'Light';

/** Figma "GC Tokens" values read 2026-11-03; only the tokens the pair checks use. */
const FIGMA: Record<Mode, Record<string, Paint>> = {
  Dark: {
    'bg/sidebar': ['#181818', 1],
    'text/primary': ['#e8e8e8', 1],
    'text/secondary': ['#ababab', 1],
    'text/muted': ['#959595', 1],
    'text/on-accent': ['#ffffff', 1],
    'accent/solid': ['#0078d4', 1],
    'border/strong': ['#ffffff', 0.22],
  },
  Light: {
    'bg/sidebar': ['#f3f3f3', 1],
    'text/primary': ['#1f1f1f', 1],
    'text/secondary': ['#55565a', 1],
    'text/muted': ['#6b6c70', 1],
    'text/on-accent': ['#ffffff', 1],
    'accent/solid': ['#0b63d6', 1],
    'border/strong': ['#000000', 0.26],
  },
};

function ratio(mode: Mode, fg: string, bg: string): number {
  const table = FIGMA[mode];
  const [bgHex, bgAlpha] = table[bg] ?? assert.fail(`no Figma value for ${bg}`);
  const [fgHex, fgAlpha] = table[fg] ?? assert.fail(`no Figma value for ${fg}`);
  assert.equal(bgAlpha, 1, `${bg} must be opaque`);
  return contrastRatio(over(parseHex(fgHex), fgAlpha, parseHex(bgHex)), parseHex(bgHex));
}

const TEXT_PAIRS: ReadonlyArray<readonly [fg: string, bg: string]> = [
  ['text/primary', 'bg/sidebar'],
  ['text/secondary', 'bg/sidebar'],
  ['text/muted', 'bg/sidebar'],
  ['text/on-accent', 'accent/solid'],
];

for (const mode of ['Dark', 'Light'] as const) {
  for (const [fg, bg] of TEXT_PAIRS) {
    test(`Figma ${mode}: ${fg} on ${bg} reaches 4.5:1`, () => {
      const r = ratio(mode, fg, bg);
      assert.ok(r >= 4.5, `${r.toFixed(2)}:1`);
    });
  }
}

/**
 * Pairs the Figma values miss on purpose of record. The entry fails the test once
 * Figma is fixed (follow-up F-10), which is the signal to delete it.
 */
const KNOWN_DESIGN_GAPS: ReadonlyArray<{ fg: string; bg: string; min: number; reason: string }> = [
  {
    fg: 'border/strong',
    bg: 'bg/sidebar',
    min: 3,
    reason: 'control outline is about 2:1 on the sidebar, below WCAG 1.4.11 (F-10)',
  },
];

for (const mode of ['Dark', 'Light'] as const) {
  for (const gap of KNOWN_DESIGN_GAPS) {
    test(`Figma ${mode}: ${gap.fg} on ${gap.bg} is a recorded gap below ${gap.min}:1`, () => {
      const r = ratio(mode, gap.fg, gap.bg);
      assert.ok(r < gap.min, `${r.toFixed(2)}:1 now meets ${gap.min}:1; remove the entry (${gap.reason})`);
    });
  }
}
