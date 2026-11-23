/**
 * pathfinder.ts
 * A* pathfinding on 8-connected grid with clearance-based wall avoidance
 * and line-of-sight string-pulling smoothing.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { isCircleBlocked } from "../collision";
import { NavGrid, NavGridPoint } from "./navgrid";

export interface FindPathOptions {
  /** Player circle radius for collision verification (metres). Default 0.08 m. */
  playerRadius?: number;
  /** Weight for low-clearance penalty (0 = pure distance, >0 prefers wider spaces). Default 0.25. */
  clearancePenaltyWeight?: number;
  /** Preferred clearance threshold in metres. Below this, penalty applies. Default 0.45 m. */
  preferredClearanceM?: number;
  /** Step distance for shortcut line collision sampling (metres). Default 0.05 m (5 cm). */
  sampleStepM?: number;
  /** Automatically snap a blocked start position to nearest walkable cell within 1.5 m. Default true. */
  snapStart?: boolean;
  /** Automatically snap a blocked goal position to nearest walkable cell within 1.5 m. Default false. */
  snapGoal?: boolean;
}

export interface PathSuccess {
  points: NavGridPoint[];
  lengthM: number;
  computeMs: number;
  expandedNodes: number;
}

export interface PathError {
  error: "unreachable" | "start-blocked" | "goal-blocked";
}

export type PathResult = PathSuccess | PathError;

interface AStarHeapNode {
  col: number;
  row: number;
  f: number;
  g: number;
}

class AStarMinHeap {
  private nodes: AStarHeapNode[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(col: number, row: number, f: number, g: number): void {
    const node: AStarHeapNode = { col, row, f, g };
    this.nodes.push(node);
    this.bubbleUp(this.nodes.length - 1);
  }

  pop(): AStarHeapNode | undefined {
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
      if (element.f >= parent.f) break;
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
        if (this.nodes[leftChildIdx].f < element.f) {
          swapIdx = leftChildIdx;
        }
      }

      if (rightChildIdx < length) {
        const compareF = swapIdx === -1 ? element.f : this.nodes[leftChildIdx].f;
        if (this.nodes[rightChildIdx].f < compareF) {
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

const SQRT2 = Math.SQRT2; // ~1.41421356237
const OCTILE_FACTOR = SQRT2 - 1.0; // ~0.41421356237

/**
 * Octile distance heuristic for 8-connected grid.
 */
function octileHeuristic(
  c1: number,
  r1: number,
  c2: number,
  r2: number,
  cellSize: number
): number {
  const dx = Math.abs(c1 - c2);
  const dz = Math.abs(r1 - r2);
  return cellSize * (Math.max(dx, dz) + OCTILE_FACTOR * Math.min(dx, dz));
}

/**
 * Verifies that a straight-line segment from p1 to p2 is collision-free at playerRadius,
 * sampled every sampleStepM (default 0.05 m).
 */
export function isSegmentCollisionFree(
  navGrid: NavGrid,
  p1: NavGridPoint,
  p2: NavGridPoint,
  playerRadius: number,
  sampleStepM = 0.05
): boolean {
  const dist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  if (dist < 1e-6) {
    return !isCircleBlocked(navGrid.rawOccupancy, p1.x, p1.z, playerRadius, false, false);
  }

  const steps = Math.max(1, Math.ceil(dist / sampleStepM));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const sx = p1.x + t * (p2.x - p1.x);
    const sz = p1.z + t * (p2.z - p1.z);
    if (isCircleBlocked(navGrid.rawOccupancy, sx, sz, playerRadius, false, false)) {
      return false;
    }
  }

  return true;
}

/**
 * Finds optimal shortest path from start to goal on the navigation grid,
 * smoothed via line-of-sight shortcutting (string pulling).
 */
export function findPath(
  grid: NavGrid,
  startPoint: NavGridPoint,
  goalPoint: NavGridPoint,
  opts?: FindPathOptions
): PathResult {
  const startTime = performance.now();

  const playerRadius = opts?.playerRadius ?? 0.08;
  const clearanceWeight = opts?.clearancePenaltyWeight ?? 0.25;
  const prefClearance = opts?.preferredClearanceM ?? 0.45;
  const sampleStepM = opts?.sampleStepM ?? 0.05;
  const snapStart = opts?.snapStart !== false;
  const snapGoal = opts?.snapGoal === true;

  // Validate / snap start
  let start = { x: startPoint.x, z: startPoint.z };
  if (!grid.isWalkable(start.x, start.z)) {
    if (!snapStart) {
      return { error: "start-blocked" };
    }
    const snapped = grid.snapToWalkable(start.x, start.z);
    if (!snapped) {
      return { error: "start-blocked" };
    }
    start = snapped;
  }

  // Validate / snap goal
  let goal = { x: goalPoint.x, z: goalPoint.z };
  const rawGoalCell = grid.worldToCell(goal.x, goal.z);
  const isGoalOutOfBounds = !grid.isValidCell(rawGoalCell.col, rawGoalCell.row);
  const rawGoalIdx = isGoalOutOfBounds ? -1 : rawGoalCell.row * grid.width + rawGoalCell.col;
  const isGoalObstacle =
    isGoalOutOfBounds ||
    (grid.rawOccupancy.state
      ? grid.rawOccupancy.state[rawGoalIdx] === 2 ||
        grid.rawOccupancy.state[rawGoalIdx] === 3 ||
        grid.rawOccupancy.state[rawGoalIdx] === 0
      : grid.rawOccupancy.data[rawGoalIdx] === 1);

  if (isGoalObstacle) {
    if (!snapGoal) {
      return { error: "goal-blocked" };
    }
    const snapped = grid.snapToWalkable(goal.x, goal.z);
    if (!snapped) {
      return { error: "goal-blocked" };
    }
    goal = snapped;
  } else if (!grid.isWalkable(goal.x, goal.z)) {
    // Goal is observed-free but not reachable from spawn/start component
    return { error: "unreachable" };
  }

  const startCell = grid.worldToCell(start.x, start.z);
  const goalCell = grid.worldToCell(goal.x, goal.z);

  // If start and goal are in the exact same cell
  if (startCell.col === goalCell.col && startCell.row === goalCell.row) {
    const directLen = Math.hypot(goal.x - start.x, goal.z - start.z);
    return {
      points: [start, goal],
      lengthM: directLen,
      computeMs: performance.now() - startTime,
      expandedNodes: 1,
    };
  }

  const width = grid.width;
  const height = grid.height;
  const cellSize = grid.cellSize;
  const totalCells = width * height;

  const gScore = new Float64Array(totalCells);
  gScore.fill(Infinity);
  const cameFrom = new Int32Array(totalCells);
  cameFrom.fill(-1);

  const startIdx = startCell.row * width + startCell.col;
  const goalIdx = goalCell.row * width + goalCell.col;

  gScore[startIdx] = 0.0;

  const heap = new AStarMinHeap();
  const startH = octileHeuristic(startCell.col, startCell.row, goalCell.col, goalCell.row, cellSize);
  heap.push(startCell.col, startCell.row, startH, 0.0);

  const diagCost = SQRT2 * cellSize;
  const cardCost = 1.0 * cellSize;

  let expandedNodes = 0;
  let reachedGoal = false;

  while (heap.size > 0) {
    const node = heap.pop()!;
    const { col: c, row: r, g } = node;
    const idx = r * width + c;

    if (c === goalCell.col && r === goalCell.row) {
      reachedGoal = true;
      break;
    }

    if (g > gScore[idx] + 1e-6) {
      continue;
    }

    expandedNodes++;

    // 8-connected neighbors
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue;

        const nc = c + dc;
        const nr = r + dr;

        if (nc < 0 || nc >= width || nr < 0 || nr >= height) continue;
        const nidx = nr * width + nc;
        if (grid.walkable[nidx] !== 1) continue;

        const npt = grid.cellToWorld(nc, nr);
        if (isCircleBlocked(grid.rawOccupancy, npt.x, npt.z, playerRadius, false, false)) {
          continue;
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

        const baseStep = dc !== 0 && dr !== 0 ? diagCost : cardCost;

        // Soft clearance penalty (keeps route centred in doorways/aisles away from walls)
        let penalty = 0.0;
        if (clearanceWeight > 0) {
          const cl = grid.clearance[nidx];
          if (cl < prefClearance) {
            const ratio = (prefClearance - cl) / prefClearance;
            penalty = clearanceWeight * ratio * ratio;
          }
        }

        const tentativeG = g + baseStep * (1.0 + penalty);

        if (tentativeG < gScore[nidx]) {
          gScore[nidx] = tentativeG;
          cameFrom[nidx] = idx;
          const h = octileHeuristic(nc, nr, goalCell.col, goalCell.row, cellSize);
          heap.push(nc, nr, tentativeG + h, tentativeG);
        }
      }
    }
  }

  if (!reachedGoal) {
    return { error: "unreachable" };
  }

  // Reconstruct raw cell path
  const rawCells: Array<{ col: number; row: number }> = [];
  let currIdx = goalIdx;
  while (currIdx !== -1) {
    const cr = Math.floor(currIdx / width);
    const cc = currIdx % width;
    rawCells.push({ col: cc, row: cr });
    if (currIdx === startIdx) break;
    currIdx = cameFrom[currIdx];
  }
  rawCells.reverse();

  // Convert to world waypoints
  const rawPoints: NavGridPoint[] = [];
  rawPoints.push(start);
  for (let i = 1; i < rawCells.length - 1; i++) {
    rawPoints.push(grid.cellToWorld(rawCells[i].col, rawCells[i].row));
  }
  rawPoints.push(goal);

  // Line-of-sight shortcutting (string pulling)
  const smoothed: NavGridPoint[] = [rawPoints[0]];
  let currentIdx = 0;

  while (currentIdx < rawPoints.length - 1) {
    let nextIdx = rawPoints.length - 1;
    while (nextIdx > currentIdx + 1) {
      if (
        isSegmentCollisionFree(
          grid,
          rawPoints[currentIdx],
          rawPoints[nextIdx],
          playerRadius,
          sampleStepM
        )
      ) {
        break;
      }
      nextIdx--;
    }
    smoothed.push(rawPoints[nextIdx]);
    currentIdx = nextIdx;
  }

  // Calculate final smoothed trajectory length
  let lengthM = 0;
  for (let i = 0; i < smoothed.length - 1; i++) {
    lengthM += Math.hypot(
      smoothed[i + 1].x - smoothed[i].x,
      smoothed[i + 1].z - smoothed[i].z
    );
  }

  const computeMs = performance.now() - startTime;

  return {
    points: smoothed,
    lengthM,
    computeMs,
    expandedNodes,
  };
}
