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
import { minimapGeometry, minimapScrollFor, COLUMN_WIDTH } from './viewport';
import type { GraphNode } from '../messages';

interface Props {
  nodes: readonly GraphNode[];
  laneCount: number;
  scrollLeft: number;
  viewportWidth: number;
  zoom: number;
  totalWorldWidth: number;
  width: number;
  onScroll(scrollLeft: number): void;
}

const HEIGHT = 48;
/** Ticks are sampled so a huge history does not produce a huge path string. */
const MAX_TICKS = 600;

export function GraphMinimap({
  nodes,
  laneCount,
  scrollLeft,
  viewportWidth,
  zoom,
  totalWorldWidth,
  width,
  onScroll,
}: Props): JSX.Element | null {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);

  const seek = useCallback(
    (clientX: number): void => {
      const box = ref.current?.getBoundingClientRect();
      if (box === undefined) return;
      onScroll(
        minimapScrollFor(clientX - box.left, viewportWidth, zoom, totalWorldWidth, width),
      );
    },
    [width, totalWorldWidth, onScroll, viewportWidth, zoom],
  );

  if (nodes.length === 0) return null;

  const geometry = minimapGeometry(scrollLeft, viewportWidth, zoom, totalWorldWidth, width);
  const laneSpan = Math.max(1, laneCount);
  const step = Math.max(1, Math.ceil(nodes.length / MAX_TICKS));
  const colScale = totalWorldWidth > 0 ? width / totalWorldWidth : 0;

  const ticks: string[] = [];
  for (let i = 0; i < nodes.length; i += step) {
    const node = nodes[i] as GraphNode;
    const x = node.x * colScale;
    const y = 4 + (node.lane / laneSpan) * (HEIGHT - 8);
    ticks.push(`M${x.toFixed(1)} ${y.toFixed(1)}v3`);
  }

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seek(event.clientX);
  };

  const col = Math.round(scrollLeft / (COLUMN_WIDTH * zoom));
  /** One screen of cols, so PageUp/PageDown match what the canvas does. */
  const page = Math.max(1, Math.floor(viewportWidth / (COLUMN_WIDTH * zoom)));

  return (
    <svg
      ref={ref}
      className="gc-minimap"
      width={width}
      height={HEIGHT}
      role="slider"
      tabIndex={0}
      aria-label="Ikhtisar grafik"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, nodes.length - 1)}
      aria-valuenow={col}
      aria-valuetext={`Commit ${formatCount(col + 1)} dari ${formatCount(nodes.length)}`}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (dragging.current) seek(event.clientX);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        const max = Math.max(0, totalWorldWidth * zoom - viewportWidth);
        const to = (next: number): void => {
          event.preventDefault();
          onScroll(Math.min(max, Math.max(0, next)));
        };
        switch (event.key) {
          case 'ArrowRight':
            to(scrollLeft + COLUMN_WIDTH * zoom);
            return;
          case 'ArrowLeft':
            to(scrollLeft - COLUMN_WIDTH * zoom);
            return;
          case 'PageDown':
            to(scrollLeft + page * COLUMN_WIDTH * zoom);
            return;
          case 'PageUp':
            to(scrollLeft - page * COLUMN_WIDTH * zoom);
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
        x={geometry.rectLeft}
        y={0.5}
        width={geometry.rectWidth}
        height={HEIGHT - 1}
        rx={2}
      />
    </svg>
  );
}
