import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { activeLang, setActiveLang, t, type Catalog } from '../src/webview/i18n';
import { useSettingsStore } from '../src/webview/store';

test('i18n module provides complete catalogs for en and id without em-dash', () => {
  const enCatalog = t('en');
  const idCatalog = t('id');

  assert.ok(enCatalog.pending.sectionStaged);
  assert.ok(idCatalog.pending.sectionStaged);
  assert.ok(enCatalog.format.unknownDate);
  assert.ok(idCatalog.format.unknownDate);

  // Check no em-dash or en-dash in values
  function assertNoDash(obj: unknown, prefix: string) {
    if (typeof obj === 'string') {
      assert.ok(!obj.includes('\u2014'), `${prefix} contains em-dash`);
      assert.ok(!obj.includes('\u2013'), `${prefix} contains en-dash`);
    } else if (typeof obj === 'function') {
      const res = (obj as (...args: string[]) => string)('1', '2');
      assert.ok(!res.includes('\u2014'), `${prefix}() output contains em-dash`);
      assert.ok(!res.includes('\u2013'), `${prefix}() output contains en-dash`);
    } else if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        assertNoDash(obj[i], `${prefix}[${i}]`);
      }
    } else if (typeof obj === 'object' && obj !== null) {
      for (const [k, v] of Object.entries(obj)) {
        assertNoDash(v, `${prefix}.${k}`);
      }
    }
  }

  assertNoDash(enCatalog, 'en');
  assertNoDash(idCatalog, 'id');
});

test('i18n t(lang) returns corresponding catalog', () => {
  assert.equal(t('id').pending.selectAll, 'Pilih semua');
  assert.equal(t('en').pending.selectAll, 'Select all');
  assert.equal(t('id').format.unknownDate, 'Tanggal tidak diketahui');
  assert.equal(t('en').format.unknownDate, 'Unknown date');
  assert.equal(t('id').inspector.copyShortHash, 'Salin hash pendek');
  assert.equal(t('en').inspector.copyShortHash, 'Copy short hash');
  assert.equal(t('id').changeTree.expandFolder, 'Buka');
  assert.equal(t('en').changeTree.expandFolder, 'Expand');
  assert.equal(t('id').commitForm.publishButton, 'Terbitkan branch');
  assert.equal(t('en').commitForm.publishButton, 'Publish branch');
  assert.equal(t('id').commitForm.pushButton, 'Push');
  assert.equal(t('en').commitForm.pushButton, 'Push');
  assert.equal(t('id').conflict.continueMerge, 'Lanjutkan merge');
  assert.equal(t('en').conflict.continueMerge, 'Continue merge');
  assert.equal(t('id').toast.urgentAria, 'Peringatan dan kesalahan');
  assert.equal(t('en').toast.urgentAria, 'Warnings and errors');
  assert.equal(t('id').graph.emptyTitle, 'Belum ada commit di repository ini.');
  assert.equal(t('en').graph.emptyTitle, 'No commits in this repository yet.');
  assert.equal(t('id').menu.riskyWord, 'berisiko');
  assert.equal(t('en').menu.riskyWord, 'risky');
  assert.equal(t('id').guard.permanentBadge, 'Permanen');
  assert.equal(t('en').guard.permanentBadge, 'Permanent');
  assert.equal(t('id').guard.discardRiskLabel, 'permanen');
  assert.equal(t('en').guard.discardRiskLabel, 'permanent');
  assert.equal(t('id').format.actionTitles.discardFile('src/foo.ts'), 'Buang perubahan pada src/foo.ts?');
  assert.equal(t('en').format.actionTitles.discardFile('src/foo.ts'), 'Discard changes to src/foo.ts?');
  assert.equal(
    t('id').format.actionConsequences.discardFile('src/foo.ts'),
    'Perubahan lokal file ini akan dibuang permanen dan tidak bisa dikembalikan.',
  );
  assert.equal(
    t('en').format.actionConsequences.discardFile('src/foo.ts'),
    'Local changes to this file will be permanently discarded and cannot be recovered.',
  );
  assert.equal(t('id').legend.title, 'Panduan simbol grafik');
  assert.equal(t('en').legend.title, 'Graph symbol legend');
  assert.equal(t('id').github.panelAria, 'Status GitHub');
  assert.equal(t('en').github.panelAria, 'GitHub status');
  assert.equal(t('id').explorer.asideAria, 'Panel detail');
  assert.equal(t('en').explorer.asideAria, 'Details panel');
  assert.equal(t('id').minimap.ariaLabel, 'Ikhtisar grafik');
  assert.equal(t('en').minimap.ariaLabel, 'Graph overview');
  assert.equal(t('id').bridge.timeout, 'Permintaan melebihi batas waktu.');
  assert.equal(t('en').bridge.timeout, 'Request timed out.');
});

test('activeLang defaults to en and changes with setActiveLang with reset guarantee', () => {
  try {
    assert.equal(activeLang(), 'en');
    setActiveLang('id');
    assert.equal(activeLang(), 'id');
  } finally {
    setActiveLang('en');
    assert.equal(activeLang(), 'en');
  }
});

test('useSettingsStore language updates synchronize activeLang() via subscription', () => {
  try {
    assert.equal(activeLang(), 'en');
    useSettingsStore.setState({ language: 'id' });
    assert.equal(activeLang(), 'id');
    useSettingsStore.getState().setLanguage('en');
    assert.equal(activeLang(), 'en');
    useSettingsStore.getState().setLanguage('id');
    assert.equal(activeLang(), 'id');
  } finally {
    useSettingsStore.setState({ language: 'en' });
    setActiveLang('en');
    assert.equal(activeLang(), 'en');
  }
});

test('all webview ts and tsx call sites of format.ts helpers with lang parameter forward language', () => {
  const formatTsPath = path.join(__dirname, '..', '..', 'src', 'webview', 'format.ts');
  const formatSrc = fs.readFileSync(formatTsPath, 'utf8');
  const formatSourceFile = ts.createSourceFile(
    formatTsPath,
    formatSrc,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  // Discover exported functions that take a parameter named `lang`
  const functionsWithLang = new Set<string>();
  for (const statement of formatSourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) {
        const hasLangParam = statement.parameters.some((p) => p.name.getText(formatSourceFile) === 'lang');
        if (hasLangParam) {
          functionsWithLang.add(statement.name.text);
        }
      }
    }
  }

  // Also include helpers from other webview modules that take `lang` (e.g., laneLabel, menuGroupLabel, menuItemsFor)
  functionsWithLang.add('laneLabel');
  functionsWithLang.add('menuGroupLabel');
  functionsWithLang.add('menuItemsFor');

  assert.ok(functionsWithLang.size > 0, 'Must have found functions taking lang parameter');

  const webviewDir = path.join(__dirname, '..', '..', 'src', 'webview');
  const webviewFiles = fs.readdirSync(webviewDir).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));
  const violations: string[] = [];

  for (const file of webviewFiles) {
    const filePath = path.join(webviewDir, file);
    const code = fs.readFileSync(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      filePath,
      code,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    function checkCall(callExpr: ts.CallExpression) {
      const expr = callExpr.expression;
      let fnName: string | null = null;
      if (ts.isIdentifier(expr)) {
        fnName = expr.text;
      }

      if (fnName !== null && functionsWithLang.has(fnName)) {
        // Narrow documented exceptions:
        // 1. Inside format.ts itself where helper calls other helper with its own received `lang` parameter
        // 2. Declaration / self call in format.ts or definition modules
        if (file === 'format.ts') {
          // Inside format.ts, verify that the caller forwards `lang`
          const args = callExpr.arguments;
          const lastArg = args.length > 0 ? args[args.length - 1] : undefined;
          const lastArgText = lastArg ? lastArg.getText(sourceFile) : '';
          if (lastArgText !== 'lang') {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(callExpr.getStart(sourceFile));
            violations.push(`${file}:${line + 1}:${character + 1} - ${fnName}(...) internal format call without lang forwarding (last arg: "${lastArgText}")`);
          }
          return;
        }

        const args = callExpr.arguments;
        const lastArg = args.length > 0 ? args[args.length - 1] : undefined;
        const lastArgText = lastArg ? lastArg.getText(sourceFile).replace(/\s+/g, '') : '';

        // Accepted forms of forwarding active language:
        // - Identifier `language` or `lang`
        // - Call expression `activeLang()`
        // - Member expression `useSettingsStore.getState().language`
        const isValidLang =
          lastArgText === 'language' ||
          lastArgText === 'lang' ||
          lastArgText === 'activeLang()' ||
          lastArgText === 'useSettingsStore.getState().language';

        if (!isValidLang) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(callExpr.getStart(sourceFile));
          violations.push(`${file}:${line + 1}:${character + 1} - ${fnName}(...) called without language forwarding (last arg: "${lastArgText}")`);
        }
      }

      ts.forEachChild(callExpr, (child) => {
        if (ts.isCallExpression(child)) {
          checkCall(child);
        } else {
          visit(child);
        }
      });
    }

    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        checkCall(node);
      } else {
        ts.forEachChild(node, visit);
      }
    }

    visit(sourceFile);
  }

  assert.deepEqual(
    violations,
    [],
    `Found call sites of format helpers missing language forwarding:\n${violations.join('\n')}`,
  );
});



test('shell header strings exist in both languages and function entries stay safe', () => {
  for (const lang of ['en', 'id'] as const) {
    const shell = t(lang).shell;
    for (const value of Object.values(shell)) {
      const text = typeof value === 'function' ? value('1') : value;
      assert.ok(text.length > 0);
    }
  }
  assert.notEqual(t('en').shell.syncLocal, t('id').shell.syncLocal);
  assert.notEqual(t('en').shell.syncAhead('2'), t('id').shell.syncAhead('2'));
});

test('nav strings exist in both languages, share keys, and carry the count into the accessible name', () => {
  assert.deepEqual(
    Object.keys(t('en').nav).sort(),
    Object.keys(t('id').nav).sort(),
    'both catalogs define the same nav keys',
  );
  for (const lang of ['en', 'id'] as const) {
    const nav = t(lang).nav;
    for (const value of Object.values(nav)) {
      const text = typeof value === 'function' ? value('1') : value;
      assert.ok(text.length > 0);
    }
    for (const name of [nav.changesAria, nav.prsAria, nav.issuesAria]) {
      assert.match(name('7'), /7/, 'the count reaches the accessible name');
    }
  }
  assert.notEqual(t('en').nav.changes, t('id').nav.changes);
  assert.notEqual(t('en').nav.changesAria('2'), t('id').nav.changesAria('2'));
});

test('stash filter strings exist in both languages, are translated, and carry both counts', () => {
  for (const lang of ['en', 'id'] as const) {
    const p = t(lang).pending;
    assert.equal(typeof p.stashSearchPlaceholder, 'string', `${lang} placeholder`);
    assert.equal(typeof p.stashSearchAria, 'string', `${lang} aria`);
    assert.equal(typeof p.stashSearchEmptyTitle, 'string', `${lang} empty title`);
    assert.ok(p.stashSearchPlaceholder.length > 0 && p.stashSearchAria.length > 0 && p.stashSearchEmptyTitle.length > 0);
    const line = p.stashSearchMatched('3', '9');
    assert.match(line, /3/, `${lang}: shown count`);
    assert.match(line, /9/, `${lang}: total count`);
  }
  const en = t('en').pending;
  const id = t('id').pending;
  assert.notEqual(en.stashSearchPlaceholder, id.stashSearchPlaceholder);
  assert.notEqual(en.stashSearchAria, id.stashSearchAria);
  assert.notEqual(en.stashSearchEmptyTitle, id.stashSearchEmptyTitle);
  assert.notEqual(en.stashSearchMatched('1', '2'), id.stashSearchMatched('1', '2'));
  assert.notEqual(en.stashSearchPlaceholder, en.searchPlaceholder, 'the stash row does not say "files"');
  assert.notEqual(id.stashSearchPlaceholder, id.searchPlaceholder);
  for (const text of [en.stashSearchPlaceholder, en.stashSearchAria, en.stashSearchEmptyTitle, en.stashSearchMatched('1', '2')]) {
    assert.doesNotMatch(text, /file/i, `"${text}" is about stashes, not files`);
  }
});

test('sub-tab strings exist in both languages, are translated, and carry the count into the accessible name', () => {
  // The Changes sub-tab reuses `nav.changesAria`: same words, so no duplicate key.
  for (const lang of ['en', 'id'] as const) {
    const nav = t(lang).nav;
    assert.equal(typeof nav.subTabsAria, 'string', `${lang} subTabsAria`);
    assert.equal(typeof nav.subStashesAria, 'function', `${lang} subStashesAria`);
    assert.ok(nav.subTabsAria.length > 0);
    assert.match(nav.subStashesAria('7'), /7/, `${lang}: the count reaches the accessible name`);
  }
  assert.notEqual(t('en').nav.subTabsAria, t('id').nav.subTabsAria);
  assert.notEqual(t('en').nav.subStashesAria('2'), t('id').nav.subStashesAria('2'));
});
