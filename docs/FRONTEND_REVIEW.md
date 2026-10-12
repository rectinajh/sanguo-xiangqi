# Frontend code review — `frontend/` @ 2b8cd97

> **⚠️ 过时（2026-10 对照）**  
> 下文是提交 `2b8cd97` 时的只读评审快照，**结论已不再代表当前仓库**。Wave A/B 之后已落地：
> - EIP-1193 注入钱包写链（测试网私钥不出浏览器）
> - 生产构建剥离 Anvil/AI 钥；AI 仅由独立 `pnpm agent` 持钥
> - `createGame()` 无 `aiSeat`；Agent 入座时绑定卧底
> - 邀请链接多人入座 + 跨钱包盟约要约 / 诚意金过期退款 UI
> - 终局面板奖池 / payout；10143 地址与示例 tx 见 README
>
> 仍成立或仍待办的项以 [DEV_CHECKLIST.md](./DEV_CHECKLIST.md) 勾选为准；下文仅作历史对照，勿当现状验收清单。

---

# Frontend code review — `frontend/` @ 2b8cd97（历史归档）

Read-only review. No files were modified. `npx tsc -b --force` in `frontend/` exits **0 with zero diagnostics** (type-clean); `npx vite build` succeeds (500 kB JS / 155 kB gzip). Type-checking is not where the problems are.

**Verdict in one line（当时）:** this is a polished *local-Anvil demo console* wearing the clothes of a product. A stranger cannot open it in a browser and play: there is no wallet connection, no way to get MON, no way for a second human to sit down, no way to reach the end of a game without clicking a button labelled "director stands in for the AI", and the AI's private key is shipped in the public JS bundle.

---

## 0. Exact end-to-end trace (what actually happens)

Reproduced by reading every code path. `frontend/src/lib/addresses.json:2` pins `chainId: 31337` and `:3` pins `rpcUrl: "http://127.0.0.1:8545"`, so step 0 is a hard gate.

| Step | What the user sees | What actually happens on chain | Status |
|---|---|---|---|
| 0. Open page | `检测 RPC…` → `Anvil 未启动` + a 3-terminal shell recipe | `getBlockNumber()` fails → `chainOk=false`; every button is `disabled` (`App.tsx:533-541`) | **Brick** unless a local Anvil with those exact addresses is running |
| 1. "连接 / 灌测币" | `创建临时钱包…` → `从 Anvil 灌测币…` | Two `localStorage` keys generated; 8 MON each sent **from the hardcoded Anvil key #0** (`wallet.ts:35-47`); AI key topped up too (`App.tsx:163`) | Local-only |
| 2. "新开一局" | `创建对局…` then three seats fill | `createGame(deployer, 2)` then `join(0/1/2, 3 MON)` from **three keys the frontend holds** (`App.tsx:198-207`) | Works locally; not multiplayer |
| 3. Make a legal move | Click own piece → gold dots + fee tooltip → click target | `commitMove` tx, then a second `revealMove` tx (`contracts.ts:108-139`) | Works locally (2 tx per move) |
| 4. Capture | toast `吃子结算` | `_settleCapture` → `CaptureSettled`, Points/penalty | Works |
| 5. Alliance | "秘密求援" → 结盟/疏火 | `lockEarnest`/`lockPeaceOffer` + **AI's signature forged in-browser** + `activateCovenant` | Works, but the AI key is public |
| 6. Betrayal slash | "挑战背刺 Slash" | `challengeBetrayal(hash, 2, 1)` — hardcoded betrayer + clause | Only after the AI really captured an advisor, and there is **no AI-initiated covenant**, so the victim role is backwards |
| 7. AI's turn | **Nothing happens. Ever.** | — | **Stall** until a human clicks "导演代走" (`App.tsx:580-582`) |
| 8. Endgame reveal | "终局揭示" → modal | `finalizeGame` needs `phase==2`, reached only by elimination or ply 80 | Reachable only after ~80 manual AI clicks, or via the demo's owner-only bankruptcy drains |

---

## 1. Where the AI comes from (direct answer)

**The AI is the frontend.** There is no agent process, no service, no key store.

* `agent/package.json` is a stub that prints a string:
  ```json
  "start:once": "echo 'AI is driven from frontend Demo / AI走一步 for MVP; standalone bot deferred'"
  ```
* The "AI" is a pure function called from the React event handler — `packages/shared/src/policy.ts:5-31` (`pickAiMove`), invoked at `App.tsx:254-258`:
  ```ts
  const pick = pickAiMove(board, { allySeat: covenantActive ? 0 : null, activatedPly, forceBetrayal: false });
  ```
* It only runs when a human clicks — `App.tsx:580-582`:
  ```tsx
  <button className="secondary" disabled={busy || board.turn !== AI_SEAT} onClick={aiPlayOnce}>
    导演代走
  </button>
  ```
* **The AI does have its own key — and so does everyone who opens the page.** `chain.ts:25-29`:
  ```ts
  export const ANVIL_KEYS = {
    deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    ai: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    faucet: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  };
  ```
* Whoever clicks "导演代走" signs the AI's tx — `App.tsx:179-183` + `:231-232`:
  ```ts
  function accountForSeat(seat: Seat): Account {
    if (seat === AI_SEAT) return aiAccount;
  ```
  ```ts
  const acct = accountForSeat(seat);
  await commitAndReveal(acct, gameId, seat, from, to, piece);
  ```
* `.env.example:5` says `# AI agent key — NEVER use a human session key here / AGENT_KEY=0x59c6…` — **`AGENT_KEY` is read nowhere in the repo** (`grep -rn AGENT_KEY frontend/src` → nothing). The frontend uses the literal instead.

Verified leak in the production bundle:

```
$ grep -o 59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d dist/assets/index-*.js
59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
$ ...context...
const gd={deployer:"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
          ai:"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
          faucet:"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"}
```

**PRD verdict.** PRD §3.1 (`docs/PRD.md:97`) "AI 卧底 ×1 … **自有 Agent EOA**"; §7 (`:333-334`) "[AI Agent 服务] … 自有键 · **永不索取用户钥**"; §8.1 (`:356`) "AI … 无用户钥"; §11 (`:430`) "人类临时钱包；AI 不持用户键".

* "AI has its own EOA" — **literally true**: it is a distinct address, never derived from the human keys.
* "humans never hand over keys" — **true for humans** (human A/B keys stay in this browser's `localStorage` and are never sent to the AI).
* "key isolation" — **false**. The isolation is between two literals in the same public file. Any visitor can `privateKeyToAccount(ANVIL_KEYS.ai)` and then move the AI seat, forge its covenant signatures, or drain its balance. The AI is not an independent actor; it is a puppet run by whoever clicked last.

---

## 2. BLOCKER

### B1. There is no wallet connection at all; every actor is a hardcoded Anvil key or a faucet-dripped ephemeral key
`frontend/src/lib/wallet.ts:13-47`, `frontend/src/lib/chain.ts:25-29`, `frontend/src/App.tsx:146-177`.
```ts
export function loadOrCreateWallet(label: string): SessionWallet {   // wallet.ts:13
  const raw = localStorage.getItem(STORAGE_KEY);
  ...
  map[label] = generatePrivateKey();                                  // :24
```
```ts
export async function fundFromAnvil(to: `0x${string}`, amountMon = "5") {  // wallet.ts:35
  const faucet = accountFromKey(ANVIL_KEYS.faucet);                        // :36
```
`grep -rn "window.ethereum\|eth_requestAccounts\|WalletConnect\|injected" frontend/src` returns **nothing**. The only client is `createWalletClient({ account, chain, transport: http(rpcUrl) })` (`chain.ts:21`).

**Impact:** on Monad testnet `fundFromAnvil` is a no-op sender with no balance and no way to fund it; a real user with a real wallet has no way to seat themselves. The game's entire MON economy can only be exercised on a chain where the Anvil key #0 is pre-funded. The product claim ("Monad-ready", `App.tsx:529`) is unsupported by any code path.
**Fix:** add EIP-1193 (`window.ethereum`) + optional WalletConnect via viem `custom(provider)`; keep the ephemeral-wallet path only behind a `demo` flag; move `chainId`/`rpcUrl`/addresses to `import.meta.env` (`VITE_CHAIN_ID`, `VITE_RPC_URL`, per-chain address maps) with a baked default for local Anvil.

### B2. The AI's private key is a constant compiled into the public bundle
`frontend/src/lib/chain.ts:27` (`ai: "0x59c6995e…"`), used at `App.tsx:67`, `:163`, `:206`, `:406`, `:416`, `:426`, `:439`, `:359`. Proof of leak in §1 above.
**Impact:** the hidden-mole premise is void. A visitor can take over the AI seat, sign covenants as the AI, or empty its balance. On a public testnet the AI's stake is a public honeypot.
**Fix:** delete `ANVIL_KEYS.ai` from the frontend entirely. If the AI must be driven from the page for the demo, run a tiny signer service (`agent/`) holding `AGENT_KEY` with an endpoint like `POST /ai/move {gameId}` and have the button call it; on real deploys point the frontend at the agent's address and let the agent run its own loop.

### B3. The AI never moves; the game stalls on seat 2 unless a human clicks "导演代走"
`frontend/src/App.tsx:580-582` (button), `:252-261` (`aiPlayOnce`). There is no effect, no timer, no polling anywhere in `App.tsx` (only one `useEffect`, at `:109-119`, the RPC probe).
**Impact:** in the PRD's own 3-minute script (`docs/PRD.md:391-397`) the AI is supposed to act on its own. In the product, the game freezes on the AI's turn until the *player* impersonates the AI. Combined with B2 this is the opposite of the pitch.
**Fix:** after C2 (agent service) the agent should poll `getGameMeta` and move when `turn==aiSeat`; until then, at minimum auto-fire `aiPlayOnce` in a `useEffect` guarded by `board.turn===AI_SEAT && phase===1 && !busy`.

### B4. `startMatch` always seats the same three identities — no second human can ever join
`frontend/src/App.tsx:185-219`:
```ts
await joinGame(toAccount(wallets.humanA), id, 0, JOIN_VALUE);
await joinGame(toAccount(wallets.humanB), id, 1, JOIN_VALUE);
await joinGame(aiAccount, id, 2, JOIN_VALUE);
```
and the only "identity" control is a seat toggle for one person, `App.tsx:628-634`:
```tsx
{([0, 1] as Seat[]).map((s) => (
  <button key={s} className={mySeat === s ? "primary" : "ghost"} onClick={() => setMySeat(s)}>
    操控{SEAT_LABEL_ZH[s]}
```
Plus the only "network" UI is the top bar — there is no room code, no share link, no lobby, no opponent list.
**Impact:** "三人象棋" cannot contain three people. A stranger who opens the URL gets brand-new `localStorage` keys and, on "新开一局", `createGame` *succeeds* (creating a fresh game) while every `join` reverts `"taken"` — `App.tsx:213-215` shows a raw `String(e)` toast and leaves `gameId` pointing at a game they do not own. Two humans on two machines cannot play each other, ever.
**Fix:** add a lobby: creator calls `createGame` and publishes the `gameId` (URL `?game=123`), each participant calls `join` for one seat with their own connected wallet, and the UI derives `mySeat` from `getSeat(gameId,s).player === myAddress` instead of a toggle.

### B5. `hasAddresses()` guards only two of the three contracts; a missing `AgentRegistry` bricks the game permanently
`frontend/src/lib/contracts.ts:29-31`:
```ts
export function hasAddresses() {
  return Boolean(addresses.GameTable && addresses.Covenant);
}
```
`finalizeGame` (`contracts/src/GameTable.sol:389`) ends with `registry.recordGameResult(ai, gameId, aiWon, g.slashed[g.aiSeat], forcedBurn);` — if `AgentRegistry` were `0x0`, that external call reverts and `finalizeGame` can never succeed, so the game can never be settled or revealed. Nothing anywhere checks `addresses.AgentRegistry` (`grep` → only `contracts.ts:26` reads it).
**Fix:** `return Boolean(addresses.GameTable && addresses.Covenant && addresses.AgentRegistry)` **and** verify `getCode(addr) !== "0x"` for all three at connect time (an RPC that is up but pointed at the wrong chain currently passes the probe, see H4).

---

## 3. HIGH

### H1. A failed `revealMove` leaves a live commit and locks the game for 60 s; there is no recovery path
`frontend/src/lib/contracts.ts:120-137` sends two independent transactions and only *after* both does anything else happen:
```ts
const h1 = await wallet.writeContract({ ... functionName: "commitMove", args: [gameId, ch], ... });   // :120
await pub.waitForTransactionReceipt({ hash: h1 });                                                    // :128
const h2 = await wallet.writeContract({ ... functionName: "revealMove", ... });                       // :129
await pub.waitForTransactionReceipt({ hash: h2 });                                                    // :137
```
If the commit lands and the reveal reverts (`"fee"` at `GameTable.sol:282`, `"illegal geom"` at `:277`, or any RPC hiccup), the commit is still stored — `commitMove` requires `g.commits[seat].commitHash == bytes32(0)`, i.e. `require(..., "pending")` at `GameTable.sol:248` blocks every retry for that seat until `expireCommit` (`:310-329`, `COMMIT_REVEAL_WINDOW = 60`) is called. `contracts.ts` never exports `expireCommit`; `App.tsx:244-246` merely toasts:
```ts
} catch (e: unknown) {
  toast("走子失败", String(e));
  setStatus("走子失败 — 规则或余额不足");
```
and the salt is lost with the closure.
**Impact:** one flaky reveal = up to a minute of a frozen game with a misleading message, and the player cannot self-recover. This is the most likely way a live demo dies.
**Fix:** wrap each step separately; if the commit succeeded and the reveal failed, persist `{salt, from, to, piece}` in a "pending move" state and render a "重试揭示 / 让该座超时弃权" panel that calls `revealMove` again or `expireCommit` (poll `block.timestamp` or simply offer it after 60 s).

### H2. Slash is hardcoded to one clause and one betrayer, and the button reads "covenant active" not "violation proven"
`frontend/src/App.tsx:318-333`:
```ts
// Demo: claim AI (seat 2) betrayed NO_CAPTURE_ADVISOR
await challengeBetrayal(accountForSeat(mySeat), covenantHash, AI_SEAT, 1);
...
log("背刺挑战成功 · BetrayalSlashed", true);
```
`App.tsx:622-624` enables it whenever `covenantActive` is true:
```tsx
<button className="danger" disabled={!covenantActive || busy} onClick={doSlash}>
  挑战背刺 Slash
```
But the contract requires evidence and the caller to be the victim — `Covenant.sol:254-259`:
```solidity
require(msg.sender == victimAddr, "victim");
if (violatedClause == CLAUSE_NO_CAPTURE_ADVISOR) {
    require(IGameTable(gameTable).advisorBetrayal(c.gameId, betrayerSeat, victim, c.activatedPly), "no capture");
```
**Impact:** a player who has just locked 0.10 MON (or 0.40 for 疏火) sees an inviting red button that reverts on every click until one specific event (AI captures *that* player's advisor) has already happened. The PRD's dramatic peak becomes a "why doesn't this work" moment. The 疏火 covenant (clause 4) can *never* be slashed from this UI because `doSlash` always passes clause `1` (`:323`).
**Fix:** read `getCovenant(hash)` + `advisorBetrayal(gameId, aiSeat, mySeat, activatedPly)` (or the peace variant with `getPeacePlies`) before enabling, show the clause list, and pass the violated clause from state instead of the literal `1`.

### H3. The demo's owner-only drains are the only way to reach the endgame on a human timescale
`frontend/src/App.tsx:463-464`:
```ts
await directorDrain(deployer, id, 1, parseEther("5"));
await directorDrain(deployer, id, 2, parseEther("5"));
```
`directorDrain` is `onlyOwner` (`GameTable.sol:345`). A normal (non-demo) game has no such shortcut, and the only natural endings are: capture a general (hard: 27 pieces, no check/checkmate rules, see M4) or reach `MAX_PLIES = 80` (`GameTable.sol:19`, one full round = 3 moves, driven by 80 manual AI-button clicks). Natural bankruptcy is essentially unreachable — the cheapest legal move is a 1-step soldier at `0.006–0.009 MON` (`FeeLib.sol:37-41`) against a 2 MON opening balance, and the largest single drain is a chariot capture penalty of 0.1 MON (`FeeLib.sol:52-55`).
**Impact:** the "破产收束" beat that the README table advertises (`README.md` 2:15 row) exists **only** inside the demo button. A user who presses "新开一局" has no path to 终局 within a demo-length session.
**Fix:** expose the game's own end conditions in the UI (ply counter with "X/80", per-seat `playBalance` vs `minAffordableLegalMoveFee`, a "认输/退出" that maps to an honest on-chain resign path if you add one), and stop relying on `directorDrain` outside the demo.

### H4. "Chain connected" only means "some JSON-RPC answered `eth_blockNumber`"; wrong-network is indistinguishable from ready
`frontend/src/App.tsx:109-119`:
```ts
useEffect(() => {
  (async () => {
    try {
      const pub = getPublicClient();
      await pub.getBlockNumber();
      setChainOk(true);
    } catch {
      setChainOk(false);
    }
  })();
}, []);
```
`activeChain` is built from the static JSON (`chain.ts:5-12`), so if the RPC at `127.0.0.1:8545` is a fork, a different chain, or a node where the addresses were never deployed, the pill still reads `链已连接 · http://127.0.0.1:8545` (`App.tsx:547`) and the first contract interaction fails with "returned no data".
**Impact:** a stranger pointed at a stale `addresses.json` sees a green "connected" badge and a board that silently does nothing useful. There is also no handling of the `chainId` mismatch case (the app cannot ask a wallet to switch, because there is no wallet — see B1).
**Fix:** on mount read `eth_chainId` and compare with `addresses.chainId`; call `getCode` on the three addresses; render three distinct states (`RPC 未启动` / `链 ID 不匹配 (期望 10143，实际 X)` / `合约未部署` / `就绪`) and only then enable buttons.

### H5. "体验使用" has no faucet: a stranger with a real wallet has no way to obtain MON
`README.md` (五条命令) and PRD §6 (`docs/PRD.md:308` "临时会话钱包 + faucet（含作战余额）") promise a faucet. The repo contains `grep -rn "faucet" frontend/src` → only `wallet.ts:36` (`ANVIL_KEYS.faucet`). The UI string at `App.tsx:537` says "连接 / 灌测币" — but the "coin" comes from Anvil key #0, which exists only on a local node.
**Impact:** even with the app deployed on 10143 at a public URL, a visitor cannot fund a seat (3 MON per seat: `constants.ts:2-7`, `JOIN_VALUE = 3 MON`), so the first real action is impossible.
**Fix:** either link a Monad faucet and show the connected address with a copy button and balance, or run a rate-limited testnet dripper, or sponsor seats via a paymaster — and say which one on screen.

### H6. Errors are `String(e)` / raw viem objects in a toast
`App.tsx:172` `toast("Anvil 未就绪", String(e), "info")`; `:214` `toast("开局失败", String(e))`; `:245` `toast("走子失败", String(e))`; `:272`, `:312`, `:329`, `:369` the same. The single place that extracts a message is the demo handler, `App.tsx:491-496`:
```ts
const msg = e && typeof e === "object" && "shortMessage" in e && typeof e.shortMessage === "string" ? e.shortMessage : ...
```
**Impact:** a viem `ContractFunctionRevertedError` stringifies to `[object Object]` or a multi-screen dump. A player whose move reverted on `"fee"` or `"illegal geom"` cannot tell which. Baseline requirement for "stranger can try it" is unmet.
**Fix:** one `humanizeError(e)` helper: unwrap `shortMessage`/`metaMessages`, map known revert strings (`"fee"` → 作战余额不足，需 X MON；`"pending"` → 上一步尚未揭示；`"taken"` → 该座位已被其他钱包占用; `"busy i"` → 你已有生效盟约) and always show the underlying reason trimmed to one line.

### H7. `wallets.humanA!` non-null assertions will throw at runtime; no top-level error boundary
`frontend/src/App.tsx:179-183`:
```ts
function accountForSeat(seat: Seat): Account {
  if (seat === AI_SEAT) return aiAccount;
  if (seat === 0) return toAccount(wallets.humanA!);
  return toAccount(wallets.humanB!);
}
```
Called from async handlers (`onMove:231`, `doTopUp:267`, `doSlash:323`, `proposeAlliance:289-290`). If `wallets` is empty (e.g. the user refreshes the page and clicks "操控红营" then a piece before pressing "连接 / 灌测币" — `setMySeat` at `:630` has no guard, and `connected` is not required to *select* pieces in `Board.tsx:182-187`), `toAccount(undefined)` throws inside an async function → unhandled rejection, toast never fires (the `throw` is inside `try`, so it is caught and toasts `String(e)` — but there is no `ErrorBoundary` anywhere, and `main.tsx:6-10` mounts `App` bare).
**Fix:** make `wallets` a required derived value (`if (!wallets.humanA || !wallets.humanB) return` guards at the top of every handler, as `startMatch:186` already does), and wrap `<App/>` in an error boundary that renders a recoverable panel.

---

## 4. MEDIUM

### M1. Hardcoded seats and magic numbers that assume *this* browser created the game
* `App.tsx:53` `const AI_SEAT: Seat = 2;` — also used at `:180`, `:206`, `:253`, `:323`, `:347`, `:366`, `:412`, `:416`, `:677` (passes `aiSeat={AI_SEAT}`), `:676`. The reveal modal will happily print "卧底座位：绿营" for a game whose real AI seat is 0 or 1.
* `App.tsx:302` `const clauses = kind === "peace" ? [4, 1] : [1, 2];` and `:292` `parseEther("0.25")`, `:296` `parseEther("0.15")`, `:305` `parseEther("0.2")` — the 0.2 is correct only because `bondTotal = 2 × 0.15 = 0.3`, `each = 0.15`, and the proposer already locked 0.1 (`Covenant.sol:183-187`); nothing reads `BOND_PER_CLAUSE` or `EARNEST_BOND` from chain.
* `App.tsx:255` `allySeat: covenantActive ? 0 : null` — assumes the human is always seat 0.
**Fix:** read `aiSeat` via `peekAiSeat` (owner-only — so instead store the locally-created `aiSeat` in state and show "本局卧底由本机创建，座位 2"; on reveal use the emitted `AiRevealed(gameId, seat, hash)`), and read the covenant constants from the contract (`EARNEST_BOND()`, `BOND_PER_CLAUSE()`) before building the value.

### M2. Non-demo gameplay can stall permanently on an expired commit; there is no `expireCommit`/`refundExpiredEarnest`/resign in the UI
`contracts.ts` exports `directorDrain` (`:275`) but not `expireCommit` (`GameTable.sol:310`) or `refundExpiredEarnest` (`Covenant.sol:131`). PRD §3.4 (`docs/PRD.md:126`) requires "超时未 reveal：先扣 timeoutPenalty；再跑破产检查；否则弃权一步" — implemented on chain, unreachable from the page.
**Impact:** a seat that commits and then closes the tab blocks the other two forever (the contract explicitly allows *anyone* to call `expireCommit`, and the frontend never does). A locked earnest is stuck in the Covenant contract with no refund button.
**Fix:** add both calls; surface a "对手超时 60s — 点此推进" banner and a "退回过期诚意金" button.

### M3. `ecoMode` recomputes all legal moves for the whole board, and the board re-renders on every parent state change
`App.tsx:506-514`:
```ts
const ecoTargets: Set<string> = useMemo(() => {
  if (!ecoMode) return new Set<string>();
  const moves = legalMoves(board, board.turn);
```
and `Board.tsx:99-106` does the same work per render:
```ts
const moves: LegalMove[] = selected && mySeat !== null && board.turn === mySeat ? legalMoves(board, mySeat)...
const legalKey = new Set(...); const feeMap = new Map(...);
```
`legalMoves` is O(121 × 121) and allocates an object per legal move (`board.ts:160-184`). `Board` is not wrapped in `React.memo`, and `App` re-renders on every `status`/`log`/`toast` change (including during a move, when `setStatus` fires at `:229` and `:243`).
**Impact:** perceptible jank on low-end mobile; each keystroke-free state change recomputes the move list. The `.sanren` container is `max-width: 680px` and the SVG has 121 hit circles + up to ~14 pieces, so this is CPU, not paint.
**Fix:** memoize `legalMoves(board, seat)` by a board revision counter, wrap `Board` in `React.memo`, and skip the `ecoMode` computation unless `ecoMode` is on (it already early-returns, but the parent still re-renders `Board`).

### M4. `aiPlayOnce` can never execute the PRD's "fake sincerity" betrayal, and `activatedPly` is a local guess
`App.tsx:252-261`:
```ts
const pick = pickAiMove(board, { allySeat: covenantActive ? 0 : null, activatedPly, forceBetrayal: false });
```
PRD §3.6 (`docs/PRD.md:141`) makes 假诚意 "**必做**": "Active 盟约履约约 10 手后吃盟友士". `policy.ts:11-14` gates it on `board.ply - opts.activatedPly >= 10`, so it *can* fire after 10 plies — but `activatedPly` is set locally at `App.tsx:307` `setActivatedPly(ply)` from the last `readMeta` result, and is never refreshed from the covenant (`Covenant.sol:236` `activatedPlyOf(hash)` exists and is unused by the frontend). If the covenant is activated when the local `ply` differs from `g.ply` (it does: `proposeAlliance` runs three transactions and never re-reads meta), the 10-ply clock is anchored at the wrong ply.
**Impact:** the flagship AI behaviour triggers at an unpredictable time or, with `forceBetrayal: false` plus the AI being eliminated/bankrupt, not at all. The demo works only because `demoSpine.ts:36` passes `forceBetrayal: true` (and even that path is used only through `demoSpine`, which computes its own board — see M6).
**Fix:** after `activateCovenant`, `setActivatedPly(Number(await cov.activatedPlyOf(hash)))`, and re-read it on every refresh; add a visible "盟约已履约 N 手" counter so the money shot can be timed.

### M5. Dead CSS and unused exports presented as features
* `frontend/src/styles/app.css:317-324` — `.cell.eco`, `.cell.eco.legal` and `:147-162` `.fee-tip` are referenced by no TSX (`Board.tsx` renders SVG circles and an inline `<g>` tooltip at `:238-250`); the `.cell` grid board no longer exists.
* `SanrenBoard.tsx` + `sanrenPath.ts` + `packages/shared/src/sanrenMap.ts` + `sanrenSetup.ts` are reachable only from `frontend/dev-board.html` / `dev-overlay.html` and `src/dev/*`, which are not in any build input. The **rendered** board is the 11×11 `Board.tsx`, whereas `sanrenMap.ts` builds a completely different triangular board with 46+ nodes, arcs and a citadel (`sanrenMap.ts:81-243`) and 13 pieces/side (`sanrenSetup.ts:11-33`). So `README`/commit-message claims about the 三人象棋 map ("三人象棋地图描图") describe code the product never renders, and the two rule geometries are inconsistent by construction (M6-adjacent).
* `wallet.ts:49-54` exports `getBalance`, `formatEther`; neither is used.
* `contracts.ts:71-82` parses `receipt.logs` into a local `gameId` that is overwritten two lines later (`:84-89`); the comment `// parse GameCreated` describes dead code.
**Fix:** delete `.cell*`/`.fee-tip`, either wire `SanrenBoard` in or delete it plus the `SANREN_MAP` exports, and remove the unused helpers.

### M6. The "AI betrayal" in the demo is a scripted board, not the live game
`demoSpine.ts:28-46` replays its own `initialBoard()` and asserts `pickAiMove(..., forceBetrayal: true)` yields an advisor capture; `App.tsx:429-459` then replays `spine.moves` against the chain. `demoSpine()` is called at `App.tsx:411` and would `throw new Error("demo move illegal: …")` (`demoSpine.ts:32`) at runtime if any shared rule changes. There is no unit test for `demoSpine` (no test files exist under `packages/shared/test` — `pnpm test:shared` runs `vitest run` over a package with no tests).
**Impact:** the 3-minute demo — the repo's primary artifact — is a hardcoded ladder whose legality is re-derived at runtime, not covered by a test.
**Fix:** add `demoSpine.test.ts` asserting the chain of `isLegalMove` results and that the betray move captures an advisor; have the demo call `pickAiMove` instead of a precomputed move list where possible.

### M7. Multi-actor UI gives no separation between the two "humans"
`App.tsx:619-633` exposes 秘密求援 / Slash / 终局揭示 and a seat toggle in one flat panel; `ScorePanel` marks exactly one seat as "你" (`App.tsx:609` → `ScorePanel.tsx:32`) and switches instantly. There is no room code/share link/opponent list (see B4), and because `setupSession` regenerates keys per browser (`wallet.ts:23-26`), a refresh on another device yields a different identity for "the same" seat.
**Impact:** nothing in the UI communicates that seats 0/1 are supposed to be two different people, so a stranger cannot infer how a second player would join.
**Fix:** see B4; additionally, show both human addresses with a "本机" tag and never label a seat "你" when it is not the connected address.

### M8. The endgame never shows the money
`readMeta` returns `prizePool` (`contracts.ts:271`) and it is never displayed; `EndgameReveal.tsx:14-38` shows only the AI seat, winner, `trustScore`, `slashed`, `forcedBurn` and the motive string. The PRD's payout (70/20/10 + stake refund, `GameTable.sol:518-562`) is invisible.
**Impact:** the "double ledger" story ends with no settlement screen; a player cannot see what they won or lost.
**Fix:** after finalize, read each seat's ETH/token balance delta (or emit/parse `GameFinalized` + balances) and show a settlement table (stake refund, prize pool share, protocol cut, net).

---

## 5. LOW

| # | Issue | file:line | Evidence / impact | Fix |
|---|---|---|---|---|
| L1 | Google Fonts is a hard external dependency of the first paint ("stranger opens a browser" can fail on a locked-down network) | `frontend/index.html:7-9` `<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC…">` | Fonts are cosmetic; CSS already lists fallbacks (`app.css:17-18`) | Self-host subset or drop the link |
| L2 | Multiplayer/spectator claim unmet: zero polling, zero subscriptions | `App.tsx:109-119` is the only `useEffect` in the file | Board fresh only in `runDemoFull:448,460,482` and the game only refreshes on a tx the local user submitted | Needs `watchContractEvent` or a 2 s poll; without it the "观战" role in PRD §3.1 (`docs/PRD.md:98`) does not exist |
| L3 | RPC probe never retries after Anvil starts | `App.tsx:109-119`, `:554-563` | The empty-state card renders a shell recipe (`terminal 1: pnpm anvil …`) with no "重试" button; buttons stay disabled forever (`:533`) | Add a retry button / poll the probe |
| L4 | `toast()` timer leaks and can set state after unmount | `App.tsx:102-106` `setTimeout(() => setToasts(...), 4500)` | No cleanup; 4.5 s window | Store timers in a ref / clear on unmount |
| L5 | `busy` is one global flag; a partial failure leaves buttons disabled with no cancel | `App.tsx:58`, `:375-502` | `runDemoFull` awaits ~20 receipts and 121 `eth_call`s per board read with no timeout; the UI is frozen ("进行中…") if an RPC hangs | Per-action busy + `AbortController`/timeout on reads |
| L6 | `onMove`'s third argument is dead | `Board.tsx:198` `onMove(selected, { x, y }, board.cells[…]piece)` vs `App.tsx:221` | Harmless but signals the double-implementation of legality | Drop the param or make `onMove` use it (M10-style single source of truth) |
| L7 | Two independent legality implementations, no cross-check in CI | `packages/shared/src/board.ts:111-156` vs `contracts/src/GameTable.sol:580-617` | They agree today (checked piece-by-piece, including the horse-leg quirk at `board.ts:138-140` / `GameTable.sol:601-607` and elephant-eye at `:135` / `:598-599`), and `computeMoveFee` (`fees.ts:11-17`) matches `FeeLib.moveFee` exactly — but nothing tests the agreement | Add a fuzz test comparing `legalMoves` against `previewMoveFee`/`_isLegal` for random boards |
| L8 | No "pool broken" guard against the same human signing both sides of a covenant | `App.tsx:666-674` targets list includes the other human seat; `accountForSeat` (`:179-183`) maps 0 and 1 to two keys the same person controls | In seat-toggle mode a user can attempt 红↔蓝 self-alliance; `Covenant.sol:174` `require(signerI != signerJ)` reverts and the toast says only "盟约失败" | Disable self-targets or label seats as "本机" |
| L9 | Mobile: 20 px hit circles inside a 1000-unit viewBox | `Board.tsx:193` `r="20"` | At a 360 px viewport (`.sanren` max-width 680, `app.css:134`) that is ≈14 px, ~1/3 of the 44 px minimum; no keyboard focus (`<circle onClick>` is not focusable) | Render 40-unit hit areas and/or HTML buttons over the SVG; add keyboard navigation |
| L10 | `EndgameReveal`'s backdrop cannot close while `AllianceModal`'s can | `EndgameReveal.tsx:17` `<div className="modal-backdrop">` vs `AllianceModal.tsx:24` `onClick={onClose}` | Minor inconsistency | Add `onClick={onClose}` |
| L11 | A seat's address renders as a full zero string for empty seats | `ScorePanel.tsx:36` `{s.address ? \`${s.address.slice(0,6)}…${s.address.slice(-4)}\` : "未入座"}`; `readSeat` returns `0x000…000` (`contracts.ts:148-150`) | Shows `0x0000…0000` instead of 未入座 for unjoined seats | Treat `address === zeroAddress` as absent |
| L12 | `chainId` mismatch produces a silent dead board rather than a distinct state | `App.tsx:212` `setMySeat(0)` + interactive check at `:593` | In seat-toggle mode after switching to 蓝营 the board goes non-interactive with no explanation | Show "当前轮到红营…" text driven by `turn` vs `mySeat` |

---

## 6. NIT

* `App.tsx:225` comment `// legality already filtered by Board; never send illegal` is false in the important case: `Board` filters against the **stale local** board, and the contract re-checks (`GameTable.sol:277`). That gap is exactly H1.
* `App.tsx:229` `估计 ${fee !== undefined ? formatMon(fee) : "?"} MON` — the estimate is computed before the tx and never reconciled with the emitted `MoveFeePaid` value.
* `App.tsx:240` logs the locally-computed `fee`, not the on-chain value from `MoveFeePaid`.
* `App.tsx:141-143` `if (meta.phase === 2) setWinnerSeat(...)` — `phase` is a plain number from a tuple (`contracts.ts:266`), so the magic `2` is a copy of the Solidity enum with no shared constant.
* `App.tsx:516` `const phaseLabel = phase === 0 ? "大厅" : phase === 1 ? "行棋中" : phase === 2 ? "已终局" : "—";` — same duplication.
* `contracts.ts:12` imports `BOARD_H, BOARD_W` from shared for the cell loop, but the loop bounds are the only thing shared; the contract's `BOARD_W/BOARD_H` are separate constants (`GameTable.sol:22-23`).
* `App.tsx:63-66` `wallets` has an optional `humanB` that is always set together with `humanA`; the optionality is what forces H7's `!`.
* `frontend/tsconfig.json` sets `"noUnusedLocals": false, "noUnusedParameters": false`, so the dead `piece` parameter (L6) and unused imports would never be flagged.
* `frontend/package.json` `"build": "tsc -b && vite build"` is fine, but `tsconfig.tsbuildinfo` is committed-adjacent (`frontend/tsconfig.tsbuildinfo` exists in the tree) — it reuses stale state for `tsc -b` (a plain `npx tsc -b` returned instantly with exit 0; `--force` was needed to be sure).
* `docs/PRD.md:197` advertises 卒走1格 **0.009 MON**; the implemented formula gives `(0.010 + 0.005) × 0.6 = 0.009` only at distance 1 — correct for that example, but the UI's own demo log prints `cheapFee`/`chariotFee` from the same formula (`App.tsx:432`), so the README's "约 0.009 / 0.050" stays consistent. No action.
* `README.md` claims "公开事件不写卧底座位" — true, and `Joined(gameId, seat, player)` does emit the player address, so seat *identity* is public; only the `isAi` bit is hidden (`GameTable.sol:37` comment, `:141`). The privacy claim should be phrased as "事件不含 isAi 位" to avoid overclaiming (PRD §5.4 G1).
* `frontend/src/lib/chain.ts:5` `const chainId = addresses.chainId || 31337;` silently defaults to Anvil on a malformed/absent field — a typo'd testnet config becomes a local-chain config.

---

## 7. What actually works today (hands-on, local Anvil)

Verified by reading the full call path and the contract's matching logic:

1. **Deploy + boot**: `pnpm anvil` / `pnpm deploy:local` writes `frontend/src/lib/addresses.json` (verified format in `scripts/deploy-local.sh`) / `pnpm dev` serves a working board at `:5173`. `vite build` produces a valid static bundle.
2. **Wallet bootstrap on Anvil**: two ephemeral keys created and persisted in `localStorage` (`wallet.ts:13-29`), 8 MON dripped from the Anvil key, AI key dripped.
3. **Full game creation and seating**: `createGame(2)` + three `join(3 MON)` in one click; the contract's `Lobby → Playing` transition fires on the third join (`GameTable.sol:143-156`), the frontend picks it up via `refreshChainSeats` (`App.tsx:209` → `:136-140`), and the board becomes interactive (`App.tsx:593`).
4. **Legal move with commit → reveal and real fee burn**: two transactions per move, salt generated per move (`contracts.ts:116`), and the client's fee preview is byte-identical to `FeeLib.moveFee` for every piece/distance (checked `fees.ts:11-17` against `FeeLib.sol:33-42`).
5. **Legal-move generation agrees with the chain.** I diffed `board.ts:111-156` against `GameTable.sol:580-617` rule by rule and found no divergence: general/soldier one orthogonal step (frontend splits the condition, contract uses `adx+ady==1` — equivalent when `dx===0 || dy===0`), advisor diagonal, elephant 2×2 with a blocked eye, horse with a blocked leg (the contract's `hx/hy` at `:605-606` corresponds to the same leg the frontend checks at `board.ts:138-140`), chariot ray with clear path, cannon ray with exactly one screen when capturing, plus `dstSeat == seat` self-capture rejection on both sides. `initialBoard()` (`board.ts:35-73`) is the same 27-piece layout as `_setupInitialBoard` (`GameTable.sol:747-776`), including the relocated seat-2 horse at `(6,9)`.
6. **Capture settlement** with Points, half-point clawback and a MON penalty (`GameTable.sol:418-439`), reflected in the 双账本 panel.
7. **Secret alliance mechanically**: `lockEarnest` → dual ECDSA over the raw hash (`signCovenantHash` → `wallet.signMessage({ message: { raw } })` at `contracts.ts:396-399`, matching `Covenant.sol:318-331`'s `\x19Ethereum Signed Message:\n32` prefix) → `activateCovenant` with the correct 0.2 MON top-up for a 2-clause bond (`Covenant.sol:183-187`). The events genuinely omit seats (`EarnestLocked` at `:63`, `CovenantActivated` at `:65`).
8. **Betrayal slash** with real evidence: the AI/whatever seat actually captures an advisor after activation, then `challengeBetrayal` moves the bond into the victim's `playBalance` (`Covenant.sol:270-280` → `GameTable.sol:233-240`).
9. **Endgame reveal and reputation** when the game does end: `finalizeGame` pays out 70/20/10 (`GameTable.sol:518-562`), reveals the AI seat, and writes `games/wins/slashed/betrayalIndex/trustScore/forcedBurnMonTotal` to `AgentRegistry` (`AgentRegistry.sol:48-74`); the modal renders `trustScore`, `slashed`, `forcedBurn` and the motive string.
10. **The 3-minute demo spine** (`App.tsx:375-503`) does run the intended narrative on a fresh Anvil and prints the step tracker — as long as the page is served from a build whose `ANVIL_KEYS.deployer` is the contract owner, because it drains seats with `onlyOwner` calls.

Everything above is real chain state. Nothing above survives contact with a public testnet or a second human.

---

## 8. THE ANSWER: how far is this from "a stranger opens a browser and plays"?

**Not close — there is no browser path at all.** Today the app is a *self-hosted dev console*: it ships the chain's chainId, RPC URL and contract addresses as compile-time JSON, it mints its players' identities from `localStorage` and funds them from a private key that is public in the bundle, and its AI is a button. The stranger experience, verbatim, is:

> open URL → `检测 RPC…` → `Anvil 未启动` → a card reading `terminal 1: pnpm anvil / terminal 2: pnpm deploy:local / terminal 3: pnpm dev` with every button greyed out.

And if they *are* a developer who runs those three commands, they get a genuinely impressive single-player demo console: real fee burns, real commit-reveal, real earnest bonds, a real slash, a real reputation write — but they still cannot play a game to its end without clicking "导演代走" ~80 times, and they still cannot invite a second person.

Concretely, in dependency order, the distance is:

| # | Gap | Size | Blocks |
|---|---|---|---|
| 1 | EIP-1193 wallet connect + network switch + `import.meta.env` config (B1, H4) | ~1–2 days | everything on a public URL |
| 2 | Move the AI out of the bundle into a signer service and make it self-driving (B2, B3, M4) | ~1–2 days | the "hidden staked mole" premise and unattended games |
| 3 | A lobby: create → publish `gameId` → others `join` their own seat; derive `mySeat` from chain (B4, M7) | ~2–3 days | "三人" |
| 4 | Faucet/funding story for 3 MON per seat (H5) | ~0.5 day | first action by a stranger |
| 5 | Error surfacing, pending-commit recovery, `expireCommit`, real end conditions (H1, H2, H3, H6, M2) | ~2 days | a game that finishes without a developer watching it |
| 6 | Polling/events for spectators and reload-resume; endgame settlement screen (L2, M8) | ~1–2 days | "观战" and the payout payoff |
| 7 | Mobile hit targets, i18n of half the UI, loading states (L9, §4 misc) | ~1–2 days | "体验使用" on a phone |

**Realistic estimate: ~8–12 focused engineer-days to reach "a stranger can open a link, connect a wallet, get testnet MON, sit at a seat, and finish a game against a genuinely autonomous AI."** The on-chain half is in good shape and the demo narrative is genuinely built — but essentially all of the *product* surface (identity, funding, matchmaking, autonomy, recovery, settlement) is either hardcoded, owner-only, or missing, and three of those gaps (B1, B2, B4) are architectural rather than cosmetic.
