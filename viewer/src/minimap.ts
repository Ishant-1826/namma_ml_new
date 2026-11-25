/**
 * minimap.ts
 * Offscreen cached minimap renderer for 2D occupancy grid.
 * Key B toggles, default OFF.
 * +Z points DOWN the image (matching top.png).
 * Occupied cells dark, walkable cells light, free but not walkable cells mid-grey.
 * Supports rendering POI pins, zones, anchors, and interactive click / drag.
 */

import { OccupancyGrid } from "./collision";
import { POI, normalizeCategory } from "./poi/poi_types";
import { getEffectiveCategory, getPOIHighlightState } from "./poi/jump_math";

export class Minimap {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly _ctx: CanvasRenderingContext2D;
  private readonly _offscreenCanvas: HTMLCanvasElement;
  private readonly _offscreenCtx: CanvasRenderingContext2D;
  private _grid: OccupancyGrid | null = null;
  private _visible = false;
  private _lastDrawTime = 0;

  private _pois: POI[] = [];
  private _selectedPOIId: string | null = null;
  private _authoringActive = false;
  private _draggedPOI: POI | null = null;
  private _categoryFilter: string | null = null;
  private _pulsingPOIId: string | null = null;
  private _pulseStartTime = 0;
  private _pulseDurationMs = 2000;

  // Interaction callbacks
  public onPOIClick?: (poi: POI, event: PointerEvent) => void;
  public onMapClick?: (worldPos: { x: number; z: number }, event: PointerEvent) => void;
  public onPOIDrag?: (poi: POI, newWorldPos: { x: number; z: number }) => void;
  public onPOIDragEnd?: (poi: POI) => void;

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement("canvas");
    this.canvas.id = "minimap-canvas";
    this.canvas.width = 220;
    this.canvas.height = 220;
    this.container.appendChild(this.canvas);

    this._ctx = this.canvas.getContext("2d")!;
    this._offscreenCanvas = document.createElement("canvas");
    this._offscreenCtx = this._offscreenCanvas.getContext("2d")!;

    this.setupInteractions();
    this.setVisible(false);
  }

  setGrid(grid: OccupancyGrid): void {
    this._grid = grid;
    this._offscreenCanvas.width = grid.width;
    this._offscreenCanvas.height = grid.height;

    // Render occupancy grid ONCE into offscreen canvas
    const imgData = this._offscreenCtx.createImageData(grid.width, grid.height);
    const pixels = imgData.data;

    for (let r = 0; r < grid.height; r++) {
      for (let c = 0; c < grid.width; c++) {
        const idx = r * grid.width + c;
        const pIdx = idx * 4;
        const isOcc = grid.data[idx] === 1;
        const isWalk = grid.walkable ? grid.walkable[idx] === 1 : !isOcc;

        if (isOcc) {
          // Occupied: dark (#12151b)
          pixels[pIdx] = 18;
          pixels[pIdx + 1] = 21;
          pixels[pIdx + 2] = 27;
          pixels[pIdx + 3] = 235;
        } else if (isWalk) {
          // Walkable: light (#e2e8f0)
          pixels[pIdx] = 226;
          pixels[pIdx + 1] = 232;
          pixels[pIdx + 2] = 240;
          pixels[pIdx + 3] = 245;
        } else {
          // Free but not walkable: mid-grey (#64748b)
          pixels[pIdx] = 100;
          pixels[pIdx + 1] = 116;
          pixels[pIdx + 2] = 139;
          pixels[pIdx + 3] = 230;
        }
      }
    }

    this._offscreenCtx.putImageData(imgData, 0, 0);

    // Aspect-correct canvas size (width ~220px)
    const aspect = grid.height / grid.width;
    this.canvas.width = 220;
    this.canvas.height = Math.round(220 * aspect);
  }

  setPOIs(pois: POI[]): void {
    this._pois = pois;
  }

  setSelectedPOI(poiId: string | null): void {
    this._selectedPOIId = poiId;
  }

  pulsePOI(poiId: string, durationMs = 2000): void {
    this._pulsingPOIId = poiId;
    this._pulseStartTime = performance.now();
    this._pulseDurationMs = durationMs;
  }

  setCategoryFilter(category: string | null): void {
    const norm = normalizeCategory(category);
    this._categoryFilter = norm || null;
  }

  setAuthoringMode(active: boolean): void {
    this._authoringActive = active;
  }

  toggle(): boolean {
    this.setVisible(!this._visible);
    return this._visible;
  }

  setVisible(visible: boolean): void {
    this._visible = visible;
    this.container.classList.toggle("hidden", !visible);
  }

  get isVisible(): boolean {
    return this._visible;
  }

  /**
   * Sets up interactive pointer handlers on the minimap canvas.
   */
  private setupInteractions(): void {
    this.canvas.style.pointerEvents = "auto";
    this.canvas.style.cursor = "pointer";

    // Stop propagation so clicking minimap does not request canvas pointer-lock
    this.container.addEventListener("click", (e) => e.stopPropagation());
    this.canvas.addEventListener("click", (e) => e.stopPropagation());

    this.canvas.addEventListener("pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
      if (!this._grid) return;

      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      // Check hit against POI pins
      const hitPOI = this.findPOIAtPixel(px, py, 10.0);
      if (hitPOI) {
        if (this._authoringActive) {
          this._draggedPOI = hitPOI;
          this.canvas.setPointerCapture(e.pointerId);
        }
        if (this.onPOIClick) {
          this.onPOIClick(hitPOI, e);
        }
      } else {
        const world = this.pixelToWorld(px, py);
        if (this.onMapClick) {
          this.onMapClick(world, e);
        }
      }
    });

    this.canvas.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this._draggedPOI || !this._grid || !this._authoringActive) return;
      e.stopPropagation();

      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const world = this.pixelToWorld(px, py);

      if (this.onPOIDrag) {
        this.onPOIDrag(this._draggedPOI, world);
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (this._draggedPOI) {
        e.stopPropagation();
        try {
          this.canvas.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        if (this.onPOIDragEnd) {
          this.onPOIDragEnd(this._draggedPOI);
        }
        this._draggedPOI = null;
      }
    };

    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
  }

  private pixelToWorld(px: number, py: number): { x: number; z: number } {
    if (!this._grid) return { x: 0, z: 0 };
    const w = this.canvas.width;
    const h = this.canvas.height;
    const col = (px / w) * this._grid.width;
    const row = (py / h) * this._grid.height;
    return {
      x: this._grid.origin[0] + col * this._grid.cell_size,
      z: this._grid.origin[1] + row * this._grid.cell_size,
    };
  }

  private worldToPixel(x: number, z: number): { px: number; py: number } {
    if (!this._grid) return { px: 0, py: 0 };
    const originX = this._grid.origin[0];
    const originZ = this._grid.origin[1];
    const cellSize = this._grid.cell_size;
    const col = (x - originX) / cellSize;
    const row = (z - originZ) / cellSize;
    return {
      px: (col / this._grid.width) * this.canvas.width,
      py: (row / this._grid.height) * this.canvas.height,
    };
  }

  private findPOIAtPixel(px: number, py: number, radiusPx = 10.0): POI | null {
    let closest: POI | null = null;
    let minD = radiusPx;

    for (const p of this._pois) {
      const pos = this.worldToPixel(p.position.x, p.position.z);
      const d = Math.hypot(pos.px - px, pos.py - py);
      if (d < minD) {
        minD = d;
        closest = p;
      }
    }
    return closest;
  }

  /**
   * Redraws player position, heading arrow, and POI markers at most 10 times per second (>= 100 ms).
   * +Z points DOWN the canvas.
   */
  update(playerX: number, playerZ: number, yawRad: number, now: number): void {
    if (!this._visible || !this._grid) return;
    if (now - this._lastDrawTime < 100) return;
    this._lastDrawTime = now;

    const ctx = this._ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    // 1. Blit pre-rendered offscreen grid
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._offscreenCanvas, 0, 0, w, h);

    // 2. Partition POIs into render layers so highlighted / selected markers are drawn LAST
    const effectiveCategory = getEffectiveCategory(
      this._categoryFilter,
      this._selectedPOIId,
      this._pois
    );

    const basePOIs: POI[] = [];
    const matchPOIs: POI[] = [];
    let selectedPOI: POI | null = null;

    for (const poi of this._pois) {
      const state = getPOIHighlightState(poi, this._selectedPOIId, effectiveCategory);
      if (state === "selected") {
        selectedPOI = poi;
      } else if (state === "match") {
        matchPOIs.push(poi);
      } else {
        basePOIs.push(poi);
      }
    }

    // Helper: draw pin base elements (zone, displacement line, anchor)
    const drawBaseElements = (poi: POI, isWarning: boolean) => {
      const pinPx = this.worldToPixel(poi.position.x, poi.position.z);
      const anchorPx = this.worldToPixel(poi.anchor.x, poi.anchor.z);

      // Draw Zone if circular
      if (poi.zone && poi.zone.type === "circle") {
        const zoneRadiusPx = (poi.zone.radius / (this._grid!.width * this._grid!.cell_size)) * w;
        ctx.beginPath();
        ctx.arc(pinPx.px, pinPx.py, zoneRadiusPx, 0, Math.PI * 2);
        ctx.fillStyle = isWarning ? "rgba(239, 68, 68, 0.15)" : "rgba(0, 229, 255, 0.15)";
        ctx.fill();
        ctx.lineWidth = 1.0;
        ctx.strokeStyle = isWarning ? "rgba(239, 68, 68, 0.5)" : "rgba(0, 229, 255, 0.5)";
        ctx.stroke();
      }

      // Draw displacement line connecting pin to anchor if moved
      if (Math.hypot(anchorPx.px - pinPx.px, anchorPx.py - pinPx.py) > 1.5) {
        ctx.beginPath();
        ctx.moveTo(pinPx.px, pinPx.py);
        ctx.lineTo(anchorPx.px, anchorPx.py);
        ctx.lineWidth = 1.0;
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = isWarning ? "#ef4444" : "#38ef7d";
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw Snapped Anchor (small green dot)
      ctx.beginPath();
      ctx.arc(anchorPx.px, anchorPx.py, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = isWarning ? "#ef4444" : "#38ef7d";
      ctx.fill();
    };

    // Layer 1: Normal and Dimmed POIs (drawn first at bottom)
    for (const poi of basePOIs) {
      const pinPx = this.worldToPixel(poi.position.x, poi.position.z);
      const snapDist = Math.hypot(poi.anchor.x - poi.position.x, poi.anchor.z - poi.position.z);
      const isWarning = Boolean(poi.unreachable || snapDist > 1.0);

      ctx.globalAlpha = effectiveCategory ? 0.30 : 1.0;
      drawBaseElements(poi, isWarning);

      // Default Pin Marker
      ctx.beginPath();
      ctx.arc(pinPx.px, pinPx.py, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isWarning ? "#ef4444" : "#00e5ff";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }

    // Layer 2: Same-Category Matches (drawn over base layer)
    // Dark blue marker (#1d4ed8 core) with a strong outer glow (bright blue #60a5fa halo, shadowBlur ~14 px),
    // thin white 1 px rim for contrast, radius ~8.5 px
    for (const poi of matchPOIs) {
      const pinPx = this.worldToPixel(poi.position.x, poi.position.z);
      const snapDist = Math.hypot(poi.anchor.x - poi.position.x, poi.anchor.z - poi.position.z);
      const isWarning = Boolean(poi.unreachable || snapDist > 1.0);

      ctx.globalAlpha = 1.0;
      drawBaseElements(poi, isWarning);

      ctx.save();
      ctx.shadowColor = "#60a5fa";
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(pinPx.px, pinPx.py, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = "#1d4ed8";
      ctx.fill();
      ctx.lineWidth = 1.0;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.restore();

      // Full-size label on matching pins on the minimap
      ctx.font = "bold 9px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const labelText = poi.name;
      const textWidth = ctx.measureText(labelText).width;

      ctx.fillStyle = "rgba(15, 23, 42, 0.90)";
      ctx.beginPath();
      ctx.roundRect(pinPx.px + 12, pinPx.py - 7, textWidth + 8, 14, 3);
      ctx.fill();
      ctx.strokeStyle = "#60a5fa";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillText(labelText, pinPx.px + 16, pinPx.py);
    }

    // Layer 3: Currently Selected POI (drawn LAST on top of everything)
    // GREEN (#22c55e core, same glow style in green, radius ~8.5 px, thin white 1 px rim)
    if (selectedPOI) {
      const poi = selectedPOI;
      const pinPx = this.worldToPixel(poi.position.x, poi.position.z);
      const snapDist = Math.hypot(poi.anchor.x - poi.position.x, poi.anchor.z - poi.position.z);
      const isWarning = Boolean(poi.unreachable || snapDist > 1.0);

      ctx.globalAlpha = 1.0;
      drawBaseElements(poi, isWarning);

      ctx.save();
      ctx.shadowColor = "#4ade80";
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(pinPx.px, pinPx.py, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = "#22c55e";
      ctx.fill();
      ctx.lineWidth = 1.0;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.restore();

      // Label badge
      ctx.font = "bold 9px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const labelText = poi.name;
      const textWidth = ctx.measureText(labelText).width;

      ctx.fillStyle = "rgba(11, 28, 18, 0.92)";
      ctx.beginPath();
      ctx.roundRect(pinPx.px + 12, pinPx.py - 7, textWidth + 8, 14, 3);
      ctx.fill();
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillText(labelText, pinPx.px + 16, pinPx.py);

      // Draw animated pulsing ring on pin if active
      if (poi.id === this._pulsingPOIId) {
        const elapsed = now - this._pulseStartTime;
        if (elapsed < this._pulseDurationMs) {
          const progress = elapsed / this._pulseDurationMs;
          const pulseRadius = 8.5 + progress * 16.0;
          const pulseAlpha = (1.0 - progress) * 0.85;
          ctx.beginPath();
          ctx.arc(pinPx.px, pinPx.py, pulseRadius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(74, 222, 128, ${pulseAlpha.toFixed(2)})`;
          ctx.lineWidth = 2.0;
          ctx.stroke();
        } else {
          this._pulsingPOIId = null;
        }
      }
    }

    ctx.globalAlpha = 1.0;

    // 3. Map player position (world X, Z) to minimap pixels
    const playerPixel = this.worldToPixel(playerX, playerZ);
    const px = playerPixel.px;
    const py = playerPixel.py;

    // Draw player dot
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#06b6d4";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    // Draw heading arrow (yaw 0 points North / -Z, which is UP the image: dirZ < 0)
    // +Z is DOWN in canvas coords (py + dirY * len)
    const dirX = -Math.sin(yawRad);
    const dirY = -Math.cos(yawRad); // dirY < 0 when pointing North (-Z)
    const arrowLen = 12;

    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + dirX * arrowLen, py + dirY * arrowLen);
    ctx.strokeStyle = "#06b6d4";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Arrowhead tip
    const headLen = 5;
    const angle = Math.atan2(dirY, dirX);
    ctx.beginPath();
    ctx.moveTo(px + dirX * arrowLen, py + dirY * arrowLen);
    ctx.lineTo(
      px + dirX * arrowLen - headLen * Math.cos(angle - Math.PI / 6),
      py + dirY * arrowLen - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      px + dirX * arrowLen - headLen * Math.cos(angle + Math.PI / 6),
      py + dirY * arrowLen - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fillStyle = "#06b6d4";
    ctx.fill();
  }
}
