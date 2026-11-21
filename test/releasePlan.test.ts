import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canPublish,
  defaultTitle,
  previousTag,
  releaseCommands,
  suggestNextTag,
  type ReleaseForm,
} from '../src/releasePlan';

test('suggestNextTag returns null when no semver tag exists and ignores pre-release tags', () => {
  assert.equal(suggestNextTag([], ['feat: initial']), null);
  assert.equal(suggestNextTag(['release-2026', 'v1.0.0-rc.1', 'beta'], ['feat: one']), null);
});

test('suggestNextTag picks highest semver, preserves v prefix, and applies major/minor/patch rules', () => {
  // Picks highest semver (v1.10.0 > v1.2.0) and ignores pre-release v2.0.0-alpha.1
  const minor = suggestNextTag(
    ['v1.2.0', 'v1.10.0', 'v2.0.0-alpha.1'],
    ['fix: typo', 'feat(ui): add release dialog'],
  );
  assert.ok(minor !== null);
  assert.equal(minor.name, 'v1.11.0');
  assert.equal(minor.bump, 'minor');
  assert.ok(minor.reason.length > 0);

  // Breaking change via !: triggers major bump and preserves absence of v prefix
  const majorBang = suggestNextTag(['2.3.4', '1.9.9'], ['feat(api)!: drop legacy endpoint', 'fix: bug']);
  assert.ok(majorBang !== null);
  assert.equal(majorBang.name, '3.0.0');
  assert.equal(majorBang.bump, 'major');

  // Breaking change via BREAKING CHANGE token triggers major bump
  const majorToken = suggestNextTag(['v0.9.1'], ['refactor: rewrite config BREAKING CHANGE']);
  assert.ok(majorToken !== null);
  assert.equal(majorToken.name, 'v1.0.0');
  assert.equal(majorToken.bump, 'major');

  // Only fix/chore subjects trigger patch bump
  const patch = suggestNextTag(['v2.7.0'], ['fix(git): handle empty tag', 'chore: update docs']);
  assert.ok(patch !== null);
  assert.equal(patch.name, 'v2.7.1');
  assert.equal(patch.bump, 'patch');
});

test('previousTag finds the highest semver tag before the candidate name', () => {
  assert.equal(previousTag([], 'v1.0.0'), null);
  assert.equal(previousTag(['v1.0.0', 'v1.2.0', 'v2.0.0-rc.1', 'v1.1.0'], 'v1.3.0'), 'v1.2.0');
  assert.equal(previousTag(['v1.0.0', 'v1.2.0', 'v1.5.0'], 'v1.2.0'), 'v1.0.0');
  assert.equal(previousTag(['v1.0.0'], 'v1.0.0'), null);
  assert.equal(previousTag(['v1.0.0', 'v1.1.0'], 'custom-tag'), 'v1.1.0');
});

test('releaseCommands builds exact ordered commands with explicit refs/tags refspec for both modes', () => {
  const form: ReleaseForm = {
    tag: 'v2.8.0',
    target: '9f8e7d6',
    title: 'v2.8.0',
    notes: '## Notes',
    annotated: true,
    prerelease: false,
    remote: 'origin',
  };

  const relCmds = releaseCommands(form, 'octo', 'repo', 'release');
  assert.equal(relCmds.length, 3);
  assert.equal(relCmds[0], 'git tag -a v2.8.0 9f8e7d6 -m "v2.8.0"');
  assert.equal(relCmds[1], 'git push origin refs/tags/v2.8.0:refs/tags/v2.8.0');
  assert.equal(relCmds[2], 'POST /repos/octo/repo/releases');

  const tagOnlyCmds = releaseCommands(form, 'octo', 'repo', 'tag');
  assert.equal(tagOnlyCmds.length, 2);
  assert.equal(tagOnlyCmds[0], 'git tag -a v2.8.0 9f8e7d6 -m "v2.8.0"');
  assert.equal(tagOnlyCmds[1], 'git push origin refs/tags/v2.8.0:refs/tags/v2.8.0');

  const lightCmds = releaseCommands({ ...form, annotated: false, remote: '' }, 'octo', 'repo', 'tag');
  assert.deepEqual(lightCmds, ['git tag v2.8.0 9f8e7d6']);
});

test('canPublish enforces connection and valid form fields', () => {
  const valid: ReleaseForm = {
    tag: 'v2.8.0',
    target: 'main',
    title: 'v2.8.0',
    notes: 'Notes',
    annotated: true,
    prerelease: false,
    remote: 'origin',
  };

  assert.equal(canPublish(valid, true), true);
  assert.equal(canPublish(valid, false), false, 'disconnected cannot publish');
  assert.equal(canPublish({ ...valid, tag: '-bad' }, true), false, 'invalid tag');
  assert.equal(canPublish({ ...valid, target: '-bad' }, true), false, 'invalid target');
  assert.equal(canPublish({ ...valid, title: '   ' }, true), false, 'blank title');
  assert.equal(canPublish({ ...valid, notes: 'a\u0000b' }, true), false, 'NUL in notes');
  assert.equal(canPublish({ ...valid, remote: '' }, true), false, 'missing remote');
  assert.equal(canPublish({ ...valid, target: 'a'.repeat(40) }, true), true, 'commit hash target allowed');
});

test('defaultTitle derives a clean release title from tag name and optional first note line', () => {
  assert.equal(defaultTitle('v2.8.0', null), 'v2.8.0');
  assert.equal(defaultTitle('v2.8.0', '   '), 'v2.8.0');
  assert.equal(defaultTitle('v2.8.0', '## Tags and releases'), 'v2.8.0 - Tags and releases');
  assert.equal(defaultTitle('v2.8.0', 'v2.8.0 - Already prefixed'), 'v2.8.0 - Already prefixed');
});
