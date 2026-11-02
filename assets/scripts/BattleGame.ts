import {
    _decorator, Color, Component, Director, director, Graphics, Label, Layers, Node, UITransform,
} from 'cc';
import {
    Battle, bossRemaining, calcDamage, createUnit, hitChance, newLevelProgress, pickEnemy, progressAfterBossKill,
    progressAfterNormalKill, rollDrop, DROP_EFFECTS,
} from './BattleCore';
import type {
    BattleEvent, DiceRoll, DropEffect, EnemyConfig, LevelConfig, LevelProgress, Unit,
} from './BattleCore';
import { loadGameConfig } from './Config';
import type { GameConfig } from './Config';
import {
    calcEquipBonus, equipItem, equipmentName, equipmentSummary, equippedId, hasEquipment, loadEquipmentState,
    ownEquipment, ownedForSlot, saveEquipmentState, unequipSlot, SLOT_LABEL,
} from './Equipment';
import type { EquipSlot, EquipmentState } from './Equipment';
import {
    ButtonView, COLOR_MUTED, COLOR_TEXT, TextOptions, createButton, createPanel, createPopup, createText,
    createUINode, setAnchor, setSize,
} from './UIFactory';

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
};

/** 敌人 id -> 中文名（只用于显示，取不到就直接显示 id） */
const ENEMY_NAMES: { [id: string]: string } = {
    fox: '狐狸',
    wolf: '狼',
    bat: '蝙蝠',
    robot: '机器人',
    builder: '建造者',
    fox_king: '狐狸王',
    factory_overseer: '工厂监督者',
};

/** 击败敌人后，隔多久刷新下一个敌人（秒） */
const NEXT_ENEMY_DELAY = 0.9;

/** 单帧最大步长，避免切后台回来时战斗瞬间跑完 */
const MAX_STEP = 0.1;

type Phase = 'loading' | 'select' | 'battle' | 'defeat';

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

    // ---------------- 生命周期 ----------------

    protected start(): void {
        this.buildUi();
        this.syncCanvasSize(true);
        void this.bootstrap();
    }

    protected update(dt: number): void {
        this.syncCanvasSize(false);
        if (this.phase !== 'battle' || !this.battle || this.battle.finished) return;

        const events = this.battle.update(Math.min(dt, MAX_STEP));
        for (const event of events) this.onBattleEvent(event);
        this.refreshStatusLines();
    }

    // ---------------- 启动 / 流程 ----------------

    private async bootstrap(): Promise<void> {
        this.equipState = loadEquipmentState();
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

    /** 配置读不出来时把原因显示在敌人面板上（比只打进控制台更容易看到） */
    private showConfigError(message: string): void {
        this.phase = 'loading';
        this.selectButton?.setEnabled(false);
        this.exitButton?.setEnabled(false);
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
        this.progress = newLevelProgress(level.boss, Math.random);

        const base = config.player;
        this.playerUnit = createUnit({
            side: 'player',
            id: 'player',
            name: '玩家',
            hp: base.Hp,
            maxHp: base.Hp,
            atk: base.Atk,
            def: base.Def,
            agility: base.Agility,
            speed: base.Speed,
            atkGap: base.Atk_gap,
            defGap: base.def_gap,
        });

        this.closePopup();
        this.selectButton?.setEnabled(true);
        this.exitButton?.setEnabled(true);
        this.log(`进入关卡 ${this.levelName()}`);
        this.log(`BOSS 倒计时：再击败 ${bossRemaining(this.progress)} 个普通敌人`);
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

        // 装备 + 「下一场战斗」增益一起合进来（战斗开始时生效）
        const bonus = calcEquipBonus(this.equipState, config.equipments);
        player.atk = config.player.Atk + this.playerMods.atk + bonus.atk;
        player.def = config.player.Def + bonus.def;
        player.agility = config.player.Agility + this.playerMods.agility + bonus.agility;
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
            case 'end':
                if (event.winner === 'player') this.onEnemyDefeated();
                else this.onPlayerDefeated();
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
        }, NEXT_ENEMY_DELAY);
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

    /** 玩家阵亡：弹窗，退出关卡 */
    private onPlayerDefeated(): void {
        this.phase = 'defeat';
        this.selectButton?.setEnabled(true);
        this.exitButton?.setEnabled(true);
        this.setAttackStatus('玩家阵亡');
        this.setDefenseStatus('');
        this.refreshAll();
        this.showDefeatPopup();
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
            return;
        }

        const base = config.player;
        this.playerText.string = [
            `生命  ${player.hp} / ${player.maxHp}`,
            `攻击  ${player.atk}${bonusText(player.atk - base.Atk)}`,
            `防御  ${player.def}${bonusText(player.def - base.Def)}`,
            `敏捷  ${player.agility}${bonusText(player.agility - base.Agility)}`,
            `攻击间隔  ${player.speed.toFixed(1)} 秒`,
            `防御间隔  ${player.defGap.toFixed(1)} 秒`,
        ].join('\n');
        this.terminalText.string = this.logs.join('\n');
        this.refreshEquipButtons();
    }

    private refreshEquipButtons(): void {
        const config = this.config;
        if (!this.weaponButton || !this.armorButton) return;
        const weapon = config ? equipmentName(config.equipments, equippedId(this.equipState, 'weapon')) : '';
        const armor = config ? equipmentName(config.equipments, equippedId(this.equipState, 'armor')) : '';
        this.weaponButton.label.string = `武器：${weapon || '空'}`;
        this.armorButton.label.string = `护甲：${armor || '空'}`;
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
        while (this.logs.length > 10) this.logs.shift();
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

        this.leftText(panel.node, '玩家', -w / 2 + 22, h / 2 - 36, 26, COLOR_TEXT, true);
        this.playerText = this.blockText(panel.node, -w / 2 + 22, h / 2 - 82, w - 44, 18, 26);

        this.weaponButton = createButton(panel.node, 'WeaponButton', '武器：空', 178, 50, () => {
            this.showEquipPopup('weapon');
        }, 18);
        this.weaponButton.node.setPosition(-w / 2 + 111, -8, 0);

        this.armorButton = createButton(panel.node, 'ArmorButton', '护甲：空', 178, 50, () => {
            this.showEquipPopup('armor');
        }, 18);
        this.armorButton.node.setPosition(-w / 2 + 297, -8, 0);

        this.leftText(panel.node, '终端', -w / 2 + 22, -52, 16, COLOR_MUTED, false);
        this.terminalText = this.blockText(panel.node, -w / 2 + 22, -78, w - 44, 13, 18);
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

    /** 战败弹窗 */
    private showDefeatPopup(): void {
        const popup = this.openPopup('战斗失败', 480, 300);
        this.centerText(popup.content, 0, 40, 18, COLOR_MUTED, false,
            `你在「${this.levelName()}」中被击败`);
        this.centerText(popup.content, 0, 4, 18, COLOR_MUTED, false, `共击败 ${this.kills} 个敌人`);
        const button = createButton(popup.content, 'ExitLevel', '退出关卡', 260, 68, () => {
            popup.close();
            this.exitLevel();
        });
        button.node.setPosition(0, -70, 0);
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
