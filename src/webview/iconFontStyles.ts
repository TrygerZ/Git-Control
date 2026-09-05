/**
 * DOM side of the icon-font `@font-face` injection, split out of `ui.tsx` so
 * the injection and cleanup paths run under `node:test` against a stub DOM.
 *
 * CSP: `style-src ${cspSource} 'nonce-…'` with no `unsafe-inline`. A
 * dynamically created `<style>` carrying the page nonce is honoured by the
 * parser — the nonce is copied from the bundle's own `<script nonce>` via the
 * `.nonce` property (`getAttribute('nonce')` is hidden in the DOM). When no
 * nonce is reachable the rules go through an adopted stylesheet, which
 * CSSOM-inserted rules are exempt from `style-src` inline checks. Neither path
 * loosens CSP.
 */

/** Fixed id for the single injected `@font-face` style element (never stacked). */
export const FONT_STYLE_ID = 'gc-icon-font-faces';

/** DOM surface the styler touches; injected so tests can fake it. */
export interface IconFontDom {
  /** Remove the style element with this id, if present. */
  removeStyle(id: string): void;
  /** Create (with nonce) or reuse the style element, then set its content. */
  setStyleContent(id: string, nonce: string, css: string): void;
  /** Nonce of the page's own CSP-protected `<script>`, when reachable. */
  scriptNonce(): string | undefined;
  adoptedSheets(): readonly CSSStyleSheet[];
  adoptSheets(sheets: readonly CSSStyleSheet[]): void;
  createSheet(): CSSStyleSheet;
}

/**
 * Apply `css` through the best available path (nonce `<style>`, else adopted
 * stylesheet); empty `css` removes everything. Returns the CSSOM sheet to
 * remember, or `undefined` when none is kept. Pure apart from `dom`: whichever
 * path a snapshot takes, the other path's residue is torn down first (H1) —
 * an old theme's `@font-face` rules must never outlive their snapshot.
 */
export function applyIconFontCss(
  dom: IconFontDom,
  css: string,
  sheet: CSSStyleSheet | undefined,
): CSSStyleSheet | undefined {
  /** Detach the remembered sheet; nothing to detach when `sheet` is undefined. */
  const detachSheet = (): CSSStyleSheet | undefined => {
    if (sheet === undefined) return undefined;
    dom.adoptSheets(dom.adoptedSheets().filter((s) => s !== sheet));
    return undefined;
  };
  if (css.length === 0) {
    dom.removeStyle(FONT_STYLE_ID);
    return detachSheet(); // H1: clear the element AND any adopted sheet
  }
  const nonce = dom.scriptNonce();
  if (typeof nonce === 'string' && nonce.length > 0) {
    const kept = detachSheet(); // no CSSOM residue from a previous snapshot
    dom.setStyleContent(FONT_STYLE_ID, nonce, css);
    return kept;
  }
  // CSSOM fallback: adoptable stylesheets are never blocked by style-src.
  dom.removeStyle(FONT_STYLE_ID); // no `<style>` residue from a previous snapshot
  const next = sheet ?? dom.createSheet();
  if (sheet === undefined) dom.adoptSheets([...dom.adoptedSheets(), next]);
  next.replaceSync(css); // exactly once, whether fresh or reused
  return next;
}

/** Real webview DOM adapter. */
const webviewDom: IconFontDom = {
  removeStyle: (id) => document.getElementById(id)?.remove(),
  setStyleContent: (id, nonce, css) => {
    let style = document.getElementById(id);
    if (style === null) {
      style = document.createElement('style');
      style.id = id;
      style.nonce = nonce;
      document.head.append(style);
    }
    style.textContent = css;
  },
  // `.nonce` property, not `getAttribute`: the DOM hides the nonce attribute
  // of CSP-protected elements, but the IDL property still reflects it.
  scriptNonce: () => (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce,
  adoptedSheets: () => document.adoptedStyleSheets,
  adoptSheets: (sheets) => {
    document.adoptedStyleSheets = [...sheets];
  },
  createSheet: () => new CSSStyleSheet(),
};

/** CSSOM fallback sheet, kept so a theme switch replaces rather than stacks. */
let fontFaceSheet: CSSStyleSheet | undefined;

/** Apply one snapshot's font-face CSS through the real webview DOM. */
export function syncIconFontCss(css: string): void {
  fontFaceSheet = applyIconFontCss(webviewDom, css, fontFaceSheet);
}
