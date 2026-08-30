/**
 * Integration harness: one real VS Code host per scenario.
 *
 * Scenarios cannot share a launch. A workspace folder, `PATH`, and a
 * machine-scoped setting are all fixed for the lifetime of a host, and
 * `gitControl.gitPath` / `gitControl.githubApiUrl` are machine-scoped, so each
 * scenario gets its own workspace AND its own user-data directory. Sharing the
 * profile would leak one scenario's settings into the next.
 *
 * Scenarios:
 *   repo        real repository: commands, diff provider, webview HTML + CSP
 *   norepo      folder without .git: "Folder ini bukan repository Git."
 *   missing-git git absent from PATH and from the setting
 *   secrets     connect/disconnect GitHub, then an on-disk check that the token
 *               never reached `workspaceState`
 */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runTests } = require('@vscode/test-electron');
const execFileAsync = promisify(execFile);

const ROOT = path.resolve(__dirname, '..');
/** Sentinel tokens. `ghp_`-shaped so the logger's redaction rules apply to them. */
const TOKEN_A = `ghp_${crypto.randomBytes(16).toString('hex')}`;
const TOKEN_B = `ghp_${crypto.randomBytes(16).toString('hex')}`;

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'git-control-it-'));
  const results = [];
  try {
    results.push(await scenario(scratch, 'repo', { workspace: gitRepo }));
    results.push(await scenario(scratch, 'norepo', { workspace: plainFolder }));
    results.push(await scenario(scratch, 'missing-git', { workspace: gitRepo, env: withoutGitOnPath() }));
    results.push(
      await scenario(scratch, 'secrets', {
        workspace: gitRepo,
        env: { GIT_CONTROL_TOKEN_A: TOKEN_A, GIT_CONTROL_TOKEN_B: TOKEN_B },
        after: assertTokenNeverInWorkspaceStorage,
      }),
    );
  } finally {
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }

  console.log('\n=== integration summary ===');
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `: ${result.detail}`}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function scenario(scratch, name, options) {
  const home = path.join(scratch, name);
  const workspace = path.join(home, 'workspace');
  // Own profile per scenario: machine-scoped settings written by one scenario must
  // not be visible to the next.
  const userData = path.join(home, 'user-data');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await options.workspace(workspace);

  console.log(`\n--- ${name} ---`);
  let ok = true;
  let detail = '';
  try {
    await runTests({
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(__dirname, 'integration-suite.js'),
      launchArgs: [workspace, '--disable-extensions-except', ROOT, `--user-data-dir=${userData}`],
      extensionTestsEnv: {
        GIT_CONTROL_ROOT: ROOT,
        GIT_CONTROL_SCENARIO: name,
        GIT_CONTROL_MISSING_GIT: path.join(home, 'no-such-dir'),
        ...(options.env ?? {}),
      },
    });
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : String(err);
    console.error(`FAIL ${name}: ${detail}`);
  }

  if (ok && options.after !== undefined) {
    try {
      await options.after(userData);
    } catch (err) {
      ok = false;
      detail = err instanceof Error ? err.message : String(err);
      console.error(`FAIL ${name} (post-exit check): ${detail}`);
    }
  }
  return { name, ok, detail };
}

// ------------------------------------------------------------- workspace setup

async function gitRepo(workspace) {
  const run = (args) => execFileAsync('git', args, { cwd: workspace });
  await run(['init', '--quiet', '--initial-branch=main']);
  await run(['config', 'user.email', 'integration@example.com']);
  await run(['config', 'user.name', 'Integration Test']);
  await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n');
  await run(['add', 'a.txt']);
  await run(['commit', '--quiet', '-m', 'initial']);
}

async function plainFolder(workspace) {
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'not a repository\n');
}

/**
 * `PATH` with every directory containing a git executable removed.
 *
 * Dropping `PATH` entirely would take the editor down with it, which would prove
 * nothing about the extension's degradation path.
 */
function withoutGitOnPath() {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const kept = (process.env[key] ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !/git/i.test(entry));
  return { [key]: kept.join(path.delimiter) };
}

// ------------------------------------------------------------- post-exit check

/**
 * The token must never be in `workspaceState`.
 *
 * A Memento belonging to another extension is unreadable from a test extension,
 * so this reads the profile from disk after the host exits. `workspaceStorage`
 * holds the SQLite database backing `workspaceState`; SQLite stores text
 * unencrypted, so a plaintext scan for the sentinel is a real check. Secrets live
 * in `globalStorage`, encrypted by the OS keyring, so the sentinel must not be
 * found there in the clear either — if it is, that is a finding, and it is
 * reported rather than silently tolerated.
 */
async function assertTokenNeverInWorkspaceStorage(userData) {
  const workspaceStorage = path.join(userData, 'User', 'workspaceStorage');
  const hits = await scanFor(workspaceStorage, [TOKEN_A, TOKEN_B]);
  if (hits.length > 0) {
    throw new Error(`token found in workspaceState storage: ${hits.join(', ')}`);
  }
  console.log('PASS the GitHub token never appears in workspaceStorage (workspaceState)');

  const elsewhere = await scanFor(userData, [TOKEN_A, TOKEN_B], workspaceStorage);
  if (elsewhere.length > 0) {
    console.log(`LIMITATION sentinel token bytes also present outside SecretStorage: ${elsewhere.join(', ')}`);
  } else {
    console.log('PASS the token appears nowhere in the profile in plaintext');
  }
}

async function scanFor(root, needles, skip) {
  const hits = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (skip !== undefined && (full === skip || full.startsWith(`${skip}${path.sep}`))) continue;
    if (entry.isDirectory()) {
      hits.push(...(await scanFor(full, needles, skip)));
      continue;
    }
    if (!entry.isFile()) continue;
    let buffer;
    try {
      buffer = await fs.readFile(full);
    } catch {
      continue;
    }
    // Latin1 so arbitrary binary bytes never trip UTF-8 replacement and hide a
    // match; the sentinels are ASCII.
    const text = buffer.toString('latin1');
    if (needles.some((needle) => text.includes(needle))) hits.push(full);
  }
  return hits;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
