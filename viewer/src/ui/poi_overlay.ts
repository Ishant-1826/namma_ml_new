/**
 * poi_overlay.ts
 * Manages 3D visual representations of Points of Interest (POIs) in Three.js.
 * - Billboard sprites for floating pins & labels with constant on-screen size.
 * - Distance fade beyond ~8 m (6 m to 8 m linear fade).
 * - Render with depthTest: false and high renderOrder so splats never occlude them.
 * - Screen-space and ground-plane raycasting hit tests (zero heap allocation).
 * - Snapped anchor visualizer (small green dot on floor).
 * - Red warning state for unreachable anchors or displacement > 1 m.
 */

import * as THREE from "three";
import { POI } from "../poi/poi_types";
import { SpatialIndex } from "../poi/spatial_index";

export interface POIOverlayOptions {
  renderOrder?: number;
  pinHeightM?: number;
  fadeStartM?: number;
  fadeEndM?: number;
  screenScale?: number;
}

interface POIMarkerData {
  poi: POI;
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  stemMesh: THREE.Line;
  anchorMesh: THREE.Mesh;
  zoneMesh?: THREE.Line;
  isWarning: boolean;
}

export class POIOverlay {
  readonly group: THREE.Group;
  private readonly markers = new Map<string, POIMarkerData>();
  private _labelsVisible = true;
  private _authoringActive = false;
  private _selectedPOIId: string | null = null;

  private readonly renderOrder: number;
  private readonly defaultPinHeightM: number;
  private readonly fadeStartM: number;
  private readonly fadeEndM: number;
  private readonly screenScale: number;

  // Pre-allocated static / reusable vectors to guarantee ZERO heap allocation in render/hit-test loops
  private static readonly _camPos = new THREE.Vector3();
  private static readonly _projVec = new THREE.Vector3();
  private static readonly _raycaster = new THREE.Raycaster();
  private static readonly _ndcVec = new THREE.Vector2();

  // Shared geometries for stems and anchors
  private readonly _anchorGeometry: THREE.SphereGeometry;
  private readonly _anchorMaterialValid: THREE.MeshBasicMaterial;
  private readonly _anchorMaterialWarn: THREE.MeshBasicMaterial;
  private readonly _stemMaterial: THREE.LineBasicMaterial;
  private readonly _stemMaterialWarn: THREE.LineBasicMaterial;

  constructor(options: POIOverlayOptions = {}) {
    this.group = new THREE.Group();
    this.group.name = "poi_overlay_group";

    this.renderOrder = options.renderOrder ?? 9999;
    this.defaultPinHeightM = options.pinHeightM ?? 1.2;
    this.fadeStartM = options.fadeStartM ?? 6.0;
    this.fadeEndM = options.fadeEndM ?? 8.0;
    this.screenScale = options.screenScale ?? 0.09;

    // Shared reusable anchor geometries and materials
    this._anchorGeometry = new THREE.SphereGeometry(0.04, 8, 8);
    this._anchorMaterialValid = new THREE.MeshBasicMaterial({
      color: 0x38ef7d, // Crisp green for valid snapped anchor
      depthTest: false,
    });
    this._anchorMaterialWarn = new THREE.MeshBasicMaterial({
      color: 0xef4444, // Red alert for unreachable/displaced anchor
      depthTest: false,
    });
    this._stemMaterial = new THREE.LineBasicMaterial({
      color: 0x00e5ff, // Accent cyan
      transparent: true,
      opacity: 0.6,
      depthTest: false,
    });
    this._stemMaterialWarn = new THREE.LineBasicMaterial({
      color: 0xef4444,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
    });
  }

  get labelsVisible(): boolean {
    return this._labelsVisible;
  }

  setLabelsVisible(visible: boolean): void {
    this._labelsVisible = visible;
  }

  toggleLabels(): boolean {
    this._labelsVisible = !this._labelsVisible;
    return this._labelsVisible;
  }

  setAuthoringMode(active: boolean): void {
    this._authoringActive = active;
  }

  setSelectedPOI(poiId: string | null): void {
    this._selectedPOIId = poiId;
    // Re-render textures of affected markers to reflect selection glow
    for (const marker of this.markers.values()) {
      this.updateMarkerTexture(marker);
    }
  }

  /**
   * Replaces all current POI markers with a new set of POIs.
   */
  setPOIs(pois: POI[]): void {
    this.clear();
    for (const p of pois) {
      this.addOrUpdatePOI(p);
    }
  }

  /**
   * Adds or updates a single POI marker in the scene.
   */
  addOrUpdatePOI(poi: POI): void {
    const existing = this.markers.get(poi.id);
    if (existing) {
      this.removePOI(poi.id);
    }

    const pinY = poi.height ?? this.defaultPinHeightM;
    const snapDist = Math.hypot(poi.anchor.x - poi.position.x, poi.anchor.z - poi.position.z);
    const isWarning = Boolean(poi.unreachable || snapDist > 1.0);

    // 1. Create canvas texture for billboard
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 140;
    this.renderLabelCanvas(canvas, poi, isWarning, poi.id === this._selectedPOIId);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    // 2. Create billboard Sprite
    const material = new THREE.SpriteMaterial({
      map: texture,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 1.0,
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.set(poi.position.x, pinY, poi.position.z);
    sprite.center.set(0.5, 0.0); // Pin point sits at exact coordinate
    sprite.renderOrder = this.renderOrder;
    this.group.add(sprite);

    // 3. Create vertical stem line connecting floating pin to floor (y=0)
    const stemPoints = [
      new THREE.Vector3(poi.position.x, pinY, poi.position.z),
      new THREE.Vector3(poi.position.x, 0.0, poi.position.z),
    ];
    const stemGeom = new THREE.BufferGeometry().setFromPoints(stemPoints);
    const stemMesh = new THREE.Line(
      stemGeom,
      isWarning ? this._stemMaterialWarn : this._stemMaterial
    );
    stemMesh.renderOrder = this.renderOrder - 1;
    this.group.add(stemMesh);

    // 4. Snapped anchor indicator (green dot on floor, or red if warning)
    const anchorMesh = new THREE.Mesh(
      this._anchorGeometry,
      isWarning ? this._anchorMaterialWarn : this._anchorMaterialValid
    );
    anchorMesh.position.set(poi.anchor.x, 0.02, poi.anchor.z);
    anchorMesh.renderOrder = this.renderOrder;
    this.group.add(anchorMesh);

    // 5. Zone indicator outline if zone exists
    let zoneMesh: THREE.Line | undefined;
    if (poi.zone) {
      const zonePoints: THREE.Vector3[] = [];
      if (poi.zone.type === "circle") {
        const segs = 32;
        const r = poi.zone.radius;
        for (let i = 0; i <= segs; i++) {
          const theta = (i / segs) * Math.PI * 2;
          zonePoints.push(
            new THREE.Vector3(
              poi.position.x + Math.cos(theta) * r,
              0.015,
              poi.position.z + Math.sin(theta) * r
            )
          );
        }
      } else if (poi.zone.type === "rect") {
        const hw = poi.zone.width * 0.5;
        const hd = poi.zone.depth * 0.5;
        const yaw = poi.zone.yaw;
        const cosY = Math.cos(yaw);
        const sinY = Math.sin(yaw);
        const corners = [
          [-hw, -hd],
          [hw, -hd],
          [hw, hd],
          [-hw, hd],
          [-hw, -hd],
        ];
        for (const [cx, cz] of corners) {
          const rx = cx * cosY - cz * sinY;
          const rz = cx * sinY + cz * cosY;
          zonePoints.push(new THREE.Vector3(poi.position.x + rx, 0.015, poi.position.z + rz));
        }
      } else if (poi.zone.type === "polygon") {
        for (const pt of poi.zone.points) {
          zonePoints.push(new THREE.Vector3(pt.x, 0.015, pt.z));
        }
        if (poi.zone.points.length > 0) {
          zonePoints.push(new THREE.Vector3(poi.zone.points[0].x, 0.015, poi.zone.points[0].z));
        }
      }

      if (zonePoints.length > 0) {
        const zoneGeom = new THREE.BufferGeometry().setFromPoints(zonePoints);
        zoneMesh = new THREE.Line(
          zoneGeom,
          new THREE.LineBasicMaterial({
            color: isWarning ? 0xef4444 : 0x00e5ff,
            transparent: true,
            opacity: 0.45,
            depthTest: false,
          })
        );
        zoneMesh.renderOrder = this.renderOrder - 2;
        this.group.add(zoneMesh);
      }
    }

    this.markers.set(poi.id, {
      poi,
      sprite,
      material,
      texture,
      stemMesh,
      anchorMesh,
      zoneMesh,
      isWarning,
    });
  }

  removePOI(poiId: string): void {
    const marker = this.markers.get(poiId);
    if (!marker) return;

    this.group.remove(marker.sprite);
    marker.material.dispose();
    marker.texture.dispose();

    this.group.remove(marker.stemMesh);
    marker.stemMesh.geometry.dispose();

    this.group.remove(marker.anchorMesh);

    if (marker.zoneMesh) {
      this.group.remove(marker.zoneMesh);
      marker.zoneMesh.geometry.dispose();
      (marker.zoneMesh.material as THREE.Material).dispose();
    }

    this.markers.delete(poiId);
  }

  clear(): void {
    const ids = Array.from(this.markers.keys());
    for (const id of ids) {
      this.removePOI(id);
    }
  }

  /**
   * Re-draws a marker's label canvas texture.
   */
  private updateMarkerTexture(marker: POIMarkerData): void {
    const canvas = marker.texture.image as HTMLCanvasElement;
    if (canvas) {
      this.renderLabelCanvas(canvas, marker.poi, marker.isWarning, marker.poi.id === this._selectedPOIId);
      marker.texture.needsUpdate = true;
    }
  }

  /**
   * Renders the billboard badge onto a 2D canvas.
   */
  private renderLabelCanvas(
    canvas: HTMLCanvasElement,
    poi: POI,
    isWarning: boolean,
    isSelected: boolean
  ): void {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const padX = 24;
    const pillH = 92;
    const pillY = 10;
    const radius = 24;

    const themeColor = isWarning
      ? "#ef4444"
      : isSelected
      ? "#38ef7d"
      : "#00e5ff";

    // 1. Shadow glow
    ctx.shadowColor = isSelected ? "rgba(56, 239, 125, 0.6)" : "rgba(0, 0, 0, 0.75)";
    ctx.shadowBlur = isSelected ? 18 : 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 4;

    // 2. Rounded badge container
    ctx.beginPath();
    ctx.roundRect(padX, pillY, w - padX * 2, pillH, radius);
    ctx.fillStyle = "rgba(11, 15, 25, 0.92)";
    ctx.fill();

    // 3. Border stroke
    ctx.shadowColor = "transparent";
    ctx.lineWidth = isSelected ? 3.5 : 2.0;
    ctx.strokeStyle = themeColor;
    ctx.stroke();

    // 4. Downward pointer triangle at bottom center
    ctx.beginPath();
    ctx.moveTo(w / 2 - 14, pillY + pillH);
    ctx.lineTo(w / 2, pillY + pillH + 16);
    ctx.lineTo(w / 2 + 14, pillY + pillH);
    ctx.closePath();
    ctx.fillStyle = "rgba(11, 15, 25, 0.92)";
    ctx.fill();
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = 2.0;
    ctx.stroke();

    // 5. Pin status dot on the left
    const dotX = padX + 32;
    const dotY = pillY + pillH / 2;
    ctx.beginPath();
    ctx.arc(dotX, dotY, 9, 0, Math.PI * 2);
    ctx.fillStyle = themeColor;
    ctx.fill();

    // 6. Name label (bold white)
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 30px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    let displayName = poi.name;
    if (ctx.measureText(displayName).width > w - padX * 2 - 100) {
      while (displayName.length > 3 && ctx.measureText(displayName + "...").width > w - padX * 2 - 100) {
        displayName = displayName.slice(0, -1);
      }
      displayName += "...";
    }
    ctx.fillText(displayName, dotX + 22, dotY - 14);

    // 7. Category subtitle
    ctx.fillStyle = isWarning ? "#fca5a5" : "#94a3b8";
    ctx.font = "600 20px system-ui, -apple-system, sans-serif";
    const subText = isWarning
      ? (poi.unreachable ? "UNREACHABLE ANCHOR" : "ANCHOR > 1m")
      : poi.category.toUpperCase();
    ctx.fillText(subText, dotX + 22, dotY + 20);
  }

  /**
   * Render loop update:
   * - ZERO per-frame heap allocations.
   * - Computes distance-based scale for constant on-screen size.
   * - Fades out markers linearly between fadeStartM (6m) and fadeEndM (8m).
   */
  update(camera: THREE.PerspectiveCamera): void {
    POIOverlay._camPos.copy(camera.position);

    const fovRad = (camera.fov * Math.PI) / 180;
    const tanFovHalf = Math.tan(fovRad * 0.5);
    const aspect = 512 / 140; // Canvas aspect ratio

    for (const marker of this.markers.values()) {
      const pos = marker.sprite.position;
      const dx = pos.x - POIOverlay._camPos.x;
      const dy = pos.y - POIOverlay._camPos.y;
      const dz = pos.z - POIOverlay._camPos.z;
      const dist = Math.hypot(dx, dy, dz);

      // In authoring mode, keep pins fully visible so user can position them
      let alpha = 1.0;
      if (!this._authoringActive) {
        if (!this._labelsVisible) {
          alpha = 0.0;
        } else if (dist <= this.fadeStartM) {
          alpha = 1.0;
        } else if (dist >= this.fadeEndM) {
          alpha = 0.0;
        } else {
          alpha = (this.fadeEndM - dist) / (this.fadeEndM - this.fadeStartM);
        }
      }

      marker.material.opacity = alpha;
      marker.sprite.visible = alpha > 0.005;
      marker.stemMesh.visible = alpha > 0.005;
      marker.anchorMesh.visible = this._authoringActive || alpha > 0.005;
      if (marker.zoneMesh) {
        marker.zoneMesh.visible = this._authoringActive || alpha > 0.005;
      }

      // Constant on-screen scaling
      const worldHeight = 2.0 * dist * tanFovHalf * this.screenScale;
      const worldWidth = worldHeight * aspect;
      marker.sprite.scale.set(worldWidth, worldHeight, 1.0);
    }
  }

  /**
   * Performs hit test from screen coordinates (x, y) against pins and ground zones.
   * ZERO per-click heap allocation (reuses static vectors).
   */
  hitTest(
    screenX: number,
    screenY: number,
    screenWidth: number,
    screenHeight: number,
    camera: THREE.PerspectiveCamera,
    spatialIndex?: SpatialIndex
  ): POI | null {
    // 1. Test 3D billboard pin hit (screen-space distance threshold ~36 px)
    let bestPinDist = 36.0; // max hit radius in pixels
    let hitPOI: POI | null = null;

    for (const marker of this.markers.values()) {
      if (!marker.sprite.visible && !this._authoringActive) continue;

      POIOverlay._projVec.copy(marker.sprite.position);
      POIOverlay._projVec.project(camera);

      // Must be in front of near plane
      if (POIOverlay._projVec.z >= 1.0) continue;

      const px = (POIOverlay._projVec.x * 0.5 + 0.5) * screenWidth;
      const py = (-POIOverlay._projVec.y * 0.5 + 0.5) * screenHeight;

      const d = Math.hypot(px - screenX, py - screenY);
      if (d < bestPinDist) {
        bestPinDist = d;
        hitPOI = marker.poi;
      }
    }

    if (hitPOI) {
      return hitPOI;
    }

    // 2. Ground-plane raycast at y=0 tested against zones with spatialIndex.queryPoint
    if (spatialIndex) {
      POIOverlay._ndcVec.x = (screenX / screenWidth) * 2 - 1;
      POIOverlay._ndcVec.y = -(screenY / screenHeight) * 2 + 1;

      POIOverlay._raycaster.setFromCamera(POIOverlay._ndcVec, camera);
      const ray = POIOverlay._raycaster.ray;

      if (Math.abs(ray.direction.y) > 1e-5) {
        const t = -ray.origin.y / ray.direction.y;
        if (t > 0) {
          const hitX = ray.origin.x + t * ray.direction.x;
          const hitZ = ray.origin.z + t * ray.direction.z;

          const matched = spatialIndex.queryPoint(hitX, hitZ);
          if (matched.length > 0) {
            return matched[0];
          }
        }
      }
    }

    return null;
  }

  /**
   * Raycasts from screen coordinates to ground plane (y=0).
   * Returns {x, z} coordinate or null. Reuses static vectors.
   */
  raycastFloor(
    screenX: number,
    screenY: number,
    screenWidth: number,
    screenHeight: number,
    camera: THREE.PerspectiveCamera
  ): { x: number; z: number } | null {
    POIOverlay._ndcVec.x = (screenX / screenWidth) * 2 - 1;
    POIOverlay._ndcVec.y = -(screenY / screenHeight) * 2 + 1;

    POIOverlay._raycaster.setFromCamera(POIOverlay._ndcVec, camera);
    const ray = POIOverlay._raycaster.ray;

    if (Math.abs(ray.direction.y) > 1e-5) {
      const t = -ray.origin.y / ray.direction.y;
      if (t > 0) {
        return {
          x: ray.origin.x + t * ray.direction.x,
          z: ray.origin.z + t * ray.direction.z,
        };
      }
    }
    return null;
  }
}
