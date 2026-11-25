/**
 * guidance_hud.ts
 * Real-time navigation guidance HUD overlay.
 * Displays:
 *  - Destination name
 *  - Remaining walking distance and ETA
 *  - Next direction instruction with turn icon
 *  - Route progress bar
 *  - Action buttons: "Follow Route (Key G)" and "Clear Route (Key C)"
 *  - Debug stats pill (Key O) showing path length, compute ms, expanded nodes
 *  - Arrival banner when within 0.6 m of anchor
 *
 * Responsive layout at 1280x720 and 390px mobile width without overlapping
 * search bar (top-center), minimap (top-right), or F3 stats panel (top-left).
 */

import { NavigationInstruction } from "../nav/instructions";
import { RouteState } from "../nav/route_state";

export interface GuidanceHUDCallbacks {
  onFollowRoute?: () => void;
  onClearRoute?: () => void;
  onToggleDebug?: () => void;
}

export class GuidanceHUD {
  private readonly container: HTMLDivElement;
  private readonly destNameEl: HTMLElement;
  private readonly instructionIconEl: HTMLElement;
  private readonly instructionTextEl: HTMLElement;
  private readonly distanceEl: HTMLElement;
  private readonly etaEl: HTMLElement;
  private readonly progressBarEl: HTMLElement;
  private readonly btnFollowEl: HTMLButtonElement;
  private readonly btnClearEl: HTMLButtonElement;
  private readonly debugStatsEl: HTMLElement;
  private readonly debugPathLenEl: HTMLElement;
  private readonly debugTimeEl: HTMLElement;
  private readonly debugNodesEl: HTMLElement;
  private readonly arrivalToastEl: HTMLElement;

  private _isVisible = false;
  private _callbacks: GuidanceHUDCallbacks;

  constructor(callbacks: GuidanceHUDCallbacks = {}) {
    this._callbacks = callbacks;

    this.container = document.createElement("div");
    this.container.id = "guidance-hud";
    this.container.className = "guidance-hud hidden";

    this.container.innerHTML = `
      <div class="guidance-hud-card" id="guidance-hud-card">
        <!-- Header: Destination and Metrics -->
        <div class="guidance-hud-header">
          <div class="guidance-dest-group">
            <span class="guidance-dest-icon" aria-hidden="true">📍</span>
            <span class="guidance-dest-name" id="guidance-dest-name">Destination</span>
          </div>
          <div class="guidance-metrics-group">
            <span class="guidance-metric-distance" id="guidance-metric-distance">0.0 m</span>
            <span class="guidance-metric-dot">•</span>
            <span class="guidance-metric-eta" id="guidance-metric-eta">0 s</span>
          </div>
        </div>

        <!-- Progress Track -->
        <div class="guidance-progress-track">
          <div class="guidance-progress-fill" id="guidance-progress-fill" style="width: 0%;"></div>
        </div>

        <!-- Main Instruction Row -->
        <div class="guidance-instruction-row">
          <div class="guidance-turn-icon-box" id="guidance-turn-icon-box">
            <span class="guidance-turn-icon" id="guidance-turn-icon">⬆️</span>
          </div>
          <div class="guidance-instruction-content">
            <div class="guidance-instruction-text" id="guidance-instruction-text">Starting navigation...</div>
          </div>
        </div>

        <!-- Debug Overlay Bar (Key O) -->
        <div class="guidance-debug-bar hidden" id="guidance-debug-bar">
          <span class="guidance-debug-badge">DEBUG (O)</span>
          <span>Length: <strong id="debug-path-length">0.0 m</strong></span>
          <span>A* Time: <strong id="debug-compute-ms">0.0 ms</strong></span>
          <span>Nodes: <strong id="debug-expanded-nodes">0</strong></span>
        </div>

        <!-- Action Controls -->
        <div class="guidance-actions-row">
          <button type="button" class="btn-guidance-follow" id="btn-guidance-follow" title="Toggle Auto-Walk (Key G)">
            <span class="btn-icon">🚶</span>
            <span class="btn-label" id="btn-guidance-follow-label">Follow Route</span>
            <kbd class="btn-kbd">G</kbd>
          </button>
          <button type="button" class="btn-guidance-clear" id="btn-guidance-clear" title="Clear Route (Key C)">
            <span class="btn-icon">✕</span>
            <span class="btn-label">Clear</span>
            <kbd class="btn-kbd">C</kbd>
          </button>
        </div>
      </div>

      <!-- Arrival Banner -->
      <div class="guidance-arrival-banner hidden" id="guidance-arrival-banner">
        <span class="arrival-icon">🎉</span>
        <span class="arrival-text" id="guidance-arrival-text">You have arrived!</span>
      </div>
    `;

    document.body.appendChild(this.container);

    this.destNameEl = this.container.querySelector("#guidance-dest-name") as HTMLElement;
    this.instructionIconEl = this.container.querySelector("#guidance-turn-icon") as HTMLElement;
    this.instructionTextEl = this.container.querySelector("#guidance-instruction-text") as HTMLElement;
    this.distanceEl = this.container.querySelector("#guidance-metric-distance") as HTMLElement;
    this.etaEl = this.container.querySelector("#guidance-metric-eta") as HTMLElement;
    this.progressBarEl = this.container.querySelector("#guidance-progress-fill") as HTMLElement;
    this.btnFollowEl = this.container.querySelector("#btn-guidance-follow") as HTMLButtonElement;
    this.btnClearEl = this.container.querySelector("#btn-guidance-clear") as HTMLButtonElement;
    this.debugStatsEl = this.container.querySelector("#guidance-debug-bar") as HTMLElement;
    this.debugPathLenEl = this.container.querySelector("#debug-path-length") as HTMLElement;
    this.debugTimeEl = this.container.querySelector("#debug-compute-ms") as HTMLElement;
    this.debugNodesEl = this.container.querySelector("#debug-expanded-nodes") as HTMLElement;
    this.arrivalToastEl = this.container.querySelector("#guidance-arrival-banner") as HTMLElement;

    this.setupEvents();
  }

  private setupEvents(): void {
    this.btnFollowEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this._callbacks.onFollowRoute?.();
    });

    this.btnClearEl.addEventListener("click", (e) => {
      e.stopPropagation();
      this._callbacks.onClearRoute?.();
    });
  }

  show(): void {
    if (this._isVisible) return;
    this._isVisible = true;
    this.container.classList.remove("hidden");
  }

  hide(): void {
    if (!this._isVisible) return;
    this._isVisible = false;
    this.container.classList.add("hidden");
    this.hideArrivalBanner();
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  /**
   * Updates HUD contents from route state and instruction.
   * Modifies existing DOM textContent without layout thrashing.
   */
  update(state: RouteState, instruction: NavigationInstruction): void {
    if (state.status === "idle" || !state.targetPOI) {
      this.hide();
      return;
    }

    this.show();

    // 1. Destination name
    this.destNameEl.textContent = state.targetPOI.name;

    // 2. Metrics
    const distM = instruction.remainingDistanceM;
    this.distanceEl.textContent = `${distM.toFixed(1)} m`;

    const etaS = instruction.etaSeconds;
    this.etaEl.textContent = etaS >= 60 ? `${Math.floor(etaS / 60)}m ${etaS % 60}s` : `${etaS}s`;

    // 3. Progress bar
    const pct = Math.round(instruction.progressFraction * 100);
    this.progressBarEl.style.width = `${pct}%`;

    // 4. Next instruction text and icon
    this.instructionTextEl.textContent = instruction.text;
    this.instructionIconEl.textContent = this.getInstructionIcon(instruction.type);

    // 5. Auto-walk button state
    const followLabel = this.container.querySelector("#btn-guidance-follow-label");
    if (followLabel) {
      followLabel.textContent = state.autoWalkActive ? "Stop Walking" : "Follow Route";
    }
    this.btnFollowEl.classList.toggle("active-walking", state.autoWalkActive);

    // 6. Debug bar
    if (state.debugOverlayActive) {
      this.debugStatsEl.classList.remove("hidden");
      this.debugPathLenEl.textContent = `${state.totalLengthM.toFixed(1)} m`;
      this.debugTimeEl.textContent = `${state.computeMs.toFixed(1)} ms`;
      this.debugNodesEl.textContent = `${state.expandedNodes}`;
    } else {
      this.debugStatsEl.classList.add("hidden");
    }
  }

  /**
   * Shows arrival toast banner for ~3 seconds.
   */
  showArrival(poiName: string): void {
    const textEl = this.container.querySelector("#guidance-arrival-text");
    if (textEl) {
      textEl.textContent = `You have arrived at ${poiName}`;
    }
    this.arrivalToastEl.classList.remove("hidden");
    setTimeout(() => {
      this.hideArrivalBanner();
    }, 3500);
  }

  hideArrivalBanner(): void {
    this.arrivalToastEl.classList.add("hidden");
  }

  private getInstructionIcon(type: string): string {
    switch (type) {
      case "continue":
        return "⬆️";
      case "turn-left":
        return "↖️";
      case "turn-right":
        return "↗️";
      case "turn-sharp-left":
        return "⬅️";
      case "turn-sharp-right":
        return "➡️";
      case "arrive":
      case "arrived":
        return "🏁";
      default:
        return "🧭";
    }
  }
}
