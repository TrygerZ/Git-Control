import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFileIcon, resolveFolderIcon, type ResolvedIcon } from '../src/webview/fileIcon';
import type { IconThemeSnapshot } from '../src/messages';

/**
 * Precedence suite for the pure theme-icon resolver. Every theme fixture is a
 * minimal hand-built snapshot; matching must be lowercase and every broken
 * entry (missing definition, empty definition) must fall through to the next
 * tier instead of stopping the lookup.
 */

let counter = 0;
function defId(): string {
  counter += 1;
  return `d${counter}`;
}

function svg(uri = 'https://wv/assets/x.svg'): ResolvedIcon {
  return { kind: 'svg', uri };
}

function snapshot(overrides: Partial<IconThemeSnapshot> = {}): IconThemeSnapshot {
  return {
    themeId: 'test',
    definitions: {},
    fileExtensions: {},
    fileNames: {},
    folderNames: {},
    folderNamesExpanded: {},
    languageIds: {},
    languageByExtension: {},
    languageByFilename: {},
    fonts: [],
    hidesExplorerArrows: false,
    ...overrides,
  };
}

test('snapshot null resolves to undefined', () => {
  assert.equal(resolveFileIcon('a.ts', null), undefined);
  assert.equal(resolveFolderIcon('src', false, null), undefined);
});

test('fileNames beats fileExtensions', () => {
  const snap = snapshot({
    definitions: { name: { iconUri: 'name.svg' }, ext: { iconUri: 'ext.svg' } },
    fileNames: { makefile: 'name' },
    fileExtensions: { mk: 'ext' },
  });
  assert.deepEqual(resolveFileIcon('Makefile', snap), svg('name.svg'));
  assert.deepEqual(resolveFileIcon('build.mk', snap), svg('ext.svg'));
});

test('multi-dot extensions try longest first', () => {
  const snap = snapshot({
    definitions: { long: { iconUri: 'long.svg' }, short: { iconUri: 'short.svg' } },
    fileExtensions: { tsx: 'short', 'test.tsx': 'long' },
  });
  assert.deepEqual(resolveFileIcon('app.test.tsx', snap), svg('long.svg'));
  assert.deepEqual(resolveFileIcon('app.prod.tsx', snap), svg('short.svg'));
});

test('dotfile segments: .eslintrc.json reaches json, .gitignore reaches gitignore', () => {
  const snap = snapshot({
    definitions: { json: { iconUri: 'json.svg' }, ign: { iconUri: 'ign.svg' } },
    fileExtensions: { json: 'json', gitignore: 'ign' },
  });
  assert.deepEqual(resolveFileIcon('.eslintrc.json', snap), svg('json.svg'));
  assert.deepEqual(resolveFileIcon('.gitignore', snap), svg('ign.svg'));
});

test('matching is case-insensitive', () => {
  const snap = snapshot({
    definitions: { md: { iconUri: 'md.svg' }, readme: { iconUri: 'rm.svg' } },
    fileExtensions: { md: 'md' },
    fileNames: { 'readme.md': 'readme' },
  });
  assert.deepEqual(resolveFileIcon('README.MD', snap), svg('rm.svg'));
  const noName = snapshot({
    definitions: { md: { iconUri: 'md.svg' } },
    fileExtensions: { md: 'md' },
  });
  assert.deepEqual(resolveFileIcon('README.MD', noName), svg('md.svg'));
});

test('languageIds via languageByExtension and languageByFilename', () => {
  const snap = snapshot({
    definitions: { ts: { iconUri: 'ts.svg' }, docker: { iconUri: 'docker.svg' } },
    languageIds: { typescript: 'ts', dockerfile: 'docker' },
    languageByExtension: { ts: 'typescript' },
    languageByFilename: { dockerfile: 'dockerfile' },
  });
  assert.deepEqual(resolveFileIcon('a.ts', snap), svg('ts.svg'));
  assert.deepEqual(resolveFileIcon('Dockerfile', snap), svg('docker.svg'));
});

test('fileNames beats languageIds', () => {
  const snap = snapshot({
    definitions: { name: { iconUri: 'name.svg' }, lang: { iconUri: 'lang.svg' } },
    fileNames: { dockerfile: 'name' },
    languageIds: { dockerfile: 'lang' },
    languageByFilename: { dockerfile: 'dockerfile' },
  });
  assert.deepEqual(resolveFileIcon('dockerfile', snap), svg('name.svg'));
});

test('falls back to snapshot.file default', () => {
  const snap = snapshot({
    definitions: { def: { iconUri: 'default.svg' } },
    file: 'def',
  });
  assert.deepEqual(resolveFileIcon('mystery.zzz', snap), svg('default.svg'));
});

test('missing definition id falls through to next precedence tier', () => {
  const snap = snapshot({
    definitions: { real: { iconUri: 'real.svg' } },
    fileNames: { 'a.ts': 'ghost' },
    fileExtensions: { ts: 'real' },
  });
  assert.deepEqual(resolveFileIcon('a.ts', snap), svg('real.svg'));
});

test('definition without iconUri and without fontCharacter falls through', () => {
  const snap = snapshot({
    definitions: { empty: {}, real: { iconUri: 'real.svg' } },
    fileNames: { 'a.ts': 'empty' },
    fileExtensions: { ts: 'real' },
  });
  assert.deepEqual(resolveFileIcon('a.ts', snap), svg('real.svg'));
});

test('fontCharacter maps to a glyph with colour and font metadata', () => {
  const snap = snapshot({
    definitions: {
      seti: { fontCharacter: '\uE001', fontColor: '#519aba', fontId: 'seti', fontSize: '120%' },
    },
    fileExtensions: { ts: 'seti' },
    fonts: [{ id: 'seti', srcUri: 'https://wv/seti.woff', format: 'woff', size: '150%' }],
  });
  assert.deepEqual(resolveFileIcon('a.ts', snap), {
    kind: 'glyph',
    char: '\uE001',
    color: '#519aba',
    fontId: 'seti',
    fontSize: '120%',
  });
});

test('glyph fontSize falls back to the theme font size', () => {
  const snap = snapshot({
    definitions: { seti: { fontCharacter: '\uE001', fontId: 'seti' } },
    fileExtensions: { ts: 'seti' },
    fonts: [{ id: 'seti', srcUri: 'https://wv/seti.woff', format: 'woff', size: '150%' }],
  });
  const icon = resolveFileIcon('a.ts', snap);
  assert.ok(icon !== undefined && icon.kind === 'glyph');
  assert.equal(icon.fontSize, '150%');
});

test('folder names, expanded names, and defaults', () => {
  const snap = snapshot({
    definitions: {
      src: { iconUri: 'src.svg' },
      srcOpen: { iconUri: 'src-open.svg' },
      folder: { iconUri: 'folder.svg' },
      open: { iconUri: 'open.svg' },
    },
    folderNames: { src: 'src' },
    folderNamesExpanded: { src: 'srcOpen' },
    folder: 'folder',
    folderExpanded: 'open',
  });
  assert.deepEqual(resolveFolderIcon('SRC', false, snap), svg('src.svg'));
  assert.deepEqual(resolveFolderIcon('src', true, snap), svg('src-open.svg'));
  assert.deepEqual(resolveFolderIcon('other', false, snap), svg('folder.svg'));
  assert.deepEqual(resolveFolderIcon('other', true, snap), svg('open.svg'));
});

test('expanded folder falls back to closed name icon, closed default for open default', () => {
  const snap = snapshot({
    definitions: { closedName: { iconUri: 'cn.svg' }, closed: { iconUri: 'c.svg' } },
    folderNames: { src: 'closedName' },
    folder: 'closed',
  });
  // open without folderNamesExpanded / folderExpanded → closed icons
  assert.deepEqual(resolveFolderIcon('src', true, snap), svg('cn.svg'));
  assert.deepEqual(resolveFolderIcon('other', true, snap), svg('c.svg'));
});

test('folder missing definition id falls through to the default', () => {
  const snap = snapshot({
    definitions: { def: { iconUri: 'def.svg' } },
    folderNames: { src: 'ghost' },
    folder: 'def',
  });
  assert.deepEqual(resolveFolderIcon('src', false, snap), svg('def.svg'));
});

test('empty name yields undefined', () => {
  assert.equal(resolveFileIcon('', snapshot({ file: 'x' })), undefined);
  assert.equal(resolveFolderIcon('', false, snapshot({ folder: 'x' })), undefined);
});
