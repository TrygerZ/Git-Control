/**
 * Pull request draft builder and input validation (P22).
 *
 * Everything the dialog prefills is decided here, so the cases pin the two rules
 * that are easy to get wrong: a single commit names the pull request (the branch
 * name is a worse title than the commit the author just wrote), and a template
 * wins over the generated bullet list but only when it has content.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BODY_MAX,
  REVIEWERS_MAX,
  TITLE_MAX,
  buildDraft,
  humanizeBranch,
  normalizeReviewers,
  normalizeTemplate,
  validatePullRequestInput,
} from '../src/pullRequestDraft';

// ------------------------------------------------------------------- title

test('one commit uses its own subject as the title', () => {
  const draft = buildDraft([{ subject: 'fix(graph): cull nodes by world x' }], null, 'feat/cull-nodes');
  assert.equal(draft.title, 'fix(graph): cull nodes by world x');
});

test('many commits fall back to the branch name, because no single subject describes them', () => {
  const draft = buildDraft(
    [{ subject: 'one' }, { subject: 'two' }, { subject: 'three' }],
    null,
    'feat/graph-ribbons',
  );
  assert.equal(draft.title, 'Graph ribbons');
});

test('no commits and no template still produces a usable title', () => {
  const draft = buildDraft([], null, 'fix/empty-branch');
  assert.equal(draft.title, 'Empty branch');
  assert.equal(draft.body, '');
});

test('humanizeBranch drops the type prefix and sentence-cases the slug', () => {
  assert.equal(humanizeBranch('feat/graph-ribbons'), 'Graph ribbons');
  assert.equal(humanizeBranch('fix/123-broken-header'), '123 broken header');
  assert.equal(humanizeBranch('chore/vscode-file-icon-theme'), 'Vscode file icon theme');
  assert.equal(humanizeBranch('main'), 'Main');
  // A nested name keeps only the last segment: `team/feat/x` describes `x`.
  assert.equal(humanizeBranch('team/feat/lane-gutter'), 'Lane gutter');
  // Nothing to humanize: the raw name is better than an empty title.
  assert.equal(humanizeBranch('---'), '---');
  assert.equal(humanizeBranch(''), '');
});

test('a very long branch name is cut to the title limit', () => {
  const branch = `feat/${'a'.repeat(TITLE_MAX + 40)}`;
  assert.equal(buildDraft([], null, branch).title.length, TITLE_MAX);
});

test('a single commit whose subject exceeds the limit is cut too', () => {
  const draft = buildDraft([{ subject: 'x'.repeat(TITLE_MAX + 10) }], null, 'feat/long');
  assert.equal(draft.title.length, TITLE_MAX);
});

// -------------------------------------------------------------------- body

test('a template is used verbatim when it has content', () => {
  const template = '## Summary\n\n- one\n\n## Testing\n\n- [ ] npm test\n';
  const draft = buildDraft([{ subject: 'one' }, { subject: 'two' }], template, 'feat/a');
  assert.equal(draft.body, template.trimEnd());
});

test('an empty or whitespace template falls back to the commit list', () => {
  for (const template of ['', '   \n\t\n']) {
    const draft = buildDraft([{ subject: 'one' }, { subject: 'two' }], template, 'feat/a');
    assert.equal(draft.body, '- one\n- two');
  }
});

test('the fallback body is one bullet per commit, in the order git returned them', () => {
  const draft = buildDraft(
    [{ subject: 'add ribbon geometry' }, { subject: 'move lanes' }, { subject: 'test it' }],
    null,
    'feat/a',
  );
  assert.equal(draft.body, '- add ribbon geometry\n- move lanes\n- test it');
});

test('normalizeTemplate folds CRLF and trims trailing whitespace', () => {
  assert.equal(normalizeTemplate('## Summary\r\n\r\n- one\r\n'), '## Summary\n\n- one');
  assert.equal(normalizeTemplate('  \r\n\r\n'), '');
});

test('a body over the limit is cut rather than rejected', () => {
  const template = 'x'.repeat(BODY_MAX + 100);
  assert.equal(buildDraft([], template, 'feat/a').body.length, BODY_MAX);
});

// --------------------------------------------------------------- reviewers

test('reviewers are deduped, trimmed, and capped', () => {
  assert.deepEqual(normalizeReviewers(['ann', ' bob ', 'ann', 'BOB']), ['ann', 'bob', 'BOB']);
  const many = Array.from({ length: REVIEWERS_MAX + 5 }, (_, i) => `user${i}`);
  assert.equal(normalizeReviewers(many).length, REVIEWERS_MAX);
});

test('a reviewer that cannot be a GitHub login is dropped', () => {
  assert.deepEqual(
    normalizeReviewers(['ok-login', 'bad login', 'bad/login', '-leading', 'x'.repeat(40), '']),
    ['ok-login'],
  );
});

// -------------------------------------------------------------- validation

const valid = {
  title: 'A title',
  body: 'A body',
  base: 'main',
  head: 'feat/a',
  reviewers: ['ann'],
};

test('a well formed input passes', () => {
  assert.deepEqual(validatePullRequestInput(valid), { ok: true });
});

test('the title must be present and bounded', () => {
  assert.deepEqual(validatePullRequestInput({ ...valid, title: '' }), { ok: false, field: 'title' });
  assert.deepEqual(validatePullRequestInput({ ...valid, title: '   ' }), { ok: false, field: 'title' });
  assert.deepEqual(validatePullRequestInput({ ...valid, title: 'x'.repeat(TITLE_MAX) }), { ok: true });
  assert.deepEqual(validatePullRequestInput({ ...valid, title: 'x'.repeat(TITLE_MAX + 1) }), {
    ok: false,
    field: 'title',
  });
});

test('control characters in the title are rejected, because a PR title is one line', () => {
  assert.deepEqual(validatePullRequestInput({ ...valid, title: 'a\u0007b' }), { ok: false, field: 'title' });
  assert.deepEqual(validatePullRequestInput({ ...valid, title: 'a\nb' }), { ok: false, field: 'title' });
  // The body is multiline by nature, so newlines are fine there but NUL is not.
  assert.deepEqual(validatePullRequestInput({ ...valid, body: 'a\nb\tc' }), { ok: true });
  assert.deepEqual(validatePullRequestInput({ ...valid, body: 'a\u0000b' }), { ok: false, field: 'body' });
});

test('the body is bounded', () => {
  assert.deepEqual(validatePullRequestInput({ ...valid, body: 'x'.repeat(BODY_MAX) }), { ok: true });
  assert.deepEqual(validatePullRequestInput({ ...valid, body: 'x'.repeat(BODY_MAX + 1) }), {
    ok: false,
    field: 'body',
  });
});

test('base and head must be branch names and must differ', () => {
  assert.deepEqual(validatePullRequestInput({ ...valid, base: '-x' }), { ok: false, field: 'base' });
  assert.deepEqual(validatePullRequestInput({ ...valid, head: 'feat/..' }), { ok: false, field: 'head' });
  assert.deepEqual(validatePullRequestInput({ ...valid, head: 'main' }), { ok: false, field: 'head' });
});

test('reviewers are validated against the login rule and the cap', () => {
  assert.deepEqual(validatePullRequestInput({ ...valid, reviewers: ['bad login'] }), {
    ok: false,
    field: 'reviewers',
  });
  const many = Array.from({ length: REVIEWERS_MAX + 1 }, (_, i) => `user${i}`);
  assert.deepEqual(validatePullRequestInput({ ...valid, reviewers: many }), {
    ok: false,
    field: 'reviewers',
  });
  // Duplicates are not a validation failure: the caller normalizes them first.
  assert.deepEqual(validatePullRequestInput({ ...valid, reviewers: ['ann', 'ann'] }), { ok: true });
});

test('non-string fields are rejected rather than coerced', () => {
  const bad = validatePullRequestInput({ ...valid, title: 42 as unknown as string });
  assert.deepEqual(bad, { ok: false, field: 'title' });
});
