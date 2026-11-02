import {
    _decorator, Color, Component, Director, director, Graphics, Label, Layers, Node, UITransform,
} from 'cc';
import {
    Battle, createUnit, pickEnemy, rollDrop, DROP_EFFECTS,
} from './BattleCore';
import type {
    BattleEvent, DiceRoll, DropEffect, LevelConfig, Unit,
} from './BattleCore';
import { loadGameConfig } from './Config';
import type { GameConfig } from './Config';
import {
    ButtonView, COLOR_MUTED, COLOR_TEXT, TextOptions, createButton, createPanel, createText,
    createUINode, setAnchor, setSize,
} from './UIFactory';

const { ccclass } = _decorator;

/** 设计基准尺寸：所有面板坐标都基于它，运行时整体等比缩放适配屏幕 */
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 800;

/**
 * 敌人 id -> 中文名（只用于显示，取不到就直接显示 id）。
 * 注意：键名不要用 constructor / __proto__ / prototype，Cocos 的序列化会把带这些键的对象
 * 当成非普通对象，导致配置导入为空（enemies.json 里已经踩过一次）。
 */
const ENEMY_NAMES: { [id: string]: string } = {
    fox: '狐狸',
    wolf: '狼',
    bat: '蝙蝠',
    robot: '机器人',
    builder: '建造者',
};

/** 安全地从映射表里取名（id 撞上 Object 原型成员时也不会取到奇怪的东西） */
function lookupName(table: { [id: string]: string }, id: string): string {
    return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : id;
}

/** 击败敌人后，隔多久刷新下一个敌人（秒） */
const NEXT_ENEMY_DELAY = 0.9;

/** 单帧最大步长，避免切后台回来时战斗瞬间跑完 */
const MAX_STEP = 0.1;

type Phase = 'loading' | 'select' | 'battle' | 'defeat';

interface Mods {
    atk: number;
    agility: number;
}

/**
 * 主流程组件（挂在 Canvas/Game 节点上）：
 * 选关 -> 自动战斗 -> 击败敌人后随机刷下一个 -> 玩家阵亡时弹窗退出。
 */
@ccclass('BattleGame')
export class BattleGame extends Component {
    // ---------------- 数据 ----------------
    private config: GameConfig | null = null;
    private levelId = '';
    private level: LevelConfig | null = null;
    private battle: Battle | null = null;
    private playerUnit: Unit | null = null;
    /** 下一场战斗才生效的临时增益（掉落物） */
    private playerMods: Mods = { atk: 0, agility: 0 };
    private kills = 0;
    private lastDrop = '——';
    private logs: string[] = [];
    private phase: Phase = 'loading';
    /** 每次进出关卡 +1，用来作废过期的定时器 */
    private runId = 0;

    // ---------------- UI ----------------
    private root: Node | null = null;
    private canvasWidth = 0;
    private canvasHeight = 0;

    private playerText: Label | null = null;
    private playerLogText: Label | null = null;
    private enemyTitle: Label | null = null;
    private enemyText: Label | null = null;
    private enemyStatus: Label | null = null;
    private levelText: Label | null = null;
    private diceValueLabels: Label[] = [];
    private diceSumText: Label | null = null;
    private diceResultText: Label | null = null;
    private diceStatusText: Label | null = null;
    private chooseButton: ButtonView | null = null;
    private endButton: ButtonView | null = null;

    private defeatLayer: Node | null = null;
    private defeatDesc: Label | null = null;

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
        this.refreshEnemyStatus();
    }

    // ---------------- 启动 / 流程 ----------------

    private async bootstrap(): Promise<void> {
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
        this.chooseButton?.setEnabled(false);
        this.endButton?.setEnabled(false);
        if (this.enemyTitle) this.enemyTitle.string = '配置读取失败';
        if (this.enemyText) this.enemyText.string = message;
        if (this.enemyStatus) this.enemyStatus.string = '';
        this.setStatus('修好配置后重新预览即可');
    }

    /** 点击「选择关卡」：重置玩家并进入关卡 */
    private startLevel(): void {
        const config = this.config;
        if (!config) return;
        const level = config.levels[this.levelId];
        if (!level) {
            this.setStatus(`找不到关卡 ${this.levelId}`);
            return;
        }

        this.runId += 1;
        this.phase = 'battle';
        this.level = level;
        this.kills = 0;
        this.lastDrop = '——';
        this.logs = [];
        this.playerMods = { atk: 0, agility: 0 };

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
        });

        this.hideDefeat();
        this.log(`进入关卡 ${this.levelName()}`);
        this.chooseButton?.setEnabled(false);
        this.endButton?.setEnabled(true);
        this.spawnEnemy();
        this.refreshAll();
        this.setStatus('自动战斗中…');
    }

    /** 点击「结束关卡」或战败弹窗的「退出关卡」：回到选关状态 */
    private exitLevel(): void {
        this.runId += 1;
        this.phase = this.config ? 'select' : 'loading';
        this.battle = null;
        this.level = null;
        this.playerUnit = null;
        this.playerMods = { atk: 0, agility: 0 };
        this.kills = 0;
        this.lastDrop = '——';
        this.logs = [];
        this.hideDefeat();
        this.setDiceIdle();
        this.chooseButton?.setEnabled(!!this.config);
        this.endButton?.setEnabled(false);
        this.refreshAll();
        this.setStatus(this.config ? '点击「选择关卡」进入关卡' : '配置加载中…');
    }

    /** 从当前关卡的 Enemy 权重表里随机刷一个敌人，自动开打 */
    private spawnEnemy(): void {
        const config = this.config;
        const level = this.level;
        const player = this.playerUnit;
        if (!config || !level || !player) return;

        let enemyId: string;
        try {
            enemyId = pickEnemy(level);
        } catch (err) {
            this.setStatus(err instanceof Error ? err.message : String(err));
            return;
        }

        const enemyTable = config.enemies || {};
        const enemyConfig = Object.prototype.hasOwnProperty.call(enemyTable, enemyId)
            ? enemyTable[enemyId]
            : null;
        if (!enemyConfig) {
            console.warn(`[BattleGame] enemies.json 里没有敌人 ${enemyId}`);
            this.setStatus(`enemies.json 里没有敌人 ${enemyId}`);
            return;
        }

        // 把「下一场战斗」的临时增益合进玩家属性，然后清空待生效增益
        player.atk = config.player.Atk + this.playerMods.atk;
        player.agility = config.player.Agility + this.playerMods.agility;
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
        });

        this.battle = new Battle(player, enemy, level.diff, Math.random);
        this.setDiceIdle();
        this.log(`遭遇 ${enemy.name}（生命 ${enemy.hp}）`);
        this.refreshAll();
    }

    // ---------------- 战斗事件 ----------------

    private onBattleEvent(event: BattleEvent): void {
        switch (event.kind) {
            case 'roll':
                this.onRoll(event.name, event.dice);
                break;
            case 'attack':
                this.onAttack(event);
                break;
            case 'end':
                if (event.winner === 'player') this.onEnemyDefeated();
                else this.onPlayerDefeated();
                break;
            default:
                break;
        }
    }

    private onRoll(name: string, dice: DiceRoll): void {
        if (this.diceValueLabels.length >= 2) {
            this.diceValueLabels[0].string = String(dice.a);
            this.diceValueLabels[1].string = String(dice.b);
        }
        if (this.diceSumText) this.diceSumText.string = `= ${dice.sum}`;
        if (this.diceResultText) this.diceResultText.string = '';
        if (this.diceStatusText) this.diceStatusText.string = `${name} 投骰中…（阈值 ${dice.threshold}）`;
    }

    private onAttack(event: Extract<BattleEvent, { kind: 'attack' }>): void {
        const targetName = event.targetSide === 'player' ? '玩家' : '敌人';
        if (event.hit) {
            this.log(`${event.name} 命中，${targetName}受到 ${event.damage} 伤害`);
            if (this.diceResultText) this.diceResultText.string = `命中！造成 ${event.damage} 点伤害`;
        } else {
            this.log(`${event.name} 未命中`);
            if (this.diceResultText) this.diceResultText.string = '未命中';
        }
        if (this.diceStatusText) {
            this.diceStatusText.string = event.targetSide === 'player'
                ? `玩家生命 ${event.targetHp}`
                : `敌人生命 ${event.targetHp}`;
        }
        this.refreshPlayer();
        this.refreshEnemy();
    }

    /** 击败敌人：结算掉落，然后自动刷下一个敌人 */
    private onEnemyDefeated(): void {
        const battle = this.battle;
        if (!battle) return;
        const enemy = battle.enemy;

        this.kills += 1;
        this.log(`击败 ${enemy.name}`);
        this.setStatus('敌人被击败');

        const enemyConfig = this.config ? this.config.enemies[enemy.id] : undefined;
        const dropType = rollDrop(enemyConfig ? enemyConfig.Drop : undefined);
        if (dropType) {
            const effect: DropEffect | undefined = DROP_EFFECTS[dropType];
            if (effect) {
                this.applyDrop(dropType, effect);
            } else {
                this.lastDrop = dropType;
                this.log(`掉落 ${dropType}（未定义效果）`);
            }
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

    /** 玩家阵亡：弹窗，退出关卡 */
    private onPlayerDefeated(): void {
        this.phase = 'defeat';
        this.chooseButton?.setEnabled(false);
        this.endButton?.setEnabled(true);
        this.setStatus('玩家阵亡');
        this.refreshAll();
        this.showDefeat();
    }

    // ---------------- 界面刷新 ----------------

    private refreshAll(): void {
        this.refreshPlayer();
        this.refreshEnemy();
        this.refreshLevel();
    }

    private refreshPlayer(): void {
        const player = this.playerUnit;
        const base = this.config ? this.config.player : null;
        if (!this.playerText || !this.playerLogText) return;

        if (!player || !base) {
            this.playerText.string = '——';
            this.playerLogText.string = '';
            return;
        }

        this.playerText.string = [
            `生命  ${player.hp} / ${player.maxHp}`,
            `法力  ${base.Sp}`,
            `攻击  ${player.atk}${bonusText(player.atk - base.Atk)}`,
            `防御  ${player.def}`,
            `敏捷  ${player.agility}${bonusText(player.agility - base.Agility)}`,
            `速度  ${player.speed.toFixed(1)} 秒/次`,
        ].join('\n');
        this.playerLogText.string = this.logs.join('\n');
    }

    private refreshEnemy(): void {
        if (!this.enemyTitle || !this.enemyText || !this.enemyStatus) return;
        const battle = this.battle;
        if (!battle) {
            this.enemyTitle.string = '敌人';
            this.enemyText.string = '——';
            this.enemyStatus.string = '';
            return;
        }
        const enemy = battle.enemy;
        this.enemyTitle.string = `敌人 · ${enemy.name}`;
        this.enemyText.string = [
            `生命  ${enemy.hp} / ${enemy.maxHp}`,
            `攻击  ${enemy.atk}      防御  ${enemy.def}`,
            `敏捷  ${enemy.agility}      速度  ${enemy.speed.toFixed(1)} 秒/次`,
        ].join('\n');
        this.refreshEnemyStatus();
    }

    private refreshEnemyStatus(): void {
        const battle = this.battle;
        if (!this.enemyStatus || !battle) return;
        const enemy = battle.enemy;
        let status = '';
        if (enemy.dead) {
            status = '已被击败';
        } else if (enemy.acting > 0) {
            status = '投骰中…';
        } else {
            const progress = Math.min(99, Math.floor((enemy.charge / enemy.speed) * 100));
            status = `蓄力 ${progress}%`;
        }
        if (this.enemyStatus.string !== status) this.enemyStatus.string = status;
    }

    private refreshLevel(): void {
        if (!this.levelText) return;
        const level = this.level;
        this.levelText.string = [
            `关卡  ${level ? this.levelName() : '——'}`,
            `难度  ${level ? level.diff : '-'}`,
            `已击败  ${this.kills}`,
            `掉落  ${this.lastDrop}`,
        ].join('\n');
    }

    private levelName(): string {
        const level = this.level;
        if (!level) return this.levelId;
        const name = level.name || this.levelId;
        return name === this.levelId ? name : `${name}（${this.levelId}）`;
    }

    private log(line: string): void {
        this.logs.push(line);
        while (this.logs.length > 5) this.logs.shift();
        this.refreshPlayer();
    }

    private setStatus(text: string): void {
        if (this.diceStatusText) this.diceStatusText.string = text;
    }

    private setDiceIdle(): void {
        for (const label of this.diceValueLabels) label.string = '–';
        if (this.diceSumText) this.diceSumText.string = '= ?';
        if (this.diceResultText) this.diceResultText.string = '';
    }

    // ---------------- 界面搭建 ----------------

    private buildUi(): void {
        const root = createUINode('UIRoot', this.node);
        setSize(root, BASE_WIDTH, BASE_HEIGHT);
        this.root = root;

        this.buildPlayerPanel(root);
        this.buildEnemyPanel(root);
        this.buildLevelPanel(root);
        this.buildDicePanel(root);
        this.buildButtons(root);
        this.buildDefeatLayer(root);
        this.refreshAll();
    }

    /** 左侧：玩家面板 */
    private buildPlayerPanel(root: Node): void {
        const width = 370;
        const height = 480;
        const panel = createPanel(root, 'PlayerPanel', width, height);
        panel.node.setPosition(-330, 83, 0);

        this.leftText(panel.node, '玩家', -width / 2 + 20, height / 2 - 34, 26, COLOR_TEXT, true);
        this.playerText = this.blockText(panel.node, -width / 2 + 20, height / 2 - 80, width - 40, 18, 27);

        this.leftText(panel.node, '战斗记录', -width / 2 + 20, -40, 17, COLOR_MUTED, false);
        this.playerLogText = this.blockText(panel.node, -width / 2 + 20, -72, width - 40, 15, 21);
    }

    /** 右上：敌人面板 */
    private buildEnemyPanel(root: Node): void {
        const width = 650;
        const height = 250;
        const panel = createPanel(root, 'EnemyPanel', width, height);
        panel.node.setPosition(288, 203, 0);

        this.enemyTitle = this.leftText(panel.node, '敌人', -width / 2 + 24, height / 2 - 34, 26, COLOR_TEXT, true);
        this.enemyText = this.blockText(
            panel.node, -width / 2 + 24, height / 2 - 78, width - 48, 19, 30,
        );
        this.enemyStatus = this.leftText(panel.node, '——', -width / 2 + 24, -height / 2 + 36, 17, COLOR_MUTED, false);
    }

    /** 右下偏左：关卡面板 */
    private buildLevelPanel(root: Node): void {
        const width = 310;
        const height = 195;
        const panel = createPanel(root, 'LevelPanel', width, height);
        panel.node.setPosition(142, -55, 0);

        this.leftText(panel.node, '关卡', -width / 2 + 16, height / 2 - 30, 24, COLOR_TEXT, true);
        this.levelText = this.blockText(
            panel.node, -width / 2 + 16, height / 2 - 66, width - 32, 18, 26,
        );
    }

    /** 右下：色子面板 */
    private buildDicePanel(root: Node): void {
        const width = 330;
        const height = 195;
        const panel = createPanel(root, 'DicePanel', width, height);
        panel.node.setPosition(462, -55, 0);

        this.leftText(panel.node, '色子', -width / 2 + 16, height / 2 - 30, 24, COLOR_TEXT, true);

        const dieSize = 46;
        const rowY = 16;
        const firstX = -width / 2 + 16 + dieSize / 2;
        this.diceValueLabels = [
            this.createDie(panel.node, firstX, rowY, dieSize),
            this.createDie(panel.node, firstX + dieSize + 14, rowY, dieSize),
        ];
        this.diceSumText = this.centerText(
            panel.node, firstX + (dieSize + 14) + dieSize + 34, rowY, 24, COLOR_TEXT, true,
        );
        this.diceResultText = this.text(panel.node, {
            x: -width / 2 + 16, y: -34, anchor: [0, 0.5], text: '',
            fontSize: 18, color: COLOR_TEXT, bold: true,
        });
        this.diceStatusText = this.text(panel.node, {
            x: -width / 2 + 16, y: -66, anchor: [0, 0.5], text: '',
            fontSize: 15, color: COLOR_MUTED,
        });
    }

    private buildButtons(root: Node): void {
        this.endButton = createButton(root, 'EndLevelButton', '结束关卡', 410, 130, () => this.exitLevel());
        this.endButton.node.setPosition(-280, -300, 0);
        this.endButton.setEnabled(false);

        this.chooseButton = createButton(root, 'ChooseLevelButton', '选择关卡', 485, 135, () => {
            if (this.phase === 'select') this.startLevel();
        });
        this.chooseButton.node.setPosition(345, -296, 0);
        this.chooseButton.setEnabled(false);
    }

    private buildDefeatLayer(root: Node): void {
        const layer = createUINode('DefeatLayer', root);
        setSize(layer, BASE_WIDTH, BASE_HEIGHT);
        const gfx = layer.addComponent(Graphics);
        gfx.fillColor = new Color(0, 0, 0, 150);
        gfx.rect(-BASE_WIDTH / 2, -BASE_HEIGHT / 2, BASE_WIDTH, BASE_HEIGHT);
        gfx.fill();
        // 吞掉点击，避免点到后面的按钮
        layer.on(Node.EventType.TOUCH_START, () => undefined);

        const panel = createPanel(layer, 'DefeatPanel', 460, 260);
        this.centerText(panel.node, 0, 62, 34, COLOR_TEXT, true, '战斗失败');
        this.defeatDesc = this.centerText(panel.node, 0, 8, 20, COLOR_MUTED, false, '');
        const button = createButton(panel.node, 'ExitButton', '退出关卡', 240, 72, () => this.exitLevel());
        button.node.setPosition(0, -78, 0);

        layer.active = false;
        this.defeatLayer = layer;
    }

    private showDefeat(): void {
        if (this.defeatDesc) {
            this.defeatDesc.string = `在「${this.levelName()}」中被击败\n共击败 ${this.kills} 个敌人`;
        }
        const layer = this.defeatLayer;
        if (!layer) return;
        layer.active = true;
        layer.setSiblingIndex(layer.parent ? layer.parent.children.length - 1 : 0);
    }

    private hideDefeat(): void {
        if (this.defeatLayer) this.defeatLayer.active = false;
    }

    // ---------------- 小工具 ----------------

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
            fontSize, lineHeight, width, align: 'left', valign: 'top', color,
            wrap: true,
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
        return this.centerText(panel.node, 0, 0, 26, COLOR_TEXT, true, '–');
    }

    /** Canvas 尺寸变化时重新适配（整体等比缩放，保持和设计稿一致的比例） */
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
