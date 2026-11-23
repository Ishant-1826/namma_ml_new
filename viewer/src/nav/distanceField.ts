/**
 * distanceField.ts
 * Computes shortest-path walking distance from a start point to every walkable cell.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { NavGrid, NavGridPoint, NavGridCell } from "./navgrid";
import { isCircleBlocked } from "../collision";

interface HeapNode {
  col: number;
  row: number;
  dist: number;
}

class BinaryMinHeap {
  private nodes: HeapNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(col: number, row: number, dist: number): void {
    const node: HeapNode = { col, row, dist };
    this.nodes.push(node);
    this.bubbleUp(this.nodes.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.nodes.length === 0) return undefined;
    const top = this.nodes[0];
    const bottom = this.nodes.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = bottom;
      this.bubbleDown(0);
    }
    return top;
  }

  private bubbleUp(idx: number): void {
    const element = this.nodes[idx];
    while (idx > 0) {
      const parentIdx = (idx - 1) >> 1;
      const parent = this.nodes[parentIdx];
      if (element.dist >= parent.dist) break;
      this.nodes[idx] = parent;
      this.nodes[parentIdx] = element;
      idx = parentIdx;
    }
  }

  private bubbleDown(idx: number): void {
    const length = this.nodes.length;
    const element = this.nodes[idx];
    while (true) {
      let leftChildIdx = (idx << 1) + 1;
      let rightChildIdx = leftChildIdx + 1;
      let swapIdx = -1;

      if (leftChildIdx < length) {
        if (this.nodes[leftChildIdx].dist < element.dist) {
          swapIdx = leftChildIdx;
        }
      }

      if (rightChildIdx < length) {
        const compareDist = swapIdx === -1 ? element.dist : this.nodes[leftChildIdx].dist;
        if (this.nodes[rightChildIdx].dist < compareDist) {
          swapIdx = rightChildIdx;
        }
      }

      if (swapIdx === -1) break;
      this.nodes[idx] = this.nodes[swapIdx];
      this.nodes[swapIdx] = element;
      idx = swapIdx;
    }
  }
}

const SQRT2 = Math.SQRT2; // ~1.41421356

/**
 * Computes walking distances from `start` to all walkable cells using 8-connected Dijkstra
 * with no diagonal corner-cutting.
 * Returns Float32Array where unwalkable/unreachable cells are set to Infinity.
 */
export function dijkstraFrom(
  grid: NavGrid,
  start: NavGridPoint | NavGridCell,
  playerRadius = 0
): Float32Array {
  const width = grid.width;
  const height = grid.height;
  const cellSize = grid.cellSize;
  const totalCells = width * height;

  const distances = new Float32Array(totalCells);
  distances.fill(Infinity);

  // Determine start cell indices
  let startCol = 0;
  let startRow = 0;
  if ("col" in start && "row" in start) {
    startCol = start.col;
    startRow = start.row;
  } else {
    // World coordinates
    let pt: NavGridPoint | null = start;
    if (!grid.isWalkable(pt.x, pt.z)) {
      pt = grid.snapToWalkable(pt.x, pt.z);
    }
    if (!pt) {
      return distances; // completely blocked/out of reach
    }
    const cell = grid.worldToCell(pt.x, pt.z);
    startCol = cell.col;
    startRow = cell.row;
  }

  if (!grid.isCellWalkable(startCol, startRow)) {
    return distances;
  }

  const startIdx = startRow * width + startCol;
  distances[startIdx] = 0.0;

  const heap = new BinaryMinHeap();
  heap.push(startCol, startRow, 0.0);

  const diagCost = SQRT2 * cellSize;
  const cardCost = 1.0 * cellSize;

  while (heap.size > 0) {
    const { col: c, row: r, dist: d } = heap.pop()!;
    const idx = r * width + c;
    if (d > distances[idx] + 1e-6) {
      continue;
    }

    // 8-connected neighbors
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;

        const nc = c + dc;
        const nr = r + dr;

        if (nc < 0 || nc >= width || nr < 0 || nr >= height) continue;
        const nidx = nr * width + nc;
        if (grid.walkable[nidx] !== 1) continue;

        if (playerRadius > 0) {
          const npt = grid.cellToWorld(nc, nr);
          if (isCircleBlocked(grid.rawOccupancy, npt.x, npt.z, playerRadius, false, false)) {
            continue;
          }
        }

        // Diagonal corner-cutting prevention
        if (dc !== 0 && dr !== 0) {
          if (
            grid.walkable[r * width + nc] !== 1 ||
            grid.walkable[nr * width + c] !== 1
          ) {
            continue;
          }
        }

        const stepCost = dc !== 0 && dr !== 0 ? diagCost : cardCost;
        const nextDist = d + stepCost;

        if (nextDist < distances[nidx]) {
          distances[nidx] = nextDist;
          heap.push(nc, nr, nextDist);
        }
      }
    }
  }

  return distances;
}
