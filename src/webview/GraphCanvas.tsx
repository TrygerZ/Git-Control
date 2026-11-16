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
 * `role="grid"` with `aria-rowcount`/`aria-colcount` on the container and
 * `aria-rowindex` on each rendered row — the standard way to expose a virtualized
 * list. The grid is a single tab stop with a roving `tabIndex` on the focused row,
 * so Tab crosses the canvas in one press while the arrow keys move the cursor
 * inside it. Every commit state is encoded redundantly (shape, dash pattern, badge,
 * accessible name) so colour is never the only signal.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { GraphMinimap } from './GraphMinimap';
import { LaneGutterView } from './LaneGutterView';
import { edgeDashed, laneTips, mergedLanes } from './laneGutter';
import { NodeContextMenu, type MenuAnchor, type MenuItem } from './NodeContextMenu';
import { EmptyState, GraphSkeleton, Icon, InfoBanner, Spinner, type IconName } from './ui';
import {
  authorInitials,
  formatCount,
  isSafeImageSrc,
  relativeTime,
  rowLabel,
  sanitizeGitText,
  shortHash,
  truncate,
} from './format';
import { useT } from './useT';
import { BranchSelector } from './BranchLegend';
import { useGitHubStore, useRepoStore, useSettingsStore } from './store';
import { chipsFor, computeStaggerMap, lanesForFilter, matchesSearch } from './graphQuery';
import {
  COLUMN_WIDTH,
  DAY_GAP,
  DEFAULT_OVERSCAN,
  GUTTER_X,
  LANE_HEIGHT,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_RADIUS,
  RULER_HEIGHT,
  TEXT_MIN_ZOOM,
  clampZoom,
  edgePath,
  fitZoom,
  edgeIntersectsBand,
  laneY,
  columnX,
  labelVisible,
  needsScrollToReveal,
  scrollToCommit,
  shouldRevealOnContainerFocus,
  stepZoom,
  visibleNodeRangeByX,
  visibleWorldBand,
  worldHeight,
  worldWidth,
} from './viewport';
import type { DateBucket, GraphEdge, GraphNode, RefInfo, RepoGraph, RepoStatus } from '../messages';
export { chipsFor, computeStaggerMap, lanesForFilter, matchesSearch } from './graphQuery';
export { edgePath } from './viewport';
/** Frame 01 (`10:178`): the minimap is 220 x 68 at the canvas left edge. */
const MINIMAP_WIDTH = 220;
const MINIMAP_HEIGHT = 68;

/**
 * `range` is recomputed on every `scrollLeft` change, so without a pause one continuous
 * scroll gesture would ask for avatars once per frame.
 */
const AVATAR_REQUEST_DEBOUNCE_MS = 150;

/**
 * Radius of a commit node.
 *
 * `NODE_RADIUS + 1` (6 px) is the smallest circle that can hold a legible letter at
 * 100 % zoom; a merge node stays one pixel larger than that, exactly as before, so
 * the "merge nodes are bigger" channel the legend describes is unchanged. Lanes are
 * one `LANE_HEIGHT` pitch apart, so nothing here brings two nodes closer than the merge
 * ring already did.
 *
 * Presentation-only, so it stays here rather than in `viewport.ts`, which owns the
 * layout maths the host and the tests agree on.
 */
const AVATAR_RADIUS = NODE_RADIUS + 1;

/** HEAD is one size up from a plain node, as the frame draws 34 px against 28 px. */
const HEAD_RADIUS = NODE_RADIUS + 3;

interface Props {
  graph: RepoGraph | null;
  status: RepoStatus | null;
  loading: boolean;
  paging: boolean;
  githubUrl: string | null;
  onMenuCommand(item: MenuItem, node: GraphNode): void;
  onOpenInspector(hash: string): void;
  /** The aside is open. The toolbar owns the toggle; `ExplorerApp` owns the state. */
  inspectorOpen: boolean;
  onToggleInspector(): void;
}

/**
 * Accessible name for a commit row.
 *
 * Re-exported rather than defined here: it lives in `format.ts` so `a11y.test.ts`
 * can assert it without a DOM, and so this file has exactly one source for it.
 */
export { rowLabel };

/**
 * Filter bar above the canvas (frame 01, node `9:45`).
 *
 * One row, never wrapping: search, a labelled Checkout group, a labelled Show
 * group, the count with Load older, then the panel toggle behind a divider.
 * The two labels are frame words, not form labels: `gc-toolbar__label` is the
 * quiet inline style, and each control keeps its own accessible name.
 */
function Toolbar({
  search,
  branchFilter,
  currentBranch,
  busy,
  refs,
  countId,
  countText,
  canLoadOlder,
  paging,
  inspectorOpen,
  onSearch,
  onBranchFilter,
  onLoadOlder,
  onToggleInspector,
}: {
  search: string;
  branchFilter: string;
  currentBranch: string | null;
  busy: boolean;
  refs: readonly RefInfo[];
  countId: string;
  countText: string;
  canLoadOlder: boolean;
  paging: boolean;
  inspectorOpen: boolean;
  onSearch(value: string): void;
  onBranchFilter(value: string): void;
  onLoadOlder(): void;
  onToggleInspector(): void;
}): JSX.Element {
  const strings = useT();
  const branches = refs.filter((r) => r.kind === 'local' || r.kind === 'remote');
  return (
    <div
      className="gc-toolbar gc-toolbar--filters"
      role="toolbar"
      aria-label={strings.graph.toolbarAria}
      aria-orientation="horizontal"
    >
      <div className="gc-toolbar__search-wrap">
        <span className="gc-toolbar__search-input-wrap">
          <span className="gc-toolbar__search-icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            type="search"
            className="gc-toolbar__search-input"
            value={search}
            maxLength={100}
            placeholder={strings.graph.searchPlaceholder}
            aria-label={strings.graph.searchAria}
            aria-describedby={countId}
            onChange={(e) => onSearch(e.target.value)}
          />
        </span>
      </div>

      {/*
        One checkout control, shared with the sidebar; the unlabelled variant, so
        the visible `Checkout` word sits beside it and the accessible name stays.
      */}
      <div className="gc-toolbar__group">
        <span className="gc-toolbar__label">{strings.graph.checkoutBranchLabel}</span>
        <BranchSelector
          currentBranch={currentBranch}
          refs={refs}
          busy={busy}
          aria-label={strings.graph.checkoutBranchAria}
        />
      </div>

      <div className="gc-toolbar__group">
        <span className="gc-toolbar__label">{strings.graph.showLabel}</span>
        <div className="gc-toolbar__branch-wrap">
          <select
            className="gc-toolbar__branch-select"
            aria-label={strings.graph.branchFilterAria}
            value={branchFilter}
            onChange={(e) => onBranchFilter(e.target.value)}
          >
            <option value="">{strings.graph.branchFilterAll}</option>
            {branches.map((ref) => (
              <option key={ref.refName} value={ref.shortName}>
                {ref.kind === 'remote'
                  ? strings.graph.branchFilterRemotePrefix(sanitizeGitText(ref.shortName))
                  : sanitizeGitText(ref.shortName)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <span className="gc-toolbar__divider" aria-hidden="true" />

      {/* The count moved up from the paragraph above the canvas; still the live region. */}
      <p className="gc-toolbar__count" id={countId} role="status" aria-live="polite">
        {countText}
      </p>
      {canLoadOlder && (
        <button
          type="button"
          className="gc-button gc-button--quiet gc-toolbar__load-older"
          title={strings.graph.moreButtonTitle}
          disabled={paging}
          onClick={onLoadOlder}
        >
          {strings.graph.moreButton}
        </button>
      )}
      {paging && <Spinner label={strings.graph.moreLoadingSpinner} />}

      <span className="gc-toolbar__divider" aria-hidden="true" />

      {(search.length > 0 || branchFilter.length > 0) && (
        <button
          type="button"
          className="gc-button gc-button--quiet gc-toolbar__clear"
          onClick={() => {
            onSearch('');
            onBranchFilter('');
          }}
        >
          {strings.graph.resetFilter}
        </button>
      )}

      <button
        type="button"
        className="gc-icon-button gc-toolbar__panel-toggle"
        aria-label={strings.graph.panelToggleAria}
        title={strings.graph.panelToggleTitle}
        aria-expanded={inspectorOpen}
        onClick={onToggleInspector}
      >
        <Icon name="panel-right" />
      </button>
    </div>
  );
}

export function GraphCanvas({
  graph,
  status,
  loading,
  paging,
  githubUrl,
  onMenuCommand,
  onOpenInspector,
  inspectorOpen,
  onToggleInspector,
}: Props): JSX.Element {
  const strings = useT();
  const language = useSettingsStore((s) => s.language);
  const zoom = useSettingsStore((s) => s.zoom);
  const setZoom = useSettingsStore((s) => s.setZoom);
  const search = useSettingsStore((s) => s.search);
  const setSearch = useSettingsStore((s) => s.setSearch);
  const branchFilter = useSettingsStore((s) => s.branchFilter);
  const setBranchFilter = useSettingsStore((s) => s.setBranchFilter);
  const selectedHash = useRepoStore((s) => s.selectedHash);
  const selectCommit = useRepoStore((s) => s.selectCommit);
  const focusTargetHash = useRepoStore((s) => s.focusTargetHash);
  const loadMore = useRepoStore((s) => s.loadMore);
  const avatars = useGitHubStore((s) => s.avatars);
  const loadCommitAuthors = useGitHubStore((s) => s.loadCommitAuthors);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  /** The gutter is fixed, so it needs the vertical offset the scroller owns. */
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportWidthState, setViewportWidthState] = useState(800);
  const [menu, setMenu] = useState<{ node: GraphNode; anchor: MenuAnchor } | null>(null);
  const [focusRow, setFocusRow] = useState(0);
  const [pendingFocusRow, setPendingFocusRow] = useState<number | null>(null);
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);
  // Hover region state: tracks active hash and clear timer to prevent flicker
  // when moving between node hit circle and expanded label
  const hoverTimer = useRef<number | null>(null);
  const activeHoverHash = useRef<string | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  // Cleanup pending hover timer on unmount
  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) {
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      }
    };
  }, []);

  // Enter hover region for a node/label: immediately cancels any pending leave
  // and switches active hash if different
  const onRegionEnter = useCallback((hash: string) => {
    clearHoverTimer();
    activeHoverHash.current = hash;
    setHoveredHash((prev) => (prev === hash ? prev : hash));
  }, [clearHoverTimer]);

  // Leave hover region for a node/label: only clears if the pointer hasn't entered
  // another part of the same node's region or a different node
  const onRegionLeave = useCallback((hash: string) => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      if (activeHoverHash.current === hash) {
        activeHoverHash.current = null;
        setHoveredHash(null);
      }
      hoverTimer.current = null;
    }, 50);
  }, [clearHoverTimer]);

  // Clear hover immediately without delay (e.g. on scroll or drag pan)
  const clearHoverImmediate = useCallback(() => {
    clearHoverTimer();
    activeHoverHash.current = null;
    setHoveredHash(null);
  }, [clearHoverTimer]);

  const spaceHeld = useRef(false);
  const panFrom = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const now = useMemo(() => Date.now(), [graph]);
  // Ids for the grid's description and the search result count.
  const helpId = useId();
  const countId = useId();

  // Track viewport width so horizontal column culling matches reality after resize or initial layout.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return undefined;
    if (node.clientWidth > 0) setViewportWidthState(node.clientWidth);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width } = entry.contentRect;
        if (width > 0) setViewportWidthState(width);
      }
    });
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

  // Wheel handling:
  // - Ctrl/Cmd + Wheel: Zoom in/out
  // - Vertical wheel without Shift: convert deltaY to horizontal pan (natural for mouse wheel on horizontal timeline)
  //   Trackpads naturally emit deltaX on horizontal swipes, which native scrolling handles when not prevented.
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return undefined;
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setZoom(clampZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
        return;
      }
      // If user scrolls vertically without shift and not currently pan-dragging, pan horizontally
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.shiftKey) {
        node.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [setZoom, zoom]);

  const rows: GraphNode[] = useMemo(() => {
    if (graph === null) return [];
    const keep = lanesForFilter(graph, branchFilter);
    return keep === null ? graph.nodes : graph.nodes.filter((n) => keep.has(n.lane));
  }, [graph, branchFilter]);

  /** Date buckets filtered to only those containing visible nodes */
  const dateBuckets: DateBucket[] = useMemo(() => {
    if (graph === null) return [];
    if (rows.length === graph.nodes.length) return graph.dateBuckets;
    return graph.dateBuckets.filter((bucket) =>
      rows.some((n) => n.x >= bucket.startX && n.x < bucket.startX + bucket.width),
    );
  }, [graph, rows]);

  /** hash → row index, so edges can be placed without scanning. */
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((node, index) => map.set(node.hash, index));
    return map;
  }, [rows]);

  /** Pre-pass map of node placement (above vs below) to avoid collisions */
  const staggerMap = useMemo(() => computeStaggerMap(rows), [rows]);

  const laneCount = useMemo(() => {
    if (graph === null) return 1;
    if (rows.length === 0) return 1;
    const maxLane = rows.reduce((max, n) => Math.max(max, n.lane), 0);
    return maxLane + 1;
  }, [graph, rows]);

  const maxNodeX = useMemo(() => {
    return rows.reduce((max, n) => Math.max(max, n.x), 0);
  }, [rows]);
  const totalWorldW = worldWidth(maxNodeX + COLUMN_WIDTH, GUTTER_X);
  const totalWorldH = worldHeight(laneCount, LANE_HEIGHT, RULER_HEIGHT);

  const range = visibleNodeRangeByX({
    nodes: rows,
    scrollLeft,
    viewportWidth: viewportWidthState,
    zoom,
    columnWidth: COLUMN_WIDTH,
    overscan: DEFAULT_OVERSCAN,
  });
  const band = visibleWorldBand(scrollLeft, viewportWidthState, zoom, DEFAULT_OVERSCAN, COLUMN_WIDTH);

  const visibleEdges = useMemo(() => {
    if (graph === null) return [];
    const out: Array<{ edge: GraphEdge; fromX: number; toX: number }> = [];
    for (const edge of graph.edges) {
      const fromNode = rows.find((n) => n.hash === edge.from);
      const toNode = rows.find((n) => n.hash === edge.to);
      if (fromNode === undefined || toNode === undefined) continue;
      const fromX = fromNode.x;
      const toX = toNode.x;
      if (!edgeIntersectsBand(fromX, toX, band)) continue;
      out.push({ edge, fromX, toX });
    }
    return out;
  }, [graph, rows, band.left, band.right]);

  /** Lanes whose tip another tip reaches, so an edge into one is solid. */
  const mergedLaneSet = useMemo(
    () => mergedLanes(laneTips(graph?.nodes ?? []), graph?.edges ?? []),
    [graph],
  );

  const laneColor = useCallback(
    (lane: number): string => graph?.lanes[lane]?.color ?? 'currentColor',
    [graph],
  );

  const focusRowElement = useCallback((index: number): boolean => {
    const node = scrollRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`);
    if (node) {
      node.focus();
      return true;
    }
    return false;
  }, []);

  // Deterministic focus: if a row focus is pending and within the rendered range, focus it immediately on layout
  useLayoutEffect(() => {
    if (pendingFocusRow !== null) {
      if (focusRowElement(pendingFocusRow)) {
        setPendingFocusRow(null);
      }
    }
  }, [pendingFocusRow, range.start, range.end, focusRowElement]);

  /**
   * Scroll `index` into view and focus it WITHOUT changing the selection.
   */
  const revealRow = useCallback(
    (index: number): void => {
      const node = scrollRef.current;
      if (node === null) return;
      const target = rows[index];
      if (target === undefined) return;
      setFocusRow(index);
      setPendingFocusRow(index);
      if (needsScrollToReveal(target.x, zoom, node.scrollLeft, node.clientWidth)) {
        node.scrollLeft = scrollToCommit(target.x, viewportWidthState, zoom, totalWorldW);
      }
      // If already mounted and rendered in DOM, focus directly
      focusRowElement(index);
    },
    [focusRowElement, rows, totalWorldW, viewportWidthState, zoom],
  );

  const goToRow = useCallback(
    (index: number): void => {
      const clamped = Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
      const target = rows[clamped];
      if (target === undefined) return;
      setFocusRow(clamped);
      setPendingFocusRow(clamped);
      selectCommit(target.hash);
      const next = scrollToCommit(target.x, viewportWidthState, zoom, totalWorldW);
      const node = scrollRef.current;
      if (node !== null) {
        if (needsScrollToReveal(target.x, zoom, node.scrollLeft, node.clientWidth)) {
          node.scrollLeft = next;
        }
      }
      // If already mounted and rendered in DOM, focus directly
      focusRowElement(clamped);
    },
    [focusRowElement, rows, selectCommit, totalWorldW, viewportWidthState, zoom],
  );

  const openMenuAt = useCallback((node: GraphNode, anchor: MenuAnchor): void => {
    setMenu({ node, anchor });
  }, []);

  // Avatars are fetched for the rendered window only: at 10 000 commits asking for all of
  // them would spend the whole GitHub quota on faces nobody is looking at.
  // ponytail: omit `rows` from deps and use range bounds/rowCount to prevent debounce cancellation during continuous scroll.
  useEffect(() => {
    if (rows.length === 0) return undefined;
    const visibleNodes = rows.slice(range.start, range.end);
    const visibleHashes = visibleNodes.map((n) => n.hash);
    if (visibleHashes.length === 0) return undefined;

    const timer = window.setTimeout(() => {
      loadCommitAuthors(visibleHashes);
    }, AVATAR_REQUEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [range.start, range.end, rows.length, loadCommitAuthors]);

  /** Horizontal and vertical pan, so a wide canvas is reachable without a mouse. */
  const panBy = useCallback((dx: number, dy: number = 0): void => {
    const node = scrollRef.current;
    if (node === null) return;
    if (dx !== 0) node.scrollLeft = Math.max(0, node.scrollLeft + dx);
    if (dy !== 0) node.scrollTop = Math.max(0, node.scrollTop + dy);
  }, []);

  // Align the keyboard cursor with a selection restored from persisted state.
  useEffect(() => {
    if (selectedHash === null) return;
    const index = rowIndex.get(selectedHash);
    if (index !== undefined) setFocusRow(index);
  }, [selectedHash, rowIndex]);

  // Scroll and focus requested commit (e.g. from stash hash click or external reveal).
  useEffect(() => {
    if (focusTargetHash === null) return;
    const index = rowIndex.get(focusTargetHash);
    if (index !== undefined) {
      goToRow(index);
      const target = rows[index];
      const node = scrollRef.current;
      if (target !== undefined && node !== null) {
        node.scrollLeft = scrollToCommit(target.x, viewportWidthState, zoom, totalWorldW);
      }
      useRepoStore.setState({ focusTargetHash: null });
    } else if (!loading) {
      // Commit is not in the loaded graph window. Do not scroll or fetch; clear target.
      useRepoStore.setState({ focusTargetHash: null });
    }
  }, [focusTargetHash, rowIndex, loading, goToRow, rows, totalWorldW, viewportWidthState, zoom]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        goToRow(focusRow + 1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        goToRow(focusRow - 1);
        return;
      case 'ArrowDown': {
        event.preventDefault();
        // Move to node in next lane down near same X if available, else pan vertically
        const current = rows[focusRow];
        if (current !== undefined) {
          const inNextLane = rows
            .map((n, i) => ({ n, i }))
            .filter(({ n }) => n.lane > current.lane)
            .sort((a, b) => Math.abs(a.n.x - current.x) - Math.abs(b.n.x - current.x));
          if (inNextLane.length > 0 && inNextLane[0]) {
            goToRow(inNextLane[0].i);
          } else {
            panBy(0, 40);
          }
        }
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        // Move to node in previous lane up near same X if available, else pan vertically
        const current = rows[focusRow];
        if (current !== undefined) {
          const inPrevLane = rows
            .map((n, i) => ({ n, i }))
            .filter(({ n }) => n.lane < current.lane)
            .sort((a, b) => Math.abs(a.n.x - current.x) - Math.abs(b.n.x - current.x));
          if (inPrevLane.length > 0 && inPrevLane[0]) {
            goToRow(inPrevLane[0].i);
          } else {
            panBy(0, -40);
          }
        }
        return;
      }
      case 'PageDown':
        event.preventDefault();
        goToRow(focusRow + Math.max(1, Math.floor(viewportWidthState / (COLUMN_WIDTH * zoom)) - 1));
        return;
      case 'PageUp':
        event.preventDefault();
        goToRow(focusRow - Math.max(1, Math.floor(viewportWidthState / (COLUMN_WIDTH * zoom)) - 1));
        return;
      case 'Home':
        event.preventDefault();
        goToRow(0);
        return;
      case 'End':
        event.preventDefault();
        goToRow(rows.length - 1);
        return;
      case 'Enter':
      case ' ': {
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
      case '0':
        event.preventDefault();
        setZoom(1);
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
    // Clear hover state on pan start
    clearHoverImmediate();
    // Drag-to-pan starts on empty canvas or whenever `space` is held; starting it
    // on a row or node hit target would swallow the click that selects that commit.
    const onInteractive = (event.target as HTMLElement).closest('[data-row], [data-node]') !== null;
    if (onInteractive && !spaceHeld.current) return;
    // Suppress native text selection initiated by left-click drag while preserving click flow on interactive targets.
    event.preventDefault();
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
    clearHoverImmediate();
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-row], [data-node]');
    if (target === null) return;
    const hash = target.dataset.node;
    const index = hash ? rowIndex.get(hash) : Number(target.dataset.row);
    if (index === undefined) return;
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
        title={strings.graph.emptyTitle}
        hint={strings.graph.emptyHint}
        steps={strings.graph.emptySteps}
      />
    );
  }

  const worldH = totalWorldH;
  const currentBranch = status?.branch ?? null;
  const matchCount = search.length === 0 ? rows.length : rows.filter((n) => matchesSearch(n, search)).length;
  /** Row holding HEAD, so the floating "back to HEAD" control has somewhere to go. */
  const headHash = graph === null ? null : graph.head;
  const headRow = headHash === null ? undefined : rowIndex.get(headHash);

  return (
    <div className="gc-graph">
      <Toolbar
        search={search}
        branchFilter={branchFilter}
        currentBranch={currentBranch}
        busy={status !== null && status.operation !== 'idle'}
        refs={graph?.refs ?? []}
        countId={countId}
        countText={
          search.length === 0 && branchFilter.length === 0
            ? strings.graph.countAll(formatCount(rows.length, language))
            : strings.graph.countMatched(formatCount(matchCount, language), formatCount(rows.length, language))
        }
        canLoadOlder={graph !== null && graph.nextCursor !== null && graph.truncated === false}
        paging={paging}
        inspectorOpen={inspectorOpen}
        onSearch={setSearch}
        onBranchFilter={setBranchFilter}
        onLoadOlder={() => void loadMore()}
        onToggleInspector={onToggleInspector}
      />

      {graph?.stale === true && (
        <InfoBanner tone="warning" glyph="watch">
          <strong>{strings.graph.staleTitle}</strong>
          <span>{strings.graph.staleDetail}</span>
        </InfoBanner>
      )}

      {graph?.truncated === true && (
        <InfoBanner tone="info" glyph="ellipsis">
          <strong>{strings.graph.truncatedTitle}</strong>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title={strings.graph.loadMoreTitle}
            disabled={paging || graph.nextCursor === null}
            onClick={() => void loadMore()}
          >
            {strings.graph.loadMoreButton}
          </button>
          {paging && <Spinner label={strings.graph.loadingMoreSpinner} />}
        </InfoBanner>
      )}

      <p className="gc-visually-hidden" id={helpId}>
        {strings.graph.helpText}
      </p>

      <div className="gc-graph__main">
        {/*
          Positioned wrapper so the floating controls can sit over the canvas
          without scrolling with it. They cannot live INSIDE `.gc-canvas`: that
          element is the scroll container, and an absolutely positioned child of a
          scroller drifts away with the content.
        */}
        <div className="gc-graph__stage">
          {graph !== null && (
            <LaneGutterView
              graph={graph}
              zoom={zoom}
              scrollTop={scrollTop}
              scrollLeft={scrollLeft}
            />
          )}
          {/*
            One tab stop for the whole grid. Tab lands on the container, which
            immediately hands focus to the cursor row (`onFocus` below) so the row's
            accessible name is announced; the arrow keys then move the cursor. The
            container stays focusable rather than relying only on the roving row
            `tabIndex`, because the cursor row may be scrolled out of the rendered
            window, and a grid that Tab cannot reach at all is the worse failure.
          */}
          <div
            className="gc-canvas"
            ref={scrollRef}
            role="grid"
            aria-label={strings.graph.canvasAria}
            aria-rowcount={rows.length}
            aria-colcount={1}
            aria-orientation="horizontal"
            aria-describedby={helpId}
            tabIndex={0}
            onFocus={(event) => {
              const shouldReveal = shouldRevealOnContainerFocus({
                targetIsContainer: event.target === event.currentTarget,
                keyboardModality: event.currentTarget.matches(':focus-visible'),
              });
              if (!shouldReveal) return;
              if (rows.length > 0) revealRow(focusRow);
            }}
            onScroll={(event) => {
              clearHoverImmediate();
              setScrollLeft(event.currentTarget.scrollLeft);
              setScrollTop(event.currentTarget.scrollTop);
            }}
            onPointerLeave={() => clearHoverImmediate()}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onContextMenu={onContextMenu}
            onDragStart={(e) => e.preventDefault()}
          >
            {/* Sticky Date Ruler at top of scroller */}
            <div
              className="gc-ruler"
              style={{
                width: `${totalWorldW * zoom}px`,
                minWidth: '100%',
              }}
              aria-hidden="true"
            >
              <div className="gc-ruler__track">
                {dateBuckets.map((bucket) => (
                  <div
                    key={bucket.timestamp}
                    className="gc-ruler__cell"
                    style={{
                      left: `${bucket.bandStartX * zoom}px`,
                      width: `${bucket.bandWidth * zoom}px`,
                    }}
                  >
                    <span>{bucket.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div
              className="gc-canvas__world"
              role="rowgroup"
              style={{
                height: `${totalWorldH * zoom}px`,
                minWidth: `${totalWorldW * zoom}px`,
                width: `${totalWorldW * zoom}px`,
              }}
            >
              <svg
                className="gc-canvas__svg"
                width={totalWorldW * zoom}
                height={totalWorldH * zoom}
                aria-hidden="true"
                focusable="false"
              >
                <g transform={`scale(${zoom})`}>
                  {Array.from({ length: laneCount }, (_, lane) =>
                    lane % 2 === 1 ? (
                      <rect
                        key={`lane-band-${lane}`}
                        className="gc-canvas__lane-band"
                        x={0}
                        y={RULER_HEIGHT + lane * LANE_HEIGHT}
                        width={totalWorldW}
                        height={LANE_HEIGHT}
                      />
                    ) : null,
                  )}
                  {/* Odd lanes (lane % 2 === 1) take the band above. It sits under the day
                      lines and the edges, which are painted after it. */}

                  {/* Day separator lines aligned with band geometry */}
                  {dateBuckets.map((bucket) => {
                    return (
                      <g key={`day-bg-${bucket.timestamp}`}>
                        <line
                          className="gc-canvas__day-line"
                          x1={bucket.bandStartX + bucket.bandWidth}
                          y1={RULER_HEIGHT}
                          x2={bucket.bandStartX + bucket.bandWidth}
                          y2={totalWorldH}
                        />
                      </g>
                    );
                  })}

                  {/* Edges */}
                  {visibleEdges.map(({ edge, fromX, toX }) => (
                    <path
                      key={`${edge.from}->${edge.to}`}
                      className={
                        edge.kind === 'merge'
                          ? 'gc-edge gc-edge--merge'
                          : edgeDashed(edge.toLane, mergedLaneSet)
                            ? 'gc-edge gc-edge--direct gc-edge--dashed'
                            : 'gc-edge gc-edge--direct'
                      }
                      d={edgePath(edge, fromX, toX, LANE_HEIGHT, RULER_HEIGHT)}
                      stroke={laneColor(edge.kind === 'merge' ? edge.toLane : edge.fromLane)}
                    />
                  ))}

                  {/* Nodes */}
                  {rows.slice(range.start, range.end).map((node, offset) => {
                    const index = range.start + offset;
                    const dim = !matchesSearch(node, search);
                    return (
                      <NodeMark
                        key={node.hash}
                        node={node}
                        avatarUrl={avatars[node.hash] ?? null}
                        y={laneY(node.lane, LANE_HEIGHT, RULER_HEIGHT)}
                        color={laneColor(node.lane)}
                        dim={dim}
                        selected={node.hash === selectedHash}
                        zoom={zoom}
                        onSelect={() => {
                          setFocusRow(index);
                          selectCommit(node.hash);
                        }}
                        onOpen={() => onOpenInspector(node.hash)}
                        onHoverChange={(hovered) => (hovered ? onRegionEnter(node.hash) : onRegionLeave(node.hash))}
                      />
                    );
                  })}
                </g>
              </svg>

              {/* Branch pill on branch tips */}
              {rows.slice(range.start, range.end).map((node) => {
                const chips = chipsFor(node.refNames, currentBranch);
                if (chips.length === 0) return null;
                const branchChip = chips[0];
                if (!branchChip) return null;

                // De-overlap strategy: if node row card is placed 'above', flip pill to 'below' (and vice versa)
                // so the branch pill never collides with its own commit label card.
                const rowPlacement = staggerMap.get(node.hash) ?? 'below';
                const pillPlacement = rowPlacement === 'above' ? 'below' : 'above';
                const nodeCenterY = laneY(node.lane, LANE_HEIGHT, RULER_HEIGHT);
                const pillTop = pillPlacement === 'above'
                  ? (nodeCenterY - NODE_RADIUS - 6) * zoom
                  : (nodeCenterY + NODE_RADIUS + 6) * zoom;

                // Check if path has slash e.g. "main/test" or "feature/something"
                const hasSlash = branchChip.name.includes('/');
                if (hasSlash) {
                  const parts = branchChip.name.split('/');
                  const parentPart = parts.slice(0, -1).join('/');
                  const childPart = parts[parts.length - 1];

                  return (
                    <div
                      key={`pill-${node.hash}`}
                      className={`gc-pill gc-pill--trail gc-pill--${branchChip.kind} gc-pill--${pillPlacement}`}
                      style={{
                        left: `${node.x * zoom}px`,
                        top: `${pillTop}px`,
                      }}
                      aria-hidden="true"
                    >
                      <span className="gc-pill__segment-slash">/</span>
                      <span className="gc-pill__segment-parent">{parentPart}</span>
                      <span className="gc-pill__segment-slash">/</span>
                      <span className="gc-pill__segment-child">{childPart}</span>
                    </div>
                  );
                }

                return (
                  <div
                    key={`pill-${node.hash}`}
                    className={`gc-pill gc-pill--${branchChip.kind} gc-pill--${pillPlacement}`}
                    style={{
                      left: `${node.x * zoom}px`,
                      top: `${pillTop}px`,
                    }}
                    aria-hidden="true"
                  >
                    <Icon name={branchChip.icon} />
                    <span>{branchChip.prefix}{branchChip.name}</span>
                  </div>
                );
              })}

              {/* Compact commit card / label positioned below or above each node */}
              {rows.slice(range.start, range.end).map((node, offset) => {
                const index = range.start + offset;
                const selected = node.hash === selectedHash;
                const focused = index === focusRow;
                const hovered = node.hash === hoveredHash;
                const isHead = node.isHead;
                const visible = labelVisible({ zoom, hovered, selected, focused, isHead });
                const placement = staggerMap.get(node.hash) ?? 'below';

                return (
                    <Row
                    key={node.hash}
                    node={node}
                    index={index}
                    zoom={zoom}
                    left={node.x * zoom}
                    now={now}
                    search={search}
                    currentBranch={currentBranch}
                    selected={selected}
                    focused={focused}
                    hovered={hovered}
                    visible={visible}
                    placement={placement}
                    lang={language}
                    onSelect={() => {
                      setFocusRow(index);
                      selectCommit(node.hash);
                    }}
                    onOpen={() => onOpenInspector(node.hash)}
                    onHoverChange={(hovered) => (hovered ? onRegionEnter(node.hash) : onRegionLeave(node.hash))}
                  />
                );
              })}
            </div>
          </div>

          {/*
            Frame 01 bottom row: the minimap at the canvas left edge, the legend
            pill beside it, sharing one bottom edge (minimap 220 x 68 at x 166,
            pill x 401-565, both end at y 882). The row owns the absolute
            positioning, so neither item can drift away from the other. Hidden
            below 220 px, where the frame draws neither and the bottom-right
            controls stack would collide.
          */}
          {viewportWidthState >= 220 && (
            <div className="gc-canvas__bottom-row">
              <div className="gc-minimap-wrap">
                <GraphMinimap
                  nodes={rows}
                  laneCount={laneCount}
                  scrollLeft={scrollLeft}
                  viewportWidth={viewportWidthState}
                  zoom={zoom}
                  totalWorldWidth={totalWorldW}
                  width={MINIMAP_WIDTH}
                  height={MINIMAP_HEIGHT}
                  onScroll={(left) => {
                    const node = scrollRef.current;
                    if (node !== null) node.scrollLeft = left;
                  }}
                />
              </div>

              {/*
                Frame 01 (`10:184`): the legend is a pill in place, not a launcher. It
                names the two node states where the graph is, and the hollow swatch
                keeps them apart without relying on colour.
              */}
              <div className="gc-legend-pill">
                <span className="gc-legend-pill__item">
                  <span className="gc-legend-pill__dot gc-legend-pill__dot--pushed" aria-hidden="true" />
                  {strings.graph.legendPushed}
                </span>
                <span className="gc-legend-pill__item">
                  <span className="gc-legend-pill__dot gc-legend-pill__dot--local" aria-hidden="true" />
                  {strings.graph.legendNotPushed}
                </span>
              </div>
            </div>
          )}

          {/*
            Floating canvas controls, bottom right. Frame 01 (`10:158`) draws one
            bar: out, a readout that doubles as the reset, in, then the two frame
            actions behind a divider: fit the whole history, or centre HEAD.
          */}
          <div className="gc-canvas__controls" role="group" aria-label={strings.graph.controlsAria}>
            <div className="gc-control-card gc-control-card--zoom">
              <button
                type="button"
                className="gc-icon-button"
                aria-label={strings.graph.zoomOutAria}
                title={strings.graph.zoomOutTitle}
                disabled={zoom <= MIN_ZOOM}
                onClick={() => setZoom(stepZoom(zoom, -1))}
              >
                <Icon name="dash" />
              </button>
              <button
                type="button"
                className="gc-zoom__reset"
                aria-label={strings.graph.zoomResetAria}
                title={strings.graph.zoomResetTitle}
                onClick={() => setZoom(1)}
              >
                {/*
                  `aria-live` is off deliberately: the value is announced by the buttons
                  that changed it, and a live region here would fire on every wheel notch.
                */}
                <span className="gc-zoom__value" aria-live="off">
                  {Math.round(zoom * 100)}%
                </span>
              </button>
              <button
                type="button"
                className="gc-icon-button"
                aria-label={strings.graph.zoomInAria}
                title={strings.graph.zoomInTitle}
                disabled={zoom >= MAX_ZOOM}
                onClick={() => setZoom(stepZoom(zoom, 1))}
              >
                <Icon name="add" />
              </button>
              <span className="gc-zoom__divider" aria-hidden="true" />
              <button
                type="button"
                className="gc-icon-button"
                aria-label={strings.graph.zoomFitAria}
                title={strings.graph.zoomFitTitle}
                onClick={() => setZoom(fitZoom(viewportWidthState, totalWorldW))}
              >
                <Icon name="maximize" />
              </button>
              <button
                type="button"
                className="gc-icon-button"
                aria-label={strings.graph.zoomHeadAria}
                title={strings.graph.zoomHeadTitle}
                disabled={headRow === undefined}
                onClick={() => {
                  if (headRow !== undefined) goToRow(headRow);
                }}
              >
                <Icon name="crosshair" />
              </button>
            </div>
          </div>
        </div>
      </div>

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

function NodeMark({
  node,
  avatarUrl,
  y,
  color,
  dim,
  selected,
  zoom,
  onSelect,
  onOpen,
  onHoverChange,
}: {
  node: GraphNode;
  avatarUrl: string | null;
  y: number;
  color: string;
  dim: boolean;
  selected: boolean;
  zoom: number;
  onSelect(): void;
  onOpen(): void;
  onHoverChange(hovered: boolean): void;
}): JSX.Element {
  const [imgFailed, setImgFailed] = useState(false);
  const strings = useT();
  const x = node.x;
  // HEAD and merge both grow the circle; a merge at HEAD takes the larger of the two.
  const r = Math.max(AVATAR_RADIUS, node.isHead ? HEAD_RADIUS : 0, node.isMerge ? NODE_RADIUS + 2 : 0);
  // 2 px inside the dot, not flush with it: the selection ring is a 2.5 px stroke centred on
  // the dot's path, so 1.25 px of it falls inside the radius and a flush avatar would cover
  // the half that says "this commit is selected".
  const avatarRadius = r - 2;
  const classes = ['gc-node'];
  if (node.local) classes.push('gc-node--local');
  if (dim) classes.push('gc-node--dim');
  if (selected) classes.push('gc-node--selected');
  // Both the initial and avatar are unreadable below `TEXT_MIN_ZOOM`, the same threshold the outside label
  // uses, so both vanish together.
  const showContent = zoom >= TEXT_MIN_ZOOM;
  // A local commit has no avatar to show - it is not on GitHub yet - and its hollow dashed
  // dot is a signal an image would paint over.
  const hasAvatar = showContent && !node.local && avatarUrl !== null && isSafeImageSrc(avatarUrl) && !imgFailed;
  const clipId = `clip-${node.hash}`;
  // Hit circle world radius: ensures rendered pixel radius is max(NODE_RADIUS * zoom, 14) px,
  // clamped so it cannot exceed half of min(COLUMN_WIDTH, LANE_HEIGHT).
  const maxHitRadius = Math.min(COLUMN_WIDTH, LANE_HEIGHT) / 2; // 48 world px (half COLUMN_WIDTH, targets never overlap in world space)
  const hitRadius = Math.min(maxHitRadius, zoom < 1 ? Math.max(r, 14 / zoom) : r);

  return (
    <g className={classes.join(' ')}>
      {/* Transparent hit target circle for click, dblclick, hover */}
      <circle
        className="gc-node__hit"
        cx={x}
        cy={y}
        r={hitRadius}
        data-node={node.hash}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
      />
      {hasAvatar && (
        <defs>
          <clipPath id={clipId}>
            <circle cx={x} cy={y} r={avatarRadius} />
          </clipPath>
        </defs>
      )}
      {/* Selection ring behind the dot: frame 01 `10:81` is 46 px against a 28 px node. */}
      {selected && <circle className="gc-node__halo" cx={x} cy={y} r={r + 9} />}
      <circle
        className="gc-node__dot"
        cx={x}
        cy={y}
        r={r}
        stroke={color}
        fill={node.local ? 'var(--vscode-editor-background)' : color}
      />
      {/*
        HEAD tag above the circle (frame 01 `151:6`, 39 x 16). Text needs the same
        zoom threshold as the initial, or it turns into a smudge.
      */}
      {node.isHead && showContent && (
        <g className="gc-node__head-tag">
          <rect x={x - 19.5} y={y - r - 26} width={39} height={16} rx={4} />
          <text x={x} y={y - r - 15} textAnchor="middle">{strings.graph.headTag}</text>
        </g>
      )}
      {hasAvatar && isSafeImageSrc(avatarUrl) && (
        <image
          className="gc-node__avatar"
          href={avatarUrl}
          x={x - avatarRadius}
          y={y - avatarRadius}
          width={avatarRadius * 2}
          height={avatarRadius * 2}
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          onError={() => setImgFailed(true)}
        />
      )}
      {/*
        Author initial inside the node, as in the Unity Branch Explorer: it turns the
        graph into "who did what" at a glance without reading a single row.
        Still the fallback whenever there is no avatar to draw: no linked account, an image
        that failed to load, or a local commit.

        `aria-hidden` is mandatory, not defensive — `rowLabel` already carries the
        full author name for this row, and a screen reader that reads the SVG text
        too would announce the author twice, once as a whole name and once as a
        stray letter.

        A local commit has a hollow dot, so its letter takes the lane colour; a
        filled dot needs the editor background to stay legible against it. Both are
        theme tokens or lane data, never a literal.
      */}
      {showContent && !hasAvatar && (
        <text
          className="gc-node__initial"
          x={x}
          y={y}
          fill={node.local ? color : 'var(--vscode-editor-background)'}
          aria-hidden="true"
        >
          {authorInitials(node.authorName)}
        </text>
      )}
      {/*
        Merge glyph inside the circle (frame 01 `10:51`): two arcs joining into one
        stem, in the contrast colour of the dot's fill.
      */}
      {node.isMerge && (
        <path
          className="gc-node__merge-glyph"
          d={`M${x - 4},${y - 5} v2 a3,3 0 0 0 3,3 h2 M${x + 4},${y - 5} v2 a3,3 0 0 1 -3,3 h-2`}
          stroke={node.local ? color : 'var(--vscode-editor-background)'}
          strokeWidth={1.6}
          fill="none"
        />
      )}
      {/*
        Rings last so they sit above the avatar. `r + 3`, not `r + 4`: at lane 0 the centre
        sits at `RULER_HEIGHT + LANE_HEIGHT / 2`, and a head ring at `r + 4` plus a 1.5
        stroke reaches a quarter pixel from the SVG edge, which rounds to a clipped ring.
      */}
      {node.isHead && <circle className="gc-node__head-ring" cx={x} cy={y} r={r + 3} stroke={color} />}
      {/*
        Hover halo, drawn last so it sits above every other ring. The stroke is
        CSS-owned (`--vscode-focusBorder`): it is chrome feedback, not lane data,
        so it must follow the theme rather than the branch palette.
      */}
      <circle className="gc-node__hover-ring" cx={x} cy={y} r={r + 4} />
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
  hovered: boolean;
  visible: boolean;
  placement: 'above' | 'below';
  lang: import('./i18n').Lang;
  onSelect(): void;
  onOpen(): void;
  onHoverChange(hovered: boolean): void;
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
  hovered,
  visible,
  placement,
  lang,
  onSelect,
  onOpen,
  onHoverChange,
}: RowProps): JSX.Element {
  const dim = !matchesSearch(node, search);
  const classes = ['gc-row', `gc-row--${placement}`];
  if (visible) classes.push('gc-row--visible');
  if (hovered) classes.push('gc-row--hovered');
  if (selected) classes.push('gc-row--selected');
  if (node.isHead) classes.push('gc-row--head');
  if (dim) classes.push('gc-row--dim');
  // Both come from git. Sanitised once here so the `title` attribute and the
  // visible text cannot disagree.
  const subject = sanitizeGitText(node.subject);
  const author = sanitizeGitText(node.authorName);
  const time = relativeTime(node.authoredAt, now, lang);

  // Position row below or above node center depending on stagger placement
  const nodeCenterY = laneY(node.lane, LANE_HEIGHT, RULER_HEIGHT);
  const topY = placement === 'above'
    ? (nodeCenterY - NODE_RADIUS - 6) * zoom
    : (nodeCenterY + NODE_RADIUS + 6) * zoom;
  const rowWidth = (COLUMN_WIDTH - 8) * zoom;

  return (
    <div
      className={classes.join(' ')}
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-row={index}
      tabIndex={focused ? 0 : -1}
      style={{
        top: `${topY}px`,
        left: `${left}px`,
        ['--gc-row-width' as string]: `${rowWidth}px`,
      }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
    >
      {/* One gridcell carries the whole row: the accessible name is composed in
          `rowLabel`, and the visual parts stay hidden so nothing is read twice. */}
      <span
        className="gc-row__cell-group"
        role="gridcell"
        aria-colindex={1}
        aria-label={rowLabel(node, now, lang)}
      >
        <span className="gc-row__subject" title={subject} aria-hidden="true">
          <Highlight text={subject} needle={search} />
        </span>
        <span className="gc-row__meta" aria-hidden="true">
          <span className="gc-row__author" title={author}>{author}</span>
          <span className="gc-row__dot">·</span>
          <span className="gc-row__time">{time}</span>
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

