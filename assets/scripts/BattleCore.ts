/**
 * 战斗核心逻辑（纯数据 + 纯函数，不依赖 cc 引擎，可脱离编辑器单独跑测试）。
 *
 * 一、玩家攻击：每 `Speed` 秒蓄力结束进入投骰阶段，`Atk_gap` 秒后结算。
 *     阈值 T = HIT_BASE + AGILITY_DIRECTION * (玩家敏捷 - 敌人敏捷) / 难度
 *     和为 2 必定失败、12 必定成功，3-11 之间「和值 > T」命中。
 *     命中伤害 = max(1, 玩家 Atk - 敌人 Def)。
 *
 * 二、玩家防御：每 `def_gap` 秒掷一次防御骰，用「玩家敏捷 vs 敌人 blockade」按同样的方式拼点。
 *     成功一次，本场战斗的防御值 += 玩家 Def。防御值相当于一个**护盾池**：
 *     一直保留在这场战斗里（换敌人才清空），敌人造成伤害时先扣它，扣完不够的部分才扣血。
 *
 * 三、敌人攻击：不再投骰，每 `Speed` 秒蓄力 + `Atk_gap` 秒出手后 100% 命中，打出 `敌人 Atk` 点伤害。
 *
 * 四、BOSS：关卡配置 `boss { enemy, a, b }`。进入关卡时、以及每次击败 BOSS 之后，
 *     在 [a, b] 之间随机一个 c；击败 c 个普通敌人后，下一个刷出来的就是 BOSS。
 */

export type Side = 'player' | 'enemy';

/** assets/resources/config/player.json */
export interface PlayerConfig {
    Hp: number;
    Sp: number;
    Atk: number;
    Agility: number;
    /** 每次防御骰成功时获得的防御值 */
    Def: number;
    /** 攻击间隙（秒） */
    Speed: number;
    /** 攻击骰的表现时间（秒） */
    Atk_gap: number;
    /** 防御间隙（秒）：每隔这么久掷一次防御骰 */
    def_gap: number;
}

/** 掉落物：type 为奖励类型字符串，rate 为 0-1 的掉落概率；BOSS 用 equip 指定装备 id */
export interface DropConfig {
    type: string;
    rate: number;
    equip?: string;
}

/**
 * BOSS 特殊规则（可选，目前只有城堡守卫用）。
 * 负数就是扣金币 / 降属性，未配置的项不生效。
 */
export interface EnemySpecial {
    /** 主角击中 BOSS 时给的金币 */
    goldOnHitPlayer?: number;
    /** 主角被 BOSS 打掉血时扣的金币（被完全格挡不算） */
    goldOnPlayerDamaged?: number;
    /** 主角击中 BOSS 后，主角「下一次攻击」的敏捷 -N */
    agilityDownOnHitPlayer?: number;    /** 主角完全格挡 BOSS 攻击后，BOSS 敏捷 -N */
    agilityDownOnFullBlock?: number;
    /** 主角完全格挡 BOSS 攻击后，BOSS blockade +N */
    blockadeUpOnFullBlock?: number;
}

/** assets/resources/config/enemies.json 中的单个敌人（BOSS 也是敌人） */
export interface EnemyConfig {
    Hp: number;
    Atk: number;
    Atk_gap: number;
    Speed: number;
    Def: number;
    /** 击败后掉落的基础金币（会乘上死亡次数倍率） */
    Gold: number;
    /** 经验倍率：击败它获得 ExpRate × 关卡基础经验 */
    ExpRate: number;
    Drop: DropConfig;
    Agility: number;
    /** 防御拼点用的“封锁”值：越高玩家越难防住 */
    blockade: number;
    /** BOSS 特殊规则（可选） */
    special?: EnemySpecial;
}

/** 关卡里的一条敌人刷新权重 */
export interface SpawnEntry {
    enemy: string;
    spawn_rate: number;
}

/** 关卡的 BOSS 配置 */
export interface BossConfig {
    /** BOSS 的敌人 id（同样配在 enemies.json 里） */
    enemy: string;
    /** 击败 [a, b] 个普通敌人后刷 BOSS */
    a: number;
    b: number;
}

/** assets/resources/config/levels.json 中的单个关卡 */
export interface LevelConfig {
    /** 仅用于界面显示，可省略 */
    name?: string;
    diff: number;
    /** 本关的基础经验值（击败敌人 / 死亡时按它结算） */
    Exp: number;
    Enemy: SpawnEntry[];
    boss?: BossConfig;
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
 * Agility_up 掉落会变成负面效果，所以这里用 -1。想严格按原文就改回 1。
 */
export const AGILITY_DIRECTION = -1;

/** 最小伤害，避免 Atk <= Def 时永远打不死对方 */
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

/**
 * 拼点成功概率：把 36 种骰子和值全部枚举一遍算概率
 * （界面上「攻击色子 / 防御色子」面板显示的百分比就是这个）
 */
export function hitChance(attackerAgility: number, defenderAgility: number, diff: number): number {
    let hit = 0;
    for (let a = 1; a <= DICE_FACES; a += 1) {
        for (let b = 1; b <= DICE_FACES; b += 1) {
            if (isHit(a + b, attackerAgility, defenderAgility, diff)) hit += 1;
        }
    }
    return hit / (DICE_FACES * DICE_FACES);
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

/** ---------------- BOSS 刷新进度 ---------------- */

export interface LevelProgress {
    /** 上一次 BOSS 之后击败的普通敌人数量 */
    normalKills: number;
    /** 击败多少个普通敌人后刷 BOSS */
    bossTarget: number;
    /** 下一个刷的敌人是不是 BOSS */
    bossPending: boolean;
}

/** 在 [a, b] 之间随机一个整数 c（a、b 顺序写反也能用） */
export function rollBossTarget(boss: BossConfig, random: RandomFn = defaultRandom): number {
    const low = Math.min(boss.a, boss.b);
    const high = Math.max(boss.a, boss.b);
    const span = Math.max(0, Math.floor(high) - Math.floor(low));
    return Math.floor(low) + Math.floor(random() * (span + 1));
}

/** 进入关卡 / 击败 BOSS 之后：重新掷一次「还要打几个普通敌人」 */
export function newLevelProgress(boss: BossConfig | undefined, random: RandomFn = defaultRandom): LevelProgress {
    return {
        normalKills: 0,
        bossTarget: boss ? rollBossTarget(boss, random) : 0,
        bossPending: false,
    };
}

/** 击败一个普通敌人后的进度 */
export function progressAfterNormalKill(progress: LevelProgress): LevelProgress {
    const normalKills = progress.normalKills + 1;
    return {
        normalKills,
        bossTarget: progress.bossTarget,
        bossPending: normalKills >= progress.bossTarget,
    };
}

/** 击败 BOSS 后的进度：重新掷 bossTarget、普通敌人计数清零 */
export function progressAfterBossKill(
    progress: LevelProgress,
    boss: BossConfig | undefined,
    random: RandomFn = defaultRandom,
): LevelProgress {
    const next = newLevelProgress(boss, random);
    return { ...next, bossPending: false };
}

/** 距离 BOSS 还要打几个普通敌人（界面上显示用） */
export function bossRemaining(progress: LevelProgress): number {
    return Math.max(0, progress.bossTarget - progress.normalKills);
}

/** ---------------- 战斗单位与战斗流程 ---------------- */

/** 已装备策略对战斗的影响开关（由 Strategies.buildEffects 生成） */
export interface StrategyEffects {
    fibDice: boolean;
    oddity: boolean;
    twoFace: boolean;
    swapAtkDef: boolean;
    thorns: boolean;
    trophy: boolean;
    suicide: boolean;
    lowInterest: boolean;
    agilityPlus: boolean;
    glassCannon: boolean;
}

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
    defGap?: number;
    blockade?: number;
    special?: EnemySpecial;
    effects?: StrategyEffects;
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
    /** 防御间隙（玩家用） */
    defGap: number;
    /** 防御拼点对手值（敌人用） */
    blockade: number;
    /** 攻击间隙已累计时间 */
    charge: number;
    /** 出手阶段剩余时间，> 0 表示正在出手 */
    acting: number;
    /** 本次攻击投骰结果（玩家用） */
    dice: DiceRoll | null;
    /** BOSS 特殊规则（只有部分敌人有） */
    special?: EnemySpecial;
    /** 已装备策略的效果开关（只有玩家有） */
    effects?: StrategyEffects;
    dead: boolean;
}

export interface DiceRoll extends DiceResult {
    threshold: number;
    hit: boolean;
    /** 伤害/防御倍率（二面骰子出最大值时 = 2） */
    multiplier?: number;
}

/** 一次投骰（含策略影响）的完整结果 */
export interface RollOutcome extends DiceRoll {
    /** 必定成功（奇数性：两个奇数） */
    forceHit: boolean;
    /** 投骰直接给的金币（奇数性 +100） */
    goldFlat: number;
    /** 按「本局盈利」百分比扣的金币（奇数性两个偶数 = -0.05） */
    goldProfitPercent: number;
    twoFaceMax: boolean;
    twoFaceMin: boolean;
}

/** 判断是不是斐波那契数（1、2、3、5、8…），策略「斐波那契」用 */
export function isFibonacci(value: number): boolean {
    if (!Number.isFinite(value) || value < 1) return false;
    let a = 1;
    let b = 1;
    while (b < value) {
        const next = a + b;
        a = b;
        b = next;
    }
    return b === value;
}

/**
 * 按已装备的策略投一次骰子。
 * 顺序：先投 2d6 → 二面骰子把每颗骰子锁成 1/6 → 斐波那契把每颗骰子锁成 2/3/5 → 奇数性做面值变换。
 */
export function rollByStrategy(
    effects: StrategyEffects | undefined,
    random: RandomFn = defaultRandom,
): RollOutcome {
    let a = 1 + Math.floor(random() * DICE_FACES);
    let b = 1 + Math.floor(random() * DICE_FACES);
    let twoFaceMax = false;
    let twoFaceMin = false;

    if (effects && effects.twoFace) {
        a = random() < 0.5 ? 1 : DICE_FACES;
        b = random() < 0.5 ? 1 : DICE_FACES;
        twoFaceMax = a === DICE_FACES && b === DICE_FACES;
        twoFaceMin = a === 1 && b === 1;
    }

    // 斐波那契：是「每颗骰子」只出斐波那契面值（不含 1，且小于骰子最大值 6 → 2/3/5），不是和值
    if (effects && effects.fibDice) {
        const fibFaces: number[] = [];
        for (let face = 2; face < DICE_FACES; face += 1) {
            if (isFibonacci(face)) fibFaces.push(face);
        }
        if (fibFaces.length > 0) {
            a = fibFaces[Math.floor(random() * fibFaces.length) % fibFaces.length];
            b = fibFaces[Math.floor(random() * fibFaces.length) % fibFaces.length];
        }
    }

    let forceHit = false;
    let goldFlat = 0;
    let goldProfitPercent = 0;
    let multiplier = 1;

    if (effects && effects.oddity) {
        const bothOdd = a % 2 === 1 && b % 2 === 1;
        const bothEven = a % 2 === 0 && b % 2 === 0;
        const isOneOne = a === 1 && b === 1;
        a = a % 2 === 1 ? a * 2 : 0;
        b = b % 2 === 1 ? b * 2 : 0;
        if (bothOdd && !isOneOne) {
            forceHit = true;
            goldFlat += 100;
        }
        if (bothEven) goldProfitPercent -= 0.05;
    }

    if (effects && effects.twoFace && twoFaceMax) {
        multiplier = 2;
    }

    return {
        a, b, sum: a + b, threshold: 0, hit: false,
        multiplier, forceHit, goldFlat, goldProfitPercent, twoFaceMax, twoFaceMin,
    };
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
        defGap: Math.max(0.2, init.defGap === undefined ? 2 : init.defGap),
        blockade: init.blockade === undefined ? 0 : init.blockade,
        charge: 0,
        acting: 0,
        dice: null,
        special: init.special,
        effects: init.effects,
        dead: init.hp <= 0,
    };
}

export type BattleEvent =
    /** 玩家开始投攻击骰（界面上先亮骰子点数） */
    | { kind: 'attackRoll'; dice: DiceRoll }
    /** 玩家攻击结算 */
    | { kind: 'attack'; hit: boolean; damage: number; enemyHp: number }
    /** 玩家防御骰结算；hit 为 true 时 defense 是新的防御值 */
    | { kind: 'defense'; dice: DiceRoll; hit: boolean; defense: number }
    /** 敌人开始出手（100% 命中，出手动画结束后结算） */
    | { kind: 'enemySwing' }
    /** 敌人造成伤害：absorbed 是被防御值吃掉的部分，damage 是实际掉的血 */
    | { kind: 'enemyHit'; damage: number; absorbed: number; defense: number; playerHp: number }
    /** 玩家被打倒：战斗暂停，等外部 revive() 复活后继续打同一个敌人 */
    | { kind: 'playerDown' }
    /** BOSS 特殊规则：金币变化（amount 正=获得，负=扣除；source 是触发原因） */
    | { kind: 'goldBonus'; amount: number; source: 'hit' | 'damaged' | 'dice' }
    /** 策略：按本局盈利百分比变化的金币（percent = -0.05 表示扣 5%） */
    | { kind: 'goldPercent'; percent: number }
    /** 策略「荆棘」：反弹伤害给敌人 */
    | { kind: 'thorns'; damage: number; enemyHp: number }
    /** BOSS 特殊规则：主角敏捷被削（当前值） */
    | { kind: 'playerAgilityDown'; agility: number }
    /** BOSS 特殊规则：主角完全格挡后 BOSS 被削弱 */
    | { kind: 'bossWeakened'; agility: number; blockade: number }
    /** 战斗结束 */
    | { kind: 'end'; winner: Side };

/** 一场战斗：外部每帧调用 update(dt)，把返回的事件同步到界面 */
export class Battle {
    readonly player: Unit;
    readonly enemy: Unit;
    readonly diff: number;

    /** 玩家在这场战斗里累积的防御值（护盾池：防御骰成功一次 +玩家 Def，被伤害扣掉，换敌人清空） */
    defense = 0;

    private readonly random: RandomFn;
    private events: BattleEvent[] = [];
    private over = false;
    /** 玩家已经倒下，正在等外部 revive() */
    private playerDown = false;
    /** 下一次攻击时主角敏捷要扣多少（BOSS 特殊规则，用掉就清零） */
    private pendingAgilityPenalty = 0;
    private defTimer = 0;
    private lastDefenseDice: DiceRoll | null = null;
    /** 二面骰子：攻/防各自的「连续最小值」计数与冷却倍率 */
    private atkStreak = 0;
    private defStreak = 0;
    private atkScale = 1;
    private defScale = 1;

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

    /** 玩家是否倒在地上等复活（外部算好血量后调 revive()） */
    get waitingRevive(): boolean {
        return this.playerDown;
    }

    /**
     * 复活：外部扣完金币、算好血量后调用，战斗继续打同一个敌人。
     * 防御值和敌人血量都不重置（还是同一场战斗）。
     */
    revive(hp: number): void {
        if (this.over) return;
        this.playerDown = false;
        this.player.hp = Math.max(1, Math.min(this.player.maxHp, Math.round(hp)));
        this.player.dead = false;
        this.player.acting = 0;
        this.player.charge = 0;
    }

    /** 防御骰计时进度 0-1（界面上显示用） */
    get defenseProgress(): number {
        const gap = this.player.defGap * this.defScale;
        return gap > 0 ? Math.min(1, this.defTimer / gap) : 0;
    }

    /** 防御骰当前的实际间隔（二面骰子会让它变长） */
    get defenseGap(): number {
        return this.player.defGap * this.defScale;
    }

    /** 最近一次防御骰的结果（界面上显示用） */
    get lastDefense(): DiceRoll | null {
        return this.lastDefenseDice;
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
        // 玩家倒下等复活时整个战场暂停
        if (this.playerDown) return;

        // 1) 玩家攻击：先结算，保证「同归于尽」时判玩家赢
        this.tickAttack(this.player, dt, true);

        // 2) 玩家防御：独立节奏，和攻击互不影响
        if (!this.over && !this.player.dead) {
            this.defTimer += dt;
            if (this.defTimer >= this.defenseGap) {
                this.defTimer -= this.defenseGap;
                this.rollDefense();
            }
        }

        // 3) 敌人攻击：100% 命中
        this.tickAttack(this.enemy, dt, false);
    }

    private tickAttack(unit: Unit, dt: number, withDice: boolean): void {
        if (this.over || unit.dead) return;
        if (unit.acting > 0) {
            unit.acting -= dt;
            if (unit.acting <= 0) {
                unit.acting = 0;
                if (withDice) this.resolvePlayerAttack();
                else this.resolveEnemyAttack();
            }
            return;
        }
        unit.charge += dt;
        const speed = withDice ? unit.speed * this.atkScale : unit.speed;
        if (unit.charge >= speed) {
            unit.charge -= speed;
            if (withDice) this.beginPlayerAttack();
            else this.beginEnemyAttack();
        }
    }

    private beginPlayerAttack(): void {
        // 上一次击中 BOSS 的代价：这一次攻击的敏捷先扣掉
        const penalty = this.pendingAgilityPenalty;
        this.pendingAgilityPenalty = 0;
        const agility = Math.max(1, this.player.agility - penalty);

        const out = this.rollFor(true);
        const threshold = hitThreshold(agility, this.enemy.agility, this.diff);
        const hit = out.forceHit || isHit(out.sum, agility, this.enemy.agility, this.diff);
        this.player.dice = {
            a: out.a, b: out.b, sum: out.sum, threshold, hit, multiplier: out.multiplier || 1,
        };
        this.player.acting = this.player.atkGap;
        this.events.push({ kind: 'attackRoll', dice: this.player.dice });
        this.emitDiceGold(out);
    }

    /** 按已装备策略投一次骰，并处理「二面骰子」的连续最小值冷却 */
    private rollFor(isAttack: boolean): RollOutcome {
        const effects = this.player.effects;
        const out = rollByStrategy(effects, this.random);
        if (effects && effects.twoFace) {
            let streak = isAttack ? this.atkStreak : this.defStreak;
            if (out.twoFaceMax) streak = 0;
            else if (out.twoFaceMin) streak += 1;
            const scale = out.twoFaceMin ? 1 + 1 / Math.max(1, streak) : 1;
            if (isAttack) {
                this.atkStreak = streak;
                this.atkScale = scale;
            } else {
                this.defStreak = streak;
                this.defScale = scale;
            }
        }
        return out;
    }

    /** 骰子上自带的金币效果（奇数性） */
    private emitDiceGold(out: RollOutcome): void {
        if (out.goldFlat) this.events.push({ kind: 'goldBonus', amount: out.goldFlat, source: 'dice' });
        if (out.goldProfitPercent) this.events.push({ kind: 'goldPercent', percent: out.goldProfitPercent });
    }

    private resolvePlayerAttack(): void {
        const dice = this.player.dice;
        this.player.dice = null;
        if (!dice || this.over) return;

        if (!dice.hit) {
            this.events.push({ kind: 'attack', hit: false, damage: 0, enemyHp: this.enemy.hp });
            return;
        }
        const damage = calcDamage(this.player.atk, this.enemy.def) * (dice.multiplier || 1);
        this.enemy.hp = Math.max(0, this.enemy.hp - damage);
        this.events.push({ kind: 'attack', hit: true, damage, enemyHp: this.enemy.hp });

        // BOSS 特殊规则：击中 BOSS 的代价与奖励
        const spec = this.enemy.special;
        if (spec) {
            if (spec.goldOnHitPlayer) {
                this.events.push({ kind: 'goldBonus', amount: spec.goldOnHitPlayer, source: 'hit' });
            }
            if (spec.agilityDownOnHitPlayer) {
                // 只影响「下一次攻击」：累积到下一次投攻击骰时扣掉，然后清零
                this.pendingAgilityPenalty += spec.agilityDownOnHitPlayer;
                this.events.push({
                    kind: 'playerAgilityDown',
                    agility: Math.max(1, this.player.agility - this.pendingAgilityPenalty),
                });
            }
        }

        if (this.enemy.hp <= 0) {
            this.enemy.dead = true;
            this.over = true;
            this.events.push({ kind: 'end', winner: 'player' });
        }
    }

    private beginEnemyAttack(): void {
        this.enemy.acting = this.enemy.atkGap;
        this.events.push({ kind: 'enemySwing' });
    }

    private resolveEnemyAttack(): void {
        if (this.over) return;
        // 敌人这次打出来的伤害（敌人自己的 Def 只影响「玩家打它时扣多少」，不影响它打人）
        const incoming = Math.max(MIN_DAMAGE, Math.round(this.enemy.atk));
        // 先扣防御值（护盾池），扣完不够的部分才扣血
        const absorbed = Math.min(this.defense, incoming);
        this.defense -= absorbed;
        const hpLoss = incoming - absorbed;
        this.player.hp = Math.max(0, this.player.hp - hpLoss);
        this.events.push({
            kind: 'enemyHit', damage: hpLoss, absorbed, defense: this.defense, playerHp: this.player.hp,
        });

        // BOSS 特殊规则：掉血扣金币 / 完全格挡住时 BOSS 被削弱
        const spec = this.enemy.special;
        if (spec) {
            if (hpLoss > 0) {
                if (spec.goldOnPlayerDamaged) {
                    this.events.push({ kind: 'goldBonus', amount: spec.goldOnPlayerDamaged, source: 'damaged' });
                }
            } else {
                let weakened = false;
                if (spec.agilityDownOnFullBlock) {
                    this.enemy.agility = Math.max(1, this.enemy.agility - spec.agilityDownOnFullBlock);
                    weakened = true;
                }
                if (spec.blockadeUpOnFullBlock) {
                    this.enemy.blockade += spec.blockadeUpOnFullBlock;
                    weakened = true;
                }
                if (weakened) {
                    this.events.push({
                        kind: 'bossWeakened', agility: this.enemy.agility, blockade: this.enemy.blockade,
                    });
                }
            }
        }

        // 策略「荆棘」：未被格挡的伤害等量反弹给敌人
        if (hpLoss > 0 && this.player.effects && this.player.effects.thorns) {
            this.enemy.hp = Math.max(0, this.enemy.hp - hpLoss);
            this.events.push({ kind: 'thorns', damage: hpLoss, enemyHp: this.enemy.hp });
            if (this.enemy.hp <= 0) {
                this.enemy.dead = true;
                this.over = true;
                this.events.push({ kind: 'end', winner: 'player' });
                return;
            }
        }

        if (this.player.hp <= 0) {
            // 玩家倒下：不结束战斗，等外部 revive()（复活后继续打同一个敌人）
            this.player.dead = true;
            this.playerDown = true;
            this.events.push({ kind: 'playerDown' });
        }
    }
    private rollDefense(): void {
        if (this.over || this.player.dead) return;
        const out = this.rollFor(false);
        const threshold = hitThreshold(this.player.agility, this.enemy.blockade, this.diff);
        const hit = out.forceHit || isHit(out.sum, this.player.agility, this.enemy.blockade, this.diff);
        this.lastDefenseDice = {
            a: out.a, b: out.b, sum: out.sum, threshold, hit, multiplier: out.multiplier || 1,
        };
        if (hit) {
            this.defense += Math.max(0, this.player.def) * (out.multiplier || 1);
        }
        this.events.push({ kind: 'defense', dice: this.lastDefenseDice, hit, defense: this.defense });
        this.emitDiceGold(out);
    }
}
