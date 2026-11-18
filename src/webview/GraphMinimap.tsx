/**
 * Minimap: a condensed overview of the whole loaded history with a draggable
 * viewport rectangle. Frame 01 (`10:178`) draws one coloured horizontal line per
 * branch lane, from its first commit to its last, so a lane stays readable at a
 * glance and the cost is bounded by lane count rather than commit count.
 *
 * Accessibility: `role="slider"` over the row index, with `aria-valuetext` so the
 * announcement is "commit 120 dari 3.400" rather than a bare number. Home, End,
 * and the arrow keys all move it, which makes the whole history reachable without
 * a pointer even though the visual affordance is a drag.
 */
import { useCallback, useRef, type JSX, type PointerEvent } from 'react';
import { minimapGeometry, minimapLaneRows, minimapScrollFor, COLUMN_WIDTH } from './viewport';
import { useT } from './useT';
import type { GraphNode } from '../messages';

interface Props {
  nodes: readonly GraphNode[];
  laneCount: number;
  /** Lane colours, indexed by lane number. */
  colors: readonly string[];
  scrollLeft: number;
  viewportWidth: number;
  zoom: number;
  totalWorldWidth: number;
  width: number;
  /** Frame height; defaults to the compact strip other callers draw. */
  height?: number;
  onScroll(scrollLeft: number): void;
}

const HEIGHT = 48;

export function GraphMinimap({
  nodes,
  laneCount,
  colors,
  scrollLeft,
  viewportWidth,
  zoom,
  totalWorldWidth,
  width,
  height = HEIGHT,
  onScroll,
}: Props): JSX.Element | null {
  const strings = useT();
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
  const rows = minimapLaneRows(nodes, laneCount);
  /** First lane at 6 px, last at `height - 6`, evenly spaced between. */
  const rowTop = (lane: number): number =>
    6 + (lane / Math.max(1, laneCount - 1)) * (height - 12);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    event.stopPropagation();
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seek(event.clientX);
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    event.stopPropagation();
    if (dragging.current) seek(event.clientX);
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>): void => {
    event.stopPropagation();
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerCancel = (event: PointerEvent<SVGSVGElement>): void => {
    event.stopPropagation();
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const maxScroll = Math.max(0, totalWorldWidth * zoom - viewportWidth);
  const currentScroll = Math.min(maxScroll, Math.max(0, Math.round(scrollLeft)));
  const progressPercent = maxScroll > 0 ? Math.round((currentScroll / maxScroll) * 100) : 0;

  /** One screen of cols, so PageUp/PageDown match what the canvas does. */
  const page = Math.max(1, Math.floor(viewportWidth / (COLUMN_WIDTH * zoom)));

  return (
    <svg
      ref={ref}
      className="gc-minimap"
      width={width}
      height={height}
      role="slider"
      tabIndex={0}
      aria-label={strings.minimap.ariaLabel}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(maxScroll)}
      aria-valuenow={currentScroll}
      aria-valuetext={strings.minimap.valueText(progressPercent)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(event) => {
        const to = (next: number): void => {
          event.preventDefault();
          onScroll(Math.min(maxScroll, Math.max(0, next)));
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
            to(maxScroll);
            return;
          default:
        }
      }}
    >
      {rows.map((row) => {
        const y = rowTop(row.lane);
        const x1 = row.startX * geometry.scale;
        // A single-commit lane is a point; the minimum length keeps it visible.
        const x2 = Math.max(row.endX * geometry.scale, x1 + 2);
        return (
          <line
            key={row.lane}
            className="gc-minimap__lane"
            x1={x1}
            x2={x2}
            y1={y}
            y2={y}
            stroke={colors[row.lane] ?? 'currentColor'}
          />
        );
      })}
      <rect
        className="gc-minimap__viewport"
        x={geometry.rectLeft}
        y={0.5}
        width={geometry.rectWidth}
        height={height - 1}
        rx={2}
      />
    </svg>
  );
}
