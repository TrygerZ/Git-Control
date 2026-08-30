/**
 * Minimap: a condensed overview of the whole loaded history with a draggable
 * viewport rectangle. Every commit becomes one 1 px tick, so even 10 000 rows
 * stay cheap — the ticks are drawn as a single path, not per-node elements.
 *
 * Accessibility: `role="slider"` over the row index, with `aria-valuetext` so the
 * announcement is "commit 120 dari 3.400" rather than a bare number. Home, End,
 * and the arrow keys all move it, which makes the whole history reachable without
 * a pointer even though the visual affordance is a drag.
 */
import { useCallback, useRef, type JSX, type PointerEvent } from 'react';
import { formatCount } from './format';
import { minimapGeometry, minimapScrollFor, ROW_HEIGHT } from './viewport';
import type { GraphNode } from '../messages';

interface Props {
  nodes: readonly GraphNode[];
  laneCount: number;
  scrollTop: number;
  viewportHeight: number;
  zoom: number;
  height: number;
  onScroll(scrollTop: number): void;
}

const WIDTH = 56;
/** Ticks are sampled so a huge history does not produce a huge path string. */
const MAX_TICKS = 600;

export function GraphMinimap({
  nodes,
  laneCount,
  scrollTop,
  viewportHeight,
  zoom,
  height,
  onScroll,
}: Props): JSX.Element | null {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const seek = useCallback(
    (clientY: number): void => {
      const box = ref.current?.getBoundingClientRect();
      if (box === undefined) return;
      onScroll(
        minimapScrollFor(clientY - box.top, viewportHeight, zoom, nodes.length, height, ROW_HEIGHT),
      );
    },
    [height, nodes.length, onScroll, viewportHeight, zoom],
  );

  if (nodes.length === 0) return null;

  const geometry = minimapGeometry(scrollTop, viewportHeight, zoom, nodes.length, height, ROW_HEIGHT);
  const laneSpan = Math.max(1, laneCount);
  const step = Math.max(1, Math.ceil(nodes.length / MAX_TICKS));
  const rowScale = height / nodes.length;

  const ticks: string[] = [];
  for (let i = 0; i < nodes.length; i += step) {
    const node = nodes[i] as GraphNode;
    const x = 4 + (node.lane / laneSpan) * (WIDTH - 8);
    const y = i * rowScale;
    ticks.push(`M${x.toFixed(1)} ${y.toFixed(1)}h3`);
  }

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seek(event.clientY);
  };

  const row = Math.round(scrollTop / (ROW_HEIGHT * zoom));
  /** One screen of rows, so PageUp/PageDown match what the canvas does. */
  const page = Math.max(1, Math.floor(viewportHeight / (ROW_HEIGHT * zoom)));

  return (
    <svg
      ref={ref}
      className="gc-minimap"
      width={WIDTH}
      height={height}
      role="slider"
      tabIndex={0}
      aria-label="Ikhtisar grafik"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, nodes.length - 1)}
      aria-valuenow={row}
      aria-valuetext={`Baris ${formatCount(row + 1)} dari ${formatCount(nodes.length)}`}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (dragging.current) seek(event.clientY);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const max = Math.max(0, nodes.length * ROW_HEIGHT * zoom - viewportHeight);
        const to = (next: number): void => {
          event.preventDefault();
          onScroll(Math.min(max, Math.max(0, next)));
        };
        // A slider that only answers ArrowUp/ArrowDown is a slider a keyboard user
        // has to hold a key on for 3 000 rows. Page and Home/End are the way out.
        switch (event.key) {
          case 'ArrowDown':
            to(scrollTop + ROW_HEIGHT * zoom);
            return;
          case 'ArrowUp':
            to(scrollTop - ROW_HEIGHT * zoom);
            return;
          case 'PageDown':
            to(scrollTop + page * ROW_HEIGHT * zoom);
            return;
          case 'PageUp':
            to(scrollTop - page * ROW_HEIGHT * zoom);
            return;
          case 'Home':
            to(0);
            return;
          case 'End':
            to(max);
            return;
          default:
        }
      }}
    >
      <path className="gc-minimap__ticks" d={ticks.join('')} />
      <rect
        className="gc-minimap__viewport"
        x={0.5}
        y={geometry.rectTop}
        width={WIDTH - 1}
        height={geometry.rectHeight}
        rx={2}
      />
    </svg>
  );
}
