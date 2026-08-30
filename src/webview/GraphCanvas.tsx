/**
 * The DAG canvas (FEAT-01).
 *
 * Rendering model
 * ---------------
 * One native-scrolling container holds a world sized `rowCount × rowHeight ×
 * zoom`. Inside it, only the rows intersecting the viewport (plus overscan) are
 * rendered — as SVG nodes/edges in a single `<svg>` and as absolutely positioned
 * HTML rows for the text. At 10 000 commits the DOM holds roughly 60 rows, not
 * 10 000.
 *
 * Layout comes from the host (`src/layout.ts`). This file only maps
 * `lane`/row index onto screen space; it never recomputes lanes or edges.
 *
 * Accessibility
 * -------------
 * `role="grid"` with `aria-rowcount` on the container and `aria-rowindex` on
 * each rendered row — the standard way to expose a virtualized list. Every
 * commit state is encoded redundantly (shape, dash pattern, badge, accessible
 * name) so colour is never the only signal.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { BranchLegend } from './BranchLegend';
import { GraphMinimap } from './GraphMinimap';
import { NodeContextMenu, type MenuAnchor, type MenuItem } from './NodeContextMenu';
import { relativeTime, sanitizeGitText, shortHash, truncate } from './format';
import { useRepoStore, useSettingsStore } from './store';
import {
  DEFAULT_OVERSCAN,
  LANE_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_RADIUS,
  ROW_HEIGHT,
  clampZoom,
  edgeIntersectsBand,
  laneX,
  rowY,
  scrollToRow,
  stepZoom,
  visibleRowRange,
  visibleWorldBand,
  worldHeight,
  worldWidth,
} from './viewport';
import { EmptyState, GraphSkeleton, InfoBanner, Spinner } from './ui';
import type { GraphEdge, GraphNode, RefInfo, RepoGraph, RepoStatus } from '../messages';

const SUBJECT_MAX = 72;
const MINIMAP_HEIGHT = 160;

interface Props {
  graph: RepoGraph | null;
  status: RepoStatus | null;
  loading: boolean;
  paging: boolean;
  githubUrl: string | null;
  onMenuCommand(item: MenuItem, node: GraphNode): void;
  onOpenInspector(hash: string): void;
}

/** Ref chip kinds, in the order they should appear next to a commit. */
type ChipKind = 'current' | 'local' | 'remote' | 'tag';

interface Chip {
  kind: ChipKind;
  glyph: string;
  prefix: string;
  name: string;
}

const CHIP_GLYPH: Record<ChipKind, string> = {
  current: '◆',
  local: '●',
  remote: '☁',
  tag: '⚑',
};

/**
 * Turn raw `refNames` into display chips. Remote refs are distinguished by a
 * glyph plus a `remote/` text prefix, so the difference survives a monochrome
 * high-contrast theme.
 *
 * Ref names come from git, so `name` is sanitised for display. Comparisons —
 * "is this the current branch?" — run on the raw value, because the raw value is
 * what the host will act on.
 */
export function chipsFor(refNames: readonly string[], currentBranch: string | null): Chip[] {
  const chips: Chip[] = [];
  for (const raw of refNames) {
    const name = raw.trim();
    if (name.length === 0 || name === 'HEAD') continue;
    if (name.startsWith('tag: ')) {
      chips.push({
        kind: 'tag',
        glyph: CHIP_GLYPH.tag,
        prefix: 'tag ',
        name: sanitizeGitText(name.slice(5)),
      });
      continue;
    }
    const isRemote = name.includes('/') && !name.startsWith('refs/heads/');
    const short = name.replace('refs/heads/', '').replace('refs/remotes/', '');
    if (isRemote) {
      chips.push({
        kind: 'remote',
        glyph: CHIP_GLYPH.remote,
        prefix: 'remote ',
        name: sanitizeGitText(short),
      });
      continue;
    }
    const isCurrent = currentBranch !== null && short === currentBranch;
    chips.push({
      kind: isCurrent ? 'current' : 'local',
      glyph: isCurrent ? CHIP_GLYPH.current : CHIP_GLYPH.local,
      prefix: '',
      name: sanitizeGitText(short),
    });
  }
  // Current branch first, then locals, remotes, tags.
  const order: Record<ChipKind, number> = { current: 0, local: 1, remote: 2, tag: 3 };
  return chips.sort((a, b) => order[a.kind] - order[b.kind]);
}

/**
 * Accessible name for a commit row, per the PRD's example wording.
 *
 * Sanitised for the same reason the visual row is: a screen-reader user makes the
 * same decisions from this string that a sighted user makes from the row, and the
 * two must not be able to disagree.
 */
export function rowLabel(node: GraphNode, now: number): string {
  const parts = [
    `commit ${shortHash(node.hash)}`,
    sanitizeGitText(node.subject),
    `oleh ${sanitizeGitText(node.authorName)}`,
    relativeTime(node.authoredAt, now),
  ];
  if (node.isHead) parts.push('HEAD');
  if (node.isMerge) parts.push('commit merge');
  if (node.local) parts.push('lokal belum dipush');
  return parts.join(', ');
}

/** Case-insensitive match over hash, subject, and author. */
export function matchesSearch(node: GraphNode, needle: string): boolean {
  if (needle.length === 0) return true;
  const q = needle.toLowerCase();
  return (
    node.hash.toLowerCase().includes(q) ||
    node.subject.toLowerCase().includes(q) ||
    node.authorName.toLowerCase().includes(q)
  );
}

/** Lane indices to keep for a branch filter, or `null` for "keep everything". */
export function lanesForFilter(graph: RepoGraph, filter: string): Set<number> | null {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return null;
  const keep = new Set<number>();
  for (const lane of graph.lanes) {
    if (lane.ref === undefined) continue;
    if (lane.ref.toLowerCase().includes(needle)) keep.add(lane.index);
  }
  return keep.size === 0 ? null : keep;
}

export function GraphCanvas({
  graph,
  status,
  loading,
  paging,
  githubUrl,
  onMenuCommand,
  onOpenInspector,
}: Props): JSX.Element {
  const zoom = useSettingsStore((s) => s.zoom);
  const setZoom = useSettingsStore((s) => s.setZoom);
  const search = useSettingsStore((s) => s.search);
  const setSearch = useSettingsStore((s) => s.setSearch);
  const branchFilter = useSettingsStore((s) => s.branchFilter);
  const setBranchFilter = useSettingsStore((s) => s.setBranchFilter);
  const selectedHash = useRepoStore((s) => s.selectedHash);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const loadMore = useRepoStore((s) => s.loadMore);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [menu, setMenu] = useState<{ node: GraphNode; anchor: MenuAnchor } | null>(null);
  const [focusRow, setFocusRow] = useState(0);
  const spaceHeld = useRef(false);
  const panFrom = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const now = useMemo(() => Date.now(), [graph]);

  // Track the viewport height so the row window matches reality after a resize.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return undefined;
    setViewportHeight(node.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // `space` toggles pan mode; tracked on the document so it works mid-drag.
  useEffect(() => {
    const down = (event: globalThis.KeyboardEvent): void => {
      if (event.code === 'Space') spaceHeld.current = true;
    };
    const up = (event: globalThis.KeyboardEvent): void => {
      if (event.code === 'Space') spaceHeld.current = false;
    };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => {
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
    };
  }, []);

  // ctrl/cmd + wheel zooms. Registered natively because React's wheel handler
  // is passive and cannot call `preventDefault`.
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(clampZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [setZoom, zoom]);

  const rows: GraphNode[] = useMemo(() => {
    if (graph === null) return [];
    const keep = lanesForFilter(graph, branchFilter);
    return keep === null ? graph.nodes : graph.nodes.filter((n) => keep.has(n.lane));
  }, [graph, branchFilter]);

  /** hash → row index, so edges can be placed without scanning. */
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((node, index) => map.set(node.hash, index));
    return map;
  }, [rows]);

  const laneCount = graph === null ? 1 : Math.max(1, graph.lanes.length);
  const range = visibleRowRange({
    scrollTop,
    viewportHeight,
    rowCount: rows.length,
    zoom,
    rowHeight: ROW_HEIGHT,
    overscan: DEFAULT_OVERSCAN,
  });
  const band = visibleWorldBand(scrollTop, viewportHeight, zoom, DEFAULT_OVERSCAN, ROW_HEIGHT);
  const gutterWidth = worldWidth(laneCount, LANE_WIDTH);

  const visibleEdges = useMemo(() => {
    if (graph === null) return [];
    const out: Array<{ edge: GraphEdge; fromY: number; toY: number }> = [];
    for (const edge of graph.edges) {
      const from = rowIndex.get(edge.from);
      const to = rowIndex.get(edge.to);
      if (from === undefined || to === undefined) continue;
      const fromY = rowY(from, ROW_HEIGHT);
      const toY = rowY(to, ROW_HEIGHT);
      // Keeps an edge whose endpoints are both off-screen but which spans the
      // viewport — otherwise long branches appear disconnected while scrolling.
      if (!edgeIntersectsBand(fromY, toY, band)) continue;
      out.push({ edge, fromY, toY });
    }
    return out;
  }, [graph, rowIndex, band.top, band.bottom]);

  const laneColor = useCallback(
    (lane: number): string => graph?.lanes[lane]?.color ?? 'currentColor',
    [graph],
  );

  const focusRowElement = useCallback((index: number): void => {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`);
    node?.focus();
  }, []);

  const goToRow = useCallback(
    (index: number): void => {
      const clamped = Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
      const target = rows[clamped];
      if (target === undefined) return;
      setFocusRow(clamped);
      selectCommit(target.hash);
      const next = scrollToRow(clamped, viewportHeight, zoom, rows.length, ROW_HEIGHT);
      const node = scrollRef.current;
      if (node !== null) {
        const top = clamped * ROW_HEIGHT * zoom;
        const bottom = top + ROW_HEIGHT * zoom;
        if (top < node.scrollTop || bottom > node.scrollTop + node.clientHeight) {
          node.scrollTop = next;
        }
      }
      // The row may not exist yet when it was outside the window; wait a frame.
      requestAnimationFrame(() => focusRowElement(clamped));
    },
    [focusRowElement, rows, selectCommit, viewportHeight, zoom],
  );

  const openMenuAt = useCallback((node: GraphNode, anchor: MenuAnchor): void => {
    setMenu({ node, anchor });
  }, []);

  // Align the keyboard cursor with a selection restored from persisted state.
  useEffect(() => {
    if (selectedHash === null) return;
    const index = rowIndex.get(selectedHash);
    if (index !== undefined) setFocusRow(index);
  }, [selectedHash, rowIndex]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        goToRow(focusRow + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        goToRow(focusRow - 1);
        return;
      case 'PageDown':
        event.preventDefault();
        goToRow(focusRow + Math.max(1, Math.floor(viewportHeight / (ROW_HEIGHT * zoom)) - 1));
        return;
      case 'PageUp':
        event.preventDefault();
        goToRow(focusRow - Math.max(1, Math.floor(viewportHeight / (ROW_HEIGHT * zoom)) - 1));
        return;
      case 'Home':
        event.preventDefault();
        goToRow(0);
        return;
      case 'End':
        event.preventDefault();
        goToRow(rows.length - 1);
        return;
      case 'Enter': {
        event.preventDefault();
        const node = rows[focusRow];
        if (node !== undefined) onOpenInspector(node.hash);
        return;
      }
      case '+':
      case '=':
        event.preventDefault();
        setZoom(stepZoom(zoom, 1));
        return;
      case '-':
      case '_':
        event.preventDefault();
        setZoom(stepZoom(zoom, -1));
        return;
      case 'ContextMenu':
      case 'F10': {
        if (event.key === 'F10' && !event.shiftKey) return;
        event.preventDefault();
        const node = rows[focusRow];
        if (node === undefined) return;
        const element = scrollRef.current?.querySelector<HTMLElement>(`[data-row="${focusRow}"]`);
        const box = element?.getBoundingClientRect();
        openMenuAt(node, { x: box?.left ?? 40, y: box?.bottom ?? 40 });
        return;
      }
      default:
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const node = scrollRef.current;
    if (node === null || event.button !== 0) return;
    // Drag-to-pan starts on empty canvas or whenever `space` is held; starting it
    // on a row would swallow the click that selects that commit.
    const onRow = (event.target as HTMLElement).closest('[data-row]') !== null;
    if (onRow && !spaceHeld.current) return;
    panFrom.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
    node.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = panFrom.current;
    const node = scrollRef.current;
    if (start === null || node === null) return;
    node.scrollLeft = start.left - (event.clientX - start.x);
    node.scrollTop = start.top - (event.clientY - start.y);
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (panFrom.current === null) return;
    panFrom.current = null;
    scrollRef.current?.releasePointerCapture(event.pointerId);
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (target === null) return;
    const index = Number(target.dataset.row);
    const node = rows[index];
    if (node === undefined) return;
    event.preventDefault();
    setFocusRow(index);
    selectCommit(node.hash);
    openMenuAt(node, { x: event.clientX, y: event.clientY });
  };

  if (loading && graph === null) return <GraphSkeleton />;

  if (graph !== null && graph.nodes.length === 0) {
    return (
      <EmptyState
        title="Belum ada commit di repository ini."
        hint="Buat commit pertama Anda dari panel Pending Changes, lalu grafik akan muncul di sini."
      />
    );
  }

  const worldH = worldHeight(rows.length, ROW_HEIGHT) * zoom;
  const currentBranch = status?.branch ?? null;

  return (
    <div className="gc-graph">
      <Toolbar
        zoom={zoom}
        search={search}
        branchFilter={branchFilter}
        refs={graph?.refs ?? []}
        onZoom={setZoom}
        onSearch={setSearch}
        onBranchFilter={setBranchFilter}
      />

      {graph?.stale === true && (
        <InfoBanner tone="warning" glyph="⌛">
          <strong>Stale</strong>
          <span>Data ini snapshot lama karena git gagal dibaca. Muat ulang untuk mencoba lagi.</span>
        </InfoBanner>
      )}

      {graph?.truncated === true && (
        <InfoBanner tone="info" glyph="⋯">
          <strong>Histori dipangkas ke 10.000 commit.</strong>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            disabled={paging || graph.nextCursor === null}
            onClick={() => void loadMore()}
          >
            Muat lebih banyak
          </button>
          {paging && <Spinner label="Memuat halaman berikutnya…" />}
        </InfoBanner>
      )}

      <div className="gc-graph__main">
        <div
          className="gc-canvas"
          ref={scrollRef}
          role="grid"
          aria-label="Grafik commit"
          aria-rowcount={rows.length}
          tabIndex={0}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          onContextMenu={onContextMenu}
        >
          <div className="gc-canvas__world" style={{ height: `${worldH}px` }}>
            <svg
              className="gc-canvas__svg"
              width={gutterWidth * zoom}
              height={worldH}
              aria-hidden="true"
              focusable="false"
            >
              <g transform={`scale(${zoom})`}>
                {visibleEdges.map(({ edge, fromY, toY }) => (
                  <path
                    key={`${edge.from}->${edge.to}`}
                    className={
                      edge.kind === 'merge' ? 'gc-edge gc-edge--merge' : 'gc-edge gc-edge--direct'
                    }
                    d={edgePath(edge, fromY, toY)}
                    stroke={laneColor(edge.kind === 'merge' ? edge.toLane : edge.fromLane)}
                  />
                ))}
                {rows.slice(range.start, range.end).map((node, offset) => {
                  const index = range.start + offset;
                  const dim = !matchesSearch(node, search);
                  return (
                    <NodeMark
                      key={node.hash}
                      node={node}
                      y={rowY(index, ROW_HEIGHT)}
                      color={laneColor(node.lane)}
                      dim={dim}
                      selected={node.hash === selectedHash}
                    />
                  );
                })}
              </g>
            </svg>

            {rows.slice(range.start, range.end).map((node, offset) => {
              const index = range.start + offset;
              return (
                <Row
                  key={node.hash}
                  node={node}
                  index={index}
                  zoom={zoom}
                  left={gutterWidth * zoom}
                  now={now}
                  search={search}
                  currentBranch={currentBranch}
                  selected={node.hash === selectedHash}
                  focused={index === focusRow}
                  onSelect={() => {
                    setFocusRow(index);
                    selectCommit(node.hash);
                  }}
                  onOpen={() => onOpenInspector(node.hash)}
                />
              );
            })}
          </div>
        </div>

        <aside className="gc-graph__side">
          <GraphMinimap
            nodes={rows}
            laneCount={laneCount}
            scrollTop={scrollTop}
            viewportHeight={viewportHeight}
            zoom={zoom}
            height={MINIMAP_HEIGHT}
            onScroll={(top) => {
              const node = scrollRef.current;
              if (node !== null) node.scrollTop = top;
            }}
          />
          <BranchLegend lanes={graph?.lanes ?? []} />
        </aside>
      </div>

      {graph !== null && graph.nextCursor !== null && graph.truncated === false && (
        <div className="gc-graph__more">
          <button
            type="button"
            className="gc-button"
            disabled={paging}
            onClick={() => void loadMore()}
          >
            Muat lebih banyak
          </button>
          {paging && <Spinner label="Memuat halaman berikutnya…" />}
        </div>
      )}

      {menu !== null && (
        <NodeContextMenu
          node={menu.node}
          status={status}
          refs={graph?.refs ?? []}
          githubUrl={githubUrl}
          anchor={menu.anchor}
          onSelect={(item) => onMenuCommand(item, menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------- pieces

/**
 * Edge geometry. First-parent edges inside one lane are a straight vertical
 * segment; a lane change or a merge uses a cubic bezier so the eye can follow
 * the curve across lanes.
 */
export function edgePath(edge: GraphEdge, fromY: number, toY: number): string {
  const x1 = laneX(edge.fromLane, LANE_WIDTH);
  const x2 = laneX(edge.toLane, LANE_WIDTH);
  if (x1 === x2) return `M${x1} ${fromY}L${x2} ${toY}`;
  const mid = (fromY + toY) / 2;
  return `M${x1} ${fromY}C${x1} ${mid} ${x2} ${mid} ${x2} ${toY}`;
}

function NodeMark({
  node,
  y,
  color,
  dim,
  selected,
}: {
  node: GraphNode;
  y: number;
  color: string;
  dim: boolean;
  selected: boolean;
}): JSX.Element {
  const x = laneX(node.lane, LANE_WIDTH);
  const r = node.isMerge ? NODE_RADIUS + 2 : NODE_RADIUS;
  const classes = ['gc-node'];
  if (node.local) classes.push('gc-node--local');
  if (dim) classes.push('gc-node--dim');
  if (selected) classes.push('gc-node--selected');

  return (
    <g className={classes.join(' ')}>
      {node.isHead && <circle className="gc-node__head-ring" cx={x} cy={y} r={r + 4} stroke={color} />}
      {node.isMerge && <circle className="gc-node__merge-ring" cx={x} cy={y} r={r + 2} stroke={color} />}
      <circle
        className="gc-node__dot"
        cx={x}
        cy={y}
        r={r}
        stroke={color}
        fill={node.local ? 'var(--vscode-editor-background)' : color}
      />
    </g>
  );
}

interface RowProps {
  node: GraphNode;
  index: number;
  zoom: number;
  left: number;
  now: number;
  search: string;
  currentBranch: string | null;
  selected: boolean;
  focused: boolean;
  onSelect(): void;
  onOpen(): void;
}

function Row({
  node,
  index,
  zoom,
  left,
  now,
  search,
  currentBranch,
  selected,
  focused,
  onSelect,
  onOpen,
}: RowProps): JSX.Element {
  const dim = !matchesSearch(node, search);
  const chips = chipsFor(node.refNames, currentBranch);
  const classes = ['gc-row'];
  if (selected) classes.push('gc-row--selected');
  if (dim) classes.push('gc-row--dim');
  // Both come from git. Sanitised once here so the `title` attribute and the
  // visible text cannot disagree.
  const subject = sanitizeGitText(node.subject);
  const authorName = sanitizeGitText(node.authorName);

  return (
    <div
      className={classes.join(' ')}
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-row={index}
      tabIndex={focused ? 0 : -1}
      style={{
        top: `${index * ROW_HEIGHT * zoom}px`,
        height: `${ROW_HEIGHT * zoom}px`,
        left: `${left}px`,
      }}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      {/* One gridcell carries the whole row: the accessible name is composed in
          `rowLabel`, and the visual parts stay hidden so nothing is read twice. */}
      <span className="gc-row__cell-group" role="gridcell" aria-label={rowLabel(node, now)}>
        <span className="gc-row__hash" aria-hidden="true">
          {shortHash(node.hash)}
        </span>
        <span className="gc-row__badges" aria-hidden="true">
          {node.isHead && <span className="gc-badge gc-badge--head">HEAD</span>}
          {node.local && (
            <span className="gc-badge gc-badge--local" title="Lokal, belum dipush">
              ↑
            </span>
          )}
          {node.isMerge && (
            <span className="gc-badge gc-badge--merge" title="Commit merge">
              ⑃
            </span>
          )}
        </span>
        <span className="gc-row__chips" aria-hidden="true">
          {chips.map((chip) => (
            <span key={`${chip.kind}-${chip.name}`} className={`gc-chip gc-chip--${chip.kind}`}>
              <span aria-hidden="true">{chip.glyph} </span>
              {chip.prefix}
              {chip.name}
            </span>
          ))}
        </span>
        <span className="gc-row__subject" title={subject} aria-hidden="true">
          <Highlight text={truncate(subject, SUBJECT_MAX)} needle={search} />
        </span>
        <span className="gc-row__author" aria-hidden="true">
          <Highlight text={authorName} needle={search} />
        </span>
        <span className="gc-row__date" aria-hidden="true">
          {relativeTime(node.authoredAt, now)}
        </span>
      </span>
    </div>
  );
}

/** Wrap search matches in `<mark>`. Non-matching rows are dimmed, never hidden. */
function Highlight({ text, needle }: { text: string; needle: string }): JSX.Element {
  if (needle.length === 0) return <>{text}</>;
  const lower = text.toLowerCase();
  const at = lower.indexOf(needle.toLowerCase());
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="gc-mark">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function Toolbar({
  zoom,
  search,
  branchFilter,
  refs,
  onZoom,
  onSearch,
  onBranchFilter,
}: {
  zoom: number;
  search: string;
  branchFilter: string;
  refs: readonly RefInfo[];
  onZoom(zoom: number): void;
  onSearch(value: string): void;
  onBranchFilter(value: string): void;
}): JSX.Element {
  const branches = refs.filter((r) => r.kind === 'local' || r.kind === 'remote');
  return (
    <div className="gc-toolbar" role="toolbar" aria-label="Kontrol grafik">
      <label className="gc-field">
        <span className="gc-field__label">Cari</span>
        <input
          type="search"
          value={search}
          maxLength={100}
          placeholder="hash, subjek, atau penulis"
          onChange={(e) => onSearch(e.target.value)}
        />
      </label>

      <label className="gc-field">
        <span className="gc-field__label">Branch</span>
        <select value={branchFilter} onChange={(e) => onBranchFilter(e.target.value)}>
          <option value="">Semua branch</option>
          {branches.map((ref) => (
            // `value` stays raw: it is compared against lane refs host-side.
            // Only the label is sanitised.
            <option key={ref.refName} value={ref.shortName}>
              {ref.kind === 'remote'
                ? `remote ${sanitizeGitText(ref.shortName)}`
                : sanitizeGitText(ref.shortName)}
            </option>
          ))}
        </select>
      </label>

      <div className="gc-zoom" role="group" aria-label="Perbesaran">
        <button
          type="button"
          className="gc-icon-button"
          aria-label="Perkecil"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => onZoom(stepZoom(zoom, -1))}
        >
          −
        </button>
        <span className="gc-zoom__value" aria-live="off">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="gc-icon-button"
          aria-label="Perbesar"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => onZoom(stepZoom(zoom, 1))}
        >
          +
        </button>
        <button type="button" className="gc-button gc-button--quiet" onClick={() => onZoom(1)}>
          100%
        </button>
      </div>
    </div>
  );
}
