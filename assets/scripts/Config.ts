import { JsonAsset, resources } from 'cc';
import { DROP_EFFECTS } from './BattleCore';
import type { EnemiesData, LevelConfig, LevelsData, PlayerConfig } from './BattleCore';
import type { EquipmentsData } from './Equipment';

/** 四份配置读出来之后的集合 */
export interface GameConfig {
    player: PlayerConfig;
    enemies: EnemiesData;
    levels: LevelsData;
    equipments: EquipmentsData;
}

/**
 * 配置都放在 assets/resources/config 下（resources 目录才能用 resources.load 动态读取），
 * 好处是改 JSON 不用改代码、也不用重新编译脚本。
 */
const CONFIG_DIR = 'config';

/**
 * 这些键名会破坏 Cocos 的 JSON 导入：
 * 引擎序列化/反序列化里用 `obj.constructor === Object` 判断“普通对象”，
 * 一旦 JSON 里出现自己的 constructor 键，整份文件会被当成非普通对象，导入结果为空（asset.json === null），
 * 运行时就会报 `Cannot read properties of null (reading 'xxx')`。踩过一次，别再用这些键名。
 */
const FORBIDDEN_KEYS = ['constructor', '__proto__', 'prototype'];

function loadJson(path: string): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
        resources.load(path, JsonAsset, (err, asset) => {
            if (err || !asset) {
                reject(err || new Error(`读取配置失败: ${path}`));
                return;
            }
            resolve(asset.json);
        });
    });
}

/** 递归找出会破坏 Cocos 序列化的键名，返回路径（如 enemies.constructor） */
function findForbiddenKey(value: unknown, prefix: string): string | null {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            const hit = findForbiddenKey(value[i], `${prefix}[${i}]`);
            if (hit) return hit;
        }
        return null;
    }
    const table = value as { [key: string]: unknown };
    for (const key of Object.keys(table)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (FORBIDDEN_KEYS.indexOf(key) >= 0) return path;
        const hit = findForbiddenKey(table[key], path);
        if (hit) return hit;
    }
    return null;
}

/** 校验单个配置文件：读不到 / 为空 / 用了禁用键名 都直接抛出可读的错误 */
function expectConfig<T>(fileName: string, value: unknown): T {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
            `${fileName} 读出来是空的。请检查 JSON 里有没有 constructor / __proto__ 这类键名`
            + `（Cocos 会把整份配置丢弃），改成别的名字后重启编辑器重新导入。`,
        );
    }
    const badKey = findForbiddenKey(value, '');
    if (badKey) {
        throw new Error(
            `${fileName} 里用了键名 "${badKey}"，Cocos 会把这个对象当成非普通对象，`
            + `导致整份配置导入为空。请改名（例如把 constructor 改成 builder）。`,
        );
    }
    if (Object.keys(value as object).length === 0) {
        throw new Error(`${fileName} 里没有任何内容`);
    }
    return value as T;
}

/** 数值字段缺失/类型不对时给出警告（不阻断流程，方便定位配置问题） */
function warnMissingNumbers(label: string, source: unknown, keys: string[]): void {
    if (!source || typeof source !== 'object') return;
    const table = source as { [key: string]: unknown };
    const missing = keys.filter((key) => typeof table[key] !== 'number');
    if (missing.length > 0) {
        console.warn(`[Config] ${label} 缺少数字字段: ${missing.join(', ')}`);
    }
}

const PLAYER_KEYS = ['Hp', 'Sp', 'Atk', 'Agility', 'Def'];
/** 敌人仍然保留 Speed/Atk_gap（旧字段，现在不影响战斗节奏，但 BOSS 强化会乘在 speed 上） */
const ENEMY_KEYS = ['Hp', 'Atk', 'Atk_gap', 'Speed', 'Def', 'Agility', 'blockade', 'Gold', 'ExpRate'];
const LEVEL_KEYS = ['diff', 'Exp'];

/** 敌人表检查：数值字段、掉落类型、装备掉落是否配了 equipments */
function checkEnemies(enemies: EnemiesData, equipments: EquipmentsData): void {
    for (const enemyId of Object.keys(enemies)) {
        const enemy = enemies[enemyId];
        warnMissingNumbers(`enemies.${enemyId}`, enemy, ENEMY_KEYS);
        const drop = enemy.Drop;
        if (!drop || !drop.type) {
            console.warn(`[Config] 敌人 ${enemyId} 没有配 Drop`);
            continue;
        }
        if (drop.type === 'Equip') {
            if (!drop.equip) {
                console.warn(`[Config] 敌人 ${enemyId} 的 Drop.type 是 Equip，但没写 equip 字段`);
            } else if (!Object.prototype.hasOwnProperty.call(equipments, drop.equip)) {
                console.warn(`[Config] 敌人 ${enemyId} 掉落装备 ${drop.equip} 在 equipments.json 里不存在`);
            }
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(DROP_EFFECTS, drop.type)) {
            console.warn(`[Config] 敌人 ${enemyId} 的掉落类型 ${drop.type} 没有对应效果（DROP_EFFECTS 里未定义）`);
        }
    }
}

/** 关卡检查：刷新权重、引用的敌人、BOSS 配置 */
function checkLevels(levels: LevelsData, enemies: EnemiesData): void {
    for (const levelId of Object.keys(levels)) {
        const level: LevelConfig = levels[levelId];
        warnMissingNumbers(`levels.${levelId}`, level, LEVEL_KEYS);
        const list = level && level.Enemy;
        if (!Array.isArray(list) || list.length === 0) {
            console.warn(`[Config] 关卡 ${levelId} 的 Enemy 列表为空`);
        } else {
            const total = list.reduce((sum, entry) => sum + (entry.spawn_rate || 0), 0);
            if (Math.abs(total - 1) > 1e-6) {
                console.warn(`[Config] 关卡 ${levelId} 的 spawn_rate 之和是 ${total}，不是 1（内部会按比例归一）`);
            }
            for (const entry of list) {
                if (!Object.prototype.hasOwnProperty.call(enemies, entry.enemy)) {
                    console.warn(`[Config] 关卡 ${levelId} 引用了不存在的敌人 ${entry.enemy}`);
                }
            }
        }

        const boss = level.boss;
        if (!boss) {
            console.warn(`[Config] 关卡 ${levelId} 没有配 boss，这个关卡不会刷 BOSS`);
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(enemies, boss.enemy)) {
            console.warn(`[Config] 关卡 ${levelId} 的 BOSS 敌人 ${boss.enemy} 不存在`);
        }
        if (typeof boss.a !== 'number' || typeof boss.b !== 'number') {
            console.warn(`[Config] 关卡 ${levelId} 的 boss.a / boss.b 必须是数字`);
        } else if (boss.a > boss.b) {
            console.warn(`[Config] 关卡 ${levelId} 的 boss.a > boss.b，内部会自动交换`);
        }
    }
}

/** 装备表检查 */
function checkEquipments(equipments: EquipmentsData): void {
    for (const id of Object.keys(equipments)) {
        const cfg = equipments[id];
        if (!cfg || !cfg.name) console.warn(`[Config] 装备 ${id} 缺少 name`);
        if (!cfg || (cfg.slot !== 'weapon' && cfg.slot !== 'armor')) {
            console.warn(`[Config] 装备 ${id} 的 slot 只能是 weapon 或 armor`);
        }
        if (!cfg || typeof cfg.price !== 'number') {
            console.warn(`[Config] 装备 ${id} 没有配 price，商店里会按 0 金币出售`);
        }
    }
}

/** 一次性读入 玩家 / 敌人 / 关卡 / 装备 四份配置并做基础校验 */
export async function loadGameConfig(): Promise<GameConfig> {
    const [playerRaw, enemiesRaw, levelsRaw, equipmentsRaw] = await Promise.all([
        loadJson(`${CONFIG_DIR}/player`),
        loadJson(`${CONFIG_DIR}/enemies`),
        loadJson(`${CONFIG_DIR}/levels`),
        loadJson(`${CONFIG_DIR}/equipments`),
    ]);

    const player = expectConfig<PlayerConfig>('player.json', playerRaw);
    const enemies = expectConfig<EnemiesData>('enemies.json', enemiesRaw);
    const levels = expectConfig<LevelsData>('levels.json', levelsRaw);
    const equipments = expectConfig<EquipmentsData>('equipments.json', equipmentsRaw);

    warnMissingNumbers('player.json', player, PLAYER_KEYS);
    checkEnemies(enemies, equipments);
    checkLevels(levels, enemies);
    checkEquipments(equipments);

    return { player, enemies, levels, equipments };
}
