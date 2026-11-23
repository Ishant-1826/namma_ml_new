/**
 * poi_types.ts
 * Data model for Points of Interest (POIs) in Namma Space.
 * Pure TypeScript: NO Three.js and NO DOM imports.
 */

export interface CircleZone {
  type: "circle";
  radius: number;
}

export interface RectZone {
  type: "rect";
  width: number;
  depth: number;
  yaw: number; // yaw in radians
}

export interface PolygonZone {
  type: "polygon";
  points: Array<{ x: number; z: number }>;
}

export type POIZone = CircleZone | RectZone | PolygonZone;

export interface POI {
  id: string;
  name: string;
  category: string;
  aliases: string[];
  tags: string[];
  position: { x: number; z: number };
  height?: number;
  zone?: POIZone;
  anchor: { x: number; z: number }; // computed navigable coordinate on walkable===1 cell
  description?: string;
  unreachable?: boolean;
}

export interface RawPOIZoneCircle {
  type?: "circle";
  radius: number;
}

export interface RawPOIZoneRect {
  type?: "rect";
  width?: number;
  depth?: number;
  w?: number;
  d?: number;
  yaw?: number;
}

export interface RawPOIZonePolygon {
  type?: "polygon";
  points: Array<{ x: number; z: number }>;
}

export type RawPOIZone = RawPOIZoneCircle | RawPOIZoneRect | RawPOIZonePolygon;

export interface RawPOI {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  aliases?: unknown;
  tags?: unknown;
  position?: unknown;
  height?: unknown;
  zone?: unknown;
  anchor?: unknown;
  description?: unknown;
}

export interface POISceneFile {
  scene: string;
  version: 1;
  pois: RawPOI[];
}
