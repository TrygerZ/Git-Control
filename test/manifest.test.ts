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
  capabilities?: {
    untrustedWorkspaces?: {
      supported?: boolean | 'limited';
      description?: string;
      restrictedConfigurations?: string[];
    };
  };
  contributes?: {
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
