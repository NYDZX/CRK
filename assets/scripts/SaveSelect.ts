import {
    _decorator, Color, Component, EventKeyboard, EventTouch, Input, KeyCode, Label, Node, UITransform, director,
    input,
} from 'cc';
import {
    COLOR_MUTED, COLOR_TEXT, createButton, createPanel, createPopup, createText, createUINode, setAnchor, setSize,
} from './UIFactory';
import { SLOT_COUNT, START_GOLD, readSlot, resetSlot, setActiveSlot } from './Save';
import { createProgress, saveProgress } from './Progress';
import { createEmptyState, saveEquipmentState } from './Equipment';
import { saveGold } from './Economy';

const { ccclass } = _decorator;

const BASE_WIDTH = 1280;
const BASE_HEIGHT = 800;

/**
 * 存档选择场景（SaveSelect.scene）。
 * 三个存档槽：点整行进入 → 切到 Battle 场景；点右侧 ✕ 删除（先弹确认框）。
 */
@ccclass('SaveSelect')
export class SaveSelect extends Component {
    private root: Node | null = null;
    private popup: Node | null = null;

    protected start(): void {
        this.buildUi();
        input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    }

    protected onDestroy(): void {
        input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
    }

    protected update(): void {
        this.fitCanvas();
    }

    private onKeyUp(event: EventKeyboard): void {
        if (event.keyCode === KeyCode.ESCAPE) this.closePopup();
    }

    /** 1280x800 的设计稿等比缩放到当前画布 */
    private fitCanvas(): void {
        const canvas = this.node.parent;
        if (!canvas || !this.root) return;
        const transform = canvas.getComponent(UITransform);
        if (!transform) return;
        const width = transform.contentSize.width || BASE_WIDTH;
        const height = transform.contentSize.height || BASE_HEIGHT;
        const scale = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
        this.root.setScale(scale, scale, 1);
    }

    private buildUi(): void {
        const root = createUINode('UIRoot', this.node);
        setSize(root, BASE_WIDTH, BASE_HEIGHT);
        this.root = root;
        this.refresh();
    }

    /** 重画整页（删除存档后也走这里） */
    private refresh(): void {
        const root = this.root;
        if (!root) return;
        for (const child of root.children.slice()) child.destroy();

        this.centerText(root, 0, 300, 40, COLOR_TEXT, true, 'CRK · 选择存档');

        for (let i = 0; i < SLOT_COUNT; i += 1) {
            const index = i + 1;
            const info = readSlot(index);
            const panel = createPanel(root, `Slot-${index}`, 720, 120);
            panel.node.setPosition(0, 150 - i * 150, 0);

            const title = info.exists ? `存档 ${index}` : `存档 ${index}（新存档）`;
            this.leftText(panel.node, title, -330, 26, 26, COLOR_TEXT, true);
            const detail = info.exists
                ? `Lv.${info.level}    经验 ${info.exp}    金币 ${info.gold}    策略 ${info.strategies}`
                : `初始 ${START_GOLD} 金币 · 1 级 · 没有策略`;
            this.leftText(panel.node, detail, -330, -24, 18, COLOR_MUTED, false);

            // 点整行 → 进入存档
            panel.node.on(Node.EventType.TOUCH_END, () => this.enterSlot(index));

            // 右侧的 ✕ → 删除（点到自己就停掉冒泡，免得又进存档）
            const close = createPanel(panel.node, `Delete-${index}`, 62, 62);
            close.node.setPosition(322, 0, 0);
            createText(close.node, '×', { fontSize: 36, bold: true, align: 'center', valign: 'center' });
            const stop = (event: EventTouch): void => {
                event.propagationStopped = true;
            };
            close.node.on(Node.EventType.TOUCH_START, stop);
            close.node.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
                stop(event);
                this.confirmDelete(index);
            });
        }

        this.centerText(root, 0, -330, 18, COLOR_MUTED, false, '点击存档进入 · 点右侧 × 删除（删除前会确认）');
    }

    /** 进入存档：空槽先写成新存档（100 金币 / 1 级 / 空装备），然后切到 Battle 场景 */
    private enterSlot(index: number): void {
        const existed = readSlot(index).exists;
        setActiveSlot(index);
        if (!existed) {
            saveGold(START_GOLD);
            saveProgress(createProgress());
            saveEquipmentState(createEmptyState());
        }
        console.log(`[SaveSelect] 进入存档 ${index}`);
        director.loadScene('Battle', (err) => {
            if (err) console.error('[SaveSelect] 进入 Battle 场景失败', err);
        });
    }

    /** 点 ✕ → 先问一次 */
    private confirmDelete(index: number): void {
        const info = readSlot(index);
        if (!info.exists) {
            console.log(`[SaveSelect] 存档 ${index} 是空的，不用删`);
            return;
        }
        this.closePopup();
        const popup = createPopup(this.root as Node, '删除存档', 560, 300, () => this.closePopup());
        this.popup = popup.layer;

        this.centerText(popup.content, 0, 58, 20, COLOR_TEXT, true, `要删除「存档 ${index}」吗？`);
        this.centerText(popup.content, 0, 16, 15, COLOR_MUTED, false,
            `Lv.${info.level} · ${info.gold} 金币 · 策略 ${info.strategies}    删除后无法恢复`);

        const cancel = createButton(popup.content, 'CancelDelete', '取消', 190, 58, () => this.closePopup(), 18);
        cancel.node.setPosition(-115, -78, 0);
        const confirm = createButton(popup.content, 'ConfirmDelete', '删除', 190, 58, () => {
            resetSlot(index);
            this.closePopup();
            this.refresh();
            console.log(`[SaveSelect] 已删除存档 ${index}`);
        }, 18);
        confirm.node.setPosition(115, -78, 0);
    }

    private closePopup(): void {
        const popup = this.popup;
        this.popup = null;
        if (popup && popup.isValid) popup.destroy();
    }

    private centerText(
        parent: Node, x: number, y: number, fontSize: number, color: Color, bold: boolean, text: string,
    ): Label {
        const label = createText(parent, text, { fontSize, color, bold, width: 900, align: 'center' });
        label.node.setPosition(x, y, 0);
        return label;
    }

    private leftText(
        parent: Node, text: string, x: number, y: number, fontSize: number, color: Color, bold: boolean,
    ): Label {
        const label = createText(parent, text, { fontSize, color, bold, align: 'left' });
        setAnchor(label.node, 0, 0.5);
        label.node.setPosition(x, y, 0);
        return label;
    }
}
