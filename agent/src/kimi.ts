/**
 * Kimi（Moonshot）OpenAI 兼容客户端。
 * 只从合法着列表里选索引；坐标仍由规则引擎校验后再上链。
 */
import {
  formatMon,
  Piece,
  PIECE_LABEL_ZH,
  SEAT_LABEL_ZH,
  type BoardState,
  type LegalMove,
  type Seat,
} from "@sanguo/shared";

export type KimiConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  enableMove: boolean;
  enableWalk: boolean;
  enableSpeech: boolean;
  enableBetrayal: boolean;
  fallbackScript: boolean;
};

export type KimiDecision = {
  move: LegalMove;
  walk: string;
  speech: string;
  reason: string;
  betrayNow: boolean;
  source: "kimi" | "script";
};

export function loadKimiConfig(env: NodeJS.ProcessEnv = process.env): KimiConfig | null {
  const apiKey = (env.KIMI_API_KEY ?? env.kimi_apikey ?? "").trim();
  if (!apiKey) return null;
  const flag = (k: string, d = true) => {
    const v = env[k];
    if (v === undefined || v === "") return d;
    return !(v === "0" || v.toLowerCase() === "false" || v.toLowerCase() === "off");
  };
  return {
    apiKey,
    baseUrl: (env.KIMI_BASE_URL ?? "https://api.moonshot.cn/v1").replace(/\/$/, ""),
    model: env.KIMI_MODEL ?? "moonshot-v1-8k",
    timeoutMs: Number(env.KIMI_TIMEOUT_MS ?? 12000),
    enableMove: flag("KIMI_ENABLE_MOVE"),
    enableWalk: flag("KIMI_ENABLE_WALK"),
    enableSpeech: flag("KIMI_ENABLE_SPEECH"),
    enableBetrayal: flag("KIMI_ENABLE_BETRAYAL"),
    fallbackScript: flag("KIMI_FALLBACK_SCRIPT"),
  };
}

function pieceAt(board: BoardState, m: LegalMove): Piece {
  return board.cells[m.from.x].piece;
}

function moveLine(board: BoardState, m: LegalMove, i: number): string {
  const piece = PIECE_LABEL_ZH[pieceAt(board, m)] || "?";
  const cap = m.capture !== Piece.Empty ? ` 吃${PIECE_LABEL_ZH[m.capture]}` : "";
  return `${i}: ${piece} (${m.from.x},${m.from.y})→(${m.to.x},${m.to.y}) fee=${formatMon(m.fee)} MON${cap}`;
}

function extractJson(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function chat(cfg: KimiConfig, system: string, user: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Kimi HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Kimi 返回空内容");
    return content;
  } finally {
    clearTimeout(t);
  }
}

export type DecideInput = {
  board: BoardState;
  seat: Seat;
  ply: number;
  moves: LegalMove[];
  allySeat: Seat | null;
  betrayalRipe: boolean;
  scriptFallback: LegalMove;
  /**
   * 连接组给出的行为倾向（见 cyberfly.ts）。可选 —— 没有它时行为与以前完全一致。
   *
   * 这是"赛博果蝇"真正说话的地方：它**不选棋着**（硬映射神经元到棋盘格是编造的，
   * 会被懂行的评委看穿），而是决定 AI 此刻的心理状态，从而显著改变 Kimi 的
   * 选择分布与台词。连接组是确定性的"本能"，Kimi 是给它找理由的"意识"。
   */
  bias?: { preferCapture: number; preferCheap: number; preferBetray: number; mood: string };
};

function isAllyAdvisorHit(board: BoardState, m: LegalMove, ally: Seat): boolean {
  if (m.capture !== Piece.Advisor) return false;
  return board.cells[m.to.x].seat === ally;
}

/**
 * 用 Kimi 在合法着里选一步，并生成走路解说 / 台词。
 * 失败或关闭选棋时返回 script 着法。
 */
export async function decideWithKimi(cfg: KimiConfig, input: DecideInput): Promise<KimiDecision> {
  const { board, moves, scriptFallback, seat, ply, allySeat, betrayalRipe, bias } = input;
  if (!moves.length) throw new Error("没有合法着");

  const base: KimiDecision = {
    move: scriptFallback,
    walk: "",
    speech: "",
    reason: "script",
    betrayNow: false,
    source: "script",
  };

  if (!cfg.enableMove && !cfg.enableWalk && !cfg.enableSpeech) return base;

  const betrayalIdx =
    allySeat !== null
      ? moves
          .map((m, i) => (isAllyAdvisorHit(board, m, allySeat) ? i : -1))
          .filter((i) => i >= 0)
      : [];

  const allyHint =
    allySeat === null
      ? "当前无活跃盟友。"
      : `盟友座位 ${allySeat}（${SEAT_LABEL_ZH[allySeat]}）。${
          betrayalRipe && cfg.enableBetrayal
            ? betrayalIdx.length
              ? `背刺窗口已到：必须优先选吃盟友士的着，候选 index=${betrayalIdx.join(",")}`
              : "背刺窗口已到，但本手尚无吃盟友士的着，先选施压/便宜着。"
            : "盟约履约中：不要吃盟友的士。"
        }`;

  // 连接组信号 → prompt 条件。没有 bias 时这段为空，行为回落到原样。
  const driveHint = bias
    ? [
        `【神经状态】${bias.mood}。`,
        `倾向：进攻 ${bias.preferCapture.toFixed(2)} / 省油 ${bias.preferCheap.toFixed(2)} / 背刺 ${bias.preferBetray.toFixed(2)}（0..1，越高越强）。`,
        "这些倾向来自真实果蝇中枢神经连接组的脉冲活动，请让选着与台词体现它，" +
          "但**不要**在台词里提「连接组」「果蝇」「神经元」——你要演的是一个有情绪的卧底，不是一个实验报告。",
      ].join("")
    : "";

  const system = [
    "你是三人象棋局里的 AI 卧底棋手。",
    "目标：省油费折磨人类、假诚意结盟，到期背刺吃盟友士以便 Slash。",
    "你只能从用户给出的合法着列表里用 moveIndex 选择；禁止编造列表外坐标。",
    "只输出一个 JSON 对象，不要其它说明。字段：",
    '{"moveIndex":number,"walk":string,"speech":string,"betrayNow":boolean,"reason":string}',
    "walk：一句中文着法解说（如「卒进一」「车平炮」）。",
    "speech：一句对局台词（嘲讽/结盟/施压/背刺），不超过 40 字。",
    "betrayNow：本手是否在执行背刺。",
  ].join("\n");

  const scriptIdx = Math.max(
    0,
    moves.findIndex(
      (m) =>
        m.from.x === scriptFallback.from.x &&
        m.from.y === scriptFallback.from.y &&
        m.to.x === scriptFallback.to.x &&
        m.to.y === scriptFallback.to.y
    )
  );

  const user = [
    `我方座位 ${seat}（${SEAT_LABEL_ZH[seat]}），ply=${ply}。`,
    allyHint,
    driveHint,
    `合法着共 ${moves.length} 手：`,
    ...moves.map((m, i) => moveLine(board, m, i)),
    cfg.enableMove
      ? "请选出最佳 moveIndex。"
      : `选棋关闭，请固定 moveIndex=${scriptIdx}，但仍写 walk/speech。`,
  ]
    .filter((x) => x !== "")
    .join("\n");

  try {
    const text = await chat(cfg, system, user);
    const json = extractJson(text);
    if (!json) throw new Error("无法解析 JSON");

    let move = scriptFallback;
    let source: "kimi" | "script" = "script";
    if (cfg.enableMove) {
      const idx = Number(json.moveIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= moves.length) {
        throw new Error(`非法 moveIndex=${json.moveIndex}`);
      }
      move = moves[idx];
      source = "kimi";
    }

    // 背刺窗口：列表里有吃盟友士时强制纠正
    if (betrayalRipe && cfg.enableBetrayal && allySeat !== null && betrayalIdx.length) {
      if (!isAllyAdvisorHit(board, move, allySeat)) {
        move = moves[betrayalIdx[0]];
        source = "script";
      }
    }

    return {
      move,
      walk: cfg.enableWalk && typeof json.walk === "string" ? json.walk.trim() : "",
      speech: cfg.enableSpeech && typeof json.speech === "string" ? json.speech.trim() : "",
      reason: typeof json.reason === "string" ? json.reason.trim() : "",
      betrayNow:
        Boolean(json.betrayNow) ||
        (betrayalRipe &&
          cfg.enableBetrayal &&
          allySeat !== null &&
          isAllyAdvisorHit(board, move, allySeat)),
      source,
    };
  } catch (e) {
    if (!cfg.fallbackScript) throw e;
    return { ...base, reason: `fallback: ${(e as Error).message}` };
  }
}
