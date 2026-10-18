import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { SpikeFrame } from "@sanguo/shared";
import { populationColor } from "./populationColor";
import { useSpikePlayback } from "./useSpikePlayback";

type Layout = {
  version: number;
  count: number;
  positions: number[][];
  groups: string[];
};

type Subnet = {
  neurons: { id: number; nt?: string; type?: string }[];
  synapses: { pre: number; post: number; weight: number }[];
};

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
      let scale = 0.035 + r * 0.08 * (0.4 + drama);
      if (isSelected) scale *= 1.8;
      else if (inFocus && focusing) scale *= 1.25;
      if (!inFocus) scale *= 0.55;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      color.set(populationColor(layout.groups[i]));
      let boost = 0.35 + r * 1.4 * (0.3 + drama);
      if (isSelected) boost = Math.max(boost, 1.6);
      else if (inFocus && focusing) boost = Math.max(boost, 0.9);
      if (!inFocus) boost *= 0.22;
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

function Synapses({
  layout,
  subnet,
  active,
  drama,
  maxEdges,
  focusNeighborIds,
  focusEdgeIndices,
}: {
  layout: Layout;
  subnet: Subnet;
  active: number[] | undefined;
  drama: number;
  maxEdges: number;
  focusNeighborIds?: Set<number> | null;
  focusEdgeIndices?: number[] | null;
}) {
  const idToIndex = useMemo(() => {
    const m = new Map<number, number>();
    subnet.neurons.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [subnet]);

  const positions = useMemo(() => {
    const focusing = !!(focusNeighborIds && focusNeighborIds.size > 0);
    let indices: number[];
    if (focusing && focusEdgeIndices && focusEdgeIndices.length) {
      indices = focusEdgeIndices;
    } else if (active && active.length) {
      indices = active;
    } else {
      indices = subnet.synapses
        .map((s, i) => ({ i, w: Math.abs(s.weight) }))
        .sort((a, b) => b.w - a.w)
        .slice(0, maxEdges)
        .map((x) => x.i);
    }
    const arr: number[] = [];
    for (const ei of indices) {
      const syn = subnet.synapses[ei];
      if (!syn) continue;
      if (focusing && (!focusNeighborIds!.has(syn.pre) || !focusNeighborIds!.has(syn.post))) {
        continue;
      }
      const a = idToIndex.get(syn.pre);
      const b = idToIndex.get(syn.post);
      if (a === undefined || b === undefined) continue;
      const pa = layout.positions[a];
      const pb = layout.positions[b];
      arr.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
    }
    return new Float32Array(arr);
  }, [layout, subnet, active, maxEdges, idToIndex, focusNeighborIds, focusEdgeIndices]);

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [positions]);

  const focusing = !!(focusNeighborIds && focusNeighborIds.size > 0);

  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial
        transparent
        opacity={focusing ? 0.45 + drama * 0.3 : 0.08 + drama * 0.35}
        color={focusing || drama > 0.4 ? "#7fd0ff" : "#3a4a5c"}
      />
    </lineSegments>
  );
}

function Spin({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (enabled && ref.current) ref.current.rotation.y += dt * 0.15;
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
  const [maxEdges, setMaxEdges] = useState(12000);
  const { displayRates, drama } = useSpikePlayback(frame, thinking);
  const fpsSamples = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [l, s] = await Promise.all([
          fetch("/cyberfly/layout.json").then((r) => r.json()),
          fetch("/cyberfly/subnet.json").then((r) => r.json()),
        ]);
        if (!cancelled) {
          setLayout(l);
          setSubnet(s);
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
        if (avg > 33 && maxEdges > 2000) setMaxEdges((m) => Math.max(2000, Math.floor(m * 0.7)));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [maxEdges]);

  if (!layout || !subnet) {
    return <div className="cyberfly-loading">加载连接组…</div>;
  }

  return (
    <Canvas
      camera={{ position: [0, 0.4, 6.2], fov: 45 }}
      dpr={[1, 1.5]}
      onPointerMissed={() => {
        if (interactive && onSelect) onSelect(null);
      }}
    >
      <color attach="background" args={["#0a1018"]} />
      <ambientLight intensity={0.55} />
      <pointLight position={[4, 6, 3]} intensity={1.1} />
      <Spin enabled={autoSpin}>
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
        <Synapses
          layout={layout}
          subnet={subnet}
          active={frame?.activeEdgeIndices}
          drama={drama}
          maxEdges={maxEdges}
          focusNeighborIds={focusNeighborIds}
          focusEdgeIndices={focusEdgeIndices}
        />
      </Spin>
      <OrbitControls enablePan={interactive} minDistance={3} maxDistance={12} />
    </Canvas>
  );
}
