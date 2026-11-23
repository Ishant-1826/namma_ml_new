# Round 2: POI Navigation & Interactive Desktop Viewer Architecture Plan

> Branch: `round2-poi-navigation`  
> Baseline Tag: `round1-submission` (commit `72f0009`)  
> Last Updated: 2026-11-22  

---

## 1. Occupancy Grid Schema (`viewer/public/scene/occupancy.json`)

The occupancy grid represents a metric 2D horizontal slice of the scene body slab ($y \in [0.20, 1.40]$ m above floor at $y = 0.0$ m).

### Exact JSON Properties
```json
{
  "origin": [-5.9, -4.7],
  "cell_size": 0.1,
  "width": 99,
  "height": 120,
  "axes": ["+X", "+Z"],
  "axes_convention": "X right, Z forward, Y up (Three.js standard)",
  "min_points_per_cell": 2,
  "inflation_radius_m": 0.12,
  "walkable_radius_m": 0.20,
  "height_band_m": [0.20, 1.40],
  "occupied_cells_raw": 3536,
  "occupied_cells_inflated": 3386,
  "free_cells": 2270,
  "unknown_cells": 2688,
  "walkable_cells": 2195,
  "total_cells": 11880,
  "occupied_pct": 29.76,
  "inflated_pct": 28.50,
  "free_pct": 19.11,
  "unknown_pct": 22.63,
  "walkable_pct": 18.48,
  "camera_free_pct": 100.0,
  "camera_walkable_pct": 100.0,
  "blocked_step_share_pct": 0.0,
  "spawn_free": true,
  "data": [ ... 11880 elements ... ],
  "walkable": [ ... 11880 elements ... ],
  "state": [ ... 11880 elements ... ],
  "clearance_m": [ ... 11880 elements ... ],
  "effective_body_radius_m": 0.20,
  "narrowest_passable_gap_m": 0.40,
  "three_narrowest_corridors": [
    {"position": [2.95, 4.95], "width_m": 0.40},
    {"position": [1.75, -0.25], "width_m": 0.40},
    {"position": [-1.25, -0.25], "width_m": 0.40}
  ]
}
```

### Dimensions & Spatial Extents
- **Cell Size**: `0.1` m ($10\text{ cm} \times 10\text{ cm}$ square cells)
- **Grid Dimensions**: `width = 99` cells (along $+X$), `height = 120` cells (along $+Z$)
- **Total Cells**: $99 \times 120 = 11,880$ cells
- **World Origin**: `[-5.9, -4.7]` ($[\min X, \min Z]$ in meters)
- **World Extents**:
  - $X \in [\text{origin}[0], \text{origin}[0] + \text{width} \times \text{cell\_size}] = [-5.9, +4.0]$ m
  - $Z \in [\text{origin}[1], \text{origin}[1] + \text{height} \times \text{cell\_size}] = [-4.7, +7.3]$ m

---

## 2. Meaning of EVERY Cell State Value

Confirmed directly from `viewer/src/collision.ts:isBlocked` (lines 53–90):

| State Value | Semantic Name | Cell Count | Percentage | Collision Behavior (`collision.ts`) | Physical Real-World Meaning |
| :---: | :---: | :---: | :---: | :--- | :--- |
| **`0`** | **Unknown / Unreconstructed** | **2,688** | **22.63%** | **Blocked by default** when `allowUnknown === false`.<br>**Traversable** when `allowUnknown === true` (Explore Mode Key U). | Pockets outside the camera trajectory or hidden by solid objects where SfM/3DGS ray carving lacked observation evidence. |
| **`1`** | **Free / Known-Free** | **2,270** | **19.11%** | **Traversable**.<br>When `limitToWalkable === true` and `allowUnknown === false`, constrained to `walkable === 1` (connected to spawn). | 3D voxel ray carving confirmed zero obstacles and $\ge 2$ camera sightlines through the body slab ($y \in [0.20, 1.40]$ m). |
| **`2`** | **Occupied (Raw Obstacle)** | **3,536** | **29.76%** | **Strictly Blocked** in all modes.<br>`isBlocked` returns `true` unconditionally. | Physical obstacles: tables, chairs, classroom walls, doors detected by $\ge 2$ SfM 3D points or dense splats. |
| **`3`** | **Inflated Obstacle Buffer** | **3,386** | **28.50%** | **Strictly Blocked** in all modes.<br>`isBlocked` returns `true` unconditionally. | 0.12 m safety margin dilated around raw obstacles. Combined with the viewer circle radius ($0.08$ m), guarantees a total physical player body clearance of $0.20$ m. |
| **N/A** | **Out of Bounds** | — | — | **Strictly Blocked** in all modes.<br>`col < 0 \|\| col >= width \|\| row < 0 \|\| row >= height` returns `true`. | Any position outside the defined grid bounds $[-5.9, 4.0] \times [-4.7, 7.3]$ m. |

### Auxiliary Grid Arrays
- **`walkable` Array (11,880 elements)**:
  - `walkable === 1`: **2,195 cells (18.48%)** — 4-neighbour flood-filled continuous region connected to spawn.
  - `walkable === 0`: **9,685 cells (81.52%)** — blocked, unknown, or unreachable isolated pockets.
- **`data` Array (11,880 elements)** (Round 1 backwards compatibility):
  - `data === 1`: **9,342 cells (78.64%)** — all blocked cells (raw occupied + inflated + isolated unknowns).
  - `data === 0`: **2,538 cells (21.36%)** — free cells.

---

## 3. World $\leftrightarrow$ Cell Coordinate Conversions

Confirmed from `viewer/src/collision.ts:worldToCell`:

### Forward Conversion: World $(x, z) \to$ Grid Cell $(\text{col}, \text{row}, \text{idx})$
$$\text{col} = \left\lfloor \frac{x - \text{origin}[0]}{\text{cell\_size}} \right\rfloor = \left\lfloor \frac{x - (-5.9)}{0.1} \right\rfloor$$
$$\text{row} = \left\lfloor \frac{z - \text{origin}[1]}{\text{cell\_size}} \right\rfloor = \left\lfloor \frac{z - (-4.7)}{0.1} \right\rfloor$$
$$\text{idx} = \text{row} \times \text{width} + \text{col} = \text{row} \times 99 + \text{col}$$

### Inverse Conversion: Grid Cell $(\text{col}, \text{row}) \to$ World Center $(x, z)$
$$x = \text{origin}[0] + (\text{col} + 0.5) \times \text{cell\_size} = -5.9 + (\text{col} + 0.5) \times 0.1$$
$$z = \text{origin}[1] + (\text{row} + 0.5) \times \text{cell\_size} = -4.7 + (\text{row} + 0.5) \times 0.1$$

---

## 4. Spawn Position & Alignment

From `viewer/public/scene/scene.json`:
- **World Position**: `[1.771, 1.450, 3.523]` (meters, right-handed Y-up, floor at $y = 0.0$ m, standing eye height $1.45$ m).
- **Spawn Yaw**: `-0.0426` radians ($-2.44^\circ$, facing North along $-Z$).
- **Spawn Cell Mapping**:
  - $\text{col} = \lfloor (1.771 - (-5.9)) / 0.1 \rfloor = 76$
  - $\text{row} = \lfloor (3.523 - (-4.7)) / 0.1 \rfloor = 82$
  - $\text{idx} = 82 \times 99 + 76 = 8,194$
- **State at Spawn**:
  - `state = 1` (Free)
  - `walkable = 1` (Walkable)
  - `data = 0` (Free)
  - Verified free with zero initial collision overlap.

---

## 5. Walkable Region & Flood-Fill Analysis

- **BFS Flood-Fill Reachability**:
  A 4-connected breadth-first search initialized at spawn cell $(76, 82)$ on `walkable === 1` visits **2,195 out of 2,195 cells (100.00%)**.
  - Disconnected walkable pockets: **0**.
  - The walkable domain is fully contiguous and transitively reachable.
- **Physical Walkable Floor Area**:
  $$\text{Area} = 2,195 \times (0.1\text{ m} \times 0.1\text{ m}) = \mathbf{21.95\text{ m}^2}$$
- **Passable Bottlenecks**:
  The minimum passable doorway / aisle width in the scene is **0.40 m** (corridors at $[2.95, 4.95]$, $[1.75, -0.25]$, and $[-1.25, -0.25]$).

---

## 6. How `main.ts` Wires Controls, Collision, and Minimap

```
+-----------------------------------------------------------------------------------+
|                                 viewer/src/main.ts                                |
+-----------------------------------------------------------------------------------+
       |                                      |                               |
       v                                      v                               v
+------------------------+      +---------------------------+     +-----------------+
| FirstPersonControls.ts |      |       collision.ts        |     |   minimap.ts    |
| (WASD, Mouse Look,     | <--> | (Circle vs cell test,     |     | (2D occupancy   |
|  Sprint, Sub-stepping) |      |  wall-sliding resolution) |     |  canvas overlay)|
+------------------------+      +---------------------------+     +-----------------+
       |                                                                  |
       +----------------------------+-------------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------------------+
|                        Render Loop: renderer.setAnimationLoop                     |
|  1. if (document.hidden) skip frame                                               |
|  2. controls.update(dt) -> resolves motion via collision.ts                       |
|  3. renderer.render(scene, camera)                                                |
|  4. minimap.update(x, z, yaw, now) [max 10 Hz]                                    |
|  5. F3 Telemetry DOM updates [max 4 Hz]                                           |
+-----------------------------------------------------------------------------------+
```

1. **Initialization**:
   - `fetch("/scene/scene.json")` and `fetch("/scene/occupancy.json")` load scene metadata and grid.
   - `FirstPersonControls` is instantiated with camera, canvas, bounds, and grid.
   - `Minimap` initializes an offscreen 2D canvas of the grid ($99 \times 120$ px) mapped to CSS dimensions ($180 \times 218$ px).
   - Splat mesh (`scene.v1.spz` or fallback `scene.splat`) is loaded via Spark and added to Three.js `scene`.
2. **Substep Collision Resolution**:
   - Inside `controls.update(dt)`, movement delta $(\Delta x, \Delta z)$ is partitioned into sub-steps $\le 0.05$ m.
   - `collision.ts:resolveMovement` tests the player circle ($r = 0.08$ m) against the grid cells.
   - Perpendicular axes slide independently: if $X$ motion hits a blocked cell, $X$ motion cancels while $Z$ motion slides freely along the wall.
3. **Render Loop Zero-Allocation Guarantee**:
   - All vectors and matrices are pre-allocated outside the loop.
   - Minimap and F3 DOM updates are throttled (10 Hz and 4 Hz).

---

## 7. Round 2 Architecture & Module Plug-in Points

Round 2 adds Points of Interest (POIs), spatial search, 2D/3D pathfinding (A*), smoothed trajectories, and route guidance.

```
viewer/
├── src/
│   ├── main.ts              <-- Wires NavController & POIController into render loop
│   ├── controls.ts          <-- (Unchanged Round 1 controls)
│   ├── collision.ts         <-- (Unchanged Round 1 collision maths)
│   ├── minimap.ts           <-- Extends with drawRoute(waypoints)
│   ├── nav/                 <-- [NEW] Pure TypeScript Navigation (Zero Three.js / DOM)
│   │   ├── nav_grid.ts      <-- Graph abstraction over OccupancyGrid (8-connectivity, clearance costs)
│   │   ├── astar.ts         <-- A* pathfinder with binary min-heap (pre-allocated, zero-allocation)
│   │   ├── smoother.ts      <-- Raycast line-of-sight path pruning (eliminates zig-zags)
│   │   └── route_state.ts   <-- Route state machine (IDLE, NAVIGATING, ARRIVED, OFF_PATH)
│   ├── poi/                 <-- [NEW] Pure TypeScript POI Registry (Zero Three.js / DOM)
│   │   ├── poi_types.ts     <-- POI schema interfaces, category types
│   │   ├── poi_registry.ts  <-- Loads poi.json, spatial index, fuzzy search
│   │   └── poi_projection.ts<-- Math for 3D world to 2D screen coordinate projection & culling
│   └── ui/                  <-- [NEW] Pure DOM UI Overlays
│       ├── search_bar.ts    <-- Autocomplete search overlay (hotkey '/')
│       ├── poi_card.ts      <-- Collapsible detail card with "Navigate" action
│       └── nav_hud.ts       <-- Active route banner (distance, heading cue, cancel)
└── test/
    ├── nav_grid.test.ts     <-- Vitest unit tests for grid traversal
    ├── astar.test.ts        <-- Vitest unit tests for A* shortest path & clearance
    ├── smoother.test.ts     <-- Vitest unit tests for path smoothing
    └── poi.test.ts          <-- Vitest unit tests for POI registry & search
```

### Pure Logic Isolation Rule (Standing Rule 6)
- **`viewer/src/nav/`** and **`viewer/src/poi/`** contain **zero** Three.js and **zero** DOM imports.
- All algorithms are tested under headless **Vitest** in `viewer/test/`.
- UI rendering and event dispatching live strictly in `viewer/src/ui/`.

### Main Integration Details
1. **Nav Initialization**:
   - `NavGrid` wraps the already loaded `occupancy.json`.
   - `AStarPathfinder` initializes with pre-allocated node pools to guarantee zero heap allocation during routing.
2. **3D Visual Route Display**:
   - Pre-allocated `THREE.BufferGeometry` or instanced breadcrumb markers placed at $y = 0.05$ m.
   - Updated only on route calculation or waypoint advancement.
3. **2D Minimap Route Overlay**:
   - `Minimap.drawRoute(waypoints)` connects waypoint cell coordinates with high-contrast path lines directly on the minimap canvas.
4. **Input Handling**:
   - Key `/` focuses POI search bar and unlocks cursor.
   - `Escape` closes POI drawer and cancels active navigation.
