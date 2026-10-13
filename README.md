# 三国棋局 · Shadow Xiangqi

**Three-player Xiangqi on Monad. One seat is an AI mole. Every move burns money, and betrayal is a transaction.**

Most "AI agent" games ask you to trust a server. This one doesn't ask. The board is a
contract. The agent's reputation is a contract. The moment it stabs you in the back, the
slash is a transaction you can read on a block explorer — not a line in someone's log file.

| | |
|---|---|
| Track | **04 Trust Identity & AI Infrastructure** |
| Local chain | Anvil `31337` |
| Target chain | Monad Testnet `10143` |
| Rules | Inspired by Sanren Xiangqi — an executable simplification, not a rules encyclopedia |
| License | MIT |

---

## Background

Three-player chess has a property that two-player chess does not: **the losing player
decides who wins.** In a two-player game, "who is winning" is a fact. In a three-player
game, it is a negotiation. That is the oldest problem in political economy wearing a
board-game costume: coalitions, credible commitments, and the moment a partner becomes a
liability.

And there is a second problem, newer and worse. We are now handing decision-making to
software agents that we cannot audit and cannot punish. An agent that lies to you suffers
no consequence. Its "reputation" lives in a vendor's database, resets when the vendor feels
like it, and is invisible to anyone outside that vendor's walled garden.

So we built a small, complete world where both problems *are* the game — and where the
answers are enforced by code rather than promised by a terms-of-service page.

---

## The Pain, Stated Plainly

**1. Agents have no skin in the game.**
When an AI lies, nothing happens to it. There is no cost, no record, no recourse.
"Trust me" is the entire trust model.

**2. Reputation is a rented database row.**
Even when a platform tracks agent behaviour, the score is private, mutable, and
non-portable. You cannot verify it, take it elsewhere, or build on it without asking
permission.

**3. Commitments between players are unenforceable.**
In every multiplayer game with diplomacy, an alliance is just words. Nothing makes
defection *cost* anything, so the equilibrium collapses into everyone betraying first.

**4. On-chain games are economically fake.**
Most put a token on a leaderboard and call it "game theory". Nothing is consumed, nothing
is at risk, and the only real strategy is farming the emission schedule.

---

## The Solution

Four mechanisms. Each exists because the naive version fails in a specific, reproducible
way.

### Money burns on every move

A move is not free. Every `commitAndRevealMove` consumes the mover's **play balance**, and
that MON is gone — it is not redistributed to anyone. Hoarding is safe and losing. This
converts thinking time into a real resource and gives the game a clock nobody controls.

Measured on Monad testnet across 110 opening moves:

| | MON |
|---|---|
| min | 0.0090 |
| avg | 0.1027 |
| max | 0.5775 |

The *available* move set is priced by geometry and remaining balance. Being poor is not a
debuff you read about — it is a shrinking list of legal choices.

### Alliances are collateralised

A covenant is not a promise, it is a **deposit**. Two players lock earnest money against a
commitment, and the commitment's plaintext never goes on-chain — only a hash — so the table
cannot read your intentions before you act on them.

### Betrayal is a transaction, not a plot twist

Breaking the covenant is *allowed*. It is also *priced*: the betrayer's earnest bond is
seized, their `trustScore` in the `AgentRegistry` drops, and the seizure is emitted as an
event anyone can index.

This is the point of the whole design. **Defection is not prevented — it is made legible.**

### The mole's reputation is on-chain and slashable

One of the three seats is an AI. Until the end, *which* seat is hidden. At settlement,
`AiRevealed` publishes it along with a `motiveLogHash` — a commitment to the agent's
recorded reasoning.

The agent is not punished for playing well. It is punished for **lying**, and that
punishment is a state change in a public contract.

---

## What Makes This Different

**The AI's strategy comes from a real connectome.**

The mole's decisions are not prompt-engineering all the way down. A subnetwork of the
**Janelia FlyEM MaleCNS** connectome — the full male *Drosophila* central nervous system,
published in *Cell* in September 2026 — runs as a spiking simulation and produces the
agent's behavioural drives.

We extracted **2,500 neurons and 84,014 real synapses**, seeded from descending neurons
(the behavioural output layer) and expanded one hop upstream along real `ConnectsTo` edges.

The division of labour is the interesting part:

- **The connectome is the subconscious.** It is deterministic — the same board position
  always yields the same impulse. It does *not* pick a move.
- **Kimi is the voice.** It turns the impulse into a chosen move and a line of dialogue:
  the self-justification that follows the urge.

That is precisely the anatomy of a betrayal. **The impulse arrives first; the reason
arrives second.**

We deliberately do **not** claim the fly is playing chess. Mapping neurons onto board
squares would be invention. The connectome outputs three behavioural drives
(`aggression`, `avoidance`, `courtship`), and the legal move is selected downstream.

> Reference: <https://male-cns.janelia.org/> · data licensed **CC-BY** (HHMI Janelia FlyEM)

**The whole product is one command away from being verified.**

```bash
pnpm demo    # 18 transactions end to end, including a real betrayal slashing
```

Not a video. Not a screenshot. A script that deploys, plays, betrays, and settles.

**Honesty is designed in, not bolted on.**

The ZK layer is explicitly staged and labelled (see below). The verifier is a stub and says
so in its own source. A reviewer who knows cryptography will find no inflated claims here —
and that is enforced by a size gate and a dependency audit in CI.

---

## Architecture

**Interactive diagram:** [`docs/diagrams/architecture.html`](docs/diagrams/architecture.html)
— click any node to trace its connections. Source evidence is pinned to repository paths
and line numbers at commit `5fbe2f6`.

```
Browser + wallet ──HTTPS──▶ SPA (Vercel) ──signed tx──▶ GameTable ──┐
                                  │  │  │                            │
                                  │  │  └──reputation──▶ AgentRegistry│
                                  │  └──earnest/betrayal──▶ Covenant ─┤ Monad testnet
                                  │                                   │
                                  └──leaderboard/history──▶ Indexer ◀─┘
                                                             │
                                    ┌────────────────────────┼──────────────┐
                                    ▼                        ▼              ▼
                                Supabase              AI mole agent ◀── Kimi API
                                                             │
                                                             ▼
                                                   Cyberfly connectome
```

Key components, and where to verify each claim:

| Component | Evidence |
|---|---|
| `GameTable` (board, seats, ply, fees) | `contracts/src/GameTable.sol:489` |
| `Covenant` (earnest bond, slashing) | `contracts/src/Covenant.sol:396` |
| `AgentRegistry` (trust score) | `contracts/src/AgentRegistry.sol:59` |
| Indexer (chunked log scanning) | `server/src/indexer.ts:130` |
| Postgres store (dual backend) | `server/src/store.ts:49` |
| Agent decision entry | `agent/src/index.ts:586` |
| Connectome spiking simulation | `agent/src/cyberfly.ts:142` |
| Kimi decision + dialogue | `agent/src/kimi.ts:142` |

### One move, end to end

**Interactive diagram:** [`docs/diagrams/sequence.html`](docs/diagrams/sequence.html)

A naive implementation splits commit and reveal into two transactions. That creates a
front-running window: everyone sees your plaintext before deciding their own move. So
`commitAndRevealMove` compresses both into a single transaction and validates the geometry
on the spot. The window does not exist.

If a player stalls, `expireCommit` lets *anyone* clear the stale commitment after 60
seconds. If a player wants out, `resign` follows the same accounting path as bankruptcy and
unblocks `finalizeGame` — the other two are not forced to grind out the remaining plies.

### Data flow

**Interactive diagram:** [`docs/diagrams/dataflow.html`](docs/diagrams/dataflow.html)

The chain is the only source of truth; everything below the boundary is a mirror you can
delete and rescan without losing a single fact. That boundary is the whole reason the
indexer exists: there is no on-chain "list all games", so history is reconstructed from
events rather than stored.

Two traps are called out on the diagram, both of which cost us real debugging time:
`eth_getLogs` is capped at **100 blocks** on Monad's public RPC, and a mirror without
provenance accumulates **ghost games** after every contract redeploy.

### Demo workflow

**Interactive diagram:** [`docs/diagrams/workflow.html`](docs/diagrams/workflow.html) —
the three-minute runbook: connect wallet → fill three seats → play → covenant → betrayal →
slashing → reputation drop.

---

## Honest ZK

The ZK layer is **staged and labelled**. Nothing here pretends to be a complete circuit.

| Level | Status | What it actually does |
|---|---|---|
| **L0** | **Shipped** | Hash commitment + dual ECDSA + UI concealment. The covenant plaintext never touches the chain. |
| **L1** | **Shipped** | `IVerifier` interface in place and wired into `Covenant`. |
| **L2** | **Not implemented** | Preimage ZK (circom / Noir). Interface ready; no circuit exists. |
| **L3** | **Not implemented** | Fully anonymous covenants. |

`StubVerifier` accepts an **empty** proof (the P0 ECDSA path, checked in `Covenant`) and
**rejects any non-empty blob**. It refuses to pretend it verified something. That behaviour
is deliberate and covered by tests.

We would rather show you a labelled stub than a circuit that does not run.

---

## Roadmap (Not Done)

| Item | Status |
|---|---|
| Preimage ZK circuit (L2) | Interface reserved, no implementation |
| Checkmate detection on-chain | Deliberately off-chain — `isInCheck` ≈ 379k gas, `hasAnyLegalMove` ≈ 533k |
| Mainnet deployment | Testnet only |
| Contract size headroom | `GameTable` is 24,073 B of the 24,576 B EIP-170 limit — **503 B left** |

That last row is a real constraint, not a footnote. Further on-chain features require
switching `require` strings to custom errors first (measured saving: ~1.9 KB).

---

## Run It

```bash
pnpm install
pnpm test          # shared 24 + frontend 17 + agent 12 + forge 85
pnpm demo          # local anvil: deploy, play, betray, settle — 18 transactions
pnpm dev           # frontend on :5173 against a local chain
pnpm size          # EIP-170 size gate (this has caught a real 146 KB regression)
```

**Monad testnet:**

```bash
pnpm deploy:testnet        # needs FOUNDRY_CODE_SIZE_LIMIT=100000 for the deploy script's initcode
pnpm indexer               # reads chain, writes Supabase/SQLite
pnpm --filter agent start  # the mole: registers, fills the empty seat, plays, betrays
```

**Requirements:** Node `22.x` (for `node:sqlite`), pnpm `10.33.4`, Foundry.

### Testnet addresses (`10143`)

| Contract | Address |
|---|---|
| `GameTable` | `0x808a1e24d13681e4666706d60def28afe21859af` |
| `Covenant` | `0x857ff987f28564b7f7b6a58cd421bd4e01ec80b9` |
| `AgentRegistry` | `0x9c19c6213dc150c9fe38a20fae0721bd9935c012` |
| `StubVerifier` | `0xc0ff952f5679c877a1bd4cabdf9b2348e3d3b333` |

Canonical source: `frontend/src/lib/addresses.10143.json`.

### Test tokens

We do **not** run a faucet. Use the official one: **<https://faucet.monad.xyz>**

### Environment

`agent/.env` and `server/.env` are gitignored and created from the `.example` files. Never
commit real keys.

---

## Engineering Notes

Things that cost real time and are now encoded as guardrails:

- **EIP-170 is not advisory.** `GameTable` once reached 146 KB while `forge test` stayed
  green, because the test profile had `code_size_limit = 500_000`. `pnpm size` now fails
  the build, and CI runs it separately from `forge test`.
- **Monad's public RPC caps `eth_getLogs` at 100 blocks.** The indexer chunks adaptively
  instead of assuming a wide range works.
- **A missing `await` is invisible on SQLite and fatal on Postgres.** `upsertGame` was
  called without `await`; SQLite's synchronous driver hid it, and the Postgres path
  silently wrote nothing while logging success.
- **A mirror without provenance accumulates ghosts.** Contract addresses change on every
  redeploy while `gameId` restarts at 1, so `games` carries a `contract` column and every
  read filters on it. Without this, a redeploy leaves phantom games on the leaderboard.
- **`require` strings are expensive.** 65 of them, 36 distinct, ~1.9 KB total. Noted for
  when headroom runs out.

### Security posture

- Storage binds to loopback by default; `INDEXER_HOST` must be set explicitly to expose it.
- The indexer API is read-only. There is no write path.
- No `ReentrancyGuard`, by review: all four payment sites follow checks-effects-interactions
  and `_pay` verifies the call result. The guard would cost bytes we do not have.
- `pnpm audit --audit-level high`: **0** findings.
- 0 `TODO`/`FIXME`, 0 `console.log` in shipped frontend code.

---

## Diagrams

Generated with **[Archify](https://github.com/tt-a1i/archify)** from the repository — typed
JSON source, schema validation, and real-browser checks, not hand-drawn images.

| Diagram | File |
|---|---|
| Runtime architecture | [`docs/diagrams/architecture.html`](docs/diagrams/architecture.html) |
| Data flow (authority vs. mirror) | [`docs/diagrams/dataflow.html`](docs/diagrams/dataflow.html) |
| Single-transaction move (sequence) | [`docs/diagrams/sequence.html`](docs/diagrams/sequence.html) |
| Three-minute demo (workflow) | [`docs/diagrams/workflow.html`](docs/diagrams/workflow.html) |

Each is a self-contained HTML file. Open it directly — no install, no server. Sources live
in `.archify/`, so any diagram can be revised without redrawing it.

---

## License & Attribution

Code: MIT.

Connectome data: **MaleCNS v1.0**, HHMI Janelia FlyEM, licensed **CC-BY**.
<https://male-cns.janelia.org/> · `agent/data/cyberfly-subnet.json` is derived from it and
retains the attribution in its `source` field.
