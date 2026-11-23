/**
 * poi_authoring.ts
 * Authoring Mode (Key P) for interactive POI creation, editing, dragging, and deletion.
 * - Visible "EDIT POIs" badge.
 * - Click floor or minimap to drop pin.
 * - Form for name, category (dropdown + custom), aliases (comma-separated), zone radius, height, description.
 * - Shows snapped anchor (green dot) or warning (red pin if unreachable or moved > 1m).
 * - Export, Import, and localStorage autosave.
 * - Key isolation: form typing does NOT trigger WASD or hotkeys.
 */

import { NavGrid } from "../nav/navgrid";
import { POI, POISceneFile } from "../poi/poi_types";
import { loadPOIs } from "../poi/loader";

export const LOCAL_STORAGE_POI_DRAFT_KEY = "namma_space_poi_draft";

export interface POIAuthoringOptions {
  navGrid?: NavGrid | null;
  onPOIsChange: (pois: POI[]) => void;
  onSelectPOI?: (poi: POI | null) => void;
}

export class POIAuthoring {
  private _active = false;
  private _navGrid: NavGrid | null = null;
  private _pois: POI[] = [];
  private _editingPOI: POI | null = null;
  private _isNewPOI = false;

  private readonly onPOIsChange: (pois: POI[]) => void;
  private readonly onSelectPOI?: (poi: POI | null) => void;

  // DOM Elements
  private readonly badge: HTMLDivElement;
  private readonly toolbar: HTMLDivElement;
  private readonly formModal: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;

  constructor(options: POIAuthoringOptions) {
    this._navGrid = options.navGrid ?? null;
    this.onPOIsChange = options.onPOIsChange;
    this.onSelectPOI = options.onSelectPOI;

    // 1. "EDIT POIs" Badge
    this.badge = document.createElement("div");
    this.badge.id = "authoring-badge";
    this.badge.className = "authoring-badge hidden";
    this.badge.innerHTML = `<span class="badge-dot"></span> EDIT POIs (Key P)`;
    document.body.appendChild(this.badge);

    // 2. Authoring Toolbar
    this.toolbar = document.createElement("div");
    this.toolbar.id = "authoring-toolbar";
    this.toolbar.className = "authoring-toolbar hidden";
    this.toolbar.innerHTML = `
      <div class="toolbar-hint">Click floor or minimap to place pin</div>
      <div class="toolbar-actions">
        <button type="button" class="btn-tool" id="btn-author-export" title="Download poi.json">⬇️ Export poi.json</button>
        <button type="button" class="btn-tool" id="btn-author-import" title="Import poi.json">⬆️ Import poi.json</button>
        <button type="button" class="btn-tool danger" id="btn-author-exit" title="Exit Edit Mode (Key P)">✕ Exit</button>
      </div>
    `;
    document.body.appendChild(this.toolbar);

    // 3. Hidden File Input for import
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".json,application/json";
    this.fileInput.style.display = "none";
    document.body.appendChild(this.fileInput);

    // 4. Edit Form Modal
    this.formModal = document.createElement("div");
    this.formModal.id = "authoring-form-modal";
    this.formModal.className = "authoring-form-modal hidden";
    document.body.appendChild(this.formModal);

    this.setupEvents();
  }

  setNavGrid(grid: NavGrid | null): void {
    this._navGrid = grid;
  }

  setPOIs(pois: POI[]): void {
    this._pois = [...pois];
  }

  getPOIs(): POI[] {
    return [...this._pois];
  }

  isActive(): boolean {
    return this._active;
  }

  toggle(): boolean {
    this.setActive(!this._active);
    return this._active;
  }

  setActive(active: boolean): void {
    this._active = active;
    this.badge.classList.toggle("hidden", !active);
    this.toolbar.classList.toggle("hidden", !active);

    if (!active) {
      this.closeForm();
      if (this.onSelectPOI) {
        this.onSelectPOI(null);
      }
    }
  }

  /**
   * Opens form to drop a new pin at world coordinates (x, z).
   */
  dropNewPin(x: number, z: number): void {
    if (!this._active) return;

    // Calculate initial snapped anchor
    const anchor = this.computeAnchor(x, z);
    const snapDist = Math.hypot(anchor.x - x, anchor.z - z);
    const unreachable = anchor.unreachable;

    const id = `poi_${Date.now().toString(36)}`;
    const newPOI: POI = {
      id,
      name: "New Point of Interest",
      category: "desk",
      aliases: [],
      tags: [],
      position: { x, z },
      height: 1.2,
      anchor: { x: anchor.x, z: anchor.z },
      unreachable,
    };

    this._editingPOI = newPOI;
    this._isNewPOI = true;
    this.openForm(newPOI, snapDist, unreachable);
  }

  /**
   * Opens form to edit an existing POI.
   */
  editPOI(poi: POI): void {
    this._editingPOI = { ...poi };
    this._isNewPOI = false;

    const snapDist = Math.hypot(poi.anchor.x - poi.position.x, poi.anchor.z - poi.position.z);
    this.openForm(this._editingPOI, snapDist, Boolean(poi.unreachable));
  }

  /**
   * Moves a POI's pin position (e.g. from minimap drag).
   */
  movePOI(poiId: string, newX: number, newZ: number): void {
    const idx = this._pois.findIndex((p) => p.id === poiId);
    if (idx === -1) return;

    const anchor = this.computeAnchor(newX, newZ);
    this._pois[idx].position = { x: newX, z: newZ };
    this._pois[idx].anchor = { x: anchor.x, z: anchor.z };
    this._pois[idx].unreachable = anchor.unreachable;

    this.saveDraft();
    this.onPOIsChange(this._pois);
  }

  deletePOI(poiId: string): void {
    this._pois = this._pois.filter((p) => p.id !== poiId);
    this.saveDraft();
    this.onPOIsChange(this._pois);
    if (this._editingPOI?.id === poiId) {
      this.closeForm();
    }
    if (this.onSelectPOI) {
      this.onSelectPOI(null);
    }
  }

  private computeAnchor(x: number, z: number): { x: number; z: number; unreachable: boolean } {
    if (!this._navGrid) {
      return { x, z, unreachable: false };
    }
    const snapped = this._navGrid.snapToWalkable(x, z, 5.0);
    if (!snapped) {
      return { x, z, unreachable: true };
    }
    return { x: snapped.x, z: snapped.z, unreachable: false };
  }

  private setupEvents(): void {
    // Toolbar buttons
    const exportBtn = this.toolbar.querySelector("#btn-author-export");
    exportBtn?.addEventListener("click", () => this.exportPOIs());

    const importBtn = this.toolbar.querySelector("#btn-author-import");
    importBtn?.addEventListener("click", () => this.fileInput.click());

    const exitBtn = this.toolbar.querySelector("#btn-author-exit");
    exitBtn?.addEventListener("click", () => this.setActive(false));

    // File input change (import)
    this.fileInput.addEventListener("change", (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        this.importPOIs(file);
      }
      this.fileInput.value = "";
    });

    // Form modal clicks: stop propagation
    this.formModal.addEventListener("click", (e) => e.stopPropagation());

    // Isolate keyboard input so typing does NOT trigger WASD or shortcuts
    this.formModal.addEventListener("keydown", (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        this.closeForm();
      }
    });
    this.formModal.addEventListener("keyup", (e: KeyboardEvent) => {
      e.stopPropagation();
    });
  }

  private openForm(poi: POI, snapDist: number, unreachable: boolean): void {
    const isWarning = unreachable || snapDist > 1.0;
    const categories = [
      "desk",
      "sofa",
      "chair",
      "table",
      "door",
      "window",
      "reception",
      "kitchen",
      "other",
    ];

    const isCustomCat = !categories.includes(poi.category);
    const catOptions = categories
      .map((c) => `<option value="${c}" ${c === poi.category || (c === "other" && isCustomCat) ? "selected" : ""}>${c}</option>`)
      .join("");

    const aliasesStr = poi.aliases ? poi.aliases.join(", ") : "";
    let zoneRadius = "";
    if (poi.zone && poi.zone.type === "circle") {
      zoneRadius = poi.zone.radius.toString();
    }

    const warningBanner = isWarning
      ? `<div class="form-warning-banner">
          ⚠️ ${unreachable ? "Anchor is UNREACHABLE from spawn!" : `Anchor moved ${snapDist.toFixed(2)} m (> 1 m) to nearest walkable cell.`}
        </div>`
      : `<div class="form-success-banner">✓ Snapped cleanly to walkable floor (${snapDist.toFixed(2)} m)</div>`;

    this.formModal.innerHTML = `
      <div class="form-modal-card">
        <div class="form-header">
          <h3>${this._isNewPOI ? "➕ Drop New POI" : "✏️ Edit POI"}</h3>
          <button type="button" class="btn-form-close" id="form-btn-close">✕</button>
        </div>

        ${warningBanner}

        <div class="form-body">
          <div class="form-group">
            <label for="form-inp-name">POI Name *</label>
            <input type="text" id="form-inp-name" value="${poi.name}" placeholder="e.g. Workstation Desk" required />
          </div>

          <div class="form-row">
            <div class="form-group flex-1">
              <label for="form-sel-cat">Category *</label>
              <select id="form-sel-cat">
                ${catOptions}
              </select>
            </div>
            <div class="form-group flex-1 ${isCustomCat ? "" : "hidden"}" id="form-custom-cat-group">
              <label for="form-inp-custom-cat">Custom Category</label>
              <input type="text" id="form-inp-custom-cat" value="${isCustomCat ? poi.category : ""}" placeholder="e.g. printer" />
            </div>
          </div>

          <div class="form-group">
            <label for="form-inp-aliases">Aliases (comma-separated)</label>
            <input type="text" id="form-inp-aliases" value="${aliasesStr}" placeholder="e.g. table, desk, pc setup" />
          </div>

          <div class="form-row">
            <div class="form-group flex-1">
              <label for="form-inp-radius">Zone Radius (m, optional)</label>
              <input type="number" step="0.1" min="0" id="form-inp-radius" value="${zoneRadius}" placeholder="e.g. 1.2" />
            </div>
            <div class="form-group flex-1">
              <label for="form-inp-height">Label Height (m)</label>
              <input type="number" step="0.1" id="form-inp-height" value="${poi.height ?? 1.2}" placeholder="1.2" />
            </div>
          </div>

          <div class="form-group">
            <label for="form-inp-desc">Description</label>
            <textarea id="form-inp-desc" rows="2" placeholder="Brief description of this point of interest...">${poi.description ?? ""}</textarea>
          </div>

          <div class="form-meta-info">
            <div>Pin: (${poi.position.x.toFixed(2)}, ${poi.position.z.toFixed(2)})</div>
            <div>Anchor: (${poi.anchor.x.toFixed(2)}, ${poi.anchor.z.toFixed(2)})</div>
          </div>
        </div>

        <div class="form-footer">
          ${!this._isNewPOI ? `<button type="button" class="btn-form-delete" id="form-btn-delete">🗑️ Delete</button>` : ""}
          <div class="form-footer-right">
            <button type="button" class="btn-form-cancel" id="form-btn-cancel">Cancel</button>
            <button type="button" class="btn-form-save" id="form-btn-save">💾 Save POI</button>
          </div>
        </div>
      </div>
    `;

    this.formModal.classList.remove("hidden");

    // Form handlers
    const nameInput = this.formModal.querySelector("#form-inp-name") as HTMLInputElement;
    const catSelect = this.formModal.querySelector("#form-sel-cat") as HTMLSelectElement;
    const customCatGroup = this.formModal.querySelector("#form-custom-cat-group") as HTMLDivElement;
    const customCatInput = this.formModal.querySelector("#form-inp-custom-cat") as HTMLInputElement;
    const aliasesInput = this.formModal.querySelector("#form-inp-aliases") as HTMLInputElement;
    const radiusInput = this.formModal.querySelector("#form-inp-radius") as HTMLInputElement;
    const heightInput = this.formModal.querySelector("#form-inp-height") as HTMLInputElement;
    const descInput = this.formModal.querySelector("#form-inp-desc") as HTMLTextAreaElement;

    catSelect.addEventListener("change", () => {
      customCatGroup.classList.toggle("hidden", catSelect.value !== "other");
    });

    const closeBtn = this.formModal.querySelector("#form-btn-close");
    closeBtn?.addEventListener("click", () => this.closeForm());

    const cancelBtn = this.formModal.querySelector("#form-btn-cancel");
    cancelBtn?.addEventListener("click", () => this.closeForm());

    const deleteBtn = this.formModal.querySelector("#form-btn-delete");
    deleteBtn?.addEventListener("click", () => {
      if (this._editingPOI) {
        this.deletePOI(this._editingPOI.id);
      }
    });

    const saveBtn = this.formModal.querySelector("#form-btn-save");
    saveBtn?.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        alert("POI Name cannot be empty.");
        nameInput.focus();
        return;
      }

      let category = catSelect.value;
      if (category === "other") {
        category = customCatInput.value.trim() || "general";
      }

      const rawAliases = aliasesInput.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const rVal = parseFloat(radiusInput.value);
      let zone: POI["zone"] | undefined;
      if (!isNaN(rVal) && rVal > 0) {
        zone = { type: "circle", radius: rVal };
      }

      const hVal = parseFloat(heightInput.value);
      const height = !isNaN(hVal) ? hVal : 1.2;
      const desc = descInput.value.trim() || undefined;

      const updatedPOI: POI = {
        ...poi,
        name,
        category,
        aliases: rawAliases,
        zone,
        height,
        description: desc,
      };

      if (this._isNewPOI) {
        this._pois.push(updatedPOI);
      } else {
        const idx = this._pois.findIndex((p) => p.id === updatedPOI.id);
        if (idx !== -1) {
          this._pois[idx] = updatedPOI;
        }
      }

      this.saveDraft();
      this.onPOIsChange(this._pois);
      this.closeForm();
    });

    // Auto-focus name field
    setTimeout(() => nameInput.focus(), 50);
  }

  private closeForm(): void {
    this._editingPOI = null;
    this._isNewPOI = false;
    this.formModal.classList.add("hidden");
  }

  /**
   * Autosaves current POI list to browser localStorage.
   */
  private saveDraft(): void {
    try {
      const fileData: POISceneFile = {
        scene: "home",
        version: 1,
        pois: this._pois,
      };
      localStorage.setItem(LOCAL_STORAGE_POI_DRAFT_KEY, JSON.stringify(fileData));
    } catch (err) {
      console.warn("[Authoring] Failed to autosave POIs to localStorage:", err);
    }
  }

  /**
   * Exports POIs as a downloadable `poi.json` file.
   */
  exportPOIs(): void {
    const fileData: POISceneFile = {
      scene: "home",
      version: 1,
      pois: this._pois.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        aliases: p.aliases,
        tags: p.tags,
        position: p.position,
        height: p.height,
        zone: p.zone,
        description: p.description,
      })),
    };

    const jsonStr = JSON.stringify(fileData, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "poi.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`[Authoring] Exported ${this._pois.length} POIs to poi.json`);
  }

  /**
   * Imports and validates a user-selected `poi.json` file.
   */
  private importPOIs(file: File): void {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        if (!this._navGrid) {
          alert("Cannot validate imported POIs: navigation grid not initialized.");
          return;
        }

        const res = loadPOIs(data, this._navGrid);
        if (res.errors.length > 0) {
          alert(`Failed to import POIs:\n- ${res.errors.join("\n- ")}`);
          return;
        }

        this._pois = res.pois;
        this.saveDraft();
        this.onPOIsChange(this._pois);

        let warnMsg = "";
        if (res.warnings.length > 0) {
          warnMsg = `\nWarnings:\n${res.warnings.join("\n")}`;
        }
        alert(`Successfully imported ${res.pois.length} POIs!${warnMsg}`);
      } catch (err) {
        alert(`Failed to parse JSON file: ${String(err)}`);
      }
    };
    reader.readAsText(file);
  }
}
