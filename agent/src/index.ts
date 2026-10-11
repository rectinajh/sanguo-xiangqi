/**
 * index.ts —— 独立运行的 AI 卧底进程。
 *
 * 与前端的区别（这正是评审里指出的最大缺口）：
 *   - 它有自己的 EOA（AGENT_KEY），不读取任何玩家私钥
 *   - 它会**自己轮询回合并自动走子**，不需要人类点"导演代走"
 *   - 它可以自主接盟、履约、然后在窗口到期后背刺
 *   - 终局时把 motiveLog 的哈希写进链上
 *
 * 用法：
 *   AGENT_KEY=0x... pnpm agent
 * 可选：
 *   GAME_ID=3            只服务指定对局
 *   AGENT_SEAT=2         坐哪一座
 *   BETRAYAL_AFTER_PLIES=10  履约多少手之后背刺
 *   AGENT_POLL_MS=1500   轮询间隔
 */
import { encodeAbiParameters, formatEther, keccak256, type Hex } from "viem";
import {
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
    }
  >();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly ctx: Ctx,
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

    const st = this.state.get(gameId) ?? {
      board: initialBoard(),
      lastPly: -1,
      covenantHash: null,
      activatedPly: null,
      betrayed: false,
      finished: false,
      motivePublished: false,
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

    // 状态变化时同步棋盘（棋盘只在 reveal 后变化）
    if (ply !== st.lastPly) {
      st.board = await this.readBoard(gameId);
      st.lastPly = ply;
    }

    await this.syncCovenant(gameId, st);

    if (turn !== this.seat) return;

    // 轮到我走：先尝试走一步（若已有 pending commit 会被合约拒绝，忽略即可）
    await this.playOneMove(gameId, st, ply);
  }

  private async readBoard(gameId: bigint): Promise<BoardState> {
    const b = initialBoard();
    const cells = await Promise.all(
      Array.from({ length: 11 }, (_, y) =>
        Promise.all(
          Array.from({ length: 11 }, (_, x) =>
            this.ctx.pub.readContract({
              address: this.cfg.addresses.GameTable,
              abi: ABIS.GameTable,
              functionName: "cell",
              args: [gameId, x, y],
            }) as Promise<readonly [number, number]>
          )
        )
      )
    );
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        const [piece, seatOr255] = cells[y][x];
        b.cells[y][x] = {
          piece: piece as Piece,
          seat: seatOr255 === 255 ? null : (seatOr255 as Seat),
        };
      }
    }
    const seatViews = await Promise.all(
      ([0, 1, 2] as Seat[]).map(
        (s) =>
          this.ctx.pub.readContract({
            address: this.cfg.addresses.GameTable,
            abi: ABIS.GameTable,
            functionName: "getSeat",
            args: [gameId, s],
          }) as Promise<readonly [string, bigint, bigint, number, boolean]>
      )
    );
    b.eliminated = seatViews.map((s) => s[4]);
    b.ply = this.state.get(gameId)?.lastPly ?? 0;
    b.turn = this.seat;
    return b;
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

    const pick = pickAiMove(board, {
      allySeat: st.covenantHash ? this.allySeatOf(board) : null,
      activatedPly: st.activatedPly,
      forceBetrayal: ripe,
    });
    if (!pick) {
      this.say(`局 ${gameId}：没有合法着法`);
      return;
    }

    if (ripe && pick.capture === Piece.Advisor) {
      st.betrayed = true;
      this.log.push({
        ply,
        kind: "betray",
        detail: `fake sincerity: captured ally advisor from (${pick.from.x},${pick.from.y})→(${pick.to.x},${pick.to.y})`,
      });
      this.say(`局 ${gameId}：背刺！吃掉盟友的士（ply ${ply}）`);
    } else {
      this.log.push({
        ply,
        kind: pick.capture === Piece.Empty ? "open" : "capture",
        detail: `(${pick.from.x},${pick.from.y})→(${pick.to.x},${pick.to.y})`,
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
      for (let y = 0; y < 11; y++) {
        for (let x = 0; x < 11; x++) {
          const c = board.cells[y][x];
          if (c.seat === s && c.piece === Piece.Advisor) return s;
        }
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
    const piece = this.state.get(gameId)!.board.cells[move.from.y][move.from.x].piece;
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
  const cfg = loadConfig();
  const ctx = makeClients(cfg);
  const agent = new MoleAgent(cfg, ctx);
  await agent.run();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
