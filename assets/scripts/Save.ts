import { sys } from 'cc';

/**
 * 存档槽位系统：一共 3 个槽，每个槽独立保存 金币 / 装备 / 等级经验策略。
 * 具体的数据格式由 Economy / Equipment / Progress 各自负责，这里只管「用哪个槽」和槽的概览。
 *
 * 存储 key 形如 crk_slot1_gold / crk_slot1_equipment / crk_slot1_progress，
 * 另外用 crk_current_slot_v1 记住上次选的槽位。
 */

/** 存档槽数量 */
export const SLOT_COUNT = 3;

/** 新存档的初始金币 */
export const START_GOLD = 100;

const CURRENT_KEY = 'crk_current_slot_v1';

/** 老版本（没有槽位时）用的 key，用来把旧进度搬进 1 号存档 */
const LEGACY_KEYS: { [name: string]: string } = {
    gold: 'crk_gold_v1',
    equipment: 'crk_equipment_v1',
    progress: 'crk_progress_v1',
};

let activeSlot = 1;

export function getActiveSlot(): number {
    return activeSlot;
}

export function setActiveSlot(index: number): void {
    const next = Math.min(Math.max(1, Math.floor(index)), SLOT_COUNT);
    activeSlot = next;
    try {
        sys.localStorage.setItem(CURRENT_KEY, String(next));
    } catch (err) {
        console.warn('[Save] 写入当前槽位失败', err);
    }
}

/** 读上次用的槽位（没存过就是 1） */
export function loadActiveSlot(): number {
    try {
        const raw = sys.localStorage.getItem(CURRENT_KEY);
        const value = raw === null ? 1 : Number(raw);
        if (!Number.isFinite(value)) return 1;
        return Math.min(Math.max(1, Math.floor(value)), SLOT_COUNT);
    } catch (err) {
        console.warn('[Save] 读取当前槽位失败', err);
        return 1;
    }
}

/** 某个槽位里某类数据的 key（默认当前槽） */
export function slotKey(name: string, index: number = activeSlot): string {
    const slot = Math.min(Math.max(1, Math.floor(index)), SLOT_COUNT);
    return `crk_slot${slot}_${name}`;
}

export interface SlotInfo {
    index: number;
    /** 这个槽是不是已经有存档数据 */
    exists: boolean;
    gold: number;
    level: number;
    exp: number;
    /** 已装备的策略数量 */
    strategies: number;
}

/** 读某个槽位的概览（界面上列出 3 个存档时用） */
export function readSlot(index: number): SlotInfo {
    const info: SlotInfo = { index, exists: false, gold: 0, level: 1, exp: 0, strategies: 0 };
    try {
        const goldRaw = sys.localStorage.getItem(slotKey('gold', index));
        const progressRaw = sys.localStorage.getItem(slotKey('progress', index));
        if (goldRaw === null && progressRaw === null) return info;
        info.exists = true;
        info.gold = goldRaw === null ? START_GOLD : Number(goldRaw) || 0;
        if (progressRaw !== null) {
            const parsed = JSON.parse(progressRaw) as { level?: number; exp?: number; slots?: unknown[] };
            info.level = typeof parsed.level === 'number' ? Math.floor(parsed.level) : 1;
            info.exp = typeof parsed.exp === 'number' ? Math.floor(parsed.exp) : 0;
            info.strategies = Array.isArray(parsed.slots)
                ? parsed.slots.filter((id) => typeof id === 'string').length
                : 0;
        }
    } catch (err) {
        console.warn(`[Save] 读取存档 ${index} 失败`, err);
    }
    return info;
}

/** 清空某个槽位（重新开始） */
export function resetSlot(index: number): void {
    try {
        sys.localStorage.removeItem(slotKey('gold', index));
        sys.localStorage.removeItem(slotKey('equipment', index));
        sys.localStorage.removeItem(slotKey('progress', index));
        sys.localStorage.removeItem(slotKey('records', index));
    } catch (err) {
        console.warn(`[Save] 清空存档 ${index} 失败`, err);
    }
}

/**
 * 老版本（金币/装备/等级各存一个全局 key）的进度搬进 1 号存档。
 * 只在「1 号存档还是空的、而且确实有旧数据」时做一次。
 */
export function migrateLegacySave(): boolean {
    try {
        const hasSlot1 = sys.localStorage.getItem(slotKey('gold', 1)) !== null
            || sys.localStorage.getItem(slotKey('progress', 1)) !== null;
        if (hasSlot1) return false;
        let moved = false;
        for (const name of Object.keys(LEGACY_KEYS)) {
            const legacy = sys.localStorage.getItem(LEGACY_KEYS[name]);
            if (legacy === null) continue;
            sys.localStorage.setItem(slotKey(name, 1), legacy);
            moved = true;
        }
        if (moved) {
            sys.localStorage.setItem(CURRENT_KEY, '1');
            console.log('[Save] 已把旧存档迁移到 1 号槽位');
        }
        return moved;
    } catch (err) {
        console.warn('[Save] 迁移旧存档失败', err);
        return false;
    }
}
