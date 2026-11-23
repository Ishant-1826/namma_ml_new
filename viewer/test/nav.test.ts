import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { OccupancyGrid, isCircleBlocked, isBlocked } from "../src/collision";
import { NavGrid } from "../src/nav/navgrid";
import { findPath } from "../src/nav/pathfinder";
import { dijkstraFrom } from "../src/nav/distanceField";

/**
 * Creates a synthetic grid for navigation testing.
 * Origin [0, 0], cellSize = 0.1 m.
 */
function createTestGrid(
  width: number,
  height: number,
  blockedCells: Array<[number, number]> = [],
  spawn?: [number, number]
): NavGrid {
  const data = new Uint8Array(width * height);
  for (const [col, row] of blockedCells) {
    if (col >= 0 && col < width && row >= 0 && row < height) {
      data[row * width + col] = 1;
    }
  }

  const occ: OccupancyGrid = {
    origin: [0, 0],
    cell_size: 0.1,
    width,
    height,
    data,
  };

  return new NavGrid(occ, spawn ?? [0.05, 0.05]);
}

describe("Phase 1 Navigation Core (Pure TypeScript)", () => {
  describe("1. Synthetic Map Tests", () => {
    it("open room: finds straight-line smoothed path between distant points", () => {
      // 10x10 open room (1.0m x 1.0m)
      const grid = createTestGrid(10, 10, [], [0.05, 0.05]);

      const start = { x: 0.15, z: 0.15 };
      const goal = { x: 0.85, z: 0.85 };

      const res = findPath(grid, start, goal);
      expect("points" in res).toBe(true);
      if (!("points" in res)) return;

      // Smoothed path in an open room should be a direct shortcut (2 points: start, goal)
      expect(res.points.length).toBe(2);
      expect(res.points[0]).toEqual(start);
      expect(res.points[1]).toEqual(goal);

      const straightDist = Math.hypot(goal.x - start.x, goal.z - start.z);
      expect(res.lengthM).toBeCloseTo(straightDist, 4);
      expect(res.expandedNodes).toBeGreaterThan(0);
    });

    it("wall with a 0.8 m door: path must route through the door without tunneling", () => {
      // 15x15 grid (1.5m x 1.5m)
      // Wall along col 7 (x = 0.7 to 0.8) for all rows EXCEPT a 0.8 m door at rows 3..10
      const blocked: Array<[number, number]> = [];
      for (let r = 0; r < 15; r++) {
        // Door is at rows 4..11 (8 cells = 0.8 m opening)
        if (r < 4 || r > 11) {
          blocked.push([7, r]);
        }
      }
      const grid = createTestGrid(15, 15, blocked, [0.25, 0.75]);

      const start = { x: 0.25, z: 0.15 }; // left side, aligned with a wall section
      const goal = { x: 1.25, z: 0.15 }; // right side, aligned with wall section

      const res = findPath(grid, start, goal);
      expect("points" in res).toBe(true);
      if (!("points" in res)) return;

      // The straight-line path would cross (col 7, row 1) which is a solid wall.
      // The path must deviate to pass through the door (row >= 4).
      let crossedThroughDoor = false;
      for (let i = 0; i < res.points.length - 1; i++) {
        const p1 = res.points[i];
        const p2 = res.points[i + 1];
        const d = Math.hypot(p2.x - p1.x, p2.z - p1.z);
        const steps = Math.max(1, Math.ceil(d / 0.05));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const sx = p1.x + t * (p2.x - p1.x);
          const sz = p1.z + t * (p2.z - p1.z);
          if (sx >= 0.65 && sx <= 0.85 && sz >= 0.40 && sz <= 1.20) {
            crossedThroughDoor = true;
          }
        }
      }
      expect(crossedThroughDoor).toBe(true);

      // Verify no sample collides with the wall
      for (let i = 0; i < res.points.length - 1; i++) {
        const p1 = res.points[i];
        const p2 = res.points[i + 1];
        const d = Math.hypot(p2.x - p1.x, p2.z - p1.z);
        const steps = Math.max(1, Math.ceil(d / 0.05));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const sx = p1.x + t * (p2.x - p1.x);
          const sz = p1.z + t * (p2.z - p1.z);
          expect(isCircleBlocked(grid.rawOccupancy, sx, sz, 0.04)).toBe(false);
        }
      }
    });

    it("U-shaped trap: navigates around concave obstacle without getting stuck", () => {
      // 20x20 grid (2.0m x 2.0m)
      // U-trap opening towards +X:
      // Vertical back wall at col 5, rows 5..15
      // Horizontal top wall at cols 5..14, row 5
      // Horizontal bottom wall at cols 5..14, row 15
      const blocked: Array<[number, number]> = [];
      for (let r = 5; r <= 15; r++) blocked.push([5, r]);
      for (let c = 5; c <= 14; c++) blocked.push([c, 5]);
      for (let c = 5; c <= 14; c++) blocked.push([c, 15]);

      const grid = createTestGrid(20, 20, blocked, [0.85, 1.05]);

      // Start inside the pocket of the U-trap
      const start = { x: 0.85, z: 1.05 }; // col 8, row 10 (inside U)
      // Goal outside behind the trap wall
      const goal = { x: 0.25, z: 1.05 }; // col 2, row 10 (outside U behind back wall)

      const res = findPath(grid, start, goal);
      expect("points" in res).toBe(true);
      if (!("points" in res)) return;

      // Path must exit the trap to the right (x > 1.40) before turning around
      const maxPathX = Math.max(...res.points.map((p) => p.x));
      expect(maxPathX).toBeGreaterThanOrEqual(1.40);
      expect(res.points[res.points.length - 1]).toEqual(goal);
    });

    it("unreachable goal: returns error 'unreachable'", () => {
      // Solid dividing wall at col 7 across all rows
      const blocked: Array<[number, number]> = [];
      for (let r = 0; r < 10; r++) blocked.push([5, r]);

      const grid = createTestGrid(10, 10, blocked, [0.25, 0.55]);

      const start = { x: 0.25, z: 0.55 }; // left side
      const goal = { x: 0.85, z: 0.55 }; // right side

      const res = findPath(grid, start, goal);
      expect("error" in res).toBe(true);
      if ("error" in res) {
        expect(res.error).toBe("unreachable");
      }
    });

    it("start inside an obstacle gets snapped: snaps to nearest walkable cell", () => {
      // Wall at col 5 for all rows
      const blocked: Array<[number, number]> = [];
      for (let r = 0; r < 10; r++) blocked.push([5, r]);
      const grid = createTestGrid(10, 10, blocked, [0.25, 0.55]);

      // Start right inside the wall at x = 0.55 (col 5)
      const startInWall = { x: 0.55, z: 0.55 };
      const goal = { x: 0.15, z: 0.55 };

      // findPath should auto-snap start to nearest walkable cell (col 4 or col 6)
      const res = findPath(grid, startInWall, goal, { snapStart: true });
      expect("points" in res).toBe(true);
      if (!("points" in res)) return;

      expect(res.points.length).toBeGreaterThanOrEqual(2);
      expect(grid.isWalkable(res.points[0].x, res.points[0].z)).toBe(true);
      expect(res.points[res.points.length - 1]).toEqual(goal);
    });

    it("narrow aisle: path navigates smoothly along a confined corridor", () => {
      // Corridor between row 4 and row 6: rows 0..3 and 7..10 are blocked
      const blocked: Array<[number, number]> = [];
      for (let c = 0; c < 15; c++) {
        for (let r = 0; r <= 3; r++) blocked.push([c, r]);
        for (let r = 7; r <= 10; r++) blocked.push([c, r]);
      }
      const grid = createTestGrid(15, 11, blocked, [0.15, 0.55]);

      const start = { x: 0.15, z: 0.55 };
      const goal = { x: 1.35, z: 0.55 };

      const res = findPath(grid, start, goal);
      expect("points" in res).toBe(true);
      if (!("points" in res)) return;

      expect(res.lengthM).toBeCloseTo(1.20, 2);
      for (const p of res.points) {
        expect(p.z).toBeGreaterThanOrEqual(0.40);
        expect(p.z).toBeLessThanOrEqual(0.70);
      }
    });

    it("distanceField: dijkstraFrom accurately computes walking distance map", () => {
      // 5x5 open grid
      const grid = createTestGrid(5, 5, [], [0.05, 0.05]);
      const dists = dijkstraFrom(grid, { col: 0, row: 0 });

      expect(dists[0]).toBe(0.0);
      // Cardinal 1 cell: 0.10 m
      expect(dists[1]).toBeCloseTo(0.10, 5);
      // Diagonal 1 cell: 0.1414 m
      expect(dists[5 + 1]).toBeCloseTo(0.141421356, 5);
      // Farthest corner (col 4, row 4): 4 diagonals = 4 * 0.141421356 = 0.5657 m
      expect(dists[4 * 5 + 4]).toBeCloseTo(4 * 0.141421356, 4);
    });
  });

  describe("2. Real Map Tests (occupancy.json)", () => {
    const occPath = path.resolve(__dirname, "../public/scene/occupancy.json");
    const rawData = JSON.parse(fs.readFileSync(occPath, "utf-8"));
    const realGrid = new NavGrid(rawData);

    it("asserts that the spawn cell is walkable", () => {
      // Spawn from scene.json: [1.771, 1.45, 3.523]
      const spawnX = 1.771;
      const spawnZ = 3.523;
      expect(realGrid.isWalkable(spawnX, spawnZ)).toBe(true);
      const spawnCell = realGrid.worldToCell(spawnX, spawnZ);
      expect(spawnCell.col).toBe(76);
      expect(spawnCell.row).toBe(82);
      expect(realGrid.isCellWalkable(76, 82)).toBe(true);
    });

    it("asserts that snapToWalkable returns null for a point far outside the grid", () => {
      const farPoint = realGrid.snapToWalkable(100.0, 100.0, 1.5);
      expect(farPoint).toBeNull();

      const farPoint2 = realGrid.snapToWalkable(-50.0, -50.0, 1.5);
      expect(farPoint2).toBeNull();
    });

    it("matches exact walkable cell count and clearance from ROUND2_PLAN.md", () => {
      expect(realGrid.walkableCount).toBe(2195);
      expect(realGrid.maxClearance).toBeCloseTo(0.85, 2);
    });

    it("200 random walkable pairs: 0 collision samples, length >= straight-line and <= 1.10x Dijkstra optimum", () => {
      // Collect walkable cell coordinates that are valid navigable centers
      const walkableCoords: Array<{ col: number; row: number }> = [];
      const width = realGrid.width;
      const height = realGrid.height;

      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          if (realGrid.walkable[r * width + c] === 1) {
            const pt = realGrid.cellToWorld(c, r);
            if (!isCircleBlocked(realGrid.rawOccupancy, pt.x, pt.z, 0.08, false, false)) {
              walkableCoords.push({ col: c, row: r });
            }
          }
        }
      }

      expect(walkableCoords.length).toBeGreaterThan(1000);

      // Deterministic pseudo-random number generator (LCG) for reproducible testing
      let seed = 42;
      function pseudoRandom(): number {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      }

      let totalCollisions = 0;
      let maxRatioVsDijkstra = 0;
      let minRatioVsStraight = Infinity;

      const numPairs = 200;
      for (let i = 0; i < numPairs; i++) {
        const idx1 = Math.floor(pseudoRandom() * walkableCoords.length);
        let idx2 = Math.floor(pseudoRandom() * walkableCoords.length);
        if (idx2 === idx1) {
          idx2 = (idx1 + 1) % walkableCoords.length;
        }

        const c1 = walkableCoords[idx1];
        const c2 = walkableCoords[idx2];
        const start = realGrid.cellToWorld(c1.col, c1.row);
        const goal = realGrid.cellToWorld(c2.col, c2.row);

        // Ground-truth 8-connected grid Dijkstra optimum
        const distField = dijkstraFrom(realGrid, start, 0.08);
        const optDijkstraDist = distField[c2.row * width + c2.col];

        if (!isFinite(optDijkstraDist)) {
          // Skip if disconnected
          continue;
        }

        const res = findPath(realGrid, start, goal, { playerRadius: 0.08 });
        expect("points" in res).toBe(true);
        if (!("points" in res)) continue;

        const straightDist = Math.hypot(goal.x - start.x, goal.z - start.z);
        expect(res.lengthM).toBeGreaterThanOrEqual(straightDist - 1e-4);

        const ratioVsDijkstra = res.lengthM / optDijkstraDist;
        if (ratioVsDijkstra > maxRatioVsDijkstra) {
          maxRatioVsDijkstra = ratioVsDijkstra;
        }

        const ratioVsStraight = res.lengthM / (straightDist || 1e-6);
        if (ratioVsStraight < minRatioVsStraight) {
          minRatioVsStraight = ratioVsStraight;
        }

        expect(ratioVsDijkstra).toBeLessThanOrEqual(1.10);

        // Verify every shortcut sampled every 5 cm has 0 collisions
        for (let k = 0; k < res.points.length - 1; k++) {
          const p1 = res.points[k];
          const p2 = res.points[k + 1];
          const segDist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
          const steps = Math.max(1, Math.ceil(segDist / 0.05));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const sx = p1.x + t * (p2.x - p1.x);
            const sz = p1.z + t * (p2.z - p1.z);
            if (isCircleBlocked(realGrid.rawOccupancy, sx, sz, 0.08, false, false)) {
              totalCollisions++;
            }
          }
        }
      }

      expect(totalCollisions).toBe(0);
      expect(maxRatioVsDijkstra).toBeLessThanOrEqual(1.10);
      expect(minRatioVsStraight).toBeGreaterThanOrEqual(1.0 - 1e-4);
    });
  });

  describe("3. Narrow Corridor Routing (ROUND2_PLAN.md)", () => {
    const occPath = path.resolve(__dirname, "../public/scene/occupancy.json");
    const rawData = JSON.parse(fs.readFileSync(occPath, "utf-8"));
    const realGrid = new NavGrid(rawData);

    const corridors = [
      {
        name: "Corridor 1 [2.95, 4.95]",
        pos: { x: 2.95, z: 4.95 },
        sideA: { x: 2.95, z: 4.55 },
        sideB: { x: 2.75, z: 5.05 },
        passableWidthM: 0.40,
      },
      {
        name: "Corridor 2 [1.75, -0.25]",
        pos: { x: 1.75, z: -0.25 },
        sideA: { x: 1.75, z: -0.65 },
        sideB: { x: 1.75, z: 0.15 },
        passableWidthM: 0.40,
      },
      {
        name: "Corridor 3 [-1.25, -0.25]",
        pos: { x: -1.25, z: -0.25 },
        sideA: { x: -1.25, z: -0.65 },
        sideB: { x: -1.25, z: 0.15 },
        passableWidthM: 0.40,
      },
    ];

    for (const c of corridors) {
      it(`verifies ${c.name} corridor cell is walkable and routes across sides with 0 collision samples at 5 cm`, () => {
        // Assert corridor cell itself is on the walkable region
        const isCorridorWalkable = realGrid.isWalkable(c.pos.x, c.pos.z);
        expect(isCorridorWalkable).toBe(true);

        // Assert both sides are on the walkable region
        expect(realGrid.isWalkable(c.sideA.x, c.sideA.z)).toBe(true);
        expect(realGrid.isWalkable(c.sideB.x, c.sideB.z)).toBe(true);

        // Find path across the corridor
        const res = findPath(realGrid, c.sideA, c.sideB, { playerRadius: 0.08 });
        expect("points" in res).toBe(true);
        if (!("points" in res)) return;

        expect(res.points.length).toBeGreaterThanOrEqual(2);

        // Sample every segment at 5 cm intervals
        let collisions = 0;
        for (let k = 0; k < res.points.length - 1; k++) {
          const p1 = res.points[k];
          const p2 = res.points[k + 1];
          const segDist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
          const steps = Math.max(1, Math.ceil(segDist / 0.05));
          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const sx = p1.x + t * (p2.x - p1.x);
            const sz = p1.z + t * (p2.z - p1.z);
            if (isCircleBlocked(realGrid.rawOccupancy, sx, sz, 0.08, false, false)) {
              collisions++;
            }
          }
        }

        expect(collisions).toBe(0);
      });
    }
  });
});
