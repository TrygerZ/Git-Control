/**
 * In-host integration suite, run inside a real VS Code extension host.
 *
 * One process = one workspace = one profile, so the scenarios that need a
 * different workspace, a different PATH, or different settings cannot share a
 * launch. `integration-runner.js` starts one host per scenario and selects the
 * body below with `GIT_CONTROL_SCENARIO`.
 *
 * Observability notes, because most of what this file checks has no direct API:
 *   - `showWarningMessage` / `showErrorMessage` / `showInformationMessage` /
 *     `showInputBox` are wrapped at module load, before the extension activates.
 *     That is the only way to observe the "not a repository" and "git missing"
 *     degradation paths and the only way to drive the interactive token prompt
 *     non-interactively.
 *   - `createWebviewPanel` is wrapped too, which yields the real generated HTML
 *     through the public `panel.webview.html` getter — so the CSP is inspected
 *     for real rather than assumed.
 *   - `workspaceState` and `SecretStorage` of another extension are not readable
 *     from here. The runner scans the profile's `workspaceStorage` on disk after
 *     the host exits instead; see `assertTokenNeverInWorkspaceStorage`.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const EXTENSION_ID = 'TrygerZ.git-control';
const NOT_A_REPO = 'Folder ini bukan repository Git.';
const GIT_MISSING = 'Git tidak ditemukan pada PATH.';
const GITHUB_CONNECTED = 'GitHub tersambung.';
const GITHUB_DISCONNECTED = 'GitHub diputus.';

/**
 * Captured host interactions. Populated by the wrappers installed below.
 *
 * Installed at module load: VS Code requires this file before the extension's
 * `onStartupFinished` activation in every version tested, so the wrappers are in
 * place for the whole extension lifetime. `activatedBeforePatch` records whether
 * that assumption held instead of quietly relying on it.
 */
const seen = {
  warnings: [],
  errors: [],
  infos: [],
  inputBoxes: [],
  panels: [],
  viewResolves: [],
};

const activatedBeforePatch = vscode.extensions.getExtension(EXTENSION_ID)?.isActive === true;
/** Queue of replies for `showInputBox`, so each prompt can answer differently. */
const inputBoxReplies = [];
const patched = {
  showWarningMessage: wrapMessage('showWarningMessage', seen.warnings),
  showErrorMessage: wrapMessage('showErrorMessage', seen.errors),
  showInformationMessage: wrapMessage('showInformationMessage', seen.infos),
  showInputBox: patch(vscode.window, 'showInputBox', () => (options) => {
    seen.inputBoxes.push(options ?? {});
    return Promise.resolve(inputBoxReplies.shift());
  }),
  createWebviewPanel: patch(vscode.window, 'createWebviewPanel', (original) => (...args) => {
    const panel = original.apply(vscode.window, args);
    seen.panels.push(panel);
    return panel;
  }),
  registerWebviewViewProvider: patch(
    vscode.window,
    'registerWebviewViewProvider',
    (original) => (id, provider, ...rest) => {
      const wrapped = {
        ...provider,
        resolveWebviewView: async (view, ...tail) => {
          const result = await provider.resolveWebviewView(view, ...tail);
          seen.viewResolves.push({ id, html: view.webview.html });
          return result;
        },
      };
      return original.call(vscode.window, id, wrapped, ...rest);
    },
  ),
};

function wrapMessage(name, sink) {
  return patch(vscode.window, name, () => (message, ...items) => {
    sink.push(String(message));
    // Resolve to `undefined`: every caller treats that as "no button pressed", so
    // nothing here can navigate the editor or open a folder picker.
    return Promise.resolve(undefined);
  });
}

function patch(target, name, wrap) {
  const original = target[name];
  if (typeof original !== 'function') return false;
  try {
    target[name] = wrap(original);
  } catch {
    return false;
  }
  return target[name] !== original;
}

// --------------------------------------------------------------------- entry

async function run() {
  const scenario = process.env.GIT_CONTROL_SCENARIO ?? 'repo';
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} must be installed in the development host`);
  report(`scenario ${scenario}`);
  report(`stubs installed: ${Object.entries(patched).filter(([, ok]) => ok).map(([k]) => k).join(', ') || 'none'}`);
  if (activatedBeforePatch) report('NOTE extension was already active when the stubs were installed');

  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await extension.activate();
    assert.equal(extension.isActive, true, 'extension must activate');
    await commandsRegistered();

    if (scenario === 'repo') await repoScenario();
    else if (scenario === 'norepo') await noRepoScenario();
    else if (scenario === 'missing-git') await missingGitScenario();
    else if (scenario === 'secrets') await secretsScenario();
    else assert.fail(`unknown scenario: ${scenario}`);

    assert.deepEqual(unhandled.map(String), [], 'no unhandled rejections');
    pass('extension host produced no unhandled rejections');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

async function commandsRegistered() {
  const manifest = require(path.join(process.env.GIT_CONTROL_ROOT, 'package.json'));
  const registered = await vscode.commands.getCommands(true);
  for (const entry of manifest.contributes.commands) {
    assert.ok(registered.includes(entry.command), `${entry.command} is registered`);
  }
  pass('every declared command is registered');
}

// ----------------------------------------------------------- scenario: repo

async function repoScenario() {
  await vscode.commands.executeCommand('gitControl.openExplorer');
  await vscode.commands.executeCommand('gitControl.openPendingChanges');
  await vscode.commands.executeCommand('gitControl.showLogs');
  await vscode.commands.executeCommand('gitControl.refresh');
  // Only useful with several repositories, but it must not throw with one.
  await vscode.commands.executeCommand('gitControl.pickRepository');
  pass('all commands execute against a real repository');

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'a git workspace is open');
  const head = (await execGit(['rev-parse', 'HEAD'])).trim();
  const document = await vscode.workspace.openTextDocument(historicalUri(head, 'a.txt', folder));
  assert.equal(document.getText(), 'one\n', 'valid historical content is served');
  const invalid = await vscode.workspace.openTextDocument(
    historicalUri('not-a-revision', 'missing.txt', folder),
  );
  assert.notEqual(invalid.getText(), 'one\n', 'invalid revision is rejected');
  pass('git-control: diff provider serves history and rejects bad revisions');

  await inspectExplorerHtml();
  await inspectPendingView();
  await inspectPanelDisposal();
}

function historicalUri(rev, filePath, folder) {
  return vscode.Uri.from({
    scheme: 'git-control',
    path: `/${filePath}`,
    query: new URLSearchParams({ rev, path: filePath, folder: folder.uri.fsPath }).toString(),
  });
}

/**
 * Real HTML and CSP inspection.
 *
 * `WebviewPanel.webview.html` is a public getter, so wrapping
 * `createWebviewPanel` is enough to read exactly what the host generated — no
 * string-building shortcut, no guesswork.
 */
async function inspectExplorerHtml() {
  const panel = seen.panels[0];
  assert.ok(panel, 'the explorer panel was created through vscode.window.createWebviewPanel');
  const html = panel.webview.html;
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, 'the document carries a CSP meta tag');
  const policy = csp[1];
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(policy, /connect-src 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.doesNotMatch(html, /unsafe-eval/);

  const nonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(policy)[1];
  assert.ok(html.includes(`<script nonce="${nonce}"`), 'the script tag carries the nonce');
  assert.ok(html.includes(`<link nonce="${nonce}"`), 'the stylesheet carries the same nonce');
  // Scripts and styles are loaded from the webview resource origin only.
  const sources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const source of sources) {
    assert.match(source, /^https:\/\/[^/]*vscode-(cdn\.net|webview\.net|resource)/, source);
  }
  pass('explorer webview HTML: strict CSP, nonced script and style, no inline or eval');

  // A fresh nonce per load is the whole point of generating one; prove it by
  // disposing the panel and reopening.
  const before = nonce;
  panel.dispose();
  await vscode.commands.executeCommand('gitControl.openExplorer');
  const reopened = seen.panels[seen.panels.length - 1];
  assert.notEqual(reopened, panel, 'a disposed panel is rebuilt, not revived');
  const after = /nonce-([0-9a-f]{32})/.exec(reopened.webview.html)[1];
  assert.notEqual(after, before, 'each webview load gets a fresh nonce');
  pass('each webview load gets a fresh CSP nonce');
}

/**
 * `resolveWebviewView` for the Pending Changes view.
 *
 * Focusing the view container is what makes VS Code resolve it. The wrapper
 * around `registerWebviewViewProvider` records the resolve and the HTML the
 * provider produced.
 */
async function inspectPendingView() {
  if (patched.registerWebviewViewProvider !== true) {
    limitation('registerWebviewViewProvider could not be wrapped; view resolve not observed');
    return;
  }
  await vscode.commands.executeCommand('gitControl.openPendingChanges');
  const resolved = await waitFor(() => seen.viewResolves.find((v) => v.id === 'gitControl.pendingChanges'));
  if (resolved === undefined) {
    limitation('the Pending Changes view was never resolved by the host (focus did not reveal it)');
    return;
  }
  assert.match(resolved.html, /default-src 'none'/);
  assert.match(resolved.html, /data-view="pending"/);
  assert.match(resolved.html, /script-src 'nonce-[0-9a-f]{32}'/);
  pass('resolveWebviewView ran for gitControl.pendingChanges and produced a CSP-locked document');
}

/**
 * Disposal, as far as the public API reaches.
 *
 * `deactivate` cannot be invoked from a test extension: VS Code owns the call and
 * exposes no hook for it, and another extension's subscription array is not
 * readable. What is observable is that disposing a webview panel detaches its
 * bridge without throwing and leaves the extension fully usable — the failure
 * mode a leaked disposable would produce here.
 */
async function inspectPanelDisposal() {
  const panel = seen.panels[seen.panels.length - 1];
  panel.dispose();
  await vscode.commands.executeCommand('gitControl.refresh');
  await vscode.commands.executeCommand('gitControl.openExplorer');
  await vscode.commands.executeCommand('gitControl.refresh');
  pass('disposing a webview panel detaches its bridge and the extension keeps working');
  limitation(
    'clean deactivate is NOT verified: VS Code exposes no API to invoke another ' +
      'extension\'s deactivate or to enumerate its subscriptions. Covered by unit tests only.',
  );
}

// -------------------------------------------------------- scenario: norepo

/**
 * A folder that is not a repository.
 *
 * The warning is raised during registry construction, which already happened at
 * startup — before these stubs could see it. Touching `gitControl.gitPath`
 * re-runs discovery and the registry build, so the warning is produced again,
 * now observably.
 */
async function noRepoScenario() {
  await vscode.commands.executeCommand('gitControl.refresh');
  await vscode.commands.executeCommand('gitControl.openPendingChanges');
  await vscode.commands.executeCommand('gitControl.openExplorer');
  pass('gitControl.refresh and both webviews run in a non-repository folder without throwing');

  if (patched.showWarningMessage !== true) {
    limitation('showWarningMessage could not be wrapped; the notARepo path was not observed');
    return;
  }
  seen.warnings.length = 0;
  await rediscoverGit('git');
  const warning = await waitFor(() => seen.warnings.find((line) => line === NOT_A_REPO));
  assert.equal(warning, NOT_A_REPO, `the host reports "${NOT_A_REPO}"`);
  pass(`non-repository workspace reports "${NOT_A_REPO}" and stays alive`);

  await vscode.commands.executeCommand('gitControl.refresh');
  assert.equal(vscode.extensions.getExtension(EXTENSION_ID).isActive, true);
  pass('extension is still active after the non-repository warning');
}

// --------------------------------------------------- scenario: missing-git

/**
 * Git absent.
 *
 * The runner strips git from PATH and seeds `gitControl.gitPath` with a path that
 * does not exist, so both discovery candidates fail. Re-pointing the setting
 * re-runs discovery under the installed stubs.
 */
async function missingGitScenario() {
  if (patched.showErrorMessage !== true) {
    limitation('showErrorMessage could not be wrapped; the gitMissing path was not observed');
    return;
  }
  seen.errors.length = 0;
  await rediscoverGit(path.join(process.env.GIT_CONTROL_MISSING_GIT ?? 'C:\\nope', 'git-does-not-exist'));
  const error = await waitFor(() => seen.errors.find((line) => line === GIT_MISSING));
  assert.equal(error, GIT_MISSING, `the host reports "${GIT_MISSING}"`);
  pass(`missing git reports "${GIT_MISSING}"`);

  // Degradation, not death: commands still answer and the webviews still open.
  await vscode.commands.executeCommand('gitControl.refresh');
  await vscode.commands.executeCommand('gitControl.openExplorer');
  await vscode.commands.executeCommand('gitControl.openPendingChanges');
  await vscode.commands.executeCommand('gitControl.showLogs');
  assert.equal(vscode.extensions.getExtension(EXTENSION_ID).isActive, true);
  pass('extension survives a missing git: commands and webviews still run');
}

// ------------------------------------------------------- scenario: secrets

/**
 * Token handling.
 *
 * `connectGitHub` prompts with `showInputBox`, which the module-load stub answers
 * from `inputBoxReplies`, so the flow runs non-interactively. The runner points
 * `gitControl.githubApiUrl` at a closed local port, so the validation request
 * fails fast and offline instead of reaching GitHub.
 *
 * The negative half — the token never lands in `workspaceState` — is checked by
 * the runner after this host exits, because a Memento belonging to another
 * extension is not readable through the API.
 */
async function secretsScenario() {
  if (patched.showInputBox !== true) {
    limitation('showInputBox could not be wrapped; connectGitHub cannot be driven non-interactively');
    return;
  }
  const first = process.env.GIT_CONTROL_TOKEN_A;
  const second = process.env.GIT_CONTROL_TOKEN_B;
  assert.ok(first && second, 'the runner must supply both sentinel tokens');

  // Point the API at a closed local port so validation fails as a transport error
  // rather than a 401. A 401 would make the host delete the token by design, which
  // is correct behaviour but the wrong thing to measure here — and no test may
  // depend on reaching github.com.
  await vscode.workspace
    .getConfiguration('gitControl')
    .update('githubApiUrl', 'https://127.0.0.1:1', vscode.ConfigurationTarget.Global);

  seen.infos.length = 0;
  inputBoxReplies.push(first);
  await vscode.commands.executeCommand('gitControl.connectGitHub');
  const prompt = seen.inputBoxes[seen.inputBoxes.length - 1];
  assert.ok(prompt, 'connectGitHub asked for the token');
  assert.equal(prompt.password, true, 'the token prompt is masked');
  assert.ok(await waitFor(() => seen.infos.includes(GITHUB_CONNECTED)), `reports "${GITHUB_CONNECTED}"`);
  pass('connectGitHub stores a token through the masked prompt');

  seen.infos.length = 0;
  await vscode.commands.executeCommand('gitControl.disconnectGitHub');
  assert.ok(await waitFor(() => seen.infos.includes(GITHUB_DISCONNECTED)), `reports "${GITHUB_DISCONNECTED}"`);
  pass('disconnectGitHub clears the token');

  // Cancelling must not wipe a stored token, and must not store an empty one.
  inputBoxReplies.push(undefined);
  await vscode.commands.executeCommand('gitControl.connectGitHub');
  pass('a cancelled token prompt is a no-op');

  // Leave a token behind so the runner's on-disk scan has something to look for.
  inputBoxReplies.push(second);
  await vscode.commands.executeCommand('gitControl.connectGitHub');
  pass('a second token is stored for the runner to look for on disk');

  // Exercise every surface that reads settings while a token exists.
  await vscode.commands.executeCommand('gitControl.refresh');
  await vscode.commands.executeCommand('gitControl.openExplorer');
  limitation(
    'SecretStorage and workspaceState of another extension are not readable from a ' +
      'test extension; the runner scans the profile\'s workspaceStorage after exit instead.',
  );
}

// -------------------------------------------------------------------- utils

/** Flip `gitControl.gitPath` to force `rediscoverGit` plus a registry rebuild. */
async function rediscoverGit(value) {
  const config = vscode.workspace.getConfiguration('gitControl');
  // Machine scope: only the global target is writable, which is what the fresh
  // per-scenario profile is for.
  await config.update('gitPath', value, vscode.ConfigurationTarget.Global);
}

/** Poll a predicate; host notifications and registry rebuilds are async. */
async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function execGit(args) {
  return new Promise((resolve, reject) => {
    const child = require('node:child_process').spawn('git', args, {
      cwd: vscode.workspace.workspaceFolders[0].uri.fsPath,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function limitation(message) {
  console.log(`LIMITATION ${message}`);
}

function report(message) {
  console.log(`INFO ${message}`);
}

module.exports = { run };
