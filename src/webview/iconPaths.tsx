import type { JSX } from 'react';
import type { IconName } from './icons';

export const ICON_PATHS: Record<IconName, () => JSX.Element> = {
  // Navigation / Utility
  search: () => (
    <>
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M10 10l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  'git-branch': () => (
    <>
      <circle cx="4.5" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="4.5" cy="12" r="1.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="11.5" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M4.5 5.75v4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11.5 5.75v1.25a3 3 0 0 1-3 3h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  'circle-filled': () => (
    <circle cx="8" cy="8" r="4.5" fill="currentColor" />
  ),
  cloud: () => (
    <path
      d="M5.5 13h5.75a3.25 3.25 0 0 0 .7-6.42A4 4 0 0 0 4.25 8.5 2.75 2.75 0 0 0 5.5 13z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  tag: () => (
    <>
      <path
        d="M2.5 8.5V3.5h5l6 6-5 5-6-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="5.5" cy="5.5" r="1" fill="currentColor" />
    </>
  ),
  watch: () => (
    <>
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M8 5.5v2.75l2 1.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 1.5h4M6 14.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  ellipsis: () => (
    <>
      <circle cx="4" cy="8" r="1.25" fill="currentColor" />
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
      <circle cx="12" cy="8" r="1.25" fill="currentColor" />
    </>
  ),
  home: () => (
    <path
      d="M2.5 7.5L8 3l5.5 4.5V13a1 1 0 0 1-1 1h-3V9.5H6.5V14h-3a1 1 0 0 1-1-1V7.5z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  dash: () => (
    <path d="M4 8h8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  ),
  add: () => (
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
  ),
  'chevron-right': () => (
    <path d="M6 3.5l4.5 4.5L6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  'chevron-down': () => (
    <path d="M3.5 6l4.5 4.5L12.5 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  'chevron-left': () => (
    <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  'chevron-up': () => (
    <path d="M3.5 10l4.5-4.5L12.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  warning: () => (
    <>
      <path
        d="M7.13 2.75a1 1 0 0 1 1.74 0l5.5 9.5A1 1 0 0 1 13.5 13.75H2.5a1 1 0 0 1-.87-1.5l5.5-9.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M8 6.25v3.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r=".8" fill="currentColor" />
    </>
  ),
  error: () => (
    <>
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  info: () => (
    <>
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="8" cy="5.5" r=".8" fill="currentColor" />
      <path d="M8 7.5v3.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  close: () => (
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  ),
  'arrow-down': () => (
    <>
      <path d="M8 3v9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.5 9l3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  'arrow-up': () => (
    <>
      <path d="M8 13V3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.5 7l3.5-3.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  refresh: () => (
    <>
      <path
        d="M13.25 7.5A5.5 5.5 0 1 0 12.5 11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path d="M13.5 3.5v4.25H9.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  discard: () => (
    <>
      <path
        d="M3 6.5h6a4 4 0 0 1 4 4v2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M6 3L2.5 6.5 6 10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </>
  ),
  // Tombol buka Canvas / Graph Explorer: node commit graph dengan relasi cabang
  graph: () => (
    <>
      <circle cx="4" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <circle cx="4" cy="12" r="1.75" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <circle cx="12" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M4 5.75v4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4 6.5a4.5 4.5 0 0 1 4 2.5l2.25 1.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  // Status M: File modified (pensil menulis dokumen / file edit)
  'diff-modified': () => (
    <>
      <path
        d="M9 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M6.5 9.5l3.75-3.75 1.5 1.5L8 11H6.5V9.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="currentColor"
      />
    </>
  ),
  // Status A: File added (tanda plus bersih dan tebal)
  'diff-added': () => (
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  ),
  // Status D: File removed (tanda minus bersih dan tebal)
  'diff-removed': () => (
    <path d="M3.5 8h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  ),
  // Status R: File renamed (tanda panah lengkung transisi nama)
  'diff-renamed': () => (
    <>
      <path d="M3.5 10a4 4 0 0 1 4-4h4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M9.5 3.5l3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  // Status C: Copied file (dua halaman bertumpuk)
  copy: () => (
    <>
      <rect x="5.5" y="5.5" width="7" height="8" rx="1" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M3.5 10.5V3.5A1 1 0 0 1 4.5 2.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </>
  ),
  // Status T: File type changed (symlink / link icon)
  'file-symlink-file': () => (
    <>
      <path d="M6.5 9.5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M5 8L3.5 9.5a2.12 2.12 0 1 0 3 3L8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M11 8l1.5-1.5a2.12 2.12 0 1 0-3-3L8 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </>
  ),
  // Status ?: File untracked (file berkas baru dengan plus kecil di pojok kanan bawah)
  question: () => (
    <>
      <path
        d="M8.5 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M8.5 2.5L12 6v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M11.5 10v4M9.5 12h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // Status !: File ignored (lingkaran slash / do not track)
  'diff-ignored': () => (
    <>
      <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M4.5 4.5l7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  // External link: leaves the app (Open on GitHub). Distinct from clipboard pair.
  external: () => (
    <>
      <path d="M5 3.5H3.5A1 1 0 0 0 2.5 4.5v8A1 1 0 0 0 3.5 13.5h8a1 1 0 0 0 1-1V11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M9.5 3.5h3v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M6.5 9.5l6-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  // Generic file (theme icon fallback): page with folded corner.
  file: () => (
    <>
      <path
        d="M4 2.5h4.5L12 6v7.5H4z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M8.5 2.5V6H12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  // Generic closed folder (theme icon fallback).
  folder: () => (
    <path
      d="M2.5 4.5l.5-.5h4l1 1.5h5.5l.5.5v6l-.5.5H3l-.5-.5z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  // Git stash / archive storage box: lid with slight overhang, recessed body, and horizontal handle slot.
  archive: () => (
    <>
      <rect
        x="2"
        y="3"
        width="12"
        height="3"
        rx="0.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M6 8.75h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // Success confirmation: a single confident tick, heavier than a chevron so it reads as done.
  check: () => (
    <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  ),
  // Push: arrow rising out of the local baseline toward the remote line above.
  push: () => (
    <>
      <path d="M8 12.5V4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.5 7.5L8 4l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M3.5 13.75h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // Pull: push mirrored; the arrow lands on the baseline instead of leaving it.
  pull: () => (
    <>
      <path d="M8 3.5v8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4.5 8.5L8 12l3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M3.5 13.75h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // Fetch: two half-arcs chasing each other. Distinct from `refresh`, which is one
  // arc with an arrowhead and means "reload this view".
  fetch: () => (
    <>
      <path d="M13.5 8a5.5 5.5 0 0 0-9.9-3.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M2.5 8a5.5 5.5 0 0 0 9.9 3.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M3.5 2.25v2.75h2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M12.5 13.75V11H9.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  // Commit: the node the whole graph is drawn with, ring with a filled centre.
  commit: () => (
    <>
      <circle cx="8" cy="8" r="4.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" />
    </>
  ),
  // Merge: two parent lanes joining into one child, the mirror of `git-branch`.
  merge: () => (
    <>
      <circle cx="4.5" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="11.5" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="8" cy="12" r="1.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M4.5 5.75v1.5a2.5 2.5 0 0 0 2.5 2.5h.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M11.5 5.75v1.5a2.5 2.5 0 0 1-2.5 2.5h-.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M8 9.7v.55" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // Cherry-pick: two cherries on a shared stem, one targeted commit taken across.
  'cherry-pick': () => (
    <>
      <path d="M8.75 2.5c.9 1.9.9 3.6.05 5.1-.85-1.5-.85-3.2-.05-5.1z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none" />
      <path d="M8.8 7.6C7.6 5.9 5.9 5.3 4.6 6.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M8.8 7.6c1.2-1.7 2.9-2.3 4.2-1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <circle cx="4.5" cy="10.5" r="2.25" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <circle cx="11.5" cy="10.5" r="2.25" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </>
  ),
  // Revert: counter-clockwise arc with the head pointing backwards in time.
  revert: () => (
    <>
      <path d="M2.75 7.5A5.5 5.5 0 1 1 3.5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M2.5 3.5v4.25h4.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
  // Reset: a lane returning to an earlier node. The filled dot is the target commit.
  reset: () => (
    <>
      <path d="M12.5 4H6.5a3 3 0 0 0-3 3v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M9.5 1.75L12.5 4 9.5 6.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="5" cy="11.5" r="2.25" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <circle cx="5" cy="11.5" r=".8" fill="currentColor" />
    </>
  ),
  // Eye: view a diff or preview without changing anything.
  eye: () => (
    <>
      <path
        d="M2.5 8s2.25-4 5.5-4 5.5 4 5.5 4-2.25 4-5.5 4-5.5-4-5.5-4z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="8" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </>
  ),
  // Filter funnel: wide mouth narrowing to a short spout.
  filter: () => (
    <path
      d="M3 3.5h10l-3.75 4.75v4l-2.5 1.25v-5.25L3 3.5z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  // Single person: head over shoulders, for the author of one commit.
  user: () => (
    <>
      <circle cx="8" cy="5.25" r="2.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M3.25 13.5a4.75 4.75 0 0 1 9.5 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </>
  ),
  // Contributors: a full figure in front with a second head peeking behind.
  users: () => (
    <>
      <circle cx="6" cy="5.5" r="2.25" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <path d="M1.75 13.25a4.25 4.25 0 0 1 8.5 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M10.25 3.5a2.25 2.25 0 0 1 0 4.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M11.25 9.35a4.25 4.25 0 0 1 3 3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </>
  ),
  // Settings gear: eight teeth around a centre bore.
  settings: () => (
    <>
      <circle cx="8" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path
        d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.76 3.76l1.06 1.06M11.18 11.18l1.06 1.06M12.24 3.76l-1.06 1.06M4.82 11.18l-1.06 1.06"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  // Layout toggle with the sidebar on the left.
  'panel-left': () => (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  // Layout toggle with the sidebar on the right.
  'panel-right': () => (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M9.5 3v10" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  // Diff: two panes side by side, the right one inset like a changed region.
  diff: () => (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9.75 5.75h2M9.75 8h2M9.75 10.25h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
  // History: a clock with the minute hand and a rewind tick at the top-left.
  history: () => (
    <>
      <path d="M3 4.5A5.75 5.75 0 1 1 2.25 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M2.5 2.25v2.5H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M8 5.5v2.75l2 1.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // Branch-add: the standard branch glyph with a small plus at its fork.
  'branch-add': () => (
    <>
      <circle cx="4" cy="4" r="1.75" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <circle cx="4" cy="12" r="1.75" stroke="currentColor" strokeWidth="1.4" fill="none" />
      <path d="M4 5.75v4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4 8.5a3.5 3.5 0 0 1 3.5-3.5H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M12 3v4M10 5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </>
  ),
  // Trash: bin with a lid and two vertical ribs, for dropping a stash entry.
  trash: () => (
    <>
      <path d="M3 4.5h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M4.25 4.5l.5 8a1.5 1.5 0 0 0 1.5 1.5h3.5a1.5 1.5 0 0 0 1.5-1.5l.5-8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M6.75 7.25v4M9.25 7.25v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
};
