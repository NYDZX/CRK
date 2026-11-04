/**
 * 技能系统：攻击技能 / 防御技能。
 * 一个技能就是一个「色子」：有面值区间、切换能耗、破碎后的恢复时间，以及面板上写的效果。
 */

export type SkillKind = 'attack' | 'defense';

export interface SkillDef {
    id: string;
    name: string;
    kind: SkillKind;
    /** 面板说明 */
    desc: string;
    /** 切换到这个色子要花的能量 */
    energy: number;
    /** 色子面值区间（闭区间） */
    faceMin: number;
    faceMax: number;
    /** 色子破碎后恢复所需时间（秒） */
    recovery: number;
    /** 攻击技能：伤害 = scale × atk；防御技能：防御值 = scale × def */
    scale?: number;
    /** 多段伤害段数（旋风斩 = 3） */
    hits?: number;
    /** 躲闪：拼点胜出时抵消全部伤害、不增加防御值 */
    dodge?: boolean;
    /** 额外金币（抢夺 = 50） */
    gold?: number;
    /** 按色子面值扣金币（黄金要塞 = 100/面值） */
    goldPerFace?: number;
    /** 防御技能不提供防御，只加金币倍率（贿赂 +0.5） */
    bonusMultiplier?: number;
    /** 命中后给自己「力量」：持续时间内伤害额外 +bonus × atk */
    strength?: { duration: number; bonus: number };
    /** 命中后削减敌方防御色子面值上限（重击 2） */
    weakenMax?: number;
    /** 延迟生效：n 秒后才结算，且无视拼点结果（巩固 3） */
    delay?: number;
}

export const SKILLS: SkillDef[] = [
    {
        id: 'slash',
        name: '砍击',
        kind: 'attack',
        desc: '造成 1 倍攻击伤害',
        energy: 1,
        faceMin: 2,
        faceMax: 7,
        recovery: 2,
        scale: 1,
    },
    {
        id: 'guard',
        name: '防御',
        kind: 'defense',
        desc: '提供 1 倍防御值的护盾',
        energy: 2,
        faceMin: 2,
        faceMax: 4,
        recovery: 3,
        scale: 1,
    },
    {
        id: 'dodge',
        name: '闪避',
        kind: 'defense',
        desc: '面值高于对方攻击色子时抵消全部伤害（不增加防御值）',
        energy: 0,
        faceMin: 1,
        faceMax: 9,
        recovery: 1,
        dodge: true,
    },
    {
        id: 'whirlwind',
        name: '旋风斩',
        kind: 'attack',
        desc: '造成 3 次 0.333 倍攻击伤害',
        energy: 1,
        faceMin: 1,
        faceMax: 9,
        recovery: 2,
        scale: 0.333,
        hits: 3,
    },
    {
        id: 'charged',
        name: '蓄力打击',
        kind: 'attack',
        desc: '1.2 倍攻击伤害，命中后力量 +1（2 秒内伤害再 +0.5 倍攻击）',
        energy: 2,
        faceMin: 3,
        faceMax: 5,
        recovery: 3,
        scale: 1.2,
        strength: { duration: 2, bonus: 0.5 },
    },
    {
        id: 'heavy',
        name: '重击',
        kind: 'attack',
        desc: '1 倍攻击伤害，命中后下一回合敌方防御色子面值上限 -2（不低于 1）',
        energy: 1,
        faceMin: 1,
        faceMax: 5,
        recovery: 2,
        scale: 1,
        weakenMax: 2,
    },
    {
        id: 'bribe',
        name: '贿赂',
        kind: 'defense',
        desc: '不提供防御，金币获取倍率 +0.5',
        energy: 3,
        faceMin: 1,
        faceMax: 1,
        recovery: 4,
        bonusMultiplier: 0.5,
    },
    {
        id: 'snatch',
        name: '抢夺',
        kind: 'defense',
        desc: '躲闪，并且额外获得 50 金币',
        energy: 2,
        faceMin: 1,
        faceMax: 5,
        recovery: 2,
        dodge: true,
        gold: 50,
    },
    {
        id: 'fortify',
        name: '巩固',
        kind: 'defense',
        desc: '重复 3 秒后生效（无视拼点结果），提供 10 倍防御值',
        energy: 2,
        faceMin: 5,
        faceMax: 5,
        recovery: 3,
        scale: 10,
        delay: 3,
    },
    {
        id: 'goldenFortress',
        name: '黄金要塞',
        kind: 'defense',
        desc: '提供「面值 × 防御」的护盾，同时扣掉「面值 × 100」金币',
        energy: 2,
        faceMin: 2,
        faceMax: 7,
        recovery: 3,
        goldPerFace: 100,
    },
];

export const SKILL_BY_ID: { [id: string]: SkillDef } = (() => {
    const map: { [id: string]: SkillDef } = {};
    for (const skill of SKILLS) map[skill.id] = skill;
    return map;
})();

/** 新存档默认拥有的技能 */
export const STARTING_SKILLS = ['slash', 'guard', 'dodge'];

export const DEFAULT_ATTACK_SKILL = 'slash';
export const DEFAULT_DEFENSE_SKILL = 'guard';

export function skillById(id: string | null | undefined): SkillDef | null {
    if (!id) return null;
    return Object.prototype.hasOwnProperty.call(SKILL_BY_ID, id) ? SKILL_BY_ID[id] : null;
}

export function skillName(id: string | null | undefined): string {
    const skill = skillById(id);
    return skill ? skill.name : (id || '');
}

export function skillsOfKind(kind: SkillKind): SkillDef[] {
    return SKILLS.filter((skill) => skill.kind === kind);
}

/** 面值区间文本，例如 "2-7" */
export function faceRangeText(skill: SkillDef): string {
    return skill.faceMin === skill.faceMax ? `${skill.faceMin}` : `${skill.faceMin}-${skill.faceMax}`;
}
