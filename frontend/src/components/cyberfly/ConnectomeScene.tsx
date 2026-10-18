import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { SpikeFrame } from "@sanguo/shared";
import { populationColor } from "./populationColor";
import { useSpikePlayback } from "./useSpikePlayback";

type BoundaryProps = { children: ReactNode; fallback: ReactNode };
type BoundaryState = { error: Error | null };

class WebGlErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }
  render() {
    if (this.state.error) return this.props.fallback;
    return this.props.children;
  }
}

function WebGlUnavailable() {
  return (
    <div className="cyberfly-loading">
      三维连接组需要 WebGL；当前环境不可用，驱动条仍可用。
    </div>
  );
}

type Layout = {
  version: number;
  count: number;
  positions: number[][];
  groups: string[];
  source?: string;
};

type Subnet = {
  neurons: { id: number; nt?: string; type?: string }[];
  synapses: { pre: number; post: number; weight: number }[];
};

type Filaments = {
  segmentCount: number;
  positions: Float32Array;
  groups: Uint8Array;
  neuronIndex: Uint16Array;
};

const GROUP_NAMES = ["P1", "DN", "GABA", "other"] as const;

/** Soft light-blue current (readable on dark anatomy). */
const FLASH = new THREE.Color("#6ebfff");
const FLASH_HOT = new THREE.Color("#b8e4ff");
/** Normalize cable distance so tips≈1 and soma≈0 for inward conduction. */
const SOMA_RADIUS = 2.2;
/** Simultaneous traveling fronts per neuron (multi-path / multi-angle). */
const NUM_FRONTS = 4;

function fract(x: number): number {
  return x - Math.floor(x);
}

function radialFromSoma(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
): number {
  return Math.min(1, Math.hypot(x - sx, y - sy, z - sz) / SOMA_RADIUS);
}

/** Wider envelope so many segments stay lit as fronts sweep. */
function pulseAt(front: number, target: number): number {
  let d = Math.abs(front - target);
  if (d > 0.5) d = 1 - d;
  let h = 1 - d * 3.1;
  if (h <= 0) return 0;
  return h * h;
}

/**
 * Continuous multi-path conduction: several phase-offset fronts per neuron,
 * plus a soft shimmer so mid-window never goes dark.
 * front 0 = periphery, 1 = soma.
 */
function conductionStrength(
  t: number,
  neuronIndex: number,
  radial: number,
  mx: number,
  my: number,
  mz: number,
): { peak: number; arrive: number } {
  const angle = Math.atan2(mz, mx) + my * 0.35;
  const target = 1 - radial;
  let peak = 0;
  let arrive = 0;
  for (let k = 0; k < NUM_FRONTS; k++) {
    const front = fract(t * 1.75 + neuronIndex * 0.119 + k / NUM_FRONTS + angle * 0.09);
    peak = Math.max(peak, pulseAt(front, target));
    arrive = Math.max(arrive, pulseAt(front, 1));
  }
  // Low continuous shimmer along active cables (not a single blink)
  const shimmer = 0.28 + 0.22 * Math.sin(t * 4.2 + neuronIndex * 0.7 + radial * 5);
  peak = Math.min(1.45, peak * 1.2 + Math.max(0, shimmer) * 0.35 * (1 - radial * 0.4));
  return { peak, arrive };
}

/** Amplify mid rates so more pathways participate while thinking. */
function effectiveRate(r: number, drama: number): number {
  if (drama < 0.05) return r;
  return Math.min(1, r * 1.55 + 0.06 * drama);
}

async function loadFilaments(url: string): Promise<Filaments> {
  const buf = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`filaments ${r.status}`);
    return r.arrayBuffer();
  });
  const view = new DataView(buf);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  if (magic !== "MCNS") throw new Error("bad filaments magic");
  const version = view.getUint32(4, true);
  const segmentCount = view.getUint32(8, true);
  if (version !== 1) throw new Error(`unsupported filaments v${version}`);
  let offset = 12;
  const positions = new Float32Array(segmentCount * 6);
  for (let i = 0; i < positions.length; i++) {
    positions[i] = view.getFloat32(offset, true);
    offset += 4;
  }
  const groups = new Uint8Array(segmentCount);
  for (let i = 0; i < segmentCount; i++) {
    groups[i] = view.getUint8(offset++);
  }
  if (offset % 2) offset += 1;
  const neuronIndex = new Uint16Array(segmentCount);
  for (let i = 0; i < segmentCount; i++) {
    neuronIndex[i] = view.getUint16(offset, true);
    offset += 2;
  }
  return { segmentCount, positions, groups, neuronIndex };
}

function Neurons({
  layout,
  subnet,
  rates,
  drama,
  selectedId,
  focusNeighborIds,
  interactive,
  onSelect,
}: {
  layout: Layout;
  subnet: Subnet;
  rates: number[] | null;
  drama: number;
  selectedId?: number | null;
  focusNeighborIds?: Set<number> | null;
  interactive?: boolean;
  onSelect?: (id: number | null) => void;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const ratesRef = useRef(rates);
  const dramaRef = useRef(drama);
  ratesRef.current = rates;
  dramaRef.current = drama;

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const focusing = !!(focusNeighborIds && focusNeighborIds.size > 0);
    const ratesNow = ratesRef.current;
    const dramaNow = dramaRef.current;
    const t = clock.elapsedTime;
    const pulseOn = dramaNow > 0.06;

    for (let i = 0; i < layout.count; i++) {
      const [x, y, z] = layout.positions[i];
      const nid = subnet.neurons[i]?.id;
      const r = ratesNow?.[i] ?? 0;
      const isSelected = nid !== undefined && nid === selectedId;
      const inFocus = !focusing || (nid !== undefined && focusNeighborIds!.has(nid));

      const re = effectiveRate(r, dramaNow);
      // Flare when any inward front arrives; soft glow between waves
      let pulse = 0;
      if (pulseOn && re > 0.05) {
        const { arrive, peak } = conductionStrength(t, i, 0, x, y, z);
        const glow = 0.22 + 0.18 * Math.max(0, Math.sin(t * 5 + i * 0.9));
        pulse = (arrive * 1.55 + peak * 0.28 + glow * 0.6) * re * (0.7 + dramaNow * 0.45);
      }

      let scale = 0.038 + re * 0.075 * (0.4 + dramaNow) + pulse * 0.12;
      if (isSelected) scale *= 1.9;
      else if (inFocus && focusing) scale *= 1.3;
      if (!inFocus) scale *= 0.45;

      dummy.position.set(x, y, z);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);

      color.set(populationColor(layout.groups[i]));
      let boost = 1.05 + re * 1.1 * (0.35 + dramaNow);
      if (pulse > 0.04) {
        color.lerp(FLASH_HOT, Math.min(0.95, pulse));
        boost += pulse * 2.0;
      }
      if (isSelected) boost = Math.max(boost, 1.85);
      else if (inFocus && focusing) boost = Math.max(boost, 1.25);
      if (!inFocus) boost *= 0.25;
      color.multiplyScalar(boost);
      m.setColorAt(i, color);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (!interactive || !onSelect) return;
    e.stopPropagation();
    const iid = e.instanceId;
    if (iid === undefined) return;
    const nid = subnet.neurons[iid]?.id;
    if (nid === undefined) return;
    onSelect(nid === selectedId ? null : nid);
  };

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, layout.count]}
      onClick={interactive ? handleClick : undefined}
    >
      <sphereGeometry args={[1, 8, 8]} />
      <meshStandardMaterial vertexColors toneMapped={false} />
    </instancedMesh>
  );
}

type SegMeta = {
  ni: number;
  g: number;
  mx: number;
  my: number;
  mz: number;
  /** 0 at soma … 1 at tip (for inward conduction). */
  radial: number;
  radialA: number;
  radialB: number;
};

/** Real MaleCNS SWC cables + traveling current while thinking. */
function SkeletonFilaments({
  filaments,
  layout,
  subnet,
  rates,
  drama,
  maxSegments,
  focusNeighborIds,
}: {
  filaments: Filaments;
  layout: Layout;
  subnet: Subnet;
  rates: number[] | null;
  drama: number;
  maxSegments: number;
  focusNeighborIds?: Set<number> | null;
}) {
  const lineRef = useRef<THREE.LineSegments>(null);
  const matRef = useRef<THREE.LineBasicMaterial>(null);
  const focusing = !!(focusNeighborIds && focusNeighborIds.size > 0);
  const palette = useMemo(
    () => GROUP_NAMES.map((g) => new THREE.Color(populationColor(g))),
    [],
  );
  const tmp = useMemo(() => new THREE.Color(), []);
  const ca = useMemo(() => new THREE.Color(), []);
  const cb = useMemo(() => new THREE.Color(), []);
  const ratesRef = useRef(rates);
  const dramaRef = useRef(drama);
  ratesRef.current = rates;
  dramaRef.current = drama;

  const { positions, meta } = useMemo(() => {
    const total = filaments.segmentCount;
    const cap = Math.min(total, Math.max(2000, maxSegments));
    const chosen: number[] = [];
    if (focusing) {
      for (let i = 0; i < total && chosen.length < cap; i++) {
        const ni = filaments.neuronIndex[i];
        const nid = subnet.neurons[ni]?.id;
        if (nid !== undefined && focusNeighborIds!.has(nid)) chosen.push(i);
      }
      const pad = Math.min(cap, Math.floor(cap * 0.15));
      for (let i = 0; i < total && chosen.length < cap; i += Math.max(1, Math.floor(total / Math.max(1, pad)))) {
        chosen.push(i);
      }
    } else {
      const stride = total <= cap ? 1 : total / cap;
      for (let k = 0; k < cap; k++) chosen.push(Math.min(total - 1, Math.floor(k * stride)));
    }

    const pos = new Float32Array(chosen.length * 6);
    const metas: SegMeta[] = new Array(chosen.length);
    for (let c = 0; c < chosen.length; c++) {
      const i = chosen[c];
      const base = i * 6;
      const o = c * 6;
      for (let k = 0; k < 6; k++) pos[o + k] = filaments.positions[base + k];
      const ax = pos[o];
      const ay = pos[o + 1];
      const az = pos[o + 2];
      const bx = pos[o + 3];
      const by = pos[o + 4];
      const bz = pos[o + 5];
      const ni = filaments.neuronIndex[i];
      const soma = layout.positions[ni] ?? [0, 0, 0];
      const mx = (ax + bx) * 0.5;
      const my = (ay + by) * 0.5;
      const mz = (az + bz) * 0.5;
      metas[c] = {
        ni,
        g: filaments.groups[i] ?? 3,
        mx,
        my,
        mz,
        radial: radialFromSoma(mx, my, mz, soma[0], soma[1], soma[2]),
        radialA: radialFromSoma(ax, ay, az, soma[0], soma[1], soma[2]),
        radialB: radialFromSoma(bx, by, bz, soma[0], soma[1], soma[2]),
      };
    }
    return { positions: pos, meta: metas };
  }, [filaments, layout, subnet, maxSegments, focusNeighborIds, focusing]);

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    return g;
  }, [positions]);

  const metaRef = useRef(meta);
  metaRef.current = meta;

  useFrame(({ clock }) => {
    const line = lineRef.current;
    if (!line) return;
    const attr = line.geometry.getAttribute("color") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const ratesNow = ratesRef.current;
    const dramaNow = dramaRef.current;
    const t = clock.elapsedTime;
    const pulseOn = dramaNow > 0.06;
    const metas = metaRef.current;
    const n = metas.length;

    for (let c = 0; c < n; c++) {
      const m = metas[c];
      tmp.copy(palette[m.g] ?? palette[3]);
      if (m.g === 3) tmp.multiplyScalar(0.78);

      const r = ratesNow?.[m.ni] ?? 0;
      const re = effectiveRate(r, dramaNow);
      let boost = 0.88 + re * 1.15 * (0.4 + dramaNow);
      if (focusing) {
        const nid = subnet.neurons[m.ni]?.id;
        const inFocus = nid !== undefined && focusNeighborIds!.has(nid);
        boost *= inFocus ? 1.25 : 0.22;
      }

      let flashA = 0;
      let flashB = 0;
      if (pulseOn && re > 0.05) {
        const { peak } = conductionStrength(t, m.ni, m.radial, m.mx, m.my, m.mz);
        const amt = Math.min(1.55, peak * re * (0.9 + dramaNow * 0.55));
        // Lead toward soma: endpoint closer to soma gets the crest first
        const leadA = m.radialA <= m.radialB ? 1.25 : 0.75;
        const leadB = m.radialB < m.radialA ? 1.25 : 0.75;
        flashA = Math.min(1.55, amt * leadA);
        flashB = Math.min(1.55, amt * leadB);
        // Light-blue wash so many pathways stay lit between wave crests
        boost += amt * 0.6;
        tmp.lerp(FLASH, Math.min(0.6, 0.22 + amt * 0.5));
      }

      const o = c * 6;
      ca.copy(tmp).multiplyScalar(boost);
      if (flashA > 0.04) ca.lerp(flashA > 0.7 ? FLASH_HOT : FLASH, Math.min(1, flashA));
      arr[o] = ca.r;
      arr[o + 1] = ca.g;
      arr[o + 2] = ca.b;
      cb.copy(tmp).multiplyScalar(boost);
      if (flashB > 0.04) cb.lerp(flashB > 0.7 ? FLASH_HOT : FLASH, Math.min(1, flashB));
      arr[o + 3] = cb.r;
      arr[o + 4] = cb.g;
      arr[o + 5] = cb.b;
    }
    attr.needsUpdate = true;

    if (matRef.current) {
      matRef.current.opacity = focusing
        ? 0.68 + dramaNow * 0.28
        : 0.46 + dramaNow * 0.52;
    }
  });

  return (
    <lineSegments ref={lineRef} geometry={geom}>
      <lineBasicMaterial
        ref={matRef}
        transparent
        opacity={0.45}
        vertexColors
        toneMapped={false}
        depthWrite={false}
      />
    </lineSegments>
  );
}

function Spin({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (enabled && ref.current) ref.current.rotation.y += dt * 0.1;
  });
  return <group ref={ref}>{children}</group>;
}

export function ConnectomeScene({
  frame,
  thinking,
  selectedId = null,
  onSelect,
  focusNeighborIds = null,
  focusEdgeIndices = null,
  interactive = false,
  autoSpin = true,
}: {
  frame: SpikeFrame | null;
  thinking: boolean;
  selectedId?: number | null;
  onSelect?: (id: number | null) => void;
  focusNeighborIds?: Set<number> | null;
  focusEdgeIndices?: number[] | null;
  interactive?: boolean;
  autoSpin?: boolean;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [subnet, setSubnet] = useState<Subnet | null>(null);
  const [filaments, setFilaments] = useState<Filaments | null>(null);
  const [maxSegments, setMaxSegments] = useState(70000);
  const { displayRates, drama } = useSpikePlayback(frame, thinking);
  const fpsSamples = useRef<number[]>([]);

  void focusEdgeIndices;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [l, s, f] = await Promise.all([
          fetch("/cyberfly/layout.json").then((r) => r.json()),
          fetch("/cyberfly/subnet.json").then((r) => r.json()),
          loadFilaments("/cyberfly/filaments.bin"),
        ]);
        if (!cancelled) {
          setLayout(l);
          setSubnet(s);
          setFilaments(f);
        }
      } catch {
        /* soft-fail: parent shows drives only */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let last = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      const samples = fpsSamples.current;
      samples.push(dt);
      if (samples.length > 45) samples.shift();
      if (samples.length === 45) {
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        if (avg > 33 && maxSegments > 12000) {
          setMaxSegments((m) => Math.max(12000, Math.floor(m * 0.72)));
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [maxSegments]);

  if (!layout || !subnet || !filaments) {
    return <div className="cyberfly-loading">加载 MaleCNS 骨架…</div>;
  }

  return (
    <WebGlErrorBoundary fallback={<WebGlUnavailable />}>
      <Canvas
        camera={{ position: [3.2, 0.6, 5.6], fov: 40 }}
        dpr={[1, 1.5]}
        gl={{
          antialias: false,
          powerPreference: "high-performance",
          failIfMajorPerformanceCaveat: false,
        }}
        onPointerMissed={() => {
          if (interactive && onSelect) onSelect(null);
        }}
      >
        <color attach="background" args={["#05080e"]} />
        <ambientLight intensity={0.75} />
        <pointLight position={[5, 7, 4]} intensity={1.2} />
        <pointLight position={[-4, -3, 5]} intensity={0.4} />
        <Spin enabled={autoSpin && drama < 0.35}>
          <SkeletonFilaments
            filaments={filaments}
            layout={layout}
            subnet={subnet}
            rates={displayRates}
            drama={drama}
            maxSegments={maxSegments}
            focusNeighborIds={focusNeighborIds}
          />
          <Neurons
            layout={layout}
            subnet={subnet}
            rates={displayRates}
            drama={drama}
            selectedId={selectedId}
            focusNeighborIds={focusNeighborIds}
            interactive={interactive}
            onSelect={onSelect}
          />
        </Spin>
        <OrbitControls enablePan={interactive} minDistance={2.5} maxDistance={16} target={[0, 0.1, 0]} />
      </Canvas>
    </WebGlErrorBoundary>
  );
}
