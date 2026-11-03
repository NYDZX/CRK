import { sys } from 'cc';
import { slotKey } from './Save';

/**
 * 关卡纪录：每个关卡「单局最高盈利」（本局金币 − 进关时金币）的最大值。
 * 跟着存档槽走（crk_slot1_records ...），只记正数，亏了不覆盖纪录。
 */
export interface LevelRecords {
    [levelId: string]: number;
}

function sanitize(raw: unknown): LevelRecords {
    const out: LevelRecords = {};
    if (!raw || typeof raw !== 'object') return out;
    const table = raw as { [key: string]: unknown };
    for (const key of Object.keys(table)) {
        const value = table[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            out[key] = Math.round(value);
        }
    }
    return out;
}

export function loadRecords(): LevelRecords {
    try {
        const raw = sys.localStorage.getItem(slotKey('records'));
        if (!raw) return {};
        return sanitize(JSON.parse(raw) as unknown);
    } catch (err) {
        console.warn('[Records] 读取关卡纪录失败，按空处理', err);
        return {};
    }
}

export function saveRecords(records: LevelRecords): void {
    try {
        sys.localStorage.setItem(slotKey('records'), JSON.stringify(records));
    } catch (err) {
        console.warn('[Records] 写入关卡纪录失败', err);
    }
}

/** 某关的最高盈利（没纪录返回 0） */
export function bestProfit(records: LevelRecords, levelId: string): number {
    return records[levelId] === undefined ? 0 : records[levelId];
}

/** 提交一次本局盈亏，只有刷出新纪录才返回 true */
export function submitProfit(records: LevelRecords, levelId: string, profit: number): boolean {
    const prev = bestProfit(records, levelId);
    const value = Math.round(profit);
    if (value <= prev) return false;
    records[levelId] = value;
    return true;
}
