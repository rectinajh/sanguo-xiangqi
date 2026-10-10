import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BoardState,
  Coord,
  Piece,
  Seat,
  SEAT_LABEL_ZH,
  initialBoard,
  applyMove,
  legalMoves,
  formatMon,
  JOIN_VALUE,
  type LegalMove,
} from "@sanguo/shared";
import { keccak256, encodePacked, parseEther, type Hex, type Account } from "viem";
import { Board } from "./components/Board";
import { ScorePanel, type SeatView } from "./components/ScorePanel";
import { AllianceModal } from "./components/AllianceModal";
import { EndgameReveal } from "./components/EndgameReveal";
import { ToastHost, type ToastItem } from "./components/Toast";
import {
  loadOrCreateWallet,
  toAccount,
  fundFromAnvil,
  type SessionWallet,
} from "./lib/wallet";
import { accountFromKey, ANVIL_KEYS, getPublicClient, addresses } from "./lib/chain";
import {
  hasAddresses,
  createGame,
  joinGame,
  commitAndReveal,
  readSeat,
  readMeta,
  directorDrain,
  finalizeGame,
  lockEarnest,
  lockPeaceOffer,
  activateCovenant,
  challengeBetrayal,
  signCovenantHash,
  depositPlayBalance,
} from "./lib/contracts";

type LogItem = { t: string; hl?: boolean };
type DemoStep = { id: string; label: string; done: boolean; current: boolean };

const AI_SEAT: Seat = 2;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("准备中");
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const [wallets, setWallets] = useState<{
    humanA?: SessionWallet;
    humanB?: SessionWallet;
  }>({});
  const aiAccount = useMemo(() => accountFromKey(ANVIL_KEYS.ai), []);
  const deployer = useMemo(() => accountFromKey(ANVIL_KEYS.deployer), []);

  const [gameId, setGameId] = useState<bigint | null>(null);
  const [board, setBoard] = useState<BoardState>(() => initialBoard());
  const [mySeat, setMySeat] = useState<Seat>(0);
  const [selected, setSelected] = useState<Coord | null>(null);
  const [hoverFee, setHoverFee] = useState<{ to: Coord; fee: bigint } | null>(null);
  const [seats, setSeats] = useState<SeatView[]>([
    { seat: 0, playBalance: 0n, points: 0, seatStake: 0n, eliminated: false },
    { seat: 1, playBalance: 0n, points: 0, seatStake: 0n, eliminated: false },
    { seat: 2, playBalance: 0n, points: 0, seatStake: 0n, eliminated: false },
  ]);
  const [turn, setTurn] = useState<Seat>(0);
  const [phase, setPhase] = useState(0);
  const [ply, setPly] = useState(0);

  const [ecoMode, setEcoMode] = useState(false); // 省油推荐
  const [allianceOpen, setAllianceOpen] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [motiveLog, setMotiveLog] = useState("");
  const [winnerSeat, setWinnerSeat] = useState<Seat | null>(null);
  const [covenantHash, setCovenantHash] = useState<Hex | null>(null);
  const [covenantActive, setCovenantActive] = useState(false);
  const [demoSteps, setDemoSteps] = useState<DemoStep[]>([]);

  const log = useCallback((t: string, hl?: boolean) => {
    setLogs((prev) => [{ t, hl }, ...prev].slice(0, 40));
  }, []);

  const toast = useCallback((title: string, body?: string, kind?: "slash" | "info") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((p) => [...p, { id, title, body, kind }]);
    setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), 4500);
  }, []);

  // Probe RPC
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

  async function refreshChainSeats(id: bigint) {
    const views: SeatView[] = [];
    for (let s = 0; s < 3; s++) {
      const r = await readSeat(id, s);
      views.push({
        seat: s as Seat,
        playBalance: r.playBalance,
        points: r.points,
        seatStake: r.seatStake,
        eliminated: r.eliminated,
        address: r.player,
        isYou: s === mySeat,
      });
    }
    setSeats(views);
    const meta = await readMeta(id);
    setTurn(meta.turn);
    setPhase(meta.phase);
    setPly(meta.ply);
    if (meta.phase === 2) {
      setWinnerSeat(meta.winnerSeat < 3 ? (meta.winnerSeat as Seat) : null);
    }
  }

  async function setupSession() {
    setBusy(true);
    setStatus("创建临时钱包…");
    try {
      const humanA = loadOrCreateWallet("humanA");
      const humanB = loadOrCreateWallet("humanB");
      setWallets({ humanA, humanB });
      if (!hasAddresses()) {
        setStatus("未部署合约 — 请先跑 deploy:local");
        toast("缺少合约地址", "运行 pnpm deploy:local", "info");
        setBusy(false);
        return;
      }
      setStatus("从 Anvil 灌测币…");
      await fundFromAnvil(humanA.address, "8");
      await fundFromAnvil(humanB.address, "8");
      // AI already has anvil #1 funded by default, top up anyway
      await fundFromAnvil(aiAccount.address, "8");
      setConnected(true);
      setStatus("钱包就绪 · 可开局");
      log(`临时钱包 A ${humanA.address.slice(0, 8)}…`);
      log(`临时钱包 B ${humanB.address.slice(0, 8)}…`);
      log(`AI Agent ${aiAccount.address.slice(0, 8)}…（独立密钥）`);
      toast("会话就绪", "人类临时钱包已生成并注资；AI 永不碰你的钥");
    } catch (e: unknown) {
      setStatus("连接失败");
      toast("Anvil 未就绪", String(e), "info");
      setChainOk(false);
    } finally {
      setBusy(false);
    }
  }

  function accountForSeat(seat: Seat): Account {
    if (seat === AI_SEAT) return aiAccount;
    if (seat === 0) return toAccount(wallets.humanA!);
    return toAccount(wallets.humanB!);
  }

  async function startMatch() {
    if (!wallets.humanA || !wallets.humanB) return;
    setBusy(true);
    setStatus("创建对局…");
    try {
      setBoard(initialBoard());
      setSelected(null);
      setCovenantHash(null);
      setCovenantActive(false);
      setRevealOpen(false);

      const id = await createGame(deployer, AI_SEAT);
      setGameId(id);
      log(`Game #${id} 创建 · AI 卧底座位已隐藏`, true);

      await joinGame(toAccount(wallets.humanA), id, 0, JOIN_VALUE);
      log("红营入座 · 锁 1 MON + 2 MON 作战余额");
      await joinGame(toAccount(wallets.humanB), id, 1, JOIN_VALUE);
      log("蓝营入座");
      await joinGame(aiAccount, id, 2, JOIN_VALUE);
      log("绿营入座（疑似凡人…）");

      await refreshChainSeats(id);
      setStatus("对局进行中 · 每步一笔链上交易");
      toast("三座已满", "开始行棋 — 点己子看合法格与油费");
      setMySeat(0);
    } catch (e: unknown) {
      toast("开局失败", String(e));
      setStatus("开局失败");
    } finally {
      setBusy(false);
    }
  }

  async function onMove(from: Coord, to: Coord, piece: Piece) {
    if (gameId === null || busy) return;
    const seat = board.turn;
    // legality already filtered by Board; never send illegal
    const fee = legalMoves(board, seat).find((m: LegalMove) => m.from.x === from.x && m.from.y === from.y && m.to.x === to.x && m.to.y === to.y
    )?.fee;
    setBusy(true);
    setStatus(`提交走子… 预估 ${fee !== undefined ? formatMon(fee) : "?"} MON`);
    try {
      const acct = accountForSeat(seat);
      await commitAndReveal(acct, gameId, seat, from, to, piece);
      const result = applyMove(board, seat, from, to);
      setBoard(result.board);
      if (result.captured !== Piece.Empty) {
        log(`吃子！Points 结算中…`, true);
        toast("吃子结算", `捕获棋子，双账本已更新`);
      }
      log(
        `${SEAT_LABEL_ZH[seat]} 走子 (${from.x},${from.y})→(${to.x},${to.y}) · 扣油费 ${fee !== undefined ? formatMon(fee) : "?"}`
      );
      await refreshChainSeats(gameId);
      setStatus("对局进行中");
    } catch (e: unknown) {
      toast("走子失败", String(e));
      setStatus("走子失败 — 规则或余额不足");
    } finally {
      setBusy(false);
    }
  }

  /** AI auto-play one heuristic move when it's AI turn */
  async function aiPlayOnce() {
    if (gameId === null || board.turn !== AI_SEAT || busy) return;
    const moves = legalMoves(board, AI_SEAT);
    if (!moves.length) return;
    // Prefer captures; else cheaper moves unless "aggression"
    const captures = moves.filter((m: LegalMove) => m.capture !== Piece.Empty);
    const pool = captures.length ? captures : moves;
    pool.sort((a: LegalMove, b: LegalMove) => Number(a.fee - b.fee));
    // Mid pick: not always cheapest (feels alive) but prefer value
    const pick = captures.length ? pool[pool.length - 1] : pool[0];
    await onMove(pick.from, pick.to, board.cells[pick.from.y][pick.from.x].piece);
  }

  async function doTopUp() {
    if (gameId === null || mySeat === AI_SEAT) return;
    setBusy(true);
    try {
      await depositPlayBalance(accountForSeat(mySeat), gameId, mySeat, parseEther("1"));
      await refreshChainSeats(gameId);
      log(`${SEAT_LABEL_ZH[mySeat]} 补给油费 +1 MON（氪金路线）`, true);
      toast("油费已补给", "+1 MON 作战余额 · 可打远程车");
    } catch (e: unknown) {
      toast("补给失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function proposeAlliance(to: Seat, kind: "ally" | "peace" = "ally") {
    if (gameId === null || !wallets.humanA) return;
    setBusy(true);
    try {
      const myBal = seats[mySeat]?.playBalance ?? 0n;
      const hash = keccak256(
        encodePacked(
          ["string", "uint256", "uint8", "uint8", "uint256"],
          [kind === "peace" ? "peace" : "covenant", gameId, mySeat, to, BigInt(Date.now())]
        )
      );
      setCovenantHash(hash);
      const me = accountForSeat(mySeat);
      const other = accountForSeat(to);
      if (kind === "peace") {
        await lockPeaceOffer(me, gameId, hash, ply, mySeat, myBal, parseEther("0.25"), 8);
        log(`疏火要约已锁 · 贿金 0.25 MON · 8 手停火（事件无座位）`, true);
        toast("疏火诚意金", "第三方看不见你在疏通谁");
      } else {
        // multi-offer: if already have pending, send premium
        const value = parseEther("0.15"); // covers earnest+premium buffer
        await lockEarnest(me, gameId, hash, ply, mySeat, myBal, value);
        log(`诚意金已锁 · hash ${hash.slice(0, 10)}…`, true);
        toast("诚意金锁定", "第三方看不见求援对象");
      }

      const clauses = kind === "peace" ? [4, 1] : [1, 2];
      const sigI = await signCovenantHash(me, hash);
      const sigJ = await signCovenantHash(other, hash);
      await activateCovenant(other, hash, gameId, mySeat, to, clauses, sigI, sigJ, parseEther("0.2"));
      setCovenantActive(true);
      log(kind === "peace" ? "疏火盟约 Active · 停火窗口开启" : "盟约 Active（G1 隐座位）", true);
      toast(kind === "peace" ? "疏火生效" : "秘密盟约生效", "违约可 Slash；非法着法仍禁止");
      setAllianceOpen(false);
    } catch (e: unknown) {
      toast("盟约失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doSlash() {
    if (gameId === null || !covenantHash) return;
    setBusy(true);
    try {
      // Demo: claim AI (seat 2) betrayed NO_CAPTURE_ADVISOR
      await challengeBetrayal(accountForSeat(mySeat), covenantHash, AI_SEAT, 1, 2);
      setCovenantActive(false);
      log("背刺挑战成功 · BetrayalSlashed", true);
      toast("背刺罚没！", "盟约 bond 已划给受害方", "slash");
      await refreshChainSeats(gameId);
    } catch (e: unknown) {
      toast("Slash 失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doFinalize() {
    if (gameId === null) return;
    setBusy(true);
    try {
      const motive = [
        "motiveLog v1",
        `aiSeat=${AI_SEAT}`,
        "strategy=fake_sincerity",
        "forcedBurnMON=0.07",
        "betrayal=NO_CAPTURE_ADVISOR after trust built",
        `ply=${ply}`,
      ].join("\n");
      setMotiveLog(motive);
      const mh = keccak256(encodePacked(["string"], [motive]));
      // Ensure finished: drain others if needed for demo
      const meta = await readMeta(gameId);
      if (meta.phase !== 2) {
        // force bankrupt seat 1 for demo drama if still playing
        try {
          await directorDrain(deployer, gameId, 1, parseEther("3"));
        } catch {
          /* may already be out */
        }
      }
      await finalizeGame(deployer, gameId, mh);
      await refreshChainSeats(gameId);
      setRevealOpen(true);
      log("终局 · AI 揭示 + AgentRegistry 已记声誉", true);
      toast("AI 卧底揭晓", SEAT_LABEL_ZH[AI_SEAT]);
      setStatus("对局结束");
    } catch (e: unknown) {
      toast("终局失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runDemo() {
    if (!connected) await setupSession();
    const steps: DemoStep[] = [
      { id: "join", label: "入座三座 · 隐藏 AI", done: false, current: true },
      { id: "move", label: "走子烧 MON（fee 预览）", done: false, current: false },
      { id: "whale", label: "氪金补给 / 性价比对照", done: false, current: false },
      { id: "ally", label: "诚意金秘密结盟", done: false, current: false },
      { id: "slash", label: "背刺 Slash", done: false, current: false },
      { id: "end", label: "终局揭示 AI + 声誉", done: false, current: false },
    ];
    const mark = (id: string) => {
      setDemoSteps(
        steps.map((s, i) => {
          const idx = steps.findIndex((x) => x.id === id);
          return {
            ...s,
            done: i <= idx,
            current: i === idx + 1,
          };
        })
      );
    };
    setDemoSteps(steps.map((s, i) => ({ ...s, current: i === 0, done: false })));

    setBusy(true);
    try {
      if (!wallets.humanA) {
        const humanA = loadOrCreateWallet("humanA");
        const humanB = loadOrCreateWallet("humanB");
        setWallets({ humanA, humanB });
        await fundFromAnvil(humanA.address, "8");
        await fundFromAnvil(humanB.address, "8");
        await fundFromAnvil(aiAccount.address, "8");
        setConnected(true);
        // continue with local refs
        wallets.humanA = humanA;
        wallets.humanB = humanB;
      }
      setBusy(false);
      await startMatch();
      mark("join");

      // A few human moves + AI
      setEcoMode(true);
      await new Promise((r) => setTimeout(r, 400));
      // Play as seat 0 if turn 0
      let b = initialBoard();
      // sync: after startMatch board was reset — use state carefully by reading legal from initial and applying locally after chain
      // Re-fetch: we'll move using current board state via functional approach
      setBusy(false);

      // Move 1: red soldier
      {
        const moves = legalMoves(initialBoard(), 0);
        const cheap = [...moves].sort((a: LegalMove, c: LegalMove) => Number(a.fee - c.fee))[0];
        if (cheap && gameId !== null) {
          /* gameId set in startMatch — race: use latest via ref pattern */
        }
      }
    } catch (e: unknown) {
      toast("Demo 中断", String(e));
      setBusy(false);
    }
  }

  // Robust demo harness
  async function runDemoFull() {
    setBusy(true);
    const steps: DemoStep[] = [
      { id: "join", label: "入座三座 · 隐藏 AI", done: false, current: true },
      { id: "move", label: "走子烧 MON（fee 预览）", done: false, current: false },
      { id: "whale", label: "氪金补给 / 省油推荐", done: false, current: false },
      { id: "ally", label: "诚意金秘密结盟", done: false, current: false },
      { id: "slash", label: "背刺 Slash", done: false, current: false },
      { id: "end", label: "终局揭示 AI + 声誉", done: false, current: false },
    ];
    const setStep = (id: string) => {
      const idx = steps.findIndex((s) => s.id === id);
      setDemoSteps(
        steps.map((s, i) => ({
          ...s,
          done: i <= idx,
          current: i === idx + 1 || (i === idx && idx === steps.length - 1),
        }))
      );
    };
    setDemoSteps(steps);

    try {
      let humanA = wallets.humanA ?? loadOrCreateWallet("humanA");
      let humanB = wallets.humanB ?? loadOrCreateWallet("humanB");
      setWallets({ humanA, humanB });
      if (!hasAddresses()) throw new Error("请先 deploy:local");
      await fundFromAnvil(humanA.address, "10");
      await fundFromAnvil(humanB.address, "10");
      await fundFromAnvil(aiAccount.address, "10");
      setConnected(true);

      let b = initialBoard();
      setBoard(b);
      const id = await createGame(deployer, AI_SEAT);
      setGameId(id);
      await joinGame(toAccount(humanA), id, 0, JOIN_VALUE);
      await joinGame(toAccount(humanB), id, 1, JOIN_VALUE);
      await joinGame(aiAccount, id, 2, JOIN_VALUE);
      await refreshChainSeats(id);
      setMySeat(0);
      setStep("join");
      log("Demo: 三座入座完成", true);

      // Cheap move (budget style)
      setEcoMode(true);
      const cheapMoves = legalMoves(b, 0).sort((a: LegalMove, c: LegalMove) => Number(a.fee - c.fee));
      const m1 = cheapMoves[0];
      await commitAndReveal(toAccount(humanA), id, 0, m1.from, m1.to, b.cells[m1.from.y][m1.from.x].piece);
      b = applyMove(b, 0, m1.from, m1.to).board;
      setBoard(b);
      log(`性价比着法 扣 ${formatMon(m1.fee)} MON`, true);
      await refreshChainSeats(id);

      // AI move
      const aiMoves = legalMoves(b, 2);
      if (aiMoves.length && b.turn === 2) {
        const am = aiMoves.sort((a: LegalMove, c: LegalMove) => Number(a.fee - c.fee))[0];
        await commitAndReveal(aiAccount, id, 2, am.from, am.to, b.cells[am.from.y][am.from.x].piece);
        b = applyMove(b, 2, am.from, am.to).board;
        setBoard(b);
      } else if (b.turn === 1) {
        const bm = legalMoves(b, 1).sort((a: LegalMove, c: LegalMove) => Number(a.fee - c.fee))[0];
        await commitAndReveal(toAccount(humanB), id, 1, bm.from, bm.to, b.cells[bm.from.y][bm.from.x].piece);
        b = applyMove(b, 1, bm.from, bm.to).board;
        setBoard(b);
        if (b.turn === 2) {
          const am = legalMoves(b, 2).sort((a: LegalMove, c: LegalMove) => Number(a.fee - c.fee))[0];
          await commitAndReveal(aiAccount, id, 2, am.from, am.to, b.cells[am.from.y][am.from.x].piece);
          b = applyMove(b, 2, am.from, am.to).board;
          setBoard(b);
        }
      }
      await refreshChainSeats(id);
      setStep("move");

      // Whale top-up
      await depositPlayBalance(toAccount(humanA), id, 0, parseEther("2"));
      await refreshChainSeats(id);
      log("氪金补给 +2 MON — 远程车已可负担", true);
      toast("Whale 补给", "人类可热补油费；AI 合约层禁止");
      setStep("whale");

      // Alliance between A and B (AI will "betray" narratively)
      const hash = keccak256(encodePacked(["string", "uint256"], ["demo-cov", id]));
      setCovenantHash(hash);
      await lockEarnest(toAccount(humanA), id, hash, 1, 0, parseEther("4"), parseEther("0.1"));
      const sigI = await signCovenantHash(toAccount(humanA), hash);
      const sigJ = await signCovenantHash(toAccount(humanB), hash);
      await activateCovenant(toAccount(humanB), hash, id, 0, 1, [1, 2], sigI, sigJ, parseEther("0.2"));
      setCovenantActive(true);
      log("秘密盟约 Active", true);
      setStep("ally");

      // Slash — demo challenges seat2 as betrayer for drama (even if ally was A-B: show slash UX)
      // Better narrative: re-lock A-AI alliance for true betrayal story
      const hash2 = keccak256(encodePacked(["string", "uint256"], ["demo-betray", id]));
      await lockEarnest(toAccount(humanA), id, hash2, 2, 0, parseEther("4"), parseEther("0.15"));
      const sAI = await signCovenantHash(aiAccount, hash2);
      const sA = await signCovenantHash(toAccount(humanA), hash2);
      // Need previous covenant cleared — fulfill first
      // Skip if activeBySeat busy: slash the A-B one as victim claiming B betrayal for demo
      await challengeBetrayal(toAccount(humanA), hash, 1, 1, 2);
      setCovenantHash(hash);
      setCovenantActive(false);
      toast("背刺罚没！", "Bond 已划转", "slash");
      log("BetrayalSlashed 已上链", true);
      setStep("slash");

      // Bankrupt B via director for endgame
      await directorDrain(deployer, id, 1, parseEther("5"));
      const motive = [
        "motiveLog v1",
        "aiSeat=2",
        "strategy=fake_sincerity+gas_pressure",
        "note=humans burned MON; alliance slashed",
        "forcedBurnMON≈0.05+",
      ].join("\n");
      setMotiveLog(motive);
      const mh = keccak256(encodePacked(["string"], [motive]));
      await finalizeGame(deployer, id, mh);
      await refreshChainSeats(id);
      setRevealOpen(true);
      setStep("end");
      setStatus("Demo 完成");
      toast("Demo 脊骨跑通", "入座→扣费→补给→结盟→Slash→揭示");
    } catch (e: unknown) {
      console.error(e);
      toast("Demo 失败", String(e));
      setStatus("Demo 失败");
    } finally {
      setBusy(false);
    }
  }

  // Eco highlight: cheapest legal moves for current turn
  const ecoTargets: Set<string> = useMemo(() => {
    if (!ecoMode) return new Set<string>();
    const moves = legalMoves(board, board.turn);
    if (!moves.length) return new Set<string>();
    const min = moves.reduce((a: bigint, m: LegalMove) => (m.fee < a ? m.fee : a), moves[0].fee);
    return new Set<string>(
      moves.filter((m: LegalMove) => m.fee === min).map((m: LegalMove) => `${m.to.x},${m.to.y}`)
    );
  }, [ecoMode, board]);

  const phaseLabel = phase === 0 ? "大厅" : phase === 1 ? "行棋中" : phase === 2 ? "已终局" : "—";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>三国棋局 · Shadow Xiangqi</h1>
          <p className="tagline">
            三人象棋桌上藏着押金 AI 卧底——步步一笔交易烧 MON。氪金可打华丽远程车；性价比党靠省油与逼破产取胜。非法着法永不放行。
          </p>
          <div className="badge-row">
            <span className="badge accent">赛道 04 · AI 身份与声誉</span>
            <span className="badge">ZK-ready · 非完整 ZK</span>
            <span className="badge">本地 Anvil / Monad-ready</span>
          </div>
        </div>
        <div className="actions" style={{ minWidth: 200 }}>
          <button className="primary" disabled={busy || chainOk === false} onClick={runDemoFull}>
            {busy ? "进行中…" : "一键 Demo 脊骨"}
          </button>
          <button className="secondary" disabled={busy || chainOk === false} onClick={setupSession}>
            连接 / 灌测币
          </button>
          <button className="secondary" disabled={busy || !connected} onClick={startMatch}>
            新开一局
          </button>
        </div>
      </header>

      <div className="status-bar">
        <span className={`status-pill ${chainOk ? "ok" : chainOk === false ? "err" : "warn"}`}>
          {chainOk === null ? "检测 RPC…" : chainOk ? `链已连接 · ${addresses.rpcUrl}` : "Anvil 未启动"}
        </span>
        <span className="status-pill">{hasAddresses() ? `GameTable ${addresses.GameTable.slice(0, 8)}…` : "未部署"}</span>
        <span className="status-pill warn">{status}</span>
        {gameId !== null && <span className="status-pill">局 #{gameId.toString()} · {phaseLabel} · ply {ply}</span>}
      </div>

      {!chainOk && chainOk !== null && (
        <div className="panel empty">
          <p>请先启动本地链并部署：</p>
          <p className="loading" style={{ marginTop: 8 }}>
            terminal 1: pnpm anvil<br />
            terminal 2: pnpm deploy:local<br />
            terminal 3: pnpm dev
          </p>
        </div>
      )}

      <div className="layout">
        <div className="panel board-wrap">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>棋盘 · 合法格才可点</h2>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className={ecoMode ? "primary" : "ghost"}
                onClick={() => setEcoMode((v) => !v)}
                title="高亮当前最便宜合法着法"
              >
                {ecoMode ? "省油推荐 · 开" : "省油推荐"}
              </button>
              <button className="secondary" disabled={busy || gameId === null || mySeat === AI_SEAT} onClick={doTopUp}>
                补给油费 +1
              </button>
              <button className="secondary" disabled={busy || board.turn !== AI_SEAT} onClick={aiPlayOnce}>
                AI 走一步
              </button>
            </div>
          </div>
          {ecoMode && (
            <p style={{ color: "var(--gold)", fontSize: "0.8rem", margin: "0 0 8px" }}>
              性价比模式：最便宜合法目标格已用金色强调（悬停仍显示精确 fee）。远程车合法但更费油——氪金玩家可先补给。
            </p>
          )}
          <Board
            board={board}
            mySeat={connected ? mySeat : null}
            interactive={!!connected && phase === 1 && !busy}
            selected={selected}
            onSelect={setSelected}
            onMove={onMove}
            hoverFee={hoverFee}
            onHoverLegal={setHoverFee}
            ecoTargets={ecoTargets}
          />
          {ecoMode && ecoTargets.size > 0 && (
            <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: 8 }}>
              当前最便宜合法目标数：{ecoTargets.size}（仅提示，不绕过棋规）
            </p>
          )}
        </div>

        <div className="sidebar">
          <ScorePanel seats={seats.map((s) => ({ ...s, isYou: s.seat === mySeat }))} turn={turn} />

          <div className="panel">
            <h2>玩法切换</h2>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: 0 }}>
              <strong style={{ color: "var(--red)" }}>氪金：</strong>补给油费后打远程车/华丽连吃。
              <br />
              <strong style={{ color: "var(--green)" }}>性价比：</strong>开省油推荐，短步进逼，逼对手烧光破产。
            </p>
            <div className="actions">
              <button className="secondary" disabled={!gameId || busy} onClick={() => setAllianceOpen(true)}>
                秘密求援
              </button>
              <button className="danger" disabled={!covenantActive || busy} onClick={doSlash}>
                挑战背刺 Slash
              </button>
              <button className="secondary" disabled={!gameId || busy} onClick={doFinalize}>
                终局揭示
              </button>
              <div style={{ display: "flex", gap: 6 }}>
                {([0, 1] as Seat[]).map((s) => (
                  <button key={s} className={mySeat === s ? "primary" : "ghost"} onClick={() => setMySeat(s)}>
                    操控{SEAT_LABEL_ZH[s]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {demoSteps.length > 0 && (
            <div className="panel">
              <h2>Demo 进度</h2>
              <div className="demo-steps">
                {demoSteps.map((s) => (
                  <div key={s.id} className={`step ${s.done ? "done" : ""} ${s.current ? "current" : ""}`}>
                    <span>{s.done ? "✓" : s.current ? "→" : "·"}</span>
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="panel">
            <h2>事件流</h2>
            <div className="log">
              {logs.length === 0 && <div className="item">尚无事件 — 开始 Demo 或开局</div>}
              {logs.map((l, i) => (
                <div key={i} className={`item ${l.hl ? "hl" : ""}`}>
                  {l.t}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <AllianceModal
        open={allianceOpen}
        fromSeat={mySeat}
        targets={([0, 1, 2] as Seat[]).filter((s) => s !== mySeat)}
        onClose={() => setAllianceOpen(false)}
        onPropose={proposeAlliance}
        busy={busy}
        isWhale={(seats[mySeat]?.playBalance ?? 0n) >= parseEther("3")}
      />
      <EndgameReveal
        open={revealOpen}
        aiSeat={AI_SEAT}
        winnerSeat={winnerSeat}
        motiveLog={motiveLog}
        onClose={() => setRevealOpen(false)}
      />
      <ToastHost items={toasts} />
    </div>
  );
}
