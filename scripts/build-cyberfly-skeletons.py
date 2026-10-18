#!/usr/bin/env python3
"""
Download MaleCNS SWC skeletons for cyberfly subnet neurons and build:
  frontend/public/cyberfly/layout.json   — soma positions + groups
  frontend/public/cyberfly/filaments.bin — downsampled cable segments (binary)

Public SWCs (no token):
  https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/skeletons-malecns/skeletons-swc/{bodyId}.swc

Run from repo root:
  python3 scripts/build-cyberfly-skeletons.py
"""
from __future__ import annotations

import json
import math
import os
import struct
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUBNET_PATH = ROOT / "frontend/public/cyberfly/subnet.json"
# Prefer agent copy if public is stale; both should match after layout builds
AGENT_SUBNET = ROOT / "agent/data/cyberfly-subnet.json"
OUT_DIR = ROOT / "frontend/public/cyberfly"
CACHE_DIR = ROOT / "agent/data/cyberfly-swc"
SWC_URL = (
    "https://storage.googleapis.com/flyem-male-cns/v1.0/segmentation/"
    "skeletons-malecns/skeletons-swc/{bodyId}.swc"
)

# Geometry budget: ~80k segments → ~160k verts (fits adaptive maxEdges range)
MAX_SEGMENTS = 90_000
MIN_SEGS_PER_NEURON = 4
MAX_SEGS_PER_NEURON = 120
CONCURRENCY = 40
SCENE_EXTENT = 5.4  # target max AABB edge in R3F units


def group_of(n: dict) -> str:
    t = n.get("type") or ""
    nt = n.get("nt") or ""
    tl = t.lower()
    if "P1" in t or "fru" in tl or "Courtship" in t:
        return "P1"
    if t.startswith("DN") or "DNa" in t or "DNb" in t:
        return "DN"
    if nt == "gaba":
        return "GABA"
    return "other"


GROUP_CODE = {"P1": 0, "DN": 1, "GABA": 2, "other": 3}


def fetch_swc(body_id: int) -> tuple[int, str, Path | None]:
    path = CACHE_DIR / f"{body_id}.swc"
    if path.exists() and path.stat().st_size > 50:
        return body_id, "cached", path
    url = SWC_URL.format(bodyId=body_id)
    last_err = ""
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sanguo-cyberfly/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            if len(data) < 50:
                return body_id, "empty", None
            path.write_bytes(data)
            return body_id, "ok", path
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}"
            if e.code == 404:
                return body_id, "missing", None
            time.sleep(0.35 * (attempt + 1))
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
            time.sleep(0.35 * (attempt + 1))
    return body_id, f"fail:{last_err}", None


def parse_swc(path: Path) -> tuple[tuple[float, float, float], list[tuple[float, float, float, float, float, float]]]:
    """Return (soma_xyz, edge_segments as xyzabc). Soma = root (parent=-1), else max radius."""
    nodes: dict[int, tuple[float, float, float, float, int]] = {}
    for line in path.read_text(errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 7:
            continue
        nid = int(float(parts[0]))
        x, y, z, r = float(parts[2]), float(parts[3]), float(parts[4]), float(parts[5])
        parent = int(float(parts[6]))
        nodes[nid] = (x, y, z, r, parent)

    if not nodes:
        raise ValueError("empty swc")

    root_id = None
    max_r = -1.0
    max_r_id = None
    for nid, (x, y, z, r, parent) in nodes.items():
        if parent < 0 and root_id is None:
            root_id = nid
        if r > max_r:
            max_r = r
            max_r_id = nid
    soma_id = root_id if root_id is not None else max_r_id
    assert soma_id is not None
    sx, sy, sz, _, _ = nodes[soma_id]
    soma = (sx, sy, sz)

    edges: list[tuple[float, float, float, float, float, float]] = []
    for nid, (x, y, z, _r, parent) in nodes.items():
        if parent < 0 or parent not in nodes:
            continue
        px, py, pz, _, _ = nodes[parent]
        edges.append((x, y, z, px, py, pz))
    return soma, edges


def downsample_edges(
    edges: list[tuple[float, float, float, float, float, float]],
    budget: int,
    seed: int,
) -> list[tuple[float, float, float, float, float, float]]:
    if not edges or budget <= 0:
        return []
    if len(edges) <= budget:
        return edges
    # Deterministic stride sample across cable
    stride = max(1, len(edges) // budget)
    out = edges[::stride][:budget]
    # If still short, fill with hash-ish picks
    if len(out) < budget:
        step = max(1, len(edges) // (budget - len(out) + 1))
        for i in range(seed % step, len(edges), step):
            if len(out) >= budget:
                break
            e = edges[i]
            if e not in out:
                out.append(e)
    return out[:budget]


def main() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    subnet_path = SUBNET_PATH if SUBNET_PATH.exists() else AGENT_SUBNET
    data = json.loads(subnet_path.read_text())
    neurons: list[dict] = data["neurons"]
    body_ids = [int(n["id"]) for n in neurons]
    groups = [group_of(n) for n in neurons]
    n = len(neurons)
    print(f"subnet neurons: {n}", flush=True)

    # --- download ---
    t0 = time.time()
    results: dict[int, Path | None] = {}
    status_counts: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futs = {ex.submit(fetch_swc, bid): bid for bid in body_ids}
        done = 0
        for fut in as_completed(futs):
            bid, status, path = fut.result()
            results[bid] = path
            key = status.split(":")[0]
            status_counts[key] = status_counts.get(key, 0) + 1
            done += 1
            if done % 250 == 0 or done == n:
                print(f"  download {done}/{n} {status_counts}", flush=True)
    print(f"download done in {time.time()-t0:.1f}s → {status_counts}", flush=True)

    # --- parse + collect ---
    somas: list[tuple[float, float, float] | None] = [None] * n
    per_edges: list[list[tuple[float, float, float, float, float, float]]] = [[] for _ in range(n)]
    parsed_ok = 0
    for i, bid in enumerate(body_ids):
        path = results.get(bid)
        if path is None:
            continue
        try:
            soma, edges = parse_swc(path)
            somas[i] = soma
            per_edges[i] = edges
            parsed_ok += 1
        except Exception as e:  # noqa: BLE001
            print(f"  parse fail {bid}: {e}", flush=True)

    print(f"parsed OK: {parsed_ok}/{n}", flush=True)
    if parsed_ok < n * 0.5:
        raise SystemExit("too many SWC failures; aborting")

    # Fill missing somas with centroid of successful ones (keeps index alignment)
    ok_somas = [s for s in somas if s is not None]
    cx = sum(s[0] for s in ok_somas) / len(ok_somas)
    cy = sum(s[1] for s in ok_somas) / len(ok_somas)
    cz = sum(s[2] for s in ok_somas) / len(ok_somas)
    for i in range(n):
        if somas[i] is None:
            somas[i] = (cx, cy, cz)

    # Allocate segment budgets proportional to sqrt(edge count)
    weights = [math.sqrt(max(1, len(per_edges[i]))) for i in range(n)]
    wsum = sum(weights) or 1.0
    budgets = []
    for i in range(n):
        b = int(MAX_SEGMENTS * (weights[i] / wsum))
        b = max(MIN_SEGS_PER_NEURON if per_edges[i] else 0, min(MAX_SEGS_PER_NEURON, b))
        if not per_edges[i]:
            b = 0
        budgets.append(b)
    # Rescale if over budget
    total_b = sum(budgets)
    if total_b > MAX_SEGMENTS:
        scale = MAX_SEGMENTS / total_b
        budgets = [max(0, int(b * scale)) for b in budgets]

    raw_segs: list[tuple[float, float, float, float, float, float, int, int]] = []
    # (ax,ay,az,bx,by,bz, neuronIndex, groupCode)
    for i in range(n):
        edges = downsample_edges(per_edges[i], budgets[i], seed=body_ids[i])
        gcode = GROUP_CODE[groups[i]]
        for e in edges:
            raw_segs.append((*e, i, gcode))

    print(f"segments before transform: {len(raw_segs)} (budget {MAX_SEGMENTS})", flush=True)

    # --- normalize into compact AABB ---
    # Use all soma + segment endpoints for AABB
    pts: list[tuple[float, float, float]] = [somas[i] for i in range(n)]  # type: ignore
    for seg in raw_segs:
        pts.append((seg[0], seg[1], seg[2]))
        pts.append((seg[3], seg[4], seg[5]))

    minx = min(p[0] for p in pts)
    maxx = max(p[0] for p in pts)
    miny = min(p[1] for p in pts)
    maxy = max(p[1] for p in pts)
    minz = min(p[2] for p in pts)
    maxz = max(p[2] for p in pts)
    mx = 0.5 * (minx + maxx)
    my = 0.5 * (miny + maxy)
    mz = 0.5 * (minz + maxz)
    ext = max(maxx - minx, maxy - miny, maxz - minz) or 1.0
    scale = SCENE_EXTENT / ext

    # MaleCNS voxel space: Z often longest (VNC). Map to scene so long axis ≈ Y (up),
    # and brain (wider coronal spread) sits toward +Y like neuPrint side/3/4 views.
    # Transform: scene_x = (raw_x - mx)*scale, scene_y = (raw_z - mz)*scale, scene_z = -(raw_y - my)*scale
    # Then flip Y if the +Y half has smaller radial spread than -Y (brain should be up).
    def to_scene(x: float, y: float, z: float) -> tuple[float, float, float]:
        return ((x - mx) * scale, (z - mz) * scale, -(y - my) * scale)

    soma_scene = [to_scene(*somas[i]) for i in range(n)]  # type: ignore

    # Brain-up flip: compare mean radial extent in XZ for upper vs lower Y thirds of somata
    ys = [p[1] for p in soma_scene]
    y_lo = sorted(ys)[n // 3]
    y_hi = sorted(ys)[(2 * n) // 3]

    def mean_radius(pred) -> float:
        rs = []
        for p in soma_scene:
            if pred(p[1]):
                rs.append(math.hypot(p[0], p[2]))
        return sum(rs) / len(rs) if rs else 0.0

    r_high = mean_radius(lambda y: y >= y_hi)
    r_low = mean_radius(lambda y: y <= y_lo)
    flip_y = r_high < r_low  # if upper is thinner, flip so brain goes up
    print(f"orientation: r_high={r_high:.3f} r_low={r_low:.3f} flip_y={flip_y}", flush=True)

    def finalize(x: float, y: float, z: float) -> tuple[float, float, float]:
        if flip_y:
            y = -y
        return (
            round(x, 4),
            round(y, 4),
            round(z, 4),
        )

    positions = [list(finalize(*p)) for p in soma_scene]

    # Write filaments.bin
    # magic "MCNS" | u32 version=1 | u32 segmentCount
    # f32 positions[count*6] | u8 groups[count] | u16 neuronIndex[count]
    segs_out: list[tuple[float, float, float, float, float, float, int, int]] = []
    for ax, ay, az, bx, by, bz, ni, gc in raw_segs:
        a = finalize(*to_scene(ax, ay, az))
        b = finalize(*to_scene(bx, by, bz))
        segs_out.append((*a, *b, ni, gc))

    seg_count = len(segs_out)
    buf = bytearray()
    buf += b"MCNS"
    buf += struct.pack("<II", 1, seg_count)
    for s in segs_out:
        buf += struct.pack("<6f", s[0], s[1], s[2], s[3], s[4], s[5])
    buf += bytes(s[7] for s in segs_out)
    # pad to even for u16 alignment
    if len(buf) % 2:
        buf += b"\0"
    for s in segs_out:
        buf += struct.pack("<H", s[6])

    fil_path = OUT_DIR / "filaments.bin"
    fil_path.write_bytes(buf)

    layout = {
        "version": 3,
        "source": "male-cns-swc",
        "count": n,
        "positions": positions,
        "groups": groups,
        "meta": {
            "swcParsed": parsed_ok,
            "swcStatus": status_counts,
            "segments": seg_count,
            "sceneExtent": SCENE_EXTENT,
            "flipY": flip_y,
            "rawAABB": [minx, maxx, miny, maxy, minz, maxz],
        },
    }
    layout_path = OUT_DIR / "layout.json"
    layout_path.write_text(json.dumps(layout, separators=(",", ":")))

    # Tiny manifest for the client
    manifest = {
        "version": 1,
        "file": "filaments.bin",
        "segmentCount": seg_count,
        "groups": ["P1", "DN", "GABA", "other"],
        "attribution": "MaleCNS CC-BY (Janelia FlyEM)",
    }
    (OUT_DIR / "filaments.json").write_text(json.dumps(manifest, indent=2) + "\n")

    print(
        f"wrote layout.json ({layout_path.stat().st_size} B), "
        f"filaments.bin ({fil_path.stat().st_size} B, {seg_count} segs), "
        f"filaments.json",
        flush=True,
    )
    print(
        f"soma AABB scene: "
        f"x[{min(p[0] for p in positions):.2f},{max(p[0] for p in positions):.2f}] "
        f"y[{min(p[1] for p in positions):.2f},{max(p[1] for p in positions):.2f}] "
        f"z[{min(p[2] for p in positions):.2f},{max(p[2] for p in positions):.2f}]",
        flush=True,
    )


if __name__ == "__main__":
    main()
