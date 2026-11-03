import { sys } from 'cc';

/**
 * 经济系统：金币、复活、负债利息、金币掉落倍率。
 * 纯计算函数都能脱离 cc 用（只有读写存档用到 sys.localStorage）。
 */

/** 每次被击败复活要扣的金币（扣成负数就进入负债） */
export const REVIVE_GOLD_COST = 80;

/** 负债利息：每分钟扣「当前负债额」的 5% */
export const DEBT_INTEREST_RATE = 0.05;

/** 复活血量下限：hp_origin / 5（也就是 a 最多算到 5） */
export const REVIVE_MIN_RATIO = 1 / 5;

/** 金币存档 key */
const GOLD_KEY = 'crk_gold_v1';

/** 读金币存档（BOSS/敌人掉的金币永久保存） */
export function loadGold(): number {
    try {
        const raw = sys.localStorage.getItem(GOLD_KEY);
        if (!raw) return 0;
        const value = Number(raw);
        return Number.isFinite(value) ? Math.round(value) : 0;
    } catch (err) {
        console.warn('[Economy] 读取金币失败，按 0 处理', err);
        return 0;
    }
}

export function saveGold(gold: number): void {
    try {
        sys.localStorage.setItem(GOLD_KEY, String(Math.round(gold)));
    } catch (err) {
        console.warn('[Economy] 写入金币失败', err);
    }
}

/**
 * 第 deaths 次死亡后的复活血量：
 *   hp_revive = hp_origin / a      （a = 死亡次数，第一次死亡 a = 1）
 *   当 hp_revive < hp_origin / 5 时把 a 固定住（也就是最多算到 a = 5，复活血量不低于 20%）
 */
export function reviveHp(maxHp: number, deaths: number): number {
    const a = Math.max(1, Math.floor(deaths));
    const cappedA = Math.min(a, Math.round(1 / REVIVE_MIN_RATIO));
    return Math.max(1, Math.round(maxHp / cappedA));
}

/** 金币掉落倍率：sqrt(ln(a) + 1)，a = 死亡次数（a < 1 时按 1 算，倍率 = 1） */
export function goldMultiplier(deaths: number): number {
    const a = Math.max(1, Math.floor(deaths));
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
