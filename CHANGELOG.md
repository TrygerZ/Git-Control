# Changelog

All notable changes to the "Git Control" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.18.0] - 2026-11-14

### Added
- Create a pull request from the Pull requests view, with the title and description prefilled from your commits and the repository template.
- A branch that is not on the remote is published with upstream tracking first, then the pull request is created. Nothing is ever force-pushed.
- Choose the base and compare branches, request reviewers, and open the pull request as a draft.
- The dialog previews the exact push command and API call that will run, and shows the template path it read.
- A pull request that already exists for the same branch pair is reported with its number and a link, instead of creating a second one.
- Without a GitHub token the dialog explains how to connect and offers a publish-only path that pushes the branch without calling the API.
- Quick actions and the Help panel offer Create pull request when the current branch is ahead of its upstream.

### Changed
- Creating a pull request needs a token with write access to pull requests. Reconnect if your token only has read access.
- A reviewer that GitHub refuses no longer hides a successful creation; the names that could not be requested are listed in the toast.

## [3.17.0] - 2026-11-13

### Added
- Commit inspector shows the pull request that contains the selected commit, with its state, base branch, and a summary of its checks.
- Pull request rows show how many checks passed, or which ones are failing, loaded only for the rows scrolled into view.
- A commit that is in no pull request says so and asks GitHub for nothing further.

### Changed
- Pull request data now carries the head commit, so a row can read its checks without a second lookup.
- The check summary folds a commit's check runs into one badge: a completed failure outranks a run still in progress, and skipped or neutral checks count as passed.

### Security
- Both new GitHub reads are validated before they reach the API, and neither sends a request without a connected token.
- A check read that fails is remembered as unavailable for 30 seconds instead of being retried on every scroll.

## [3.16.0] - 2026-11-12

### Added
- Branches view can clean up merged local branches from one dialog. Git's own refusal is shown when a branch is not safe to delete.
- Optional second step deletes the same branches on the remote, after an explicit acknowledgement in the same dialog.
- A single merged branch can be deleted from its row menu.
- The cleanup banner names how many branches are merged and disappears when none remain.

### Changed
- The guard dialog's stage 2 acknowledgement describes the loss that is actually about to happen, so a remote branch delete no longer warns about uncommitted local changes.
- `GuardSnapshot` carries the current branch, so the guard itself can refuse deleting the branch you are on instead of leaving it to git.

### Security
- Branch deletion uses the safe delete only. Unmerged branches and the current branch are never removed, and no forced delete exists anywhere in the code.
- Remote deletion is a separate operation from push, so the force-push rejection is unchanged.

## [3.15.1] - 2026-11-12

### Changed
- GitHub changes are checked by a guard that verifies the connection, token trust, and granted permissions before anything is sent.
- A GitHub change is sent once. The client never retries a write and never answers one from cache, so a repeated request cannot create a duplicate pull request, comment, or release.
- Duplicate clicks on a GitHub action are joined into one request instead of racing each other.
- A write refused for lack of permission now names the permission it needs instead of reporting a bare access denial.

### Security
- Write requests are refused when the API host was derived from a repository remote, so the token is never sent there.

## [3.15.0] - 2026-11-12

### Added
- Explorer header gains Fetch, Pull, and Publish or Push buttons beside the breadcrumbs, with ahead and behind counts. They run the same actions and the same guard flow as the sidebar footer, and the group is hidden when the repository has no remote.
- The third button reads Publish while the branch has no upstream and Push once it has one. Pull is disabled without an upstream and on a detached HEAD, and Push is disabled while the branch is in sync.

## [3.14.0] - 2026-11-11

### Added
- Explorer header gains a Help button and a More menu. The menu lists Quick actions, every sidebar view with its Changes and Pull requests counts, Refresh graph, Show Git output, GitHub connect or disconnect, and Pick repository.
- Choosing a view reveals the sidebar on that view, even when the sidebar was never opened in this session.
- Both header buttons render in every Explorer state, including while the repository is still loading.

### Changed
- GitHub connect and disconnect are reachable from the Explorer More menu instead of the removed details panel.

### Fixed
- The Help panel draws its back, title, and close in the header slot the repository header otherwise owns, so the nav strip sits below it instead of under a second header.
- Closing Help returns focus to the info button that opened it, and only that path moves focus: a nav strip click, a feature row, and the Publish row keep their own target.

## [3.13.0] - 2026-11-11

### Added
- Help panel in the sidebar with two tabs. Features explains every shipped view in one sentence and opens it, and Shortcuts lists the keys that actually drive the graph, the change list, and the menus. Open it from the info button in the sidebar header or from `Git Control: Help and Shortcuts`.
- Every listed shortcut is tied to the handler that implements it by a test, so a key that disappears from the code cannot stay in the panel.
- The Help footer brings the Get started checklist back after it was dismissed.

### Changed
- Quick actions gains a Help row and the sidebar header gains the info button.

## [3.12.0] - 2026-11-11

### Added
- Get started card in the Changes view guides a new repository from the first commit to a pull request. Each step is derived from the current branch and GitHub state, so nothing is stored and nothing can drift.
- The current step carries its own action: connect GitHub, publish the branch, or open the compare page on GitHub. The publish button reuses the footer push, so the usual guards and confirmations apply.
- The card can be dismissed at any time, and a completed card hides itself after three seconds. Dismissal is remembered per workspace, and the Quick actions palette offers a row that reopens the card.

### Changed
- Quick actions now lists the Get started checklist row.

## [3.11.0] - 2026-11-10

### Added
- Quick actions command (`Git Control: Quick Actions`, `Ctrl+K G` or `Cmd+K G`) opens a palette with up to three suggested next steps for the current branch, followed by a shortcut to every sidebar view.
- Suggestions follow the repository state: resolve conflicts while an operation is open, publish an unpublished branch, push commits that the remote does not have, and commit staged files. A branch whose latest run failed also offers Actions.
- Search icon in the sidebar header opens the same palette.
- Choosing a row opens the matching view and focuses its control. Nothing runs until you press the button.

### Changed
- The publish suggestion counts only commits the remote does not have, so a branch sitting on published history no longer offers a publish.

## [3.10.0] - 2026-11-09

### Added
- Job rows in the Actions view expand to show the last 200 lines of the job log, so a failed step can be read without leaving the editor. The first failed job opens automatically when a run expands.
- Open full log opens the job page on GitHub.

### Security
- Job logs are downloaded from the signed storage link without sending the GitHub token, only from validated HTTPS hosts, with size, time, and line limits.
- Signed URL secrets are redacted from the Git Control output channel.

## [3.9.0] - 2026-11-09

### Added
- Actions view in the sidebar lists GitHub Actions workflow runs for the current branch and for all branches, with filters for branch and workflow.
- Run rows expand to show their jobs. Running workflows refresh automatically.
- The Actions tab shows a red dot when the latest run on the current branch failed.
- Git Control: Open Actions command.

## [3.8.1] - 2026-11-08

### Changed
- GitHub requests now use conditional requests, so unchanged pull request and repository data no longer consumes API quota.
- Reload in the Pull requests view revalidates against GitHub instead of showing a cached copy.

### Fixed
- A 304 Not Modified response is no longer treated as a GitHub failure.

## [3.8.0] - 2026-11-08

### Added
- Branches view in the sidebar lists local branches, remote branches, and tags, with labels for merged, local-only, and upstream-gone branches.
- Branches can be sorted by recent activity, name, or ahead and behind. The choice is remembered per workspace.
- Branch rows offer Checkout, Merge into current, and Copy branch name. Checkout on uncommitted changes keeps the existing stash or commit prompt.
- Git Control: Open Branches command.

## [3.7.1] - 2026-11-08

### Changed
- Branch data now includes upstream-gone state, last activity date, and merged state, plus a read-only worktree list, as groundwork for the Branches view.

## [3.7.0] - 2026-11-07

### Added
- "Start work" on an expanded issue creates a branch named from the issue number and title (for example `feat/97-lane-gutter-push-state`) and switches to it, with a preview of the Git command.
- The suggested name uses `fix/` when the issue carries a `bug` label and `feat/` otherwise. It can be edited before the branch is created.
- A note appears when the working tree is dirty, because uncommitted changes move to the new branch with you.

## [3.6.0] - 2026-11-07

### Added
- Issues view in the sidebar with Assigned, Created and Mentioned filters, state and label filters, and a text filter.
- Issue count badge on the Issues tab.
- Command "Git Control: Open Issues".

## [3.5.0] - 2026-11-06

### Added
- Pull requests view in the sidebar with Open, Review requested, Mine and Draft filters, a current branch card and a text filter.
- Navigation strip with Changes and Pull requests tabs and a pull request count badge.
- Command "Git Control: Open Pull Requests".
- Clear states for loading, no GitHub remote, empty results, API rate limit and private repositories without a token.
- Banner "Sign in for higher limits" with a Connect GitHub button above the pull request list when signed out.

### Changed
- The sidebar view is now named "Git Control".
- Pull requests moved from the Explorer details panel to the sidebar. They still load without sign-in for public repositories.

## [3.4.0] - 2026-11-06

### Added
- "Amend last commit" toggle in the commit footer. It loads the last commit message and replaces that commit with the staged changes and the message.

### Changed
- The commit message box, "Push to remote after commit", and the Commit, Push, and Pull buttons now sit in a footer pinned to the bottom of the Pending Changes view. The file list scrolls above it.
- Select all and Clear moved from the toolbar into the list header.
- Notifications now appear above the footer.
- Amend is blocked when the last commit may already be on the upstream branch, because pushing it would need a force push. The footer explains why.

## [3.2.0] - 2026-11-05

### Added
- Changes and Stashes tabs at the top of the Pending Changes list, with counts.
- A search row in the Stashes tab that filters by the stash label or hash prefix. A filtered list keeps the original stash numbers, so Apply and Drop still target the right stash.

### Changed
- Stashes moved from the pinned footer into their own tab. Apply, drop, and file previews work as before.
- The open tab is remembered when the sidebar is hidden and shown again.
- Merge, rebase, and conflict banners now appear below the tabs.

## [3.1.0] - 2026-11-05

### Changed
- The Pending Changes header now has three rows: the repository name with refresh and open-graph buttons, the branch selector with a sync chip, and the upstream name with the short HEAD hash. Branch switching moved from the action toolbar into this header.
- Added the navigation strip component and its keyboard model for the sidebar. It stays hidden until a second section exists, so it is not visible yet.

## [3.0.3] - 2026-11-04

### Changed
- The sidebar remembers which view was last open and can be told which view to show. No visible change yet.

## [3.0.2] - 2026-11-04

### Changed
- Dialog keyboard handling (Tab trap and Escape) now lives in one shared hook. Behavior is unchanged.

## [3.0.1] - 2026-11-04

### Changed
- Webview colors now come from a named token layer derived from the VS Code theme. No visual change.

## [3.0.0] - 2026-11-04

### Changed
- Starts the 3.x line. No command, setting, or view id changes.

### Fixed
- README keyboard shortcut table now matches the graph. Left and Right move between commits, Up and Down move between lanes.

## [2.7.0] - 2026-09-21

### Added
- Commit inspector now renders the author's GitHub avatar, falling back to deterministic initials when the author is unlinked or the image fails to load.
- Stash section is pinned to the sidebar footer as its own dropdown, matching the VS Code Source Control graph menu, instead of scrolling with the change list.
- Active change row content (checkbox, file icon, name) is inset from the panel edge while the selection wash stays flush to both edges, mirroring VS Code list behaviour.

### Changed
- Pending Changes panel is denser: smaller change row height, compact section headers, a toned-down list header, and a rebalanced commit card, so the sidebar reads nearly full width.
- Selection toolbar is now laid out as two aligned full-width rows: the branch selector fills the first, and the Select all / Clear controls share the second at equal widths, keeping the layout stable across English and Indonesian labels.
- Commit card bottom padding is balanced against its top and side padding, removing the oversized gap above the toolbar.
- Branch selector and stash rows are aligned to the same content inset as change rows.

### Fixed
- Context bar no longer shows the ahead/behind count twice: the green arrow badge keeps the number while the adjacent sentence names the upstream only.
- Scrollbar gutter in the Branch Explorer aside is reserved, so the dropdown chevron no longer drifts left or right when the file list scrolls.
- Tree indentation is additive to the row content inset, so the indent survives at every folder depth instead of collapsing the left inset on root rows.

## [2.6.19] - 2026-09-20

### Fixed
- Commit cards in the top graph lane are no longer cut off by the sticky date ruler when a node is both selected and hovered (z-index cascade conflict), and resting selected cards now also clear the ruler.

## [2.6.18] - 2026-09-12

### Fixed
- Commit graph horizontal culling now uses actual world x positions instead of uniform column indices, preventing partially missing commit nodes when panning right on repositories with date gaps.

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
