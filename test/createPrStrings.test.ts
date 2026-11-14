/**
 * Create pull request strings (P22).
 *
 * `test/i18n.test.ts` already proves the two catalogs have the same keys and that
 * no value carries an en dash or an em dash. This file pins the part that test
 * cannot know: the namespace exists, every key the dialog reads is present, and
 * every function entry survives being called with two arguments, which is how the
 * parity test probes them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../src/webview/i18n';
import { hostText } from '../src/hostText';

const LANGS = ['en', 'id'] as const;

test('the createPr namespace exists in both catalogs', () => {
  for (const lang of LANGS) {
    const catalog = t(lang) as unknown as Record<string, unknown>;
    assert.ok(catalog.createPr !== undefined, `${lang} has createPr`);
  }
});

test('every string the dialog reads exists in both catalogs', () => {
  const keys = [
    'title',
    'base',
    'compare',
    'titleLabel',
    'body',
    'reviewers',
    'labels',
    'linkedIssue',
    'add',
    'draft',
    'willRun',
    'cancel',
    'submitPush',
    'submit',
    'submitDraft',
    'creating',
    'creatingOnGitHub',
    'existsTitle',
    'connectTitle',
    'connectBody',
    'publishOnly',
    'noTemplate',
    'openOnGitHub',
    'reviewersUnavailable',
    'notOnOrigin',
    'onOrigin',
    'onlyPr',
    'openN',
    'createdToast',
    'reviewersFailed',
    'summary',
    'titleCount',
    'fromTemplate',
    'existsBody',
  ] as const;
  for (const lang of LANGS) {
    const ns = t(lang).createPr as unknown as Record<string, unknown>;
    for (const key of keys) {
      assert.ok(ns[key] !== undefined, `${lang}.createPr.${key} exists`);
    }
  }
});

test('the function entries read correctly with two arguments', () => {
  assert.equal(t('en').createPr.titleCount('52', '256'), '52 / 256');
  assert.equal(t('en').createPr.openN('154'), 'Open #154');
  assert.match(t('en').createPr.createdToast('154'), /154/);
  assert.match(t('en').createPr.summary('3', '4'), /3/);
  assert.match(t('id').createPr.summary('3', '4'), /3/);
  assert.match(t('en').createPr.fromTemplate('.github/pull_request_template.md'), /pull_request_template/);
  assert.match(t('en').createPr.notOnOrigin('feat/a'), /feat\/a/);
  assert.match(t('id').createPr.notOnOrigin('feat/a'), /feat\/a/);
  assert.match(t('en').createPr.onOrigin('feat/a'), /feat\/a/);
  assert.match(t('en').createPr.existsBody('154', 'feat/a', 'main'), /154/);
  assert.match(t('en').createPr.reviewersFailed('bob'), /bob/);
});

test('no createPr value is empty', () => {
  for (const lang of LANGS) {
    const ns = t(lang).createPr as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(ns)) {
      if (typeof value === 'string') assert.ok(value.trim().length > 0, `${lang}.createPr.${key}`);
      if (typeof value === 'function') {
        const out = (value as (...args: string[]) => string)('1', '2');
        assert.ok(out.trim().length > 0, `${lang}.createPr.${key}()`);
      }
    }
  }
});

test('the host text carries the two new messages in both languages', () => {
  for (const lang of LANGS) {
    assert.ok(hostText(lang).github.prExists.length > 0, `${lang} prExists`);
    assert.ok(hostText(lang).github.prCreateFailed.length > 0, `${lang} prCreateFailed`);
  }
});
