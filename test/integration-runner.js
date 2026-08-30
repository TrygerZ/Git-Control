const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runTests } = require('@vscode/test-electron');
const execFileAsync = promisify(execFile);

async function main() {
  const root = path.resolve(__dirname, '..');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'git-control-vscode-'));
  try {
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.email', 'integration@example.com'], { cwd: workspace });
    await execFileAsync('git', ['config', 'user.name', 'Integration Test'], { cwd: workspace });
    await fs.writeFile(path.join(workspace, 'a.txt'), 'one\n');
    await execFileAsync('git', ['add', 'a.txt'], { cwd: workspace });
    await execFileAsync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: workspace });
    const suite = path.join(__dirname, 'integration-suite.js');
    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      launchArgs: [workspace, '--disable-extensions-except', root],
      extensionTestsEnv: { GIT_CONTROL_ROOT: root },
    });
    if (code !== 0) process.exitCode = code;
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
