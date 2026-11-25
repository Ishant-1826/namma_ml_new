/**
 * route_renderer.ts
 * 3D floor route chevrons and vertical destination light beacon.
 * Pre-allocated Three.js instances with zero heap allocations during the render loop.
 * Visible through splats (depthTest: false, high renderOrder, slight transparency).
 * Fades beyond 12 m from player.
 */

import * as THREE from "three";
import { NavGridPoint } from "../nav/navgrid";

const MAX_CHEVRON_INSTANCES = 350;
const CHEVRON_SPACING_M = 0.20; // 20 cm spacing between chevrons
const FADE_START_M = 12.0; // full opacity up to 12 m
const FADE_END_M = 16.0;   // completely faded beyond 16 m

export class RouteRenderer {
  readonly group: THREE.Group;

  // 1. Instanced Chevrons on Floor (y = 0.03)
  private readonly _chevronMesh: THREE.InstancedMesh;
  private readonly _chevronMaterial: THREE.MeshBasicMaterial;
  private readonly _chevronGeometry: THREE.BufferGeometry;

  // 2. Destination Light Beacon
  private readonly _beaconGroup: THREE.Group;
  private readonly _beaconCylinder: THREE.Mesh;
  private readonly _beaconCore: THREE.Mesh;
  private readonly _beaconMaterial: THREE.MeshBasicMaterial;
  private readonly _beaconCoreMaterial: THREE.MeshBasicMaterial;

  // Pre-allocated temporaries for instance transforms & colors (ZERO per-frame allocation)
  private readonly _dummy = new THREE.Object3D();
  private readonly _tempColor = new THREE.Color();
  private readonly _baseColor = new THREE.Color(0x00e5ff); // Cyan
  private readonly _dimColor = new THREE.Color(0x0284c7);  // Darker blue/cyan for fade

  private _activeCount = 0;
  private _pathPoints: NavGridPoint[] = [];
  private _destinationAnchor: NavGridPoint | null = null;
  private _lastProjectedProgressM = -999;
  private _isVisible = false;

  // Distance along path for each chevron instance
  private readonly _instanceDistAlongPath = new Float32Array(MAX_CHEVRON_INSTANCES);

  constructor() {
    this.group = new THREE.Group();
    this.group.name = "route_renderer_group";

    // Build Chevron 2D Arrow Geometry in XZ plane
    // Tip at (0, 0, -0.09), wings at (-0.065, 0, 0.065) and (0.065, 0, 0.065), notch at (0, 0, 0.02)
    const positions = new Float32Array([
      // Left triangle: tip, left wing, notch
      0, 0, -0.09,
      -0.065, 0, 0.065,
      0, 0, 0.02,
      // Right triangle: tip, notch, right wing
      0, 0, -0.09,
      0, 0, 0.02,
      0.065, 0, 0.065,
    ]);

    this._chevronGeometry = new THREE.BufferGeometry();
    this._chevronGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this._chevronGeometry.computeVertexNormals();

    this._chevronMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff, // Tinted per-instance by instanceColor
      transparent: true,
      opacity: 0.90,
      depthTest: false,
      side: THREE.DoubleSide,
    });

    this._chevronMesh = new THREE.InstancedMesh(
      this._chevronGeometry,
      this._chevronMaterial,
      MAX_CHEVRON_INSTANCES
    );
    this._chevronMesh.renderOrder = 9999;
    this._chevronMesh.frustumCulled = false;
    this._chevronMesh.count = 0;
    this.group.add(this._chevronMesh);

    // Initialize instanceColor buffer
    for (let i = 0; i < MAX_CHEVRON_INSTANCES; i++) {
      this._chevronMesh.setColorAt(i, this._baseColor);
    }
    if (this._chevronMesh.instanceColor) {
      this._chevronMesh.instanceColor.needsUpdate = true;
    }

    // Build Vertical Beacon Group at Destination
    this._beaconGroup = new THREE.Group();
    this._beaconGroup.name = "destination_beacon";
    this._beaconGroup.visible = false;

    // Outer translucent beam (height 2.8 m)
    const cylGeo = new THREE.CylinderGeometry(0.08, 0.16, 2.8, 16, 1, true);
    this._beaconMaterial = new THREE.MeshBasicMaterial({
      color: 0x22c55e, // Bright green
      transparent: true,
      opacity: 0.45,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this._beaconCylinder = new THREE.Mesh(cylGeo, this._beaconMaterial);
    this._beaconCylinder.position.y = 1.4; // Base sits at y=0, top at y=2.8
    this._beaconCylinder.renderOrder = 9998;
    this._beaconGroup.add(this._beaconCylinder);

    // Inner bright core beam
    const coreGeo = new THREE.CylinderGeometry(0.025, 0.04, 2.8, 8, 1, true);
    this._beaconCoreMaterial = new THREE.MeshBasicMaterial({
      color: 0xa7f3d0, // Mint / white-green
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      side: THREE.DoubleSide,
    });
    this._beaconCore = new THREE.Mesh(coreGeo, this._beaconCoreMaterial);
    this._beaconCore.position.y = 1.4;
    this._beaconCore.renderOrder = 9999;
    this._beaconGroup.add(this._beaconCore);

    this.group.add(this._beaconGroup);
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  /**
   * Sets the active route path points and destination anchor.
   * Recomputes instance transforms only when the route changes.
   */
  setRoute(path: NavGridPoint[] | null, anchor: NavGridPoint | null): void {
    if (!path || path.length < 2 || !anchor) {
      this.clear();
      return;
    }

    this._pathPoints = path;
    this._destinationAnchor = anchor;
    this._isVisible = true;

    // Position beacon at anchor
    this._beaconGroup.position.set(anchor.x, 0, anchor.z);
    this._beaconGroup.visible = true;

    // Sample chevrons along path
    this.layoutChevrons(path);
  }

  /**
   * Clears the 3D route and hides the beacon.
   */
  clear(): void {
    this._pathPoints = [];
    this._destinationAnchor = null;
    this._isVisible = false;
    this._chevronMesh.count = 0;
    this._beaconGroup.visible = false;
    this._lastProjectedProgressM = -999;
  }

  /**
   * Lays out chevrons along the smoothed path with consistent spacing.
   * Called ONCE when path is computed or updated, NEVER per frame.
   */
  private layoutChevrons(path: NavGridPoint[]): void {
    let instanceIdx = 0;
    let accumulatedDistM = 0;

    for (let seg = 0; seg < path.length - 1; seg++) {
      const p1 = path[seg];
      const p2 = path[seg + 1];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const segLen = Math.hypot(dx, dz);
      if (segLen < 1e-4) continue;

      const dirX = dx / segLen;
      const dirZ = dz / segLen;
      // Rotation angle in XZ plane: local -Z points in direction (dirX, dirZ)
      const yaw = Math.atan2(-dirX, -dirZ);

      // Number of steps along this segment
      const numSteps = Math.max(1, Math.floor(segLen / CHEVRON_SPACING_M));
      const actualStep = segLen / numSteps;

      for (let s = 0; s < numSteps; s++) {
        if (instanceIdx >= MAX_CHEVRON_INSTANCES) break;

        const t = (s + 0.5) / numSteps;
        const x = p1.x + t * dx;
        const z = p1.z + t * dz;
        const distAlong = accumulatedDistM + t * segLen;

        this._dummy.position.set(x, 0.03, z);
        this._dummy.rotation.set(0, yaw, 0);
        this._dummy.scale.set(1, 1, 1);
        this._dummy.updateMatrix();

        this._chevronMesh.setMatrixAt(instanceIdx, this._dummy.matrix);
        this._chevronMesh.setColorAt(instanceIdx, this._baseColor);
        this._instanceDistAlongPath[instanceIdx] = distAlong;

        instanceIdx++;
      }

      accumulatedDistM += segLen;
      if (instanceIdx >= MAX_CHEVRON_INSTANCES) break;
    }

    this._activeCount = instanceIdx;
    this._chevronMesh.count = instanceIdx;
    this._chevronMesh.instanceMatrix.needsUpdate = true;
    if (this._chevronMesh.instanceColor) {
      this._chevronMesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Render loop update:
   * - Animates beacon rotation and gentle breathing pulse
   * - Fades chevrons beyond 12 m from the player's progress
   * - ZERO heap allocation per frame.
   */
  update(playerProgressM: number, nowMs: number): void {
    if (!this._isVisible || this._activeCount === 0) return;

    // Animate beacon: slow spin and gentle breathing
    const spinAngle = (nowMs * 0.001) % (Math.PI * 2);
    this._beaconCylinder.rotation.y = spinAngle;
    this._beaconCore.rotation.y = -spinAngle * 1.5;

    const pulse = 0.45 + 0.15 * Math.sin(nowMs * 0.004);
    this._beaconMaterial.opacity = pulse;

    // Update distance-fade only when player progress has moved meaningfully (>= 0.15 m)
    const distDelta = Math.abs(playerProgressM - this._lastProjectedProgressM);
    if (distDelta >= 0.15 || this._lastProjectedProgressM < 0) {
      this._lastProjectedProgressM = playerProgressM;
      this.updateChevronColors(playerProgressM);
    }
  }

  /**
   * Updates instance colors according to distance from player progress.
   * Full brightness for 12 m, fading linearly to dark between 12 m and 16 m.
   * Zero heap allocations.
   */
  private updateChevronColors(playerProgressM: number): void {
    if (!this._chevronMesh.instanceColor) return;

    for (let i = 0; i < this._activeCount; i++) {
      const distFromPlayer = this._instanceDistAlongPath[i] - playerProgressM;

      if (distFromPlayer < -1.0) {
        // Behind player: dim down
        this._tempColor.copy(this._dimColor).multiplyScalar(0.25);
      } else if (distFromPlayer <= FADE_START_M) {
        // Full brightness for next 12 m
        this._tempColor.copy(this._baseColor);
      } else if (distFromPlayer >= FADE_END_M) {
        // Beyond 16 m: faded to near zero
        this._tempColor.copy(this._dimColor).multiplyScalar(0.08);
      } else {
        // Linear fade between 12 m and 16 m
        const factor = (FADE_END_M - distFromPlayer) / (FADE_END_M - FADE_START_M);
        this._tempColor.lerpColors(this._dimColor, this._baseColor, factor).multiplyScalar(0.2 + 0.8 * factor);
      }

      this._chevronMesh.setColorAt(i, this._tempColor);
    }

    this._chevronMesh.instanceColor.needsUpdate = true;
  }
}
