# CRK · 骰子自动战斗 Demo

Cocos Creator **3.8.8** 项目。选关 → 自动战斗（攻击骰 / 防御骰双拼点）→ 打普通敌人攒进度 → 打 BOSS 掉装备 → 阵亡弹窗退出。

---

## 1. 怎么跑起来

1. 用 Cocos Creator 3.8.8 打开本目录（`package.json` 里已写死 creator 版本）。
2. 打开场景 `assets/scenes/Battle.scene`（双击即可）。
3. 点右上角预览 ▶，然后点「选关」挑一个关卡。

> 可选：`项目设置 → 项目数据 → 设计分辨率` 改成 `1280 x 800` 会更贴合草图。
> UI 按 1280x800 布局并整体等比缩放，改不改分辨率都能正常显示。

---

## 2. 玩法流程

| 步骤 | 说明 |
| --- | --- |
| 选关 | 点「选关」弹窗挑关卡（`forest` / `factory`），进去后**全自动**战斗 |
| 玩家攻击 | 每 `Speed` 秒蓄力结束进入投骰，`Atk_gap` 秒后结算；命中则 `玩家 Atk - 敌人 Def` |
| 玩家防御 | 每 `def_gap` 秒掷一次防御骰（玩家敏捷 vs 敌人 `blockade`）；成功一次防御值 +玩家 `Def`，**一直保留到这场战斗结束** |
| 敌人攻击 | **不投骰，100% 命中**：每 `Speed` 秒蓄力 + `Atk_gap` 秒出手后造成 `敌人 Atk - 玩家当前防御值`（至少 1） |
| 普通敌人 | 击败后按 `Drop.rate` 掉落 buff（下一场战斗生效，或立即回血），0.9 秒后自动刷下一个 |
| BOSS | 进入关卡时在 `[a, b]` 里随机一个 c；击败 c 个普通敌人后，下一个刷出来的就是 BOSS（面板显示「距 BOSS N」） |
| 击败 BOSS | 掉落**装备**（永久保存到本地存档），然后重新掷 c，继续刷普通敌人 |
| 装备 | 玩家面板有「武器 / 护甲」两个按钮，点开弹窗选择/卸下；属性在**每次战斗开始时**结算 |
| 玩家阵亡 | 弹窗 → 退出关卡（装备和存档不会丢） |
| 退出 | 任何时候点「退出」回到选关状态 |

> 战斗进度、防御值、距 BOSS 个数、当前掉落都显示在对应面板上；最近 10 条战斗记录在玩家面板下方的「终端」里。

---

## 3. 战斗公式

### 3.1 玩家攻击（拼点）

```
阈值 T = floor( 6 - (玩家敏捷 - 敌人敏捷) / 关卡难度 )     ← 默认 AGILITY_DIRECTION = -1，见 3.5
骰子和 = 2   → 必定失败
骰子和 = 12  → 必定成功
3-11        → 骰子和 > T 则命中，否则未命中
命中伤害 = max(1, 玩家 Atk - 敌人 Def)
```

- 骰子 = **两个六面骰**，和值 2-12。
- 面板上的「命中率」就是把 36 种和值全部枚举出来的真实概率（见 3.4）。

### 3.2 玩家防御（拼点，对手是敌人的 blockade）

```
阈值 T = floor( 6 - (玩家敏捷 - 敌人 blockade) / 关卡难度 )
判定方式和攻击完全一样（2 必失败、12 必成功、其余 和值 > T）
成功一次：本场战斗的防御值 += 玩家 Def
```

- `blockade` 越高，玩家越难防住（因为阈值被抬高）。
- 防御值**只增不减**，一直保留到这场战斗结束（换敌人就清空）。
- 面板上的「成功率」同样是把 36 种和值枚举出来的真实概率，后面跟着当前防御值。

### 3.3 敌人攻击（100% 命中）

```
伤害 = max(1, 敌人 Atk - 玩家当前防御值)
```

- 敌人不再投骰，蓄力 `Speed` 秒 + 出手 `Atk_gap` 秒后必定造成伤害，所以防御骰很关键。

### 3.4 伤害与最小伤害

`max(1, ...)` 的下限避免「攻低防高」时双方永远打不死（改动入口：`BattleCore.ts` 的 `MIN_DAMAGE`）。

### 3.5 ⚠️ 敏捷方向开关

```ts
export const AGILITY_DIRECTION = -1;  // -1 = 敏捷越高越强（当前默认）；1 = 严格按需求原文
```

- `-1`：阈值 = `6 - (攻方敏捷 - 守方敏捷)/难度`，敏捷高 → 更容易命中、更难被打中（符合直觉）。
- `+1`：需求原文方向，敏捷高反而更吃亏，`Agility_up` 会变成负面效果。

之前按 `+1` 实测过：玩家（敏捷 6）打狐狸（敏捷 3）命中率只有 16.7%，狐狸打玩家 91.7%，必输。所以默认用 `-1`。

---

## 4. 配置文件

四份 JSON 都在 `assets/resources/config/` 下，改完**不用重新编译脚本**，重新预览即可生效
（改完编辑器没反应的话，点一下编辑器窗口让它刷新资源，或者重启编辑器）。

> ⚠️ **JSON 里不要用 `constructor` / `__proto__` / `prototype` 当键名。**
> Cocos 的导入和序列化用 `obj.constructor === Object` 判断“普通对象”，一旦某个对象带自己的 `constructor` 键，
> 整份文件会被当成非普通对象，导入结果是**空**（`asset.json === null`），运行时直接报
> `Cannot read properties of null (reading 'xxx')`。`Config.ts` 启动时会扫描这类键名并给出可读的报错。

### 4.1 `player.json`（玩家）

```json
{ "Hp": 90, "Sp": 10, "Atk": 14, "Agility": 6, "Def": 3, "Speed": 2.4, "Atk_gap": 0.6, "def_gap": 1.8 }
```

| 字段 | 含义 |
| --- | --- |
| `Hp` | 生命上限，也是每次进入关卡时的血量 |
| `Sp` | 法力，**只显示、不参与战斗**（留给以后的技能系统） |
| `Atk` | 攻击力 |
| `Agility` | 敏捷，参与攻击拼点和防御拼点 |
| `Def` | **每次防御骰成功获得的防御值**（不是常驻防御力） |
| `Speed` | 攻击间隙（秒） |
| `Atk_gap` | 攻击骰的表现时间（秒） |
| `def_gap` | 防御间隙（秒）：每隔这么久掷一次防御骰 |

### 4.2 `enemies.json`（敌人，BOSS 也是这里的条目）

```json
"fox": { "Hp": 24, "Atk": 6, "Atk_gap": 1.0, "Speed": 2.0, "Def": 1,
         "Agility": 3, "blockade": 5,
         "Drop": { "type": "Agility_up", "rate": 0.2 } }
```

| 字段 | 含义 |
| --- | --- |
| `Hp` / `Atk` / `Def` / `Agility` / `Speed` / `Atk_gap` | 同上（`Agility` 参与玩家攻击拼点） |
| `blockade` | **防御拼点里敌人这一方的值**，越高玩家越难防住 |
| `Drop.type` / `Drop.rate` | 普通敌人的奖励类型与掉落概率（见 4.5） |
| `Drop.equip` | 当 `Drop.type` 为 `Equip` 时掉落的装备 id（BOSS 用，见 4.4） |

### 4.3 `levels.json`（关卡 + BOSS）

```json
"forest": {
  "name": "森林",
  "diff": 1,
  "Enemy": [
    { "enemy": "fox",  "spawn_rate": 0.5 },
    { "enemy": "wolf", "spawn_rate": 0.3 },
    { "enemy": "bat",  "spawn_rate": 0.2 }
  ],
  "boss": { "enemy": "fox_king", "a": 3, "b": 6 }
}
```

| 字段 | 含义 |
| --- | --- |
| key（`forest`） | 关卡 id |
| `name` | 可选，界面显示用 |
| `diff` | 关卡难度，参与拼点阈值计算（越大敏捷差影响越小） |
| `Enemy[].enemy` / `.spawn_rate` | 普通敌人 id 与刷新权重（建议和为 1，不等于 1 会按比例归一） |
| `boss.enemy` | BOSS 的敌人 id（同样配在 `enemies.json` 里） |
| `boss.a` / `boss.b` | 每次进入关卡 / 击败 BOSS 后，在 `[a, b]` 里随机一个 c，击败 c 个普通敌人后刷 BOSS（b 要大于 a，写反了会自动交换） |

### 4.4 `equipments.json`（装备）

```json
"steel_sword": { "name": "钢剑", "slot": "weapon", "Atk": 4 },
"power_armor": { "name": "动力甲", "slot": "armor", "Def": 2, "Agility": 1 }
```

| 字段 | 含义 |
| --- | --- |
| `name` | 显示名 |
| `slot` | `weapon`（武器槽）或 `armor`（护甲槽） |
| `Atk` / `Def` / `Agility` | 战斗开始时加成的属性（`Def` 加的是“每次防御骰获得的防御值”） |

- BOSS 掉落装备后**永久保存**在浏览器 localStorage（key：`crk_equipment_v1`），重开预览也还在。
- 同一件装备只会在背包里存在一份；换槽位、卸下都会立即保存。

### 4.5 普通敌人掉落（`BattleCore.ts` 的 `DROP_EFFECTS`）

| type | 效果 |
| --- | --- |
| `Agility_up` | 下一场战斗 敏捷 +1 |
| `Atk_up` | 下一场战斗 攻击 +2 |
| `Hp_heal` | 立即回复 10 点生命（不超过上限） |

- 「下一场战斗」类效果：战斗结束时记下，**下一场开打时生效、只作用于那一场**，可以叠加。
- BOSS 用 `Equip` 类型掉落装备（不进这张表）。

---

## 5. 代码结构

```
assets/
  scenes/Battle.scene          Canvas + Camera + Game(BattleGame) —— 场景里只有骨架，UI 全部由代码创建
  scripts/
    BattleCore.ts              纯逻辑：攻击/防御拼点、敌人 100% 伤害、BOSS 进度、掉落判定（不依赖 cc）
    Equipment.ts               装备数据、属性加成、localStorage 永久存档
    Config.ts                  resources.load 读取四份 JSON + 启动校验
    UIFactory.ts               面板/文字/按钮/弹窗（用 Graphics 画，不需要任何图片资源）
    BattleGame.ts              主流程组件：布局、阶段切换、事件播报、选关/装备/战败弹窗
  resources/config/*.json      player / enemies / levels / equipments
docs/layout.png                UI 布局示意图（按 BattleGame.ts 里的坐标画的近似稿）
```

### 界面（按你最新草图）

![UI 布局示意](docs/layout.png)

| 草图 | 实现 |
| --- | --- |
| 左侧大框「玩家信息、终端」 | 属性 + 武器/护甲两个装备按钮 + 底部 10 行战斗记录 |
| 右上框「敌人、关卡信息」 | 左半边敌人（名字/生命/攻击/防御/敏捷/封锁/进度），右半边关卡（关卡/难度/击杀/距 BOSS/掉落），中间竖线分隔 |
| 中右「攻击色子」 | 两颗骰子 + 和值 + 命中结果 + **命中率** + 蓄力进度 |
| 中右「防御色子」 | 两颗骰子 + 和值 + 防御结果 + **成功率 / 当前防御值** + 下次防御倒计时 |
| 左下「退出」 | 按钮，回到选关状态 |
| 右下「选关」 | 按钮，弹出关卡选择窗口 |

- 布局以 **1280x800** 为基准，运行时整体等比缩放（`min(宽/1280, 高/800)`）。
- 面板/按钮/弹窗都用 `Graphics` 画描边，文字用系统字体，整个 Demo **不需要一张图片资源**。

---

## 6. 自测

- **类型检查**：

```powershell
node "C:\ProgramData\cocos\editors\Creator\3.8.8\resources\app.asar.unpacked\node_modules\typescript\lib\tsc.js" `
     -p tsconfig.json --noEmit --skipLibCheck
```

- **纯逻辑自测**：`BattleCore.ts` 不依赖 `cc`，可以编译成 commonjs 后在 node 里跑：

```powershell
node "<同上>/typescript/lib/tsc.js" assets/scripts/BattleCore.ts `
     --target ES2019 --module commonjs --outDir tools/build --skipLibCheck
```

用 `createUnit / Battle / newLevelProgress` 就能复现整个战斗循环（敌人 100% 命中、防御值累积、BOSS 进度、掉落）。
当前数值的模拟结果（每关跑 200 个随机种子）：

| 配置 | 平均击杀 | 打到 BOSS | 击杀 BOSS |
| --- | --- | --- | --- |
| forest 空装备 | 9.1 | 100% | 94% |
| forest 带钢剑 | 10.6 | 100% | 100% |
| factory 空装备 | 1.7 | 2% | 0% |
| factory 带钢剑+动力甲 | 4.1 | 35% | 19% |

- **配置校验**：`Config.ts` 启动时会检查四份 JSON（空文件、`constructor` 这类禁用键名、
  关卡引用了不存在的敌人、`spawn_rate` 之和、`blockade` / `def_gap` 等新字段、
  `Equip` 掉落是否指向存在的装备）。有问题打到控制台 warning；整份读不出来时会把原因显示在「敌人、关卡信息」面板上。

---

## 7. 实现取舍（需求里没写死的地方）

1. **防御值的含义**：防御骰成功一次就 `+玩家 Def`，可叠加、只增不减，换敌人清空（对应「防御值在与该敌人的战斗中始终存在」）。
2. **def_gap**：定义为防御间隙（多久掷一次防御骰），和攻击的 `Speed` 是两条独立节奏，所以 UI 上分成两个色子面板。
3. **BOSS 触发条件**：在 `[a, b]` 随机 c，击败 **c** 个普通敌人后刷 BOSS；每击败一次 BOSS 重新掷 c。
4. **BOSS 掉落**：`Drop.type = "Equip"` + `Drop.equip = 装备 id`，装备永久存 localStorage（同一件不重复获得）。
5. **装备生效时机**：每次战斗开始时结算（战斗中换装不影响当前这场）。
6. **敌人 100% 伤害**：保留 `Atk_gap` 作为出手动作时间，伤害在出手结束时结算。
7. **敏捷方向**：默认 `AGILITY_DIRECTION = -1`（敏捷越高越强，见 3.5）；要严格按原文就改成 `1`。
8. **关卡选择**：点「选关」弹窗，随时可以换关卡（换了就重开本轮）。
9. **敌人中文名**：写在 `BattleGame.ts` 的 `ENEMY_NAMES` 里，没配的敌人直接显示 id。
10. **配置键名**：`constructor` / `__proto__` / `prototype` 不能当 JSON 键名，见第 4 节。
