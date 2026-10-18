# Cyberfly Fullscreen Neuron Browser (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Enable fullscreen neuron browser from the sidebar: orbit/zoom, click-select, neighbor subgraph, bodyId/type search, enter/return without breaking the board.

**Architecture:** Reuse `ConnectomeScene` with selection/focus props. New overlay `NeuronBrowser` + pure helpers `neighborGraph` / `neuronSearch`. Sidebar button opens overlay; close returns to match UI. Same layout/subnet assets and `SpikeFrame` rates.

**Tech Stack:** React 18, R3F v8, drei v9, three, Vitest, existing `frontend/src/components/cyberfly/*`.

## Global Constraints

- Do not upgrade to R3F v9 / React 19.
- Soft-fail WebGL must not block board play.
- Honest copy unchanged (动力学推断).
- Stay on branch `feat/cyberfly-neuron-viz`; push updates to PR #2; do not merge.
- Ignore unrelated dirty files (`addresses.json`, `.archify/`, etc.).

---

### Task 1: Pure helpers — neighbor graph + search

**Files:**
- Create: `frontend/src/components/cyberfly/neighborGraph.ts`
- Create: `frontend/src/components/cyberfly/neuronSearch.ts`
- Create: `frontend/test/neighborGraph.test.ts`
- Create: `frontend/test/neuronSearch.test.ts`

**Interfaces:**
- `buildNeighborSet(synapses, neuronId, hops=1): { nodeIds: Set<number>; edgeIndices: number[] }`
- `searchNeurons(neurons, query): { id: number; type?: string; nt?: string }[]` — match bodyId exact/prefix and type/nt/group substring (case-insensitive)

- [ ] **Step 1:** Write failing tests for both helpers.
- [ ] **Step 2:** Run `pnpm --filter frontend test` — expect FAIL.
- [ ] **Step 3:** Implement helpers.
- [ ] **Step 4:** Re-run tests — PASS.
- [ ] **Step 5:** Commit `feat(frontend): neuron neighbor + search helpers`

---

### Task 2: ConnectomeScene selection + neighbor focus

**Files:**
- Modify: `frontend/src/components/cyberfly/ConnectomeScene.tsx`

**Interfaces:**
- Props add: `selectedId?: number | null`, `onSelect?: (id: number | null) => void`, `focusNeighborIds?: Set<number> | null`, `interactive?: boolean` (default false for sidebar; true in browser), `autoSpin?: boolean` (false in browser).
- When `interactive`: raycast InstancedMesh click → map instanceId → neuron id; enable pan on OrbitControls.
- When focus set: dim non-neighbor neurons/edges; highlight selected + neighbors.
- Sidebar usage stays auto-spin, no click required.

- [ ] **Step 1:** Extend scene props; wire raycasting + dimming.
- [ ] **Step 2:** `pnpm --filter frontend exec tsc -b --force` passes.
- [ ] **Step 3:** Commit `feat(frontend): connectome selection and neighbor focus`

---

### Task 3: NeuronBrowser overlay + enable sidebar button

**Files:**
- Create: `frontend/src/components/cyberfly/NeuronBrowser.tsx`
- Modify: `frontend/src/components/cyberfly/CyberflyBrainPanel.tsx`
- Modify: `frontend/src/styles/app.css` (fullscreen overlay styles)

**Interfaces:**
- Fullscreen fixed overlay with ConnectomeScene (`interactive`, no spin), search input, results list, detail panel (bodyId, type, nt, rate), close button.
- Panel button enabled: opens browser; Esc or 「返回对局」 closes.
- Pass current `frame` / `thinking` into browser so rates still show.

- [ ] **Step 1:** Implement overlay shell + CSS.
- [ ] **Step 2:** Wire search → select; select → neighbor focus via helpers.
- [ ] **Step 3:** Enable sidebar button; remove disabled/即将推出.
- [ ] **Step 4:** Commit `feat(frontend): fullscreen neuron browser`

---

### Task 4: Verification + PR update

- [ ] `pnpm --filter frontend test`
- [ ] `pnpm --filter frontend exec tsc -b --force`
- [ ] `pnpm --filter agent test` (sanity)
- [ ] Push to `origin/feat/cyberfly-neuron-viz`
- [ ] Update PR #2 body to mention phase-2 browser (gh pr edit); do not merge

## Spec coverage checklist

- Fullscreen browser — Task 3
- Orbit/zoom/pan — Task 2
- Click select — Task 2–3
- Neighbor subgraph — Tasks 1–2
- Search bodyId/type — Tasks 1, 3
- Enter/return from sidebar — Task 3
