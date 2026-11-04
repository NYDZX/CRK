import type { StrategyEffects } from './BattleCore';

/**
 * 策略系统：每升 5 级随机获得一条，可装备到 5 个策略槽里。
 * 这里只放“有哪些策略 + 文案 + 把已装备的 id 转成 Battle 用的开关”，
 * 具体效果在 BattleCore（骰子/伤害）和 BattleGame（金币/利息）里实现。
 */

export interface StrategyDef {
    id: string;
    name: string;
    desc: string;
}

/** 策略槽数量 */
export const MAX_SLOTS = 5;

export const STRATEGIES: StrategyDef[] = [
    {
        id: 'fibonacci',
        name: '斐波那契',
        desc: '每颗骰子只出 2/3/5（斐波那契面值，不含 1）',
    },
    {
        id: 'oddity',
        name: '奇数性',
        desc: '奇数翻倍，双奇必中+100，双偶扣 5% 盈利',
    },
    {
        id: 'swap',
        name: '攻防转换',
        desc: '基础攻击与基础防御互换',
    },
    {
        id: 'thorns',
        name: '荆棘',
        desc: '受到未格挡伤害时等量反弹',
    },
    {
        id: 'trophy',
        name: '奖杯',
        desc: '金币倍率每次提升额外 +0.2',
    },
    {
        id: 'twoFace',
        name: '二面骰子',
        desc: '玩家色子只出最小/最大面值，出最大面值时伤害/防御 ×2',
    },
    {
        id: 'suicide',
        name: '自杀式袭击',
        desc: '金币变化取反，盈利>1000 清零，50 秒结束关卡',
    },
    {
        id: 'lowInterest',
        name: '低利率',
        desc: '利息 -1.5%，倍率不随死亡上升',
    },
    {
        id: 'agility',
        name: '敏捷',
        desc: '玩家敏捷 +1',
    },
    {
        id: 'glassCannon',
        name: '玻璃大炮',
        desc: '攻击 ×3，防御骰必然投出最小值',
    },
    {
        id: 'autoShield',
        name: '自动护盾',
        desc: '每场战斗开始 +15 护盾，但玩家防御 ×0.9',
    },
    {
        id: 'healthPotion',
        name: '血瓶',
        desc: '每场战斗结束回复 10 点血量',
    },
];

export const STRATEGY_BY_ID: { [id: string]: StrategyDef } = (() => {
    const map: { [id: string]: StrategyDef } = {};
    for (const def of STRATEGIES) map[def.id] = def;
    return map;
})();

export function strategyName(id: string | null | undefined): string {
    if (!id) return '';
    const def = Object.prototype.hasOwnProperty.call(STRATEGY_BY_ID, id) ? STRATEGY_BY_ID[id] : null;
    return def ? def.name : id;
}

/** 把「已装备的策略 id」转成战斗核心用的开关集合 */
export function buildEffects(ids: Array<string | null | undefined>): StrategyEffects {
    const has = (id: string): boolean => ids.indexOf(id) >= 0;
    return {
        fibDice: has('fibonacci'),
        oddity: has('oddity'),
        twoFace: has('twoFace'),
        swapAtkDef: has('swap'),
        thorns: has('thorns'),
        trophy: has('trophy'),
        suicide: has('suicide'),
        lowInterest: has('lowInterest'),
        agilityPlus: has('agility'),
        glassCannon: has('glassCannon'),
        autoShield: has('autoShield'),
        healthPotion: has('healthPotion'),
    };
}

/** 没装备任何策略时的空开关 */
export function emptyEffects(): StrategyEffects {
    return buildEffects([]);
}
