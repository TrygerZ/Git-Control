/**
 * Issue branch name helpers (P09).
 *
 * The title and labels are untrusted: GitHub hands them to us and they end up in
 * a git argument, so every case here is about what survives the fold and what
 * cannot reach `git switch --create`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANCH_SLUG_MAX,
  branchNameProblem,
  slugifyTitle,
  startWorkRequest,
  suggestBranchName,
  type IssueRef,
} from '../src/webview/issueBranch';
import { validateBranchName } from '../src/validation';

function issue(over: Partial<IssueRef> & { number: number }): IssueRef {
  return { title: 'Lane gutter should show push state per branch', labels: [], ...over };
}

// ------------------------------------------------------------------- slugify

test('slugifyTitle folds a plain ASCII title to hyphenated words', () => {
  // Fold only: the 40 character default would cut this one, so the cap is raised here
  // and pinned separately below.
  assert.equal(
    slugifyTitle('Lane gutter should show push state per branch', 80),
    'lane-gutter-should-show-push-state-per-branch',
  );
});

test('slugifyTitle caps at BRANCH_SLUG_MAX by default', () => {
  const slug = slugifyTitle('one two three four five six seven eight nine ten');
  assert.equal(slug, 'one-two-three-four-five-six-seven-eight');
  assert.ok(slug.length <= BRANCH_SLUG_MAX);
});

test('slugifyTitle collapses punctuation runs instead of hyphenating each mark', () => {
  assert.equal(slugifyTitle('Fix: crash on save!! (again)'), 'fix-crash-on-save-again');
  assert.equal(slugifyTitle('a.b/c\\d'), 'a-b-c-d');
});

test('slugifyTitle folds accented letters to ASCII and keeps the rest of the word', () => {
  assert.equal(slugifyTitle('Perbaikan tampilan'), 'perbaikan-tampilan');
  assert.equal(slugifyTitle('Café résumé'), 'cafe-resume');
});

test('slugifyTitle returns an empty string for titles with no usable character', () => {
  assert.equal(slugifyTitle(''), '');
  assert.equal(slugifyTitle('   '), '');
  assert.equal(slugifyTitle('🚀 🎉'), '');
  assert.equal(slugifyTitle('修复登录问题'), '');
});

test('slugifyTitle trims leading and trailing separators', () => {
  assert.equal(slugifyTitle('--- hello ---'), 'hello');
  assert.equal(slugifyTitle('...hello...'), 'hello');
});

test('slugifyTitle strips control and bidi characters rather than passing them through', () => {
  assert.equal(slugifyTitle('safe\u0000name'), 'safe-name');
  assert.equal(slugifyTitle('a‮b'), 'a-b');
});

test('slugifyTitle cuts a long title at the cap on a word boundary', () => {
  const long = slugifyTitle('alpha beta gamma delta epsilon zeta eta theta iota kappa', 20);
  assert.ok(long.length <= 20, long);
  assert.ok(!long.endsWith('-'), 'no trailing hyphen after the cut');
  assert.equal(long, 'alpha-beta-gamma');
});

test('slugifyTitle never returns more than the cap, even for one unbroken word', () => {
  const long = slugifyTitle('a'.repeat(120), 12);
  assert.equal(long, 'a'.repeat(12));
});

// -------------------------------------------------------------- suggestion

test('suggestBranchName reproduces the frame 93 sample', () => {
  // Frame 93 drops the filler words: "should show" and "per branch" do not reach the
  // name. The fold itself keeps them, which is why the trim lives here and not in
  // `slugifyTitle`.
  assert.equal(
    suggestBranchName(issue({ number: 97 })),
    'feat/97-lane-gutter-push-state',
  );
});

test('suggestBranchName keeps a title whose words are all content', () => {
  assert.equal(
    suggestBranchName(issue({ number: 12, title: 'Graph ribbons overlap lanes' })),
    'feat/12-graph-ribbons-overlap-lanes',
  );
});

test('suggestBranchName falls back to the number when the title is only filler words', () => {
  assert.equal(suggestBranchName(issue({ number: 5, title: 'The of and per should' })), 'feat/5');
});

/**
 * "branch" is the one word that is only dropped at the END. The frame 93 sample ends
 * in "per branch", but an issue ABOUT branches must keep the word, or the name stops
 * naming the thing.
 */
test('suggestBranchName drops a trailing "branch" and keeps one that carries meaning', () => {
  assert.equal(
    suggestBranchName(issue({ number: 30, title: 'Branch list is slow' })),
    'feat/30-branch-list-is-slow',
  );
  assert.equal(
    suggestBranchName(issue({ number: 31, title: 'Rename branch' })),
    'feat/31-rename',
  );
  assert.equal(
    suggestBranchName(issue({ number: 32, title: 'Branches panel is empty' })),
    'feat/32-branches-panel-is-empty',
    'only the singular trailing word is dropped',
  );
});

test('suggestBranchName prefixes fix/ when a bug label is present, whatever its case', () => {
  assert.equal(
    suggestBranchName(issue({ number: 88, title: 'Change rows feel cramped', labels: ['bug'] })),
    'fix/88-change-rows-feel-cramped',
  );
  assert.equal(
    suggestBranchName(issue({ number: 88, title: 'Change rows feel cramped', labels: ['Bug'] })),
    'fix/88-change-rows-feel-cramped',
  );
  assert.equal(
    suggestBranchName(issue({ number: 88, title: 'Change rows feel cramped', labels: ['BUG', 'ui'] })),
    'fix/88-change-rows-feel-cramped',
  );
});

test('suggestBranchName falls back to the type and number when the title has no usable character', () => {
  assert.equal(suggestBranchName(issue({ number: 97, title: '修复登录问题' })), 'feat/97');
  assert.equal(suggestBranchName(issue({ number: 97, title: '🚀', labels: ['bug'] })), 'fix/97');
});

test('every suggestion passes validateBranchName', () => {
  const titles = [
    'Lane gutter should show push state per branch',
    'Fix: crash on save!! (again)',
    'Café résumé',
    '修复登录问题',
    '--- hello ---',
    'a.b/c\\d',
    'a'.repeat(200),
    'refs/heads/x',
    'a..b',
    '@',
    '-dash',
    'x y',
    'HEAD',
  ];
  for (const title of titles) {
    for (const labels of [[], ['bug']] as const) {
      const name = suggestBranchName({ number: 1, title, labels });
      assert.equal(validateBranchName(name), true, `${title} -> ${name}`);
    }
  }
});

test('200 random titles never produce a name that fails validateBranchName', () => {
  let seed = 20261107;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const alphabet = 'abcXYZ019 -_./\\:@{}~^?*[]é🚀\u0000‮';
  for (let i = 0; i < 200; i += 1) {
    const length = next() % 60;
    let title = '';
    for (let j = 0; j < length; j += 1) title += alphabet[next() % alphabet.length];
    const name = suggestBranchName({ number: next() % 1000, title, labels: next() % 2 === 0 ? ['bug'] : [] });
    assert.equal(validateBranchName(name), true, JSON.stringify(title) + ' -> ' + name);
  }
});

// ---------------------------------------------------------------- problems

test('branchNameProblem reports the first thing wrong with a name', () => {
  assert.equal(branchNameProblem('', []), 'empty');
  assert.equal(branchNameProblem('   ', []), 'empty');
  assert.equal(branchNameProblem('-x', []), 'invalid');
  assert.equal(branchNameProblem('a..b', []), 'invalid');
  assert.equal(branchNameProblem('a b', []), 'invalid');
  assert.equal(branchNameProblem('refs/heads/x', []), 'invalid');
  assert.equal(branchNameProblem('feat/97-lane-gutter', ['main', 'feat/97-lane-gutter']), 'exists');
  assert.equal(branchNameProblem('feat/97-lane-gutter', ['main']), null);
});

test('branchNameProblem compares against local branches exactly, not by prefix', () => {
  assert.equal(branchNameProblem('feat/97', ['feat/97-lane']), null);
  assert.equal(branchNameProblem('feat/97-lane', ['feat/97-lane']), 'exists');
});

// --------------------------------------------------------------- request

test('startWorkRequest builds the exact create-branch payload', () => {
  assert.deepEqual(startWorkRequest('feat/97-lane-gutter', 'a'.repeat(40)), {
    action: 'create-branch',
    name: 'feat/97-lane-gutter',
    startPoint: 'a'.repeat(40),
  });
});

test('startWorkRequest refuses an unknown HEAD and an unusable name', () => {
  assert.equal(startWorkRequest('feat/97', null), null);
  assert.equal(startWorkRequest('', 'a'.repeat(40)), null);
  assert.equal(startWorkRequest('a..b', 'a'.repeat(40)), null);
});

test('the slug cap is the documented 40 characters', () => {
  assert.equal(BRANCH_SLUG_MAX, 40);
});
