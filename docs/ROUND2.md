# Round 2 Evaluation Guide & Technical Report

This document provides competition judges with a streamlined 3-minute evaluation walkthrough of the Round 2 deliverables, architectural criteria mappings, and an audit of third-party dependencies.

---

## Live Demos

* **Round 2 (Evaluate this one)**: [https://namma-ml-viewer-r2.parthbhardwaj0906.workers.dev](https://namma-ml-viewer-r2.parthbhardwaj0906.workers.dev)
  * **Platform**: Cloudflare Workers (static assets)
  * Implements all Round 2 deliverables: spatial POI indexing and 3D labeling, fuzzy search UI with category chips, collision-free, near-optimal pathfinding around obstacles, turn-by-turn navigation HUD, smooth camera transitions, and in-browser POI authoring mode.
* **Round 1 (Unchanged reference)**: [https://namma-ml-viewer.pages.dev/](https://namma-ml-viewer.pages.dev/)
  * **Platform**: Cloudflare Pages
  * Submitted for Round 1 judging (pure 3D reconstruction and first-person collision roaming).

> **Note**: Round 1 and Round 2 are separate Cloudflare projects hosted on separate Cloudflare accounts.

---

## 3-Minute Judge Quick-Test Guide

Follow this sequential sequence to evaluate all Round 2 capabilities inside the live viewer:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        3-MINUTE EVALUATION WALKTHROUGH                       │
├──────────────────────────────────────────────────────────────────────────────┤
│ 1. Search & Route  : Press '/' -> Type "door" -> Click "Navigate"             │
│ 2. Automated Walk  : Press 'G' to engage auto-walk along the ribbon path     │
│ 3. Category Filter : Press '/' -> Click category chip "bench" or "table"     │
│ 4. Typo Tolerance  : Type typo "dor" or "tabel" -> Verify instant match      │
│ 5. POI Authoring   : Press 'P' -> Drop test pin on floor -> Inspect modal    │
│ 6. Debug Overlay   : Press 'O' to reveal 2D distance field & waypoints       │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Step 1: Spatial Search & Route Display
1. Open the [Round 2 Live Viewer](https://namma-ml-viewer-r2.parthbhardwaj0906.workers.dev).
2. Press **`/`** (or **`Ctrl + K`**) to open the Spatial Search bar.
3. Type `"door"`. Notice instant search matching and distance calculations from your current location.
4. Click the **"Navigate"** action button.
   * A vibrant cyan 3D path with animated chevrons appears on the floor.
   * A vertical destination beacon illuminates at the target location.
   * The Guidance HUD appears at the top displaying the first turn instruction (e.g. `"In 1.8 m, Turn slight right toward door"`).

### Step 2: Auto-Walk Navigation
1. Press **`G`** on the keyboard.
2. The camera smoothly advances along the path at a natural walking speed ($1.4\text{ m/s}$), rotating to align with upcoming path tangents.
3. Observe turn-by-turn HUD updates count down metric distances until reaching destination arrival.
4. Press **`C`** at any point to cancel or clear the active route.

### Step 3: Category Filtering & Visual Highlighting
1. Press **`/`** to reopen search.
2. Click any category chip at the top of the search modal (e.g. **`bench`**, **`table`**, or **`door`**).
3. The results list filters instantly to matching POIs. In the 3D scene, matching POI markers glow with accented halos while non-matching markers dim, providing rapid visual orientation.

### Step 4: Typo Tolerance & Multi-Token Matching
1. In the search box, test intentional typos or aliases:
   * Type `"dor"` $\rightarrow$ matches `"door"`.
   * Type `"tabel"` $\rightarrow$ matches `"black table"` and `"study table"`.
   * Type `"inch tape"` $\rightarrow$ matches `"measuring tape"` via alias expansion.
2. Click the **"Jump"** button next to any result:
   * The camera executes a smooth cinematic quadratic ease-in-out transition directly to the viewing position, oriented facing the landmark.

### Step 5: In-Viewer POI Authoring Mode
1. Press **`P`** to toggle POI Authoring Mode.
2. Notice the top `"EDIT POIs"` badge and authoring toolbar.
3. Click anywhere on the 3D floor splat or on the 2D minimap (press **`B`** to view minimap).
4. A new authoring pin drops and the edit modal opens, displaying the snapped walkable anchor coordinates and clearance.
5. Close the modal and press **`P`** again to exit edit mode without altering saved production data.

### Step 6: Navigation Debug Overlay
1. Press **`O`** to toggle the navigation debug visualizer.
2. The 3D scene displays the underlying distance field, path waypoints, and clearance vectors, demonstrating real-time occupancy grid alignment.

---

## Round 2 Criteria-to-Implementation Mapping

| Evaluation Criterion | Implementation Details | Key Source Files | Automated Tests |
|---|---|---|---|
| **Spatial Indexing & POI Tagging** | Structured POI data model with 2D spatial hash grid index ($1.0\text{ m}$ bucket size), multi-zone support (circles, rectangles, polygons), anchor snapping to walkable cells with $\ge 0.20\text{ m}$ clearance, and live Three.js 3D billboard markers with distance LOD. | [`viewer/src/poi/poi_types.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/poi/poi_types.ts)<br>[`viewer/src/poi/loader.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/poi/loader.ts)<br>[`viewer/src/poi/spatial_index.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/poi/spatial_index.ts)<br>[`viewer/src/ui/poi_overlay.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/ui/poi_overlay.ts)<br>[`viewer/src/ui/poi_authoring.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/ui/poi_authoring.ts) | `test/poi.test.ts` (32 tests) |
| **Pathfinding Accuracy** | 8-connected A* search on $0.10\text{ m}$ occupancy grid with octile heuristic. Raycast string-pulling smooths stepped paths into natural lines of sight. Validated 100% collision-free rate (9073/9073 test samples), $0.990$ mean ratio vs Dijkstra optimum, and $0.38\text{ ms}$ average compute time across 72 POI pairs. | [`viewer/src/nav/navgrid.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/nav/navgrid.ts)<br>[`viewer/src/nav/pathfinder.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/nav/pathfinder.ts)<br>[`viewer/src/nav/distanceField.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/nav/distanceField.ts)<br>[`viewer/src/nav/instructions.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/nav/instructions.ts)<br>[`viewer/src/nav/route_state.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/nav/route_state.ts) | `test/nav.test.ts` (17 tests)<br>`test/navigation_guidance.test.ts` (32 tests) |
| **Search UI & Transition** | Real-time search modal with category chips, Damerau-Levenshtein fuzzy matching (edit distance $\le 2$), alias lookup, multi-token scoring, cinematic camera jumps with quadratic easing, turn-by-turn guidance HUD with monotonic progress tracking, and dynamic re-routing if the player drifts $> 0.50\text{ m}$ off-path. | [`viewer/src/poi/search.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/poi/search.ts)<br>[`viewer/src/ui/search_bar.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/ui/search_bar.ts)<br>[`viewer/src/ui/jump_controller.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/ui/jump_controller.ts)<br>[`viewer/src/ui/guidance_hud.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/ui/guidance_hud.ts)<br>[`viewer/src/ui/navigation_controller.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/ui/navigation_controller.ts)<br>[`viewer/src/ui/route_renderer.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/src/ui/route_renderer.ts) | `test/search_ui.test.ts` (24 tests)<br>`test/navigation_guidance.test.ts` (32 tests) |
| **Code Cleanliness & Repository Setup** | Pure TypeScript modular architecture, zero runtime bundle bloat (zero new production dependencies added for Round 2), strict typechecking (`tsc --noEmit`), 140 passing automated Vitest tests, comprehensive documentation, and lightweight Cloudflare Worker asset deployment under 25 MiB. | [`viewer/package.json`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/package.json)<br>[`viewer/vite.config.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/viewer/vite.config.ts)<br>[`scripts/validate_pois.ts`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/scripts/validate_pois.ts)<br>[`docs/SOP.md`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/docs/SOP.md)<br>[`docs/NAV_EVAL.md`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/docs/NAV_EVAL.md)<br>[`README.md`](file:///c:/Users/parth/OneDrive/Desktop/Namma_Space/README.md) | Full test suite: 140 passed |

---

## Third-Party Libraries & Licences Audit

All dependencies are strictly inspected from `viewer/package.json` and resolved in `node_modules/`:

| Library / Package | Resolved Version | License | Purpose in Project |
|---|---|---|---|
| **`@sparkjsdev/spark`** | `2.4.0` | **MIT** | Core WebGL Gaussian Splatting rendering engine (`SparkRenderer`, `SplatMesh`). |
| **`three`** | `0.186.1` | **MIT** | WebGL 3D scene graph, camera transformations, vectors, raycasting, and matrix math. |
| **`typescript`** | `5.9.3` (`^5.4`) | **Apache-2.0** | Static typing and compilation for viewer source and pipeline scripts. |
| **`vite`** | `5.4.21` (`^5.4`) | **MIT** | Build tool, bundling, and local development server. |
| **`vitest`** | `2.1.9` (`^2.1.9`) | **MIT** | Unit and integration test runner for pathfinding, collision, and search algorithms. |

> **Audit Guarantee**: No new runtime npm dependencies were introduced for Round 2. All spatial indexing, A* pathfinding, line-of-sight smoothing, fuzzy search, and guidance HUD calculations are implemented in pure, zero-dependency TypeScript.
