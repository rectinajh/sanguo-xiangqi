import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BoardState,
  Coord,
  Piece,
  Seat,
  SEAT_LABEL_ZH,
  initialBoard,
  legalMoves,
  formatMon,
  JOIN_VALUE,
  demoSpine,
  pickAiMove,
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
import {
  accountFromKey,
  ANVIL_KEYS,
  getPublicClient,
  addresses,
  activeChain,
  IS_LOCAL_DEMO,
  hasInjectedWallet,
  requestInjectedAccount,
  ensureInjectedChain,
  assertCorrectChain,
  getInjectedWalletClient,
} from "./lib/chain";
import {
  hasAddresses,
  createGame,
  joinGame,
  commitAndReveal,
  readSeat,
  readMeta,
  readBoard,
  directorDrain,
  finalizeGame,
  lockEarnest,
  lockPeaceOffer,
  activateCovenant,
  challengeBetrayal,
  signCovenantHash,
  depositPlayBalance,
  feesPaidOf,
  seatWasSlashed,
  readReputation,
  buildPreimage,
  registerAgent,
  clausesOf,
} from "./lib/contracts";

type LogItem = { t: string; hl?: boolean };
type DemoStep = { id: string; label: string; done: boolean; current: boolean };

const AI_SEAT: Seat = 2;
// 链上条款编号，必须与 Covenant.sol 的常量一致
const CLAUSE_NO_CAPTURE_ADVISOR = 1;
const CLAUSE_NO_EXPOSE = 2;
const CLAUSE_BUY_PEACE = 4;
const BOND_PER_CLAUSE = parseEther("0.15");

/**
 * viem 的错误对象直接 String() 会渲染成 "[object Object]"。
 * 这里按优先级取出人类可读的 revert 原因。
 */
function friendlyError(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as Record<string, unknown>;
    if (typeof anyE.shortMessage === "string") return anyE.shortMessage;
    if (typeof anyE.details === "string") return anyE.details;
    if (typeof anyE.message === "string") {
      const m = anyE.message as string;
      // 合约 revert 的 reason 常藏在 message 里
      const match = m.match(/reverted with the following reason:\s*([^\n]+)/);
      if (match) return match[1].trim();
      return m.split("\n")[0];
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

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

  // ── 真实玩家身份 ─────────────────────────────────────────────
  // 本地演示（chainId 31337）沿用内置测试钥 + 双人左右互搏；
  // 其它链上一律走浏览器钱包，一个浏览器只代表一个玩家。
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(null);
  const [walletKind, setWalletKind] = useState<"none" | "injected" | "local">("none");
  const [chainName, setChainName] = useState<string>("");
  const isLocalDemo = IS_LOCAL_DEMO;
  /** 我在链上占的座位；null 表示还没入座 */
  const [mySeatOrNull, setMySeatOrNull] = useState<Seat | null>(null);

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
  // 盟约里"可能违约的那一方"的座位。Demo 主线是 AI（座位 2）；
  // 人类互盟时会被 proposeAlliance 设为对手座位。
  const [covenantBetrayer, setCovenantBetrayer] = useState<Seat>(AI_SEAT);
  const [activatedPly, setActivatedPly] = useState<number | null>(null);
  const [aiRevealed, setAiRevealed] = useState(false);
  const [trustScore, setTrustScore] = useState<number | undefined>(undefined);
  const [slashedCount, setSlashedCount] = useState<number | undefined>(undefined);
  const [forcedBurn, setForcedBurn] = useState<bigint | undefined>(undefined);
  const [demoSteps, setDemoSteps] = useState<DemoStep[]>([]);

  const log = useCallback((t: string, hl?: boolean) => {
    setLogs((prev) => [{ t, hl }, ...prev].slice(0, 40));
  }, []);

  const toast = useCallback((title: string, body?: string, kind?: "slash" | "info") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((p) => [...p, { id, title, body, kind }]);
    setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), 4500);
  }, []);

  // 探测 RPC：不只是"有没有应答"，还要校验链 ID 与应用配置一致
  useEffect(() => {
    (async () => {
      try {
        const pub = getPublicClient();
        await pub.getBlockNumber();
        const actual = await pub.getChainId();
        setChainName(activeChain.name);
        if (actual !== addresses.chainId) {
          setChainOk(false);
          setStatus(`链不匹配：RPC=${actual}，应用配置=${addresses.chainId}`);
          return;
        }
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
    setAiRevealed(meta.aiRevealed);
    if (meta.phase === 2) {
      setWinnerSeat(meta.winnerSeat < 3 ? (meta.winnerSeat as Seat) : null);
    }
  }

  /**
   * 连接玩家身份。
   * - 公网/测试网：请求浏览器钱包授权、切到正确的链，私钥始终留在钱包里。
   * - 本地演示：沿用内置测试钥，并自动灌测币，方便一键跑通。
   */
  async function connectWallet() {
    setBusy(true);
    try {
      if (!hasAddresses()) {
        throw new Error("合约地址不完整 —— 本地请先跑 pnpm deploy:local");
      }
      setStatus("校验链 ID…");
      await assertCorrectChain();

      if (!isLocalDemo) {
        if (!hasInjectedWallet()) {
          throw new Error(
            `${activeChain.name} 上需要使用浏览器钱包。请安装 MetaMask 等 EIP-1193 钱包后刷新页面。`
          );
        }
        setStatus("等待钱包授权…");
        const ok = await ensureInjectedChain();
        if (!ok) throw new Error(`请在钱包里切换到 ${activeChain.name}（chainId ${addresses.chainId}）`);
        const addr = await requestInjectedAccount();
        setWalletAddress(addr);
        setWalletKind("injected");
        setConnected(true);
        setStatus("钱包已连接");
        log(`钱包已连接 ${addr.slice(0, 10)}…（私钥不出钱包）`, true);
        toast("钱包已连接", "接下来在棋盘上选一个空座入座");
        return;
      }

      // —— 本地演示路径 ——
      const humanA = loadOrCreateWallet("humanA");
      const humanB = loadOrCreateWallet("humanB");
      setWallets({ humanA, humanB });
      setWalletAddress(humanA.address);
      setWalletKind("local");
      setStatus("从 Anvil 灌测币…");
      await fundFromAnvil(humanA.address, "8");
      await fundFromAnvil(humanB.address, "8");
      await fundFromAnvil(aiAccount.address, "8");
      setConnected(true);
      setStatus("钱包就绪 · 可开局");
      log(`临时钱包 A ${humanA.address.slice(0, 8)}…`);
      log(`临时钱包 B ${humanB.address.slice(0, 8)}…`);
      log("第三把独立密钥已就绪，终局前不公开身份");
      toast("会话就绪", "人类临时钱包已生成并注资；第三把密钥与人类钥隔离");
    } catch (e: unknown) {
      const msg = friendlyError(e);
      setStatus("连接失败");
      toast("钱包连接失败", msg);
      if (!isLocalDemo) setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  function accountForSeat(seat: Seat): Account {
    if (seat === AI_SEAT) return aiAccount;
    if (seat === 0) return toAccount(wallets.humanA!);
    return toAccount(wallets.humanB!);
  }

  /**
   * 返回"我"在某个座位上的签名者。
   *
   * - 本地演示：三个座位都在本地，可以左右互搏（Demo 需要）。
   * - 公网/测试网：只有连上钱包的那个座位归我，其它座位一律拒绝签名。
   *   这一条是"多人同桌"能成立的前提 —— 一个浏览器只代表一个玩家。
   */
  function signerForSeat(seat: Seat): Account | `0x${string}` {
    if (!isLocalDemo) {
      const mine = seatOwningWallet(seat);
      if (!mine) throw new Error("这不是你的座位 —— 一个钱包只能操控自己入座的那一座");
      return mine;
    }
    return accountForSeat(seat);
  }

  /** 我连的钱包地址占了哪一座（没入座返回 null）。 */
  function seatOwningWallet(seat: Seat): `0x${string}` | null {
    if (!walletAddress) return null;
    const s = seats[seat];
    if (!s?.address) return null;
    return s.address.toLowerCase() === walletAddress.toLowerCase() ? walletAddress : null;
  }

  /** 我在链上实际占的座位。 */
  function seatOfMe(): Seat | null {
    if (walletKind === "local") return mySeat;
    if (!walletAddress) return null;
    for (const s of [0, 1, 2] as Seat[]) {
      const a = seats[s]?.address;
      if (a && a.toLowerCase() === walletAddress.toLowerCase()) return s;
    }
    return null;
  }

  /**
   * 当前正在代表的座位。
   * - 本地演示：可以自由切换看哪一座（一个人左右互搏跑 Demo）。
   * - 真实钱包：只等于我入座的那一座；没入座就是只读观战。
   */
  const activeSeat: Seat | null = walletKind === "local" ? mySeat : seatOfMe();
  /** 我是否能替某个座位签名。真实钱包只认自己那一座。 */
  function canSignFor(seat: Seat): boolean {
    if (walletKind !== "local") return seatOwningWallet(seat) !== null;
    return true;
  }
  const iAmSeated = activeSeat !== null;

  async function startMatch() {
    if (!wallets.humanA || !wallets.humanB) return;
    setBusy(true);
    setStatus("创建对局…");
    try {
      setBoard(initialBoard());
      setSelected(null);
      setCovenantHash(null);
      setCovenantActive(false);
      setActivatedPly(null);
      setAiRevealed(false);
      setRevealOpen(false);

      const id = await createGame(deployer, AI_SEAT);
      setGameId(id);
      log(`Game #${id} 创建 · 卧底身份未写入公开事件`, true);

      await joinGame(toAccount(wallets.humanA), id, 0, JOIN_VALUE);
      log("红营入座 · 锁 1 MON + 2 MON 作战余额");
      await joinGame(toAccount(wallets.humanB), id, 1, JOIN_VALUE);
      log("蓝营入座");
      await joinGame(aiAccount, id, 2, JOIN_VALUE);
      log("绿营入座");

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
    const capturedBefore = board.cells[to.y][to.x].piece !== Piece.Empty;
    setBusy(true);
    setStatus(`提交走子… 预估 ${fee !== undefined ? formatMon(fee) : "?"} MON`);
    try {
      const acct = accountForSeat(seat);
      await commitAndReveal(acct, gameId, seat, from, to, piece);
      const synced = await readBoard(gameId);
      setBoard(synced);
      if (capturedBefore) {
        log("吃子！Points 结算中…", true);
        toast("吃子结算", "捕获棋子，双账本已更新");
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

  async function aiPlayOnce() {
    if (gameId === null || board.turn !== AI_SEAT || busy) return;
    const pick = pickAiMove(board, {
      allySeat: covenantActive ? 0 : null,
      activatedPly,
      forceBetrayal: false,
    });
    if (!pick) return;
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
      // 条款与 bond 现在都进入被签名的 preimage：链上会校验
      // keccak256(abi.encode(preimage)) == covenantHash，调用者无法再现场改条款。
      const clauses = kind === "peace" ? [CLAUSE_BUY_PEACE, CLAUSE_NO_CAPTURE_ADVISOR] : [CLAUSE_NO_CAPTURE_ADVISOR, CLAUSE_NO_EXPOSE];
      const bondAmount = BOND_PER_CLAUSE * BigInt(clauses.length);
      const { preimage, hash } = buildPreimage({
        gameId,
        seatI: mySeat,
        seatJ: to,
        clauses,
        bondAmount,
      });
      setCovenantHash(hash);
      setCovenantBetrayer(to);
      const me = accountForSeat(mySeat);
      const other = accountForSeat(to);

      // 发起方锁诚意金（0.1）；激活时按身份各自补足自己那一半 bond。
      const earnest = preimage.earnestBond;
      if (kind === "peace") {
        await lockPeaceOffer(me, gameId, hash, mySeat, parseEther("0.25"), 8);
        log("疏火要约已锁 · 贿金 0.25 MON · 8 手停火（事件无座位）", true);
        toast("疏火诚意金", "第三方看不见你在疏通谁");
      } else {
        await lockEarnest(me, gameId, hash, mySeat, earnest);
        log(`诚意金已锁 · hash ${hash.slice(0, 10)}…`, true);
        toast("诚意金锁定", "第三方看不见求援对象");
      }

      // 双方对同一个 covenantHash 签名 —— 签的就是上面那份条款。
      const sigI = await signCovenantHash(me, hash);
      const sigJ = await signCovenantHash(other, hash);

      // 由对手方激活：它付自己那一半 + 替发起方补齐缺口（发起方已锁的
      // 诚意金抵扣了自己那一半）。链上按身份计费，不再看谁在调用。
      const each = bondAmount / 2n;
      const proposerOwed = each > earnest ? each - earnest : 0n;
      const value = proposerOwed + each;
      await activateCovenant(other, preimage, sigI, sigJ, value);
      setCovenantActive(true);
      setActivatedPly(ply);
      log(kind === "peace" ? "疏火盟约 Active · 停火窗口开启" : "盟约 Active（G1 隐座位）", true);
      toast(kind === "peace" ? "疏火生效" : "秘密盟约生效", "违约可 Slash；非法着法仍禁止");
      setAllianceOpen(false);
    } catch (e: unknown) {
      toast("盟约失败", friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function doSlash() {
    if (gameId === null || !covenantHash) return;
    setBusy(true);
    try {
      // 不再硬编码"条款 = 1"。条款从链上读回来，按盟约真实包含的条款依次
      // 尝试挑战；链上会用真实吃子记录判定，没有证据会 revert。
      // 违约方默认为 AI 座位（Demo 主线），可由 covenantBetrayer 覆盖。
      const clauses = await clausesOf(covenantHash);
      const betrayer = covenantBetrayer;
      const challenger = accountForSeat(mySeat);

      let lastErr: unknown = null;
      for (const clause of clauses) {
        if (clause === CLAUSE_NO_EXPOSE) continue; // 链上明确不支持该条款的挑战
        try {
          await challengeBetrayal(challenger, covenantHash, betrayer, clause);
          setCovenantActive(false);
          log(`背刺挑战成功 · BetrayalSlashed（条款 ${clause}）`, true);
          toast("背刺罚没！", "盟约 bond 已划给受害方", "slash");
          await refreshChainSeats(gameId);
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr ?? new Error("盟约里没有可挑战的条款");
    } catch (e: unknown) {
      toast("Slash 失败", friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 真实钱包入座：用我自己钱包里的 MON 支付 seatStake + playBalance，
   * 成为这一座的玩家。入座后这个浏览器就只代表这一座。
   * 这是"多人同桌"能成立的前提 —— 每个玩家用自己的钱入自己的座。
   */
  async function joinSeatAsMe(seat: Seat) {
    if (gameId === null || !walletAddress) return;
    setBusy(true);
    setStatus(`入座${SEAT_LABEL_ZH[seat]}…`);
    try {
      const pub = getPublicClient();
      const bal = await pub.getBalance({ address: walletAddress });
      if (bal < JOIN_VALUE) {
        throw new Error(
          `余额不足：入座需要 ${formatMon(JOIN_VALUE)} MON，你当前 ${formatMon(bal)} MON。请先去水龙头领取测试币。`
        );
      }
      // 传入钱包地址即可：签名由浏览器钱包完成，私钥不出钱包
      await joinGame(walletAddress, gameId, seat, JOIN_VALUE);
      await refreshChainSeats(gameId);
      log(`我入座${SEAT_LABEL_ZH[seat]} · 锁 1 MON 质押 + 2 MON 作战余额`, true);
      toast("入座成功", `你现在是${SEAT_LABEL_ZH[seat]}`);
    } catch (e: unknown) {
      toast("入座失败", friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * 确保 AI 座位在声誉注册表里有身份。
   * 注册表不再对陌生地址自动注册（否则 address(0) 之类的地址也能被写入战绩），
   * 所以没注册时 finalizeGame 的声誉写入会被 try/catch 吞掉。这里按需补一次。
   */
  async function ensureAgentRegistered(account: Account) {
    const rep = await readReputation(account.address);
    if (rep.registered) return;
    try {
      await registerAgent(account, "sanguo://agent/mole-v1");
      log("AI 身份已注册进 AgentRegistry", true);
    } catch (err) {
      // 已经注册过（并发或重复点击）不算失败
      log(`AI 身份注册跳过：${friendlyError(err)}`);
    }
  }

  async function doFinalize() {
    if (gameId === null) return;
    setBusy(true);
    try {
      const meta = await readMeta(gameId);
      if (meta.phase !== 2) {
        toast("还不能终局", "需要只剩一方，或达到最大手数");
        return;
      }
      const paid0 = await feesPaidOf(gameId, 0);
      const paid1 = await feesPaidOf(gameId, 1);
      const burned = paid0 + paid1;
      const slashed = await seatWasSlashed(gameId, AI_SEAT);
      const motive = [
        "motiveLog v1",
        "strategy=fake_sincerity",
        `forcedBurnMON=${formatMon(burned)}`,
        `wasSlashed=${slashed}`,
        `ply=${meta.ply}`,
      ].join("\n");
      setMotiveLog(motive);
      setForcedBurn(burned);
      await ensureAgentRegistered(aiAccount);
      const mh = keccak256(encodePacked(["string"], [motive]));
      await finalizeGame(deployer, gameId, mh);
      const rep = await readReputation(aiAccount.address);
      setTrustScore(Number(rep.trustScore));
      setSlashedCount(Number(rep.slashed));
      setForcedBurn(rep.forcedBurnMonTotal);
      await refreshChainSeats(gameId);
      setRevealOpen(true);
      log("终局揭示 · 声誉已写入 AgentRegistry", true);
      toast("卧底揭晓", SEAT_LABEL_ZH[AI_SEAT]);
      setStatus("对局结束");
    } catch (e: unknown) {
      toast("终局失败", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runDemoFull() {
    setBusy(true);
    const steps: DemoStep[] = [
      { id: "join", label: "入座三座 · 身份未公开", done: false, current: true },
      { id: "move", label: "卒便宜 / 车贵", done: false, current: false },
      { id: "ally", label: "诚意金秘密结盟", done: false, current: false },
      { id: "slash", label: "真吃士后 Slash", done: false, current: false },
      { id: "end", label: "破产收束 · 揭示声誉", done: false, current: false },
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

    // Demo 过程中要用到的 covenantHash（challenge 时需要同一个值）
    let demoCovenantHash: Hex | null = null;

    try {
      const humanA = wallets.humanA ?? loadOrCreateWallet("humanA");
      const humanB = wallets.humanB ?? loadOrCreateWallet("humanB");
      setWallets({ humanA, humanB });
      if (!hasAddresses()) throw new Error("请先 deploy:local");
      if (addresses.chainId !== 31337) {
        throw new Error("一键 Demo 只用本地 Anvil 密钥。测试网请用你自己的私钥，不要用公开的 Anvil 钥。");
      }
      await fundFromAnvil(humanA.address, "10");
      await fundFromAnvil(humanB.address, "10");
      await fundFromAnvil(aiAccount.address, "10");
      setConnected(true);
      setAiRevealed(false);
      setRevealOpen(false);

      const spine = demoSpine();
      const id = await createGame(deployer, AI_SEAT);
      setGameId(id);
      await joinGame(toAccount(humanA), id, 0, JOIN_VALUE);
      await joinGame(toAccount(humanB), id, 1, JOIN_VALUE);
      await joinGame(aiAccount, id, 2, JOIN_VALUE);
      await refreshChainSeats(id);
      setBoard(await readBoard(id));
      setMySeat(0);
      setStep("join");
      log("三座入座 · 公开事件没有卧底座位", true);

      const accountFor = (seat: Seat) => {
        if (seat === 0) return toAccount(humanA);
        if (seat === 1) return toAccount(humanB);
        return aiAccount;
      };

      for (const m of spine.moves) {
        if (m.tag === "expensive") {
          setStep("move");
          log(`卒 ${formatMon(spine.cheapFee)} MON · 车 ${formatMon(spine.chariotFee)} MON`, true);
        }
        if (m.tag === "betray") {
          // 红营（0）发起、绿营 AI（2）接盟；条款与 bond 进入被签名的 preimage。
          const clauses = [CLAUSE_NO_CAPTURE_ADVISOR, CLAUSE_NO_EXPOSE];
          const bondAmount = BOND_PER_CLAUSE * BigInt(clauses.length);
          const { preimage, hash } = buildPreimage({
            gameId: id,
            seatI: 0,
            seatJ: AI_SEAT,
            clauses,
            bondAmount,
          });
          demoCovenantHash = hash;
          setCovenantHash(hash);
          setCovenantBetrayer(AI_SEAT);

          // 发起方红营锁诚意金 0.1 并签名
          await lockEarnest(toAccount(humanA), id, hash, 0, preimage.earnestBond);
          const sigI = await signCovenantHash(toAccount(humanA), hash);
          const sigJ = await signCovenantHash(aiAccount, hash);

          // AI 来激活：付自己那一半 + 替红营补齐缺口
          const each = bondAmount / 2n;
          const proposerOwed = each > preimage.earnestBond ? each - preimage.earnestBond : 0n;
          await activateCovenant(aiAccount, preimage, sigI, sigJ, proposerOwed + each);

          const meta = await readMeta(id);
          setActivatedPly(meta.ply);
          setCovenantActive(true);
          setStep("ally");
          log("红营与绿营盟约 Active · 事件不写座位", true);
        }
        await commitAndReveal(accountFor(m.seat), id, m.seat, m.from, m.to, m.piece);
        setBoard(await readBoard(id));
        await refreshChainSeats(id);
        if (m.tag === "betray") {
          log("绿营吃掉红方的士", true);
          await challengeBetrayal(toAccount(humanA), demoCovenantHash!, AI_SEAT, CLAUSE_NO_CAPTURE_ADVISOR);
          setCovenantActive(false);
          setStep("slash");
          toast("背刺罚没", "bond 进入受害方作战余额", "slash");
          log("BetrayalSlashed · 吃士证据已核对", true);
          await refreshChainSeats(id);
        }
      }
      setBoard(await readBoard(id));
      await refreshChainSeats(id);

      await directorDrain(deployer, id, 1, parseEther("5"));
      await directorDrain(deployer, id, 2, parseEther("5"));
      const paid0 = await feesPaidOf(id, 0);
      const paid1 = await feesPaidOf(id, 1);
      const burned = paid0 + paid1;
      const motive = [
        "motiveLog v1",
        "strategy=fake_sincerity",
        `forcedBurnMON=${formatMon(burned)}`,
        "betrayal=NO_CAPTURE_ADVISOR",
        `ply=${(await readMeta(id)).ply}`,
      ].join("\n");
      setMotiveLog(motive);
      setForcedBurn(burned);
      await ensureAgentRegistered(aiAccount);
      await finalizeGame(deployer, id, keccak256(encodePacked(["string"], [motive])));
      const rep = await readReputation(aiAccount.address);
      setTrustScore(Number(rep.trustScore));
      setSlashedCount(Number(rep.slashed));
      setForcedBurn(rep.forcedBurnMonTotal);
      setBoard(await readBoard(id));
      await refreshChainSeats(id);
      setRevealOpen(true);
      setStep("end");
      setStatus("Demo 完成");
      log(`终局揭示 · forcedBurn ${formatMon(rep.forcedBurnMonTotal)} MON · slashed ${rep.slashed}`, true);
      toast("Demo 脊骨跑通", "扣费 → 真吃士 → Slash → 揭示");
    } catch (e: unknown) {
      console.error(e);
      const msg =
        e && typeof e === "object" && "shortMessage" in e && typeof e.shortMessage === "string"
          ? e.shortMessage
          : e instanceof Error
            ? e.message
            : String(e);
      log(`Demo 失败 · ${msg}`, true);
      toast("Demo 失败", msg);
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
            <span className="badge">{chainName || activeChain.name} · chainId {addresses.chainId}</span>
          </div>
        </div>
        <div className="actions" style={{ minWidth: 200 }}>
          <button className="primary" disabled={busy || chainOk === false} onClick={runDemoFull}>
            {busy ? "进行中…" : "一键 Demo 脊骨"}
          </button>
          <button className="secondary" disabled={busy || chainOk === false} onClick={connectWallet}>
            {connected
              ? walletKind === "injected"
                ? `${walletAddress?.slice(0, 6)}…${walletAddress?.slice(-4)} 已连接`
                : "本地会话已就绪"
              : isLocalDemo
                ? "连接 / 灌测币"
                : "连接钱包"}
          </button>
          <button className="secondary" disabled={busy || !connected} onClick={startMatch}>
            新开一局
          </button>
        </div>
      </header>

      <div className="status-bar">
        <span className={`status-pill ${chainOk ? "ok" : chainOk === false ? "err" : "warn"}`}>
          {chainOk === null
            ? "检测 RPC…"
            : chainOk
              ? `${chainName || activeChain.name} 已连接`
              : isLocalDemo
                ? "本地链未就绪"
                : `链不匹配或不可达（需要 chainId ${addresses.chainId}）`}
        </span>
        {!isLocalDemo && (
          <span className={`status-pill ${iAmSeated ? "ok" : "warn"}`}>
            {iAmSeated ? `我的座位：${SEAT_LABEL_ZH[activeSeat!]}` : "未入座"}
          </span>
        )}
        <span className="status-pill">{hasAddresses() ? `GameTable ${addresses.GameTable.slice(0, 8)}…` : "未部署"}</span>
        <span className="status-pill warn">{status}</span>
        {gameId !== null && <span className="status-pill">局 #{gameId.toString()} · {phaseLabel} · ply {ply}</span>}
      </div>

      {!chainOk && chainOk !== null && !isLocalDemo && (
        <div className="panel empty">
          <p>无法连接到 {activeChain.name}（chainId {addresses.chainId}）。</p>
          <p className="loading" style={{ marginTop: 8 }}>
            RPC: {addresses.rpcUrl}
            <br />
            合约: GameTable {addresses.GameTable || "(未配置)"}
            <br />
            如果这是首次部署，请用 VITE_* 环境变量或 deploy:testnet 生成的
            addresses.{addresses.chainId}.json 配置地址。
          </p>
        </div>
      )}

      {!chainOk && chainOk !== null && isLocalDemo && (
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
                导演代走
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
          <ScorePanel seats={seats.map((s) => ({ ...s, isYou: s.seat === activeSeat }))} turn={turn} playing={phase === 1} />

          {!isLocalDemo && (
            <div className="panel">
              <h2>入座</h2>
              {!connected && <p style={{ fontSize: "0.82rem", color: "var(--muted)" }}>先连接钱包。</p>}
              {connected && gameId === null && (
                <p style={{ fontSize: "0.82rem", color: "var(--muted)" }}>还没有进行中的对局，请先「新开一局」。</p>
              )}
              {connected && gameId !== null && (
                <>
                  <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: 0 }}>
                    入座需要 {formatMon(JOIN_VALUE)} MON（1 MON 质押 + 2 MON 作战余额），
                    从你自己的钱包支付。一个钱包只能占一个座位。
                  </p>
                  <div className="actions">
                    {([0, 1, 2] as Seat[]).map((s) => {
                      const occupied = Boolean(seats[s]?.address && seats[s].address !== "0x0000000000000000000000000000000000000000");
                      const mine = seatOwningWallet(s) !== null;
                      return (
                        <button
                          key={s}
                          className={mine ? "primary" : "secondary"}
                          disabled={busy || occupied || phase !== 0}
                          onClick={() => joinSeatAsMe(s)}
                        >
                          {mine ? `你在${SEAT_LABEL_ZH[s]}` : occupied ? `${SEAT_LABEL_ZH[s]} 已满` : `入座${SEAT_LABEL_ZH[s]}`}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

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
              {isLocalDemo ? (
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ fontSize: "0.75rem", color: "var(--muted)", alignSelf: "center" }}>
                    本地演示：可切换视角
                  </span>
                  {([0, 1] as Seat[]).map((s) => (
                    <button key={s} className={mySeat === s ? "primary" : "ghost"} onClick={() => setMySeat(s)}>
                      视角{SEAT_LABEL_ZH[s]}
                    </button>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
                  {iAmSeated
                    ? `你坐在${SEAT_LABEL_ZH[activeSeat!]} · 只能操控自己这一座`
                    : "你还没有入座 —— 在棋盘上点一个空座即可入座"}
                </div>
              )}
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
        open={revealOpen && aiRevealed}
        aiSeat={AI_SEAT}
        winnerSeat={winnerSeat}
        motiveLog={motiveLog}
        trustScore={trustScore}
        slashed={slashedCount}
        forcedBurn={forcedBurn}
        onClose={() => setRevealOpen(false)}
      />
      <ToastHost items={toasts} />
    </div>
  );
}
