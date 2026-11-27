# Namma Space — Intelligent Indoor Spatial Navigation Engine

An end-to-end spatial engine that turns smartphone captures of real indoor environments into photorealistic, interactive 3D digital twins with zero-install first-person walkthroughs, spatial Point of Interest (POI) search, and collision-free, near-optimal pathfinding around physical obstacles.

Built for the **Techfest 2026-27 Namma Space Challenge**.

---

## Live Demos

* **Round 2 (Evaluate this one)**: [https://namma-ml-viewer-r2.parthbhardwaj0906.workers.dev](https://namma-ml-viewer-r2.parthbhardwaj0906.workers.dev)
  * **Platform**: Cloudflare Workers (static assets)
  * Features full Round 2 deliverables: 3D POI labeling, fuzzy spatial search, collision-free, near-optimal route pathfinding, turn-by-turn HUD guidance, smooth camera jumps, in-browser POI authoring mode, and automated walk navigation.
* **Round 1 (Unchanged reference)**: [https://namma-ml-viewer.pages.dev/](https://namma-ml-viewer.pages.dev/)
  * **Platform**: Cloudflare Pages
  * Preserved exactly as submitted for Round 1 judging (3D Gaussian Splatting reconstruction and first-person collision roaming).

> **Note**: These deployments are separate Cloudflare projects hosted on separate Cloudflare accounts.

---

## Quick Start

### Prerequisites
* **Node.js**: $\ge 18.0.0$
* **npm**: $\ge 9.0.0$
* Modern web browser with WebGL 2.0 and WebAssembly support (Chrome, Edge, Firefox, Safari).

### Installation & Local Run
```bash
# 1. Install root & viewer dependencies
npm install --prefix viewer

# 2. Start local development server
npm run dev
```
Open [http://localhost:5173/](http://localhost:5173/) in your browser.

### Building for Production
```bash
# Build TypeScript and Vite bundle into viewer/dist/
npm run build
```
The output in `viewer/dist/` contains all static assets, Gaussian splat models (`scene.v1.spz`), 2D occupancy grid, and POI manifests. No single file exceeds 25 MiB.

### Running Tests
The test suite consists of 140 automated unit and integration tests across 6 test suites covering collision math, navigation A*, distance fields, POI parsing, spatial indexing, fuzzy search, and guidance HUD tracking:
```bash
# Run unit test suite
npm run test

# Run TypeScript static type checker
npm --prefix viewer run typecheck
```

---

## How Navigation Works

Navigation in Namma Space calculates collision-free, near-optimal walking routes through the reconstructed environment:

1. **Occupancy Grid Representation**:
   * The venue floor plan is represented as a high-resolution 2D occupancy grid ($0.10\text{ m}$ cell size) generated from metric 3D Gaussian geometry and camera trajectory carving.
   * Obstacle cells, unknown areas, and walkable corridors are strictly mapped in `viewer/public/scene/occupancy.json`.

2. **Anchor Snapping & Clearance**:
   * When navigating to a POI (e.g. furniture, window, door), the destination pin is snapped to the nearest walkable cell having an obstacle clearance of at least $0.20\text{ m}$ (satisfying human radius $r = 0.08\text{ m}$ clearance requirements).

3. **A\* Pathfinding & Heuristics**:
   * The A\* pathfinder in `viewer/src/nav/pathfinder.ts` uses an 8-connected grid search with diagonal movements and an admissible octile distance heuristic.
   * Path calculations run in under $1.5\text{ ms}$ (mean $0.38\text{ ms}$).

4. **Line-of-Sight Path Smoothing**:
   * Raw 8-way grid paths are processed with raycast string-pulling. The smoother checks collision clearance across line-of-sight segments, turning stepped grid paths into natural, straight-line walking trajectories.
   * Paths are guaranteed collision-free, near-optimal trajectories achieving a mean path ratio of $0.990$ compared to Dijkstra baseline.

5. **Guidance Engine & Turn-by-Turn Tracking**:
   * The guidance generator converts smoothed waypoints into concise instructions with metric distances, turn angles, and clock-face directions.
   * While walking (or during automated walk mode), the tracker monitors player progress. If the user wanders off-path by more than $0.50\text{ m}$, dynamic re-routing instantly recalculates a fresh path from the current position.

For extensive performance metrics, wall clearance benchmarks, and stress test data across 72 POI pairs, see the [Navigation Evaluation Report](docs/NAV_EVAL.md).

---

## How to Author POIs

The viewer includes an interactive authoring tool for venue managers:

1. **Activate Authoring Mode**:
   * Walk into the venue and press `P` to toggle POI edit mode. A glowing badge and toolbar will appear.
2. **Drop a Pin**:
   * Click on the 3D floor splat or click on the 2D minimap floor plan. A new pin marker is dropped and automatically snapped to a walkable anchor.
3. **Set Metadata**:
   * Enter the name (e.g. `Balcony Door`), category (`door`, `bench`, `table`, `window`, `stage`, `tape`, `general`), optional search aliases, and a descriptive note.
4. **Export Dataset**:
   * Click **Export poi.json** in the toolbar to download the updated JSON file.
   * Save the file over `viewer/public/scene/poi.json`.
5. **Validate**:
   * Run the offline validation tool to verify reachability and clearances:
     ```bash
     npx tsx scripts/validate_pois.ts
     ```
   * The tool validates that all POIs are reachable from spawn, obstacle-free, and correctly formatted.
6. **Commit**:
   * Commit the verified `poi.json` to git and redeploy.

For the full operational protocol, see the [POI Annotation SOP](docs/SOP.md#7-poi-annotation-sop-venue-tagging-protocol).

---

## Architecture Overview

The frontend is organized into modular subsystems under `viewer/src/`:

```
viewer/src/
├── nav/                     # Core Navigation & Pathfinding
│   ├── navgrid.ts           # 2D occupancy grid adapter, 8-way connectivity, clearance transforms
│   ├── distanceField.ts     # Dijkstra distance field calculation & wave propagation
│   ├── pathfinder.ts        # A* pathfinding with octile heuristic & raycast path smoother
│   ├── instructions.ts      # Turn-by-turn guidance instruction generator
│   └── route_state.ts       # Route progress tracking & off-path detection (0.50 m hysteresis)
│
├── poi/                     # Spatial Data Model & Search
│   ├── poi_types.ts         # POI schema, category types, zone definitions
│   ├── loader.ts            # POI dataset parser, grid validator, and data source resolver
│   ├── spatial_index.ts     # 2D spatial grid hash for rapid proximity and zone queries
│   ├── search.ts            # Damerau-Levenshtein fuzzy search & multi-token ranker
│   └── jump_math.ts         # Cinematic camera transition math & visibility checks
│
└── ui/                      # 3D Presentation & Controls
    ├── search_bar.ts        # Search UI dialog with category filters & result list
    ├── poi_overlay.ts       # 3D billboard markers in Three.js scene with distance LOD
    ├── poi_card.ts          # Selected POI details card with Jump / Navigate actions
    ├── route_renderer.ts    # 3D animated route ribbon & target beacon
    ├── guidance_hud.ts      # Turn-by-turn direction banner, distance, and progress bar
    ├── navigation_controller.ts # Route execution orchestrator & automated walk runner
    ├── poi_authoring.ts     # In-viewer interactive POI editor & JSON exporter
    └── jump_controller.ts   # Smooth quadratic camera transitions between locations
```

---

## Controls & Key Bindings

| Key / Input | Action |
|---|---|
| **`/`** or **`Ctrl + K`** | Open Spatial Search dialog |
| **`L`** | Toggle 3D POI marker labels (ON / OFF) |
| **`P`** | Toggle POI Authoring mode (place / edit pins) |
| **`G`** | Toggle Auto-Walk along active route |
| **`C`** | Clear / Cancel active navigation route |
| **`O`** | Toggle navigation debug overlay (distance field & waypoints) |
| **`Esc`** | Close search / Dismiss POI card / Exit authoring modal / Release pointer lock |
| **`B`** | Toggle 2D minimap floor plan overlay |
| **`U`** | Toggle exploration of unreconstructed areas |
| **`R`** | Reset player position and yaw to spawn point |
| **`F3`** | Toggle telemetry statistics panel (FPS, frame time, splats, position) |
| **`1` / `2` / `3`** | Switch rendering quality preset (Low / Medium / High) |
| **`WASD` / Arrows** | First-person movement with wall sliding collision detection |
| **`Mouse`** | Camera look (Pitch & Yaw via pointer lock) |
| **`Shift`** | Sprint (2x movement speed) |
| **`H`** | Toggle walking head-bob motion |

---

## Further Documentation

* [docs/ROUND2.md](docs/ROUND2.md): **Round 2 Evaluation Guide**, 3-minute judge test script, criteria-to-implementation mapping, and third-party license audit.
* [docs/NAV_EVAL.md](docs/NAV_EVAL.md): **Navigation Evaluation Report**, reachability matrices, wall clearance benchmarks, and instruction quality verification.
* [docs/SOP.md](docs/SOP.md): **Standard Operating Procedure**, indoor video capture protocol, camera setting guidelines, and POI annotation SOP.
* [docs/STATE.md](docs/STATE.md): Detailed technical status of all pipeline and viewer phases.
