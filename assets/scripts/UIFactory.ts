import {
    Color, EventTouch, Graphics, HorizontalTextAlignment, Label, Layers, Node, UITransform, VerticalTextAlignment,
} from 'cc';

/**
 * 极简 UI 工具：所有面板/文字/按钮都用代码创建，
 * 面板与按钮的黑框用 Graphics 画，不需要任何图片资源。
 */

export const COLOR_TEXT = new Color(25, 25, 25, 255);
export const COLOR_BORDER = new Color(15, 15, 15, 255);
export const COLOR_PANEL = new Color(255, 255, 255, 255);
export const COLOR_MUTED = new Color(128, 128, 128, 255);
export const COLOR_PRESSED = new Color(232, 232, 232, 255);
export const COLOR_DISABLED_TEXT = new Color(175, 175, 175, 255);
export const COLOR_DISABLED_BORDER = new Color(185, 185, 185, 255);

/** 创建一个 UI 节点（自动挂 UITransform，并设置为 UI_2D 层，否则相机看不见/点不到） */
export function createUINode(name: string, parent: Node | null): Node {
    const node = new Node(name);
    node.layer = Layers.Enum.UI_2D;
    node.addComponent(UITransform);
    if (parent) parent.addChild(node);
    return node;
}

export function getTransform(node: Node): UITransform {
    return node.getComponent(UITransform) as UITransform;
}

export function setSize(node: Node, width: number, height: number): void {
    getTransform(node).setContentSize(width, height);
}

export function setAnchor(node: Node, x: number, y: number): void {
    getTransform(node).setAnchorPoint(x, y);
}

/** 画一个描边/填充矩形（以节点原点为中心） */
export function drawFrame(
    gfx: Graphics,
    width: number,
    height: number,
    fill: Color | null,
    stroke: Color | null,
    lineWidth = 3,
): void {
    gfx.clear();
    if (fill) gfx.fillColor = fill;
    if (stroke) {
        gfx.strokeColor = stroke;
        gfx.lineWidth = lineWidth;
    }
    gfx.rect(-width / 2, -height / 2, width, height);
    if (fill) gfx.fill();
    if (stroke) gfx.stroke();
}

export interface PanelView {
    node: Node;
    gfx: Graphics;
    width: number;
    height: number;
}

export interface PanelOptions {
    fill?: Color | null;
    stroke?: Color | null;
    lineWidth?: number;
}

/** 白底黑框的面板 */
export function createPanel(
    parent: Node,
    name: string,
    width: number,
    height: number,
    options: PanelOptions = {},
): PanelView {
    const node = createUINode(name, parent);
    setSize(node, width, height);
    const gfx = node.addComponent(Graphics);
    drawFrame(
        gfx,
        width,
        height,
        options.fill === undefined ? COLOR_PANEL : options.fill,
        options.stroke === undefined ? COLOR_BORDER : options.stroke,
        options.lineWidth === undefined ? 3 : options.lineWidth,
    );
    return { node, gfx, width, height };
}

export interface TextOptions {
    name?: string;
    fontSize?: number;
    lineHeight?: number;
    color?: Color;
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
    valign?: 'top' | 'center' | 'bottom';
    /** 传了宽度 + wrap=true 时，文本按宽度自动换行并自动撑高（锚点建议 (0,1)） */
    width?: number;
    height?: number;
    wrap?: boolean;
}

const H_ALIGN: { [key: string]: HorizontalTextAlignment } = {
    left: HorizontalTextAlignment.LEFT,
    center: HorizontalTextAlignment.CENTER,
    right: HorizontalTextAlignment.RIGHT,
};

const V_ALIGN: { [key: string]: VerticalTextAlignment } = {
    top: VerticalTextAlignment.TOP,
    center: VerticalTextAlignment.CENTER,
    bottom: VerticalTextAlignment.BOTTOM,
};

/** 创建一段文字 */
export function createText(parent: Node, text: string, options: TextOptions = {}): Label {
    const fontSize = options.fontSize === undefined ? 20 : options.fontSize;
    const node = createUINode(options.name || 'text', parent);
    const label = node.addComponent(Label);
    label.useSystemFont = true;
    label.fontSize = fontSize;
    label.lineHeight = options.lineHeight === undefined ? fontSize + 8 : options.lineHeight;
    label.color = options.color || COLOR_TEXT;
    label.isBold = !!options.bold;
    label.horizontalAlign = H_ALIGN[options.align || 'left'];
    label.verticalAlign = V_ALIGN[options.valign || 'center'];

    if (options.width !== undefined) {
        setSize(node, options.width, options.height === undefined ? label.lineHeight : options.height);
    }
    if (options.wrap && options.width !== undefined) {
        label.overflow = Label.Overflow.RESIZE_HEIGHT;
        label.enableWrapText = true;
    } else {
        label.overflow = Label.Overflow.NONE;
        label.enableWrapText = false;
    }
    label.string = text;
    return label;
}

export interface ButtonView {
    node: Node;
    gfx: Graphics;
    label: Label;
    width: number;
    height: number;
    setEnabled: (value: boolean) => void;
}

/** 黑框按钮：按下变灰，松开触发回调 */
export function createButton(
    parent: Node,
    name: string,
    text: string,
    width: number,
    height: number,
    onClick: () => void,
    fontSize = 24,
): ButtonView {
    const panel = createPanel(parent, name, width, height);
    const label = createText(panel.node, text, {
        name: 'label',
        fontSize,
        width: width - 20,
        align: 'center',
        valign: 'center',
    });
    label.node.setPosition(0, 0, 0);

    let enabled = true;
    const paint = (pressed: boolean): void => {
        if (!enabled) {
            drawFrame(panel.gfx, width, height, COLOR_PANEL, COLOR_DISABLED_BORDER, 3);
            label.color = COLOR_DISABLED_TEXT;
            return;
        }
        drawFrame(panel.gfx, width, height, pressed ? COLOR_PRESSED : COLOR_PANEL, COLOR_BORDER, 3);
        label.color = COLOR_TEXT;
    };

    panel.node.on(Node.EventType.TOUCH_START, () => {
        if (enabled) paint(true);
    });
    panel.node.on(Node.EventType.TOUCH_CANCEL, () => {
        paint(false);
    });
    panel.node.on(Node.EventType.TOUCH_END, () => {
        if (!enabled) return;
        paint(false);
        onClick();
    });

    return {
        node: panel.node,
        gfx: panel.gfx,
        label,
        width,
        height,
        setEnabled: (value: boolean) => {
            if (enabled === value) return;
            enabled = value;
            paint(false);
        },
    };
}

/** 销毁节点的所有子节点（弹窗列表重建时用） */
export function clearNode(node: Node): void {
    const children = node.children.slice();
    for (const child of children) child.destroy();
}

export interface PopupView {
    layer: Node;
    panel: Node;
    content: Node;
    width: number;
    height: number;
    /** 关闭并销毁弹窗 */
    close: () => void;
}

/**
 * 通用弹窗：全屏半透明遮罩 + 居中面板 + 标题，内容塞进 content 里。
 * 点遮罩空白处关闭；点面板内部不会误触关闭。
 */
export function createPopup(
    root: Node,
    title: string,
    width: number,
    height: number,
    onClose?: () => void,
): PopupView {
    const rootSize = getTransform(root).contentSize;
    const layer = createUINode('Popup', root);
    setSize(layer, rootSize.width, rootSize.height);
    const gfx = layer.addComponent(Graphics);
    gfx.fillColor = new Color(0, 0, 0, 150);
    gfx.rect(-rootSize.width / 2, -rootSize.height / 2, rootSize.width, rootSize.height);
    gfx.fill();

    const panel = createPanel(layer, 'PopupPanel', width, height);
    // 点面板内部不要把事件冒泡给遮罩，否则会误关闭
    panel.node.on(Node.EventType.TOUCH_START, (event: EventTouch) => {
        event.propagationStopped = true;
    });
    panel.node.on(Node.EventType.TOUCH_END, (event: EventTouch) => {
        event.propagationStopped = true;
    });

    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        if (onClose) onClose();
        if (layer.isValid) layer.destroy();
    };
    layer.on(Node.EventType.TOUCH_END, close);

    createText(panel.node, title, {
        name: 'title',
        fontSize: 26,
        bold: true,
        width: width - 40,
        align: 'center',
        valign: 'center',
    }).node.setPosition(0, height / 2 - 36, 0);

    const content = createUINode('content', panel.node);
    setSize(content, width - 40, height - 96);
    content.setPosition(0, -20, 0);

    return { layer, panel: panel.node, content, width, height, close };
}
