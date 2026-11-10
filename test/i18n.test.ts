import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { activeLang, setActiveLang, t, type Catalog } from '../src/webview/i18n';
import { hostCatalogs, hostText } from '../src/hostText';
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

test('the prs namespace exists in both catalogs with the same shape', () => {
  const en = t('en').prs;
  const id = t('id').prs;

  // Structure is enforced by `id` implementing `Catalog`; these pin the strings
  // that carry meaning a translator could otherwise flip.
  assert.equal(en.chipOpen, 'Open');
  assert.equal(id.chipOpen, 'Terbuka');
  assert.equal(en.chipReview, 'Review requested');
  assert.equal(id.chipReview, 'Perlu review');
  assert.equal(en.groupNeedsReview, 'Needs your review');
  assert.equal(id.groupNeedsReview, 'Menunggu review Anda');
  assert.equal(en.signInBannerText, 'Sign in for higher limits');
  assert.equal(id.signInBannerText, 'Masuk untuk batas lebih tinggi');
  assert.equal(en.noRemoteTitle, 'No GitHub remote');
  assert.equal(id.noRemoteTitle, 'Tidak ada remote GitHub');
  assert.equal(en.clearFilters, 'Clear filters');
  assert.equal(id.clearFilters, 'Hapus filter');

  // Function entries must not throw on numeric-looking input, which is how the
  // dash scan and the count formatters call them.
  assert.equal(en.rowAria('#7', 'Title', 'octocat'), '#7, Title, by octocat');
  assert.equal(id.rowAria('#7', 'Title', 'octocat'), '#7, Title, oleh octocat');
  assert.equal(en.branchCardAhead('3', 'main'), '3 ahead of main');
  assert.equal(id.branchCardAhead('3', 'main'), '3 di depan main');
  assert.equal(en.branchCardAhead('2', 'develop'), '2 ahead of develop', 'the base is the branch it tracks');
  assert.equal(id.branchCardAhead('2', 'develop'), '2 di depan develop');
  assert.equal(en.rateLimitedBody('12:40'), 'Showing cached results. Requests resume in 12:40.');
});

test('the issues namespace exists in both catalogs with the same shape', () => {
  const en = (t('en') as Record<string, unknown>).issues as Record<string, unknown>;
  const id = (t('id') as Record<string, unknown>).issues as Record<string, unknown>;

  assert.ok(en !== undefined, 'en.issues must exist');
  assert.ok(id !== undefined, 'id.issues must exist');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(id).sort());

  assert.equal(en.panelAria, 'Issues');
  assert.equal(id.panelAria, 'Issue');
  assert.equal(en.chipAssigned, 'Assigned');
  assert.equal(id.chipAssigned, 'Ditugaskan');
  assert.equal(en.chipCreated, 'Created');
  assert.equal(id.chipCreated, 'Dibuat saya');
  assert.equal(en.chipMentioned, 'Mentioned');
  assert.equal(id.chipMentioned, 'Menyebut saya');
  assert.equal(en.groupAssigned, 'Assigned to you');
  assert.equal(id.groupAssigned, 'Ditugaskan kepada Anda');
  assert.equal(en.groupClosed, 'Recently closed');
  assert.equal(id.groupClosed, 'Baru ditutup');
  assert.equal(en.openOnGitHub, 'Open on GitHub');
  assert.equal(id.openOnGitHub, 'Buka di GitHub');
  assert.equal(en.clearFilters, 'Clear filters');
  assert.equal(id.clearFilters, 'Hapus filter');

  const rowAriaEn = en.rowAria as (n: string, t: string, l: string) => string;
  const rowAriaId = id.rowAria as (n: string, t: string, l: string) => string;
  assert.equal(rowAriaEn('97', 'Login fails', ', labels bug'), 'Issue #97, Login fails, labels bug');
  assert.equal(rowAriaId('97', 'Login fails', ', label bug'), 'Issue #97, Login fails, label bug');

  const labelsJoinEn = en.labelsJoin as (names: string) => string;
  const labelsJoinId = id.labelsJoin as (names: string) => string;
  assert.equal(labelsJoinEn('bug, auth'), ', labels bug, auth');
  assert.equal(labelsJoinId('bug, auth'), ', label bug, auth');

  const commentsCountEn = en.commentsCount as (n: string) => string;
  const commentsCountId = id.commentsCount as (n: string) => string;
  assert.equal(commentsCountEn('3'), '3 comments');
  assert.equal(commentsCountId('3'), '3 komentar');
});

test('the startWork namespace exists in both catalogs with the same shape', () => {
  const en = (t('en') as Record<string, unknown>).startWork as Record<string, unknown>;
  const id = (t('id') as Record<string, unknown>).startWork as Record<string, unknown>;

  assert.ok(en !== undefined, 'en.startWork must exist');
  assert.ok(id !== undefined, 'id.startWork must exist');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(id).sort());

  assert.equal(en.button, 'Start work');
  assert.equal(id.button, 'Mulai kerja');
  assert.equal(en.fieldLabel, 'New branch name');
  assert.equal(id.fieldLabel, 'Nama branch baru');
  assert.equal(en.commandLabel, 'Command that will run');
  assert.equal(id.commandLabel, 'Perintah yang akan dijalankan');
  assert.equal(en.submit, 'Create branch');
  assert.equal(id.submit, 'Buat branch');
  assert.equal(en.problemEmpty, 'Branch name cannot be empty.');
  assert.equal(id.problemEmpty, 'Nama branch tidak boleh kosong.');
  assert.equal(en.problemExists, 'A local branch with this name already exists.');
  assert.equal(id.problemExists, 'Branch lokal dengan nama ini sudah ada.');

  // Function entries must not throw on numeric-looking input, which is how the
  // dash scan and the count formatters call them.
  const titleEn = en.title as (n: string) => string;
  const titleId = id.title as (n: string) => string;
  assert.equal(titleEn('97'), 'Start work on #97');
  assert.equal(titleId('97'), 'Mulai kerja pada #97');

  const doneEn = en.doneToast as (name: string) => string;
  const doneId = id.doneToast as (name: string) => string;
  assert.equal(doneEn('feat/97-x'), 'Created feat/97-x and switched to it');
  assert.equal(doneId('feat/97-x'), 'Membuat feat/97-x dan berpindah ke branch itu');

  // Every row offers the same label, so the accessible name has to say which issue.
  const buttonAriaEn = en.buttonAria as (n: string) => string;
  const buttonAriaId = id.buttonAria as (n: string) => string;
  assert.match(buttonAriaEn('97'), /97/);
  assert.match(buttonAriaId('97'), /97/);
  assert.notEqual(buttonAriaEn('97'), buttonAriaId('97'));
});

test('the onboarding namespace exists in both catalogs with the same shape', () => {
  const en = (t('en') as Record<string, unknown>).onboarding as Record<string, unknown>;
  const id = (t('id') as Record<string, unknown>).onboarding as Record<string, unknown>;

  assert.ok(en !== undefined, 'en.onboarding must exist');
  assert.ok(id !== undefined, 'id.onboarding must exist');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(id).sort());

  assert.equal(en.title, 'Get started');
  assert.equal(id.title, 'Mulai di sini');
  assert.equal(en.doneTitle, 'All set');
  assert.equal(id.doneTitle, 'Semua siap');
  assert.equal(en.dismissAria, 'Dismiss getting started');
  assert.equal(id.dismissAria, 'Tutup panduan langkah awal');
  assert.equal(en.doneNote, 'This card hides itself in a few seconds.');
  assert.equal(id.doneNote, 'Kartu ini akan hilang sendiri dalam beberapa detik.');

  assert.equal(en.connectTitle, 'Connect GitHub');
  assert.equal(id.connectTitle, 'Hubungkan GitHub');
  assert.equal(en.commitTitle, 'Save changes with a commit');
  assert.equal(id.commitTitle, 'Simpan perubahan dengan commit');
  assert.equal(en.publishTitle, 'Publish your branch');
  assert.equal(id.publishTitle, 'Publikasikan branch Anda');
  assert.equal(en.prTitle, 'Open a pull request');
  assert.equal(id.prTitle, 'Buka pull request');

  assert.equal(en.actionConnect, 'Connect');
  assert.equal(id.actionConnect, 'Hubungkan');
  assert.equal(en.actionPublish, 'Publish');
  assert.equal(id.actionPublish, 'Publikasikan');
  assert.equal(en.actionOpenCompare, 'Open on GitHub');
  assert.equal(id.actionOpenCompare, 'Buka di GitHub');
  assert.equal(en.actionCreatePr, 'Create pull request');
  assert.equal(id.actionCreatePr, 'Buat pull request');

  // Every step exposes its state as text, so the marks are not colour-only.
  assert.equal(en.stepDoneAria, 'completed');
  assert.equal(id.stepDoneAria, 'selesai');
  assert.equal(en.stepCurrentAria, 'current step');
  assert.equal(id.stepCurrentAria, 'langkah saat ini');
  assert.equal(en.stepTodoAria, 'not started');
  assert.equal(id.stepTodoAria, 'belum dimulai');

  const progressEn = en.progress as (done: string, total: string) => string;
  const progressId = id.progress as (done: string, total: string) => string;
  assert.equal(progressEn('2', '4'), '2 of 4');
  assert.equal(progressId('2', '4'), '2 dari 4');

  const progressAriaEn = en.progressAria as (done: string, total: string) => string;
  const progressAriaId = id.progressAria as (done: string, total: string) => string;
  assert.equal(progressAriaEn('2', '4'), 'Getting started progress, 2 of 4 steps');
  assert.equal(progressAriaId('2', '4'), 'Kemajuan langkah awal, 2 dari 4 langkah');

  const connectDoneEn = en.connectDone as (login: string) => string;
  const connectDoneId = id.connectDone as (login: string) => string;
  assert.equal(connectDoneEn('TrygerZ'), 'Signed in as TrygerZ');
  assert.equal(connectDoneId('TrygerZ'), 'Masuk sebagai TrygerZ');

  // The publish copy names the host it sends to, because a non-GitHub remote
  // would otherwise promise something the step cannot do.
  const ghEn = en.publishDescGithub as (branch: string) => string;
  const ghId = id.publishDescGithub as (branch: string) => string;
  const remoteEn = en.publishDescRemote as (branch: string) => string;
  const remoteId = id.publishDescRemote as (branch: string) => string;
  assert.equal(ghEn('feat/a'), 'Send feat/a to GitHub so others can see it');
  assert.equal(remoteEn('feat/a'), 'Send feat/a to the remote so others can see it');
  assert.match(ghId('feat/a'), /feat\/a/);
  assert.match(remoteId('feat/a'), /feat\/a/);
  assert.notEqual(ghId('feat/a'), remoteId('feat/a'));
});

// ---------------------------------------------------- host catalog (P15)

test('host catalog keeps en and id in parity with no dash in either', () => {
  const en = hostCatalogs.en;
  const id = hostCatalogs.id;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(id).sort(), 'same namespaces');

  for (const namespace of Object.keys(en) as Array<keyof typeof en>) {
    assert.deepEqual(
      Object.keys(en[namespace]).sort(),
      Object.keys(id[namespace]).sort(),
      `namespace ${namespace} keeps the same keys`,
    );
  }

  function scan(value: unknown, where: string): void {
    if (typeof value === 'string') {
      assert.ok(!value.includes('\u2014'), `${where} contains em-dash`);
      assert.ok(!value.includes('\u2013'), `${where} contains en-dash`);
    } else if (typeof value === 'function') {
      const out = (value as (...args: string[]) => string)('1', '2');
      assert.equal(typeof out, 'string', `${where} returns a string`);
      assert.ok(!out.includes('\u2014'), `${where}() contains em-dash`);
      assert.ok(!out.includes('\u2013'), `${where}() contains en-dash`);
    }
  }
  for (const lang of ['en', 'id'] as const) {
    for (const [namespace, entries] of Object.entries(hostCatalogs[lang])) {
      for (const [key, value] of Object.entries(entries)) scan(value, `${lang}.${namespace}.${key}`);
    }
  }

  assert.equal(hostText('id').quickActions.publishTitle, 'Publikasikan branch');
  assert.equal(hostText('en').quickActions.publishTitle, 'Publish branch');
  assert.equal(hostText('id').quickActions.groupGo, 'Buka');
  assert.equal(hostText('en').quickActions.groupGo, 'Go to');
});

test('quick actions function entries survive numeric-looking arguments', () => {
  const en = hostText('en').quickActions;
  const id = hostText('id').quickActions;
  assert.equal(en.publishDetail('3'), 'Send your 3 local commits to the remote so others can see them');
  assert.equal(id.publishDetail('3'), 'Kirim 3 commit lokal ke remote agar bisa dilihat orang lain');
  assert.match(en.commitTitle('1'), /^Commit 1 staged file\b/);
  assert.match(en.commitTitle('2'), /^Commit 2 staged files\b/);
  assert.match(id.commitTitle('1'), /^Commit 1 file\b/);
  assert.equal(en.resolveDetail('2'), '2 files need your decision before you can continue');
  assert.equal(en.openActionsDetail('4'), '4 failing runs on this branch');
  assert.equal(en.createPrDetail('feat/x'), 'Ask teammates to review feat/x');
});

test('the webview palette namespace names the header search button', () => {
  const en = t('en').palette;
  const id = t('id').palette;
  assert.equal(en.openAria, 'Open quick actions');
  assert.equal(id.openAria, 'Buka aksi cepat');
  assert.equal(en.openTitle, 'Quick actions');
  assert.equal(id.openTitle, 'Aksi cepat');
  assert.notEqual(en.openAria, id.openAria);
});

test('the resolve detail has a ready form for a zero-conflict operation', () => {
  // A merge whose conflicts are already resolved is still "in progress", and the
  // row must not claim zero files need a decision.
  assert.equal(hostText('en').quickActions.resolveDetailReady, 'This operation can continue now');
  assert.equal(hostText('id').quickActions.resolveDetailReady, 'Operasi ini sudah bisa dilanjutkan');
});
