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
  positions: Float32Array; // length segmentCount*6
  groups: Uint8Array; // per segment 0..3
  neuronIndex: Uint16Array; // per segment → layout index
};

const GROUP_NAMES = ["P1", "DN", "GABA", "other"] as const;

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
  if (offset % 2) offset += 1; // pad to align u16
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

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const focusing = !!(focusNeighborIds && focusNeighborIds.size > 0);
    for (let i = 0; i < layout.count; i++) {
      const [x, y, z] = layout.positions[i];
      const nid = subnet.neurons[i]?.id;
      const r = rates?.[i] ?? 0;
      const isSelected = nid !== undefined && nid === selectedId;
      const inFocus = !focusing || (nid !== undefined && focusNeighborIds!.has(nid));
      let scale = 0.038 + r * 0.085 * (0.4 + drama);
      if (isSelected) scale *= 1.9;
      else if (inFocus && focusing) scale *= 1.3;
      if (!inFocus) scale *= 0.45;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      color.set(populationColor(layout.groups[i]));
      // Bright idle so population colors always read on anatomical silhouette
      let boost = 1.05 + r * 1.15 * (0.35 + drama);
      if (isSelected) boost = Math.max(boost, 1.85);
      else if (inFocus && focusing) boost = Math.max(boost, 1.25);
      if (!inFocus) boost *= 0.25;
      color.multiplyScalar(boost);
      m.setColorAt(i, color);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [layout, subnet, rates, drama, dummy, color, selectedId, focusNeighborIds]);

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

/** Real MaleCNS SWC cables — visual star of the idle look. */
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
  const focusing = !!(focusNeighborIds && focusNeighborIds.size > 0);
  const palette = useMemo(
    () => GROUP_NAMES.map((g) => new THREE.Color(populationColor(g))),
    [],
  );

  const { positions, colors } = useMemo(() => {
    const total = filaments.segmentCount;
    const cap = Math.min(total, Math.max(2000, maxSegments));
    // When focusing, prefer segments of focused neurons; else take first `cap`
    // (already stratified at build time across the full subnet).
    const chosen: number[] = [];
    if (focusing) {
      for (let i = 0; i < total && chosen.length < cap; i++) {
        const ni = filaments.neuronIndex[i];
        const nid = subnet.neurons[ni]?.id;
        if (nid !== undefined && focusNeighborIds!.has(nid)) chosen.push(i);
      }
      // Pad with a thin global sample so anatomy still reads
      const pad = Math.min(cap, Math.floor(cap * 0.15));
      for (let i = 0; i < total && chosen.length < cap; i += Math.max(1, Math.floor(total / pad))) {
        chosen.push(i);
      }
    } else {
      const stride = total <= cap ? 1 : total / cap;
      for (let k = 0; k < cap; k++) chosen.push(Math.min(total - 1, Math.floor(k * stride)));
    }

    const pos = new Float32Array(chosen.length * 6);
    const col = new Float32Array(chosen.length * 6);
    const tmp = new THREE.Color();
    for (let c = 0; c < chosen.length; c++) {
      const i = chosen[c];
      const base = i * 6;
      const o = c * 6;
      for (let k = 0; k < 6; k++) pos[o + k] = filaments.positions[base + k];

      const g = filaments.groups[i] ?? 3;
      tmp.copy(palette[g] ?? palette[3]);
      if (g === 3) tmp.multiplyScalar(0.78);

      const ni = filaments.neuronIndex[i];
      const nid = subnet.neurons[ni]?.id;
      const r = rates?.[ni] ?? 0;
      let boost = 0.92 + r * 1.1 * (0.35 + drama);
      if (focusing) {
        const inFocus = nid !== undefined && focusNeighborIds!.has(nid);
        boost *= inFocus ? 1.25 : 0.22;
      }
      tmp.multiplyScalar(boost);
      // both endpoints same color
      col[o] = tmp.r;
      col[o + 1] = tmp.g;
      col[o + 2] = tmp.b;
      col[o + 3] = tmp.r;
      col[o + 4] = tmp.g;
      col[o + 5] = tmp.b;
    }
    return { positions: pos, colors: col };
  }, [filaments, layout, subnet, rates, drama, maxSegments, focusNeighborIds, focusing, palette]);

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  }, [positions, colors]);

  const opacity = focusing ? 0.62 + drama * 0.25 : 0.42 + drama * 0.35;

  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial
        transparent
        opacity={opacity}
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

  // focusEdgeIndices kept in API for NeuronBrowser compat (synapse overlay unused when SWC present)
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
        <Spin enabled={autoSpin}>
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
