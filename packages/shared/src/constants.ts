/** FINAL PRD §4.2 frozen defaults (wei, 18 decimals, MON mock) */
export const SEAT_STAKE = 5n * 10n ** 16n; // 0.05 MON（与 GameTable.SEAT_STAKE 一致）
export const PLAY_BALANCE_INITIAL = 3n * 10n ** 17n; // 0.3 MON
export const MIN_PLAY_BALANCE_TO_START = 5n * 10n ** 16n; // 0.05 MON
export const MIN_AGENT_STAKE = 10n ** 18n;
export const FAUCET_PER_HUMAN = 32n * 10n ** 17n; // 3.2 MON
export const JOIN_VALUE = SEAT_STAKE + PLAY_BALANCE_INITIAL; // 0.35 MON

export const BASE_FEE = 10n ** 16n; // 0.010 MON
export const DIST_UNIT = 5n * 10n ** 15n; // 0.005 MON

export const EARNEST_BOND = 10n ** 17n; // 0.10 MON
export const BOND_PER_CLAUSE = 15n * 10n ** 16n; // 0.15 MON
export const EARNEST_TIMEOUT_SECS = 90;
export const EARNEST_TIMEOUT_PLIES = 3;
export const MAX_ACTIVE_COVENANTS_PER_SEAT = 1;

export const TIMEOUT_PENALTY = 3n * 10n ** 16n; // 0.03
export const ILLEGAL_REVEAL_PENALTY = 5n * 10n ** 16n; // 0.05
export const MAX_PLIES = 80;

export const POINT_TO_MON_RATE = 10n ** 15n; // 0.001 MON / Point
export const DEFEAT_STAKE_SHARE_BPS = 4000n; // 40%
export const CAPTIVE_POINT_LOSS_RATIO_BPS = 5000n; // 50%
export const CAPTURE_PENALTY_PER_POINT = 10n ** 15n; // 0.001 MON per point

export const MAIN_POOL_WINNER_BPS = 7000n;
export const MAIN_POOL_SECOND_BPS = 2000n;
export const MAIN_POOL_PROTOCOL_BPS = 1000n;

/** P1 deferred — constants only */
export const RUMOR_PRICE = 5n * 10n ** 16n;
export const ACCUSE_STAKE = 10n ** 17n;
export const ACCUSE_SLASH_ON_AI = 4n * 10n ** 17n;

/** @deprecated 旧 11×11；新地图用 NODE_COUNT */
export const BOARD_W = 11;
export const BOARD_H = 11;
/** 三人象棋落点数（与 sanrenMap 一致；卒线外角拆点后为 142） */
export const NODE_COUNT = 142;

export const CLAUSE_NO_CAPTURE_ADVISOR = 1;
export const CLAUSE_NO_EXPOSE_BEFORE_END = 2;
export const CLAUSE_MUTUAL_NON_CHECK = 3;

export const CLAUSE_BUY_PEACE = 4;
export const EXTRA_EARNEST_PREMIUM = 5n * 10n ** 16n; // 0.05 MON
export const WHALE_PLAY_BALANCE_THRESHOLD = 3n * 10n ** 18n;
export const BUY_PEACE_DEFAULT_PLIES = 8;
export const WHALE_PENDING_EARNEST = 3;
export const BASE_PENDING_EARNEST = 1;
