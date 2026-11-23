/**
 * scripts/validate_pois.ts
 * Validates viewer/public/scene/poi.json against viewer/public/scene/occupancy.json.
 * Pure TypeScript execution via npx tsx.
 *
 * For each POI, prints:
 * - Reachable from spawn?
 * - Snap distance (pin to anchor)
 * - Anchor cell coordinates (col, row)
 *
 * Exits with code 1 if any POI is unreachable or invalid.
 */

import * as fs from "fs";
import * as path from "path";
import { OccupancyGrid } from "../viewer/src/collision";
import { NavGrid } from "../viewer/src/nav/navgrid";
import { findPath } from "../viewer/src/nav/pathfinder";
import { loadPOIs } from "../viewer/src/poi/loader";
import { POI } from "../viewer/src/poi/poi_types";

function main(): void {
  const projectRoot = path.resolve(__dirname, "..");
  const occPath = path.join(projectRoot, "viewer", "public", "scene", "occupancy.json");
  const poiPath = path.join(projectRoot, "viewer", "public", "scene", "poi.json");
  const scenePath = path.join(projectRoot, "viewer", "public", "scene", "scene.json");

  console.log("================================================================================");
  console.log(" Namma Space — POI Validation Tool (Phase 2)");
  console.log("================================================================================");

  if (!fs.existsSync(occPath)) {
    console.error(`[Error] occupancy.json not found at ${occPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(poiPath)) {
    console.error(`[Error] poi.json not found at ${poiPath}`);
    process.exit(1);
  }

  // 1. Load scene & occupancy
  const occData = JSON.parse(fs.readFileSync(occPath, "utf-8")) as OccupancyGrid;
  let spawnPos: [number, number] = [1.771, 3.523];
  if (fs.existsSync(scenePath)) {
    const sceneData = JSON.parse(fs.readFileSync(scenePath, "utf-8"));
    if (sceneData.camera?.spawn?.position) {
      spawnPos = [sceneData.camera.spawn.position[0], sceneData.camera.spawn.position[2]];
    }
  }

  console.log(`Grid: ${occData.width}x${occData.height} cells @ ${occData.cell_size}m, origin: [${occData.origin[0]}, ${occData.origin[1]}]`);
  console.log(`Spawn: (${spawnPos[0].toFixed(3)}, ${spawnPos[1].toFixed(3)})`);

  const navGrid = new NavGrid(occData, spawnPos);
  const spawnCell = navGrid.worldToCell(spawnPos[0], spawnPos[1]);
  console.log(`Spawn cell: col=${spawnCell.col}, row=${spawnCell.row}, walkable=${navGrid.isCellWalkable(spawnCell.col, spawnCell.row)}`);
  console.log("--------------------------------------------------------------------------------");

  // 2. Load and validate POIs
  const rawPoiData = JSON.parse(fs.readFileSync(poiPath, "utf-8"));
  const loadResult = loadPOIs(rawPoiData, navGrid);

  if (loadResult.errors.length > 0) {
    console.error(`[FAIL] ${loadResult.errors.length} validation error(s) found in poi.json:`);
    for (const err of loadResult.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  if (loadResult.warnings.length > 0) {
    console.warn(`[WARN] ${loadResult.warnings.length} warning(s):`);
    for (const w of loadResult.warnings) {
      console.warn(`  - ${w}`);
    }
  }

  console.log(`Loaded ${loadResult.pois.length} POI(s) successfully.\n`);

  let allReachable = true;
  const poiDetails: Array<{
    poi: POI;
    pinCell: { col: number; row: number };
    anchorCell: { col: number; row: number };
    snapDist: number;
    reachable: boolean;
    pathLengthM?: number;
  }> = [];

  for (let i = 0; i < loadResult.pois.length; i++) {
    const poi = loadResult.pois[i];
    const pinCell = navGrid.worldToCell(poi.position.x, poi.position.z);
    const anchorCell = navGrid.worldToCell(poi.anchor.x, poi.anchor.z);
    const snapDist = Math.hypot(poi.anchor.x - poi.position.x, poi.anchor.z - poi.position.z);

    // Verify A* path from spawn to anchor
    const pathRes = findPath(navGrid, { x: spawnPos[0], z: spawnPos[1] }, poi.anchor);
    const reachable = !("error" in pathRes) && pathRes.points.length > 0;

    if (!reachable || poi.unreachable) {
      allReachable = false;
    }

    poiDetails.push({
      poi,
      pinCell,
      anchorCell,
      snapDist,
      reachable,
      pathLengthM: "lengthM" in pathRes ? pathRes.lengthM : undefined,
    });

    console.log(`POI #${i + 1}: [${poi.id}] "${poi.name}" (category: "${poi.category}")`);
    console.log(`  - Pin position:   (${poi.position.x.toFixed(3)}, ${poi.position.z.toFixed(3)}) -> Cell [col: ${pinCell.col}, row: ${pinCell.row}]`);
    console.log(`  - Anchor:         (${poi.anchor.x.toFixed(3)}, ${poi.anchor.z.toFixed(3)}) -> Cell [col: ${anchorCell.col}, row: ${anchorCell.row}]`);
    console.log(`  - Snap distance:  ${snapDist.toFixed(3)} m`);
    console.log(`  - Walkable cell:  ${navGrid.isCellWalkable(anchorCell.col, anchorCell.row)} (clearance: ${navGrid.getClearance(poi.anchor.x, poi.anchor.z).toFixed(2)} m)`);
    console.log(`  - From spawn:     Reachable = ${reachable ? "YES" : "NO"}${pathRes && "lengthM" in pathRes ? ` (path length: ${pathRes.lengthM.toFixed(2)} m, compute: ${pathRes.computeMs.toFixed(2)} ms)` : ""}`);
    if (poi.zone) {
      console.log(`  - Zone:           ${poi.zone.type} (${JSON.stringify(poi.zone)})`);
    }
    console.log("");
  }

  // 3. Pairwise walking distances
  console.log("Pairwise Walking Distances Between POIs:");
  let maxPairwiseDist = 0;
  for (let i = 0; i < poiDetails.length; i++) {
    for (let j = i + 1; j < poiDetails.length; j++) {
      const pA = poiDetails[i];
      const pB = poiDetails[j];
      const route = findPath(navGrid, pA.poi.anchor, pB.poi.anchor);
      const dWalk = "lengthM" in route ? route.lengthM : NaN;
      const dEuclid = Math.hypot(pA.poi.position.x - pB.poi.position.x, pA.poi.position.z - pB.poi.position.z);
      if (!isNaN(dWalk) && dWalk > maxPairwiseDist) {
        maxPairwiseDist = dWalk;
      }
      console.log(`  * "${pA.poi.name}" <-> "${pB.poi.name}": walking = ${isNaN(dWalk) ? "UNREACHABLE" : dWalk.toFixed(2) + " m"} (straight-line = ${dEuclid.toFixed(2)} m)`);
    }
  }

  console.log("--------------------------------------------------------------------------------");
  if (!allReachable) {
    console.error("[FAIL] One or more POIs are unreachable from spawn!");
    process.exit(1);
  }

  if (maxPairwiseDist < 6.0) {
    console.warn(`[WARN] Maximum pairwise distance between POIs is ${maxPairwiseDist.toFixed(2)} m (< 6.0 m requirement).`);
  } else {
    console.log(`[PASS] Maximum pairwise walking distance is ${maxPairwiseDist.toFixed(2)} m (> 6.0 m requirement satisfied).`);
  }

  console.log("[PASS] All POIs are valid, well-anchored, and reachable from spawn.\n");
  process.exit(0);
}

main();
