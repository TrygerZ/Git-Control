/**
 * Current-branch card (frame 05, node `69:64`) and the create dialog footer
 * (frame 07, node `72:112`).
 *
 * Frame 05 puts both actions inside the card: `Button/Create pull request` opens
 * the in-extension dialog, `Button/Compare` opens the GitHub compare page. The
 * code today has one external link and a create button that floated up into the
 * search row.
 *
 * Frame 07 puts `Cancel`, `Create draft`, and the primary submit side by side in
 * the footer; the draft button exists whether or not the draft switch is on, and
 * pressing it creates the pull request as a draft.
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

const PRS = 'src/webview/PullRequestsView.tsx';
const DIALOG = 'src/webview/CreatePullRequest.tsx';

test('the card owns both actions, and nothing create-shaped floats in the search row', () => {
  const src = read(PRS);
  const card = src.indexOf('gc-prs__card');
  assert.ok(card > 0, 'the card exists');
  const body = src.slice(card, card + 2600);
  assert.match(body, /startCreate|createPr\.title/, 'Create pull request lives in the card');
  assert.match(body, /compareUrl|compareAction/, 'Compare lives in the card');

  // The search row keeps the filter and nothing else.
  const search = src.slice(src.indexOf('gc-listbar'), card);
  assert.doesNotMatch(search, /startCreate/, 'no second create entry point in the search row');
});

test('Compare opens the in-extension compare sub-view for the current branch', () => {
  const src = read(PRS);
  assert.match(src, /openCompare\(/, 'Compare opens the local compare sub-view');
  assert.match(src, /navigate\(\{\s*id:\s*'branches'/, 'Compare switches to the Branches route');
  assert.doesNotMatch(src, /href=\{/, 'no raw link');
});

test('both card buttons are named and reachable without a pointer', () => {
  const src = read(PRS);
  const card = src.slice(src.indexOf('gc-prs__card'), src.indexOf('gc-prs__card') + 2600);
  // Frame 05 draws both as real buttons; neither may be hover-only.
  assert.equal((card.match(/<button/g) ?? []).length >= 2, true, 'two real buttons');
  assert.match(card, /aria-label=|>\s*\{strings\.createPr\.title\}/, 'the create button is named');
  assert.match(card, /strings\.prs\.compareAction|strings\.prs\.compareAria/, 'compare is named');
});

test('the dialog footer is Cancel, Create draft, primary, in that order', () => {
  const src = read(DIALOG);
  const footer = src.slice(src.indexOf('gc-create-pr__footer'));
  const cancel = footer.indexOf('strings.createPr.cancel');
  const draft = footer.indexOf('strings.createPr.submitDraft');
  const primary = footer.indexOf('primaryLabel');
  assert.ok(cancel > 0 && draft > 0 && primary > 0, 'all three are in the footer');
  assert.ok(cancel < draft && draft < primary, 'frame 07 order');
});

test('Create draft is a footer button that forces a draft, not a switch side effect', () => {
  const src = read(DIALOG);
  // It renders unconditionally: the frame shows it whether the switch is on or off.
  const footer = src.slice(src.indexOf('gc-create-pr__footer'));
  assert.doesNotMatch(footer, /\{draft && \(/, 'the draft button is not conditional');
  // It sets the draft flag for its own submit, so one press creates a draft even
  // when the switch was left off.
  assert.match(src, /submit\(true\)|submitAsDraft|setDraft\(true\)[\s\S]{0,200}submit\(/);
});

test('the draft switch still exists and still says what it does', () => {
  const src = read(DIALOG);
  assert.match(src, /strings\.createPr\.draft\b/);
  assert.match(src, /role="switch"/);
  assert.match(src, /setDraft\(/);
});

test('the two actions send the same requests they did, so the host is unchanged', () => {
  const src = read(DIALOG);
  // A draft submit travels on the same payload with `draft: true`; no new kind.
  assert.doesNotMatch(src, /bridge\.request\('/, 'the dialog still speaks through the store');
  const store = read('src/webview/store.ts');
  assert.match(store, /draft: true|setDraft/, 'the store owns the flag');
});

test('both catalogs carry the compare label and the draft button label', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['compareAction', 'compareAria']) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing prs.${key}`);
    }
    assert.ok(catalog.includes('    submitDraft:'), `${lang} catalog is missing createPr.submitDraft`);
  }
});
