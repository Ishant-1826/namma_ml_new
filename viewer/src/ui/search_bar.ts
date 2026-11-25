/**
 * search_bar.ts
 * Spatial POI search bar with live autocomplete, category chips,
 * walking-distance ranking via DistanceFieldGate, keyboard navigation,
 * action buttons ("Jump here", "Navigate"), and toast notifications.
 */

import { POI, normalizeCategory } from "../poi/poi_types";
import { NavGrid } from "../nav/navgrid";
import { searchPOIs, SearchResult } from "../poi/search";
import {
  DistanceFieldGate,
  extractCategories,
  filterPOIsByCategory,
  CategorizedPOIItem,
} from "../poi/jump_math";

export interface SearchBarCallbacks {
  onOpen?: () => void;
  onClose?: (resumePointerLock: boolean) => void;
  onSelectPOI?: (poi: POI | null) => void;
  onJumpRequested?: (poi: POI) => void;
  onNavigateRequested?: (poi: POI, distanceM?: number) => void;
  onCategoryFilter?: (category: string | null) => void;
}

export class SearchBar {
  private readonly container: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly clearBtn: HTMLButtonElement;
  private readonly chipsContainer: HTMLDivElement;
  private readonly resultsContainer: HTMLDivElement;
  private readonly toastContainer: HTMLDivElement;

  private _pois: POI[] = [];
  private _grid: NavGrid | null = null;
  private _categories: string[] = [];
  private _activeCategory: string | null = null;
  private _currentResults: Array<{ poi: POI; walkingDistance?: number; unreachable?: boolean }> = [];
  private _selectedIndex = 0;
  private _isOpen = false;
  private _toastTimeout: number | null = null;

  private readonly _callbacks: SearchBarCallbacks;
  private readonly _distanceGate: DistanceFieldGate;

  constructor(distanceGate: DistanceFieldGate, callbacks: SearchBarCallbacks = {}) {
    this._distanceGate = distanceGate;
    this._callbacks = callbacks;

    // Outer container
    this.container = document.createElement("div");
    this.container.id = "poi-search-wrapper";
    this.container.className = "poi-search-wrapper hidden";

    this.container.innerHTML = `
      <div class="poi-search-backdrop" id="poi-search-backdrop"></div>
      <div class="poi-search-panel" id="poi-search-panel">
        <div class="poi-search-input-box">
          <span class="poi-search-icon" aria-hidden="true">🔍</span>
          <input
            type="text"
            id="poi-search-input"
            class="poi-search-input"
            placeholder="Search POIs... (Press / or Ctrl+K)"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="button" id="poi-search-clear-btn" class="poi-search-clear-btn hidden" title="Clear search">✕</button>
          <span class="poi-search-esc-hint">Esc</span>
        </div>

        <div class="poi-category-chips" id="poi-category-chips"></div>

        <div class="poi-search-results" id="poi-search-results"></div>

        <div class="poi-search-actions hidden" id="poi-search-actions">
          <div class="poi-action-info" id="poi-action-info"></div>
          <div class="poi-action-buttons">
            <button type="button" class="btn-jump" id="btn-search-jump" title="Shift + Enter">
              <span>🚀 Jump Here</span>
              <kbd class="btn-kbd">Shift+↵</kbd>
            </button>
            <button type="button" class="btn-nav" id="btn-search-nav" title="Enter">
              <span>🧭 Navigate</span>
              <kbd class="btn-kbd">↵</kbd>
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.container);

    // Toast element for user notifications
    this.toastContainer = document.createElement("div");
    this.toastContainer.id = "poi-toast-container";
    this.toastContainer.className = "poi-toast-container hidden";
    document.body.appendChild(this.toastContainer);

    this.input = this.container.querySelector("#poi-search-input") as HTMLInputElement;
    this.clearBtn = this.container.querySelector("#poi-search-clear-btn") as HTMLButtonElement;
    this.chipsContainer = this.container.querySelector("#poi-category-chips") as HTMLDivElement;
    this.resultsContainer = this.container.querySelector("#poi-search-results") as HTMLDivElement;

    this.setupEvents();
  }

  setGrid(grid: NavGrid): void {
    this._grid = grid;
  }

  setPOIs(pois: POI[]): void {
    this._pois = pois;
    this._categories = extractCategories(pois);
    this.renderCategoryChips();
  }

  isOpen(): boolean {
    return this._isOpen;
  }

  open(playerPos?: { x: number; z: number }): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.container.classList.remove("hidden");

    this._callbacks.onOpen?.();

    // Focus input and select text cleanly
    requestAnimationFrame(() => {
      this.input.focus();
      this.input.select();
    });

    this.updateQueryResults(playerPos);
  }

  close(resumePointerLock = true): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.container.classList.add("hidden");
    this.input.blur();

    this._callbacks.onClose?.(resumePointerLock);
  }

  /**
   * Sets the active category filter (or clears it) and updates display.
   */
  setCategory(category: string | null, playerPos?: { x: number; z: number }): void {
    const norm = normalizeCategory(category);
    if (this._activeCategory === norm) {
      this._activeCategory = null;
    } else {
      this._activeCategory = norm || null;
    }

    this.renderCategoryChips();
    this._callbacks.onCategoryFilter?.(this._activeCategory);
    this.updateQueryResults(playerPos);
  }

  /**
   * Clears any active category filter.
   */
  clearCategory(): void {
    this._activeCategory = null;
    this.renderCategoryChips();
    this._callbacks.onCategoryFilter?.(null);
  }

  /**
   * Displays a floating toast notification.
   */
  showToast(message: string, durationMs = 3000): void {
    if (this._toastTimeout !== null) {
      window.clearTimeout(this._toastTimeout);
      this._toastTimeout = null;
    }

    this.toastContainer.textContent = message;
    this.toastContainer.classList.remove("hidden");
    this.toastContainer.classList.add("visible");

    this._toastTimeout = window.setTimeout(() => {
      this.toastContainer.classList.remove("visible");
      this.toastContainer.classList.add("hidden");
      this._toastTimeout = null;
    }, durationMs);
  }

  private renderCategoryChips(): void {
    this.chipsContainer.innerHTML = "";
    if (this._categories.length === 0) return;

    for (const cat of this._categories) {
      const normCat = normalizeCategory(cat);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `category-chip ${this._activeCategory === normCat ? "active" : ""}`;
      btn.textContent = cat;
      btn.dataset.category = normCat;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setCategory(cat);
      });
      this.chipsContainer.appendChild(btn);
    }
  }

  private setupEvents(): void {
    // Backdrop click closes search
    const backdrop = this.container.querySelector("#poi-search-backdrop");
    backdrop?.addEventListener("click", () => {
      this.close(true);
    });

    // Clear button
    this.clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.input.value = "";
      this.clearBtn.classList.add("hidden");
      this.input.focus();
      this.updateQueryResults();
    });

    // Input events with full typing isolation (WASD, R, B, U, etc. never fire)
    this.input.addEventListener("input", () => {
      this.clearBtn.classList.toggle("hidden", this.input.value.length === 0);
      this.updateQueryResults();
    });

    this.input.addEventListener("keydown", (e: KeyboardEvent) => {
      // Prevent bubbling to window hotkeys
      e.stopPropagation();

      if (e.code === "Escape" || e.key === "Escape") {
        e.preventDefault();
        this.close(true);
      } else if (e.code === "ArrowDown" || e.key === "ArrowDown") {
        e.preventDefault();
        this.moveSelection(1);
      } else if (e.code === "ArrowUp" || e.key === "ArrowUp") {
        e.preventDefault();
        this.moveSelection(-1);
      } else if (e.code === "Enter" || e.key === "Enter") {
        e.preventDefault();
        const selected = this.getSelectedPOI();
        if (selected && !selected.unreachable) {
          if (e.shiftKey) {
            // Shift + Enter = Jump
            this.triggerJump(selected.poi);
          } else {
            // Enter = Navigate
            this.triggerNavigate(selected.poi, selected.walkingDistance);
          }
        }
      }
    });

    this.input.addEventListener("keyup", (e: KeyboardEvent) => {
      e.stopPropagation();
    });

    // Action button clicks
    const jumpBtn = this.container.querySelector("#btn-search-jump");
    jumpBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const selected = this.getSelectedPOI();
      if (selected && !selected.unreachable) {
        this.triggerJump(selected.poi);
      }
    });

    const navBtn = this.container.querySelector("#btn-search-nav");
    navBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const selected = this.getSelectedPOI();
      if (selected && !selected.unreachable) {
        this.triggerNavigate(selected.poi, selected.walkingDistance);
      }
    });
  }

  private moveSelection(delta: number): void {
    if (this._currentResults.length === 0) return;
    const len = this._currentResults.length;
    let nextIdx = (this._selectedIndex + delta + len) % len;

    // If candidate is unreachable, try to find next reachable item
    let attempts = 0;
    while (this._currentResults[nextIdx]?.unreachable && attempts < len) {
      nextIdx = (nextIdx + delta + len) % len;
      attempts++;
    }

    this._selectedIndex = nextIdx;
    this.updateSelectionDOM();

    const selected = this.getSelectedPOI();
    if (selected && !selected.unreachable) {
      this._callbacks.onSelectPOI?.(selected.poi);
    }
  }

  private getSelectedPOI(): { poi: POI; walkingDistance?: number; unreachable?: boolean } | null {
    if (this._selectedIndex >= 0 && this._selectedIndex < this._currentResults.length) {
      return this._currentResults[this._selectedIndex];
    }
    return null;
  }

  private triggerJump(poi: POI): void {
    this.close(true);
    this._callbacks.onJumpRequested?.(poi);
  }

  private triggerNavigate(poi: POI, distanceM?: number): void {
    this.close(true);
    this._callbacks.onNavigateRequested?.(poi, distanceM);
  }

  /**
   * Refreshes search results based on current query and distance field.
   */
  updateQueryResults(playerPos?: { x: number; z: number }): void {
    const query = this.input.value.trim();
    const distField = this._distanceGate.cachedField;

    let items: Array<{ poi: POI; walkingDistance?: number; unreachable?: boolean }> = [];

    if (query.length > 0) {
      // 1. Live text search with tie-breaking
      const searchRes: SearchResult[] = searchPOIs(
        query,
        this._pois,
        distField ?? undefined,
        this._grid ?? undefined,
        playerPos
      );

      // Filter by active category if set
      const filtered = this._activeCategory
        ? searchRes.filter((r) => r.category.toLowerCase().trim() === this._activeCategory)
        : searchRes;

      items = filtered.slice(0, 8).map((r) => ({
        poi: r.poi,
        walkingDistance: r.walkingDistance,
        unreachable: Boolean(r.poi.unreachable),
      }));
    } else {
      // 2. Empty state: category filter or all POIs sorted by walking distance
      const catItems: CategorizedPOIItem[] = filterPOIsByCategory(
        this._pois,
        this._activeCategory,
        distField,
        this._grid ?? undefined
      );

      items = catItems.slice(0, 8).map((item) => ({
        poi: item.poi,
        walkingDistance: item.walkingDistance,
        unreachable: Boolean(item.poi.unreachable),
      }));
    }

    this._currentResults = items;

    // Pick first reachable item as default selection
    let firstReachable = 0;
    while (firstReachable < items.length && items[firstReachable].unreachable) {
      firstReachable++;
    }
    this._selectedIndex = firstReachable < items.length ? firstReachable : 0;

    this.renderResultsDOM(query);
  }

  private renderResultsDOM(query: string): void {
    this.resultsContainer.innerHTML = "";

    const actionsBar = this.container.querySelector("#poi-search-actions") as HTMLElement;

    if (this._currentResults.length === 0) {
      actionsBar?.classList.add("hidden");
      this.resultsContainer.innerHTML = `
        <div class="poi-search-empty">
          <p class="empty-title">No matching POIs found for "${query}"</p>
          <p class="empty-hint">Try searching for table, chair, bench, stage, door, or window.</p>
        </div>
      `;
      return;
    }

    // Render up to 8 result items
    this._currentResults.forEach((item, idx) => {
      const poi = item.poi;
      const isUnreachable = Boolean(item.unreachable);

      const div = document.createElement("div");
      div.className = `poi-result-item ${idx === this._selectedIndex ? "selected" : ""} ${isUnreachable ? "unreachable" : ""}`;
      div.dataset.index = String(idx);
      div.setAttribute("role", "option");
      div.setAttribute("aria-selected", idx === this._selectedIndex ? "true" : "false");
      if (isUnreachable) {
        div.setAttribute("aria-disabled", "true");
      }

      let distHtml = "";
      if (isUnreachable) {
        distHtml = `<span class="result-dist error">Unreachable</span>`;
      } else if (item.walkingDistance !== undefined) {
        distHtml = `<span class="result-dist">📍 ${item.walkingDistance.toFixed(1)} m</span>`;
      }

      const aliasSnippet = poi.aliases && poi.aliases.length > 0
        ? `<span class="result-alias">(${poi.aliases[0]})</span>`
        : "";

      div.innerHTML = `
        <div class="result-left">
          <span class="result-name">${poi.name}</span>
          ${aliasSnippet}
          <span class="result-category-chip">${poi.category}</span>
        </div>
        <div class="result-right">
          ${distHtml}
        </div>
      `;

      if (!isUnreachable) {
        div.addEventListener("click", (e) => {
          e.stopPropagation();
          this._selectedIndex = idx;
          this.updateSelectionDOM();
          this._callbacks.onSelectPOI?.(poi);
        });

        div.addEventListener("mouseenter", () => {
          this._selectedIndex = idx;
          this.updateSelectionDOM();
        });
      }

      this.resultsContainer.appendChild(div);
    });

    this.updateSelectionDOM();
  }

  private updateSelectionDOM(): void {
    const items = this.resultsContainer.querySelectorAll(".poi-result-item");
    items.forEach((item, idx) => {
      const isSel = idx === this._selectedIndex;
      item.classList.toggle("selected", isSel);
      item.setAttribute("aria-selected", isSel ? "true" : "false");
      if (isSel) {
        item.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });

    // Update Action Bar
    const actionsBar = this.container.querySelector("#poi-search-actions") as HTMLElement;
    const actionInfo = this.container.querySelector("#poi-action-info") as HTMLElement;
    const selected = this.getSelectedPOI();

    if (!selected || selected.unreachable) {
      actionsBar?.classList.add("hidden");
    } else {
      actionsBar?.classList.remove("hidden");
      const dText = selected.walkingDistance !== undefined
        ? ` • Walking: ${selected.walkingDistance.toFixed(1)} m`
        : "";
      actionInfo.textContent = `Selected: "${selected.poi.name}" (${selected.poi.category})${dText}`;
    }
  }
}
