# AGENTS.md: Git Control

VS Code extension (`TrygerZ.git-control`), engine `^1.90.0`, entry `dist/extension.js`, activation `onStartupFinished`.
Interactive 2D Git DAG explorer and dedicated Pending Changes panel.

## Commands

| Command | Action | When to use |
|---|---|---|
| `npm run build` | `node esbuild.js` | Build extension, webview, and test bundles into `dist/` and `out/test/` |
| `npm run watch` | `node esbuild.js --watch` | Recompile on file changes during local development |
| `npm run typecheck` | `tsc --noEmit` | Check TypeScript types across `src/` and `test/` (esbuild does not type-check) |
| `npm test` | `node esbuild.js && node --test "out/test/*.test.js"` | Run unit/headless tests against compiled bundles (auto-builds) |
| `npm run test:integration` | `node esbuild.js && node test/integration-runner.js` | Run real VS Code Electron integration scenarios (first run downloads VS Code via `@vscode/test-electron`) |
| `npm run package` | `node esbuild.js --production && vsce package` | Production build + package `.vsix` artifact |

## Architecture & Trust Boundaries

The codebase is partitioned into three execution contexts with strict trust boundaries:

```
+---------------------------------------------------------------------------------------+
| Extension Host (Node 20 / CommonJS)                                                   |
| Full VS Code API, Git CLI execution, SecretStorage, filesystem watchers               |
| Entry: src/extension.ts -> dist/extension.js                                         |
| Architecture rule: pure logic separated from vscode I/O wrappers (see Invariants)    |
+---------------------------------------------------------------------------------------+
                                           ^ |
    Typed message bridge (kind + payload, REST-equivalent; src/messages.ts, src/bridge.ts)
    All webview requests pass validation before touching git argv
                                           | v
+---------------------------------------------------------------------------------------+
| Webview (Browser / IIFE / ES2022)                                                     |
| React 19 + Zustand UI. Untrusted context.                                             |
| Entry: src/webview/main.tsx -> dist/webview.js & dist/webview.css                     |
| CSP: default-src 'none'; connect-src 'none'; no network access, no secrets             |
+---------------------------------------------------------------------------------------+
```

Agents following the AGENTS.md convention resolve the nearest configuration file. If webview-specific or host-specific rules grow substantial, split them into `src/webview/AGENTS.md`; until then, this root file remains the single source of truth.

## Non-Negotiable Invariants

| Invariant | Enforced At | If Violated |
|---|---|---|
| `spawn` + `shell: false` + argv array; no `exec`/`execSync`; `--` before user paths | `src/git.ts` | Command injection (T1). Never interpolate shell strings. |
| No force push constructable; `push()` rejects refspecs starting with `+`; `--force`/`--force-with-lease` never emitted on push code paths | `src/git.ts`, `src/guard.ts`, `src/bridge.ts` | Remote history overwrite. Force push is permanently out of scope. |
| Webview inputs validated before entering argv; `sanitizeRefArg` on refs | `src/validation.ts`, `src/bridge.ts` | Option injection (`-flag` interpreted as git option). |
| GitHub token stored ONLY in `SecretStorage`; sent ONLY to `tokenAllowed` base (`github.com` or explicit `gitControl.githubApiUrl`); NEVER to webview, logs, or `workspaceState` | `src/extension.ts`, `src/github.ts` | Token theft / exfiltration (SEC-001). Remote URL host derived API base MUST NEVER receive token. |
| All logs pass through redactor | `src/logger.ts` | Secret leakage in output channel or bug report screenshots (SEC-004, SEC-012). |
| Mutations serialized via per-repo promise mutex (`runExclusive`); status cache invalidated on mutation / watcher; watcher debounce 500 ms | `src/git.ts`, `src/repository.ts`, `src/watcher.ts` | Git index lock races (`.git/index.lock`), dirty state corruption, UI thrashing. |
| Zero `dangerouslySetInnerHTML`, zero `innerHTML`; no untrusted `href`/`src` binding | `src/webview/**` | Webview XSS / remote code execution (T4). |
| `gitControl.gitPath` and `gitControl.githubApiUrl` MUST stay `"scope": "machine"`; `gitPath` MUST be absolute | `package.json`, `src/extension.ts` | Malicious repository executes arbitrary local binaries via committed `.vscode/settings.json` (SEC-005). |
| New logic belongs in pure modules free of `vscode`; I/O and `vscode` APIs partitioned to thin wrappers (e.g. `iconThemeCore.ts` pure vs `iconTheme.ts` I/O, `PersistentStore` in `repository.ts`) | `src/git.ts`, `src/gitParse.ts`, `src/validation.ts`, `src/guard.ts`, `src/layout.ts`, `src/repository.ts`, `src/remoteUrl.ts`, `src/iconThemeCore.ts`, `src/webview/{format,viewport,tree}.ts` | Inability to unit test business/domain logic under `node:test` without heavyweight stubs or full extension harness. |
| `.vscodeignore` maintained independently of `.gitignore`; only `dist/`, `resources/`, `package.json`, `README.md`, `CHANGELOG.md` in VSIX | `.vscodeignore` | Leaking internal docs, sources, source maps with developer paths into public extension package (SEC-002). |

## Deliberate Redactor Omission (DO NOT "FIX")

In `src/logger.ts`, bare 40-character hex strings are **intentionally not redacted**. A 40-hex classic OAuth token is byte-identical to a git object SHA-1 hash. Redacting bare 40-hex runs would erase every commit hash and tree object from the diagnostic log. Real secrets arrive via URL userinfo or `Authorization` headers, which are explicitly stripped by dedicated regex rules. A regression test (`test/logger.test.ts`) asserts that bare 40-hex object IDs remain untouched. Do not add a bare 40-hex redaction rule.

## Adding a Feature End-to-End

When implementing a new Git action, modify layers in this exact sequence:

1. `src/validation.ts`: Define/update pure input validators (no node/vscode imports).
2. `src/git.ts`: Add runner method using `this.run()` with `spawn` + `shell: false` + `--`.
3. `src/messages.ts`: Update typed request/response payload union types.
4. `src/guard.ts`: Define pre-execution safety rules and required confirmation levels.
5. `src/bridge.ts`: Wire request handling, validate payload, check guard, execute, format output.
6. `src/repository.ts`: Add or invalidate domain model caches if state changed.
7. `src/webview/store.ts`: Add action and state handler in Zustand store.
8. `src/webview/` components: Render UI controls and wire event handlers.
9. `src/webview/i18n.ts`: Add UI strings in BOTH `en` and `id` catalogs (en is source type, id implements `Catalog`).
10. `test/`: Add unit and regression tests. `test/i18n.test.ts` enforces key parity and forbids en/em-dashes.

## Testing Standards

- **Quality gates:** Both `npm test` and `npm run typecheck` must pass cleanly. Treat any test count drop or new failure as a regression. Never record absolute test counts in this document.
- **Harness:** Node built-in test runner (`node:test`) + strict assertions (`node:assert/strict`).
- **Fixtures:** Integration and git tests MUST use `test/repoFixture.ts` (`makeFixture(kind)`, `cleanup(dir)`) with `FixtureKind = 'single' | 'triple'`. Real repo templates are created with git once per test process, then copied per test via `fs.cp` (avoids 350-650 ms Windows git spawn overhead). To test a new repo shape, **add a new `FixtureKind` case; never hand-roll a repo inside a test**.
- **Rules:**
  - Every new feature or bugfix must include tests.
  - Never relax, disable, or delete existing security assertion checks to force a test pass.
  - Both `npm run typecheck` and `npm test` must pass cleanly before completing work.

## Code Conventions

- **TypeScript:** Strict mode enabled (`target: ES2022`, `module: Node16`, `noUncheckedIndexedAccess: true`).
- **Comments:** Comment the *why* and the *threat model/invariant*, not obvious mechanics (see docblocks in `src/git.ts` and `src/validation.ts`).
- **File size:** Existing large modules (`styles.css`, `GraphCanvas.tsx`, `i18n.ts`, `bridge.ts`) are structured by domain; do not introduce unneeded abstraction layers or micro-files.
- **Language:** English for all code, comments, commit messages, and docs. Product requirements in `docs/PRD_Git_Control.md` are in Indonesian.

## Documentation Style

- In prose, use ONLY single ASCII hyphens (`-`). Never use em dashes (U+2014), en dashes (U+2013), or double hyphens (`--`) as punctuation or parenthetical separators; replace them with periods, commas, colons, or parentheses. Machine rule: `test/i18n.test.ts` rejects U+2013/U+2014 in catalogs, extended here repo-wide.
- CRITICAL EXCEPTION: the dash rule applies ONLY to prose. In inline code, code blocks, commands, and argv, keep `--` intact. `--` before user paths in `src/git.ts` is a security invariant; CLI flags (`--noEmit`, `--watch`, `--production`, `--cached`) must remain intact. NEVER run a global find-replace for `--`.
- Zero emojis, zero stickers, zero decorative ASCII art, zero badges. Plain Markdown only.
- Professional English, declarative sentences, high density over expressiveness (tables and bullets over paragraphs). No hype, no pleasantries ("we are excited to"), no filler words (very, really, simply, just, obviously).
- Write instructions in imperative mood ("Run X", "Never import Y"), not narrative or optional advice.
- Scope: applies to `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/**`, code docblocks, commit messages, and PR descriptions.

## Git & Release Workflow

- **Branches:** Create a new branch from `main` for new features and bug fixes. Follow `<type>/<kebab-case-slug>` naming using Conventional Commits types (`feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `perf`, `ci`), e.g. `feat/vscode-file-icon-theme`. Minor updates do not require a branch and may commit directly to `main` (for example: typo fixes, wording adjustments in documentation, comment edits, and small configuration adjustments). When in doubt whether a change is minor, create a branch.
- **Commits:** Conventional Commits with scope in lowercase imperative without trailing period (`feat(webview): ...`, `fix(icons): ...`, `chore(release): ...`).
- **Merge gates:** For branched work, ensure `npm test` and `npm run typecheck` pass cleanly on the branch before reporting results and requesting merge. Never merge to `main` until user explicitly approves or requests it; task completion and passing all gates do not constitute approval.
- **Permissions:** Only commit or push when explicitly requested by user. Without explicit user request, never `push --force`, never `reset --hard` on published branches, never delete branches (`branch -D`), and never rewrite history.
- **Releases:** Update `CHANGELOG.md` following Keep a Changelog (`Added`, `Changed`, `Fixed`, `Security`) + SemVer, bump `package.json`, run `npm run package`.

## Project Boundaries (Strict Prohibitions)

- **Zero new runtime dependencies:** Keep runtime dependencies pinned to the 3 approved: `react`, `react-dom`, `zustand`.
- **No external git libraries:** Never install `simple-git`, `nodegit`, or shell wrappers. All git operations go through `src/git.ts`.
- **No backend / server components:** Git Control is an offline-capable client extension. No telemetry servers, no OAuth callback servers, no local databases.
- **No floating dependency versions:** All dependencies in `package.json` must remain exact-pinned (no `^` or `~`).
- **Never ship `docs/`:** `docs/` is internal and must remain ignored by `.vscodeignore` and `.gitignore`.
- **No destructive git execution:** Never run destructive commands (`git reset --hard`, `clean -fd`) against the user's workspace repository without explicit confirmation through guard gates.

## File Map

Encodes module purity boundaries (pure logic vs I/O) and execution trust boundaries not deducible from file paths. Update this table when adding or relocating modules.

| Path | Responsibility |
|---|---|
| `src/extension.ts` | Extension lifecycle, command registrations, secret management, webview provider |
| `src/git.ts` | Git execution engine, process spawning (`shell: false`), mutex locks, output parsing |
| `src/gitParse.ts` | Parsers for git log, numstat, status, refs, and diff outputs |
| `src/validation.ts` | Pure input sanitizers for hashes, branch names, paths, and remote names |
| `src/guard.ts` | Pure safety policy engine checking dirty/conflict/stale states before execution |
| `src/bridge.ts` | Host-side message router, error mapping, idempotency cache, guard enforcement |
| `src/messages.ts` | Type definitions for RPC messages, DTOs, and error codes |
| `src/repository.ts` | Repository state cache, commit graph layout invocation, commit pagination |
| `src/watcher.ts` | Dual-source file watcher (`vscode.workspace` + `fs.watch` for `.git`) with 500ms debounce |
| `src/logger.ts` | Diagnostic logger with regex credential redaction |
| `src/github.ts` | GitHub REST client with bounded response cache (`CACHE_MAX_ENTRIES = 200`, `AUTHOR_CACHE_MAX_ENTRIES = 1000`) and circuit breaker (5 failures / 60s) |
| `src/remoteUrl.ts` | Remote URL parser and credential stripper |
| `src/layout.ts` | Deterministic DAG layout engine (pure: no DOM, no git, no vscode; identical inputs yield byte-identical output; used only by `src/repository.ts`) |
| `src/iconTheme.ts` | Extension-host icon theme extractor (reads active JSON/JSONC, merges overlays, resolves asset URIs via `vscode.workspace.fs` + `vscode.Uri.joinPath` only) |
| `src/iconThemeCore.ts` | Pure core for file icon theme parsing and snapshot assembly (zero `vscode` imports, data-in/data-out) |
| `src/hostText.ts` | Localized strings for extension host error messages and dialogs |
| `src/webview/main.tsx` | Webview entry point and React root mount |
| `src/webview/store.ts` | Zustand store managing graph state, pending changes, selections, and modals |
| `src/webview/bridge.ts` | Webview-side RPC client dispatching requests to VS Code host |
| `src/webview/i18n.ts` | BCP-47 catalog (`en` and `id`) for webview localization |
| `src/webview/format.ts` | Pure presentation helpers and formatting functions (strings sourced from i18n catalog) |
| `src/webview/viewport.ts` | Pure viewport and virtualization maths for canvas (world vs screen coordinate spaces) |
| `src/webview/tree.ts` | Pure flat change paths to collapsible tree and tri-state selection maths |
| `src/webview/iconFontStyles.ts` | Nonce-bearing `<style>` / adopted stylesheet `@font-face` injector (strict CSP compliant) |
| `src/webview/ui.tsx` | Shared webview UI primitives (skeletons, banners, icons, error boundary) |
| `src/webview/GraphCanvas.tsx` | Canvas/SVG renderer for 2D git commit graph and lane routing |
| `src/webview/PendingChanges.tsx` | Tree view for staged, unstaged, and untracked file changes |
| `src/webview/Inspector.tsx` | Detail inspector for selected commit or file diff |
| `src/webview/CommitForm.tsx` | Commit message authoring, inline validation, and commit/push controls |
| `src/webview/GuardDialog.tsx` | Blocked-action guard modal offering remedies (commit/stash/fetch/cancel/resolve-conflicts/confirm) and 2-level confirmations |

## Canonical References

- `docs/PRD_Git_Control.md`: Product truth, feature requirements, and user flows (Indonesian). Gitignored.
- `docs/SECURITY_AUDIT.md`: Complete security posture, threat model (T1-T10), and vulnerability resolutions (SEC-001 to SEC-018). Gitignored.
