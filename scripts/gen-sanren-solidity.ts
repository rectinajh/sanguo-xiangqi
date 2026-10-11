/**
 * 从 packages/shared 地图生成 contracts/src/libraries/SanrenData.sol
 *
 * ⚠️ 为什么重写：
 * 旧版把「每个节点对」展开成 if 链 —— isAdj 258 分支、countBetween 约 1400 行、
 * lineSteps 约 950 行、horseOk 约 700 行，GameTable 编译到 **146 KB**，
 * 远超 EIP-170 的 24,576 B 运行时代码上限，在 anvil/真实链上直接部署失败
 * （max initcode size exceeded）。
 *
 * 现在改为紧凑常量表：
 *   - 邻接位图 139×139 bit
 *   - 每条线的节点列表
 *   - 节点→所属线集合（数量 + (线号,位次) 对）
 *     ⚠️ 必须保留**所有**候选线：本图每个节点同时属于 2~4 条线，
 *        只记一条会让 lineStep 在 929 处算错，进而让车/炮的合法性与费用全错。
 *   - 节点→营地 / 营地内 (f,r)
 *   - 九宫与本营成员位图
 *   - 马：稀疏排序表 + 二分查找（旧版是 139×139 稠密展开）
 *
 * 编码：Solidity 不接受大的 bytes 字面量（会被当成整数常量而报错），
 * 因此所有表按 bytes32 分块声明，运行时用 _table() 拼成内存 bytes。
 *
 * 生成后必须跑：
 *   pnpm gen:sanren && cd contracts && forge test && forge build --sizes
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SANREN_MAP } from "../packages/shared/src/sanrenMap.ts";
import { SANREN_GRAPH } from "../packages/shared/src/sanrenGraph.ts";
import { initialSanrenPieces } from "../packages/shared/src/sanrenSetup.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "contracts/src/libraries/SanrenData.sol");

const N = SANREN_MAP.nodes.length;
const adj = SANREN_GRAPH.adj;
const lines = SANREN_MAP.lines.filter((l) => l.nodes.length >= 2);
const setup = initialSanrenPieces();
const faces = SANREN_GRAPH.faces;

const MAX_LINE = Math.max(...lines.map((l) => l.nodes.length));
const EMPTY = 255;
const NL = String.fromCharCode(10);

/**
 * 字节数组 → bytecode 常量表。
 *
 * ⚠️ Solidity 不允许 `bytes32[N] constant`（"Only constants of value type and byte array
 *    type are implemented"），也不接受很长的 bytes 字面量（会被当成整数常量）。
 *    所以这里把每张表发射成「若干 bytes32 常量 + 一个拼接字面量」：
 *      TABLE_0, TABLE_1, … 是各 32 字节块；
 *      TABLE_ALL = 0x<全部字节> 是单个 bytes 字面量。
 *    取表时把 TABLE_ALL 拷进内存即可，编译器会自动折叠这些常量。
 */
function emitTable(
  name: string,
  bytes: number[],
  comment: string,
  idx: number
): { decl: string; offset: string; n: number; len: number; chunks: string[]; pad: number; coverUpTo: number } {
  // ⚠️ 奇数位十六进制字面量会被 Solidity 当成数字，并在最前面补一个 0，
  //    等于把整张表整体后移一个字节。这里显式在最前面补一个 0 字节并记录 pad，
  //    访问器再用 `idx += pad` 补偿回来。（这个坑曾导致偏移全错、查表 revert oob。）
  const pad = bytes.length % 2 === 1 ? 1 : 0;
  const paddedBytes = pad ? [0, ...bytes] : bytes.slice();

  const chunks: string[] = [];
  for (let i = 0; i < paddedBytes.length; i += 32) {
    const slice = paddedBytes.slice(i, i + 32);
    const filled = slice.concat(new Array(32 - slice.length).fill(0));
    chunks.push("0x" + filled.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join(""));
  }
  // 访问器需要覆盖到的最大下标（真实字节数，不含块内补齐）
  const coverUpTo = paddedBytes.length;
  // 硬断言：块数必须覆盖到 coverUpTo，否则访问器会在表内越界（历史 bug）
  if (chunks.length * 32 < coverUpTo) {
    throw new Error(`${name}: 块数 ${chunks.length} 不足以覆盖 ${coverUpTo} 字节`);
  }

  let decl = `    /// ${comment}（${bytes.length} 字节，pad=${pad}，${chunks.length} 块）` + NL;
  chunks.forEach((c, i) => {
    decl += `    bytes32 internal constant ${name}_${i} = ${c};` + NL;
  });
  const offset = `    uint256 internal constant OFF_${name} = ${idx};` + NL;
  return { decl, offset, n: chunks.length, len: bytes.length, chunks, pad, coverUpTo };
}

// ── 1. （邻接不再单独存表，由「同线」关系推导，见 isAdj）──

// ── 2. 每条线的节点列表 ───────────────────────────────────────
const lineNodes: number[] = [];
for (const line of lines) {
  for (let i = 0; i < MAX_LINE; i++) lineNodes.push(i < line.nodes.length ? line.nodes[i] : EMPTY);
}
const lineLen = lines.map((l) => l.nodes.length);

// ── 3. 节点 → 所属线集合（全部保留，按节点紧凑排列）───────────
const members: { li: number; ri: number }[][] = Array.from({ length: N }, () => []);
lines.forEach((line, li) => line.nodes.forEach((id, ri) => members[id].push({ li, ri })));

const memberCount = new Uint8Array(N);
for (let n = 0; n < N; n++) memberCount[n] = members[n].length;
const maxMembers = Math.max(...memberCount);

// 紧凑排列 + 累积偏移表（比定宽填充省空间，且偏移仍是 O(1) 查表）
const memberPairs: number[] = [];
const memberOffset = new Uint16Array(N + 1);
for (let n = 0; n < N; n++) {
  memberOffset[n] = memberPairs.length;
  for (const m of members[n]) memberPairs.push(m.li, m.ri);
}
memberOffset[N] = memberPairs.length;

// ── 4. 营地 / 营地内 (f, r) ───────────────────────────────────
const nodeCamp = new Uint8Array(N).fill(3);
for (const n of SANREN_MAP.nodes) nodeCamp[n.id] = n.camp;
const campF = new Uint8Array(N).fill(EMPTY);
const campR = new Uint8Array(N).fill(EMPTY);
for (const n of SANREN_MAP.nodes) {
  if (n.camp <= 2 && n.f >= 0) {
    campF[n.id] = n.f;
    campR[n.id] = n.r;
  }
}

// ── 5. 九宫 / 本营 成员位图 ───────────────────────────────────
const NBYTES = Math.ceil(N / 8);
const palaceBits = new Uint8Array(NBYTES * 3);
const campBits = new Uint8Array(NBYTES * 3);
const setBit = (buf: Uint8Array, plane: number, idx: number) => {
  buf[plane * NBYTES + (idx >> 3)] |= 1 << (idx & 7);
};
for (let c = 0; c < 3; c++) {
  for (const id of SANREN_GRAPH.palace[c]) setBit(palaceBits, c, id);
  for (const id of SANREN_GRAPH.campNodes[c]) setBit(campBits, c, id);
}

// ── 6. 马：稀疏排序表 ─────────────────────────────────────────
const horseMap = new Map<number, number>();
for (const face of faces) {
  for (const leg of face) {
    const neigh = face.filter((v) => v !== leg && adj[leg].includes(v));
    const opp = face.find((c) => c !== leg && !neigh.includes(c));
    if (opp === undefined) continue;
    for (const start of adj[leg]) {
      if (face.includes(start)) continue;
      horseMap.set(start * N + opp, leg + 1);
    }
  }
}
const horseKeys = [...horseMap.keys()].sort((a, b) => a - b);
const horseKeyBytes: number[] = [];
const horseLegBytes: number[] = [];
for (const k of horseKeys) {
  horseKeyBytes.push((k >> 8) & 0xff, k & 0xff);
  horseLegBytes.push(horseMap.get(k)!);
}
if (horseKeys.some((k) => k > 0xffff)) throw new Error("马表 key 超过 uint16");

// ── 7. 汇总所有表 ────────────────────────────────────────────
const TABLES: { name: string; bytes: number[]; comment: string }[] = [
  { name: "LINE_NODES", bytes: lineNodes, comment: "每条线的节点列表，每行 MAX_LINE 个" },
  { name: "LINE_LEN", bytes: lineLen, comment: "每条线的实际长度" },
  { name: "MEMBER_COUNT", bytes: Array.from(memberCount), comment: "每个节点所属的线数" },
  {
    name: "MEMBER_OFFSET",
    // ⚠️ 必须显式展开成「每个值 2 字节的大端」。
    //    以前这里写的是 Array.from(memberOffset) —— 那只是 140 个数字，
    //    等于把 uint16 表当成 140 字节，块数少了一半，访问器一旦越过 160 就 oob。
    bytes: (() => {
      const out: number[] = [];
      for (const v of memberOffset) out.push((v >> 8) & 0xff, v & 0xff);
      return out;
    })(),
    comment: "memberPairs 的每节点起始偏移（uint16 大端，140 个）",
  },
  { name: "MEMBER_PAIRS", bytes: memberPairs, comment: "节点所属 (线号,位次) 紧凑排列" },
  { name: "NODE_CAMP", bytes: Array.from(nodeCamp), comment: "节点所属营地" },
  { name: "CAMP_F", bytes: Array.from(campF), comment: "节点在本营的 f 坐标" },
  { name: "CAMP_R", bytes: Array.from(campR), comment: "节点在本营的 r 坐标" },
  { name: "PALACE_BITS", bytes: Array.from(palaceBits), comment: "九宫成员位图（三营地各一层）" },
  { name: "CAMP_BITS", bytes: Array.from(campBits), comment: "本营成员位图（三营地各一层）" },
  { name: "HORSE_KEY", bytes: horseKeyBytes, comment: "马着法 key（uint16 大端），升序" },
  { name: "HORSE_LEG", bytes: horseLegBytes, comment: "马着法对应的 leg+1" },
];
const emitted = TABLES.map((t, idx) => ({ ...t, ...emitTable(t.name, t.bytes, t.comment, idx) }));
const tableDecls = emitted.map((e) => e.decl).join("\n");
const tableOffsets = emitted.map((e) => e.offset).join("");
const tableCount = TABLES.length;
const tableChunkCounts = emitted.map((e) => e.n);
const maxChunks = Math.max(...tableChunkCounts);
const byteAccessors = emitted
  .map((e, i) => {
    const rows = e.chunks
      .map((c, k) => {
        // 第 k 块覆盖字节 [k*32, k*32+32)；块内第 (idx-k*32) 个字节在 uint256 的
        // 高位起第 idx-k*32 字节，也就是从右数第 31-(idx-k*32) 字节。
        const base = k * 32;
        // ⚠️ 这个数组曾经叫 rows，和外层累加器同名，导致只有最后一块被保留下来，
        //    表现为"表的第 2 块开始全是别的表的数据"。
        const blockRow =
          `            if (idx >= ${base} && idx < ${base + 32}) {` +
          NL +
          `                uint256 sh = (31 - (idx - ${base})) * 8;` +
          NL +
          `                return uint8(uint256(${c}) >> sh);` +
          NL +
          `            }`;
        return blockRow;
      })
      .join(NL);
    return `    /// @dev 读取 ${e.name} 的第 idx 个字节。pad=${e.pad} 用于抵消奇数位十六进制
    ///      字面量被 Solidity 补在最前面的那个 0 字节。
    function _${e.name.toLowerCase()}Byte(uint256 idx) private pure returns (uint8) {
        idx += ${e.pad};
${rows}
        revert("oob");
    }`;
  })
  .join(NL + NL);

// ── 8. 生成 ──────────────────────────────────────────────────
const solid = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice AUTO-GENERATED by scripts/gen-sanren-solidity.ts — do not edit by hand.
///
/// 紧凑常量表版。旧版把节点对展开成 if 链，让 GameTable 达到 146 KB
/// （EIP-170 上限 24,576 B）而无法部署；这里全部改为查表。
library SanrenData {
    uint8 internal constant NODE_COUNT = ${N};
    uint8 internal constant CAMP_NONE = 3;
    uint8 internal constant EMPTY_SLOT = 255;
    uint8 internal constant MAX_LINE = ${MAX_LINE};
    uint16 internal constant LINE_COUNT = ${lines.length};
    uint16 internal constant HORSE_COUNT = ${horseKeys.length};
    uint8 internal constant MAX_MEMBERS = ${maxMembers};

${tableDecls}
${tableOffsets}    uint256 internal constant TABLE_COUNT = ${tableCount};

    // ── 表读取 ────────────────────────────────────────────────
${byteAccessors}

    /// @dev 表里存的是 uint16 大端：低地址是高位。
    ///      （之前写成 (b[i] << 8) | b[i+1] 是错的 —— 那是按"低地址是低位"读，
    ///        会让偏移全部错位到远超表长，表现为查表 revert "oob"。）
    function _member_offsetU16(uint256 i) private pure returns (uint16) {
        return uint16(_member_offsetByte(i + 1)) | (uint16(_member_offsetByte(i)) << 8);
    }

    function _palace_bitsBit(uint256 i) private pure returns (bool) {
        return (_palace_bitsByte(i >> 3) & (1 << (i & 7))) != 0;
    }

    function _camp_bitsBit(uint256 i) private pure returns (bool) {
        return (_camp_bitsByte(i >> 3) & (1 << (i & 7))) != 0;
    }

    // ── 邻接 ──────────────────────────────────────────────────
    /// @dev 相邻 = 同一条线上且位次相差 1。
    ///      本图里"相邻"与"同线且位次相邻"等价（过渡区与中宫的连线也建成了线），
    ///      因此不再需要 139×139 的邻接位图，省下约 2.4 KB 常量和一次内存拷贝。
    function isAdj(uint8 x, uint8 y) internal pure returns (bool) {
        if (x >= NODE_COUNT || y >= NODE_COUNT) return false;
        (bool ok, , uint8 ra, uint8 rb) = sharedLine(x, y);
        if (!ok) return false;
        uint8 d = ra > rb ? ra - rb : rb - ra;
        return d == 1;
    }

    // ── 同线关系 ──────────────────────────────────────────────
    /// @notice 两点若在同一条线上，返回该线号与各自位次。
    /// @dev 必须遍历节点的**所有**候选线。本图每个节点同时属于 2~4 条线，
    ///      只看第一条会让 lineStep 在 929 个节点对上算错，从而让车/炮的
    ///      合法性与费用全错。
    function sharedLine(uint8 a, uint8 b)
        internal
        pure
        returns (bool ok, uint8 li, uint8 ra, uint8 rb)
    {
        if (a >= NODE_COUNT || b >= NODE_COUNT) return (false, 0, 0, 0);
        uint8 na = _member_countByte(a);
        uint8 nb = _member_countByte(b);
        uint256 offA = _member_offsetU16(uint256(a) * 2);
        uint256 offB = _member_offsetU16(uint256(b) * 2);
        for (uint8 i = 0; i < na; i++) {
            uint8 la = _member_pairsByte(offA + uint256(i) * 2);
            uint8 ra = _member_pairsByte(offA + uint256(i) * 2 + 1);
            for (uint8 j = 0; j < nb; j++) {
                uint8 lb = _member_pairsByte(offB + uint256(j) * 2);
                uint8 rb = _member_pairsByte(offB + uint256(j) * 2 + 1);
                if (la == lb && ra != rb) return (true, la, ra, rb);
            }
        }
        return (false, 0, 0, 0);
    }

    function lineStep(uint8 a, uint8 b) internal pure returns (uint8) {
        if (a == b) return 0;
        (bool ok, , uint8 ra, uint8 rb) = sharedLine(a, b);
        if (!ok) return 0;
        return ra > rb ? ra - rb : rb - ra;
    }

    /// @notice 同线上两点之间（不含端点）的棋子数；不在同线返回 -1。
    function countBetween(uint8 a, uint8 b, uint8[160] storage board) internal view returns (int8) {
        (bool ok, uint8 li, uint8 ra, uint8 rb) = sharedLine(a, b);
        if (!ok || ra == rb) return -1;
        uint8 lo = ra < rb ? ra : rb;
        uint8 hi = ra < rb ? rb : ra;
        uint8 n = 0;
        for (uint8 r = lo + 1; r < hi; r++) {
            uint8 node = _line_nodesByte(uint256(li) * MAX_LINE + r);
            if (node != EMPTY_SLOT && board[node] != 0) n++;
        }
        return int8(n);
    }

    // ── 营地 / 九宫 / 坐标 ────────────────────────────────────
    function inPalace(uint8 camp, uint8 node) internal pure returns (bool) {
        if (camp > 2 || node >= NODE_COUNT) return false;
        return _palace_bitsBit(uint256(camp) * NODE_COUNT + node);
    }

    function inCamp(uint8 camp, uint8 node) internal pure returns (bool) {
        if (camp > 2 || node >= NODE_COUNT) return false;
        return _camp_bitsBit(uint256(camp) * NODE_COUNT + node);
    }

    function nodeCampOf(uint8 node) internal pure returns (uint8) {
        if (node >= NODE_COUNT) return CAMP_NONE;
        return _node_campByte(node);
    }

    function localF(uint8 camp, uint8 node) internal pure returns (int16) {
        if (camp > 2 || node >= NODE_COUNT) return -1;
        uint8 v = _camp_fByte(node);
        return v == EMPTY_SLOT ? int16(-1) : int16(uint16(v));
    }

    function localR(uint8 camp, uint8 node) internal pure returns (int16) {
        if (camp > 2 || node >= NODE_COUNT) return -1;
        uint8 v = _camp_rByte(node);
        return v == EMPTY_SLOT ? int16(-1) : int16(uint16(v));
    }

    function gateOf(uint8 seat) internal pure returns (uint8) {
        if (seat == 0) return ${SANREN_GRAPH.gate[0]};
        if (seat == 1) return ${SANREN_GRAPH.gate[1]};
        return ${SANREN_GRAPH.gate[2]};
    }

    // ── 马 ────────────────────────────────────────────────────
    /// @notice 马的「日」字：返回马腿节点；0 表示不成着。
    function horseLegOf(uint8 from_, uint8 to_) internal pure returns (uint8) {
        if (from_ >= NODE_COUNT || to_ >= NODE_COUNT) return 0;
        uint32 key = uint32(from_) * NODE_COUNT + to_;
        uint32 lo = 0;
        uint32 hi = HORSE_COUNT;
        while (lo < hi) {
            uint32 mid = (lo + hi) / 2;
            uint16 k = uint16(
                (uint16(_horse_keyByte(uint256(mid) * 2)) << 8) | uint16(_horse_keyByte(uint256(mid) * 2 + 1))
            );
            if (k == key) return _horse_legByte(mid);
            if (k < key) lo = mid + 1;
            else hi = mid;
        }
        return 0;
    }

    function horseOk(uint8 from_, uint8 to_, uint8[160] storage board) internal view returns (bool) {
        uint8 legPlus1 = horseLegOf(from_, to_);
        if (legPlus1 == 0) return false;
        return board[legPlus1 - 1] == 0;
    }

    // ── 初始布局 ──────────────────────────────────────────────
    uint16 internal constant SETUP_COUNT = ${setup.length};

    function setupCount() internal pure returns (uint16) {
        return SETUP_COUNT;
    }

    function setupAt(uint16 i) internal pure returns (uint8 node, uint8 piece, uint8 seat) {
${setup
  .map((p, i) => `        if (i == ${i}) return (${p.node}, ${p.piece}, ${p.seat});`)
  .join("\n")}
        revert("setup");
    }
}
`;

writeFileSync(out, solid);
console.log(`Wrote ${out}`);
console.log(
  `  nodes=${N} lines=${lines.length} maxLine=${MAX_LINE} maxMembers=${maxMembers} setup=${setup.length}`
);
console.log(
  `  表字节数: ` + emitted.map((e) => `${e.name}=${e.bytes.length}`).join(" ")
);
