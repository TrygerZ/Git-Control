import type { GraphEdge, GraphNode } from '../messages';
import { laneY, segmentIntersectsBand } from './viewport';

export interface BranchRibbonSegment {
  key: string;
  color: string;
  startX: number;
  endX: number;
  trackD: string;
  topD: string;
  bottomD: string;
}

export interface RibbonGeometry {
  laneHeight: number;
  rulerHeight: number;
  capPad: number;
  halfHeight: number;
}

// Half-height of 4px yields an 8px total ribbon height without engulfing nodes.
export const RIBBON_HALF_HEIGHT = 4;

export function computeBranchRibbons(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  band: { left: number; right: number },
  geometry: RibbonGeometry | number = { laneHeight: 88, rulerHeight: 40, capPad: 28, halfHeight: RIBBON_HALF_HEIGHT },
  rulerHeight?: number,
): BranchRibbonSegment[] {
  const dimensions: RibbonGeometry = typeof geometry === 'number'
    ? { laneHeight: geometry, rulerHeight: rulerHeight ?? 40, capPad: 28, halfHeight: RIBBON_HALF_HEIGHT }
    : geometry;
  if (nodes.length === 0) return [];
  const nodeMap = new Map<string, GraphNode>();
  for (const n of nodes) nodeMap.set(n.hash, n);
  const firstParentMap = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind !== 'direct') continue;
    const child = nodeMap.get(edge.from);
    const parent = nodeMap.get(edge.to);
    if (child && parent && child.branchName && child.branchName === parent.branchName) firstParentMap.set(child.hash, parent.hash);
  }
  const branchNodesMap = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!n.branchName) continue;
    let list = branchNodesMap.get(n.branchName);
    if (!list) { list = []; branchNodesMap.set(n.branchName, list); }
    list.push(n);
  }
  const ribbons: BranchRibbonSegment[] = [];
  for (const [branchName, bNodes] of branchNodesMap.entries()) {
    const hasOutgoingLink = new Set<string>();
    const hasIncomingLink = new Set<string>();
    for (const child of bNodes) {
      const parentHash = firstParentMap.get(child.hash);
      if (parentHash && nodeMap.has(parentHash)) {
        const parent = nodeMap.get(parentHash)!;
        hasOutgoingLink.add(child.hash);
        hasIncomingLink.add(parent.hash);

        const leftNode = child.x <= parent.x ? child : parent;
        const rightNode = child.x <= parent.x ? parent : child;
        const startX = leftNode.x;
        const endX = rightNode.x;
        const minX = Math.max(0, startX - dimensions.capPad);
        const maxX = endX + dimensions.capPad;

        if (segmentIntersectsBand(minX, maxX, band)) {
          const color = child.branchColor ?? 'var(--vscode-focusBorder)';
          const y1 = laneY(leftNode.lane, dimensions.laneHeight, dimensions.rulerHeight);
          const y2 = laneY(rightNode.lane, dimensions.laneHeight, dimensions.rulerHeight);
          const h = dimensions.halfHeight;
          if (y1 === y2) {
            const topD = `M${startX} ${y1 - h}L${endX} ${y2 - h}`;
            const bottomD = `M${startX} ${y1 + h}L${endX} ${y2 + h}`;
            const trackD = `M${startX} ${y1 - h}L${endX} ${y2 - h}L${endX} ${y2 + h}L${startX} ${y1 + h}Z`;
            ribbons.push({ key: `${branchName}-link-${leftNode.hash}-${rightNode.hash}`, color, startX, endX, trackD, topD, bottomD });
          } else {
            const mid = (startX + endX) / 2;
            const topD = `M${startX} ${y1 - h}C${mid} ${y1 - h} ${mid} ${y2 - h} ${endX} ${y2 - h}`;
            const bottomD = `M${startX} ${y1 + h}C${mid} ${y1 + h} ${mid} ${y2 + h} ${endX} ${y2 + h}`;
            const trackD = `M${startX} ${y1 - h}C${mid} ${y1 - h} ${mid} ${y2 - h} ${endX} ${y2 - h}L${endX} ${y2 + h}C${mid} ${y2 + h} ${mid} ${y1 + h} ${startX} ${y1 + h}Z`;
            ribbons.push({ key: `${branchName}-link-${leftNode.hash}-${rightNode.hash}`, color, startX, endX, trackD, topD, bottomD });
          }
        }
      }
    }
    for (const node of bNodes) {
      const y = laneY(node.lane, dimensions.laneHeight, dimensions.rulerHeight);
      const color = node.branchColor ?? 'var(--vscode-focusBorder)';
      const isTip = !hasIncomingLink.has(node.hash);
      const isRoot = !hasOutgoingLink.has(node.hash);
      const h = dimensions.halfHeight;
      if (isTip && isRoot) {
        const startX = Math.max(0, node.x - dimensions.capPad);
        const endX = node.x + dimensions.capPad;
        if (segmentIntersectsBand(startX, endX, band)) {
          const topD = `M${startX} ${y - h}L${endX} ${y - h}`;
          const bottomD = `M${startX} ${y + h}L${endX} ${y + h}`;
          const trackD = `M${startX} ${y - h}L${endX} ${y - h}L${endX} ${y + h}L${startX} ${y + h}Z`;
          ribbons.push({ key: `${branchName}-iso-${node.hash}`, color, startX, endX, trackD, topD, bottomD });
        }
      }
      else {
        if (isTip) {
          const startX = node.x;
          const endX = node.x + dimensions.capPad;
          if (segmentIntersectsBand(startX, endX, band)) {
            const topD = `M${startX} ${y - h}L${endX} ${y - h}`;
            const bottomD = `M${startX} ${y + h}L${endX} ${y + h}`;
            const trackD = `M${startX} ${y - h}L${endX} ${y - h}L${endX} ${y + h}L${startX} ${y + h}Z`;
            ribbons.push({ key: `${branchName}-tip-${node.hash}`, color, startX, endX, trackD, topD, bottomD });
          }
        }
        if (isRoot) {
          const startX = Math.max(0, node.x - dimensions.capPad);
          const endX = node.x;
          if (segmentIntersectsBand(startX, endX, band)) {
            const topD = `M${startX} ${y - h}L${endX} ${y - h}`;
            const bottomD = `M${startX} ${y + h}L${endX} ${y + h}`;
            const trackD = `M${startX} ${y - h}L${endX} ${y - h}L${endX} ${y + h}L${startX} ${y + h}Z`;
            ribbons.push({ key: `${branchName}-root-${node.hash}`, color, startX, endX, trackD, topD, bottomD });
          }
        }
      }
    }
  }
  return ribbons;
}

export function edgePath(edge: GraphEdge, fromX: number, toX: number, laneHeight = 88, rulerHeight = 40): string {
  const y1 = laneY(edge.fromLane, laneHeight, rulerHeight);
  const y2 = laneY(edge.toLane, laneHeight, rulerHeight);
  if (y1 === y2) return `M${fromX} ${y1}L${toX} ${y2}`;
  const mid = (fromX + toX) / 2;
  return `M${fromX} ${y1}C${mid} ${y1} ${mid} ${y2} ${toX} ${y2}`;
}
