/**
 * poi.test.ts
 * Unit tests for POI data model, loader, spatial index, and search engine.
 * Pure TypeScript: Uses an in-test synthetic fixture (NOT public/scene).
 */

import { describe, it, expect } from "vitest";
import { OccupancyGrid } from "../src/collision";
import { NavGrid } from "../src/nav/navgrid";
import { POI, RawPOI } from "../src/poi/poi_types";
import { loadPOIs, resolvePOIDataSource } from "../src/poi/loader";
import {
  SpatialIndex,
  isPointInCircle,
  isPointInRect,
  isPointInPolygon,
  isPointInZone,
} from "../src/poi/spatial_index";
import {
  searchPOIs,
  damerauLevenshtein,
  normalizeToken,
  tokenizeText,
} from "../src/poi/search";

/**
 * Creates an in-test synthetic NavGrid.
 */
function createSyntheticGrid(
  width = 20,
  height = 20,
  blockedCoords: Array<[number, number]> = [],
  origin: [number, number] = [0, 0],
  cellSize = 0.5
): NavGrid {
  const data = new Uint8Array(width * height);
  for (const [c, r] of blockedCoords) {
    if (c >= 0 && c < width && r >= 0 && r < height) {
      data[r * width + c] = 1;
    }
  }

  const occ: OccupancyGrid = {
    origin,
    cell_size: cellSize,
    width,
    height,
    data,
  };

  return new NavGrid(occ, [origin[0] + 0.25, origin[1] + 0.25]);
}

describe("Phase 2 POI Data Model, Spatial Index & Search", () => {
  // =========================================================================
  // 1. Zone Hit Tests
  // =========================================================================
  describe("1. Zone Hit Tests", () => {
    it("circle: correctly tests interior, boundary and exterior points", () => {
      // Circle at center (0, 0) with radius 2.0
      expect(isPointInCircle(0.0, 0.0, 0.0, 0.0, 2.0)).toBe(true);
      expect(isPointInCircle(1.0, 1.0, 0.0, 0.0, 2.0)).toBe(true); // dist = 1.414 < 2
      expect(isPointInCircle(2.0, 0.0, 0.0, 0.0, 2.0)).toBe(true); // boundary
      expect(isPointInCircle(0.0, -2.0, 0.0, 0.0, 2.0)).toBe(true); // boundary
      expect(isPointInCircle(2.0, 0.05, 0.0, 0.0, 2.0)).toBe(false); // outside
      expect(isPointInCircle(1.5, 1.5, 0.0, 0.0, 2.0)).toBe(false); // dist = 2.121 > 2
    });

    it("rect (axis-aligned): correctly tests points inside and outside", () => {
      // Rect at center (1.0, 2.0) with width 4.0 (x in [-1, 3]) and depth 2.0 (z in [1, 3]), yaw = 0
      expect(isPointInRect(1.0, 2.0, 1.0, 2.0, 4.0, 2.0, 0.0)).toBe(true); // center
      expect(isPointInRect(2.5, 2.5, 1.0, 2.0, 4.0, 2.0, 0.0)).toBe(true); // interior
      expect(isPointInRect(3.0, 3.0, 1.0, 2.0, 4.0, 2.0, 0.0)).toBe(true); // corner boundary
      expect(isPointInRect(3.1, 2.0, 1.0, 2.0, 4.0, 2.0, 0.0)).toBe(false); // outside X
      expect(isPointInRect(1.0, 3.1, 1.0, 2.0, 4.0, 2.0, 0.0)).toBe(false); // outside Z
      expect(isPointInRect(-1.1, 2.0, 1.0, 2.0, 4.0, 2.0, 0.0)).toBe(false);
    });

    it("rect (rotated with yaw): correctly tests oriented rectangle", () => {
      // Rect at center (0, 0) with width 4.0, depth 2.0, yaw = pi/4 (45 degrees)
      const yaw = Math.PI / 4;
      expect(isPointInRect(0.0, 0.0, 0.0, 0.0, 4.0, 2.0, yaw)).toBe(true);

      // Along major axis (length 4.0, half-width 2.0 at 45 deg):
      // point at distance 1.5 along 45 deg: (1.5 * cos(45), 1.5 * sin(45)) = (1.06, 1.06)
      const cos45 = Math.cos(yaw);
      const sin45 = Math.sin(yaw);
      expect(isPointInRect(1.5 * cos45, 1.5 * sin45, 0.0, 0.0, 4.0, 2.0, yaw)).toBe(true);

      // Point at distance 2.5 along 45 deg (> half-width 2.0)
      expect(isPointInRect(2.5 * cos45, 2.5 * sin45, 0.0, 0.0, 4.0, 2.0, yaw)).toBe(false);

      // Along minor axis (depth 2.0, half-depth 1.0 at 135 deg / perpendicular):
      // point at distance 0.8: inside
      expect(isPointInRect(-0.8 * sin45, 0.8 * cos45, 0.0, 0.0, 4.0, 2.0, yaw)).toBe(true);
      // point at distance 1.2: outside
      expect(isPointInRect(-1.2 * sin45, 1.2 * cos45, 0.0, 0.0, 4.0, 2.0, yaw)).toBe(false);
    });

    it("polygon: tests convex and non-convex polygons via ray casting", () => {
      // Convex triangle: (0, 0), (4, 0), (2, 4)
      const tri = [
        { x: 0, z: 0 },
        { x: 4, z: 0 },
        { x: 2, z: 4 },
      ];
      expect(isPointInPolygon(2.0, 1.0, tri)).toBe(true);
      expect(isPointInPolygon(2.0, 3.5, tri)).toBe(true);
      expect(isPointInPolygon(0.0, 0.0, tri)).toBe(true); // vertex
      expect(isPointInPolygon(2.0, 5.0, tri)).toBe(false); // above apex
      expect(isPointInPolygon(-1.0, 1.0, tri)).toBe(false); // left of base

      // Non-convex L-shaped polygon:
      // (0,0) -> (4,0) -> (4,2) -> (2,2) -> (2,4) -> (0,4)
      const lShape = [
        { x: 0, z: 0 },
        { x: 4, z: 0 },
        { x: 4, z: 2 },
        { x: 2, z: 2 },
        { x: 2, z: 4 },
        { x: 0, z: 4 },
      ];
      expect(isPointInPolygon(1.0, 1.0, lShape)).toBe(true); // bottom-left
      expect(isPointInPolygon(3.0, 1.0, lShape)).toBe(true); // bottom-right
      expect(isPointInPolygon(1.0, 3.0, lShape)).toBe(true); // top-left
      expect(isPointInPolygon(3.0, 3.0, lShape)).toBe(false); // inside the cutout (outside L)
      expect(isPointInPolygon(5.0, 1.0, lShape)).toBe(false); // far right
    });

    it("isPointInZone: delegates correctly to zone or pin radius", () => {
      const pinPOI: POI = {
        id: "pin1",
        name: "Simple Pin",
        category: "bench",
        aliases: [],
        tags: [],
        position: { x: 5.0, z: 5.0 },
        anchor: { x: 5.0, z: 5.0 },
      };

      expect(isPointInZone(5.1, 5.1, pinPOI, 0.3)).toBe(true);
      expect(isPointInZone(5.5, 5.5, pinPOI, 0.3)).toBe(false);

      const circlePOI: POI = {
        ...pinPOI,
        id: "circ1",
        zone: { type: "circle", radius: 1.5 },
      };
      expect(isPointInZone(6.0, 5.0, circlePOI)).toBe(true);
      expect(isPointInZone(7.0, 5.0, circlePOI)).toBe(false);
    });
  });

  // =========================================================================
  // 2. Spatial Index Accuracy vs Brute Force (1,000 Random POIs)
  // =========================================================================
  describe("2. Spatial Index Exact Brute-Force Equivalence (1,000 Random POIs)", () => {
    // Deterministic LCG pseudo-random generator
    let seed = 123456789;
    function pseudoRandom(): number {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }

    // Generate 1,000 random POIs in [-10, 10] x [-10, 10]
    const randomPOIs: POI[] = [];
    for (let i = 0; i < 1000; i++) {
      const x = (pseudoRandom() - 0.5) * 20.0;
      const z = (pseudoRandom() - 0.5) * 20.0;
      const kind = i % 4;

      let zone: POI["zone"];
      if (kind === 1) {
        zone = { type: "circle", radius: 0.2 + pseudoRandom() * 1.5 };
      } else if (kind === 2) {
        zone = {
          type: "rect",
          width: 0.5 + pseudoRandom() * 1.5,
          depth: 0.5 + pseudoRandom() * 1.5,
          yaw: pseudoRandom() * Math.PI,
        };
      }

      randomPOIs.push({
        id: `poi_${i}`,
        name: `Random POI ${i}`,
        category: kind === 0 ? "desk" : kind === 1 ? "table" : "chair",
        aliases: [`alias_${i}`],
        tags: [`tag_${kind}`],
        position: { x, z },
        anchor: { x, z },
        zone,
      });
    }

    const index = new SpatialIndex(randomPOIs, 1.0);

    it("nearest(x, z, k) matches brute force EXACTLY for k = 1, 5, 20 across multiple query points", () => {
      const queryPoints = [
        { x: 0.0, z: 0.0 },
        { x: 4.5, z: -3.2 },
        { x: -8.1, z: 7.4 },
        { x: 12.0, z: 12.0 }, // outside bounding box
        { x: -5.0, z: -5.0 },
      ];

      for (const q of queryPoints) {
        for (const k of [1, 5, 20]) {
          const indexRes = index.nearest(q.x, q.z, k);

          // Brute force: compute distance to all 1000 POIs, sort ascending, slice k
          const bruteRes = randomPOIs
            .map((p) => ({
              poi: p,
              distance: Math.hypot(p.position.x - q.x, p.position.z - q.z),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, k);

          expect(indexRes.length).toBe(bruteRes.length);
          for (let m = 0; m < k; m++) {
            expect(indexRes[m].poi.id).toBe(bruteRes[m].poi.id);
            expect(indexRes[m].distance).toBeCloseTo(bruteRes[m].distance, 6);
          }
        }
      }
    });

    it("withinRadius(x, z, r) matches brute force EXACTLY for r = 1.0, 3.5, 8.0, 25.0", () => {
      const queryPoints = [
        { x: 0.0, z: 0.0 },
        { x: 3.2, z: 2.1 },
        { x: -7.5, z: -6.0 },
      ];

      for (const q of queryPoints) {
        for (const r of [1.0, 3.5, 8.0, 25.0]) {
          const indexRes = index.withinRadius(q.x, q.z, r);

          // Brute force
          const bruteRes = randomPOIs
            .map((p) => ({
              poi: p,
              distance: Math.hypot(p.position.x - q.x, p.position.z - q.z),
            }))
            .filter((item) => item.distance <= r + 1e-9)
            .sort((a, b) => a.distance - b.distance);

          expect(indexRes.length).toBe(bruteRes.length);
          for (let m = 0; m < indexRes.length; m++) {
            expect(indexRes[m].poi.id).toBe(bruteRes[m].poi.id);
            expect(indexRes[m].distance).toBeCloseTo(bruteRes[m].distance, 6);
          }
        }
      }
    });

    it("queryPoint(x, z) finds all POIs whose zone or pin contains the point", () => {
      // Pick a known POI with circle zone
      const target = randomPOIs.find((p) => p.zone?.type === "circle")!;
      const hits = index.queryPoint(target.position.x, target.position.z);
      expect(hits.some((h) => h.id === target.id)).toBe(true);
    });
  });

  // =========================================================================
  // 3. Search Engine
  // =========================================================================
  describe("3. Search Engine (Tokens, Fuzzy, Aliases, Plurals, Categories)", () => {
    const fixturePOIs: POI[] = [
      {
        id: "poi_rec",
        name: "Main Reception Desk",
        category: "reception",
        aliases: ["front desk", "lobby counter"],
        tags: ["checkin", "entrance", "concierge"],
        position: { x: 1.0, z: 1.0 },
        anchor: { x: 1.0, z: 1.0 },
      },
      {
        id: "poi_desk_small",
        name: "Small Desk",
        category: "desk",
        aliases: ["workstation", "writing table"],
        tags: ["furniture", "office"],
        position: { x: 4.0, z: 4.0 },
        anchor: { x: 4.0, z: 4.0 },
      },
      {
        id: "poi_coffee",
        name: "Coffee Machine",
        category: "kitchen",
        aliases: ["coffee maker", "espresso bar"],
        tags: ["beverages", "breakroom"],
        position: { x: 5.0, z: 5.0 },
        anchor: { x: 5.0, z: 5.0 },
      },
      {
        id: "poi_sofa_1",
        name: "Executive Leather Sofa",
        category: "sofa",
        aliases: ["couch"],
        tags: ["lounge", "comfort"],
        position: { x: 2.0, z: 2.0 },
        anchor: { x: 2.0, z: 2.0 },
      },
      {
        id: "poi_sofa_2",
        name: "Corner Fabric Sectional",
        category: "sofa",
        aliases: ["settee", "l-couch"],
        tags: ["living room", "seating"],
        position: { x: 6.0, z: 8.0 },
        anchor: { x: 6.0, z: 8.0 },
      },
      {
        id: "poi_chair_1",
        name: "Ergonomic Task Chair",
        category: "chair",
        aliases: ["office chair", "swivel chair"],
        tags: ["desk", "seating"],
        position: { x: 3.0, z: 3.0 },
        anchor: { x: 3.0, z: 3.0 },
      },
      {
        id: "poi_door_1",
        name: "Emergency Exit Fire Door",
        category: "door",
        aliases: ["fire exit", "escape door"],
        tags: ["safety", "egress"],
        position: { x: 0.0, z: 9.0 },
        anchor: { x: 0.0, z: 9.0 },
      },
    ];

    it("exact name: matches full name and places it at the top", () => {
      const res = searchPOIs("Main Reception Desk", fixturePOIs);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].id).toBe("poi_rec");
      expect(res[0].poi.id).toBe("poi_rec");
      expect(res[0].score).toBeGreaterThanOrEqual(1000);
    });

    it("prefix match: matches partial words ('des' -> desk)", () => {
      const res = searchPOIs("des", fixturePOIs);
      expect(res.length).toBeGreaterThan(0);
      const ids = res.map((r) => r.id);
      expect(ids).toContain("poi_desk_small");
    });

    it("typo tolerance: 'dsk' -> desk, 'cofee' -> coffee", () => {
      const resDesk = searchPOIs("dsk", fixturePOIs);
      expect(resDesk.length).toBeGreaterThan(0);
      expect(resDesk.map((r) => r.id)).toContain("poi_desk_small");

      const resCoffee = searchPOIs("cofee", fixturePOIs);
      expect(resCoffee.length).toBeGreaterThan(0);
      expect(resCoffee[0].id).toBe("poi_coffee");
    });

    it("plural match: 'desks' -> desk", () => {
      const res = searchPOIs("desks", fixturePOIs);
      expect(res.length).toBeGreaterThan(0);
      expect(res.map((r) => r.id)).toContain("poi_desk_small");
    });

    it("alias match: queries matching alias tokens return target POI", () => {
      const res = searchPOIs("front desk", fixturePOIs);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].id).toBe("poi_rec");

      const res2 = searchPOIs("couch", fixturePOIs);
      expect(res2.length).toBeGreaterThan(0);
      expect(res2[0].id).toBe("poi_sofa_1");
    });

    it("multi-word query: 'small desk' matches Small Desk", () => {
      const res = searchPOIs("small desk", fixturePOIs);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].id).toBe("poi_desk_small");
    });

    it("empty and whitespace queries return []", () => {
      expect(searchPOIs("", fixturePOIs)).toEqual([]);
      expect(searchPOIs("   ", fixturePOIs)).toEqual([]);
    });

    it("plural normalization: 'sofas' matches singular 'sofa'", () => {
      expect(normalizeToken("sofas")).toBe("sofa");
      const res = searchPOIs("sofas", fixturePOIs);
      expect(res.length).toBe(2);
      const ids = res.map((r) => r.id);
      expect(ids).toContain("poi_sofa_1");
      expect(ids).toContain("poi_sofa_2");
    });

    it("category query: returns ALL instances of that category ('sofa' returns both sofas)", () => {
      const res = searchPOIs("sofa", fixturePOIs);
      expect(res.length).toBe(2);
      const ids = res.map((r) => r.id);
      expect(ids).toContain("poi_sofa_1");
      expect(ids).toContain("poi_sofa_2");
    });

    it("no result: unmatched query returns empty array", () => {
      const res = searchPOIs("xylophone submarine", fixturePOIs);
      expect(res).toEqual([]);
    });

    it("distance field tie-breaking: ranks closest first", () => {
      // Create a mock distance field where sofa_2 is closer than sofa_1
      const mockGrid = createSyntheticGrid(20, 20, [], [0, 0], 1.0);
      const distField = new Float32Array(20 * 20);
      distField.fill(100.0);

      // Cell for sofa 1: (2, 2) -> dist = 15.0
      distField[2 * 20 + 2] = 15.0;
      // Cell for sofa 2: (6, 8) -> dist = 4.0
      distField[8 * 20 + 6] = 4.0;

      const res = searchPOIs("sofa", fixturePOIs, distField, mockGrid);
      expect(res.length).toBe(2);
      // Both have identical category score (850), but sofa 2 is closer in distance field
      expect(res[0].id).toBe("poi_sofa_2");
      expect(res[1].id).toBe("poi_sofa_1");
      expect(res[0].walkingDistance).toBe(4.0);
      expect(res[1].walkingDistance).toBe(15.0);
    });
  });

  // =========================================================================
  // 4. Loader & Validator Error Cases
  // =========================================================================
  describe("4. Loader & Validator Error Cases", () => {
    // 10m x 10m synthetic grid: origin [0, 0], cellSize = 0.5m (20 x 20 cells)
    // Wall across x in [4..5] except open door
    const grid = createSyntheticGrid(20, 20, [[10, 10]], [0, 0], 0.5);

    it("reports error for duplicate POI id", () => {
      const raw: RawPOI[] = [
        { id: "desk_1", name: "Desk One", position: { x: 2.0, z: 2.0 } },
        { id: "desk_1", name: "Desk Two", position: { x: 3.0, z: 3.0 } },
      ];
      const res = loadPOIs(raw, grid);
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]).toContain('Duplicate POI id: "desk_1"');
      expect(res.pois.length).toBe(1);
    });

    it("reports error for missing or empty name", () => {
      const raw: RawPOI[] = [
        { id: "p1", name: "", position: { x: 2.0, z: 2.0 } },
        { id: "p2", position: { x: 2.0, z: 2.0 } },
        { id: "p3", name: "   ", position: { x: 2.0, z: 2.0 } },
      ];
      const res = loadPOIs(raw, grid);
      expect(res.errors.length).toBe(3);
      expect(res.errors[0]).toContain("missing or empty name");
      expect(res.errors[1]).toContain("missing or empty name");
      expect(res.errors[2]).toContain("missing or empty name");
    });

    it("reports error for NaN or non-finite position numbers", () => {
      const raw: RawPOI[] = [
        { id: "p1", name: "NaN X", position: { x: NaN, z: 2.0 } },
        { id: "p2", name: "Inf Z", position: { x: 2.0, z: Infinity } },
      ];
      const res = loadPOIs(raw, grid);
      expect(res.errors.length).toBe(2);
      expect(res.errors[0]).toContain("non-finite position");
      expect(res.errors[1]).toContain("non-finite position");
    });

    it("reports error for position outside grid bounds", () => {
      // Grid bounds: [0, 10] x [0, 10]
      const raw: RawPOI[] = [
        { id: "p1", name: "Far Outside", position: { x: 50.0, z: 50.0 } },
        { id: "p2", name: "Negative Outside", position: { x: -5.0, z: 2.0 } },
      ];
      const res = loadPOIs(raw, grid);
      expect(res.errors.length).toBe(2);
      expect(res.errors[0]).toContain("outside grid bounds");
      expect(res.errors[1]).toContain("outside grid bounds");
    });

    it("reports error for malformed zones", () => {
      const raw: RawPOI[] = [
        {
          id: "p1",
          name: "Bad Circle",
          position: { x: 2.0, z: 2.0 },
          zone: { type: "circle", radius: -1.0 },
        },
        {
          id: "p2",
          name: "Bad Rect",
          position: { x: 2.0, z: 2.0 },
          zone: { type: "rect", width: 0, depth: 2.0 },
        },
        {
          id: "p3",
          name: "Bad Poly",
          position: { x: 2.0, z: 2.0 },
          zone: { type: "polygon", points: [{ x: 1, z: 1 }] }, // < 3 points
        },
      ];
      const res = loadPOIs(raw, grid);
      expect(res.errors.length).toBe(3);
      expect(res.errors[0]).toContain("malformed circle zone");
      expect(res.errors[1]).toContain("malformed rect zone");
      expect(res.errors[2]).toContain("malformed polygon zone");
    });

    it("marks unreachable POI if snapToWalkable returns null", () => {
      // 5x5 grid with all cells blocked
      const allBlockedGrid = createSyntheticGrid(
        5,
        5,
        Array.from({ length: 25 }, (_, i) => [i % 5, Math.floor(i / 5)]),
        [0, 0],
        1.0
      );

      const raw: RawPOI[] = [
        { id: "p_unreach", name: "Unreachable Box", position: { x: 2.0, z: 2.0 } },
      ];
      const res = loadPOIs(raw, allBlockedGrid, { maxSnapDistM: 1.0 });
      expect(res.pois.length).toBe(1);
      expect(res.pois[0].unreachable).toBe(true);
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.warnings[0]).toContain("is unreachable");
    });

    it("warns when anchor moves > 1 m from the pin", () => {
      // Create a grid where only cell (0, 0) is walkable and all other cells in rows 0..2 are blocked
      const blockedCells: Array<[number, number]> = [];
      for (let c = 1; c < 20; c++) {
        for (let r = 0; r < 5; r++) {
          blockedCells.push([c, r]);
        }
      }
      const wallGrid = createSyntheticGrid(20, 20, blockedCells, [0, 0], 0.5);

      // POI placed at x = 1.80, z = 0.25 (inside blocked cell col=3, row=0)
      // Nearest walkable cell is (0, 0) center at (0.25, 0.25), distance = 1.55 m (> 1.0 m)
      const raw: RawPOI[] = [
        { id: "p_far_pin", name: "Far Pin POI", position: { x: 1.8, z: 0.25 } },
      ];
      const res = loadPOIs(raw, wallGrid, { warnSnapThresholdM: 1.0, maxSnapDistM: 3.0 });
      expect(res.pois.length).toBe(1);
      expect(res.warnings.length).toBe(1);
      expect(res.warnings[0]).toContain("anchor moved");
      expect(res.warnings[0]).toContain("> 1 m");
    });
  });

  // =========================================================================
  // 6. POI Data Source Resolution (Server vs Draft)
  // =========================================================================
  describe("6. POI Data Source Resolution", () => {
    const serverPOI = { scene: "home", version: 1, pois: [{ id: "p1", name: "Server Desk", position: { x: 1, z: 1 } }] };
    const draftPOI = { scene: "home", version: 1, pois: [{ id: "p1", name: "Draft Desk Edited", position: { x: 2, z: 2 } }] };

    it("server poi.json wins over localStorage draft in normal viewing", () => {
      const res = resolvePOIDataSource(serverPOI, draftPOI, false);
      expect(res.source).toBe("server");
      expect(res.data).toBe(serverPOI);
    });

    it("localStorage draft is used as fallback when server data is null", () => {
      const res = resolvePOIDataSource(null, draftPOI, false);
      expect(res.source).toBe("draft");
      expect(res.data).toBe(draftPOI);
    });

    it("localStorage draft is used as fallback when server data has empty POIs", () => {
      const emptyServer = { scene: "home", version: 1, pois: [] };
      const res = resolvePOIDataSource(emptyServer, draftPOI, false);
      expect(res.source).toBe("draft");
      expect(res.data).toBe(draftPOI);
    });

    it("localStorage draft is used when authoring mode is active", () => {
      const res = resolvePOIDataSource(serverPOI, draftPOI, true);
      expect(res.source).toBe("draft");
      expect(res.data).toBe(draftPOI);
    });

    it("server data is used in authoring mode if draft is null", () => {
      const res = resolvePOIDataSource(serverPOI, null, true);
      expect(res.source).toBe("server");
      expect(res.data).toBe(serverPOI);
    });

    it("returns none when both server and draft are missing", () => {
      const res = resolvePOIDataSource(null, null, false);
      expect(res.source).toBe("none");
      expect(res.data).toBeNull();
    });
  });
});
