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
import { BranchLegend } from './BranchLegend';
import { GraphMinimap } from './GraphMinimap';
import { NodeContextMenu, type MenuAnchor, type MenuItem } from './NodeContextMenu';
import { EmptyState, GraphSkeleton, Icon, InfoBanner, Spinner, type IconName } from './ui';
import {
  authorInitials,
  formatCount,
  relativeTime,
  rowLabel,
  sanitizeGitText,
  shortHash,
  truncate,
} from './format';
import { useRepoStore, useSettingsStore } from './store';
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
  clampZoom,
  edgeIntersectsBand,
  laneY,
  columnX,
  scrollToCommit,
  stepZoom,
  visibleColumnRange,
  visibleWorldBand,
  worldHeight,
  worldWidth,
} from './viewport';
import type { DateBucket, GraphEdge, GraphNode, RefInfo, RepoGraph, RepoStatus } from '../messages';

/**
 * Compute calendar day ordinal from a local timestamp.
 * Monotonic integer per Gregorian calendar day, timezone-safe and pre-1970-safe.
 */
function calendarDayOrdinal(timestamp: number): number {
  if (!Number.isFinite(timestamp)) return 0;
  const dt = new Date(timestamp);
  let y = dt.getFullYear();
  let m = dt.getMonth() + 1;
  const d = dt.getDate();
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m - 3) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe;
}

/** Pre-pass to compute label position (below vs above) to prevent collisions of neighbouring nodes in the same lane. */
export function computeStaggerMap(nodes: readonly GraphNode[]): Map<string, 'above' | 'below'> {
  const map = new Map<string, 'above' | 'below'>();
  // Group nodes by lane
  const laneMap = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    let list = laneMap.get(node.lane);
    if (!list) {
      list = [];
      laneMap.set(node.lane, list);
    }
    list.push(node);
  }

  // Sort each lane by X coordinate and assign alternating placement to adjacent x-neighbours
  for (const laneNodes of laneMap.values()) {
    laneNodes.sort((a, b) => a.x - b.x);
    for (let i = 0; i < laneNodes.length; i += 1) {
      const node = laneNodes[i] as GraphNode;
      const placement = i % 2 === 1 ? 'above' : 'below';
      map.set(node.hash, placement);
    }
  }
  return map;
}
const MINIMAP_HEIGHT = 160;

/**
 * Radius of a commit node, and the zoom below which its author initial is dropped.
 *
 * `NODE_RADIUS + 1` (6 px) is the smallest circle that can hold a legible letter at
 * 100 % zoom; a merge node stays one pixel larger than that, exactly as before, so
 * the "merge nodes are bigger" channel the legend describes is unchanged. Lanes are
 * `LANE_HEIGHT` (88 px) apart, so nothing here brings two nodes closer than the merge
 * ring already did.
 *
 * Both constants are presentation-only and stay here rather than in `viewport.ts`,
 * which owns the layout maths the host and the tests agree on.
 *
 * Below 75 % the letter is a smudge rather than a label, so it is not drawn at all —
 * the dot, the rings, and the row text all still say everything they said before.
 */
const AVATAR_RADIUS = NODE_RADIUS + 1;
const INITIAL_MIN_ZOOM = 0.75;


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
  icon: IconName;
  prefix: string;
  name: string;
}

const CHIP_ICON: Record<ChipKind, IconName> = {
  current: 'git-branch',
  local: 'circle-filled',
  remote: 'cloud',
  tag: 'tag',
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
        icon: CHIP_ICON.tag,
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
        icon: CHIP_ICON.remote,
        prefix: 'remote ',
        name: sanitizeGitText(short),
      });
      continue;
    }
    const isCurrent = currentBranch !== null && short === currentBranch;
    chips.push({
      kind: isCurrent ? 'current' : 'local',
      icon: isCurrent ? CHIP_ICON.current : CHIP_ICON.local,
      prefix: '',
      name: sanitizeGitText(short),
    });
  }
  // Current branch first, then locals, remotes, tags.
  const order: Record<ChipKind, number> = { current: 0, local: 1, remote: 2, tag: 3 };
  return chips.sort((a, b) => order[a.kind] - order[b.kind]);
}

/**
 * Accessible name for a commit row.
 *
 * Re-exported rather than defined here: it lives in `format.ts` so `a11y.test.ts`
 * can assert it without a DOM, and so this file has exactly one source for it.
 */
export { rowLabel };

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
  const legendButtonRef = useRef<HTMLButtonElement>(null);
  const legendPanelRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportWidthState, setViewportWidthState] = useState(800);
  const [showLegend, setShowLegend] = useState(false);
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
  // Ids for the grid's description, search result count, and legend popover.
  const helpId = useId();
  const countId = useId();
  const legendId = useId();

  // Close legend popover on outside click or focus loss
  useEffect(() => {
    if (!showLegend) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        legendPanelRef.current !== null &&
        !legendPanelRef.current.contains(target) &&
        legendButtonRef.current !== null &&
        !legendButtonRef.current.contains(target)
      ) {
        setShowLegend(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [showLegend]);

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

  const visibleLanes = useMemo(() => {
    if (graph === null) return [];
    const usedLanes = new Set(rows.map((n) => n.lane));
    return graph.lanes.filter((l) => usedLanes.has(l.index));
  }, [graph, rows]);

  const maxNodeX = useMemo(() => {
    return rows.reduce((max, n) => Math.max(max, n.x), 0);
  }, [rows]);
  const totalWorldW = worldWidth(maxNodeX + COLUMN_WIDTH, GUTTER_X);
  const totalWorldH = worldHeight(laneCount, LANE_HEIGHT, RULER_HEIGHT);

  const range = visibleColumnRange({
    scrollLeft,
    viewportWidth: viewportWidthState,
    nodeCount: rows.length,
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
      const left = target.x * zoom;
      const right = left + COLUMN_WIDTH * zoom;
      if (left < node.scrollLeft || right > node.scrollLeft + node.clientWidth) {
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
        const left = target.x * zoom;
        const right = left + COLUMN_WIDTH * zoom;
        if (left < node.scrollLeft || right > node.scrollLeft + node.clientWidth) {
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
        title="Belum ada commit di repository ini."
        hint="Grafik menggambar riwayat commit, jadi ia baru punya isi setelah commit pertama."
        steps={[
          'Buka panel Pending Changes.',
          'Centang file yang ingin Anda simpan, lalu tekan Stage.',
          'Tulis pesan singkat tentang apa yang Anda ubah.',
          'Tekan Commit. Commit pertama itu akan langsung muncul di grafik ini.',
        ]}
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
        refs={graph?.refs ?? []}
        countId={countId}
        onSearch={setSearch}
        onBranchFilter={setBranchFilter}
      />

      {/*
        The only live region on this surface. It announces the filtered total after
        the user stops typing rather than on every keystroke, because `polite`
        queues and a per-frame update would leave a screen reader minutes behind.
      */}
      <p className="gc-help-text" id={countId} role="status" aria-live="polite">
        {search.length === 0 && branchFilter.length === 0
          ? `${formatCount(rows.length)} commit ditampilkan.`
          : `${formatCount(matchCount)} dari ${formatCount(rows.length)} commit cocok dengan filter.`}
      </p>

      {graph?.stale === true && (
        <InfoBanner tone="warning" glyph="watch">
          <strong>Data lama</strong>
          <span>Data ini snapshot lama karena git gagal dibaca. Muat ulang untuk mencoba lagi.</span>
        </InfoBanner>
      )}

      {graph?.truncated === true && (
        <InfoBanner tone="info" glyph="ellipsis">
          <strong>Histori dipangkas ke 10.000 commit.</strong>
          <button
            type="button"
            className="gc-button gc-button--quiet"
            title="Ambil 10.000 commit berikutnya dari histori. Hanya menambah isi grafik, tidak mengubah repository."
            disabled={paging || graph.nextCursor === null}
            onClick={() => void loadMore()}
          >
            Muat lebih banyak
          </button>
          {paging && <Spinner label="Memuat halaman berikutnya…" />}
        </InfoBanner>
      )}

      <p className="gc-visually-hidden" id={helpId}>
        Gunakan panah kiri dan kanan untuk berpindah commit, panah atas dan bawah untuk berpindah antar jalur,
        Enter untuk membuka detail, Shift F10 untuk menu tindakan, tanda plus dan minus untuk
        perbesaran, dan angka nol untuk mengembalikan perbesaran ke 100 persen.
      </p>

      <div className="gc-graph__main">
        {/*
          Positioned wrapper so the floating controls can sit over the canvas
          without scrolling with it. They cannot live INSIDE `.gc-canvas`: that
          element is the scroll container, and an absolutely positioned child of a
          scroller drifts away with the content.
        */}
        <div className="gc-graph__stage">
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
            aria-label="Grafik commit"
            aria-rowcount={rows.length}
            aria-colcount={1}
            aria-orientation="horizontal"
            aria-describedby={helpId}
            tabIndex={0}
            onFocus={(event) => {
              if (event.target !== event.currentTarget) return;
              if (rows.length > 0) revealRow(focusRow);
            }}
            onScroll={(event) => {
              clearHoverImmediate();
              setScrollLeft(event.currentTarget.scrollLeft);
            }}
            onPointerLeave={() => clearHoverImmediate()}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onContextMenu={onContextMenu}
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
                      left: `${bucket.startX * zoom}px`,
                      width: `${bucket.width * zoom}px`,
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
                  {/* Alternating day backgrounds & separator lines */}
                  {dateBuckets.map((bucket) => {
                    const dayOrdinal = calendarDayOrdinal(bucket.timestamp);
                    return (
                      <g key={`day-bg-${bucket.timestamp}`}>
                        {Math.abs(dayOrdinal) % 2 === 1 && (
                          <rect
                            className="gc-canvas__day-band"
                            x={bucket.startX}
                            y={RULER_HEIGHT}
                            width={bucket.width}
                            height={totalWorldH - RULER_HEIGHT}
                          />
                        )}
                        <line
                          className="gc-canvas__day-line"
                          x1={bucket.startX + bucket.width}
                          y1={RULER_HEIGHT}
                          x2={bucket.startX + bucket.width}
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
                        edge.kind === 'merge' ? 'gc-edge gc-edge--merge' : 'gc-edge gc-edge--direct'
                      }
                      d={edgePath(edge, fromX, toX)}
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
                return (
                  <div
                    key={`pill-${node.hash}`}
                    className={`gc-pill gc-pill--${branchChip.kind}`}
                    style={{
                      left: `${node.x * zoom}px`,
                      top: `${(laneY(node.lane, LANE_HEIGHT, RULER_HEIGHT) - NODE_RADIUS - 6) * zoom}px`,
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
                const visible = hovered || selected || focused || isHead;
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
            Floating Minimap: placed horizontally centred at the bottom of the canvas stage.
            Hidden when viewport width < 220px to prevent colliding with bottom-right floating controls stack.
            Width scales dynamically between 120px and 360px (~45% of stage width), never exceeding 60% of stage width.
          */}
          {viewportWidthState >= 220 && (
            <div className="gc-minimap-wrap">
              <GraphMinimap
                nodes={rows}
                laneCount={laneCount}
                scrollLeft={scrollLeft}
                viewportWidth={viewportWidthState}
                zoom={zoom}
                totalWorldWidth={totalWorldW}
                width={Math.max(120, Math.min(360, Math.round(viewportWidthState * 0.45)))}
                onScroll={(left) => {
                  const node = scrollRef.current;
                  if (node !== null) node.scrollLeft = left;
                }}
              />
            </div>
          )}

          {/*
            Floating canvas controls, bottom right, as in the Unity reference:
            Panduan simbol popover launcher, go to HEAD, then zoom.
          */}
          <div className="gc-canvas__controls" role="group" aria-label="Kontrol tampilan kanvas">
            <button
              ref={legendButtonRef}
              type="button"
              className="gc-icon-button gc-icon-button--float"
              aria-label="Panduan simbol grafik"
              title="Panduan simbol grafik"
              aria-expanded={showLegend}
              aria-controls={showLegend ? legendId : undefined}
              onClick={() => setShowLegend(!showLegend)}
            >
              <Icon name="info" />
            </button>
            <button
              type="button"
              className="gc-icon-button gc-icon-button--float"
              aria-label="Lompat ke commit HEAD"
              title="Kembali ke posisi Anda sekarang (HEAD)."
              disabled={headRow === undefined}
              onClick={() => {
                if (headRow !== undefined) goToRow(headRow);
              }}
            >
              <Icon name="home" />
            </button>
            <button
              type="button"
              className="gc-icon-button gc-icon-button--float"
              aria-label="Perbesar grafik"
              title="Perbesar (juga: tombol +)"
              disabled={zoom >= MAX_ZOOM}
              onClick={() => setZoom(stepZoom(zoom, 1))}
            >
              <Icon name="add" />
            </button>
            <button
              type="button"
              className="gc-icon-button gc-icon-button--float"
              aria-label="Perkecil grafik"
              title="Perkecil (juga: tombol −)"
              disabled={zoom <= MIN_ZOOM}
              onClick={() => setZoom(stepZoom(zoom, -1))}
            >
              <Icon name="dash" />
            </button>
            <button
              type="button"
              className="gc-button gc-button--float"
              aria-label="Kembalikan perbesaran ke 100 persen"
              title="Kembali ke 100% (juga: tombol 0)"
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

            {/* Floating popover for BranchLegend, anchored directly above the controls stack */}
            {showLegend && (
              <div ref={legendPanelRef} className="gc-legend-popover">
                <BranchLegend
                  id={legendId}
                  lanes={visibleLanes}
                  onClose={() => {
                    setShowLegend(false);
                    legendButtonRef.current?.focus();
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {graph !== null && graph.nextCursor !== null && graph.truncated === false && (
        <div className="gc-graph__more">
          <button
            type="button"
            className="gc-button"
            title="Ambil halaman commit berikutnya dari histori. Hanya menambah isi grafik, tidak mengubah repository."
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
 * Edge geometry in horizontal layout: fromX/toX horizontal span, fromY/toY vertical lane centres.
 */
export function edgePath(edge: GraphEdge, fromX: number, toX: number): string {
  const y1 = laneY(edge.fromLane, LANE_HEIGHT, RULER_HEIGHT);
  const y2 = laneY(edge.toLane, LANE_HEIGHT, RULER_HEIGHT);
  if (y1 === y2) return `M${fromX} ${y1}L${toX} ${y2}`;
  const mid = (fromX + toX) / 2;
  return `M${fromX} ${y1}C${mid} ${y1} ${mid} ${y2} ${toX} ${y2}`;
}

function NodeMark({
  node,
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
  y: number;
  color: string;
  dim: boolean;
  selected: boolean;
  zoom: number;
  onSelect(): void;
  onOpen(): void;
  onHoverChange(hovered: boolean): void;
}): JSX.Element {
  const x = node.x;
  // Merge nodes keep their extra pixel, so "bigger circle = merge" still holds.
  const r = node.isMerge ? NODE_RADIUS + 2 : AVATAR_RADIUS;
  const classes = ['gc-node'];
  if (node.local) classes.push('gc-node--local');
  if (dim) classes.push('gc-node--dim');
  if (selected) classes.push('gc-node--selected');
  // The initial is unreadable below ~75 %, and a merge node is the only one wide
  // enough to hold a glyph without touching its own ring.
  const showInitial = zoom >= INITIAL_MIN_ZOOM;
  // Hit circle world radius: ensures rendered pixel radius is max(NODE_RADIUS * zoom, 14) px,
  // clamped so it cannot exceed half of min(COLUMN_WIDTH, LANE_HEIGHT).
  const maxHitRadius = Math.min(COLUMN_WIDTH, LANE_HEIGHT) / 2; // 44 world px (half lane height, targets never overlap in world space)
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
      {/* `r + 3`, not `r + 4`: at lane 0 the centre sits at `RULER_HEIGHT + LANE_HEIGHT / 2`,
          and a merge head-ring at `r + 4` plus a 1.5 stroke reaches 11.75 — a
          quarter pixel from the SVG edge, which rounds to a clipped ring. */}
      {node.isHead && <circle className="gc-node__head-ring" cx={x} cy={y} r={r + 3} stroke={color} />}
      {node.isMerge && <circle className="gc-node__merge-ring" cx={x} cy={y} r={r + 2} stroke={color} />}
      <circle
        className="gc-node__dot"
        cx={x}
        cy={y}
        r={r}
        stroke={color}
        fill={node.local ? 'var(--vscode-editor-background)' : color}
      />
      {/*
        Author initial inside the node, as in the Unity Branch Explorer: it turns the
        graph into "who did what" at a glance without reading a single row.

        `aria-hidden` is mandatory, not defensive — `rowLabel` already carries the
        full author name for this row, and a screen reader that reads the SVG text
        too would announce the author twice, once as a whole name and once as a
        stray letter.

        A local commit has a hollow dot, so its letter takes the lane colour; a
        filled dot needs the editor background to stay legible against it. Both are
        theme tokens or lane data, never a literal.
      */}
      {showInitial && (
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
  onSelect,
  onOpen,
  onHoverChange,
}: RowProps): JSX.Element {
  const dim = !matchesSearch(node, search);
  const classes = ['gc-row', `gc-row--${placement}`];
  if (visible) classes.push('gc-row--visible');
  if (hovered) classes.push('gc-row--hovered');
  if (selected) classes.push('gc-row--selected');
  if (dim) classes.push('gc-row--dim');
  // Both come from git. Sanitised once here so the `title` attribute and the
  // visible text cannot disagree.
  const subject = sanitizeGitText(node.subject);
  const author = sanitizeGitText(node.authorName);
  const time = relativeTime(node.authoredAt, now);

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
        aria-label={rowLabel(node, now)}
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

/**
 * Filter bar above the canvas.
 *
 * Zoom used to live here; it now floats over the canvas instead, which leaves this
 * row with one job — narrowing what is drawn — announced by the label the reference
 * puts in front of its own filter row. Two fields, both labelled in words, so the
 * row reads as "Saring: nama / branch" rather than as three unrelated widgets.
 */
function Toolbar({
  search,
  branchFilter,
  refs,
  countId,
  onSearch,
  onBranchFilter,
}: {
  search: string;
  branchFilter: string;
  refs: readonly RefInfo[];
  /** Id of the result-count live region, so the search box points at its own output. */
  countId: string;
  onSearch(value: string): void;
  onBranchFilter(value: string): void;
}): JSX.Element {
  const branches = refs.filter((r) => r.kind === 'local' || r.kind === 'remote');
  return (
    <div
      className="gc-toolbar gc-toolbar--filters"
      role="toolbar"
      aria-label="Saringan grafik"
      aria-orientation="horizontal"
    >
      <div className="gc-toolbar__search-wrap">
        <span className="gc-toolbar__search-icon" aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          type="search"
          className="gc-toolbar__search-input"
          value={search}
          maxLength={100}
          placeholder="Cari commit (hash, pesan, penulis)..."
          aria-label="Cari commit"
          aria-describedby={countId}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <div className="gc-toolbar__branch-wrap">
        <select
          className="gc-toolbar__branch-select"
          value={branchFilter}
          aria-label="Filter branch"
          onChange={(e) => onBranchFilter(e.target.value)}
        >
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
      </div>

      {(search.length > 0 || branchFilter.length > 0) && (
        <button
          type="button"
          className="gc-button gc-button--quiet gc-toolbar__clear"
          title="Tampilkan kembali semua commit."
          onClick={() => {
            onSearch('');
            onBranchFilter('');
          }}
        >
          Reset
        </button>
      )}
    </div>
  );
}
