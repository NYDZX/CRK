# CRK · 骰子自动战斗 Demo

Cocos Creator **3.8.8** 项目。选关 → 自动战斗 → 投骰判定 → 击败后随机刷下一个敌人 → 阵亡弹窗退出。

---

## 1. 怎么跑起来

1. 用 Cocos Creator 3.8.8 打开本目录（`package.json` 里已写死 creator 版本）。
2. 打开场景 `assets/scenes/Battle.scene`（双击即可）。
3. 点右上角预览 ▶。

> 可选：`项目设置 → 项目数据 → 设计分辨率` 改成 `1280 x 800` 会更贴合设计稿。
> UI 本身按 1280x800 布局并整体等比缩放，改不改分辨率都能正常显示。

---

## 2. 玩法流程

| 步骤 | 说明 |
| --- | --- |
| 选择关卡 | 点「选择关卡」进入 `forest`，进入后**全自动**战斗，不需要任何操作 |
| 攻击间隙 | 每个单位各自的 `Speed` 秒蓄力结束 → 进入投骰阶段 |
| 投骰 | 掷两个六面骰，`Atk_gap` 秒的投骰表现后结算（面板上能看到两颗骰子和和值） |
| 击败敌人 | 按该敌人的 `Drop` 概率判定掉落，`0.9` 秒后在关卡 `Enemy` 列表里按 `spawn_rate` 随机刷下一个敌人，直接开打（玩家当前血量保留） |
| 玩家阵亡 | 弹窗提示 → 「退出关卡」/「结束关卡」→ 回到选关状态，玩家属性重置 |
| 结束关卡 | 任何时候点「结束关卡」都能直接退出当前关卡 |

---

## 3. 战斗公式

### 3.1 命中判定

```
阈值 T = floor( 6 - (攻击方敏捷 - 防守方敏捷) / 关卡难度 )   ← 默认 AGILITY_DIRECTION = -1，见 3.2
骰子和 = 2            → 必定失败
骰子和 = 12           → 必定成功
3 <= 骰子和 <= 11     → 骰子和 > T 则命中，否则未命中
```

- 骰子 = **两个六面骰**，和值范围 **2-12**（你原文「面值在 2-24」按笔误处理，2-24 是两个十二面骰）。
- 基线按你的要求由 `12` 改成 `6`：双方敏捷相同、难度 1 时阈值 = 6，命中率 = 21/36 ≈ **58.3%**。
- 改动入口：`assets/scripts/BattleCore.ts` 顶部的 `HIT_BASE`（默认 6）。

### 3.2 ⚠️ 敏捷方向（这个开关翻过一次，务必看一眼）

`BattleCore.ts` 里有个开关：

```ts
export const AGILITY_DIRECTION = -1;  // -1 = 敏捷越高越强（当前默认）；1 = 严格按需求原文
```

- `+1`（需求原文写法）：阈值 = `6 + (攻方敏捷 - 守方敏捷)/难度` —— **敏捷高的反而更难命中、更容易被打中**，
  `Agility_up` 掉落会变成负面效果。
- `-1`（当前默认）：阈值 = `6 - (攻方敏捷 - 守方敏捷)/难度` —— 敏捷越高越容易命中、越难被打中，符合直觉。

为什么默认是 `-1`：按 `+1` 时玩家（敏捷 6）打狐狸（敏捷 3）阈值是 9，命中率只有 **16.7%**，
而狐狸打玩家是 **91.7%**，一进 forest 基本必输（实测第一只怪就能把玩家打死）。
翻成 `-1` 后玩家打狐狸 91.7%、狐狸打玩家 8.3%，forest 能连打七八只。
想严格按原文（敏捷高吃亏）改回 `1` 即可，其余代码不用动。

### 3.3 伤害

```
伤害 = max(1, 攻击方 Atk - 防守方 Def)
```

- 按需求是 `Atk - Def`，额外加了「最小 1」的下限，否则攻低防高时永远打不死对方（改动入口：`MIN_DAMAGE`）。

### 3.4 时间轴

```
|-- Speed 秒攻击间隙（蓄力）--|-- Atk_gap 秒投骰表现--|-- Speed ... --|
```

- `Speed`：攻击间隙，按需求就是「多久打一次」的间隔。
- `Atk_gap`：出手动作 / 投骰动画的时长（两颗骰子点数先亮出来，`Atk_gap` 秒后才结算伤害），
  这样需求里的 `Atk_gap` 字段也有实际作用。一次完整攻击周期 = `Speed + Atk_gap`。

---

## 4. 配置文件

三份 JSON 都在 `assets/resources/config/` 下，改完**不用重新编译脚本**，重新预览即可生效
（改完编辑器没反应的话，点一下编辑器窗口让它刷新资源，或者重启编辑器）。

> ⚠️ **JSON 里不要用 `constructor` / `__proto__` / `prototype` 当键名。**
> Cocos 的导入和序列化用 `obj.constructor === Object` 判断“普通对象”，一旦某个对象带了自己的 `constructor` 键，
> 整份文件会被当成非普通对象，导入结果是**空**（`asset.json === null`），运行时直接报
> `Cannot read properties of null (reading 'xxx')`。踩过一次：敌人 id 叫 `constructor`，
> 已改名成 `builder`（显示名仍是「建造者」）。`Config.ts` 现在会在启动时扫描这类键名并给出可读的报错。

### 4.1 `player.json`（玩家）

```json
{ "Hp": 70, "Sp": 10, "Atk": 12, "Agility": 6, "Def": 3, "Atk_gap": 0.7, "Speed": 2.4 }
```

| 字段 | 含义 |
| --- | --- |
| `Hp` | 生命上限，也是每关开始时的血量 |
| `Sp` | 法力，**目前只显示、不参与战斗**（需求里的战斗规则没用到它，留着等技能系统） |
| `Atk` | 攻击力 |
| `Agility` | 敏捷，参与命中阈值计算 |
| `Def` | 防御力 |
| `Atk_gap` | 出手/投骰表现时长（秒） |
| `Speed` | 攻击间隙（秒） |

### 4.2 `enemies.json`（敌人）

```json
"fox": {
  "Hp": 24, "Atk": 7, "Atk_gap": 1.0, "Speed": 2.0,
  "Def": 1, "Drop": { "type": "Agility_up", "rate": 0.2 }, "Agility": 3
}
```

| 字段 | 含义 |
| --- | --- |
| `Hp` / `Atk` / `Def` / `Agility` / `Speed` / `Atk_gap` | 同上 |
| `Drop.type` | 掉落物类型字符串（见 4.4） |
| `Drop.rate` | 0-1 的掉落概率，随机数小于它才掉落 |

### 4.3 `levels.json`（关卡）

```json
"forest": {
  "name": "森林",
  "diff": 1,
  "Enemy": [
    { "enemy": "fox",  "spawn_rate": 0.5 },
    { "enemy": "wolf", "spawn_rate": 0.3 },
    { "enemy": "bat",  "spawn_rate": 0.2 }
  ]
},
"factory": {
  "name": "工厂",
  "diff": 1.5,
  "Enemy": [
    { "enemy": "robot",   "spawn_rate": 0.6 },
    { "enemy": "builder", "spawn_rate": 0.4 }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| key（`forest`） | 关卡 id |
| `name` | 可选，界面显示用 |
| `diff` | 关卡难度，参与命中阈值计算（越大敏捷差影响越小） |
| `Enemy[].enemy` | 引用 `enemies.json` 里的敌人 id |
| `Enemy[].spawn_rate` | 刷新权重，**之和建议为 1**；不严格等于 1 也能用（内部按比例归一） |

### 4.4 掉落物（`BattleCore.ts` 的 `DROP_EFFECTS`）

| type | 效果 |
| --- | --- |
| `Agility_up` | 下一场战斗 敏捷 +1 |
| `Atk_up` | 下一场战斗 攻击 +2（需求原文写的是「提高生命值」，按你的确认改成攻击力） |
| `Hp_heal` | 立即回复 10 点生命（不超过上限） |

- 「下一场战斗」类效果：战斗结束时记下，**下一场开打时生效、只作用于那一场**，效果用完后自动清空（可以叠加）。
- 加新的掉落类型：在 `DROP_EFFECTS` 里加一项，并在 `enemies.json` 的 `Drop.type` 里引用即可（未定义的类型只会记日志，不会崩）。

---

## 5. 代码结构

```
assets/
  scenes/Battle.scene          Canvas + Camera + Game(BattleGame) —— 场景里只有骨架，UI 全部由代码创建
  scripts/
    BattleCore.ts              纯逻辑：骰子、阈值、伤害、权重刷怪、掉落判定、Battle 状态机（不依赖 cc）
    Config.ts                  resources.load 读取三份 JSON
    UIFactory.ts               画白底黑框面板、文字、按钮（用 Graphics，不需要任何图片资源）
    BattleGame.ts              主流程组件：布局、阶段切换、事件播报、弹窗
  resources/config/*.json      三份配置
```

### 界面（严格按你给的草图，没有额外加东西）

| 草图 | 实现 |
| --- | --- |
| 左侧大框「玩家面板」 | 玩家属性（生命/法力/攻击/防御/敏捷/速度）+ 底部 5 行战斗记录 |
| 右上大框「敌人面板」 | 当前敌人名字 + 属性 + 蓄力/投骰状态 |
| 右中左框「关卡面板」 | 关卡名、难度、已击败数、最近一次掉落 |
| 右中右框「色子面板」 | 两颗骰子 + 和值 + 命中/未命中 + 伤害 |
| 左下框「结束关卡」 | 按钮，随时退出关卡 |
| 右下框「选择关卡」 | 按钮，选关状态下才可点 |

- 布局以 **1280x800** 为设计基准，运行时整体等比缩放（`min(宽/1280, 高/800)`），任何分辨率都不变形。
- 面板、按钮都用 `Graphics` 画描边矩形，文字用系统字体，所以整个 Demo **不需要一张图片资源**。

---

## 6. 自测

- **类型检查**（不用开编辑器）：

```powershell
node "C:\ProgramData\cocos\editors\Creator\3.8.8\resources\app.asar.unpacked\node_modules\typescript\lib\tsc.js" `
     -p tsconfig.json --noEmit --skipLibCheck
```

- **纯逻辑自测**：`BattleCore.ts` 不依赖 `cc`，可以单独编译成 commonjs 后在 node 里跑
  （输出到 `tools/build`，已被 .gitignore 忽略），用 `pickEnemy / Battle` 反复模拟刷关即可
  验证命中率、伤害、掉落和“战斗一定能收尾”：

```powershell
node "<同上>/typescript/lib/tsc.js" assets/scripts/BattleCore.ts `
     --target ES2019 --module commonjs --outDir tools/build --skipLibCheck
```

- **配置校验**：`Config.ts` 启动时会检查三份 JSON（空文件、`constructor` 这类禁用键名、
  关卡引用了不存在的敌人、`spawn_rate` 之和是否为 1、掉落类型是否在 `DROP_EFFECTS` 里）。
  有问题打到控制台 warning；整份读不出来时会把原因直接显示在「敌人面板」上，不会静默崩成 null。

---

## 7. 实现取舍（需求里没写死的地方）

1. **骰子**：两个六面骰，和值 2-12（不是 2-24，理由见 3.1）。
2. **阈值基线**：按你的要求用 6（原需求 12）。
3. **伤害下限 1**：防止 `Atk <= Def` 时战斗永远打不完。
4. **`Atk_gap`**：定义为投骰表现时长；一次攻击周期 = `Speed + Atk_gap`。
5. **`Sp`**：只展示，不参与战斗。
6. **敏捷方向**：默认 `AGILITY_DIRECTION = -1`（敏捷越高越强，见 3.2）；要严格按公式原文（敏捷越高越吃亏）就改成 `1`。
7. **战败**：不扣任何东西，直接弹窗退出关卡、重置玩家。
8. **关卡选择**：`levels.json` 现在有 `forest` / `factory` 两个关卡，但界面上的「选择关卡」只会进第一个；
   要做关卡列表，扩展 `BattleGame.startLevel()` 的入参即可。
9. **敌人中文名**：写在 `BattleGame.ts` 的 `ENEMY_NAMES` 里（`fox/wolf/bat/robot/builder`），没配的敌人直接显示 id。
10. **配置键名**：`constructor` / `__proto__` / `prototype` 不能当 JSON 键名（会让整份配置导入为空），见第 4 节。
