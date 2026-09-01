/**
 * Manifest assertions.
 *
 * `package.json` carries security-relevant declarations that no other test can
 * reach: configuration scopes and the Workspace Trust capability are enforced by
 * VS Code's own resolvers, not by extension code, so the only thing this project
 * can verify in-process is that the declarations are present and say what they are
 * meant to say. That is worth pinning — SEC-005 was a missing `scope` and SEC-015
 * a missing `capabilities` block, and both are one careless edit away from
 * returning.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface ConfigProperty {
  type?: string;
  scope?: string;
  description?: string;
}

interface Manifest {
  engines?: { vscode?: string };
  private?: boolean;
  repository?: { url?: string };
  bugs?: { url?: string };
  homepage?: string;
  keywords?: string[];
  icon?: string;
  galleryBanner?: { color?: string; theme?: string };
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: boolean | 'limited';
      description?: string;
      restrictedConfigurations?: string[];
    };
  };
  contributes?: {
    commands?: Array<{ command?: string; title?: string; icon?: string | { light?: string; dark?: string } }>;
    configuration?: { properties?: Record<string, ConfigProperty> };
  };
}

function manifest(): Manifest {
  const file = path.join(__dirname, '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
}

// ------------------------------------------------------------------- SEC-015

test('Workspace Trust is declared explicitly as unsupported (SEC-015)', () => {
  const trust = manifest().capabilities?.untrustedWorkspaces;
  assert.ok(trust !== undefined, 'capabilities.untrustedWorkspaces must be declared');

  // `false`, not `limited`. The extension's entire function is spawning git
  // against workspace content, and `commit` invokes the repository's own hooks by
  // design, so there is no useful restricted subset to offer.
  assert.equal(trust.supported, false);
  assert.ok(
    typeof trust.description === 'string' && trust.description.length > 20,
    'a reason is shown to the user in the Restricted Mode banner',
  );
  // The declaration must name git hooks, because that is the non-obvious part of
  // the decision and the thing a future reader needs to know was considered.
  assert.match(trust.description, /hook/i);
});

test('the settings that name an executable or a token target are restricted (SEC-015)', () => {
  const trust = manifest().capabilities?.untrustedWorkspaces;
  const restricted = trust?.restrictedConfigurations ?? [];
  // Belt to the `machine` scope's braces: if the scope is ever relaxed, this keeps
  // an untrusted workspace from supplying either value.
  assert.ok(restricted.includes('gitControl.gitPath'));
  assert.ok(restricted.includes('gitControl.githubApiUrl'));
});

// ------------------------------------------------------------- SEC-005 pinned

test('gitPath and githubApiUrl stay machine-scoped (SEC-005)', () => {
  const properties = manifest().contributes?.configuration?.properties ?? {};
  for (const key of ['gitControl.gitPath', 'gitControl.githubApiUrl']) {
    const property = properties[key];
    assert.ok(property !== undefined, key);
    assert.equal(
      property.scope,
      'machine',
      `${key} names a program we execute or a host we send the token to`,
    );
  }
});

test('marketplace metadata is complete', () => {
  const m = manifest();
  assert.equal(m.private, false);
  assert.match(m.repository?.url ?? '', /^https:\/\//);
  assert.match(m.bugs?.url ?? '', /^https:\/\//);
  assert.match(m.homepage ?? '', /^https:\/\//);
  assert.ok((m.keywords?.length ?? 0) > 0);
  assert.ok(m.galleryBanner?.color);
});

test('the marketplace icon is a 128x128 PNG', () => {
  // The marketplace rejects SVG and silently rescales anything that is not 128px,
  // so both the reference and the dimensions are pinned here. Read straight from
  // IHDR: 8-byte signature, 4-byte length, 4-byte type, then width/height as
  // big-endian uint32s.
  const icon = manifest().icon;
  assert.equal(icon, 'resources/icon.png');
  const bytes = fs.readFileSync(path.join(__dirname, '..', '..', icon as string));
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG signature',
  );
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), 128, 'width');
  assert.equal(bytes.readUInt32BE(20), 128, 'height');
  assert.equal(bytes[24], 8, 'bit depth 8');
  assert.equal(bytes[25], 6, 'colour type 6: truecolour with alpha, so the background is transparent');
});

test('every declared command has a title', () => {
  for (const command of manifest().contributes?.commands ?? []) {
    assert.ok(command.command, 'command id is required');
    assert.ok(command.title, `${command.command} must have a title`);
  }
});

test('every configuration property has a description', () => {
  for (const [key, property] of Object.entries(manifest().contributes?.configuration?.properties ?? {})) {
    assert.ok(property.description, `${key} must have a description`);
  }
});

test('@types/vscode matches engines.vscode major/minor', () => {
  const declared = manifest().engines?.vscode ?? '';
  const types = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'node_modules', '@types', 'vscode', 'package.json'), 'utf8')) as { version: string };
  const range = declared.match(/(\d+)\.(\d+)/);
  assert.ok(range, 'engines.vscode must contain a version');
  assert.equal(types.version, `${range[1]}.${range[2]}.0`);
});

test('.vscodeignore excludes source, tests, maps, dependencies, and markdown', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '..', '.vscodeignore'), 'utf8');
  for (const pattern of ['src/**', 'test/**', '**/*.map', 'node_modules/**', '**/*.md']) {
    assert.match(ignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), pattern);
  }
});

test('command icons point to valid resource files', () => {
  for (const command of manifest().contributes?.commands ?? []) {
    if (typeof command.icon === 'object' && command.icon !== null) {
      const icon = command.icon as { light?: string; dark?: string };
      if (icon.light) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', '..', icon.light)), `Icon light file missing: ${icon.light}`);
      }
      if (icon.dark) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', '..', icon.dark)), `Icon dark file missing: ${icon.dark}`);
      }
    }
  }
});
