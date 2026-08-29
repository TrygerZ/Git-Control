/**
 * Minimap: a condensed overview of the whole loaded history with a draggable
 * viewport rectangle. Every commit becomes one 1 px tick, so even 10 000 rows
 * stay cheap — the ticks are drawn as a single path, not per-node elements.
 */
import { useCallback, useRef, type JSX, type PointerEvent } from 'react';
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

  return (
    <svg
      ref={ref}
      className="gc-minimap"
      width={WIDTH}
      height={height}
      role="slider"
      tabIndex={0}
      aria-label="Ikhtisar grafik"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, nodes.length - 1)}
      aria-valuenow={Math.round(scrollTop / (ROW_HEIGHT * zoom))}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => {
        if (dragging.current) seek(event.clientY);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'PageDown') {
          event.preventDefault();
          onScroll(scrollTop + ROW_HEIGHT * zoom * 10);
        }
        if (event.key === 'ArrowUp' || event.key === 'PageUp') {
          event.preventDefault();
          onScroll(Math.max(0, scrollTop - ROW_HEIGHT * zoom * 10));
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
