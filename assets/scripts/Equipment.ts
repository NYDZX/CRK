import { sys } from 'cc';

/** 装备槽：武器 / 护甲 */
export type EquipSlot = 'weapon' | 'armor';

/** assets/resources/config/equipments.json 里的单件装备 */
export interface EquipmentConfig {
    name: string;
    slot: EquipSlot;
    Atk?: number;
    Def?: number;
    Agility?: number;
}

export interface EquipmentsData {
    [equipId: string]: EquipmentConfig;
}

/** 玩家的装备状态：背包 + 两个槽位（BOSS 掉落永久保存在这里） */
export interface EquipmentState {
    inventory: string[];
    weapon: string | null;
    armor: string | null;
}

/** 装备提供的属性加成（战斗开始时结算） */
export interface EquipBonus {
    atk: number;
    def: number;
    agility: number;
}

export const SLOT_LABEL: { [slot: string]: string } = {
    weapon: '武器',
    armor: '护甲',
};

const STORAGE_KEY = 'crk_equipment_v1';

export function createEmptyState(): EquipmentState {
    return { inventory: [], weapon: null, armor: null };
}

/** 读存档（BOSS 掉落“永久保存”，存在 localStorage 里，重开游戏也还在） */
export function loadEquipmentState(): EquipmentState {
    try {
        const raw = sys.localStorage.getItem(STORAGE_KEY);
        if (!raw) return createEmptyState();
        const parsed = JSON.parse(raw) as Partial<EquipmentState>;
        const inventory = Array.isArray(parsed.inventory)
            ? parsed.inventory.filter((id): id is string => typeof id === 'string')
            : [];
        return {
            inventory,
            weapon: typeof parsed.weapon === 'string' ? parsed.weapon : null,
            armor: typeof parsed.armor === 'string' ? parsed.armor : null,
        };
    } catch (err) {
        console.warn('[Equipment] 读取本地存档失败，按空背包处理', err);
        return createEmptyState();
    }
}

export function saveEquipmentState(state: EquipmentState): void {
    try {
        sys.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
        console.warn('[Equipment] 写入本地存档失败', err);
    }
}

/** 获得一件装备（已拥有则不重复加），返回新状态 */
export function ownEquipment(state: EquipmentState, id: string): EquipmentState {
    if (state.inventory.indexOf(id) >= 0) return state;
    return { ...state, inventory: state.inventory.concat([id]) };
}

export function hasEquipment(state: EquipmentState, id: string): boolean {
    return state.inventory.indexOf(id) >= 0;
}

/** 某槽位下拥有的装备 id 列表 */
export function ownedForSlot(state: EquipmentState, data: EquipmentsData, slot: EquipSlot): string[] {
    return state.inventory.filter((id) => {
        const cfg = data[id];
        return !!cfg && cfg.slot === slot;
    });
}

/** 装上某件装备（自动进对应槽位），返回新状态 */
export function equipItem(state: EquipmentState, data: EquipmentsData, id: string): EquipmentState {
    const cfg = data[id];
    if (!cfg) return state;
    const next: EquipmentState = { ...state, inventory: state.inventory };
    if (cfg.slot === 'weapon') next.weapon = id;
    else next.armor = id;
    return next;
}

/** 卸下某个槽位 */
export function unequipSlot(state: EquipmentState, slot: EquipSlot): EquipmentState {
    const next: EquipmentState = { ...state, inventory: state.inventory };
    if (slot === 'weapon') next.weapon = null;
    else next.armor = null;
    return next;
}

export function equippedId(state: EquipmentState, slot: EquipSlot): string | null {
    return slot === 'weapon' ? state.weapon : state.armor;
}

export function equipmentName(data: EquipmentsData, id: string | null): string {
    if (!id) return '';
    const cfg = data[id];
    return cfg ? cfg.name : id;
}

/** 装备属性文案，例如「攻击 +4」「防御 +2  敏捷 +1」 */
export function equipmentSummary(cfg: EquipmentConfig | undefined): string {
    if (!cfg) return '';
    const parts: string[] = [];
    if (cfg.Atk) parts.push(`攻击 +${cfg.Atk}`);
    if (cfg.Def) parts.push(`防御 +${cfg.Def}`);
    if (cfg.Agility) parts.push(`敏捷 +${cfg.Agility}`);
    return parts.join('   ');
}

/** 当前两个槽位提供的属性加成（战斗开始时用） */
export function calcEquipBonus(state: EquipmentState, data: EquipmentsData): EquipBonus {
    const bonus: EquipBonus = { atk: 0, def: 0, agility: 0 };
    for (const id of [state.weapon, state.armor]) {
        if (!id) continue;
        const cfg = data[id];
        if (!cfg) continue;
        bonus.atk += cfg.Atk || 0;
        bonus.def += cfg.Def || 0;
        bonus.agility += cfg.Agility || 0;
    }
    return bonus;
}
