/**
 * Webview entry point.
 *
 * The host sets `<body data-view="explorer">`, `data-view="pending">`, or
 * `data-view="pr"`; this file branches on that and mounts the matching root
 * inside the global {@link ErrorBoundary} so a render crash degrades to a
 * message plus a reload button instead of a blank panel (PRD §9).
 *
 * Deviation, deliberate: `React.lazy` and code splitting are unusable here. The
 * bundle is a single IIFE and the CSP forbids dynamic script loading
 * (`script-src 'nonce-…'` only), so there is no way to fetch a chunk at runtime.
 * The initial render is kept cheap instead — every root renders a skeleton while
 * its first request is in flight, and the graph virtualizes rows so mount cost
 * does not scale with history size.
 */
import { createRoot } from 'react-dom/client';
import { ExplorerApp } from './ExplorerApp';
import { PendingChangesApp } from './PendingChanges';
import { PullRequestApp } from './PullRequestApp';
import { ErrorBoundary, IconThemeStyles } from './ui';

const host = document.getElementById('root');

if (host !== null) {
  const view = document.body.dataset.view;
  createRoot(host).render(
    <ErrorBoundary>
      {/* Theme icon fonts for every root; renders nothing itself. */}
      <IconThemeStyles />
      {view === 'pending' ? (
        <PendingChangesApp />
      ) : view === 'pr' ? (
        <PullRequestApp />
      ) : (
        <ExplorerApp />
      )}
    </ErrorBoundary>,
  );
}
