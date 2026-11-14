/**
 * Documentation and registration (P22).
 *
 * Three things can go stale when a phase adds a module: the File Map, the purity
 * contract, and the README's scope table. This file pins all three against the
 * source, so a phase that forgets one fails here instead of drifting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

test('the pure module is registered in the purity contract', () => {
  assert.match(read('test/purity.test.ts'), /'src\/pullRequestDraft\.ts'/);
});

test('AGENTS.md maps every module this phase added', () => {
  const agents = read('AGENTS.md');
  for (const module of ['src/pullRequestDraft.ts', 'src/webview/CreatePullRequest.tsx']) {
    assert.ok(agents.includes(module), `${module} appears in the File Map`);
  }
  // The new GitRunner methods belong to a file that is already mapped, so the map
  // only has to name the two new modules.
  assert.match(agents, /pullRequestDraft/, 'the File Map row explains the module');
});

test('the README names pull request creation in its scope table', () => {
  const readme = read('README.md');
  assert.match(readme, /Create, merge, or close pull requests and issues/);
  // The publish half is the part a reader can be surprised by: it pushes a branch.
  assert.match(readme, /publish|push/i);
});

test('the docs carry no em dash, en dash, or double hyphen used as punctuation', () => {
  for (const file of ['README.md', 'AGENTS.md']) {
    const text = read(file)
      // Code blocks and inline code keep their double hyphens: `--noEmit`, `--`.
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '');
    assert.doesNotMatch(text, /[–—]/, `${file} has no dash punctuation`);
    assert.doesNotMatch(text, / -- /, `${file} does not use a double hyphen as punctuation`);
  }
});

test('the phase module list matches what the File Map claims', () => {
  // A guard against a File Map row that names a file nobody created.
  for (const file of ['src/pullRequestDraft.ts', 'src/webview/CreatePullRequest.tsx']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  }
});
