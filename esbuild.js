// Build pipeline: extension host bundle, webview bundle, and test bundle.
// Usage: node esbuild.js [--watch] [--production]
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const shared = {
  bundle: true,
  logLevel: 'info',
  minify: production,
  sourcemap: !production,
};

/** @returns {string[]} absolute-ish entry paths for test files, empty when test/ is absent */
function testEntries() {
  const dir = path.join(__dirname, 'test');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => path.join('test', f));
}

const configs = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/webview/main.tsx', 'src/webview/styles.css'],
    outdir: 'dist',
    entryNames: 'webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

const tests = testEntries();
if (tests.length > 0) {
  configs.push({
    ...shared,
    entryPoints: tests,
    outdir: 'out/test',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: true,
    minify: false,
    external: ['vscode', 'node:*'],
  });
}

async function main() {
  if (watch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((c) => c.watch()));
    return;
  }
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
