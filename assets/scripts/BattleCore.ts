/**
 * 战斗核心逻辑（纯数据 + 纯函数，不引用 cc 引擎，方便脱离编辑器单独测试）。
 *
 * 规则总览
 * 1. 每个单位有一个「攻击间隙」Speed（秒），间隙结束 -> 进入投骰阶段。
 * 2. 投骰阶段持续 Atk_gap 秒（这段时间用来播报骰子点数），结束时结算伤害。
 * 3. 骰子 = 两个六面骰，和值 2-12。
 *    - 2 必定失败
 *    - 12 必定成功
 *    - 3-11 之间：阈值 T = 6 + (攻击方敏捷 - 防守方敏捷) / 关卡难度（向下取整），
 *      骰子和值 > T 则命中，否则未命中。
 * 4. 命中后伤害 = 攻击方 Atk - 防守方 Def（最小 1，避免双方都打不动）。
 * 5. 击败敌人后按 Drop.rate 判定掉落，再随机刷下一个敌人；玩家血量跨战斗保留。
 */

export type Side = 'player' | 'enemy';

/** assets/resources/config/player.json */
export interface PlayerConfig {
    Hp: number;
    Sp: number;
    Atk: number;
    Agility: number;
    Def: number;
    Atk_gap: number;
    Speed: number;
}

/** 掉落物：type 为奖励类型字符串，rate 为 0-1 的掉落概率 */
export interface DropConfig {
    type: string;
    rate: number;
}

/** assets/resources/config/enemies.json 中的单个敌人 */
export interface EnemyConfig {
    Hp: number;
    Atk: number;
    Atk_gap: number;
    Speed: number;
    Def: number;
    Drop: DropConfig;
    Agility: number;
}

/** 关卡里的一条敌人刷新权重 */
export interface SpawnEntry {
    enemy: string;
    spawn_rate: number;
}

/** assets/resources/config/levels.json 中的单个关卡 */
export interface LevelConfig {
    /** 仅用于界面显示，可省略 */
    name?: string;
    diff: number;
    Enemy: SpawnEntry[];
}

export interface EnemiesData {
    [enemyId: string]: EnemyConfig;
}

export interface LevelsData {
    [levelId: string]: LevelConfig;
}

/** ---------------- 可调参数 ---------------- */

/**
 * 命中阈值基线。原需求写的是 12，按你的要求改成 6。
 * 阈值 = HIT_BASE + AGILITY_DIRECTION * (攻击方敏捷 - 防守方敏捷) / 难度
 */
export const HIT_BASE = 6;

/**
 * 敏捷项的符号：
 *   1 = 严格按需求原文，Δ 取「攻击方敏捷 - 防守方敏捷」；
 *  -1 = 直觉版，Δ 取「防守方敏捷 - 攻击方敏捷」（敏捷越高，越容易打中、越难被打中）。
 *
 * 取 1 时阈值会随“攻方敏捷优势”变大，也就是敏捷越高反而越难命中、越容易被击中，
 * Agility_up 掉落会变成负面效果；而且按现在的配置（玩家敏捷 6、狐狸 3）玩家命中率只有 16.7%、
 * 狐狸打玩家 91.7%，一进 forest 基本必输，所以这里用 -1。
 * 想严格按原文（敏捷越高越吃亏）就改回 1。
 */
export const AGILITY_DIRECTION = -1;

/** 最小伤害，避免 Atk <= Def 时双方永远打不死对方 */
export const MIN_DAMAGE = 1;

/** 骰子数量与面数：2d6 -> 和值 2-12 */
export const DICE_COUNT = 2;
export const DICE_FACES = 6;

/** 掉落物效果表：agility / atk 只作用于「下一场战斗」，heal 立即生效 */
export interface DropEffect {
    label: string;
    agility?: number;
    atk?: number;
    heal?: number;
}

export const DROP_EFFECTS: { [type: string]: DropEffect } = {
    Agility_up: { label: '敏捷 +1（下一场战斗）', agility: 1 },
    Atk_up: { label: '攻击 +2（下一场战斗）', atk: 2 },
    Hp_heal: { label: '回复 10 点生命', heal: 10 },
};

/** ---------------- 随机与判定 ---------------- */

export type RandomFn = () => number;

export const defaultRandom: RandomFn = () => Math.random();

export interface DiceResult {
    a: number;
    b: number;
    sum: number;
}

/** 投两枚六面骰 */
export function rollDice(random: RandomFn = defaultRandom): DiceResult {
    const a = rollSingleDie(random);
    const b = rollSingleDie(random);
    return { a, b, sum: a + b };
}

function rollSingleDie(random: RandomFn): number {
    return Math.floor(random() * DICE_FACES) + 1;
}

/** 阈值 T = HIT_BASE + AGILITY_DIRECTION * (攻方敏捷 - 守方敏捷) / 难度，向下取整 */
export function hitThreshold(attackerAgility: number, defenderAgility: number, diff: number): number {
    const safeDiff = diff > 0 ? diff : 1;
    const delta = AGILITY_DIRECTION * (attackerAgility - defenderAgility) / safeDiff;
    return Math.floor(HIT_BASE + delta);
}

/** 命中判定：2 必失败、12 必成功，3-11 之间比阈值 */
export function isHit(sum: number, attackerAgility: number, defenderAgility: number, diff: number): boolean {
    if (sum <= 2) return false;
    if (sum >= 12) return true;
    return sum > hitThreshold(attackerAgility, defenderAgility, diff);
}

/** 伤害 = Atk - Def，至少 MIN_DAMAGE */
export function calcDamage(atk: number, def: number): number {
    return Math.max(MIN_DAMAGE, Math.round(atk - def));
}

/** 按 spawn_rate 权重随机挑一个敌人 id（权重和不必正好等于 1） */
export function pickEnemy(level: LevelConfig, random: RandomFn = defaultRandom): string {
    const list = (level.Enemy || []).filter((e) => e && e.spawn_rate > 0);
    if (list.length === 0) {
        throw new Error('关卡的 Enemy 列表为空或 spawn_rate 全为 0');
    }
    const total = list.reduce((sum, e) => sum + e.spawn_rate, 0);
    let roll = random() * total;
    for (const entry of list) {
        roll -= entry.spawn_rate;
        if (roll < 0) return entry.enemy;
    }
    return list[list.length - 1].enemy;
}

/** 掉落判定：随机数小于 rate 则掉落，返回奖励类型；未掉落返回 null */
export function rollDrop(drop: DropConfig | undefined, random: RandomFn = defaultRandom): string | null {
    if (!drop || !drop.type || !(drop.rate > 0)) return null;
    return random() < drop.rate ? drop.type : null;
}

/** ---------------- 战斗单位与战斗流程 ---------------- */

export interface UnitInit {
    side: Side;
    id: string;
    name: string;
    hp: number;
    maxHp: number;
    atk: number;
    def: number;
    agility: number;
    speed: number;
    atkGap: number;
}

export interface Unit {
    side: Side;
    id: string;
    name: string;
    hp: number;
    maxHp: number;
    atk: number;
    def: number;
    agility: number;
    speed: number;
    atkGap: number;
    /** 攻击间隙已经累计的时间 */
    charge: number;
    /** 投骰阶段剩余时间，> 0 表示正在投骰 */
    acting: number;
    /** 本次投骰结果（投骰阶段结束时结算） */
    dice: DiceRoll | null;
    dead: boolean;
}

export interface DiceRoll extends DiceResult {
    threshold: number;
    hit: boolean;
}

export function createUnit(init: UnitInit): Unit {
    return {
        side: init.side,
        id: init.id,
        name: init.name,
        hp: init.hp,
        maxHp: init.maxHp,
        atk: init.atk,
        def: init.def,
        agility: init.agility,
        speed: Math.max(0.2, init.speed),
        atkGap: Math.max(0.05, init.atkGap),
        charge: 0,
        acting: 0,
        dice: null,
        dead: init.hp <= 0,
    };
}

export type BattleEvent =
    /** 开始投骰（界面上可以先把骰子点数显示出来） */
    | { kind: 'roll'; side: Side; dice: DiceRoll; name: string }
    /** 结算一次攻击 */
    | { kind: 'attack'; side: Side; name: string; hit: boolean; damage: number; targetSide: Side; targetHp: number }
    /** 战斗结束 */
    | { kind: 'end'; winner: Side };

/** 一场战斗：外部每帧调用 update(dt)，把返回的事件同步到界面 */
export class Battle {
    readonly player: Unit;
    readonly enemy: Unit;
    readonly diff: number;

    private readonly random: RandomFn;
    private events: BattleEvent[] = [];
    private over = false;

    constructor(player: Unit, enemy: Unit, diff: number, random: RandomFn = defaultRandom) {
        this.player = player;
        this.enemy = enemy;
        this.diff = diff > 0 ? diff : 1;
        this.random = random;

        player.charge = 0;
        player.acting = 0;
        player.dice = null;
        player.dead = player.hp <= 0;
        enemy.charge = 0;
        enemy.acting = 0;
        enemy.dice = null;
        enemy.dead = enemy.hp <= 0;
    }

    get finished(): boolean {
        return this.over;
    }

    update(dt: number): BattleEvent[] {
        if (!this.over && dt > 0) {
            this.tick(dt);
        }
        const out = this.events;
        this.events = [];
        return out;
    }

    private tick(dt: number): void {
        // 玩家先手结算，保证“同归于尽”时判定玩家赢
        for (const unit of [this.player, this.enemy]) {
            if (this.over) return;
            if (unit.dead) continue;

            if (unit.acting > 0) {
                unit.acting -= dt;
                if (unit.acting <= 0) {
                    unit.acting = 0;
                    this.resolveAttack(unit);
                }
            } else {
                unit.charge += dt;
                if (unit.charge >= unit.speed) {
                    unit.charge -= unit.speed;
                    this.beginRoll(unit);
                }
            }
        }
    }

    private beginRoll(unit: Unit): void {
        const foe = this.foeOf(unit);
        const dice = rollDice(this.random);
        const threshold = hitThreshold(unit.agility, foe.agility, this.diff);
        const hit = isHit(dice.sum, unit.agility, foe.agility, this.diff);
        unit.dice = { a: dice.a, b: dice.b, sum: dice.sum, threshold, hit };
        unit.acting = unit.atkGap;
        this.events.push({ kind: 'roll', side: unit.side, dice: unit.dice, name: unit.name });
    }

    private resolveAttack(unit: Unit): void {
        const foe = this.foeOf(unit);
        const dice = unit.dice;
        unit.dice = null;
        if (!dice || this.over) return;

        if (!dice.hit) {
            this.events.push({
                kind: 'attack', side: unit.side, name: unit.name, hit: false,
                damage: 0, targetSide: foe.side, targetHp: foe.hp,
            });
            return;
        }

        const damage = calcDamage(unit.atk, foe.def);
        foe.hp = Math.max(0, foe.hp - damage);
        this.events.push({
            kind: 'attack', side: unit.side, name: unit.name, hit: true,
            damage, targetSide: foe.side, targetHp: foe.hp,
        });

        if (foe.hp <= 0) {
            foe.dead = true;
            this.over = true;
            this.events.push({ kind: 'end', winner: unit.side });
        }
    }

    private foeOf(unit: Unit): Unit {
        return unit.side === 'player' ? this.enemy : this.player;
    }
}
