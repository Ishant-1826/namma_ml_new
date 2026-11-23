/**
 * spatial_index.ts
 * Spatial indexing for POIs using a 2D uniform grid spatial hash.
 * Includes point-in-zone hit tests for circles, oriented rectangles, and arbitrary polygons.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { POI } from "./poi_types";

/**
 * Circle hit test: returns true if point (px, pz) lies within circle at (cx, cz) with radius.
 */
export function isPointInCircle(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  radius: number
): boolean {
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz <= radius * radius + 1e-9;
}

/**
 * Oriented rectangle hit test: returns true if point (px, pz) lies within rectangle
 * centered at (cx, cz), with dimensions (width x depth) rotated by yaw radians.
 */
export function isPointInRect(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  width: number,
  depth: number,
  yaw: number
): boolean {
  const dx = px - cx;
  const dz = pz - cz;

  // Rotate point into rectangle's local coordinate frame (by -yaw)
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);

  const localX = dx * cosY + dz * sinY;
  const localZ = -dx * sinY + dz * cosY;

  const halfW = width * 0.5 + 1e-9;
  const halfD = depth * 0.5 + 1e-9;

  return Math.abs(localX) <= halfW && Math.abs(localZ) <= halfD;
}

/**
 * Point-in-polygon hit test: returns true if point (px, pz) is inside the polygon.
 * Implements the standard ray casting crossing number algorithm.
 */
export function isPointInPolygon(
  px: number,
  pz: number,
  points: Array<{ x: number; z: number }>
): boolean {
  const n = points.length;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i].x;
    const zi = points[i].z;
    const xj = points[j].x;
    const zj = points[j].z;

    // Check vertex collision exactly
    if (Math.abs(xi - px) < 1e-9 && Math.abs(zi - pz) < 1e-9) {
      return true;
    }

    const intersect =
      zi > pz !== zj > pz && px <= ((xj - xi) * (pz - zi)) / (zj - zi) + xi + 1e-9;
    if (intersect) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Tests whether a point (px, pz) hits a POI's zone.
 * If the POI has no zone, checks if the point is within pinRadius of poi.position.
 */
export function isPointInZone(
  px: number,
  pz: number,
  poi: POI,
  pinRadius = 0.30
): boolean {
  if (!poi.zone) {
    return isPointInCircle(px, pz, poi.position.x, poi.position.z, pinRadius);
  }

  switch (poi.zone.type) {
    case "circle":
      return isPointInCircle(px, pz, poi.position.x, poi.position.z, poi.zone.radius);
    case "rect":
      return isPointInRect(
        px,
        pz,
        poi.position.x,
        poi.position.z,
        poi.zone.width,
        poi.zone.depth,
        poi.zone.yaw
      );
    case "polygon":
      return isPointInPolygon(px, pz, poi.zone.points);
  }
}

export interface NearestResult extends POI {
  poi: POI;
  distance: number;
}

/**
 * 2D Uniform Grid Spatial Hash for fast spatial querying.
 */
export class SpatialIndex {
  readonly cellSize: number;
  private readonly grid = new Map<string, POI[]>();
  private readonly pois: POI[];

  constructor(pois: POI[], cellSize = 1.0) {
    this.cellSize = cellSize > 0 ? cellSize : 1.0;
    this.pois = pois;
    this.buildIndex();
  }

  private cellKey(col: number, row: number): string {
    return `${col},${row}`;
  }

  private buildIndex(): void {
    const cs = this.cellSize;

    for (const poi of this.pois) {
      // Calculate axis-aligned bounding box of the POI (pin or zone)
      let minX = poi.position.x;
      let maxX = poi.position.x;
      let minZ = poi.position.z;
      let maxZ = poi.position.z;

      if (!poi.zone) {
        const pinR = 0.30;
        minX -= pinR;
        maxX += pinR;
        minZ -= pinR;
        maxZ += pinR;
      } else if (poi.zone.type === "circle") {
        const r = poi.zone.radius;
        minX -= r;
        maxX += r;
        minZ -= r;
        maxZ += r;
      } else if (poi.zone.type === "rect") {
        const hw = poi.zone.width * 0.5;
        const hd = poi.zone.depth * 0.5;
        const cosY = Math.abs(Math.cos(poi.zone.yaw));
        const sinY = Math.abs(Math.sin(poi.zone.yaw));
        const bbHalfX = hw * cosY + hd * sinY;
        const bbHalfZ = hw * sinY + hd * cosY;
        minX = poi.position.x - bbHalfX;
        maxX = poi.position.x + bbHalfX;
        minZ = poi.position.z - bbHalfZ;
        maxZ = poi.position.z + bbHalfZ;
      } else if (poi.zone.type === "polygon") {
        for (const pt of poi.zone.points) {
          if (pt.x < minX) minX = pt.x;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.z < minZ) minZ = pt.z;
          if (pt.z > maxZ) maxZ = pt.z;
        }
      }

      const minCol = Math.floor(minX / cs);
      const maxCol = Math.floor(maxX / cs);
      const minRow = Math.floor(minZ / cs);
      const maxRow = Math.floor(maxZ / cs);

      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const key = this.cellKey(c, r);
          let cellList = this.grid.get(key);
          if (!cellList) {
            cellList = [];
            this.grid.set(key, cellList);
          }
          cellList.push(poi);
        }
      }
    }
  }

  /**
   * Queries all POIs whose zone contains the point (x, z),
   * or whose pin is within pinRadius (default 0.3 m).
   */
  queryPoint(x: number, z: number, pinRadius = 0.30): POI[] {
    const col = Math.floor(x / this.cellSize);
    const row = Math.floor(z / this.cellSize);
    const candidates = this.grid.get(this.cellKey(col, row));
    if (!candidates || candidates.length === 0) {
      return [];
    }

    const matched: POI[] = [];
    const seen = new Set<string>();

    for (const poi of candidates) {
      if (seen.has(poi.id)) continue;
      seen.add(poi.id);

      if (isPointInZone(x, z, poi, pinRadius)) {
        matched.push(poi);
      }
    }

    return matched;
  }

  /**
   * Finds the k nearest POIs to (x, z) sorted by distance to anchor.
   * Matches brute-force search exactly.
   */
  nearest(x: number, z: number, k = 1): NearestResult[] {
    if (k <= 0 || this.pois.length === 0) {
      return [];
    }

    const scored: NearestResult[] = [];
    for (let i = 0; i < this.pois.length; i++) {
      const p = this.pois[i];
      const dist = Math.hypot(p.anchor.x - x, p.anchor.z - z);
      scored.push({ ...p, poi: p, distance: dist });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, Math.min(k, scored.length));
  }

  /**
   * Finds all POIs within radius r of (x, z) sorted by distance ascending.
   * Matches brute-force search exactly.
   */
  withinRadius(x: number, z: number, radius: number): NearestResult[] {
    if (radius < 0 || this.pois.length === 0) {
      return [];
    }

    const results: NearestResult[] = [];
    const rSq = radius * radius;

    for (let i = 0; i < this.pois.length; i++) {
      const p = this.pois[i];
      const dx = p.anchor.x - x;
      const dz = p.anchor.z - z;
      const dSq = dx * dx + dz * dz;
      if (dSq <= rSq + 1e-9) {
        results.push({ ...p, poi: p, distance: Math.sqrt(dSq) });
      }
    }

    results.sort((a, b) => a.distance - b.distance);
    return results;
  }
}
