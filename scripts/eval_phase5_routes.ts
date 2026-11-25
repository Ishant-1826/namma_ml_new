/**
 * eval_phase5_routes.ts
 * Computes path length, compute ms, expanded nodes, and instruction list
 * for 3 far-apart POI pairs from the real poi.json.
 */

import * as fs from "fs";
import * as path from "path";
import { NavGrid } from "../viewer/src/nav/navgrid";
import { findPath, PathSuccess } from "../viewer/src/nav/pathfinder";
import { loadPOIs } from "../viewer/src/poi/loader";
import { projectPlayerOnPath, generateInstruction, PathProjection } from "../viewer/src/nav/instructions";
import { POI } from "../viewer/src/poi/poi_types";

const SCENE_DIR = path.resolve(__dirname, "../viewer/public/scene");
const occPath = path.join(SCENE_DIR, "occupancy.json");
const poiPath = path.join(SCENE_DIR, "poi.json");

const occData = JSON.parse(fs.readFileSync(occPath, "utf-8"));
const rawPoiData = JSON.parse(fs.readFileSync(poiPath, "utf-8"));

const grid = new NavGrid(occData, [1.771, 3.523]);
const loadResult = loadPOIs(rawPoiData, grid);
const pois: POI[] = loadResult.pois;

const pairs: Array<[string, string]> = [
  ["Last bench", "door"],
  ["Last bench", "study table"],
  ["measuring tape", "Last bench"],
];

console.log("================================================================================");
console.log(" Phase 5: 3 Far-Apart POI Pair Navigation Evaluation");
console.log("================================================================================");

for (let i = 0; i < pairs.length; i++) {
  const [nameA, nameB] = pairs[i];
  const poiA = pois.find((p) => p.name.toLowerCase() === nameA.toLowerCase());
  const poiB = pois.find((p) => p.name.toLowerCase() === nameB.toLowerCase());

  if (!poiA || !poiB) {
    console.error(`Could not find pair: ${nameA} <-> ${nameB}`);
    continue;
  }

  const start = { x: poiA.anchor.x, z: poiA.anchor.z };
  const goal = { x: poiB.anchor.x, z: poiB.anchor.z };

  const res = findPath(grid, start, goal, {
    playerRadius: 0.08,
    snapStart: false,
    snapGoal: false,
    collectExplored: true,
  });

  if ("error" in res) {
    console.error(`Error finding path: ${res.error}`);
    continue;
  }

  const s = res as PathSuccess;

  // Generate full instruction list along waypoints
  const instructions: string[] = [];
  const projTemp: PathProjection = {
    nearestPoint: { x: 0, z: 0 },
    distanceOffPathM: 0,
    segmentIndex: 0,
    segmentT: 0,
    distanceAlongPathM: 0,
    remainingDistanceM: 0,
  };

  // Sample instructions at each waypoint along the path
  for (let ptIdx = 0; ptIdx < s.points.length; ptIdx++) {
    const pt = s.points[ptIdx];
    projectPlayerOnPath(s.points, pt.x, pt.z, projTemp);
    const inst = generateInstruction(s.points, projTemp, s.lengthM, poiB.name);
    const stepDesc = `Waypoint ${ptIdx + 1} (${pt.x.toFixed(2)}, ${pt.z.toFixed(2)}): "${inst.text}" [rem: ${inst.remainingDistanceM.toFixed(1)}m, ETA: ${inst.etaSeconds}s, prog: ${Math.round(inst.progressFraction * 100)}%]`;
    instructions.push(stepDesc);
  }

  console.log(`\nPair #${i + 1}: "${nameA}" -> "${nameB}"`);
  console.log(`  - Path Length:        ${s.lengthM.toFixed(2)} m`);
  console.log(`  - Compute Time:       ${s.computeMs.toFixed(2)} ms`);
  console.log(`  - Expanded Nodes:     ${s.expandedNodes}`);
  console.log(`  - Total Waypoints:    ${s.points.length}`);
  console.log(`  - Instructions Count: ${instructions.length}`);
  console.log(`  - Instruction List:`);
  for (const inst of instructions) {
    console.log(`      * ${inst}`);
  }
}
console.log("================================================================================");
