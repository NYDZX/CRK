import { JsonAsset, resources } from 'cc';
import type { EnemiesData, LevelsData, PlayerConfig } from './BattleCore';

/** 三份配置读出来之后的集合 */
export interface GameConfig {
    player: PlayerConfig;
    enemies: EnemiesData;
    levels: LevelsData;
}

/**
 * 配置放在 assets/resources/config 下，所以要放进 resources 目录才能用 resources.load 动态读取
 * （好处：改 JSON 不用改代码，也不用重新编译脚本）。
 */
const CONFIG_DIR = 'config';

function loadJson<T>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        resources.load(path, JsonAsset, (err, asset) => {
            if (err || !asset) {
                reject(err || new Error(`读取配置失败: ${path}`));
                return;
            }
            resolve(asset.json as T);
        });
    });
}

/** 一次性读入 玩家 / 敌人 / 关卡 三份配置 */
export async function loadGameConfig(): Promise<GameConfig> {
    const [player, enemies, levels] = await Promise.all([
        loadJson<PlayerConfig>(`${CONFIG_DIR}/player`),
        loadJson<EnemiesData>(`${CONFIG_DIR}/enemies`),
        loadJson<LevelsData>(`${CONFIG_DIR}/levels`),
    ]);
    return { player, enemies, levels };
}
