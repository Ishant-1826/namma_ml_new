import { describe, it, expect } from "vitest";
import {
  easeInOutCubic,
  normalizeAngleRad,
  interpolateAngleRad,
  computeFacingYaw,
  DistanceFieldGate,
  extractCategories,
  filterPOIsByCategory,
  getEffectiveCategory,
  getPOIHighlightState,
} from "../src/poi/jump_math";
import { POI } from "../src/poi/poi_types";

describe("Phase 4 Pure Math & Search Helpers (jump_math.ts)", () => {
  describe("1. easeInOutCubic", () => {
    it("anchors at t=0 and t=1", () => {
      expect(easeInOutCubic(0)).toBeCloseTo(0, 5);
      expect(easeInOutCubic(1)).toBeCloseTo(1, 5);
    });

    it("evaluates midpoint at exactly 0.5", () => {
      expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5);
    });

    it("increases monotonically across [0, 1]", () => {
      let prev = -1;
      for (let t = 0; t <= 1; t += 0.05) {
        const val = easeInOutCubic(t);
        expect(val).toBeGreaterThanOrEqual(prev);
        prev = val;
      }
    });

    it("clamps out-of-bounds t", () => {
      expect(easeInOutCubic(-0.5)).toBe(0);
      expect(easeInOutCubic(1.5)).toBe(1);
    });
  });

  describe("2. normalizeAngleRad & interpolateAngleRad", () => {
    it("normalizes angles into [-PI, PI]", () => {
      expect(normalizeAngleRad(0)).toBeCloseTo(0, 5);
      expect(normalizeAngleRad(Math.PI * 3)).toBeCloseTo(Math.PI, 5);
      expect(normalizeAngleRad(-Math.PI * 3)).toBeCloseTo(-Math.PI, 5);
      expect(normalizeAngleRad(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 5);
    });

    it("interpolates shortest angular path across the wrap-around boundary", () => {
      // 170 deg (2.967 rad) to -170 deg (-2.967 rad).
      // Shortest path goes through 180 deg (Math.PI), delta is +20 deg (+0.349 rad).
      const start = (170 * Math.PI) / 180;
      const target = (-170 * Math.PI) / 180;
      const mid = interpolateAngleRad(start, target, 0.5);

      // Midpoint should be exactly Math.PI or -Math.PI
      expect(Math.abs(normalizeAngleRad(mid))).toBeCloseTo(Math.PI, 4);
    });

    it("interpolates straight angles accurately", () => {
      expect(interpolateAngleRad(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 5);
      expect(interpolateAngleRad(Math.PI / 2, 0, 0.5)).toBeCloseTo(Math.PI / 4, 5);
    });
  });

  describe("3. computeFacingYaw", () => {
    it("faces North (-Z) with yaw = 0", () => {
      const yaw = computeFacingYaw(0, 0, 0, -2);
      expect(yaw).toBeCloseTo(0, 5);
    });

    it("faces South (+Z) with yaw = PI or -PI", () => {
      const yaw = computeFacingYaw(0, 0, 0, 2);
      expect(Math.abs(yaw)).toBeCloseTo(Math.PI, 5);
    });

    it("faces East (+X) with yaw = -PI/2 (turning right from North)", () => {
      const yaw = computeFacingYaw(0, 0, 2, 0);
      expect(yaw).toBeCloseTo(-Math.PI / 2, 5);
    });

    it("faces West (-X) with yaw = +PI/2 (turning left from North)", () => {
      const yaw = computeFacingYaw(0, 0, -2, 0);
      expect(yaw).toBeCloseTo(Math.PI / 2, 5);
    });

    it("handles coincident anchor and pin without NaN", () => {
      const yaw = computeFacingYaw(1.5, 2.5, 1.5, 2.5);
      expect(Number.isFinite(yaw)).toBe(true);
      expect(yaw).toBe(0);
    });
  });

  describe("4. DistanceFieldGate (0.5m gate)", () => {
    it("forces recompute when uninitialized or force=true", () => {
      const gate = new DistanceFieldGate(0.5);
      expect(gate.shouldRecompute({ x: 0, z: 0 })).toBe(true);
      expect(gate.shouldRecompute({ x: 0, z: 0 }, true)).toBe(true);
    });

    it("does NOT recompute when player moves < 0.5 m", () => {
      const gate = new DistanceFieldGate(0.5);
      gate.updateField({ x: 0, z: 0 }, new Float32Array(10));

      expect(gate.shouldRecompute({ x: 0.2, z: 0.1 })).toBe(false); // ~0.22 m
      expect(gate.shouldRecompute({ x: 0.3, z: 0.3 })).toBe(false); // ~0.42 m
    });

    it("DOES recompute when player moves >= 0.5 m", () => {
      const gate = new DistanceFieldGate(0.5);
      gate.updateField({ x: 0, z: 0 }, new Float32Array(10));

      expect(gate.shouldRecompute({ x: 0.5, z: 0 })).toBe(true); // 0.5 m
      expect(gate.shouldRecompute({ x: 0.4, z: 0.4 })).toBe(true); // ~0.56 m
    });

    it("updates origin and cached field on updateField", () => {
      const gate = new DistanceFieldGate(0.5);
      const dummyField = new Float32Array([1, 2, 3]);
      gate.updateField({ x: 10, z: 20 }, dummyField);

      expect(gate.lastOrigin).toEqual({ x: 10, z: 20 });
      expect(gate.cachedField).toBe(dummyField);
    });
  });

  describe("5. extractCategories & filterPOIsByCategory", () => {
    const mockPOIs: POI[] = [
      {
        id: "poi_1",
        name: "Desk Alpha",
        category: "desk",
        aliases: [],
        tags: [],
        position: { x: 1, z: 1 },
        anchor: { x: 1, z: 1 },
      },
      {
        id: "poi_2",
        name: "Chair Beta",
        category: "chair",
        aliases: [],
        tags: [],
        position: { x: 2, z: 2 },
        anchor: { x: 2, z: 2 },
      },
      {
        id: "poi_3",
        name: "Desk Gamma",
        category: "desk",
        aliases: [],
        tags: [],
        position: { x: 3, z: 3 },
        anchor: { x: 3, z: 3 },
      },
      {
        id: "poi_4",
        name: "Table Delta",
        category: "table",
        aliases: [],
        tags: [],
        position: { x: 4, z: 4 },
        anchor: { x: 4, z: 4 },
      },
    ];

    it("extracts sorted unique categories", () => {
      const cats = extractCategories(mockPOIs);
      expect(cats).toEqual(["chair", "desk", "table"]);
    });

    it("filters by category correctly", () => {
      const desks = filterPOIsByCategory(mockPOIs, "desk");
      expect(desks.length).toBe(2);
      expect(desks.map((d) => d.poi.id)).toContain("poi_1");
      expect(desks.map((d) => d.poi.id)).toContain("poi_3");
    });

    it("returns all when category is null", () => {
      const all = filterPOIsByCategory(mockPOIs, null);
      expect(all.length).toBe(4);
    });

    it("filters exactly 3 POIs of matching category out of 5 with case and whitespace insensitivity", () => {
      const fixturePOIs: POI[] = [
        {
          id: "poi_table_1",
          name: "Study Table",
          category: " Table ",
          aliases: [],
          tags: [],
          position: { x: 1, z: 1 },
          anchor: { x: 1, z: 1 },
        },
        {
          id: "poi_table_2",
          name: "Black Table",
          category: "TABLE",
          aliases: [],
          tags: [],
          position: { x: 2, z: 2 },
          anchor: { x: 2, z: 2 },
        },
        {
          id: "poi_table_3",
          name: "Dining Table",
          category: "table",
          aliases: [],
          tags: [],
          position: { x: 3, z: 3 },
          anchor: { x: 3, z: 3 },
        },
        {
          id: "poi_chair_1",
          name: "Office Chair",
          category: " Chair ",
          aliases: [],
          tags: [],
          position: { x: 4, z: 4 },
          anchor: { x: 4, z: 4 },
        },
        {
          id: "poi_chair_2",
          name: "Arm Chair",
          category: "CHAIR",
          aliases: [],
          tags: [],
          position: { x: 5, z: 5 },
          anchor: { x: 5, z: 5 },
        },
      ];

      // Query with mixed case and extra whitespace
      const resultsWithWhitespace = filterPOIsByCategory(fixturePOIs, "  tAbLe  ");
      expect(resultsWithWhitespace.length).toBe(3);
      expect(resultsWithWhitespace.map((r) => r.poi.id).sort()).toEqual([
        "poi_table_1",
        "poi_table_2",
        "poi_table_3",
      ]);

      // Query with uppercase
      const resultsUppercase = filterPOIsByCategory(fixturePOIs, "TABLE");
      expect(resultsUppercase.length).toBe(3);
      expect(resultsUppercase.map((r) => r.poi.id).sort()).toEqual([
        "poi_table_1",
        "poi_table_2",
        "poi_table_3",
      ]);

      // Filter for chair returns exactly the 2 chairs
      const chairResults = filterPOIsByCategory(fixturePOIs, "chair");
      expect(chairResults.length).toBe(2);
      expect(chairResults.map((r) => r.poi.id).sort()).toEqual([
        "poi_chair_1",
        "poi_chair_2",
      ]);
    });
  });

  describe("6. getPOIHighlightState & getEffectiveCategory", () => {
    const fixture: POI[] = [
      {
        id: "poi_1",
        name: "Study Table",
        category: " Table ",
        aliases: [],
        tags: [],
        position: { x: 1, z: 1 },
        anchor: { x: 1, z: 1 },
      },
      {
        id: "poi_2",
        name: "Black Table",
        category: "TABLE",
        aliases: [],
        tags: [],
        position: { x: 2, z: 2 },
        anchor: { x: 2, z: 2 },
      },
      {
        id: "poi_3",
        name: "Office Chair",
        category: "Chair",
        aliases: [],
        tags: [],
        position: { x: 3, z: 3 },
        anchor: { x: 3, z: 3 },
      },
    ];

    it("returns expected highlight state for 2 matching POIs, 1 other, and 1 selected id (case/whitespace-insensitive)", () => {
      // poi_1 is selected (category: ' Table ')
      const selectedId = "poi_1";
      const effectiveCategory = getEffectiveCategory(null, selectedId, fixture);
      expect(effectiveCategory).toBe("table");

      expect(getPOIHighlightState(fixture[0], selectedId, effectiveCategory)).toBe("selected");
      expect(getPOIHighlightState(fixture[1], selectedId, effectiveCategory)).toBe("match");
      expect(getPOIHighlightState(fixture[2], selectedId, effectiveCategory)).toBe("dimmed");
    });

    it("returns expected highlight state when an explicit category chip is active", () => {
      // Active chip is '  tAbLe  ' with no selection
      const effectiveCategory = getEffectiveCategory("  tAbLe  ", null, fixture);
      expect(effectiveCategory).toBe("table");

      expect(getPOIHighlightState(fixture[0], null, effectiveCategory)).toBe("match");
      expect(getPOIHighlightState(fixture[1], null, effectiveCategory)).toBe("match");
      expect(getPOIHighlightState(fixture[2], null, effectiveCategory)).toBe("dimmed");
    });

    it("selected green wins over category match if both apply", () => {
      // Both active chip 'table' and poi_2 is selected
      const selectedId = "poi_2";
      const effectiveCategory = getEffectiveCategory("table", selectedId, fixture);

      expect(getPOIHighlightState(fixture[0], selectedId, effectiveCategory)).toBe("match");
      expect(getPOIHighlightState(fixture[1], selectedId, effectiveCategory)).toBe("selected");
      expect(getPOIHighlightState(fixture[2], selectedId, effectiveCategory)).toBe("dimmed");
    });

    it("returns normal for all POIs when neither a chip nor a selection is active", () => {
      const effectiveCategory = getEffectiveCategory(null, null, fixture);
      expect(effectiveCategory).toBeNull();

      expect(getPOIHighlightState(fixture[0], null, effectiveCategory)).toBe("normal");
      expect(getPOIHighlightState(fixture[1], null, effectiveCategory)).toBe("normal");
      expect(getPOIHighlightState(fixture[2], null, effectiveCategory)).toBe("normal");
    });
  });
});
