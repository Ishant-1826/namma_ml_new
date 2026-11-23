/**
 * poi_card.ts
 * Floating DOM Info Card displayed when a POI is clicked or revealed.
 * Displays name, category, description, coordinates, distance, and action buttons.
 */

import { POI } from "../poi/poi_types";

export class POICard {
  private readonly container: HTMLDivElement;
  private _currentPOI: POI | null = null;
  private _isOpen = false;

  public onNavigate?: (poi: POI) => void;
  public onEdit?: (poi: POI) => void;
  public onDelete?: (poi: POI) => void;
  public onClose?: () => void;

  constructor() {
    this.container = document.createElement("div");
    this.container.id = "poi-info-card";
    this.container.className = "poi-info-card hidden";
    document.body.appendChild(this.container);

    // Prevent clicks inside the card from bubbling to canvas / locking pointer
    this.container.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  isOpen(): boolean {
    return this._isOpen;
  }

  getCurrentPOI(): POI | null {
    return this._currentPOI;
  }

  show(
    poi: POI,
    playerPos?: { x: number; z: number },
    inAuthoringMode = false
  ): void {
    this._currentPOI = poi;
    this._isOpen = true;

    const snapDist = Math.hypot(poi.anchor.x - poi.position.x, poi.anchor.z - poi.position.z);
    const isWarning = Boolean(poi.unreachable || snapDist > 1.0);

    let distText = "";
    if (playerPos) {
      const d = Math.hypot(poi.position.x - playerPos.x, poi.position.z - playerPos.z);
      distText = `<span class="poi-meta-chip">📍 ${d.toFixed(1)} m away</span>`;
    }

    const snapStatusText = poi.unreachable
      ? `<span class="poi-status-badge error">Unreachable Anchor</span>`
      : snapDist > 1.0
      ? `<span class="poi-status-badge warning">Anchor displaced ${snapDist.toFixed(2)} m</span>`
      : `<span class="poi-status-badge success">Anchor snapped (${snapDist.toFixed(2)} m)</span>`;

    const aliasesText = poi.aliases && poi.aliases.length > 0
      ? `<div class="poi-aliases-row"><strong>Also known as:</strong> ${poi.aliases.join(", ")}</div>`
      : "";

    const descHtml = poi.description
      ? `<p class="poi-card-desc">${poi.description}</p>`
      : `<p class="poi-card-desc muted">No additional description provided.</p>`;

    const authorControlsHtml = inAuthoringMode
      ? `
        <div class="poi-author-actions">
          <button type="button" class="poi-btn-edit" id="poi-card-edit-btn">✏️ Edit POI</button>
          <button type="button" class="poi-btn-delete" id="poi-card-delete-btn">🗑️ Delete</button>
        </div>
      `
      : "";

    this.container.innerHTML = `
      <div class="poi-card-header">
        <div class="poi-card-title-group">
          <h2 class="poi-card-title">${poi.name}</h2>
          <div class="poi-badges-row">
            <span class="poi-category-pill">${poi.category}</span>
            ${distText}
            ${snapStatusText}
          </div>
        </div>
        <button type="button" class="poi-close-btn" id="poi-card-close-btn" title="Close (Esc)">✕</button>
      </div>

      <div class="poi-card-body">
        ${descHtml}
        ${aliasesText}
        <div class="poi-coords-grid">
          <div><span class="muted">Pin:</span> (${poi.position.x.toFixed(2)}, ${poi.position.z.toFixed(2)})</div>
          <div><span class="muted">Anchor:</span> (${poi.anchor.x.toFixed(2)}, ${poi.anchor.z.toFixed(2)})</div>
          ${poi.height !== undefined ? `<div><span class="muted">Height:</span> ${poi.height.toFixed(2)} m</div>` : ""}
          ${poi.zone ? `<div><span class="muted">Zone:</span> ${poi.zone.type}</div>` : ""}
        </div>
      </div>

      <div class="poi-card-footer">
        <button type="button" class="poi-nav-btn" id="poi-card-nav-btn" disabled title="Navigation routing will be available in Phase 5">
          🧭 Navigate Here (Phase 5)
        </button>
        ${authorControlsHtml}
      </div>
    `;

    // Hook events
    const closeBtn = this.container.querySelector("#poi-card-close-btn");
    closeBtn?.addEventListener("click", () => this.hide());

    const navBtn = this.container.querySelector("#poi-card-nav-btn");
    navBtn?.addEventListener("click", () => {
      if (this.onNavigate && this._currentPOI) {
        this.onNavigate(this._currentPOI);
      }
    });

    if (inAuthoringMode) {
      const editBtn = this.container.querySelector("#poi-card-edit-btn");
      editBtn?.addEventListener("click", () => {
        if (this.onEdit && this._currentPOI) {
          this.onEdit(this._currentPOI);
        }
      });

      const delBtn = this.container.querySelector("#poi-card-delete-btn");
      delBtn?.addEventListener("click", () => {
        if (this.onDelete && this._currentPOI) {
          this.onDelete(this._currentPOI);
        }
      });
    }

    this.container.classList.remove("hidden");
  }

  hide(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this._currentPOI = null;
    this.container.classList.add("hidden");
    if (this.onClose) {
      this.onClose();
    }
  }
}
