import { MIN_DAMAGE } from './BattleCore';
import type { StrategyEffects, Unit } from './BattleCore';
import { skillById } from './Skills';
import type { SkillDef, SkillKind } from './Skills';

/**
 * 新版拼点引擎：双方各有「攻击色子 / 防御色子」，每秒拼一次点。
 *  - 攻击线：玩家攻击色子 vs 敌人防御色子
 *  - 防御线：玩家防御色子 vs 敌人攻击色子
 * 胜出的一方按技能面板结算，输的一方掉 1 点对应的「耐久」（玩家：敏捷 / 封锁；敌人同理），
 * 耐久归 0 色子就碎，碎一段时间之后耐久回满。
 */

/** 默认拼点速度：1 次/秒 */
export const CONTEST_INTERVAL = 1;

/** 敌人色子破碎后固定恢复时间（敌人没有技能面板，用固定值） */
export const ENEMY_SHATTER_TIME = 3;

/** 敌人攻击色子默认面值区间（没配的话按 Atk 推算） */
export function defaultEnemyAttackFace(atk: number): [number, number] {
    const max = Math.max(2, Math.round(atk / 3));
    return [1, max];
}

/** 敌人防御色子默认面值区间（按 blockade 推算） */
export function defaultEnemyDefenseFace(blockade: number): [number, number] {
    const max = Math.max(2, Math.round(blockade));
    return [1, max];
}

export interface LaneState {
    skill: SkillDef;
    /** 最近一次投出的面值 */
    face: number;
    /** 破碎剩余时间（> 0 表示碎着） */
    broken: number;
    lastResult: 'win' | 'lose' | 'draw' | 'none';
    lastText: string;
}

export interface BattleOptions {
    attackSkill: SkillDef;
    defenseSkill: SkillDef;
    energy: number;
    energyMax: number;
    energyRecovery: number;
    enemyAttackFace: [number, number];
    enemyDefenseFace: [number, number];
}

export type SkillBattleEvent =
    | { kind: 'log'; text: string }
    | { kind: 'gold'; amount: number; reason: string }
    | { kind: 'playerDown' }
    | { kind: 'end'; winner: 'player' | 'enemy' };

export interface BattleSnapshot {
    energy: number;
    energyMax: number;
    agility: number;
    agilityMax: number;
    blockade: number;
    blockadeMax: number;
    playerDefense: number;
    enemyDefense: number;
    playerHp: number;
    playerMaxHp: number;
    enemyHp: number;
    enemyMaxHp: number;
    enemyAttackFace: number;
    enemyDefenseFace: number;
    strength: number;
    contestTimer: number;
    contestInterval: number;
    attackBroken: number;
    defenseBroken: number;
}

export class SkillBattle {
    readonly player: Unit;
    readonly enemy: Unit;
    readonly diff: number;

    energy: number;
    readonly energyMax: number;
    readonly energyRecovery: number;

    readonly attack: LaneState;
    readonly defense: LaneState;

    readonly enemyAttackRange: [number, number];
    readonly enemyDefenseRange: [number, number];
    enemyAttackFaceValue = 0;
    enemyDefenseFaceValue = 0;
    /** 「重击」给敌方防御色子的一次性上限削减 */
    private enemyDefensePenalty = 0;
    private enemyDefensePenaltyTurn = false;

    agility: number;
    readonly agilityMax: number;
    blockade: number;
    readonly blockadeMax: number;
    enemyAgility: number;
    readonly enemyAgilityMax: number;
    enemyBlockade: number;
    readonly enemyBlockadeMax: number;

    playerDefense = 0;
    enemyDefense = 0;

    /** 「力量」剩余时间与额外伤害倍率 */
    strengthTimer = 0;
    strengthBonus = 0;

    private contestTimer = 0;
    private events: SkillBattleEvent[] = [];
    private over = false;
    private playerDown = false;
    private delayedDefense: Array<{ timer: number; amount: number; label: string }> = [];
    private random: () => number;

    constructor(player: Unit, enemy: Unit, diff: number, random: () => number, options: BattleOptions) {
        this.player = player;
        this.enemy = enemy;
        this.diff = diff;
        this.random = random;
        this.energy = options.energy;
        this.energyMax = options.energyMax;
        this.energyRecovery = Math.max(0.05, options.energyRecovery);
        this.attack = { skill: options.attackSkill, face: 0, broken: 0, lastResult: 'none', lastText: '' };
        this.defense = { skill: options.defenseSkill, face: 0, broken: 0, lastResult: 'none', lastText: '' };
        this.enemyAttackRange = options.enemyAttackFace;
        this.enemyDefenseRange = options.enemyDefenseFace;

        this.agilityMax = Math.max(1, Math.round(player.agility));
        this.agility = this.agilityMax;
        this.blockadeMax = Math.max(1, Math.round(player.blockade > 0 ? player.blockade : 1));
        this.blockade = this.blockadeMax;
        this.enemyAgilityMax = Math.max(1, Math.round(enemy.agility));
        this.enemyAgility = this.enemyAgilityMax;
        this.enemyBlockadeMax = Math.max(1, Math.round(enemy.blockade > 0 ? enemy.blockade : 1));
        this.enemyBlockade = this.enemyBlockadeMax;

        this.player.charge = 0;
        this.player.acting = 0;
        this.player.dice = null;
        this.enemy.charge = 0;
        this.enemy.acting = 0;
        this.enemy.dice = null;
        if (player.effects && player.effects.autoShield) this.playerDefense = 15;
    }

    get finished(): boolean {
        return this.over;
    }

    get waitingRevive(): boolean {
        return this.playerDown;
    }

    /** 贿赂之类的被动金币倍率加成 */
    get goldMultiplierBonus(): number {
        let bonus = 0;
        if (this.attack.skill.bonusMultiplier) bonus += this.attack.skill.bonusMultiplier;
        if (this.defense.skill.bonusMultiplier) bonus += this.defense.skill.bonusMultiplier;
        return bonus;
    }

    revive(hp: number): void {
        if (this.over) return;
        this.playerDown = false;
        this.player.hp = Math.max(1, Math.min(this.player.maxHp, Math.round(hp)));
        this.player.dead = false;
    }

    snapshot(): BattleSnapshot {
        return {
            energy: this.energy,
            energyMax: this.energyMax,
            agility: this.agility,
            agilityMax: this.agilityMax,
            blockade: this.blockade,
            blockadeMax: this.blockadeMax,
            playerDefense: this.playerDefense,
            enemyDefense: this.enemyDefense,
            playerHp: this.player.hp,
            playerMaxHp: this.player.maxHp,
            enemyHp: this.enemy.hp,
            enemyMaxHp: this.enemy.maxHp,
            enemyAttackFace: this.enemyAttackFaceValue,
            enemyDefenseFace: this.enemyDefenseFaceValue,
            strength: this.strengthTimer,
            contestTimer: this.contestTimer,
            contestInterval: CONTEST_INTERVAL,
            attackBroken: this.attack.broken,
            defenseBroken: this.defense.broken,
        };
    }

    /** 切换色子：任意时刻都能切，扣能耗；切防御色子会把当前防御值清零 */
    switchSkill(kind: SkillKind, id: string): { ok: boolean; reason: string } {
        const skill = skillById(id);
        if (!skill) return { ok: false, reason: '技能不存在' };
        if (skill.kind !== kind) return { ok: false, reason: '技能类型不对' };
        const lane = kind === 'attack' ? this.attack : this.defense;
        if (lane.broken > 0) return { ok: false, reason: '色子破碎中，无法切换' };
        if (lane.skill.id === skill.id) return { ok: false, reason: '已经装的就是这个色子' };
        if (this.energy < skill.energy) {
            return { ok: false, reason: `能量不足：需要 ${skill.energy}，当前 ${this.energy.toFixed(1)}` };
        }
        this.energy -= skill.energy;
        lane.skill = skill;
        lane.face = 0;
        lane.lastResult = 'none';
        lane.lastText = '';
        if (kind === 'defense') {
            this.playerDefense = 0;
        }
        this.events.push({
            kind: 'log',
            text: `切换${kind === 'attack' ? '攻击' : '防御'}色子 → ${skill.name}（-${skill.energy} 能量）`
                + (kind === 'defense' ? '，当前防御值清零' : ''),
        });
        return { ok: true, reason: '' };
    }

    update(dt: number): SkillBattleEvent[] {
        if (!this.over && !this.playerDown && dt > 0) this.tick(dt);
        const out = this.events;
        this.events = [];
        return out;
    }

    private tick(dt: number): void {
        // 能量恢复
        this.energy = Math.min(this.energyMax, this.energy + dt / this.energyRecovery);
        // 力量倒计时
        if (this.strengthTimer > 0) this.strengthTimer = Math.max(0, this.strengthTimer - dt);
        // 色子恢复
        this.tickBroken(this.attack, dt, '攻击');
        this.tickBroken(this.defense, dt, '防御');
        this.tickBrokenEnemy(dt);

        // 延迟生效的防御（巩固）
        if (this.delayedDefense.length > 0) {
            const remain: typeof this.delayedDefense = [];
            for (const item of this.delayedDefense) {
                item.timer -= dt;
                if (item.timer <= 0) {
                    this.playerDefense += item.amount;
                    this.events.push({ kind: 'log', text: `${item.label}生效：获得 ${item.amount} 防御值` });
                } else {
                    remain.push(item);
                }
            }
            this.delayedDefense = remain;
        }

        // 拼点
        this.contestTimer += dt;
        let guard = 0;
        while (this.contestTimer >= CONTEST_INTERVAL && guard < 5) {
            this.contestTimer -= CONTEST_INTERVAL;
            guard += 1;
            this.doContest();
            if (this.over || this.playerDown) break;
        }
    }

    private tickBroken(lane: LaneState, dt: number, label: string): void {
        if (lane.broken <= 0) return;
        lane.broken = Math.max(0, lane.broken - dt);
        if (lane.broken > 0) return;
        if (lane === this.attack) {
            this.agility = this.agilityMax;
        } else {
            this.blockade = this.blockadeMax;
        }
        this.events.push({ kind: 'log', text: `${label}色子恢复了（${lane.skill.name}），耐久回满` });
    }

    private tickBrokenEnemy(dt: number): void {
        if (this.enemyAttackBroken <= 0 && this.enemyDefenseBroken <= 0) return;
        if (this.enemyAttackBroken > 0) {
            this.enemyAttackBroken = Math.max(0, this.enemyAttackBroken - dt);
            if (this.enemyAttackBroken === 0) this.enemyAgility = this.enemyAgilityMax;
        }
        if (this.enemyDefenseBroken > 0) {
            this.enemyDefenseBroken = Math.max(0, this.enemyDefenseBroken - dt);
            if (this.enemyDefenseBroken === 0) this.enemyBlockade = this.enemyBlockadeMax;
        }
    }

    /** 敌人色子破碎计时（攻击 = 敏捷归零，防御 = 封锁归零） */
    private enemyAttackBroken = 0;
    private enemyDefenseBroken = 0;

    private doContest(): void {
        if (this.attack.broken <= 0 && this.enemyDefenseBroken <= 0) this.contestAttack();
        if (this.over || this.playerDown) return;
        if (this.defense.broken <= 0 && this.enemyAttackBroken <= 0) this.contestDefense();
    }

    /** 投玩家色子面值（策略会改造面值） */
    private rollPlayerFace(lane: 'attack' | 'defense'): number {
        const skill = lane === 'attack' ? this.attack.skill : this.defense.skill;
        let min = Math.max(0, Math.round(skill.faceMin));
        const max = Math.max(min, Math.round(skill.faceMax));
        const fx: StrategyEffects | undefined = this.player.effects;

        // 玻璃大炮：防御色子必然最小值
        if (lane === 'defense' && fx && fx.glassCannon) return min;
        // 二面骰子：只出最小或最大
        if (fx && fx.twoFace) return this.random() < 0.5 ? min : max;
        let face = min + Math.floor(this.random() * (max - min + 1));
        // 斐波那契：只在区间里挑斐波那契面值
        if (fx && fx.fibDice) {
            const fibs: number[] = [];
            for (let v = min; v <= max; v += 1) {
                let a = 1;
                let b = 1;
                while (b < v) {
                    const next = a + b;
                    a = b;
                    b = next;
                }
                if (b === v) fibs.push(v);
            }
            face = fibs.length > 0 ? fibs[Math.floor(this.random() * fibs.length) % fibs.length] : min;
        }
        // 奇数性：奇数翻倍，偶数归 0
        if (fx && fx.oddity) face = face % 2 === 1 ? face * 2 : 0;
        return face;
    }

    private rollRange(range: [number, number], penalty = 0): number {
        const min = Math.max(1, Math.round(range[0]));
        const max = Math.max(min, Math.round(range[1]) - penalty);
        return min + Math.floor(this.random() * (max - min + 1));
    }

    private attackDamage(face: number): number {
        const skill = this.attack.skill;
        const scale = skill.scale === undefined ? 1 : skill.scale;
        const bonus = this.strengthTimer > 0 ? this.strengthBonus : 0;
        let base = Math.max(MIN_DAMAGE, Math.round(this.player.atk * (scale + bonus)));
        // 策略「二面骰子」：出最大面值时伤害 ×2（不再有冷却时长那一套）
        const fx = this.player.effects;
        if (fx && fx.twoFace && face >= Math.round(skill.faceMax)) base *= 2;
        const hits = Math.max(1, skill.hits || 1);
        return base * hits;
    }

    private contestAttack(): void {
        const playerFace = this.rollPlayerFace('attack');
        const penalty = this.enemyDefensePenalty;
        const enemyFace = this.rollRange(this.enemyDefenseRange, penalty);
        this.enemyDefensePenaltyTurn = penalty > 0;
        if (this.enemyDefensePenaltyTurn) this.enemyDefensePenalty = 0;

        this.attack.face = playerFace;
        this.enemyDefenseFaceValue = enemyFace;
        const skill = this.attack.skill;

        if (playerFace > enemyFace) {
            this.attack.lastResult = 'win';
            const damage = this.attackDamage(playerFace);
            const applied = this.damageEnemy(damage, skill.name);
            this.enemyBlockade = Math.max(0, this.enemyBlockade - 1);
            let extra = '';
            if (this.enemyBlockade === 0) {
                this.shatterEnemyDefense();
                extra += '，敌方防御色子破碎';
            }
            if (skill.strength) {
                this.strengthTimer = skill.strength.duration;
                this.strengthBonus = skill.strength.bonus;
                extra += `，力量 +1（${skill.strength.duration}s）`;
            }
            if (skill.weakenMax) {
                this.enemyDefensePenalty = skill.weakenMax;
                extra += `，敌方防御色子上限 -${skill.weakenMax}`;
            }
            this.attack.lastText = `${skill.name} 命中：${applied} 伤害（敌方封锁 -1${extra}）`;
        } else if (playerFace < enemyFace) {
            this.attack.lastResult = 'lose';
            this.enemyDefense += Math.max(0, Math.round(this.enemy.def));
            this.agility = Math.max(0, this.agility - 1);
            let extra = '';
            if (this.agility === 0) {
                this.shatterPlayerAttack();
                extra = '，攻击色子破碎';
            }
            this.attack.lastText = `拼点输了：敌方防御 +${Math.max(0, Math.round(this.enemy.def))}，敏捷 -1（剩 ${this.agility}${extra}）`;
        } else {
            this.attack.lastResult = 'draw';
            this.attack.lastText = '平手，无事发生';
        }
    }

    private contestDefense(): void {
        const playerFace = this.rollPlayerFace('defense');
        const enemyFace = this.rollRange(this.enemyAttackRange);
        this.defense.face = playerFace;
        this.enemyAttackFaceValue = enemyFace;
        const skill = this.defense.skill;

        if (playerFace > enemyFace) {
            this.defense.lastResult = 'win';
            let extra = '';
            if (skill.delay && skill.scale) {
                const amount = Math.max(1, Math.round(this.player.def * skill.scale));
                this.delayedDefense.push({ timer: skill.delay, amount, label: skill.name });
                extra = `，${skill.delay}s 后获得 ${amount} 防御值`;
            } else if (!skill.dodge && skill.scale) {
                let gain = Math.round(this.player.def * skill.scale);
                // 策略「二面骰子」：出最大面值时防御值 ×2
                const fx = this.player.effects;
                if (fx && fx.twoFace && playerFace >= Math.round(skill.faceMax)) gain *= 2;
                this.playerDefense += gain;
                extra = `，防御值 +${gain}`;
            } else if (skill.dodge) {
                extra = '，完全抵消这次攻击（不加防御值）';
            }
            if (skill.goldPerFace) {
                const cost = skill.goldPerFace * playerFace;
                this.events.push({ kind: 'gold', amount: -cost, reason: `${skill.name}（面值 ${playerFace}）` });
            }
            if (skill.gold) {
                this.events.push({ kind: 'gold', amount: skill.gold, reason: skill.name });
            }
            this.enemyAgility = Math.max(0, this.enemyAgility - 1);
            if (this.enemyAgility === 0) {
                this.shatterEnemyAttack();
                extra += '，敌方攻击色子破碎';
            }
            this.defense.lastText = `${skill.name} 生效${extra}`;
        } else if (playerFace < enemyFace) {
            this.defense.lastResult = 'lose';
            // 巩固：拼点失败照样扣封锁，但不掉血
            const noDamage = !!skill.delay;
            let applied = 0;
            if (!noDamage) applied = this.damagePlayer(this.enemyDamage(), skill.name);
            this.blockade = Math.max(0, this.blockade - 1);
            let extra = '';
            if (this.blockade === 0) {
                this.shatterPlayerDefense();
                extra = '，防御色子破碎';
            }
            this.defense.lastText = noDamage
                ? `拼点输了，但巩固无视结果（封锁 -1，剩 ${this.blockade}${extra}）`
                : `拼点输了：受到 ${applied} 伤害，封锁 -1（剩 ${this.blockade}${extra}）`;
        } else {
            this.defense.lastResult = 'draw';
            this.defense.lastText = '平手，无事发生';
        }
    }

    private enemyDamage(): number {
        return Math.max(MIN_DAMAGE, Math.round(this.enemy.atk));
    }

    /** 对敌人结算伤害：先扣敌方防御值，溢出才扣血 */
    private damageEnemy(amount: number, label: string): number {
        const absorbed = Math.min(this.enemyDefense, amount);
        this.enemyDefense -= absorbed;
        const hpLoss = amount - absorbed;
        if (hpLoss > 0) {
            this.enemy.hp = Math.max(0, this.enemy.hp - hpLoss);
        }
        if (hpLoss > 0) {
            this.events.push({ kind: 'log', text: `${label} 造成 ${amount} 伤害（护盾吃 ${absorbed}，掉血 ${hpLoss}）` });
        }
        if (this.enemy.hp <= 0) {
            this.enemy.dead = true;
            this.over = true;
            this.events.push({ kind: 'end', winner: 'player' });
        }
        return amount;
    }

    /** 对玩家结算伤害：先扣玩家防御值，溢出才扣血 */
    private damagePlayer(amount: number, label: string): number {
        const absorbed = Math.min(this.playerDefense, amount);
        this.playerDefense -= absorbed;
        const hpLoss = amount - absorbed;
        if (hpLoss > 0) {
            this.player.hp = Math.max(0, this.player.hp - hpLoss);
        }
        if (this.player.hp <= 0) {
            this.player.dead = true;
            this.playerDown = true;
            this.events.push({ kind: 'playerDown' });
        }
        return amount;
    }

    private shatterPlayerAttack(): void {
        this.attack.broken = Math.max(0.1, this.attack.skill.recovery);
        this.events.push({ kind: 'log', text: `敏捷归零：攻击色子（${this.attack.skill.name}）破碎 ${this.attack.broken.toFixed(1)}s` });
    }

    private shatterPlayerDefense(): void {
        this.defense.broken = Math.max(0.1, this.defense.skill.recovery);
        this.playerDefense = 0;
        this.events.push({ kind: 'log', text: `封锁归零：防御色子（${this.defense.skill.name}）破碎 ${this.defense.broken.toFixed(1)}s` });
    }

    private shatterEnemyDefense(): void {
        this.enemyDefenseBroken = ENEMY_SHATTER_TIME;
        this.enemyDefense = 0;
        this.events.push({ kind: 'log', text: '敌方封锁归零：防御色子破碎，敌方防御值清零' });
    }

    private shatterEnemyAttack(): void {
        this.enemyAttackBroken = ENEMY_SHATTER_TIME;
        this.events.push({ kind: 'log', text: '敌方敏捷归零：攻击色子破碎' });
    }
}
