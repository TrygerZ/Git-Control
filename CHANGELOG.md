# Changelog

All notable changes to the "Git Control" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.6.17] - 2026-09-11

### Fixed
- Commit inspector file paging ignores late responses for a commit that is no longer selected.

## [2.6.16] - 2026-09-11

### Fixed
- Test suite now builds empty repositories through the shared fixture instead of hand-rolled setup.

## [2.6.15] - 2026-09-11

### Added
- Added unit tests for bridge request envelope parsing and idempotency decisions.

## [2.6.14] - 2026-09-11

### Added
- Added deterministic geometry tests for branch ribbon edge paths.

## [2.6.13] - 2026-09-11

### Added
- Added unit tests for the graph query pure helpers (`chipsFor`, `matchesSearch`, `lanesForFilter`).

## [2.6.12] - 2026-09-11

### Fixed
- Content Security Policy now pins `base-uri`, `form-action`, and `frame-src` to `'none'`.

## [2.6.11] - 2026-09-11

### Fixed
- Image sources (avatars, theme icons) are validated to `https:` or `data:image` before rendering, with existing fallbacks.

## [2.6.10] - 2026-09-11

### Fixed
- Webview validates host message shapes at intake and drops unknown or malformed events and responses (defense in depth).

## [2.6.9] - 2026-09-11

### Fixed
- Commit detail cache is bounded at 200 entries with insertion-order eviction to prevent unbounded memory growth in long read-only sessions.

## [2.6.8] - 2026-09-11

### Fixed
- Live stderr progress lines forwarded to the webview are now passed through the credential redactor.

## [2.6.7] - 2026-09-11

### Fixed
- Diagnostic log redaction now strips userinfo credentials on any URL scheme, including `ssh://` and schemeless forms.

## [2.6.6] - 2026-09-11

### Fixed
- File statistics parsing validates git rename records (`old => new`) and decodes quoted paths instead of inferring renames from column count.

## [2.6.5] - 2026-09-11

### Fixed
- Commit log parsing switched to NUL-delimited framing (`git log -z`), so commit messages containing delimiter control characters no longer corrupt the graph.

## [2.6.4] - 2026-09-11

### Fixed
- Commit now reports the HEAD hash read inside the mutation mutex, preventing the response from pointing at an unrelated concurrent commit.

## [2.6.3] - 2026-09-11

### Fixed
- Repository status cache now keeps separate results for the default and include-ignored reads, so ignored files appear consistently regardless of request order.

## [2.6.2] - 2026-09-11

### Fixed
- Push retry after remote-ahead or non-fast-forward guard failure no longer replays the cached failure: both transient codes are treated as retryable by the idempotency cache.

## [2.6.1] - 2026-09-11

### Fixed
- Canvas panning with left-click drag no longer accidentally selects commit labels.

## [2.6.0] - 2026-09-11

### Added
- Cherry-pick for single commits from the node context menu, with a full conflict flow: continue and abort actions are available while a cherry-pick is in progress, and conflicted files surface in the existing resolution panel.

## [2.5.1] - 2026-09-11

### Fixed
- Reverting a merge commit now succeeds by automatically passing the first-parent (`-m 1`) flag.

## [2.5.0] - 2026-09-11

### Added
- Stash management in the Pending Changes panel: list, apply (keeps the entry), and drop with a two-step destructive confirmation; expandable entries showing stash contents with file icons, line churn, and click-to-diff.
- "Stash N from <hash>" labels; clicking the hash opens or focuses the branch explorer canvas and selects that commit.
- Icon-only apply and drop buttons with hover tooltips.
### Changed
- Replaced the stash section glyph with a dedicated archive icon in its own color tone.
- All webview icons are now scaled relative to their adjacent text with optical alignment fixes.

## [2.4.0] - 2026-09-11

### Added
- Per-file discard for unstaged changes with a two-step destructive confirmation, blocked during active operations and conflicts.

## [2.3.0] - 2026-09-11

### Added
- Pull action for the active branch from its upstream, with a dirty working tree guard offering commit, stash, and cancel remedies.

## [2.2.0] - 2026-09-07

### Added
- Contributors leaderboard panel in the explorer sidebar: ranked commit counts per author with proportional bars, collapsible section below the Inspector (open by default), click to highlight an author.
- Contributor photo avatars in the leaderboard and graph nodes, resolved from GitHub with deterministic colored initials as fallback.
- Clicking a contributor opens their GitHub profile when verified, otherwise highlights their entry.

### Fixed
- File icon glyphs now fall back to the first theme font when a definition omits the font identifier, restoring Seti icon rendering.

## [2.1.1] - 2026-09-05

### Fixed
- Restored readable text contrast for the active branch in checkout dropdowns across the graph toolbar and sidebar, ensuring current branch items remain legible in native menus while redundant checkouts remain blocked.
- Eliminated layout shifts in the Pending Changes panel when folding or expanding sections, stabilizing scrollbar spacing and preserving header action button alignment.
- Prevented panel shifting during bulk staging operations, stabilizing section dividers so that emptying a change section does not displace neighboring groups.
- Resolved commit form and panel shifting when progress indicators appear or disappear, reserving a dedicated single-line status row with a minimum height floor so indicators never displace neighboring controls.
- Corrected misleading progress status messaging during staging and unstaging operations, ensuring indicators accurately reflect the active action instead of defaulting to a commit message.

### Changed
- Removed hover underlines from collapsible section headers in the Pending Changes panel to eliminate visual noise and maintain a clean appearance.

## [2.1.0] - 2026-09-05

### Added
- Dynamic file and folder icons resolved from the user's active VS Code File Icon Theme in both the Pending Changes panel and the commit inspector file list.
- Support for both SVG-based icon themes (such as Material Icon Theme or vscode-icons) and font-based themes (such as Seti, the VS Code default).
- Automatic icon updates upon theme switching, color theme mode toggles (light/dark/high-contrast), or extension installation and uninstallation without requiring a window reload.
- Collapsible section headers for Pending Changes panel groups (Conflicts, Staged Changes, Changes, Untracked Files) with persistent fold states preserved across sessions.
- Interactive folder row icons in Pending Changes panel reflecting open and closed folder states.

### Changed
- Realignment of Pending Changes panel file row layout to follow native VS Code Source Control conventions: file icons occupy the left column, while status badges (`M`, `A`, `D`, etc.) move to the right with color-coded status tones.
- Webview resource containment policy updated to include the active icon theme extension directory within `localResourceRoots` strictly when active, granting read-only access limited to the single active theme path.

### Security
- Whitelist validation for font definitions (identifier, format, weight, and style) before forwarding theme data to webviews.
- Rejection of font source URIs containing CSS-breaking delimiter characters (quotes, parentheses, semicolons, braces, backslashes, or line terminators) to prevent CSS injection.
- Enforced resource caps (5 MB file size limit, maximum 10,000 definitions inspected, and maximum 32 font faces) to prevent extension host freezing.
- Sanitization against `__proto__` prototype poisoning keys during theme map parsing and icon lookups.
- Path traversal guards preventing theme asset references from escaping the extension theme root directory.

## [2.0.1] - 2026-09-03

### Added
- Comprehensive extension documentation in `README.md` covering architecture, features, commands, settings, and security model.
- Feature showcase screenshots for 2D Branch Explorer and Pending Changes panel.

### Changed
- **Breaking:** Setting `gitControl.gitPath` now strictly requires an absolute path. Existing configurations using relative paths (e.g., `git` or `bin\git.exe`) will be rejected. Leaving the setting empty continues to resolve automatically from system PATH.
- Minified webview bundle in production mode for release artifacts, reducing `dist/webview.js` from ~1.4 MB to ~343 KB and packaged VSIX from ~437 KB to ~149 KB.
- Excluded local `screenshots/` assets from packaged VSIX artifacts.
- Refined extension description in `package.json` for marketplace visibility.
- Updated repository ignore rules for internal documentation, development scripts, and tooling artifacts.

### Fixed
- Resolved build pipeline race condition where bundle outputs were read before disk writes finished, eliminating non-deterministic test failures (`SyntaxError: Unexpected end of input`).

### Security
- Fixed arbitrary code execution vulnerability on Windows where spawning git with relative binary names in workspace directories allowed untrusted repositories containing a malicious `git.exe` to execute arbitrary code. Git binaries are now strictly resolved to absolute paths before invocation, `NoDefaultCurrentDirectoryInExePath=1` is injected into the process environment, and relative PATH lookups/settings are rejected.

## [2.0.0] - 2026-09-03

### Added
- Interactive 2D Git DAG canvas with deterministic branch lane allocation, horizontal timeline layout, minimap, and zooming controls.
- Dedicated Pending Changes panel with tri-state staging, inline file churn counters, batch actions, and recursive directory selection.
- Two-stage safety guard framework preventing accidental destructive operations (hard reset, clean merge, push-to-diverged).
- Integrated GitHub client supporting PR status badges, commit author avatars, rate-limiting circuit breaker, and token management via SecretStorage.
- Bilingual interface support (English and Bahasa Indonesia) with runtime switching and persistent settings broadcast.
- Node context menu for branch creation, switch/checkout, soft/hard reset, revert, merge-into, and fast-forward push.
- Detailed commit inspector with multi-parent comparison, file change pagination, and VS Code native diff integration.

### Changed
- Overhauled webview design system with tokenized spacing, accessible color tones, and native VS Code theme alignment.
- Migrated graph and toolbar icon assets to inline lightweight SVG paths.
- Serialized repository mutations behind an exclusive mutex lock to prevent concurrent git command collisions.

### Fixed
- Restricted git execution boundaries and neutralized bidirectional / control characters in untrusted commit metadata.
- Bound popovers and swatch rings to canvas boundaries to avoid scrollport clipping.
- Ensured staging operations properly track untracked files without pathspec errors.
- Handled merge conflict states gracefully with porcelain parser reporting and dedicated resolution view.
