# Cyberfly 3D Neuron Viz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship phase-1 sidebar: real `simulate` spike rates drive a dramatized R3F connectome next to the board when the AI thinks.

**Architecture:** Extend `cyberfly.simulate` to export per-neuron rates as `SpikeFrame`. Frontend loads static subnet + precomputed 3D layout, renders with React Three Fiber instancing, and plays a frame whenever `aiPlayOnce` / auto-AI turn runs (demo path). Agent process can later push the same frame shape over its channel; phase 1 uses in-page simulate for immediacy.

**Tech Stack:** TypeScript, Vitest, React 18, Vite, `@react-three/fiber`, `@react-three/drei`, `three`, existing `agent/src/cyberfly.ts` + `agent/data/cyberfly-subnet.json`.

## Global Constraints

- Honest UX copy: dynamics inference, not real fly thought (README / design spec).
- Do not break board interaction if WebGL fails — panel must soft-fail.
- Prefer full nodes/edges first; auto-downsample edges if FPS < 30.
- Phase 2 browser is out of scope except a disabled/hidden entry affordance.
- Keep `simulate` determinism via existing `sensorySeed`.

---

### Task 1: Export SpikeFrame + rates from cyberfly

**Files:**
- Modify: `agent/src/cyberfly.ts`
- Modify: `agent/test/cyberfly.test.ts`
- Create: `packages/shared/src/spikeFrame.ts` (shared type for frontend import) OR keep types in agent and duplicate a thin type in frontend — **prefer** `packages/shared/src/spikeFrame.ts` exported from shared package index.

**Interfaces:**
- Produces:
  - `export type SpikeFrame = { seed: number; ply: number; rates: number[]; neuronIds: number[]; drives: Drives; activeEdgeIndices?: number[] }`
  - `export function simulateDetailed(subnet, input, opts): { drives: Drives; rates: number[] }`
  - `export function buildSpikeFrame(...): SpikeFrame`
- Consumes: existing `ConnectomeSubnet`, `SensoryInput`, `simulate` internals.

- [ ] **Step 1: Write failing test** in `agent/test/cyberfly.test.ts` asserting `simulateDetailed` returns `rates.length === subnet.neurons.length` and same seed ⇒ same rates.

- [ ] **Step 2: Run** `pnpm --filter agent test` — expect FAIL on missing export.

- [ ] **Step 3: Implement** `simulateDetailed` by lifting the internal `rates` array out of `simulate`; make `simulate` call it and return only `drives` (preserve callers).

- [ ] **Step 4: Re-run tests** — PASS.

- [ ] **Step 5: Commit** `feat(agent): export per-neuron rates as SpikeFrame`

---

### Task 2: Precompute 3D layout asset

**Files:**
- Create: `scripts/build-cyberfly-layout.ts`
- Create: `frontend/public/cyberfly/layout.json` (generated)
- Create: `frontend/public/cyberfly/subnet.json` (copy or slim pointer — copy full subnet for phase 1)

**Interfaces:**
- Produces: `layout.json` = `{ version: 1, positions: [x,y,z][], groups: string[] }` aligned to subnet neuron order.
- Layout algorithm: place by population (P1 / DN / GABA / other) on concentric shells + small deterministic jitter from bodyId hash (no runtime force layout).

- [ ] **Step 1: Write script** that reads `agent/data/cyberfly-subnet.json` and writes layout + copies subnet into `frontend/public/cyberfly/`.

- [ ] **Step 2: Run** `pnpm exec tsx scripts/build-cyberfly-layout.ts` — files exist; `positions.length === 2500`.

- [ ] **Step 3: Commit** generated assets (3.3MB subnet is already in repo under agent; public copy is OK for demo) `chore: add cyberfly layout + public subnet assets`

---

### Task 3: R3F ConnectomeScene (points + edges + drama)

**Files:**
- Modify: `frontend/package.json` — add `three`, `@react-three/fiber`, `@react-three/drei`, `@types/three`
- Create: `frontend/src/components/cyberfly/ConnectomeScene.tsx`
- Create: `frontend/src/components/cyberfly/useSpikePlayback.ts`
- Create: `frontend/src/components/cyberfly/populationColor.ts`
- Test: `frontend/src/components/cyberfly/populationColor.test.ts`

**Interfaces:**
- Produces: `<ConnectomeScene frame: SpikeFrame | null thinking: boolean />`
- Population colors: P1 gold, DN red-orange, GABA cyan, other muted gray-blue.
- Edge downsample: if `performance.now` frame delta avg > 33ms for 30 frames, render only top-N edges by |weight| or active set.

- [ ] **Step 1: Failing test** for `populationColor(type, nt)`.

- [ ] **Step 2: Implement color helper + scene** with InstancedMesh spheres/points and LineSegments.

- [ ] **Step 3: Manual** `pnpm --filter frontend test` + typecheck.

- [ ] **Step 4: Commit** `feat(frontend): R3F connectome scene with spike drama`

---

### Task 4: Sidebar panel + wire AI think

**Files:**
- Create: `frontend/src/components/cyberfly/CyberflyBrainPanel.tsx`
- Modify: `frontend/src/App.tsx` — state `spikeFrame`, call simulateDetailed when AI moves; render panel inside `.sidebar` above ScorePanel
- Modify: `frontend/src/styles/app.css` — `.cyberfly-panel` height ~280–360px
- Create: thin browser-side sensory mapper from `BoardState` → `SensoryInput` in `frontend/src/lib/cyberflySensory.ts`

**Interfaces:**
- On `aiPlayOnce` and auto-AI effect: build sensory → `simulateDetailed` → `setSpikeFrame` → then existing `pickAiMove` / `onMove`.
- Drive meters bind to `frame.drives`.
- Footer text: 诚实声明 one-liner.

- [ ] **Step 1: Implement sensory mapper + panel shell (empty canvas).**

- [ ] **Step 2: Wire thinking path; verify** clicking 导演代走 flashes spikes.

- [ ] **Step 3: Soft-fail** if WebGL unsupported — show drives only + message.

- [ ] **Step 4: Commit** `feat(frontend): cyberfly brain sidebar on AI turns`

---

### Task 5: Agent parity (optional same PR if small)

**Files:**
- Modify: `agent/src/index.ts` — when simulating, also `this.log`-append or stdout JSON line `spikeFrame` for debugging; do not block play if frontend absent.

- [ ] **Step 1: Call simulateDetailed; keep drivesToBias path.**

- [ ] **Step 2: Commit** `feat(agent): emit spike frame metadata on think`

---

### Task 6: Verification

- [ ] `pnpm --filter agent test`
- [ ] `pnpm --filter frontend test`
- [ ] `pnpm --filter frontend build` (or `tsc -b`)
- [ ] Manual: `pnpm dev` — open UI, 导演代走, confirm sidebar animation + drives move
- [ ] Confirm board still playable with panel open

---

## Spec coverage checklist

- Spectator sidebar first — Task 4
- Real rates + drama — Tasks 1, 3
- Population colors + spike highlight — Task 3
- Full points/edges with degrade — Task 3
- Honest copy — Task 4
- Phase 2 browser only affordance — Task 4 (hidden/disabled control)
