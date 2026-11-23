/**
 * navgrid.ts
 * Navigation grid abstraction over 2D occupancy data.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { OccupancyGrid, worldToCell } from "../collision";

export interface NavGridPoint {
  x: number;
  z: number;
}

export interface NavGridCell {
  col: number;
  row: number;
}

/**
 * 1D Euclidean Distance Transform (Felzenszwalb & Huttenlocher).
 * Computes min_y ((x - y)^2 + f(y)) in O(N) time.
 */
function edt1d(f: Float64Array, n: number, dOut: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  z[0] = -1e20;
  z[1] = 1e20;
  let k = 0;

  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = 1e20;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const diff = q - v[k];
    dOut[q] = diff * diff + f[v[k]];
  }
}

/**
 * 2D Euclidean Distance Transform with 1-cell blocked boundary padding.
 * Returns Euclidean distance in metres to the nearest blocked cell (f == 0).
 */
export function compute2DClearance(
  isFreeCell: (col: number, row: number) => boolean,
  width: number,
  height: number,
  cellSize: number
): Float32Array {
  const clearance = new Float32Array(width * height);
  const pw = width + 2;
  const ph = height + 2;

  // Padded grid with blocked border (border has f = 0.0)
  const paddedF = new Float64Array(pw * ph);
  for (let r = 0; r < ph; r++) {
    for (let c = 0; c < pw; c++) {
      if (r === 0 || r === ph - 1 || c === 0 || c === pw - 1) {
        paddedF[r * pw + c] = 0.0; // border is blocked
      } else {
        paddedF[r * pw + c] = isFreeCell(c - 1, r - 1) ? 1e9 : 0.0;
      }
    }
  }

  // Column-wise pass
  const colF = new Float64Array(ph);
  const colD = new Float64Array(ph);
  const d1 = new Float64Array(pw * ph);

  for (let c = 0; c < pw; c++) {
    for (let r = 0; r < ph; r++) {
      colF[r] = paddedF[r * pw + c];
    }
    edt1d(colF, ph, colD);
    for (let r = 0; r < ph; r++) {
      d1[r * pw + c] = colD[r];
    }
  }

  // Row-wise pass
  const rowF = new Float64Array(pw);
  const rowD = new Float64Array(pw);
  const d2 = new Float64Array(pw * ph);

  for (let r = 0; r < ph; r++) {
    const rowOffset = r * pw;
    for (let c = 0; c < pw; c++) {
      rowF[c] = d1[rowOffset + c];
    }
    edt1d(rowF, pw, rowD);
    for (let c = 0; c < pw; c++) {
      d2[rowOffset + c] = rowD[c];
    }
  }

  // Extract interior unpadded cells
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      clearance[r * width + c] = Math.sqrt(d2[(r + 1) * pw + (c + 1)]) * cellSize;
    }
  }

  return clearance;
}

export class NavGrid {
  readonly origin: [number, number];
  readonly cellSize: number;
  readonly width: number;
  readonly height: number;
  readonly rawOccupancy: OccupancyGrid;
  readonly walkable: Uint8Array;
  readonly clearance: Float32Array;
  readonly walkableCount: number;
  readonly maxClearance: number;
  readonly spawnCol: number;
  readonly spawnRow: number;

  constructor(
    occupancy: OccupancyGrid,
    spawn?: [number, number] | [number, number, number]
  ) {
    this.rawOccupancy = occupancy;
    this.origin = [occupancy.origin[0], occupancy.origin[1]];
    this.cellSize = occupancy.cell_size;
    this.width = occupancy.width;
    this.height = occupancy.height;

    // Resolve spawn cell
    let sCol = 0;
    let sRow = 0;
    if (spawn) {
      const sx = spawn[0];
      const sz = spawn.length === 3 ? spawn[2] : spawn[1];
      sCol = Math.floor((sx - this.origin[0]) / this.cellSize);
      sRow = Math.floor((sz - this.origin[1]) / this.cellSize);
    } else {
      // Default to center
      sCol = Math.floor(this.width / 2);
      sRow = Math.floor(this.height / 2);
    }
    this.spawnCol = sCol;
    this.spawnRow = sRow;

    // Determine observed-free predicate
    const isFree = (c: number, r: number): boolean => {
      if (c < 0 || c >= this.width || r < 0 || r >= this.height) return false;
      const idx = r * this.width + c;
      if (occupancy.state) {
        return occupancy.state[idx] === 1; // Free
      }
      return occupancy.data[idx] === 0;
    };

    // Precompute clearance field (metres to nearest blocked cell)
    // If occupancy.clearance_m is already present and matches dimensions, we can use it,
    // otherwise compute exact 2D EDT.
    const precomputed = (occupancy as { clearance_m?: number[] }).clearance_m;
    if (precomputed && precomputed.length === this.width * this.height) {
      this.clearance = new Float32Array(precomputed);
    } else {
      this.clearance = compute2DClearance(isFree, this.width, this.height, this.cellSize);
    }

    // Determine walkable cells: observed-free AND connected to spawn
    this.walkable = new Uint8Array(this.width * this.height);
    if (occupancy.walkable) {
      // Reuse pre-computed flood-fill region from occupancy
      for (let i = 0; i < occupancy.walkable.length; i++) {
        this.walkable[i] = occupancy.walkable[i] ? 1 : 0;
      }
    } else {
      // Run 4-connected BFS flood-fill from spawn on observed-free cells
      if (isFree(sCol, sRow)) {
        const queue: Array<[number, number]> = [[sCol, sRow]];
        this.walkable[sRow * this.width + sCol] = 1;
        while (queue.length > 0) {
          const [c, r] = queue.shift()!;
          const neighbors: Array<[number, number]> = [
            [c + 1, r],
            [c - 1, r],
            [c, r + 1],
            [c, r - 1],
          ];
          for (const [nc, nr] of neighbors) {
            if (nc >= 0 && nc < this.width && nr >= 0 && nr < this.height) {
              const nidx = nr * this.width + nc;
              if (this.walkable[nidx] === 0 && isFree(nc, nr)) {
                this.walkable[nidx] = 1;
                queue.push([nc, nr]);
              }
            }
          }
        }
      }
    }

    // Compute walkable count and max clearance
    let count = 0;
    let maxCl = 0;
    for (let i = 0; i < this.walkable.length; i++) {
      if (this.walkable[i] === 1) {
        count++;
        if (this.clearance[i] > maxCl) {
          maxCl = this.clearance[i];
        }
      }
    }
    this.walkableCount = count;
    this.maxClearance = maxCl;
  }

  worldToCell(x: number, z: number): NavGridCell {
    return {
      col: Math.floor((x - this.origin[0]) / this.cellSize),
      row: Math.floor((z - this.origin[1]) / this.cellSize),
    };
  }

  cellToWorld(col: number, row: number): NavGridPoint {
    return {
      x: this.origin[0] + (col + 0.5) * this.cellSize,
      z: this.origin[1] + (row + 0.5) * this.cellSize,
    };
  }

  isValidCell(col: number, row: number): boolean {
    return col >= 0 && col < this.width && row >= 0 && row < this.height;
  }

  isCellWalkable(col: number, row: number): boolean {
    return this.isValidCell(col, row) && this.walkable[row * this.width + col] === 1;
  }

  isWalkable(x: number, z: number): boolean {
    const { col, row } = this.worldToCell(x, z);
    return this.isCellWalkable(col, row);
  }

  getCellClearance(col: number, row: number): number {
    if (!this.isValidCell(col, row)) return 0;
    return this.clearance[row * this.width + col];
  }

  getClearance(x: number, z: number): number {
    const { col, row } = this.worldToCell(x, z);
    return this.getCellClearance(col, row);
  }

  /**
   * Snaps a world position (x, z) to the nearest walkable cell center via BFS / radial search.
   * Returns null if no walkable cell is within maxDistM (default 1.5 m).
   */
  snapToWalkable(x: number, z: number, maxDistM = 1.5): NavGridPoint | null {
    if (this.isWalkable(x, z)) {
      return { x, z };
    }

    const minX = this.origin[0];
    const maxX = this.origin[0] + this.width * this.cellSize;
    const minZ = this.origin[1];
    const maxZ = this.origin[1] + this.height * this.cellSize;

    // Check distance to bounding box
    const closestBoxX = Math.max(minX, Math.min(maxX, x));
    const closestBoxZ = Math.max(minZ, Math.min(maxZ, z));
    const boxDist = Math.hypot(x - closestBoxX, z - closestBoxZ);
    if (boxDist > maxDistM) {
      return null;
    }

    const centerCol = Math.floor((closestBoxX - minX) / this.cellSize);
    const centerRow = Math.floor((closestBoxZ - minZ) / this.cellSize);
    const cellRadius = Math.ceil(maxDistM / this.cellSize);

    let bestPoint: NavGridPoint | null = null;
    let bestDist = Infinity;

    const minC = Math.max(0, centerCol - cellRadius);
    const maxC = Math.min(this.width - 1, centerCol + cellRadius);
    const minR = Math.max(0, centerRow - cellRadius);
    const maxR = Math.min(this.height - 1, centerRow + cellRadius);

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (this.walkable[r * this.width + c] === 1) {
          const pt = this.cellToWorld(c, r);
          const dist = Math.hypot(x - pt.x, z - pt.z);
          if (dist <= maxDistM && dist < bestDist) {
            bestDist = dist;
            bestPoint = pt;
          }
        }
      }
    }

    return bestPoint;
  }
}
