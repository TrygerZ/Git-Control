/**
 * H1 regression tests for the icon-font `@font-face` injection paths
 * (`src/webview/iconFontStyles.ts`).
 *
 * The injection logic is split out of `ui.tsx` precisely so these paths run
 * under `node:test` against a stub DOM: which path a snapshot takes (nonce
 * `<style>` element vs adopted CSSOM sheet) and — the point of H1 — that BOTH
 * paths are torn down when the snapshot becomes `null` or switches paths.
 * Parsing `ui.tsx` source (as `format.test.ts` does for JSX) could not execute
 * this logic, so a behavioural test here is the one that actually locks it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyIconFontCss, FONT_STYLE_ID, type IconFontDom } from '../src/webview/iconFontStyles';

/** Minimal CSSStyleSheet stand-in: node has no CSSOM. */
class FakeSheet {
  cssText = '';
  replaceSync(css: string): void {
    this.cssText = css;
  }
}

/** The stub DOM hands back `FakeSheet`s typed as `CSSStyleSheet`. */
function asFake(sheet: CSSStyleSheet | undefined): FakeSheet {
  assert.ok(sheet !== undefined);
  return sheet as unknown as FakeSheet;
}

interface Calls {
  removed: string[];
  styled: Array<{ id: string; nonce: string; css: string }>;
  adopted: FakeSheet[];
}

function stubDom(calls: Calls, nonce: string | undefined): IconFontDom {
  return {
    removeStyle: (id) => calls.removed.push(id),
    setStyleContent: (id, n, css) => calls.styled.push({ id, nonce: n, css }),
    scriptNonce: () => nonce,
    adoptedSheets: () => calls.adopted as unknown as readonly CSSStyleSheet[],
    adoptSheets: (sheets) => {
      calls.adopted.length = 0;
      calls.adopted.push(...(sheets as unknown as FakeSheet[]));
    },
    createSheet: () => new FakeSheet() as unknown as CSSStyleSheet,
  };
}

const CSS = "@font-face { font-family: 'gc-icon-font-seti'; src: url('u.woff') }";

test('snapshot with fonts via the nonce path sets the style element and adopts nothing', () => {
  const calls: Calls = { removed: [], styled: [], adopted: [] };
  const dom = stubDom(calls, 'abc123');
  const sheet = applyIconFontCss(dom, CSS, undefined);
  assert.equal(sheet, undefined);
  assert.deepEqual(calls.styled, [{ id: FONT_STYLE_ID, nonce: 'abc123', css: CSS }]);
  assert.deepEqual(calls.adopted, []);
  assert.deepEqual(calls.removed, []);
});

// H1 core: snapshot null (theme off) must tear down BOTH paths.
test('null snapshot clears the nonce style element AND any adopted sheet', () => {
  const calls: Calls = { removed: [], styled: [], adopted: [] };
  const dom = stubDom(calls, 'abc123');
  // A previous CSSOM snapshot left a sheet behind (e.g. nonce disappeared).
  const stale = new FakeSheet() as unknown as CSSStyleSheet;
  calls.adopted.push(stale as unknown as FakeSheet);
  const sheet = applyIconFontCss(dom, '', stale);
  assert.equal(sheet, undefined, 'no sheet may survive the null snapshot');
  assert.deepEqual(calls.removed, [FONT_STYLE_ID], 'the <style> element is removed');
  assert.deepEqual(calls.adopted, [], 'adoptedStyleSheets no longer holds the sheet');
});

test('null snapshot with no prior sheet is a no-op removal', () => {
  const calls: Calls = { removed: [], styled: [], adopted: [] };
  const dom = stubDom(calls, 'abc123');
  const sheet = applyIconFontCss(dom, '', undefined);
  assert.equal(sheet, undefined);
  assert.deepEqual(calls.removed, [FONT_STYLE_ID]);
  assert.deepEqual(calls.adopted, []);
});

test('CSSOM fallback creates exactly one sheet and replaceSync runs once per apply', () => {
  const calls: Calls = { removed: [], styled: [], adopted: [] };
  const dom = stubDom(calls, undefined); // no nonce reachable
  const sheet = asFake(applyIconFontCss(dom, CSS, undefined));
  assert.ok(sheet instanceof FakeSheet);
  assert.equal(sheet.cssText, CSS);
  assert.deepEqual(calls.adopted, [sheet]);
  // Theme switch: same sheet reused, content replaced, still a single sheet.
  const CSS2 = CSS.replace('seti', 'other');
  const reused = applyIconFontCss(dom, CSS2, sheet as unknown as CSSStyleSheet);
  assert.equal(reused, sheet, 'the remembered sheet is reused, never stacked');
  assert.deepEqual(calls.adopted, [sheet]);
  assert.equal(sheet.cssText, CSS2);
});

test('switching from the CSSOM path to the nonce path removes the adopted sheet', () => {
  const first: Calls = { removed: [], styled: [], adopted: [] };
  const sheet = asFake(applyIconFontCss(stubDom(first, undefined), CSS, undefined));
  assert.ok(sheet instanceof FakeSheet);
  // Next snapshot arrives while a nonce is now reachable; fresh call log.
  const second: Calls = { removed: [], styled: [], adopted: [sheet] };
  const kept = applyIconFontCss(stubDom(second, 'xyz'), CSS, sheet as unknown as CSSStyleSheet);
  assert.equal(kept, undefined);
  assert.deepEqual(second.removed, [], 'nothing to remove on the CSSOM→nonce switch');
  assert.deepEqual(second.adopted, [], 'old CSSOM sheet detached before the <style> takes over');
  assert.deepEqual(second.styled, [{ id: FONT_STYLE_ID, nonce: 'xyz', css: CSS }]);
});

test('switching from the nonce path to the CSSOM path removes the style element', () => {
  const first: Calls = { removed: [], styled: [], adopted: [] };
  const sheet = applyIconFontCss(stubDom(first, 'abc'), CSS, undefined);
  assert.equal(sheet, undefined);
  // Next snapshot arrives with no nonce reachable; fresh call log.
  const second: Calls = { removed: [], styled: [], adopted: [] };
  const kept = asFake(applyIconFontCss(stubDom(second, undefined), CSS, sheet));
  assert.ok(kept instanceof FakeSheet);
  assert.deepEqual(second.removed, [FONT_STYLE_ID], 'old nonce <style> removed before the sheet adopts');
  assert.deepEqual(second.styled, [], 'no <style> write happens on the CSSOM path');
  assert.deepEqual(second.adopted, [kept]);
  assert.equal(kept.cssText, CSS);
});
