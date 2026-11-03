import { sys } from 'cc';
import { MAX_SLOTS, STRATEGIES } from './Strategies';

/**
 * 玩家养成进度：等级 / 经验 / 已获得的策略 / 策略槽。
 * 和金币、装备一样存在 localStorage（永久保存）。
 */
export interface PlayerProgress {
    level: number;
    exp: number;
    /** 已获得的策略 id（每 5 级随机给一个，不会重复给） */
    owned: string[];
    /** 策略槽：长度固定 MAX_SLOTS，装的是策略 id 或 null */
    slots: Array<string | null>;
}

const STORAGE_KEY = 'crk_progress_v1';

/** 升级经验曲线：E(n) = EXP_BASE * n^EXP_POWER，n = 当前等级（1 级升 2 级 = 100） */
export const EXP_BASE = 100;
export const EXP_POWER = 1.5;

export function expToNext(level: number): number {
    return Math.round(EXP_BASE * Math.pow(Math.max(1, level), EXP_POWER));
}

/** 每升 4 级攻击 +1 */
export function levelAtkBonus(level: number): number {
    return Math.floor(Math.max(0, level) / 4);
}

/** 每升 6 级防御 +1 */
export function levelDefBonus(level: number): number {
    return Math.floor(Math.max(0, level) / 6);
}

export function createProgress(): PlayerProgress {
    return { level: 1, exp: 0, owned: [], slots: new Array(MAX_SLOTS).fill(null) };
}

function sanitize(raw: Partial<PlayerProgress> | null): PlayerProgress {
    const base = createProgress();
    if (!raw || typeof raw !== 'object') return base;
    const level = typeof raw.level === 'number' && raw.level >= 1 ? Math.floor(raw.level) : 1;
    const exp = typeof raw.exp === 'number' && raw.exp >= 0 ? Math.floor(raw.exp) : 0;
    const owned = Array.isArray(raw.owned) ? raw.owned.filter((id): id is string => typeof id === 'string') : [];
    const slots: Array<string | null> = new Array(MAX_SLOTS).fill(null);
    if (Array.isArray(raw.slots)) {
        for (let i = 0; i < MAX_SLOTS && i < raw.slots.length; i += 1) {
            const v = raw.slots[i];
            slots[i] = typeof v === 'string' && owned.indexOf(v) >= 0 ? v : null;
        }
    }
    return { level, exp, owned, slots };
}

export function loadProgress(): PlayerProgress {
    try {
        const raw = sys.localStorage.getItem(STORAGE_KEY);
        if (!raw) return createProgress();
        return sanitize(JSON.parse(raw) as Partial<PlayerProgress>);
    } catch (err) {
        console.warn('[Progress] 读取等级存档失败，按 1 级处理', err);
        return createProgress();
    }
}

export function saveProgress(progress: PlayerProgress): void {
    try {
        sys.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch (err) {
        console.warn('[Progress] 写入等级存档失败', err);
    }
}

/** 随机挑一条还没拥有的策略；全部拥有就返回 null */
export function pickNewStrategy(owned: string[], random: () => number): string | null {
    const pool = STRATEGIES.map((s) => s.id).filter((id) => owned.indexOf(id) < 0);
    if (pool.length === 0) return null;
    return pool[Math.floor(random() * pool.length) % pool.length];
}

export interface GainExpResult {
    levelsUp: number;
    /** 这次升级新拿到的策略 id */
    newStrategies: string[];
    /** 当前等级距离下一级还差多少（方便界面显示） */
    nextNeed: number;
}

/** 加经验并按 4 级攻击 / 6 级防御 / 5 级策略发奖励（原地修改 progress） */
export function gainExp(progress: PlayerProgress, amount: number, random: () => number): GainExpResult {
    const result: GainExpResult = { levelsUp: 0, newStrategies: [], nextNeed: expToNext(progress.level) };
    if (!(amount > 0)) return result;

    progress.exp += Math.round(amount);
    let guard = 0;
    while (progress.exp >= expToNext(progress.level) && guard < 10000) {
        progress.exp -= expToNext(progress.level);
        progress.level += 1;
        result.levelsUp += 1;
        guard += 1;
        if (progress.level % 5 === 0) {
            const id = pickNewStrategy(progress.owned, random);
            if (id) {
                progress.owned.push(id);
                result.newStrategies.push(id);
            }
        }
    }
    result.nextNeed = expToNext(progress.level);
    return result;
}
