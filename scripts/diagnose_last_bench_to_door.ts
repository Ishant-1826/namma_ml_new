import * as fs from "fs";
import * as path from "path";
import { NavGrid } from "../viewer/src/nav/navgrid";
import { findPath, PathSuccess } from "../viewer/src/nav/pathfinder";
import { loadPOIs } from "../viewer/src/poi/loader";
import {
  projectPlayerOnPath,
  generateInstruction,
  extractTurnEvents,
  PathProjection,
  NavigationInstruction,
  GuidanceStateTracker,
} from "../viewer/src/nav/instructions";

const SCENE_DIR = path.resolve(__dirname, "../viewer/public/scene");
const occData = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, "occupancy.json"), "utf-8"));
const rawPoiData = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, "poi.json"), "utf-8"));

const grid = new NavGrid(occData, [1.771, 3.523]);
const loadResult = loadPOIs(rawPoiData, grid);
const pois = loadResult.pois;

const poiA = pois.find((p) => p.name.toLowerCase() === "last bench")!;
const poiB = pois.find((p) => p.name.toLowerCase() === "door")!;

const start = { x: poiA.anchor.x, z: poiA.anchor.z };
const goal = { x: poiB.anchor.x, z: poiB.anchor.z };

const res = findPath(grid, start, goal, {
  playerRadius: 0.08,
  snapStart: false,
  snapGoal: false,
  collectExplored: true,
});

if ("error" in res) {
  console.error("Path error:", res.error);
  process.exit(1);
}

const s = res as PathSuccess;
const pathPoints = s.points;
const totalLengthM = s.lengthM;
const precomputedTurns = extractTurnEvents(pathPoints);

const projTemp: PathProjection = {
  nearestPoint: { x: 0, z: 0 },
  distanceOffPathM: 0,
  segmentIndex: 0,
  segmentT: 0,
  distanceAlongPathM: 0,
  remainingDistanceM: 0,
};

const instTemp: NavigationInstruction = {
  type: "continue",
  text: "",
  distanceToEventM: 0,
  remainingDistanceM: 0,
  etaSeconds: 0,
  progressFraction: 0,
};

const tracker: GuidanceStateTracker = {
  activeTurnIndex: 0,
  initialHeadingResolved: false,
};

let lastSegIdx = 0;
let distAlong = 0;
const speedMps = 1.4;
const dt = 0.5; // sample every 0.5 s

console.log("=== DIAGNOSTIC LOG SAMPLE: 'Last bench' -> 'door' ===");

// Simulate 15 time steps at 0.5 s intervals
for (let step = 0; step < 16; step++) {
  const tSec = step * dt;
  distAlong = Math.min(totalLengthM, step * dt * speedMps);

  // Find position along path at distAlong
  let acc = 0;
  let px = pathPoints[0].x;
  let pz = pathPoints[0].z;
  let segDx = pathPoints[1].x - pathPoints[0].x;
  let segDz = pathPoints[1].z - pathPoints[0].z;

  for (let i = 0; i < pathPoints.length - 1; i++) {
    const p1 = pathPoints[i];
    const p2 = pathPoints[i + 1];
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    if (distAlong <= acc + segLen || i === pathPoints.length - 2) {
      const frac = segLen > 1e-6 ? (distAlong - acc) / segLen : 0;
      px = p1.x + frac * (p2.x - p1.x);
      pz = p1.z + frac * (p2.z - p1.z);
      segDx = p2.x - p1.x;
      segDz = p2.z - p1.z;
      break;
    }
    acc += segLen;
  }

  // Camera yaw facing along movement direction
  const yawRad = Math.atan2(-segDx, -segDz);
  const yawDeg = (yawRad * 180) / Math.PI;

  // Project player
  projectPlayerOnPath(pathPoints, px, pz, projTemp, lastSegIdx);
  lastSegIdx = projTemp.segmentIndex;

  // Generate instruction
  generateInstruction(
    pathPoints,
    projTemp,
    totalLengthM,
    poiB.name,
    yawRad,
    instTemp,
    tracker,
    precomputedTurns
  );

  const activeIdx = tracker.activeTurnIndex;
  const activeTurn = activeIdx < precomputedTurns.length ? precomputedTurns[activeIdx] : null;

  const turnPtStr = activeTurn
    ? `(${activeTurn.point.x.toFixed(2)}, ${activeTurn.point.z.toFixed(2)})`
    : "(none)";
  const angleStr = activeTurn
    ? `${activeTurn.angleDeg.toFixed(1)}° (${activeTurn.isLeft ? "left" : "right"})`
    : "0.0° (none)";
  const distAlongTurnStr = activeTurn ? `${activeTurn.alongPathM.toFixed(2)}m` : "0.00m";

  console.log(
    `[NavDebug] player=(${px.toFixed(2)}, ${pz.toFixed(2)}) yaw=${yawDeg.toFixed(1)}° | ` +
    `proj=(${projTemp.nearestPoint.x.toFixed(2)}, ${projTemp.nearestPoint.z.toFixed(2)}) offPath=${projTemp.distanceOffPathM.toFixed(2)}m segIdx=${projTemp.segmentIndex} | ` +
    `nextTurn=${turnPtStr} angle=${angleStr} distAlong=${distAlongTurnStr} | ` +
    `text="${instTemp.text}"`
  );
}
