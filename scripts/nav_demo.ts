/**
 * scripts/nav_demo.ts
 * Standalone demo script for Phase 1 Navigation Core.
 * Routes between two far-apart walkable cells on real occupancy.json,
 * compares route with clearance penalty vs penalty = 0,
 * samples both smoothed paths every 5 cm to measure min, mean and p10 clearance,
 * and renders a top-down visualization image to docs/images/nav_demo.png.
 *
 * Uses zero new npm dependencies: Node.js built-in zlib for PNG compression.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { OccupancyGrid } from "../viewer/src/collision";
import { NavGrid, NavGridPoint } from "../viewer/src/nav/navgrid";
import { findPath } from "../viewer/src/nav/pathfinder";
import { dijkstraFrom } from "../viewer/src/nav/distanceField";

// ---------------------------------------------------------------------------
// 1. Pure Node.js PNG Encoder (Zero npm dependencies)
// ---------------------------------------------------------------------------

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf: Buffer): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = data.length;
  const chunk = Buffer.alloc(8 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const toCrc = chunk.subarray(4, 8 + len);
  chunk.writeUInt32BE(crc32(toCrc), 8 + len);
  return chunk;
}

function encodeRGBAtoPNG(width: number, height: number, rgba: Buffer): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: standard
  ihdr[12] = 0; // interlace: none
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // Scanlines with filter byte 0 (None)
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    scanlines[rowOffset] = 0;
    rgba.copy(scanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(scanlines, { level: 9 });
  const idatChunk = makeChunk("IDAT", compressed);
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

// ---------------------------------------------------------------------------
// 2. Clearance Sampling & Statistics
// ---------------------------------------------------------------------------

interface ClearanceStats {
  samplesCount: number;
  min: number;
  mean: number;
  p10: number;
}

function computePathClearanceStats(
  grid: NavGrid,
  points: NavGridPoint[],
  stepM = 0.05
): ClearanceStats {
  const clearances: number[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const segDist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(1, Math.ceil(segDist / stepM));
    // Sample along segment; include endpoint on last segment to avoid duplicate samples
    const maxS = i === points.length - 2 ? steps : steps - 1;
    for (let s = 0; s <= maxS; s++) {
      const t = steps > 0 ? s / steps : 0;
      const sx = p1.x + t * (p2.x - p1.x);
      const sz = p1.z + t * (p2.z - p1.z);
      clearances.push(grid.getClearance(sx, sz));
    }
  }

  if (clearances.length === 0) {
    return { samplesCount: 0, min: 0, mean: 0, p10: 0 };
  }

  const sorted = [...clearances].sort((a, b) => a - b);
  const min = sorted[0];
  const mean = clearances.reduce((sum, val) => sum + val, 0) / clearances.length;

  // 10th percentile (linear interpolation between ranks)
  const rank = (sorted.length - 1) * 0.10;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  const p10 = sorted[lower] * (1 - weight) + sorted[upper] * weight;

  return {
    samplesCount: clearances.length,
    min,
    mean,
    p10,
  };
}

// ---------------------------------------------------------------------------
// 3. Demo Execution & Comparison
// ---------------------------------------------------------------------------

function run(): void {
  const projectRoot = path.resolve(__dirname, "..");
  const occPath = path.join(projectRoot, "viewer", "public", "scene", "occupancy.json");
  const outDir = path.join(projectRoot, "docs", "images");
  const outPngPath = path.join(outDir, "nav_demo.png");

  if (!fs.existsSync(occPath)) {
    console.error(`Error: occupancy.json not found at ${occPath}`);
    process.exit(1);
  }

  const rawJson = fs.readFileSync(occPath, "utf-8");
  const occData: OccupancyGrid = JSON.parse(rawJson);

  console.log("===============================================================================");
  console.log("  NAMMA SPACE — PHASE 1 NAVIGATION CORE & CLEARANCE PENALTY COMPARISON");
  console.log("===============================================================================");
  console.log(`Grid dimensions: ${occData.width} x ${occData.height} cells (${(occData.width * occData.cell_size).toFixed(1)}m x ${(occData.height * occData.cell_size).toFixed(1)}m)`);
  console.log(`Cell size: ${occData.cell_size} m`);

  const spawnWorld: [number, number] = [1.771, 3.523];
  const grid = new NavGrid(occData, spawnWorld);
  console.log(`Walkable cells: ${grid.walkableCount}`);
  console.log(`Max clearance: ${grid.maxClearance.toFixed(2)} m`);

  // Start point: near spawn
  const startPoint = { x: spawnWorld[0], z: spawnWorld[1] };

  // Use distanceField (Dijkstra) from start to discover the furthest reachable cell
  const distField = dijkstraFrom(grid, startPoint, 0.08);

  let maxDist = -1;
  let farCol = -1;
  let farRow = -1;
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const d = distField[r * grid.width + c];
      if (isFinite(d) && d > maxDist) {
        maxDist = d;
        farCol = c;
        farRow = r;
      }
    }
  }

  const goalPoint = grid.cellToWorld(farCol, farRow);

  console.log("\nRouting configuration:");
  console.log(`  Start: (${startPoint.x.toFixed(3)}, ${startPoint.z.toFixed(3)}) [cell ${grid.spawnCol}, ${grid.spawnRow}]`);
  console.log(`  Goal:  (${goalPoint.x.toFixed(3)}, ${goalPoint.z.toFixed(3)}) [cell ${farCol}, ${farRow}]`);
  console.log(`  Dijkstra grid distance: ${maxDist.toFixed(3)} m`);
  console.log(`  Straight-line distance: ${Math.hypot(goalPoint.x - startPoint.x, goalPoint.z - startPoint.z).toFixed(3)} m`);

  // -------------------------------------------------------------------------
  // Path A: With clearance penalty (penaltyWeight = 0.35, prefClearance = 0.40m)
  // -------------------------------------------------------------------------
  const t0 = performance.now();
  const pathWithPenalty = findPath(grid, startPoint, goalPoint, {
    playerRadius: 0.08,
    clearancePenaltyWeight: 0.35,
    preferredClearanceM: 0.40,
    sampleStepM: 0.05,
  });
  const elapsedWithPenalty = performance.now() - t0;

  if ("error" in pathWithPenalty) {
    console.error(`Failed to find path with penalty: ${pathWithPenalty.error}`);
    process.exit(1);
  }

  const statsWithPenalty = computePathClearanceStats(grid, pathWithPenalty.points, 0.05);

  console.log("\n-------------------------------------------------------------------------------");
  console.log("  RUN A: WITH CLEARANCE PENALTY (weight = 0.35, preferred = 0.40 m)");
  console.log("-------------------------------------------------------------------------------");
  console.log(`  Smoothed path length: ${pathWithPenalty.lengthM.toFixed(3)} m`);
  console.log(`  Expanded A* nodes:    ${pathWithPenalty.expandedNodes}`);
  console.log(`  Compute time:         ${pathWithPenalty.computeMs.toFixed(2)} ms (internal) / ${elapsedWithPenalty.toFixed(2)} ms (wall)`);
  console.log(`  Waypoints count:      ${pathWithPenalty.points.length}`);
  console.log(`  5 cm sample count:    ${statsWithPenalty.samplesCount}`);
  console.log(`  Min clearance:        ${statsWithPenalty.min.toFixed(4)} m`);
  console.log(`  Mean clearance:       ${statsWithPenalty.mean.toFixed(4)} m`);
  console.log(`  p10 clearance:        ${statsWithPenalty.p10.toFixed(4)} m`);

  // -------------------------------------------------------------------------
  // Path B: Zero clearance penalty (penaltyWeight = 0.0)
  // -------------------------------------------------------------------------
  const t1 = performance.now();
  const pathZeroPenalty = findPath(grid, startPoint, goalPoint, {
    playerRadius: 0.08,
    clearancePenaltyWeight: 0.0,
    preferredClearanceM: 0.40,
    sampleStepM: 0.05,
  });
  const elapsedZeroPenalty = performance.now() - t1;

  if ("error" in pathZeroPenalty) {
    console.error(`Failed to find path with zero penalty: ${pathZeroPenalty.error}`);
    process.exit(1);
  }

  const statsZeroPenalty = computePathClearanceStats(grid, pathZeroPenalty.points, 0.05);

  console.log("\n-------------------------------------------------------------------------------");
  console.log("  RUN B: ZERO CLEARANCE PENALTY (weight = 0.0)");
  console.log("-------------------------------------------------------------------------------");
  console.log(`  Smoothed path length: ${pathZeroPenalty.lengthM.toFixed(3)} m`);
  console.log(`  Expanded A* nodes:    ${pathZeroPenalty.expandedNodes}`);
  console.log(`  Compute time:         ${pathZeroPenalty.computeMs.toFixed(2)} ms (internal) / ${elapsedZeroPenalty.toFixed(2)} ms (wall)`);
  console.log(`  Waypoints count:      ${pathZeroPenalty.points.length}`);
  console.log(`  5 cm sample count:    ${statsZeroPenalty.samplesCount}`);
  console.log(`  Min clearance:        ${statsZeroPenalty.min.toFixed(4)} m`);
  console.log(`  Mean clearance:       ${statsZeroPenalty.mean.toFixed(4)} m`);
  console.log(`  p10 clearance:        ${statsZeroPenalty.p10.toFixed(4)} m`);

  // -------------------------------------------------------------------------
  // Comparison Summary
  // -------------------------------------------------------------------------
  console.log("\n===============================================================================");
  console.log("  CLEARANCE PENALTY EFFECT COMPARISON SUMMARY");
  console.log("===============================================================================");
  console.log(`  Metric                  With Penalty (0.35)   Zero Penalty (0.0)     Delta (Effect)`);
  console.log(`  ---------------------------------------------------------------------------`);
  const dMin = statsWithPenalty.min - statsZeroPenalty.min;
  const dMean = statsWithPenalty.mean - statsZeroPenalty.mean;
  const dP10 = statsWithPenalty.p10 - statsZeroPenalty.p10;
  const dLen = pathWithPenalty.lengthM - pathZeroPenalty.lengthM;

  console.log(`  Min Clearance (m)       ${statsWithPenalty.min.toFixed(4).padStart(12)}        ${statsZeroPenalty.min.toFixed(4).padStart(12)}       ${(dMin >= 0 ? "+" : "") + dMin.toFixed(4)} m`);
  console.log(`  Mean Clearance (m)      ${statsWithPenalty.mean.toFixed(4).padStart(12)}        ${statsZeroPenalty.mean.toFixed(4).padStart(12)}       ${(dMean >= 0 ? "+" : "") + dMean.toFixed(4)} m`);
  console.log(`  p10 Clearance (m)       ${statsWithPenalty.p10.toFixed(4).padStart(12)}        ${statsZeroPenalty.p10.toFixed(4).padStart(12)}       ${(dP10 >= 0 ? "+" : "") + dP10.toFixed(4)} m`);
  console.log(`  Path Length (m)         ${pathWithPenalty.lengthM.toFixed(4).padStart(12)}        ${pathZeroPenalty.lengthM.toFixed(4).padStart(12)}       ${(dLen >= 0 ? "+" : "") + dLen.toFixed(4)} m`);
  console.log(`  Waypoints Count         ${String(pathWithPenalty.points.length).padStart(12)}        ${String(pathZeroPenalty.points.length).padStart(12)}       ${pathWithPenalty.points.length - pathZeroPenalty.points.length}`);
  console.log(`  Expanded Nodes          ${String(pathWithPenalty.expandedNodes).padStart(12)}        ${String(pathZeroPenalty.expandedNodes).padStart(12)}       ${pathWithPenalty.expandedNodes - pathZeroPenalty.expandedNodes}`);
  console.log("===============================================================================\n");

  // -------------------------------------------------------------------------
  // 4. Render Top-Down Map to PNG (Both Paths Visualized)
  // -------------------------------------------------------------------------
  const scale = 8; // 8x resolution: 99*8 = 792, 120*8 = 960
  const imgWidth = grid.width * scale;
  const imgHeight = grid.height * scale;
  const rgba = Buffer.alloc(imgWidth * imgHeight * 4);

  // Palette definitions [R, G, B, A]
  const colorUnknown = [15, 23, 42, 255];       // #0F172A deep dark slate
  const colorOccupied = [30, 41, 59, 255];      // #1E293B dark slate
  const colorInflated = [71, 85, 105, 255];     // #475569 medium slate buffer
  const colorFreeUnwalk = [148, 163, 184, 255]; // #94A3B8 light slate
  const colorWalkable = [241, 245, 249, 255];   // #F1F5F9 clean off-white
  const colorPathZero = [245, 158, 11, 255];    // #F59E0B vibrant amber (zero penalty)
  const colorPathWith = [6, 182, 212, 255];     // #06B6D4 electric cyan (with penalty)
  const colorStart = [16, 185, 129, 255];       // #10B981 emerald green
  const colorGoal = [239, 68, 68, 255];         // #EF4444 bright red
  const colorWaypoint = [37, 99, 235, 255];     // #2563EB cobalt blue

  // Render base cells
  for (let r = 0; r < grid.height; r++) {
    for (let c = 0; c < grid.width; c++) {
      const idx = r * grid.width + c;
      const state = occData.state ? occData.state[idx] : (occData.data[idx] === 1 ? 2 : 1);
      const isWalk = grid.walkable[idx] === 1;

      let cellColor = colorUnknown;
      if (state === 2) {
        cellColor = colorOccupied;
      } else if (state === 3) {
        cellColor = colorInflated;
      } else if (state === 1) {
        cellColor = isWalk ? colorWalkable : colorFreeUnwalk;
      }

      for (let py = 0; py < scale; py++) {
        const y = r * scale + py;
        for (let px = 0; px < scale; px++) {
          const x = c * scale + px;
          const pixelIdx = (y * imgWidth + x) * 4;
          rgba[pixelIdx + 0] = cellColor[0];
          rgba[pixelIdx + 1] = cellColor[1];
          rgba[pixelIdx + 2] = cellColor[2];
          rgba[pixelIdx + 3] = cellColor[3];
        }
      }
    }
  }

  // Draw smooth line segment on RGBA buffer
  function drawLine(x0: number, y0: number, x1: number, y1: number, color: number[], thickness: number): void {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist * 2));
    const rad = thickness / 2;

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x0 + t * (x1 - x0);
      const cy = y0 + t * (y1 - y0);

      const minX = Math.max(0, Math.floor(cx - rad));
      const maxX = Math.min(imgWidth - 1, Math.ceil(cx + rad));
      const minY = Math.max(0, Math.floor(cy - rad));
      const maxY = Math.min(imgHeight - 1, Math.ceil(cy + rad));

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (Math.hypot(x - cx, y - cy) <= rad) {
            const pIdx = (y * imgWidth + x) * 4;
            rgba[pIdx + 0] = color[0];
            rgba[pIdx + 1] = color[1];
            rgba[pIdx + 2] = color[2];
            rgba[pIdx + 3] = color[3];
          }
        }
      }
    }
  }

  // Draw filled circle
  function drawCircle(cx: number, cy: number, radius: number, color: number[]): void {
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(imgWidth - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(imgHeight - 1, Math.ceil(cy + radius));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (Math.hypot(x - cx, y - cy) <= radius) {
          const pIdx = (y * imgWidth + x) * 4;
          rgba[pIdx + 0] = color[0];
          rgba[pIdx + 1] = color[1];
          rgba[pIdx + 2] = color[2];
          rgba[pIdx + 3] = color[3];
        }
      }
    }
  }

  function worldToPixel(wx: number, wz: number): { px: number; py: number } {
    const c = (wx - grid.origin[0]) / grid.cellSize;
    const r = (wz - grid.origin[1]) / grid.cellSize;
    return { px: c * scale, py: r * scale };
  }

  // 1. Draw Zero-Penalty path (Amber line underneath)
  const ptsZero = pathZeroPenalty.points;
  for (let i = 0; i < ptsZero.length - 1; i++) {
    const pA = worldToPixel(ptsZero[i].x, ptsZero[i].z);
    const pB = worldToPixel(ptsZero[i + 1].x, ptsZero[i + 1].z);
    drawLine(pA.px, pA.py, pB.px, pB.py, colorPathZero, 3.0);
  }

  // 2. Draw With-Penalty path (Cyan line on top)
  const ptsWith = pathWithPenalty.points;
  for (let i = 0; i < ptsWith.length - 1; i++) {
    const pA = worldToPixel(ptsWith[i].x, ptsWith[i].z);
    const pB = worldToPixel(ptsWith[i + 1].x, ptsWith[i + 1].z);
    drawLine(pA.px, pA.py, pB.px, pB.py, colorPathWith, 4.0);
  }

  // 3. Draw intermediate waypoints for With-Penalty path
  for (let i = 1; i < ptsWith.length - 1; i++) {
    const wp = worldToPixel(ptsWith[i].x, ptsWith[i].z);
    drawCircle(wp.px, wp.py, 4.0, colorWaypoint);
    drawCircle(wp.px, wp.py, 2.0, [255, 255, 255, 255]);
  }

  // 4. Draw Start & Goal markers
  const startPx = worldToPixel(startPoint.x, startPoint.z);
  drawCircle(startPx.px, startPx.py, 8.0, colorStart);
  drawCircle(startPx.px, startPx.py, 4.0, [255, 255, 255, 255]);

  const goalPx = worldToPixel(goalPoint.x, goalPoint.z);
  drawCircle(goalPx.px, goalPx.py, 8.0, colorGoal);
  drawCircle(goalPx.px, goalPx.py, 4.0, [255, 255, 255, 255]);

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const pngBuffer = encodeRGBAtoPNG(imgWidth, imgHeight, rgba);
  fs.writeFileSync(outPngPath, pngBuffer);

  console.log(`Generated visual top-down navigation map:`);
  console.log(`  File: ${outPngPath}`);
  console.log(`  Resolution: ${imgWidth} x ${imgHeight} pixels`);
  console.log(`  Cyan path:  With clearance penalty (weight = 0.35)`);
  console.log(`  Amber path: Zero clearance penalty (weight = 0.0)`);
  console.log(`  File size:  ${(pngBuffer.length / 1024).toFixed(1)} KB`);
  console.log("===============================================================================\n");
}

run();
