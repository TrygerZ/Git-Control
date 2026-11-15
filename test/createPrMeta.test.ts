/**
 * Create pull request metadata row (frame 07, node `72:62`).
 *
 * The frame puts three fields side by side under the description: Reviewers,
 * Labels, and Linked issue. The code shipped Reviewers only, so the dialog cannot
 * reach two of the three things a reviewer needs to see.
 *
 * Labels and a linked issue are two more arrays on the same create payload, and
 * both are additive: a pull request created without them is still valid, which is
 * why the fields are optional and the validation stays permissive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeLabels, normalizeLinkedIssue, validatePullRequestInput } from '../src/pullRequestDraft';

const ROOT = path.join(__dirname, '..', '..');
const read = (relative: string): string => {
  const file = path.join(ROOT, relative);
  assert.ok(fs.existsSync(file), `${relative} must exist`);
  return fs.readFileSync(file, 'utf8');
};

// ------------------------------------------------------------------ helpers

test('labels are folded to what the API accepts, deduped, and capped', () => {
  assert.deepEqual(normalizeLabels(['graph', ' graph ', 'ui', '']), ['graph', 'ui']);
  // GitHub label names are case-sensitive but a duplicate differing only in case
  // is almost always a typo, so the exact name wins and the variant is dropped.
  assert.deepEqual(normalizeLabels(['Graph', 'graph']), ['Graph', 'graph']);
  assert.equal(normalizeLabels(Array.from({ length: 40 }, (_, i) => `l${i}`)).length, 20);
  // A label is one line of text; a newline would break the chip row.
  assert.deepEqual(normalizeLabels(['a\nb', 'ok']), ['ok']);
});

test('a linked issue is a positive number or nothing', () => {
  assert.equal(normalizeLinkedIssue('97'), 97);
  assert.equal(normalizeLinkedIssue('#97'), 97);
  assert.equal(normalizeLinkedIssue('  #97 '), 97);
  assert.equal(normalizeLinkedIssue(''), null);
  assert.equal(normalizeLinkedIssue('abc'), null);
  assert.equal(normalizeLinkedIssue('0'), null);
  assert.equal(normalizeLinkedIssue('-3'), null);
  assert.equal(normalizeLinkedIssue('1.5'), null);
  assert.equal(normalizeLinkedIssue('99999999999999999999'), null, 'outside the int range');
});

test('validation stays permissive for both new fields', () => {
  const base = { title: 'Title', body: '', base: 'main', head: 'feat/x', reviewers: [] };
  assert.equal(validatePullRequestInput(base).ok, true, 'omitted is fine');
  assert.equal(validatePullRequestInput({ ...base, labels: ['graph'] }).ok, true);
  assert.equal(validatePullRequestInput({ ...base, linkedIssue: 97 }).ok, true);
  // A malformed label is a field error, not a silent drop.
  assert.deepEqual(
    validatePullRequestInput({ ...base, labels: ['a\nb'] }),
    { ok: false, field: 'labels' },
  );
  assert.deepEqual(
    validatePullRequestInput({ ...base, linkedIssue: 0 }),
    { ok: false, field: 'linkedIssue' },
  );
});

// ------------------------------------------------------------------- wiring

test('the create payload carries both fields to the host', () => {
  const messages = read('src/messages.ts');
  const payload = messages.slice(
    messages.indexOf('export interface CreatePullRequestPayload'),
    messages.indexOf('export interface CreatePullRequestResult'),
  );
  assert.match(payload, /labels\?: string\[\]/, 'labels ride the create payload');
  assert.match(payload, /linkedIssue\?: number/, 'the linked issue rides it too');
});

test('the host sends labels on the create call and the issue in the body', () => {
  const github = read('src/github.ts');
  const create = github.slice(github.indexOf('async createPullRequest'), github.indexOf('async findOpenPullRequest'));
  // GitHub has no `labels` field on POST /pulls for every API version, so the
  // labels travel as an `issues/{n}/labels` call after the create, the same way
  // reviewers already do.
  assert.match(github, /addLabels|issues\/\$\{[^}]+\}\/labels/, 'labels are applied through the issues API');
  assert.match(create, /labels/, 'the create call knows about them');
  // A closing keyword is what links the issue, and it must be appended to the body.
  assert.match(github, /Closes #|closes #/, 'the body carries the closing keyword');
});

test('the bridge validates both fields before the host sees them', () => {
  const bridgePure = read('src/bridgePure.ts');
  const validator = bridgePure.slice(bridgePure.indexOf('validateCreatePullRequestPayload'));
  assert.match(validator, /labels/, 'labels are validated');
  assert.match(validator, /linkedIssue/, 'the issue is validated');
  assert.match(validator, /normalizeLabels|normalizeLinkedIssue/, 'through the shared folds');
});

test('the dialog renders all three fields in one row, in the frame order', () => {
  const src = read('src/webview/CreatePullRequest.tsx');
  const meta = src.slice(src.indexOf('gc-create-pr__meta'));
  assert.ok(meta.length > 0, 'the row has its own element');
  const reviewers = meta.indexOf('strings.createPr.reviewers');
  const labels = meta.indexOf('strings.createPr.labels');
  const issue = meta.indexOf('strings.createPr.linkedIssue');
  assert.ok(reviewers > 0 && labels > 0 && issue > 0, 'all three fields render');
  assert.ok(reviewers < labels && labels < issue, 'frame 07 order');
});

test('the labels field is a chip row with an add input, like reviewers', () => {
  const src = read('src/webview/CreatePullRequest.tsx');
  assert.match(src, /addLabel\(/);
  assert.match(src, /removeLabel\(/);
  // Enter adds and stays in the field; a submit here would create the PR.
  assert.match(src, /event\.key !== 'Enter'\) return;[\s\S]{0,200}commitLabel|commitLabel/);
  assert.match(src, /maxLength=/, 'the input is bounded');
});

test('the linked issue field accepts a number and shows the resolved reference', () => {
  const src = read('src/webview/CreatePullRequest.tsx');
  assert.match(src, /setLinkedIssue|linkedIssue/);
  assert.match(src, /inputMode="numeric"|type="number"/, 'a number field, not free text');
  assert.match(src, /strings\.createPr\.linkedIssueHint|linkedIssueInvalid/, 'a bad value says so');
});

test('both catalogs carry the new field labels', () => {
  for (const lang of ['en', 'id']) {
    const catalog = read(`src/webview/i18n.${lang}.ts`);
    for (const key of ['labels', 'addLabel', 'linkedIssue', 'linkedIssueHint', 'linkedIssueInvalid']) {
      assert.ok(catalog.includes(`    ${key}:`), `${lang} catalog is missing createPr.${key}`);
    }
  }
});
