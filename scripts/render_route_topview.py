import argparse
import json
import math
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser = argparse.ArgumentParser(description="Render top-view route images for Phase 6 evaluation")
    parser.add_argument("--occ", default="viewer/public/scene/occupancy.json", help="Path to occupancy.json")
    parser.add_argument("--poi", default="viewer/public/scene/poi.json", help="Path to poi.json")
    parser.add_argument("--routes", required=True, help="Path to routes JSON file")
    parser.add_argument("--out-dir", default="docs/images", help="Output directory")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    with open(args.occ, "r", encoding="utf-8") as f:
        occ = json.load(f)
    with open(args.poi, "r", encoding="utf-8") as f:
        poi_data = json.load(f)
    with open(args.routes, "r", encoding="utf-8") as f:
        routes_data = json.load(f)

    w = occ["width"]
    h = occ["height"]
    cell_size = occ["cell_size"]
    origin = occ["origin"]  # [min_x, min_z]
    bounds = occ.get("bounds", {
        "min_x": origin[0],
        "max_x": origin[0] + w * cell_size,
        "min_z": origin[1],
        "max_z": origin[1] + h * cell_size
    })

    # Prepare 2D grid image (free = white, blocked = dark gray)
    raw_data = occ.get("data") or occ.get("state")
    grid = np.array(raw_data, dtype=np.uint8).reshape((h, w))
    # If using 'state' (0=unknown, 1=free, 2=obstacle, 3=margin), free is 1
    # If using 'data' (0=free, 1=blocked)
    if "state" in occ:
        is_free = (grid == 1)
    else:
        is_free = (grid == 0)

    bg = np.ones((h, w, 3), dtype=np.float32)
    bg[~is_free] = [0.82, 0.84, 0.88] # Obstacle soft slate gray
    bg[is_free] = [0.98, 0.98, 0.99]  # Walkable light cream

    extent = [bounds["min_x"], bounds["max_x"], bounds["max_z"], bounds["min_z"]]

    pois = poi_data.get("pois", [])

    for r_info in routes_data:
        tag = r_info["tag"] # 'route_long', 'route_detour', 'route_short'
        title = r_info["title"]
        pts = r_info["points"]
        from_name = r_info["from"]
        to_name = r_info["to"]
        length_m = r_info["length_m"]
        ratio = r_info.get("ratio", 1.0)

        fig, ax = plt.subplots(figsize=(8, 8), dpi=150)
        ax.imshow(bg, extent=extent, origin="upper", aspect="equal")

        # Plot all POI anchors as subtle gray markers
        for p in pois:
            pos = p.get("anchor") or p["position"]
            ax.plot(pos["x"], pos["z"], "o", color="#94a3b8", markersize=4, alpha=0.7)

        # Plot route polyline
        xs = [p["x"] for p in pts]
        zs = [p["z"] for p in pts]

        # Route glow + core
        ax.plot(xs, zs, "-", color="#38bdf8", linewidth=4.5, alpha=0.5, label="Route corridor")
        ax.plot(xs, zs, "-", color="#0284c7", linewidth=2.5, alpha=0.95)

        # Waypoints
        ax.plot(xs, zs, ".", color="#0369a1", markersize=6)

        # Start (Green) & End (Red/Amber)
        ax.plot(xs[0], zs[0], "o", color="#22c55e", markersize=10, markeredgecolor="white", markeredgewidth=1.5, zorder=5, label=f"Start: {from_name}")
        ax.plot(xs[-1], zs[-1], "s", color="#ef4444", markersize=10, markeredgecolor="white", markeredgewidth=1.5, zorder=5, label=f"Goal: {to_name}")

        # Text labels for start & goal
        ax.annotate(f" {from_name}", (xs[0], zs[0]), fontsize=9, fontweight="bold", color="#15803d",
                    bbox=dict(boxstyle="round,pad=0.2", facecolor="white", edgecolor="#22c55e", alpha=0.9))
        ax.annotate(f" {to_name}", (xs[-1], zs[-1]), fontsize=9, fontweight="bold", color="#b91c1c",
                    bbox=dict(boxstyle="round,pad=0.2", facecolor="white", edgecolor="#ef4444", alpha=0.9))

        ax.set_title(f"{title}\n{from_name} -> {to_name} ({length_m:.2f} m, Walk/Straight: {ratio:.2f}x)", fontsize=11, fontweight="bold", pad=12)
        ax.set_xlabel("X (metres)", fontsize=9)
        ax.set_ylabel("Z (metres)", fontsize=9)
        ax.grid(True, linestyle="--", alpha=0.3)
        ax.legend(loc="lower right", fontsize=8, framealpha=0.9)

        out_path = os.path.join(args.out_dir, f"{tag}.png")
        plt.tight_layout()
        plt.savefig(out_path, dpi=150)
        plt.close(fig)
        print(f"Saved: {out_path}")


if __name__ == "__main__":
    main()
