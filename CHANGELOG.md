# Changelog

All notable changes to the "Git Control" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
