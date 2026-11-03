import { sys } from 'cc';
import { START_GOLD, slotKey } from './Save';

/**
 * 经济系统：金币、复活、负债利息、金币掉落倍率。
 * 纯计算函数都能脱离 cc 用（只有读写存档用到 sys.localStorage）。
 */

/** 死亡惩罚基础比例：本局盈利 4.5%（最低 80）、本局亏损 5%（最低 100），每多死一次 +0.5% */
export const REVIVE_PROFIT_RATE = 0.045;
export const REVIVE_PROFIT_MIN = 80;
export const REVIVE_LOSS_RATE = 0.05;
export const REVIVE_LOSS_MIN = 100;
/** 每多死一次，惩罚比例 +0.5% */
export const REVIVE_RATE_STEP = 0.005;

/** 这一次死亡适用的比例：基础比例 + 之前死过的次数 × 0.5% */
export function deathPenaltyRate(profit: number, deathsBefore: number): number {
    const base = profit > 0 ? REVIVE_PROFIT_RATE : REVIVE_LOSS_RATE;
    return base + REVIVE_RATE_STEP * Math.max(0, Math.floor(deathsBefore));
}

/**
 * 一次死亡要扣的金币：
 *   本局盈亏 = 当前金币 - 进关时金币
 *   比例 = 盈利 4.5% / 亏损 5%，每多死一次再 +0.5%
 *   盈利 → max(80, 盈利 × 比例)
 *   亏损 → max(100, 亏损额 × 比例)
 */
export function deathPenalty(gold: number, goldAtLevelStart: number, deathsBefore = 0): number {
    const profit = gold - goldAtLevelStart;
    const rate = deathPenaltyRate(profit, deathsBefore);
    const min = profit > 0 ? REVIVE_PROFIT_MIN : REVIVE_LOSS_MIN;
    return Math.max(min, Math.round(Math.abs(profit) * rate));
}

/** 负债利息：每分钟扣「当前负债额」的 5% */
export const DEBT_INTEREST_RATE = 0.05;

/** 复活血量下限：hp_origin / 5（也就是 a 最多算到 5） */
export const REVIVE_MIN_RATIO = 1 / 5;

/** 一局内死亡超过这个次数后：金币倍率重新从 1 级开始算，复活血量固定 10% */
export const REVIVE_RESET_DEATHS = 15;

/** 死亡超过 15 次后的固定复活血量比例 */
export const LATE_REVIVE_RATIO = 0.1;

/** 金币存档 key */
const GOLD_KEY = 'crk_gold_v1';

/** 金币存档 key 跟着当前存档槽走，读不到数据时按新存档的 100 金币算 */
export function loadGold(): number {
    try {
        const raw = sys.localStorage.getItem(slotKey('gold'));
        if (raw === null) return START_GOLD;
        const value = Number(raw);
        return Number.isFinite(value) ? Math.round(value) : START_GOLD;
    } catch (err) {
        console.warn('[Economy] 读取金币失败，按 0 处理', err);
        return START_GOLD;
    }
}

export function saveGold(gold: number): void {
    try {
        sys.localStorage.setItem(slotKey('gold'), String(Math.round(gold)));
    } catch (err) {
        console.warn('[Economy] 写入金币失败', err);
    }
}

/**
 * 第 deaths 次死亡后的复活血量：
 *   hp_revive = hp_origin / a      （a = 死亡次数，第一次死亡 a = 1）
 *   当 hp_revive < hp_origin / 5 时把 a 固定住（也就是最多算到 a = 5，复活血量不低于 20%）
 *   一局内死亡超过 REVIVE_RESET_DEATHS 次之后，复活血量固定为 10%
 */
export function reviveHp(maxHp: number, deaths: number): number {
    const a = Math.max(1, Math.floor(deaths));
    if (a > REVIVE_RESET_DEATHS) return Math.max(1, Math.round(maxHp * LATE_REVIVE_RATIO));
    const cappedA = Math.min(a, Math.round(1 / REVIVE_MIN_RATIO));
    return Math.max(1, Math.round(maxHp / cappedA));
}

/** 倍率用的「有效死亡次数」：一局内死亡超过 15 次后重新从 1 开始数（倍率回到 1.0x 再往上涨） */
export function multiplierDeaths(deaths: number): number {
    const a = Math.max(1, Math.floor(deaths));
    return a > REVIVE_RESET_DEATHS ? a - REVIVE_RESET_DEATHS : a;
}

/** 金币掉落倍率：sqrt(ln(a) + 1)，a = 有效死亡次数（超过 15 次死亡后重新从 1 算） */
export function goldMultiplier(deaths: number): number {
    const a = multiplierDeaths(deaths);
    return Math.sqrt(Math.log(a) + 1);
}

/** 击败一个敌人实际掉落的金币 = 基础值 × 金币倍率（倍率由 BattleGame 按策略/死亡次数算好） */
export function goldDrop(baseGold: number, multiplier: number): number {
    if (!(baseGold > 0)) return 0;
    return Math.max(1, Math.round(baseGold * Math.max(0, multiplier)));
}

export function isInDebt(gold: number): boolean {
    return gold < 0;
}

/** 每分钟要扣的利息（不负债返回 0）；rate 默认 5%，策略「低利率」传 3.5% */
export function interestAmount(gold: number, rate: number = DEBT_INTEREST_RATE): number {
    if (gold >= 0) return 0;
    return Math.max(1, Math.round(-gold * rate));
}

/** 金币文案：120 / -80（负债） */
export function formatGold(gold: number): string {
    return gold < 0 ? `-${Math.abs(gold)}` : String(gold);
}
