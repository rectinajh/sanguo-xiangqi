/**
 * index.ts —— 独立运行的 AI 卧底进程。
 *
 * 与前端的区别（这正是评审里指出的最大缺口）：
 *   - 它有自己的 EOA（AGENT_KEY），不读取任何玩家私钥
 *   - 它会**自己轮询回合并自动走子**，不需要人类点"导演代走"
 *   - 它可以自主接盟、履约、然后在窗口到期后背刺
 *   - 终局时把 motiveLog 的哈希写进链上
 *   - 若配置了 KIMI_API_KEY：用大模型选棋 + 走路解说 + 说话 + 背刺（失败回退脚本）
 *
 * 用法：
 *   cp agent/.env.example agent/.env   # 填 AGENT_KEY / KIMI_API_KEY
 *   pnpm agent
 */
import { encodeAbiParameters, formatEther, keccak256, type Hex } from "viem";
import {
  NODE_COUNT,
  Piece,
  SEAT_LABEL_ZH,
  applyMove,
  initialBoard,
  legalMoves,
  pickAiMove,
  type BoardState,
  type LegalMove,
  type Seat,
} from "@sanguo/shared";
import { ABIS, loadConfig, makeClients, type AgentConfig } from "./chain.js";
import { decideWithKimi, loadKimiConfig, type KimiConfig } from "./kimi.js";
import { loadAgentEnv } from "./loadEnv.js";
import { MotiveLog } from "./motiveLog.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ctx = ReturnType<typeof makeClients>;

class MoleAgent {
  private readonly log = new MotiveLog("fake_sincerity+gas_assassin");
  private readonly state = new Map<
    bigint,
    {
      board: BoardState;
      lastPly: number;
      covenantHash: Hex | null;
      activatedPly: number | null;
      betrayed: boolean;
      finished: boolean;
      motivePublished: boolean;
      /** 事件同步游标：只扫这个块高之后的 MoveRevealed / SeatBankrupt */
      lastSyncedBlock: bigint;
      /** 首轮是否已把该局历史事件回填 */
      backfilled: boolean;
    }
  >();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly ctx: Ctx,
    private readonly kimi: KimiConfig | null,
  ) {}

  private get seat(): Seat {
    return this.cfg.seat as Seat;
  }

  private say(msg: string) {
    const t = new Date().toISOString().slice(11, 19);
    console.log(`[${t}] ${msg}`);
  }

  async run() {
    this.say(`AI 卧底启动 · 座位 ${this.seat}(${SEAT_LABEL_ZH[this.seat]})`);
    this.say(`地址 ${this.ctx.account.address}`);
    this.say(`链 ${this.cfg.chainId} · ${this.cfg.rpcUrl}`);
    this.say(`GameTable ${this.cfg.addresses.GameTable}`);
    if (this.kimi) {
      this.say(
        `Kimi 已启用 · model=${this.kimi.model} · move=${this.kimi.enableMove} walk=${this.kimi.enableWalk} speech=${this.kimi.enableSpeech} betrayal=${this.kimi.enableBetrayal}`
      );
    } else {
      this.say("Kimi 未配置（无 KIMI_API_KEY）· 使用脚本 pickAiMove");
    }

    await this.ensureRegistered();

    // 事件订阅只用来加速唤醒，真正状态一律从链上读（前端可伪显示，链才是真源）
    this.ctx.pub.watchContractEvent({
      address: this.cfg.addresses.GameTable,
      abi: ABIS.GameTable,
      onLogs: () => {
        /* 轮询本身足够；这里只是为了让日志更及时 */
      },
    });

    for (;;) {
      try {
        await this.tick();
      } catch (err) {
        this.say(`tick 出错（继续运行）：${(err as Error).message.split("\n")[0]}`);
      }
      await sleep(this.cfg.pollMs);
    }
  }

  private async ensureRegistered() {
    const reg = (await this.ctx.pub.readContract({
      address: this.cfg.addresses.AgentRegistry,
      abi: ABIS.AgentRegistry,
      functionName: "getReputation",
      args: [this.ctx.account.address],
    })) as readonly unknown[];
    const registered = Boolean(reg[6]);
    if (registered) {
      this.say("声誉身份已存在");
      return;
    }
    try {
      const hash = await this.ctx.wallet.writeContract({
        address: this.cfg.addresses.AgentRegistry,
        abi: ABIS.AgentRegistry,
        functionName: "registerAgent",
        args: ["sanguo://agent/mole-v1"],
        account: this.ctx.account,
        chain: this.ctx.chain,
      });
      await this.ctx.pub.waitForTransactionReceipt({ hash });
      this.say("已注册进 AgentRegistry");
    } catch (e) {
      this.say(`注册跳过：${(e as Error).message.split("\n")[0]}`);
    }
  }

  /** 找出所有"正在等我走子"的对局 */
  private async myGames(): Promise<bigint[]> {
    if (this.cfg.gameId !== undefined) return [this.cfg.gameId];

    const next = (await this.ctx.pub.readContract({
      address: this.cfg.addresses.GameTable,
      abi: ABIS.GameTable,
      functionName: "nextGameId",
    })) as bigint;

    const out: bigint[] = [];
    // nextGameId 从 1 开始；扫描最近若干个对局即可
    const from = next > 50n ? next - 50n : 1n;
    for (let id = from; id < next; id++) {
      try {
        const seat = (await this.ctx.pub.readContract({
          address: this.cfg.addresses.GameTable,
          abi: ABIS.GameTable,
          functionName: "getSeat",
          args: [id, this.seat],
        })) as readonly [string, bigint, bigint, number, boolean];
        const isMine = seat[0].toLowerCase() === this.ctx.account.address.toLowerCase();
        if (!isMine) continue;
        const meta = (await this.ctx.pub.readContract({
          address: this.cfg.addresses.GameTable,
          abi: ABIS.GameTable,
          functionName: "getGameMeta",
          args: [id],
        })) as readonly [number, number, number, boolean, number, bigint];
        const phase = Number(meta[0]);
        if (phase === 0 || phase === 1) out.push(id);
      } catch {
        /* 该 id 可能不存在 */
      }
    }
    return out;
  }

  private async tick() {
    for (const gameId of await this.myGames()) {
      await this.handleGame(gameId);
    }
  }

  private async handleGame(gameId: bigint) {
    const meta = (await this.ctx.pub.readContract({
      address: this.cfg.addresses.GameTable,
      abi: ABIS.GameTable,
      functionName: "getGameMeta",
      args: [gameId],
    })) as readonly [number, number, number, boolean, number, bigint];
    const phase = Number(meta[0]);
    const turn = Number(meta[1]) as Seat;
    const ply = Number(meta[2]);
    const aiRevealed = Boolean(meta[3]);

    // 自动入座：大厅阶段如果我的座位还空着，且余额够，就自己入座。
    // 这是 agent 能"自己开局"的前提 —— 以前必须由人类先替它 join，
    // 否则它只会对着空座位永远空转（实测踩过）。
    if (phase === 0) {
      await this.ensureSeated(gameId);
      return;
    }

    const st = this.state.get(gameId) ?? {
      board: initialBoard(),
      lastPly: -1,
      covenantHash: null,
      activatedPly: null,
      betrayed: false,
      finished: false,
      motivePublished: false,
      lastSyncedBlock: 0n,
      backfilled: false,
    };
    this.state.set(gameId, st);

    if (phase === 2) {
      if (aiRevealed && !st.motivePublished) st.motivePublished = true;
      if (!st.finished) {
        st.finished = true;
        this.say(`局 ${gameId} 已终局 · forcedBurn≈${formatEther(this.log.forcedBurnMon)} MON`);
        this.say(`motiveLog 哈希 ${this.log.hash()}`);
      }
      return;
    }

    // 棋盘状态由事件增量维护。
    //
    // 为什么不用"整盘读链"：GameTable.cell() 是逐节点读的，一局要 121+ 次 RPC。
    // 并发打完会被公共 RPC 限流（实测 Monad 测试网直接 RPC Request failed），
    // agent 就卡在 tick 出错里一动不动。改成事件驱动：启动回填一次历史事件，
    // 之后每个 tick 只扫新增区块。
    await this.syncBoardFromEvents(gameId, st);

    await this.syncCovenant(gameId, st);

    if (turn !== this.seat) return;

    // 轮到我走：先尝试走一步（若已有 pending commit 会被合约拒绝，忽略即可）
    await this.playOneMove(gameId, st, ply);
  }

  /** 我的座位是否已入座；没有就自己入座（需要余额 ≥ JOIN_VALUE）。 */
  private async ensureSeated(gameId: bigint) {
    const JOIN_VALUE = 3n * 10n ** 18n; // 1 MON 质押 + 2 MON 作战

    const mine = (await this.ctx.pub.readContract({
      address: this.cfg.addresses.GameTable,
      abi: ABIS.GameTable,
      functionName: "getSeat",
      args: [gameId, this.seat],
    })) as readonly [string, bigint, bigint, number, boolean];
    if (mine[0].toLowerCase() === this.ctx.account.address.toLowerCase()) return; // 已入座
    if (mine[0] !== "0x0000000000000000000000000000000000000000") return; // 被别人占了

    const bal = await this.ctx.pub.getBalance({ address: this.ctx.account.address });
    if (bal < JOIN_VALUE) {
      this.say(
        `局 ${gameId}：座位 ${this.seat} 空着，但余额只有 ${formatEther(bal)} MON，` +
          `不够入座（需 ${formatEther(JOIN_VALUE)} MON）`
      );
      return;
    }

    try {
      const h = await this.ctx.wallet.writeContract({
        address: this.cfg.addresses.GameTable,
        abi: ABIS.GameTable,
        functionName: "join",
        args: [gameId, this.seat],
        value: JOIN_VALUE,
        account: this.ctx.account,
        chain: this.ctx.chain,
      });
      await this.ctx.pub.waitForTransactionReceipt({ hash: h });
      this.say(`局 ${gameId}：已自动入座 ${this.seat}(绿营)，锁定 ${formatEther(JOIN_VALUE)} MON`);
    } catch (e) {
      this.say(`局 ${gameId}：入座失败 ${(e as Error).message.split("\n")[0]}`);
    }
  }

  /**
   * 用链上事件增量维护棋盘。
   *
   * 事件是唯一真源（前端可伪显示、cell() 逐点读又太贵），所以：
   *   - 开局先把该局的 MoveRevealed 回填一遍，重建到当前局面
   *   - 之后每个 tick 只扫 lastSyncedBlock 之后的新区块
   *
   * MoveRevealed 带 piece，直接用 applyMove 落到本地盘面，位置语义与合约一致。
   * SeatBankrupt 用来同步"谁出局了"，避免 agent 对着已出局的座位空等。
   */
  private async syncBoardFromEvents(
    gameId: bigint,
    st: {
      board: BoardState;
      lastPly: number;
      lastSyncedBlock: bigint;
      backfilled: boolean;
    }
  ) {
    const latest = await this.ctx.pub.getBlockNumber();
    const from = st.backfilled ? st.lastSyncedBlock + 1n : 0n;
    if (from > latest) return;

    // 首次回填时从 0 开始；若 RPC 对区间有限制，失败就退回"从现在开始"
    let logs: readonly { args?: unknown }[];
    try {
      logs = (await this.ctx.pub.getContractEvents({
        address: this.cfg.addresses.GameTable,
        abi: ABIS.GameTable,
        eventName: "MoveRevealed",
        args: { gameId },
        fromBlock: from,
        toBlock: latest,
      })) as readonly { args?: unknown }[];
    } catch {
      if (!st.backfilled) {
        // 回填失败：退化成"从当前块开始"，至少不会卡死
        st.backfilled = true;
        st.lastSyncedBlock = latest;
      }
      return;
    }

    for (const e of logs) {
      const a = (e.args ?? {}) as {
        fromX?: number;
        fromY?: number;
        toX?: number;
        toY?: number;
        piece?: number;
        seat?: number;
      };
      if (a.seat === undefined || a.fromX === undefined || a.toX === undefined) continue;
      const seat = Number(a.seat) as Seat;
      const from = { x: Number(a.fromX), y: Number(a.fromY ?? 0) };
      const to = { x: Number(a.toX), y: Number(a.toY ?? 0) };
      try {
        const r = applyMove(st.board, seat, from, to);
        st.board = r.board;
        st.lastPly = st.board.ply;
      } catch {
        // 本地盘面与链上不同步时不要中断整个 agent，记一笔继续
        this.say(`局 ${gameId}：事件重放失败 (${from.x}→${to.x})，跳过`);
      }
    }

    // 出局信息（破产由他人触发时 agent 需要知道）
    try {
      const bankrupt = await this.ctx.pub.getContractEvents({
        address: this.cfg.addresses.GameTable,
        abi: ABIS.GameTable,
        eventName: "SeatBankrupt",
        args: { gameId },
        fromBlock: from,
        toBlock: latest,
      });
      for (const e of bankrupt as readonly { args?: unknown }[]) {
        const a = (e.args ?? {}) as { seat?: number };
        if (a.seat !== undefined) st.board.eliminated[Number(a.seat) as Seat] = true;
      }
    } catch {
      /* 出局同步失败不致命 */
    }

    st.backfilled = true;
    st.lastSyncedBlock = latest;
  }

  /** 读回我参与的盟约（第三方读不到，AI 作为当事人可以） */
  private async syncCovenant(
    gameId: bigint,
    st: { covenantHash: Hex | null; activatedPly: number | null; betrayed: boolean }
  ) {
    if (st.covenantHash) return;

    // hasActive 是公开的（只暴露"这个座有没有盟约"，不暴露对象是谁）
    const active = (await this.ctx.pub.readContract({
      address: this.cfg.addresses.Covenant,
      abi: ABIS.Covenant,
      functionName: "hasActive",
      args: [gameId, this.seat],
    })) as boolean;
    if (!active) return;

    // partiesOf 只对当事人返回 hash，第三方拿到的是全零 —— 这就是 G1 的边界
    const h = (await this.ctx.pub.readContract({
      address: this.cfg.addresses.Covenant,
      abi: ABIS.Covenant,
      functionName: "partiesOf",
      args: [gameId, this.seat],
      account: this.ctx.account,
    })) as Hex;

    if (!h || h === `0x${"00".repeat(32)}`) return;

    const ply = (await this.ctx.pub.readContract({
      address: this.cfg.addresses.Covenant,
      abi: ABIS.Covenant,
      functionName: "activatedPlyOf",
      args: [h],
    })) as number;

    st.covenantHash = h;
    st.activatedPly = Number(ply);
    this.say(`局 ${gameId}：已接受盟约 ${h.slice(0, 10)}…（激活于 ply ${ply}）`);
    this.log.push({ ply: Number(ply), kind: "open", detail: `covenant accepted ${h.slice(0, 10)}` });
  }

  private async playOneMove(
    gameId: bigint,
    st: {
      board: BoardState;
      covenantHash: Hex | null;
      activatedPly: number | null;
      betrayed: boolean;
    },
    ply: number
  ) {
    const board = st.board;

    // 背刺窗口：盟约履约 N 手之后，优先吃盟友的士
    const ripe =
      st.covenantHash !== null &&
      st.activatedPly !== null &&
      ply - st.activatedPly >= this.cfg.betrayalAfterPlies &&
      !st.betrayed;

    const allySeat = st.covenantHash ? this.allySeatOf(board) : null;
    const moves = legalMoves(board, this.seat);
    const script = pickAiMove(board, {
      allySeat,
      activatedPly: st.activatedPly,
      forceBetrayal: ripe,
    });
    if (!script || !moves.length) {
      this.say(`局 ${gameId}：没有合法着法`);
      return;
    }

    let pick = script;
    let walk = "";
    let speech = "";
    let source: "kimi" | "script" = "script";

    if (this.kimi) {
      try {
        const d = await decideWithKimi(this.kimi, {
          board,
          seat: this.seat,
          ply,
          moves,
          allySeat,
          betrayalRipe: ripe,
          scriptFallback: script,
        });
        pick = d.move;
        walk = d.walk;
        speech = d.speech;
        source = d.source;
        if (walk) this.say(`局 ${gameId}：【走】${walk}`);
        if (speech) this.say(`局 ${gameId}：【说】${speech}`);
        if (d.reason) this.say(`局 ${gameId}：【因】${d.reason} · ${source}`);
      } catch (e) {
        this.say(`局 ${gameId}：Kimi 失败，回退脚本 · ${(e as Error).message.split("\n")[0]}`);
      }
    }

    const allyHit =
      ripe &&
      allySeat !== null &&
      pick.capture === Piece.Advisor &&
      board.cells[pick.to.x].seat === allySeat;

    if (allyHit) {
      st.betrayed = true;
      this.log.push({
        ply,
        kind: "betray",
        detail: `fake sincerity: captured ally advisor from (${pick.from.x},${pick.from.y})→(${pick.to.x},${pick.to.y})${speech ? ` | ${speech}` : ""}`,
      });
      this.say(`局 ${gameId}：背刺！吃掉盟友的士（ply ${ply}）· ${source}`);
    } else {
      this.log.push({
        ply,
        kind: pick.capture === Piece.Empty ? "open" : "capture",
        detail: `${walk || `(${pick.from.x},${pick.from.y})→(${pick.to.x},${pick.to.y})`}${speech ? ` | ${speech}` : ""}`,
        forcedBurn: await this.estimateOpponentBurn(board, pick),
      });
    }

    await this.commitAndReveal(gameId, pick);
    // 走完之后让下一轮 tick 重新读棋盘
    st.board = applyMove(board, this.seat, pick.from, pick.to).board;
  }

  /** 盟约的另一方是谁（用于"吃盟友的士"） */
  private allySeatOf(board: BoardState): Seat | null {
    // 三座里除我之外仍在场的座位；盟约对象就是其中之一。
    // 具体是谁由已有盟约决定，这里取第一个有士在场的对手。
    for (const s of [0, 1, 2] as Seat[]) {
      if (s === this.seat) continue;
      for (const c of board.cells) {
        if (c.seat === s && c.piece === Piece.Advisor) return s;
      }
    }
    return null;
  }

  /** 估算对手为应对这一手要多烧多少油费（用于 forcedBurnMON 叙事） */
  private async estimateOpponentBurn(board: BoardState, _pick: LegalMove): Promise<bigint> {
    let total = 0n;
    for (const s of [0, 1, 2] as Seat[]) {
      if (s === this.seat || board.eliminated[s]) continue;
      const moves = legalMoves(board, s);
      if (moves.length === 0) continue;
      // 对手最便宜的一步就是被迫付出的最低成本
      total += moves.reduce((a, m) => (m.fee < a ? m.fee : a), moves[0].fee);
    }
    return total;
  }

  private async commitAndReveal(gameId: bigint, move: LegalMove) {
    const piece = this.state.get(gameId)!.board.cells[move.from.x].piece;
    const salt = `0x${Buffer.from(`agent-${gameId}-${Date.now()}-${Math.random()}`)
      .toString("hex")
      .padEnd(64, "0")
      .slice(0, 64)}` as Hex;

    const commitHash = keccak256(
      encodeAbiParameters(
        [
          { type: "uint8" },
          { type: "uint8" },
          { type: "uint8" },
          { type: "uint8" },
          { type: "uint8" },
          { type: "uint8" },
          { type: "bytes32" },
        ],
        [this.seat, move.from.x, move.from.y, move.to.x, move.to.y, piece, salt]
      )
    );

    try {
      const h1 = await this.ctx.wallet.writeContract({
        address: this.cfg.addresses.GameTable,
        abi: ABIS.GameTable,
        functionName: "commitMove",
        args: [gameId, commitHash],
        account: this.ctx.account,
        chain: this.ctx.chain,
      });
      await this.ctx.pub.waitForTransactionReceipt({ hash: h1 });

      const h2 = await this.ctx.wallet.writeContract({
        address: this.cfg.addresses.GameTable,
        abi: ABIS.GameTable,
        functionName: "revealMove",
        args: [gameId, move.from.x, move.from.y, move.to.x, move.to.y, piece, salt],
        account: this.ctx.account,
        chain: this.ctx.chain,
      });
      const r = await this.ctx.pub.waitForTransactionReceipt({ hash: h2 });
      const ok = r.status === "success";
      this.say(
        `局 ${gameId}：${ok ? "走子成功" : "走子回滚"} ` +
          `(${move.from.x},${move.from.y})→(${move.to.x},${move.to.y}) fee=${formatEther(move.fee)} MON`
      );
      if (!ok) {
        // reveal 失败时把 salt 打出来，便于人工用 expireCommit 收尾
        this.say(`  ⚠️ reveal 回滚，salt=${salt}`);
      }
    } catch (e) {
      this.say(`局 ${gameId}：走子异常 ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

async function main() {
  loadAgentEnv();
  const cfg = loadConfig();
  const kimi = loadKimiConfig();
  const ctx = makeClients(cfg);
  const agent = new MoleAgent(cfg, ctx, kimi);
  await agent.run();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
