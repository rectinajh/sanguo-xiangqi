import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
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
  rates,
  drama,
}: {
  layout: Layout;
  rates: number[] | null;
  drama: number;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    for (let i = 0; i < layout.count; i++) {
      const [x, y, z] = layout.positions[i];
      const r = rates?.[i] ?? 0;
      const scale = 0.035 + r * 0.08 * (0.4 + drama);
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      color.set(populationColor(layout.groups[i]));
      const boost = 0.35 + r * 1.4 * (0.3 + drama);
      color.multiplyScalar(boost);
      m.setColorAt(i, color);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [layout, rates, drama, dummy, color]);

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, layout.count]}>
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
}: {
  layout: Layout;
  subnet: Subnet;
  active: number[] | undefined;
  drama: number;
  maxEdges: number;
}) {
  const idToIndex = useMemo(() => {
    const m = new Map<number, number>();
    subnet.neurons.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [subnet]);

  const positions = useMemo(() => {
    const pick = active && active.length ? active : undefined;
    const indices =
      pick ??
      subnet.synapses
        .map((s, i) => ({ i, w: Math.abs(s.weight) }))
        .sort((a, b) => b.w - a.w)
        .slice(0, maxEdges)
        .map((x) => x.i);
    const arr: number[] = [];
    for (const ei of indices) {
      const syn = subnet.synapses[ei];
      if (!syn) continue;
      const a = idToIndex.get(syn.pre);
      const b = idToIndex.get(syn.post);
      if (a === undefined || b === undefined) continue;
      const pa = layout.positions[a];
      const pb = layout.positions[b];
      arr.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
    }
    return new Float32Array(arr);
  }, [layout, subnet, active, maxEdges, idToIndex]);

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [positions]);

  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial
        transparent
        opacity={0.08 + drama * 0.35}
        color={drama > 0.4 ? "#7fd0ff" : "#3a4a5c"}
      />
    </lineSegments>
  );
}

function Spin({ children }: { children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    if (ref.current) ref.current.rotation.y += dt * 0.15;
  });
  return <group ref={ref}>{children}</group>;
}

export function ConnectomeScene({
  frame,
  thinking,
}: {
  frame: SpikeFrame | null;
  thinking: boolean;
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
    <Canvas camera={{ position: [0, 0.4, 6.2], fov: 45 }} dpr={[1, 1.5]}>
      <color attach="background" args={["#0a1018"]} />
      <ambientLight intensity={0.55} />
      <pointLight position={[4, 6, 3]} intensity={1.1} />
      <Spin>
        <Neurons layout={layout} rates={displayRates} drama={drama} />
        <Synapses
          layout={layout}
          subnet={subnet}
          active={frame?.activeEdgeIndices}
          drama={drama}
          maxEdges={maxEdges}
        />
      </Spin>
      <OrbitControls enablePan={false} minDistance={3} maxDistance={12} />
    </Canvas>
  );
}
