/**
 * loader.ts
 * Loads, parses, and validates POI datasets against a NavGrid.
 * Computes walkable anchor positions, validates bounds, and detects malformed definitions.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

import { NavGrid } from "../nav/navgrid";
import { POI, POIZone, POISceneFile, RawPOI } from "./poi_types";

export interface LoadPOIsResult {
  pois: POI[];
  errors: string[];
  warnings: string[];
}

export interface LoadPOIsOptions {
  maxSnapDistM?: number; // Maximum radius to search for walkable anchor (default 5.0 m)
  warnSnapThresholdM?: number; // Threshold to warn about large anchor displacement (default 1.0 m)
}

/**
 * Validates whether a value is a valid finite number.
 */
function isFiniteNumber(val: unknown): val is number {
  return typeof val === "number" && !isNaN(val) && isFinite(val);
}

/**
 * Parses and validates an optional zone definition.
 * Returns normalized POIZone or error message.
 */
function parseZone(rawZone: unknown, id: string): { zone?: POIZone; error?: string } {
  if (!rawZone || typeof rawZone !== "object") {
    return { error: `POI [${id}] has malformed zone: expected object` };
  }

  const z = rawZone as Record<string, unknown>;

  // 1. Circle zone
  if (z.type === "circle" || ("radius" in z && !("points" in z) && !("width" in z) && !("w" in z))) {
    const radius = z.radius;
    if (!isFiniteNumber(radius) || radius <= 0) {
      return { error: `POI [${id}] has malformed circle zone: radius must be a positive finite number, got ${radius}` };
    }
    return { zone: { type: "circle", radius } };
  }

  // 2. Rect zone
  if (z.type === "rect" || ("width" in z || "w" in z || "depth" in z || "d" in z)) {
    const w = z.width !== undefined ? z.width : z.w;
    const d = z.depth !== undefined ? z.depth : z.d;
    const yaw = z.yaw !== undefined ? z.yaw : 0;

    if (!isFiniteNumber(w) || w <= 0) {
      return { error: `POI [${id}] has malformed rect zone: width must be a positive finite number, got ${w}` };
    }
    if (!isFiniteNumber(d) || d <= 0) {
      return { error: `POI [${id}] has malformed rect zone: depth must be a positive finite number, got ${d}` };
    }
    if (!isFiniteNumber(yaw)) {
      return { error: `POI [${id}] has malformed rect zone: yaw must be a finite number, got ${yaw}` };
    }
    return { zone: { type: "rect", width: w, depth: d, yaw } };
  }

  // 3. Polygon zone
  if (z.type === "polygon" || Array.isArray(z.points)) {
    const pts = z.points;
    if (!Array.isArray(pts) || pts.length < 3) {
      return { error: `POI [${id}] has malformed polygon zone: points array must contain at least 3 vertices` };
    }
    const validatedPoints: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p || typeof p !== "object" || !isFiniteNumber(p.x) || !isFiniteNumber(p.z)) {
        return { error: `POI [${id}] has malformed polygon zone: vertex at index ${i} is not a finite {x, z} coordinate` };
      }
      validatedPoints.push({ x: p.x, z: p.z });
    }
    return { zone: { type: "polygon", points: validatedPoints } };
  }

  return { error: `POI [${id}] has malformed zone: unrecognized zone specification` };
}

/**
 * Loads, validates, and anchors POIs against a navigation grid.
 */
export function loadPOIs(
  input: POISceneFile | RawPOI[] | unknown,
  grid: NavGrid,
  opts?: LoadPOIsOptions
): LoadPOIsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const pois: POI[] = [];

  const maxSnapDistM = opts?.maxSnapDistM ?? 5.0;
  const warnSnapThresholdM = opts?.warnSnapThresholdM ?? 1.0;

  let rawList: unknown[] = [];
  if (input && typeof input === "object") {
    if (Array.isArray(input)) {
      rawList = input;
    } else if ("pois" in input && Array.isArray((input as POISceneFile).pois)) {
      rawList = (input as POISceneFile).pois;
    } else {
      errors.push("Invalid POI input: expected array or object containing 'pois' array");
      return { pois, errors, warnings };
    }
  } else {
    errors.push("Invalid POI input: expected object or array");
    return { pois, errors, warnings };
  }

  const seenIds = new Set<string>();

  // Grid world boundary coordinates
  const minGridX = grid.origin[0];
  const maxGridX = grid.origin[0] + grid.width * grid.cellSize;
  const minGridZ = grid.origin[1];
  const maxGridZ = grid.origin[1] + grid.height * grid.cellSize;

  for (let idx = 0; idx < rawList.length; idx++) {
    const raw = rawList[idx];
    if (!raw || typeof raw !== "object") {
      errors.push(`POI at index ${idx} is not an object`);
      continue;
    }

    const r = raw as Record<string, unknown>;

    // 1. ID check & duplicate detection
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id) {
      errors.push(`POI at index ${idx} has missing or empty id`);
      continue;
    }

    if (seenIds.has(id)) {
      errors.push(`Duplicate POI id: "${id}"`);
      continue;
    }
    seenIds.add(id);

    // 2. Name check
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name) {
      errors.push(`POI [${id}] has missing or empty name`);
      continue;
    }

    // 3. Category
    const category = typeof r.category === "string" && r.category.trim() !== ""
      ? r.category.trim()
      : "general";

    // 4. Position & Bounds check
    const pos = r.position as Record<string, unknown> | undefined;
    if (!pos || typeof pos !== "object") {
      errors.push(`POI [${id}] is missing 'position' coordinate object`);
      continue;
    }

    const px = pos.x;
    const pz = pos.z;
    if (!isFiniteNumber(px) || !isFiniteNumber(pz)) {
      errors.push(`POI [${id}] has non-finite position coordinates: x=${px}, z=${pz}`);
      continue;
    }

    if (px < minGridX || px > maxGridX || pz < minGridZ || pz > maxGridZ) {
      errors.push(`POI [${id}] position (${px.toFixed(2)}, ${pz.toFixed(2)}) is outside grid bounds [${minGridX.toFixed(2)}, ${maxGridX.toFixed(2)}] x [${minGridZ.toFixed(2)}, ${maxGridZ.toFixed(2)}]`);
      continue;
    }

    // 5. Height check
    let height: number | undefined;
    if (r.height !== undefined) {
      if (!isFiniteNumber(r.height)) {
        errors.push(`POI [${id}] has non-finite height value: ${r.height}`);
        continue;
      }
      height = r.height;
    }

    // 6. Zone parsing
    let zone: POIZone | undefined;
    if (r.zone !== undefined && r.zone !== null) {
      const zoneRes = parseZone(r.zone, id);
      if (zoneRes.error) {
        errors.push(zoneRes.error);
        continue;
      }
      zone = zoneRes.zone;
    }

    // 7. Aliases & Tags
    const aliases = Array.isArray(r.aliases)
      ? r.aliases.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
      : [];

    const tags = Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim())
      : [];

    const description = typeof r.description === "string" ? r.description.trim() : undefined;

    // 8. Anchor computation (snapToWalkable on walkable===1 cells only)
    let anchor: { x: number; z: number } = { x: px, z: pz };
    let unreachable = false;
    let lowClearance = false;

    const snapped = grid.snapToWalkable(px, pz, maxSnapDistM);
    if (!snapped) {
      unreachable = true;
      warnings.push(`POI [${id}] is unreachable: no walkable cell found within ${maxSnapDistM} m of (${px.toFixed(2)}, ${pz.toFixed(2)})`);
    } else {
      anchor = { x: snapped.x, z: snapped.z };
      lowClearance = Boolean(snapped.lowClearance);
      if (lowClearance) {
        warnings.push(`POI [${id}] anchor at (${anchor.x.toFixed(2)}, ${anchor.z.toFixed(2)}) has low clearance (< 0.20 m)`);
      }
      const snapDist = Math.hypot(anchor.x - px, anchor.z - pz);
      if (snapDist > warnSnapThresholdM) {
        warnings.push(`POI [${id}] anchor moved ${snapDist.toFixed(2)} m (> ${warnSnapThresholdM} m) from pin position (${px.toFixed(2)}, ${pz.toFixed(2)}) to walkable cell center (${anchor.x.toFixed(2)}, ${anchor.z.toFixed(2)})`);
      }
    }

    pois.push({
      id,
      name,
      category,
      aliases,
      tags,
      position: { x: px, z: pz },
      height,
      zone,
      anchor,
      description,
      unreachable,
      lowClearance,
    });
  }

  return { pois, errors, warnings };
}
