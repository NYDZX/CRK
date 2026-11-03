import {
    _decorator, Color, Component, Director, director, EventKeyboard, EventMouse, EventTouch, Graphics, Input,
    KeyCode, Label, Layers, Mask, Node, UITransform, Vec3, input,
} from 'cc';
import {
    Battle, bossRemaining, calcDamage, createUnit, hitChance, newLevelProgress, pickEnemy, progressAfterBossKill,
    progressAfterNormalKill, rollDrop, DROP_EFFECTS,
} from './BattleCore';
import type {
    BattleEvent, DiceRoll, DropEffect, EnemyConfig, LevelConfig, LevelProgress, StrategyEffects, Unit,
} from './BattleCore';
import { loadGameConfig } from './Config';
import type { GameConfig } from './Config';
import {
    DEBT_INTEREST_RATE, REVIVE_GOLD_COST, formatGold, goldDrop, goldMultiplier, interestAmount, isInDebt, loadGold,
    multiplierDeaths, reviveHp, saveGold,
} from './Economy';
import {
    calcEquipBonus, equipItem, equipmentName, equipmentSummary, equippedId, hasEquipment, loadEquipmentState,
    ownEquipment, ownedForSlot, saveEquipmentState, unequipSlot, SLOT_LABEL,
} from './Equipment';
import type { EquipSlot, EquipmentState } from './Equipment';
import { MAX_SLOTS, STRATEGY_BY_ID, buildEffects, emptyEffects, strategyName } from './Strategies';
import {
    createProgress, expToNext, gainExp, levelAtkBonus, levelDefBonus, loadProgress, saveProgress,
} from './Progress';
import type { PlayerProgress } from './Progress';
import {
    ButtonView, COLOR_MUTED, COLOR_TEXT, TextOptions, createButton, createPanel, createPopup, createText,
    createUINode, setAnchor, setSize,
} from './UIFactory';
import {
    getActiveSlot, loadActiveSlot, migrateLegacySave, setActiveSlot,
} from './Save';

const { ccclass } = _decorator;

/** 设计基准尺寸：所有面板坐标都基于它，运行时整体等比缩放适配屏幕 */
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 800;

/** 面板布局（按你最新给的草图量的比例） */
const PANEL = {
    player: { x: -330, y: 90, w: 409, h: 540 },
    info: { x: 275, y: 238, w: 645, h: 190 },
    attack: { x: 118, y: -57, w: 315, h: 230 },
    defense: { x: 449, y: -57, w: 350, h: 230 },
    exit: { x: -293, y: -284, w: 415, h: 125 },
    select: { x: 278, y: -288, w: 434, h: 110 },
    speed: { x: 570, y: -288, w: 120, h: 70 },
    shop: { x: -12, y: -288, w: 130, h: 70 },
};

/** 加速按钮的档位：点一下在 1x -> 1.5x -> 2x -> 3x -> 1x 之间循环 */
const SPEED_STEPS = [1, 1.5, 2, 3];

/** 负债时金币文字用红色 */
const COLOR_DEBT = new Color(200, 40, 40, 255);

/** 本关盈利 / 亏损的颜色 */
const COLOR_PROFIT = new Color(30, 140, 70, 255);
const COLOR_TEXT_DIM = new Color(150, 150, 150, 255);

/** 盈亏折线图尺寸（和玩家面板内宽一致） */
const CHART_W = 365;
const CHART_H = 56;

/** 「自杀式袭击」策略的强制结束时间（按 1x 速度的真实秒数） */
const SUICIDE_TIME_LIMIT = 50;

/** 策略弹窗里可滚动列表的尺寸与行高 */
const STRAT_LIST_W = 560;
const STRAT_LIST_H = 244;
const STRAT_LIST_Y = -64;
const STRAT_ROW_STEP = 44;
/** 滚动条的可拖动宽度（画出来只有 10px，热区宽一点好抓） */
const STRAT_TRACK_W = 24;

/** 策略「血瓶」每场战斗结束回复的血量 */
const HEAL_AFTER_BATTLE = 10;

/** 敌人 id -> 中文名（只用于显示，取不到就直接显示 id） */
const ENEMY_NAMES: { [id: string]: string } = {
    fox: '狐狸',
    wolf: '狼',
    bat: '蝙蝠',
    robot: '机器人',
    builder: '建造者',
    fox_king: '狐狸王',
    factory_overseer: '工厂监督者',
    knight: '骑士',
    archer: '弓手',
    mage: '法师',
    castle_guardian: '城堡守卫',
};

/** 击败敌人后，隔多久刷新下一个敌人（秒） */
const NEXT_ENEMY_DELAY = 0.9;

/** 单帧最大步长，避免切后台回来时战斗瞬间跑完 */
const MAX_STEP = 0.1;

type Phase = 'loading' | 'select' | 'battle';

interface Mods {
    atk: number;
    agility: number;
}

/** 安全地从映射表里取名（id 撞上 Object 原型成员时也不会取到奇怪的东西） */
function lookupName(table: { [id: string]: string }, id: string): string {
    return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : id;
}

/**
 * 主流程组件（挂在 Canvas/Game 节点上）：
 * 选关 -> 自动战斗 -> 打普通敌人攒进度 -> 打 BOSS 拿装备 -> 阵亡弹窗退出。
 */
@ccclass('BattleGame')
export class BattleGame extends Component {
    // ---------------- 数据 ----------------
    private config: GameConfig | null = null;
    private levelId = '';
    private level: LevelConfig | null = null;
    private progress: LevelProgress = { normalKills: 0, bossTarget: 0, bossPending: false };
    private battle: Battle | null = null;
    private playerUnit: Unit | null = null;
    /** 下一场战斗才生效的临时增益（普通敌人掉落） */
    private playerMods: Mods = { atk: 0, agility: 0 };
    /** 装备（BOSS 掉落永久保存） */
    private equipState: EquipmentState = { inventory: [], weapon: null, armor: null };
    private kills = 0;
    private lastDrop = '——';
    private logs: string[] = [];
    private phase: Phase = 'loading';
    /** 每次进出关卡 +1，用来作废过期的定时器 */
    private runId = 0;
    /** 当前这场是不是 BOSS 战 */
    private spawnedBoss = false;
    /** 金币（可以是负数 —— 负债），永久保存 */
    private gold = 0;
    /** 负债利息计时（每满 60 秒扣一次当前负债的 5%） */
    private interestTimer = 0;
    /** 本次关卡里的死亡（复活）次数，第一次死亡时是 1 */
    private deaths = 0;

    // ---------------- UI ----------------
    private root: Node | null = null;
    private popup: Node | null = null;
    private canvasWidth = 0;
    private canvasHeight = 0;

    private playerText: Label | null = null;
    private terminalText: Label | null = null;
    private weaponButton: ButtonView | null = null;
    private armorButton: ButtonView | null = null;

    private enemyTitle: Label | null = null;
    private enemyText: Label | null = null;
    private enemyStatus: Label | null = null;
    private levelText: Label | null = null;

    private attackDice: Label[] = [];
    private attackSum: Label | null = null;
    private attackResult: Label | null = null;
    private attackDamage: Label | null = null;
    private attackChance: Label | null = null;
    private attackStatus: Label | null = null;

    private defenseDice: Label[] = [];
    private defenseSum: Label | null = null;
    private defenseResult: Label | null = null;
    private defenseValue: Label | null = null;
    private defenseChance: Label | null = null;
    private defenseStatus: Label | null = null;

    private exitButton: ButtonView | null = null;
    private selectButton: ButtonView | null = null;
    private speedButton: ButtonView | null = null;
    private shopButton: ButtonView | null = null;

    private goldText: Label | null = null;
    private pnlText: Label | null = null;
    private multText: Label | null = null;
    private pnlGrid: Graphics | null = null;
    private pnlLine: Graphics | null = null;
    private stratButton: ButtonView | null = null;

    /** 本关盈亏折线：{ t: 本关经过的秒数, v: 累计盈亏 } */
    private pnlPoints: Array<{ t: number; v: number }> = [];
    /** 进入关卡时的金币（用来算本关盈亏） */
    private goldAtLevelStart = 0;
    /** 本关已过的秒数 */
    private levelSeconds = 0;

    /** 等级 / 经验 / 已获得策略 / 策略槽（永久保存） */
    private charProgress: PlayerProgress = createProgress();
    /** 已装备策略的效果开关（战斗开始时用） */
    private effects: StrategyEffects = emptyEffects();
    /** 玩家面板上的等级/经验行 */
    private progressText: Label | null = null;
    /** 玩家面板标题（显示当前存档） */
    private playerTitle: Label | null = null;
    /** 当前存档槽（1..SLOT_COUNT） */
    private slotIndex = 1;

    /** 策略弹窗的滚动列表 */
    private stratListContent: Node | null = null;
    private stratRows: Node[] = [];
    private stratBar: Graphics | null = null;
    private stratTrack: Node | null = null;
    private stratScroll = 0;
    private stratMaxScroll = 0;
    /** 拖动滚动条时，手指与滑块中心的偏移 */
    private stratDragOffset = 0;

    /** 战斗速度倍率（1 / 1.5 / 2 / 3） */
    private speedFactor = 1;

    // ---------------- 生命周期 ----------------

    protected start(): void {
        this.buildUi();
        this.syncCanvasSize(true);
        input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.on(Input.EventType.MOUSE_WHEEL, this.onMouseWheel, this);
        void this.bootstrap();
    }

    protected onDestroy(): void {
        input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.off(Input.EventType.MOUSE_WHEEL, this.onMouseWheel, this);
    }

    /** Esc：问一下要不要退出当前存档（回到存档选择场景） */
    private onKeyUp(event: EventKeyboard): void {
        if (event.keyCode !== KeyCode.ESCAPE) return;
        if (this.popup) {
            this.closePopup();
            return;
        }
        this.askExitSave();
    }

    private askExitSave(): void {
        const popup = this.openPopup('退出存档', 540, 300);
        this.centerText(popup.content, 0, 58, 20, COLOR_TEXT, true, `退出「存档 ${this.slotIndex}」？`);
        this.centerText(popup.content, 0, 12, 15, COLOR_MUTED, false, '所有进度都已经保存，可以随时从这里回来');

        const yes = createButton(popup.content, 'ExitSaveYes', '是', 190, 58, () => {
            this.log(`退出存档 ${this.slotIndex}`);
            director.loadScene('SaveSelect', (err) => {
                if (err) console.error('[BattleGame] 返回存档选择失败', err);
            });
        }, 18);
        yes.node.setPosition(-115, -78, 0);

        const no = createButton(popup.content, 'ExitSaveNo', '否', 190, 58, () => this.closePopup(), 18);
        no.node.setPosition(115, -78, 0);
    }

    protected update(dt: number): void {
        this.syncCanvasSize(false);
        this.tickInterest(dt);
        if (this.phase !== 'battle' || !this.battle || this.battle.finished) return;
        // 弹窗打开时暂停推进，免得选装备/选关的时候被打死
        if (this.popup) return;

        this.levelSeconds += Math.min(dt, MAX_STEP);

        // 策略「自杀式袭击」：一局超过 50 秒强制结束关卡（保留已经发生的盈亏）
        if (this.effects.suicide && this.levelSeconds >= SUICIDE_TIME_LIMIT) {
            this.log(`自杀式袭击：本局超过 ${SUICIDE_TIME_LIMIT} 秒，强制结束关卡`);
            this.exitLevel();
            return;
        }

        const events = this.battle.update(Math.min(dt, MAX_STEP) * this.speedFactor);
        for (const event of events) this.onBattleEvent(event);
        this.refreshStatusLines();
    }

    /** 负债利息：每满 60 秒扣一次「当前负债额 × 利率」（低利率策略是 3.5%） */
    private tickInterest(dt: number): void {
        if (!isInDebt(this.gold)) {
            this.interestTimer = 0;
            return;
        }
        this.interestTimer += dt;
        if (this.interestTimer < 60) return;
        this.interestTimer -= 60;
        const rate = this.effects.lowInterest ? DEBT_INTEREST_RATE - 0.015 : DEBT_INTEREST_RATE;
        const interest = interestAmount(this.gold, rate);
        this.applyGold(-interest, '负债利息');
    }

    // ---------------- 金币 / 经验 / 策略 ----------------

    /** 统一的加/扣金币入口：处理「自杀式袭击」的取反和 1000 上限 */
    private applyGold(delta: number, reason: string): void {
        if (!delta) return;
        const inLevel = this.phase === 'battle';
        const actual = this.effects.suicide && inLevel ? -delta : delta;
        this.gold += actual;
        if (this.effects.suicide && inLevel && this.gold - this.goldAtLevelStart > 1000) {
            this.gold = 0;
            this.log('自杀式袭击：本局盈利超过 1000，金币清零');
        }
        saveGold(this.gold);
        this.log(`${reason}：${actual > 0 ? '+' : ''}${actual} 金币（共 ${formatGold(this.gold)}）`);
        this.recordPnl();
        this.refreshGoldText();
    }

    /** 当前金币倍率：基础 sqrt(ln(a)+1)；奖杯每次提升额外 +0.2；低利率不随死亡上涨（死亡 >15 次后重新从 1 计） */
    private currentGoldMultiplier(): number {
        if (this.effects.lowInterest) return 1;
        let mult = goldMultiplier(this.deaths);
        if (this.effects.trophy) mult += 0.2 * Math.max(0, multiplierDeaths(this.deaths) - 1);
        return mult;
    }

    /** 基础属性 = 配置 + 等级加成，再套「攻防转换 / 玻璃大炮 / 敏捷」策略（不含装备） */
    private computeBaseStats(): { atk: number; def: number; agility: number } {
        const config = this.config;
        if (!config) return { atk: 0, def: 0, agility: 0 };
        let atk = config.player.Atk + levelAtkBonus(this.charProgress.level);
        let def = config.player.Def + levelDefBonus(this.charProgress.level);
        if (this.effects.swapAtkDef) {
            const tmp = atk;
            atk = def;
            def = tmp;
        }
        if (this.effects.glassCannon) {
            // 玻璃大炮：攻击 ×3，代价是防御骰必然最小值（在 BattleCore 里实现，这里不改 def）
            atk *= 3;
        }
        if (this.effects.autoShield) def = Math.round(def * 0.9);
        const agility = config.player.Agility + (this.effects.agilityPlus ? 1 : 0);
        return { atk, def, agility };
    }

    /** 把基础属性 + 装备 + 「下一场」增益写回玩家单位 */
    private refreshPlayerStats(): void {
        const config = this.config;
        const player = this.playerUnit;
        if (!config || !player) return;
        const base = this.computeBaseStats();
        const bonus = calcEquipBonus(this.equipState, config.equipments);
        player.atk = base.atk + this.playerMods.atk + bonus.atk;
        player.def = base.def + bonus.def;
        player.agility = base.agility + this.playerMods.agility + bonus.agility;
    }

    /** 加经验并处理升级奖励（4 级攻击 / 6 级防御 / 5 级随机策略） */
    private gainExperience(amount: number, reason: string): void {
        if (!(amount > 0)) return;
        const before = this.charProgress.level;
        const result = gainExp(this.charProgress, amount, Math.random);
        saveProgress(this.charProgress);
        this.log(`获得 ${Math.round(amount)} 经验（${reason}）`);
        if (result.levelsUp > 0) {
            const after = this.charProgress.level;
            this.log(`升级！Lv.${before} → Lv.${after}`);
            if (levelAtkBonus(after) > levelAtkBonus(before)) this.log('升级奖励：攻击 +1');
            if (levelDefBonus(after) > levelDefBonus(before)) this.log('升级奖励：防御 +1');
            for (const id of result.newStrategies) this.log(`获得新策略：${strategyName(id)}`);
            this.refreshPlayerStats();
        }
        this.refreshPlayer();
    }

    // ---------------- 启动 / 流程 ----------------

    private async bootstrap(): Promise<void> {
        migrateLegacySave();
        setActiveSlot(loadActiveSlot());
        this.loadSlotData();
        try {
            this.config = await loadGameConfig();
        } catch (err) {
            console.error('[BattleGame] 配置读取失败', err);
            this.showConfigError(err instanceof Error ? err.message : String(err));
            return;
        }

        const levelIds = Object.keys(this.config.levels || {});
        if (levelIds.length === 0) {
            this.showConfigError('levels.json 里没有配置任何关卡');
            return;
        }
        this.levelId = levelIds[0];
        this.exitLevel();
    }

    /** 把当前存档槽的数据读进内存（存档槽由 SaveSelect 场景选好并写进 localStorage） */
    private loadSlotData(): void {
        this.slotIndex = getActiveSlot();
        this.equipState = loadEquipmentState();
        this.gold = loadGold();
        this.charProgress = loadProgress();
        this.effects = buildEffects(this.charProgress.slots);
    }

    /** 配置读不出来时把原因显示在敌人面板上（比只打进控制台更容易看到） */
    private showConfigError(message: string): void {
        this.phase = 'loading';
        this.selectButton?.setEnabled(false);
        this.exitButton?.setEnabled(false);
        this.shopButton?.setEnabled(false);
        if (this.enemyTitle) this.enemyTitle.string = '配置读取失败';
        if (this.enemyText) this.enemyText.string = message;
        if (this.enemyStatus) this.enemyStatus.string = '';
        this.setAttackStatus('修好配置后重新预览即可');
        this.setDefenseStatus('');
    }

    /** 进入某个关卡（选关弹窗里点的那一个） */
    private startLevel(levelId: string): void {
        const config = this.config;
        if (!config) return;
        const level = config.levels[levelId];
        if (!level) {
            this.setAttackStatus(`找不到关卡 ${levelId}`);
            return;
        }

        this.runId += 1;
        this.phase = 'battle';
        this.levelId = levelId;
        this.level = level;
        this.kills = 0;
        this.lastDrop = '——';
        this.logs = [];
        this.playerMods = { atk: 0, agility: 0 };
        this.spawnedBoss = false;
        this.deaths = 0;
        this.interestTimer = 0;
        // 本关盈亏从 0 开始重新记
        this.goldAtLevelStart = this.gold;
        this.levelSeconds = 0;
        this.pnlPoints = [{ t: 0, v: 0 }];
        this.progress = newLevelProgress(level.boss, Math.random);

        const base = config.player;
        const stats = this.computeBaseStats();
        const equipBonus = calcEquipBonus(this.equipState, config.equipments);
        this.playerUnit = createUnit({
            side: 'player',
            id: 'player',
            name: '玩家',
            hp: base.Hp,
            maxHp: base.Hp,
            atk: stats.atk + equipBonus.atk,
            def: stats.def + equipBonus.def,
            agility: stats.agility + equipBonus.agility,
            speed: base.Speed,
            atkGap: base.Atk_gap,
            defGap: base.def_gap,
            effects: this.effects,
        });

        this.closePopup();
        this.selectButton?.setEnabled(true);
        this.exitButton?.setEnabled(true);
        this.shopButton?.setEnabled(false);
        this.log(`进入关卡 ${this.levelName()}`);
        this.log(`BOSS 倒计时：再击败 ${bossRemaining(this.progress)} 个普通敌人`);
        this.log(`金币 ${formatGold(this.gold)}`);
        this.spawnEnemy();
        this.refreshAll();
    }

    /** 点「退出」或战败弹窗退出：回到选关状态 */
    private exitLevel(): void {
        this.runId += 1;
        this.phase = this.config ? 'select' : 'loading';
        this.battle = null;
        this.level = null;
        this.playerUnit = null;
        this.playerMods = { atk: 0, agility: 0 };
        this.progress = { normalKills: 0, bossTarget: 0, bossPending: false };
        this.spawnedBoss = false;
        this.kills = 0;
        this.lastDrop = '——';
        this.logs = [];
        this.closePopup();
        this.setDiceIdle();
        this.selectButton?.setEnabled(!!this.config);
        this.exitButton?.setEnabled(false);
        this.shopButton?.setEnabled(!!this.config);
        this.refreshAll();
        this.setAttackStatus(this.config ? '点「选关」挑一个关卡' : '配置加载中…');
        this.setDefenseStatus('');
    }

    /** 从当前关卡刷一个敌人（到 BOSS 就刷 BOSS），自动开打 */
    private spawnEnemy(): void {
        const config = this.config;
        const level = this.level;
        const player = this.playerUnit;
        if (!config || !level || !player) return;

        const isBoss = this.progress.bossPending && !!level.boss;
        let enemyId: string;
        if (isBoss && level.boss) {
            enemyId = level.boss.enemy;
        } else {
            try {
                enemyId = pickEnemy(level);
            } catch (err) {
                this.setAttackStatus(err instanceof Error ? err.message : String(err));
                return;
            }
        }

        const enemyTable = config.enemies || {};
        const enemyConfig: EnemyConfig | null = Object.prototype.hasOwnProperty.call(enemyTable, enemyId)
            ? enemyTable[enemyId]
            : null;
        if (!enemyConfig) {
            console.warn(`[BattleGame] enemies.json 里没有敌人 ${enemyId}`);
            this.setAttackStatus(`enemies.json 里没有敌人 ${enemyId}`);
            return;
        }

        // 基础属性 + 装备 + 「下一场战斗」增益一起合进来（战斗开始时生效）
        player.effects = this.effects;
        this.refreshPlayerStats();
        this.playerMods = { atk: 0, agility: 0 };

        const enemy = createUnit({
            side: 'enemy',
            id: enemyId,
            name: lookupName(ENEMY_NAMES, enemyId),
            hp: enemyConfig.Hp,
            maxHp: enemyConfig.Hp,
            atk: enemyConfig.Atk,
            def: enemyConfig.Def,
            agility: enemyConfig.Agility,
            speed: enemyConfig.Speed,
            atkGap: enemyConfig.Atk_gap,
            blockade: enemyConfig.blockade,
            special: enemyConfig.special,
        });

        this.battle = new Battle(player, enemy, level.diff, Math.random);
        this.spawnedBoss = isBoss;
        this.setDiceIdle();
        this.log(isBoss ? `BOSS 出现：${enemy.name}` : `遭遇 ${enemy.name}`);
        this.refreshAll();
    }

    // ---------------- 战斗事件 ----------------

    private onBattleEvent(event: BattleEvent): void {
        switch (event.kind) {
            case 'attackRoll':
                this.onAttackRoll(event.dice);
                break;
            case 'attack':
                this.onAttack(event);
                break;
            case 'defense':
                this.onDefense(event);
                break;
            case 'enemySwing':
                this.setEnemyStatus('出手…');
                break;
            case 'enemyHit':
                this.onEnemyHit(event);
                break;
            case 'playerDown':
                this.onPlayerDown();
                break;
            case 'goldBonus':
                this.onGoldBonus(event.amount, event.source);
                break;
            case 'playerAgilityDown':
                this.log(`击中 BOSS 的代价：下一次攻击敏捷降到 ${event.agility}`);
                this.refreshCombatValues();
                break;
            case 'bossWeakened':
                this.log(`完全格挡！BOSS 被削弱：敏捷 ${event.agility}，封锁 ${event.blockade}`);
                this.refreshEnemy();
                this.refreshCombatValues();
                break;
            case 'goldPercent': {
                const profit = this.gold - this.goldAtLevelStart;
                if (profit > 0) {
                    const delta = -Math.max(1, Math.round(profit * Math.abs(event.percent)));
                    this.applyGold(-delta, '策略惩罚（本局盈利）');
                }
                break;
            }
            case 'thorns':
                this.log(`荆棘反弹 ${event.damage} 伤害（敌人剩余 ${event.enemyHp}）`);
                this.refreshEnemy();
                break;
            case 'end':
                if (event.winner === 'player') this.onEnemyDefeated();
                break;
            default:
                break;
        }
    }

    private onAttackRoll(dice: DiceRoll): void {
        this.showDice(this.attackDice, this.attackSum, dice);
        if (this.attackResult) this.attackResult.string = '';
        this.setAttackStatus(`投骰中…（阈值 ${dice.threshold}）`);
    }

    private onAttack(event: Extract<BattleEvent, { kind: 'attack' }>): void {
        if (event.hit) {
            this.log(`你 命中，敌人受到 ${event.damage} 伤害`);
            if (this.attackResult) this.attackResult.string = `命中！造成 ${event.damage} 点伤害`;
        } else {
            this.log('你 未命中');
            if (this.attackResult) this.attackResult.string = '未命中';
        }
        this.setAttackStatus(`敌人生命 ${event.enemyHp}`);
        this.refreshPlayer();
        this.refreshEnemy();
    }

    private onDefense(event: Extract<BattleEvent, { kind: 'defense' }>): void {
        this.showDice(this.defenseDice, this.defenseSum, event.dice);
        const gain = this.playerUnit ? this.playerUnit.def : 0;
        if (event.hit) {
            this.log(`防御成功，防御值 +${gain}（当前 ${event.defense}）`);
            if (this.defenseResult) this.defenseResult.string = `防御成功 +${gain}（防御值 ${event.defense}）`;
        } else {
            this.log('防御失败');
            if (this.defenseResult) this.defenseResult.string = '防御失败';
        }
        this.refreshCombatValues();
    }

    private onEnemyHit(event: Extract<BattleEvent, { kind: 'enemyHit' }>): void {
        if (event.absorbed > 0 && event.damage > 0) {
            this.log(`敌人命中：防御值挡下 ${event.absorbed}，你受到 ${event.damage} 伤害`);
        } else if (event.damage <= 0) {
            this.log(`敌人命中：防御值全部挡下（${event.absorbed}）`);
        } else {
            this.log(`敌人命中，你受到 ${event.damage} 伤害`);
        }
        this.refreshPlayer();
        this.refreshCombatValues();
    }

    /** 击败敌人：普通敌人掉落 buff / BOSS 掉落装备，然后推进 BOSS 进度 */
    private onEnemyDefeated(): void {
        const battle = this.battle;
        const config = this.config;
        if (!battle || !config) return;
        const enemy = battle.enemy;
        const isBoss = this.spawnedBoss;

        this.kills += 1;
        this.log(`击败 ${enemy.name}`);

        // 策略「血瓶」：每场战斗结束回 10 点血
        const playerUnit = this.playerUnit;
        if (this.effects.healthPotion && playerUnit) {
            playerUnit.hp = Math.min(playerUnit.maxHp, playerUnit.hp + HEAL_AFTER_BATTLE);
            this.log(`血瓶：战斗结束回复 ${HEAL_AFTER_BATTLE} 血（${playerUnit.hp} / ${playerUnit.maxHp}）`);
        }

        const enemyConfig: EnemyConfig | undefined = Object.prototype.hasOwnProperty.call(config.enemies, enemy.id)
            ? config.enemies[enemy.id]
            : undefined;
        const dropType = rollDrop(enemyConfig ? enemyConfig.Drop : undefined);
        if (dropType === 'Equip') {
            this.gainEquipment(enemyConfig && enemyConfig.Drop ? enemyConfig.Drop.equip : undefined);
        } else if (dropType) {
            const effect: DropEffect | undefined = DROP_EFFECTS[dropType];
            if (effect) {
                this.applyDrop(dropType, effect);
            } else {
                this.lastDrop = dropType;
                this.log(`掉落 ${dropType}（未定义效果）`);
            }
        }

        // 金币：基础金币 × 当前金币倍率；经验：敌人倍率 × 关卡基础经验
        const goldGain = goldDrop(enemyConfig ? enemyConfig.Gold : 0, this.currentGoldMultiplier());
        if (goldGain > 0) this.applyGold(goldGain, `击败 ${enemy.name}`);
        const baseExp = this.level ? this.level.Exp : 0;
        this.gainExperience((enemyConfig ? enemyConfig.ExpRate : 1) * baseExp, `击败 ${enemy.name}`);

        if (isBoss) {
            this.progress = progressAfterBossKill(this.progress, this.level ? this.level.boss : undefined, Math.random);
            this.spawnedBoss = false;
            this.log(`BOSS 已击败，下一个 BOSS 前还要打 ${bossRemaining(this.progress)} 个普通敌人`);
        } else {
            this.progress = progressAfterNormalKill(this.progress);
            if (this.progress.bossPending) this.log('普通敌人清完了，下一个就是 BOSS');
        }

        this.refreshAll();

        const runId = this.runId;
        this.scheduleOnce(() => {
            if (runId === this.runId && this.phase === 'battle') this.spawnEnemy();
        }, NEXT_ENEMY_DELAY / this.speedFactor);
    }

    private applyDrop(type: string, effect: DropEffect): void {
        const player = this.playerUnit;
        this.lastDrop = type;
        if (!player) return;

        if (effect.heal) {
            player.hp = Math.min(player.maxHp, player.hp + effect.heal);
        }
        if (effect.atk) this.playerMods.atk += effect.atk;
        if (effect.agility) this.playerMods.agility += effect.agility;

        this.log(`掉落 ${type}：${effect.label}`);
        this.refreshPlayer();
    }

    /** BOSS 专属：掉装备，永久保存到本地存档 */
    private gainEquipment(id: string | undefined): void {
        const config = this.config;
        if (!config) return;
        if (!id) {
            this.log('BOSS 没有配置掉落装备');
            return;
        }
        if (hasEquipment(this.equipState, id)) {
            this.lastDrop = `${equipmentName(config.equipments, id)}（已拥有）`;
            this.log(`BOSS 掉落 ${equipmentName(config.equipments, id)}，但你已经有了`);
            return;
        }
        this.equipState = ownEquipment(this.equipState, id);
        saveEquipmentState(this.equipState);
        this.lastDrop = equipmentName(config.equipments, id);
        this.log(`获得装备 ${equipmentName(config.equipments, id)}（永久保存，可在玩家面板装备）`);
    }

    /** BOSS 特殊规则的金币结算（+10 击中 / -55 挨打），走统一的金币入口 */
    private onGoldBonus(amount: number, source: 'hit' | 'damaged' | 'dice'): void {
        if (!amount) return;
        const who = this.battle ? this.battle.enemy.name : 'BOSS';
        if (source === 'hit') this.applyGold(amount, `击中 ${who}`);
        else if (source === 'damaged') this.applyGold(amount, `被 ${who} 打中`);
        else this.applyGold(amount, '骰子奖励');
    }

    /**
     * 玩家被击败：不退出关卡，扣一笔金币后按公式复活继续打同一个敌人。
     * 复活血量 = hp_origin / a（a = 死亡次数，a 最多算到 5，也就是不低于 20%）。
     */
    private onPlayerDown(): void {
        const battle = this.battle;
        const player = this.playerUnit;
        if (!battle || !player) return;

        this.deaths += 1;
        this.applyGold(-REVIVE_GOLD_COST, '复活扣款');

        const hp = reviveHp(player.maxHp, this.deaths);
        this.log(`第 ${this.deaths} 次被击败，按 ${hp} 血复活`);
        if (isInDebt(this.gold)) {
            this.log(`金币 ${formatGold(this.gold)}，进入负债：每分钟扣负债的利息`);
        }
        // 死亡也给 3 倍基础经验
        this.gainExperience(3 * (this.level ? this.level.Exp : 0), '被击败补偿');

        // 先同步到界面，0.9 秒后真正恢复战斗
        player.hp = hp;
        player.dead = false;
        this.setAttackStatus(`复活中…（${hp} / ${player.maxHp}）`);
        this.setDefenseStatus('');
        this.refreshAll();

        const runId = this.runId;
        this.scheduleOnce(() => {
            if (runId !== this.runId || !battle) return;
            battle.revive(hp);
            this.setAttackStatus('复活完成');
            this.refreshAll();
        }, 0.9);
    }

    // ---------------- 界面刷新 ----------------

    private refreshAll(): void {
        this.refreshPlayer();
        this.refreshEnemy();
        this.refreshLevel();
        this.refreshCombatValues();
        this.refreshStatusLines();
    }

    private refreshPlayer(): void {
        const player = this.playerUnit;
        const config = this.config;
        if (!this.playerText || !this.terminalText) return;

        if (!player || !config) {
            this.playerText.string = '——';
            this.terminalText.string = '';
            this.refreshEquipButtons();
            this.refreshGoldText();
            this.refreshProgressText();
            this.refreshPnl();
            return;
        }

        const base = config.player;
        this.playerText.string = [
            `生命  ${player.hp} / ${player.maxHp}`,
            `攻击  ${player.atk}${bonusText(player.atk - base.Atk)}    防御  ${player.def}${bonusText(player.def - base.Def)}`,
            `敏捷  ${player.agility}${bonusText(player.agility - base.Agility)}    攻速 ${player.speed.toFixed(1)}s   防速 ${player.defGap.toFixed(1)}s`,
        ].join('\n');
        this.terminalText.string = this.logs.join('\n');
        this.refreshEquipButtons();
        this.refreshGoldText();
        this.refreshProgressText();
        this.refreshPnl();
    }

    /** 等级 / 经验那一行 */
    private refreshProgressText(): void {
        if (this.playerTitle) this.playerTitle.string = `玩家 · 存档 ${this.slotIndex}`;
        if (!this.progressText) return;
        const level = this.charProgress.level;
        this.progressText.string = `Lv.${level}   经验 ${this.charProgress.exp} / ${expToNext(level)}`;
    }

    /** 金币那一行：负数就变红，并标出每分钟利息 */
    private refreshGoldText(): void {
        if (!this.goldText) return;
        if (isInDebt(this.gold)) {
            const rate = this.effects.lowInterest ? DEBT_INTEREST_RATE - 0.015 : DEBT_INTEREST_RATE;
            this.goldText.string = `金币  ${formatGold(this.gold)}（负债 ${interestAmount(this.gold, rate)}/分钟）`;
            this.goldText.color = COLOR_DEBT;
        } else {
            this.goldText.string = `金币  ${formatGold(this.gold)}`;
            this.goldText.color = COLOR_TEXT;
        }
    }

    /** 记录一次金币变动，并重画盈亏折线 */
    private recordPnl(): void {
        if (this.phase !== 'battle') {
            this.refreshPnl();
            return;
        }
        const value = this.gold - this.goldAtLevelStart;
        const last = this.pnlPoints[this.pnlPoints.length - 1];
        if (!last || last.v !== value) {
            this.pnlPoints.push({ t: this.levelSeconds, v: value });
            while (this.pnlPoints.length > 400) this.pnlPoints.shift();
        }
        this.refreshPnl();
    }

    /** 本关盈亏 + 当前金币倍率 + 折线图 */
    private refreshPnl(): void {
        const inLevel = this.phase === 'battle';
        const pnl = inLevel ? this.gold - this.goldAtLevelStart : 0;
        if (this.pnlText) {
            this.pnlText.string = inLevel ? `本关盈亏  ${signedGold(pnl)}` : '本关盈亏  ——';
            this.pnlText.color = pnl < 0 ? COLOR_DEBT : (pnl > 0 ? COLOR_PROFIT : COLOR_TEXT);
        }
        if (this.multText) {
            this.multText.string = `倍率 ${goldMultiplier(this.deaths).toFixed(2)}x`;
        }
        this.drawPnlChart();
    }

    /** 画盈亏折线：横轴是本关经过的时间，纵轴是累计盈亏，中间灰线是 0 */
    private drawPnlChart(): void {
        const grid = this.pnlGrid;
        const line = this.pnlLine;
        if (!grid || !line) return;
        grid.clear();
        line.clear();
        if (this.phase !== 'battle' || this.pnlPoints.length < 2) return;

        const halfW = CHART_W / 2;
        const halfH = CHART_H / 2;
        let maxV = 0;
        let minV = 0;
        for (const p of this.pnlPoints) {
            if (p.v > maxV) maxV = p.v;
            if (p.v < minV) minV = p.v;
        }
        if (maxV === minV) maxV = minV + 1;
        const maxT = Math.max(1, this.pnlPoints[this.pnlPoints.length - 1].t);
        const toX = (t: number): number => -halfW + (t / maxT) * CHART_W;
        const toY = (v: number): number => ((v - minV) / (maxV - minV)) * CHART_H - halfH;

        grid.strokeColor = COLOR_TEXT_DIM;
        grid.lineWidth = 1;
        grid.rect(-halfW, -halfH, CHART_W, CHART_H);
        grid.moveTo(-halfW, toY(0));
        grid.lineTo(halfW, toY(0));
        grid.stroke();

        const lastValue = this.pnlPoints[this.pnlPoints.length - 1].v;
        line.strokeColor = lastValue < 0 ? COLOR_DEBT : COLOR_PROFIT;
        line.lineWidth = 2;
        for (let i = 0; i < this.pnlPoints.length; i += 1) {
            const p = this.pnlPoints[i];
            const x = toX(p.t);
            const y = toY(p.v);
            if (i === 0) line.moveTo(x, y);
            else line.lineTo(x, y);
        }
        line.stroke();
    }

    private refreshEquipButtons(): void {
        const config = this.config;
        if (!this.weaponButton || !this.armorButton) return;
        const weapon = config ? equipmentName(config.equipments, equippedId(this.equipState, 'weapon')) : '';
        const armor = config ? equipmentName(config.equipments, equippedId(this.equipState, 'armor')) : '';
        this.weaponButton.label.string = `武器：${weapon || '空'}`;
        this.armorButton.label.string = `护甲：${armor || '空'}`;
        if (this.stratButton) {
            const equipped = this.charProgress.slots.filter((id) => !!id).length;
            this.stratButton.label.string = `策略 ${equipped}/${MAX_SLOTS}`;
        }
    }

    private refreshEnemy(): void {
        if (!this.enemyTitle || !this.enemyText) return;
        const battle = this.battle;
        if (!battle) {
            this.enemyTitle.string = '敌人 / 关卡';
            this.enemyText.string = '——';
            this.setEnemyStatus('');
            return;
        }
        const enemy = battle.enemy;
        const bossTag = this.spawnedBoss ? '【BOSS】' : '';
        this.enemyTitle.string = `敌人 · ${enemy.name}${bossTag}`;
        this.enemyText.string = [
            `生命  ${enemy.hp} / ${enemy.maxHp}`,
            `攻击  ${enemy.atk}      防御  ${enemy.def}`,
            `敏捷  ${enemy.agility}      封锁  ${enemy.blockade}`,
        ].join('\n');
        this.refreshStatusLines();
    }

    private refreshLevel(): void {
        if (!this.levelText) return;
        const level = this.level;
        this.levelText.string = [
            `关卡  ${level ? this.levelName() : '——'}`,
            `难度  ${level ? level.diff : '-'}`,
            `击杀  ${this.kills}     距 BOSS  ${level ? bossRemaining(this.progress) : '-'}`,
            `掉落  ${this.lastDrop}`,
        ].join('\n');
    }

    /** 两个色子面板里的「当前值 + 拼点成功率」 */
    private refreshCombatValues(): void {
        const battle = this.battle;
        if (!this.attackChance || !this.defenseChance) return;
        if (!battle) {
            this.attackChance.string = '';
            this.defenseChance.string = '';
            if (this.attackDamage) this.attackDamage.string = '';
            if (this.defenseValue) this.defenseValue.string = '';
            return;
        }
        const player = battle.player;
        const enemy = battle.enemy;
        const atk = hitChance(player.agility, enemy.agility, battle.diff);
        const def = hitChance(player.agility, enemy.blockade, battle.diff);
        if (this.attackDamage) this.attackDamage.string = `伤害 ${calcDamage(player.atk, enemy.def)}`;
        if (this.defenseValue) this.defenseValue.string = `防御值 ${battle.defense}`;
        this.attackChance.string = `命中率 ${(atk * 100).toFixed(1)}%`;
        this.defenseChance.string = `成功率 ${(def * 100).toFixed(1)}%`;
    }

    /** 每帧刷新的进度文字（蓄力百分比 / 防御倒计时） */
    private refreshStatusLines(): void {
        const battle = this.battle;
        if (!battle) return;
        const player = battle.player;
        const enemy = battle.enemy;

        if (this.attackStatus) {
            if (player.dead) this.attackStatus.string = '玩家阵亡';
            else if (player.acting > 0) this.attackStatus.string = '投骰中…';
            else this.attackStatus.string = `蓄力 ${Math.floor((player.charge / player.speed) * 100)}%`;
        }
        if (this.defenseStatus) {
            if (enemy.dead) this.defenseStatus.string = '敌人已被击败';
            else {
                const left = Math.max(0, player.defGap * (1 - battle.defenseProgress));
                this.defenseStatus.string = `下次防御 ${left.toFixed(1)} 秒`;
            }
        }
        if (this.enemyStatus) {
            if (enemy.dead) this.enemyStatus.string = '已被击败';
            else if (enemy.acting > 0) this.enemyStatus.string = '出手…';
            else this.enemyStatus.string = `蓄力 ${Math.floor((enemy.charge / enemy.speed) * 100)}%`;
        }
    }

    private setAttackStatus(text: string): void {
        if (this.attackStatus) this.attackStatus.string = text;
    }

    private setDefenseStatus(text: string): void {
        if (this.defenseStatus) this.defenseStatus.string = text;
    }

    private setEnemyStatus(text: string): void {
        if (this.enemyStatus) this.enemyStatus.string = text;
    }

    private setDiceIdle(): void {
        for (const label of this.attackDice) label.string = '-';
        for (const label of this.defenseDice) label.string = '-';
        if (this.attackSum) this.attackSum.string = '= ?';
        if (this.defenseSum) this.defenseSum.string = '= ?';
        if (this.attackResult) this.attackResult.string = '';
        if (this.defenseResult) this.defenseResult.string = '';
    }

    private showDice(labels: Label[], sumLabel: Label | null, dice: DiceRoll): void {
        if (labels.length >= 2) {
            labels[0].string = String(dice.a);
            labels[1].string = String(dice.b);
        }
        if (sumLabel) sumLabel.string = `= ${dice.sum}`;
    }

    private levelName(): string {
        const level = this.level;
        if (!level) return this.levelId;
        const name = level.name || this.levelId;
        return name === this.levelId ? name : `${name}（${this.levelId}）`;
    }

    private log(line: string): void {
        this.logs.push(line);
        while (this.logs.length > 6) this.logs.shift();
        this.refreshPlayer();
    }

    private syncCanvasSize(force: boolean): void {
        const canvas = this.node.parent;
        if (!canvas) return;
        const transform = canvas.getComponent(UITransform);
        if (!transform) return;

        const size = transform.contentSize;
        if (!force
            && Math.abs(size.width - this.canvasWidth) < 0.5
            && Math.abs(size.height - this.canvasHeight) < 0.5) {
            return;
        }
        this.canvasWidth = size.width;
        this.canvasHeight = size.height;

        if (!this.root) return;
        const width = this.canvasWidth || BASE_WIDTH;
        const height = this.canvasHeight || BASE_HEIGHT;
        const scale = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
        this.root.setScale(scale, scale, 1);
        this.root.setPosition(0, 0, 0);
    }

    // ---------------- 界面搭建 ----------------

    private buildUi(): void {
        const root = createUINode('UIRoot', this.node);
        setSize(root, BASE_WIDTH, BASE_HEIGHT);
        this.root = root;

        this.buildPlayerPanel(root);
        this.buildInfoPanel(root);
        this.buildAttackPanel(root);
        this.buildDefensePanel(root);
        this.buildButtons(root);
        this.refreshAll();
    }

    private buildPlayerPanel(root: Node): void {
        const { x, y, w, h } = PANEL.player;
        const panel = createPanel(root, 'PlayerPanel', w, h);
        panel.node.setPosition(x, y, 0);

        this.playerTitle = this.leftText(panel.node, '玩家 · 存档 1', -w / 2 + 22, h / 2 - 36, 24, COLOR_TEXT, true);
        this.playerText = this.blockText(panel.node, -w / 2 + 22, h / 2 - 82, w - 44, 18, 26);
        this.progressText = this.leftText(panel.node, 'Lv.1   经验 0 / 100', -w / 2 + 22, 92, 16, COLOR_TEXT, true);
        this.goldText = this.leftText(panel.node, '金币  0', -w / 2 + 22, 66, 17, COLOR_TEXT, true);

        // 本关盈亏 + 当前金币倍率
        this.pnlText = this.leftText(panel.node, '本关盈亏  ——', -w / 2 + 22, 40, 16, COLOR_TEXT, true);
        this.multText = this.rightText(panel.node, '倍率 1.00x', w / 2 - 22, 40, 16, COLOR_MUTED, false);

        // 盈亏折线图（网格 + 折线两个 Graphics，避免描边互相覆盖）
        const chart = createUINode('PnlChart', panel.node);
        setSize(chart, CHART_W, CHART_H);
        chart.setPosition(0, 0, 0);
        const gridNode = createUINode('grid', chart);
        setSize(gridNode, CHART_W, CHART_H);
        this.pnlGrid = gridNode.addComponent(Graphics);
        const lineNode = createUINode('line', chart);
        setSize(lineNode, CHART_W, CHART_H);
        this.pnlLine = lineNode.addComponent(Graphics);

        // 武器 / 护甲 / 策略 三个按钮
        this.weaponButton = createButton(panel.node, 'WeaponButton', '武器：空', 113, 46, () => {
            this.showEquipPopup('weapon');
        }, 15);
        this.weaponButton.node.setPosition(-126, -52, 0);

        this.armorButton = createButton(panel.node, 'ArmorButton', '护甲：空', 113, 46, () => {
            this.showEquipPopup('armor');
        }, 15);
        this.armorButton.node.setPosition(0, -52, 0);

        this.stratButton = createButton(panel.node, 'StrategyButton', `策略 0/${MAX_SLOTS}`, 113, 46, () => {
            this.showStrategyPopup();
        }, 15);
        this.stratButton.node.setPosition(126, -52, 0);

        this.leftText(panel.node, '终端', -w / 2 + 22, -100, 15, COLOR_MUTED, false);
        this.terminalText = this.blockText(panel.node, -w / 2 + 22, -122, w - 44, 13, 17);
    }

    private buildInfoPanel(root: Node): void {
        const { x, y, w, h } = PANEL.info;
        const panel = createPanel(root, 'InfoPanel', w, h);
        panel.node.setPosition(x, y, 0);

        this.enemyTitle = this.leftText(panel.node, '敌人 / 关卡', -w / 2 + 22, h / 2 - 32, 24, COLOR_TEXT, true);
        this.enemyText = this.blockText(panel.node, -w / 2 + 22, h / 2 - 66, 320, 17, 23);
        this.enemyStatus = this.leftText(panel.node, '', -w / 2 + 22, -h / 2 + 26, 15, COLOR_MUTED, false);

        this.divider(panel.node, -22, h - 40);

        this.levelText = this.blockText(panel.node, 2, h / 2 - 32, 296, 17, 23);
    }

    private buildAttackPanel(root: Node): void {
        const { x, y, w, h } = PANEL.attack;
        const panel = createPanel(root, 'AttackPanel', w, h);
        panel.node.setPosition(x, y, 0);

        this.leftText(panel.node, '攻击色子', -w / 2 + 16, h / 2 - 28, 22, COLOR_TEXT, true);

        const dieSize = 44;
        const rowY = 38;
        const firstX = -w / 2 + 16 + dieSize / 2;
        this.attackDice = [
            this.createDie(panel.node, firstX, rowY, dieSize),
            this.createDie(panel.node, firstX + dieSize + 12, rowY, dieSize),
        ];
        this.attackSum = this.centerText(
            panel.node, firstX + (dieSize + 12) + dieSize + 30, rowY, 22, COLOR_TEXT, true, '= ?',
        );
        this.attackResult = this.leftText(panel.node, '', -w / 2 + 16, -6, 18, COLOR_TEXT, true);
        this.attackDamage = this.leftText(panel.node, '', -w / 2 + 16, -34, 17, COLOR_TEXT, true);
        this.attackChance = this.leftText(panel.node, '', -w / 2 + 16, -58, 15, COLOR_MUTED, false);
        this.attackStatus = this.leftText(panel.node, '', -w / 2 + 16, -84, 14, COLOR_MUTED, false);
    }

    private buildDefensePanel(root: Node): void {
        const { x, y, w, h } = PANEL.defense;
        const panel = createPanel(root, 'DefensePanel', w, h);
        panel.node.setPosition(x, y, 0);

        this.leftText(panel.node, '防御色子', -w / 2 + 16, h / 2 - 28, 22, COLOR_TEXT, true);

        const dieSize = 44;
        const rowY = 38;
        const firstX = -w / 2 + 16 + dieSize / 2;
        this.defenseDice = [
            this.createDie(panel.node, firstX, rowY, dieSize),
            this.createDie(panel.node, firstX + dieSize + 12, rowY, dieSize),
        ];
        this.defenseSum = this.centerText(
            panel.node, firstX + (dieSize + 12) + dieSize + 30, rowY, 22, COLOR_TEXT, true, '= ?',
        );
        this.defenseResult = this.leftText(panel.node, '', -w / 2 + 16, -6, 18, COLOR_TEXT, true);
        this.defenseValue = this.leftText(panel.node, '', -w / 2 + 16, -34, 17, COLOR_TEXT, true);
        this.defenseChance = this.leftText(panel.node, '', -w / 2 + 16, -58, 15, COLOR_MUTED, false);
        this.defenseStatus = this.leftText(panel.node, '', -w / 2 + 16, -84, 14, COLOR_MUTED, false);
    }

    private buildButtons(root: Node): void {
        this.exitButton = createButton(root, 'ExitButton', '退出', PANEL.exit.w, PANEL.exit.h, () => this.exitLevel());
        this.exitButton.node.setPosition(PANEL.exit.x, PANEL.exit.y, 0);
        this.exitButton.setEnabled(false);

        this.selectButton = createButton(root, 'SelectButton', '选关', PANEL.select.w, PANEL.select.h, () => {
            this.showLevelPopup();
        });
        this.selectButton.node.setPosition(PANEL.select.x, PANEL.select.y, 0);
        this.selectButton.setEnabled(false);

        this.speedButton = createButton(
            root, 'SpeedButton', speedLabel(this.speedFactor), PANEL.speed.w, PANEL.speed.h,
            () => this.cycleSpeed(), 18,
        );
        this.speedButton.node.setPosition(PANEL.speed.x, PANEL.speed.y, 0);

        this.shopButton = createButton(
            root, 'ShopButton', '商店', PANEL.shop.w, PANEL.shop.h, () => this.showShopPopup(), 18,
        );
        this.shopButton.node.setPosition(PANEL.shop.x, PANEL.shop.y, 0);
        this.shopButton.setEnabled(false);
    }

    /** 点加速按钮：1x -> 1.5x -> 2x -> 3x -> 1x 循环 */
    private cycleSpeed(): void {
        const index = SPEED_STEPS.indexOf(this.speedFactor);
        this.speedFactor = SPEED_STEPS[(index + 1) % SPEED_STEPS.length];
        if (this.speedButton) this.speedButton.label.string = speedLabel(this.speedFactor);
        if (this.playerUnit) this.log(`战斗速度 ${this.speedFactor}x`);
    }

    // ---------------- 弹窗 ----------------

    private openPopup(title: string, width: number, height: number) {
        this.closePopup();
        const popup = createPopup(this.root as Node, title, width, height, () => {
            if (this.popup === popup.layer) this.popup = null;
        });
        this.popup = popup.layer;
        return popup;
    }

    private closePopup(): void {
        const popup = this.popup;
        this.popup = null;
        if (popup && popup.isValid) popup.destroy();
        // 策略列表的引用跟着弹窗一起清掉（滚轮监听要能判断“现在没有列表”）
        this.stratListContent = null;
        this.stratBar = null;
        this.stratTrack = null;
        this.stratRows = [];
        this.stratScroll = 0;
        this.stratMaxScroll = 0;
        this.stratDragOffset = 0;
    }

    /** 选关弹窗：列出 levels.json 里所有关卡 */
    private showLevelPopup(): void {
        const config = this.config;
        if (!config) return;
        const popup = this.openPopup('选择关卡', 560, 460);
        const ids = Object.keys(config.levels);
        const rowHeight = 66;
        const top = (460 - 96) / 2 - 46;
        ids.forEach((id, index) => {
            const level = config.levels[id];
            const bossId = level.boss ? level.boss.enemy : '';
            const bossName = bossId ? lookupName(ENEMY_NAMES, bossId) : '无';
            const bossRange = level.boss ? `（${level.boss.a}~${level.boss.b} 个普通敌人后）` : '';
            const text = `${level.name || id}    难度 ${level.diff}    BOSS ${bossName}${bossRange}`;
            const button = createButton(popup.content, `Level-${id}`, text, 480, rowHeight, () => {
                popup.close();
                this.startLevel(id);
            }, 18);
            button.node.setPosition(0, top - index * (rowHeight + 14), 0);
        });

        const close = createButton(popup.content, 'CloseLevelPopup', '关闭', 480, rowHeight, () => {
            popup.close();
        }, 18);
        close.node.setPosition(0, top - ids.length * (rowHeight + 14), 0);
    }

    /** 装备弹窗：选武器 / 选护甲 */
    private showEquipPopup(slot: EquipSlot): void {
        const config = this.config;
        if (!config) return;
        const popup = this.openPopup(`选择${SLOT_LABEL[slot]}`, 520, 440);
        const ids = ownedForSlot(this.equipState, config.equipments, slot);
        const rowHeight = 62;
        const step = rowHeight + 14;
        let y = (440 - 96) / 2 - 46;

        if (ids.length === 0) {
            this.centerText(popup.content, 0, 20, 18, COLOR_MUTED, false, `还没有${SLOT_LABEL[slot]}，击败 BOSS 可以获得`);
        }
        for (const id of ids) {
            const cfg = config.equipments[id];
            const equipped = equippedId(this.equipState, slot) === id;
            const text = `${cfg.name}    ${equipmentSummary(cfg)}${equipped ? '    （已装备）' : ''}`;
            const button = createButton(popup.content, `Equip-${id}`, text, 440, rowHeight, () => {
                this.equipState = equipItem(this.equipState, config.equipments, id);
                saveEquipmentState(this.equipState);
                popup.close();
                this.refreshAll();
            }, 18);
            button.node.setPosition(0, y, 0);
            y -= step;
        }

        const off = createButton(popup.content, 'Unequip', '卸下当前装备', 440, rowHeight, () => {
            this.equipState = unequipSlot(this.equipState, slot);
            saveEquipmentState(this.equipState);
            popup.close();
            this.refreshAll();
        }, 18);
        off.node.setPosition(0, y, 0);
        y -= step;

        const close = createButton(popup.content, 'CloseEquipPopup', '关闭', 440, rowHeight, () => {
            popup.close();
        }, 18);
        close.node.setPosition(0, y, 0);
    }

    /** 策略弹窗：5 个槽位 + 已获得但没装的策略 */
    private showStrategyPopup(): void {
        const popup = this.openPopup('策略', 640, 600);
        const slots = this.charProgress.slots;
        const equipped = slots.filter((id) => !!id).length;
        this.centerText(popup.content, 0, 196, 17, COLOR_TEXT, true,
            `已装备 ${equipped} / ${MAX_SLOTS}      等级 Lv.${this.charProgress.level}`);

        // 5 个槽位（点一下卸下）
        const slotW = 110;
        const gap = 12;
        const totalW = MAX_SLOTS * slotW + (MAX_SLOTS - 1) * gap;
        for (let i = 0; i < MAX_SLOTS; i += 1) {
            const id = slots[i];
            const text = id ? strategyName(id) : `槽位 ${i + 1}`;
            const button = createButton(popup.content, `Slot-${i}`, text, slotW, 56, () => {
                if (!id) return;
                slots[i] = null;
                this.applyStrategyChange(`卸下 ${strategyName(id)}`);
            }, 14);
            button.node.setPosition(-totalW / 2 + slotW / 2 + i * (slotW + gap), 130, 0);
        }

        // 已获得但没装的策略：放在可滚动列表里（滚轮上下滚）
        this.centerText(popup.content, 0, 82, 14, COLOR_MUTED, false,
            '拥有的策略（点击装进空槽 · 滚轮或拖动右侧滑块滚动）');
        const unused = this.charProgress.owned.filter((id) => slots.indexOf(id) < 0);

        const viewport = createUINode('StrategyList', popup.content);
        setSize(viewport, STRAT_LIST_W, STRAT_LIST_H);
        viewport.setPosition(0, STRAT_LIST_Y, 0);
        viewport.addComponent(Mask).type = Mask.Type.GRAPHICS_RECT;

        const contentHeight = Math.max(STRAT_LIST_H, unused.length * STRAT_ROW_STEP);
        const content = createUINode('content', viewport);
        setSize(content, STRAT_LIST_W, contentHeight);
        setAnchor(content, 0.5, 1);
        this.stratListContent = content;

        // 右侧滚动条：槽 + 滑块，同时兼作拖动用的热区（比只画 8px 好抓）
        const track = createUINode('ScrollTrack', viewport);
        setSize(track, STRAT_TRACK_W, STRAT_LIST_H);
        track.setPosition(STRAT_LIST_W / 2 - STRAT_TRACK_W / 2, 0, 0);
        this.stratTrack = track;
        this.stratBar = track.addComponent(Graphics);
        track.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
            event.propagationStopped = true;
            this.startTrackDrag(event);
        }, this);
        track.on(Node.EventType.TOUCH_MOVE, (event: EventTouch) => {
            event.propagationStopped = true;
            this.dragTrack(event);
        }, this);
        track.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
            event.propagationStopped = true;
        }, this);

        this.stratRows = [];
        if (unused.length === 0) {
            this.centerText(content, 0, -STRAT_LIST_H / 2, 15, COLOR_MUTED, false,
                '没有可装备的策略：每升 2 级随机获得一个');
        }
        for (let i = 0; i < unused.length; i += 1) {
            const id = unused[i];
            const def = Object.prototype.hasOwnProperty.call(STRATEGY_BY_ID, id) ? STRATEGY_BY_ID[id] : null;
            const text = def ? `${def.name}    ${def.desc}` : id;
            const button = createButton(content, `Own-${id}`, text, STRAT_LIST_W - 34, 40, () => {
                const empty = slots.indexOf(null);
                if (empty < 0) {
                    this.log('策略槽满了，先点上面的槽位卸下一个');
                    return;
                }
                slots[empty] = id;
                this.applyStrategyChange(`装备 ${strategyName(id)}`);
            }, 13);
            // 下拉菜单的行一般都是左对齐的
            button.label.horizontalAlign = Label.HorizontalAlign.LEFT;
            button.node.setPosition(0, -STRAT_ROW_STEP / 2 - i * STRAT_ROW_STEP, 0);
            this.stratRows.push(button.node);
        }

        this.stratScroll = 0;
        this.stratMaxScroll = Math.max(0, contentHeight - STRAT_LIST_H);
        this.applyStrategyScroll();

        const close = createButton(popup.content, 'CloseStrategy', '关闭', 560, 36, () => popup.close(), 16);
        close.node.setPosition(0, -232, 0);
    }

    /** 滚轮：`getScrollY()` 向上为正，所以往下滚(delta<0)时 stratScroll 变大 = 列表往下翻 */
    private onMouseWheel(event: EventMouse): void {
        if (!this.popup || !this.stratListContent || this.stratMaxScroll <= 0) return;
        const delta = event.getScrollY();
        if (!delta) return;
        this.stratScroll += delta > 0 ? -STRAT_ROW_STEP : STRAT_ROW_STEP;
        this.applyStrategyScroll();
    }

    /** 滑块高度：内容越多滑块越短（最少 24） */
    private strategyThumbHeight(): number {
        if (this.stratMaxScroll <= 0) return STRAT_LIST_H;
        const total = STRAT_LIST_H + this.stratMaxScroll;
        return Math.max(24, (STRAT_LIST_H * STRAT_LIST_H) / total);
    }

    /** 滑块中心在滚动槽里的局部 y */
    private strategyThumbCenter(): number {
        const half = STRAT_LIST_H / 2;
        const thumbH = this.strategyThumbHeight();
        const range = Math.max(1, STRAT_LIST_H - thumbH);
        const ratio = this.stratMaxScroll > 0 ? this.stratScroll / this.stratMaxScroll : 0;
        return half - ratio * range - thumbH / 2;
    }

    /** 按住滚动条：记下手指和滑块中心的偏移，再直接点一下也能跳过去 */
    private startTrackDrag(event: EventTouch): void {
        const local = this.trackLocalY(event);
        if (local === null) return;
        this.stratDragOffset = local - this.strategyThumbCenter();
        this.dragTrack(event);
    }

    /** 拖动滚动条：滑块中心跟着鼠标走 */
    private dragTrack(event: EventTouch): void {
        if (this.stratMaxScroll <= 0) return;
        const local = this.trackLocalY(event);
        if (local === null) return;
        const half = STRAT_LIST_H / 2;
        const thumbH = this.strategyThumbHeight();
        const range = Math.max(1, STRAT_LIST_H - thumbH);
        const center = local - this.stratDragOffset;
        const ratio = Math.min(1, Math.max(0, (half - thumbH / 2 - center) / range));
        this.stratScroll = ratio * this.stratMaxScroll;
        this.applyStrategyScroll();
    }

    /** 触摸点换算到滚动槽的局部坐标 y（超出范围返回 null） */
    private trackLocalY(event: EventTouch): number | null {
        const track = this.stratTrack;
        if (!track || !track.isValid) return null;
        const transform = track.getComponent(UITransform);
        if (!transform) return null;
        const ui = event.getUILocation();
        const local = transform.convertToNodeSpaceAR(new Vec3(ui.x, ui.y, 0));
        return local.y;
    }

    /** 把滚动量套到列表上：移动内容、隐藏滚出视口的行、重画滚动条 */
    private applyStrategyScroll(): void {
        const content = this.stratListContent;
        if (!content || !content.isValid) return;
        this.stratScroll = Math.max(0, Math.min(this.stratMaxScroll, this.stratScroll));
        // 内容锚点在顶部：往下滚 = 内容整体上移（y 变大），露出下面几条
        content.setPosition(0, STRAT_LIST_H / 2 + this.stratScroll, 0);

        // Mask 只裁渲染不裁点击，滚出视口的行要一起关掉
        const half = STRAT_LIST_H / 2;
        for (const row of this.stratRows) {
            if (!row.isValid) continue;
            const y = row.position.y + content.position.y;
            row.active = y + 20 > -half && y - 20 < half;
        }

        const bar = this.stratBar;
        if (!bar || !bar.node.isValid) return;
        bar.clear();
        if (this.stratMaxScroll <= 0) return; // 不用滚就不画滚动条
        // 槽
        bar.fillColor = new Color(228, 228, 228, 255);
        bar.rect(-5, -half, 10, STRAT_LIST_H);
        bar.fill();
        // 滑块
        const thumbH = this.strategyThumbHeight();
        const center = this.strategyThumbCenter();
        bar.fillColor = new Color(140, 140, 140, 255);
        bar.rect(-5, center - thumbH / 2, 10, thumbH);
        bar.fill();
    }

    /** 装备/卸下策略：存盘 + 重建效果（从下一场战斗开始生效） */
    private applyStrategyChange(message: string): void {
        saveProgress(this.charProgress);
        this.effects = buildEffects(this.charProgress.slots);
        this.log(`${message}（下一场战斗生效）`);
        this.refreshAll();
        this.scheduleOnce(() => this.showStrategyPopup(), 0);
    }

    /** 商店：不在关卡里的时候才能买东西（目前只卖装备） */
    private showShopPopup(): void {
        const config = this.config;
        if (!config) return;
        if (this.phase === 'battle') {
            this.log('关卡中不能进商店，先点「退出」');
            return;
        }

        const popup = this.openPopup('商店', 560, 480);
        const debt = isInDebt(this.gold);
        this.centerText(
            popup.content, 0, 116, 17, debt ? COLOR_DEBT : COLOR_TEXT, true,
            debt ? `金币 ${formatGold(this.gold)}（负债中，无法购买）` : `金币 ${this.gold}`,
        );

        const rowHeight = 62;
        const step = rowHeight + 14;
        let y = 58;
        for (const id of Object.keys(config.equipments)) {
            const cfg = config.equipments[id];
            const price = cfg.price || 0;
            const owned = hasEquipment(this.equipState, id);
            const afford = !debt && this.gold >= price;
            let text = `${cfg.name}    ${equipmentSummary(cfg)}    价格 ${price}`;
            if (owned) text = `${cfg.name}    ${equipmentSummary(cfg)}    已拥有`;
            else if (debt) text = `${cfg.name}    ${equipmentSummary(cfg)}    负债中无法购买`;
            else if (!afford) text = `${cfg.name}    ${equipmentSummary(cfg)}    金币不足（需 ${price}）`;

            const button = createButton(popup.content, `Shop-${id}`, text, 480, rowHeight, () => {
                if (this.buyEquipment(id)) this.scheduleOnce(() => this.showShopPopup(), 0);
            }, 17);
            button.node.setPosition(0, y, 0);
            button.setEnabled(!owned && afford);
            y -= step;
        }

        const close = createButton(popup.content, 'CloseShop', '关闭', 480, rowHeight, () => popup.close(), 17);
        close.node.setPosition(0, y, 0);
    }

    /** 买一件装备：成功返回 true（商店会刷新） */
    private buyEquipment(id: string): boolean {
        const config = this.config;
        if (!config) return false;
        const cfg = config.equipments[id];
        if (!cfg) return false;
        const price = cfg.price || 0;
        if (isInDebt(this.gold)) {
            this.log('负债中，无法购买');
            return false;
        }
        if (hasEquipment(this.equipState, id)) {
            this.log(`已经拥有 ${cfg.name}`);
            return false;
        }
        if (this.gold < price) {
            this.log(`金币不足：${cfg.name} 需要 ${price}`);
            return false;
        }

        this.gold -= price;
        saveGold(this.gold);
        this.equipState = ownEquipment(this.equipState, id);
        saveEquipmentState(this.equipState);
        this.log(`购买 ${cfg.name}，花费 ${price} 金币（剩余 ${this.gold}）`);
        this.refreshAll();
        return true;
    }

    // ---------------- 小工具 ----------------

    private divider(parent: Node, x: number, height: number): void {
        const node = createUINode('divider', parent);
        setSize(node, 2, height);
        const gfx = node.addComponent(Graphics);
        gfx.fillColor = new Color(205, 205, 205, 255);
        gfx.rect(-1, -height / 2, 2, height);
        gfx.fill();
        node.setPosition(x, 0, 0);
    }

    /** 左对齐单行文字，锚点在左边中点 */
    private leftText(
        parent: Node, text: string, x: number, y: number,
        fontSize: number, color: Color, bold = false,
    ): Label {
        return this.text(parent, { x, y, anchor: [0, 0.5], text, fontSize, color, bold });
    }

    /** 居中对齐单行文字 */
    private centerText(
        parent: Node, x: number, y: number,
        fontSize: number, color: Color, bold = false, text = '',
    ): Label {
        return this.text(parent, { x, y, anchor: [0.5, 0.5], text, fontSize, color, bold });
    }

    /** 右对齐单行文字，锚点在右边中点 */
    private rightText(
        parent: Node, text: string, x: number, y: number,
        fontSize: number, color: Color, bold = false,
    ): Label {
        const label = createText(parent, text, { fontSize, color, bold, align: 'right' });
        setAnchor(label.node, 1, 0.5);
        label.node.setPosition(x, y, 0);
        return label;
    }

    /** 自动换行的文字块，锚点在左上角，高度随内容增长 */
    private blockText(
        parent: Node, x: number, y: number,
        width: number, fontSize: number, lineHeight: number, color?: Color,
    ): Label {
        const label = createText(parent, '', {
            fontSize, lineHeight, width, align: 'left', valign: 'top', color, wrap: true,
        });
        setAnchor(label.node, 0, 1);
        label.node.setPosition(x, y, 0);
        return label;
    }

    private text(
        parent: Node,
        options: TextOptions & { x: number; y: number; anchor: [number, number]; text: string },
    ): Label {
        const label = createText(parent, options.text, {
            fontSize: options.fontSize,
            color: options.color,
            bold: options.bold,
            align: options.anchor[0] === 0.5 ? 'center' : 'left',
            valign: 'center',
        });
        setAnchor(label.node, options.anchor[0], options.anchor[1]);
        label.node.setPosition(options.x, options.y, 0);
        return label;
    }

    private createDie(parent: Node, x: number, y: number, size: number): Label {
        const panel = createPanel(parent, 'Die', size, size);
        panel.node.setPosition(x, y, 0);
        return this.centerText(panel.node, 0, 0, 24, COLOR_TEXT, true, '-');
    }
}

/** 加速按钮上的文字：加速 1x / 1.5x / 2x / 3x */
function speedLabel(factor: number): string {
    return `加速 ${factor}x`;
}

/** 盈亏数字：+240 / -80 / 0 */
function signedGold(value: number): string {
    return value > 0 ? `+${value}` : String(value);
}

/** 把增益差值格式化成 “(+2)” / “(-1)” */
function bonusText(delta: number): string {
    if (!delta) return '';
    return delta > 0 ? `  (+${delta})` : `  (${delta})`;
}

/**
 * 兜底：正常情况下 Canvas/Game 节点上已经挂了这个组件；
 * 万一场景里丢了脚本（例如手动改过 uuid），进场景后自动补挂一个，保证游戏还能跑。
 */
director.once(Director.EVENT_AFTER_SCENE_LAUNCH, () => {
    const scene = director.getScene();
    const canvas = scene ? scene.getChildByName('Canvas') : null;
    if (!canvas || canvas.getComponentInChildren(BattleGame)) return;

    const game = new Node('Game');
    game.layer = Layers.Enum.UI_2D;
    game.addComponent(UITransform).setContentSize(BASE_WIDTH, BASE_HEIGHT);
    canvas.addChild(game);
    game.addComponent(BattleGame);
});
