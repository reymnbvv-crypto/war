# 迷霧陣線（Tactical Fog Chess）AI 演算法開發規範 — TFC AI Protocol v1

本文件為《迷霧陣線》官方制式 AI 介面規範書。無論由人類開發者或 AI Coding Agent 從零撰寫，只要遵循本規範完成**單一獨立 `.js` 檔案**，即可無縫掛載於網頁版（`ai/` 自動探索或「匯入 AI」多檔對戰）與 Node.js 無頭對戰裁判（`tools/verify-ai.mjs`、`tools/arena.mjs`）。

---

## 一、核心遊戲規則精確規格

> 完整規則實作單一真相源位於 [`core/engine.js`](./core/engine.js)。以下僅描述客觀規則數值，不包含任何策略建議或子力估值權重。

### 1. 棋盤、對稱性與勝負
- **棋盤大小**：`10 × 10`，座標 `(x, y)` 範圍 `0..9`（`x` 向右遞增、`y` 向下遞增）；線性索引 `cell = y * 10 + x`。
- **180° 中心旋轉對稱**：地圖與初始佈陣嚴格滿足 `(x, y) ↔ (9 - x, 9 - y)`。
- **地形分布**：
  - **高地（`terrain: 'hill', elev: 1`）**：`[4,4], [5,4], [4,5], [5,5], [1,4], [2,4], [8,5], [7,5]`
  - **樹林（`terrain: 'forest', elev: 0`）**：`[2,2], [3,2], [2,3], [7,7], [6,7], [7,6], [7,3], [8,3], [6,4], [2,6], [1,6], [3,5]`
  - 其餘為**平地（`terrain: 'plain', elev: 0`）**。
- **回合流程與上限**：
  - 總上限 **`MAX_TURNS = 120`**（藍方走奇數回合 `1, 3, ..., 119`，紅方走偶數回合 `2, 4, ..., 120`）。
  - 每回合擇一動作：① 原地攻擊、② 移動（移動後若射程內有可見敵可追加攻擊或放棄攻擊）、③ 跳過回合（`skip`，無懲罰）。
- **勝負判定**：
  1. **斬首勝利**：任一方旗手陣亡立即判負（同歸於盡則平手）。
  2. **滿 120 回合結算**：依序比較 ① 雙方存活單位**總剩餘 HP** → ② 雙方佔領**高地格數** → ③ 平手。

### 2. 兵種純規則數值（雙方各 8 枚）
藍方初始編制（`B1`～`B8`）；紅方（`R1`～`R8`）為 `(9 - x, 9 - y)` 鏡像：

| 編號 | 兵種鍵值 `type` | 名稱 | HP | 基礎攻 / 防 | MP | 射程 | 基礎視野 | 藍方初始座標 `(x, y)` |
|---|---|---|---:|---:|---:|---|---:|---|
| `1, 2` | `shield` | 重盾步兵 | 10 | 4 / 5 | 2 | 曼距 1 | 2 | `(3,8)`, `(6,8)` |
| `3, 4` | `spear` | 長矛兵 | 10 | 6 / 3 | 3 | 直線 1～2 | 2 | `(4,8)`, `(5,8)` |
| `5, 6` | `cavalry` | 輕騎 | 9 | 5 / 2 | 4 | 曼距 1 | 4 | `(1,8)`, `(8,8)` |
| `7` | `archer` | 弓手 | 7 | 7 / 1 | 2 | 曼距 2～3（高地 2～4） | 3 | `(4,9)` |
| `8` | `flag` | 旗手 | 9 | 4 / 3 | 3 | 曼距 1 | 3 | `(5,9)` |

### 3. 視野與迷霧規則
- **視野半徑**：`radius = UNIT_DEFS[type].vision + (obsElev === 1 ? 1 : 0)`；可見距離條件為歐幾里得距離 `hypot(dx, dy) <= radius + 0.5`。
- **防斜角穿縫 DDA 射線**：
  - 平地（`elev === 0`）不可見高地（`elev === 1`），除非曼距 `=== 1` 相鄰仰望；射線中間遇到高地或樹林即阻斷後方。
  - 高地（`elev === 1`）視線可越過低地樹林，但穿過另一座高地會遮蔽其後方低地（`targetElev < obsElev`）。
  - 射線精準經過格角時，若兩側相鄰格皆為阻擋物，禁止穿縫透視。
- **樹林隱蔽**：無論觀察者海拔，樹林格內敵軍須同時滿足**有射線**且**歐幾里得距離 `<= 2.05`**（`vision.forestReveal[y][x] === true`）才會現形。

### 4. 移動、控制區（ZoC）與伏擊
- **每步消耗**：入樹林 `2 MP`；由低處上高地 `2 MP`；平地／下高地／高地間 `1 MP`。
- **友軍穿行**：路徑可經過友軍格，但**終點不可與友軍重疊**；不可踏入**可見敵軍格**。
- **重盾 ZoC**：敵方重盾上下左右 4 格。
  - 回合初已處於敵方重盾 ZoC 內：離開的第一步額外 `+1 MP`。
  - 移動中途踏入敵方重盾 ZoC：立即停止移動（不可繼續後續步數，但仍可攻擊）。
- **迷霧伏擊**：
  - 路徑實際步進時若撞上隱藏敵軍格：停在前一格、揭露敵軍並**強制結束回合（不可攻擊）**。
  - 若踏入隱藏敵方重盾 ZoC：停在該格、揭露重盾，**仍可發動攻擊**（觸發 `decidePostMoveAttack`）。

### 5. 射程與戰鬥公式
- **長矛距 2 突刺限制**：須同列或同行（`dx === 0 || dy === 0`）；不可平地打高地或隔高地；中間格不可有敵軍（可越過友軍）。
- **弓手射程**：可曲射共享視野內任意目標，曼距 `2～3`（高地 `2～4`），不可近戰（距 1）、不可反擊。
- **有效攻擊力（`calcEffectiveAtk`）**：
  - `baseAtk`
  - `+1` 軍旗激勵（非旗手且距己方存活旗手曼距 `1～2`）
  - `+1` 高打低 / `-1` 低打高
  - `-1` 長矛主動攻擊距離 2
  - `+2` 長矛對輕騎（攻防反擊皆生效）
  - `+2` 輕騎衝鋒（主動攻擊、移動起終點曼距 `>= 3` 且落點非樹林）
- **有效防禦力（`calcEffectiveDef`）**：
  - `baseDef`
  - `+1` 軍旗激勵（非旗手且距己方存活旗手曼距 `1～2`）
  - `+1` 守方在樹林（若攻擊距離 `>= 2` 再 `+1`，共 `+2`）
  - `+2` 重盾受距離 `>= 2` 攻擊
  - `+min(2, 鄰接友軍數)` 鄰接援護（上下左右 4 格）
  - `-2` 夾擊破防（上下左右 4 格內敵軍數 `>= 2`）
  - `-3` 破盾衝散（輕騎觸發衝鋒且目標為重盾；援護照算）
- **傷害與反擊**：
  - `damage = max(1, atkTotal - defTotal)`
  - 滿足以下**全部條件**才可反擊：守方存活、距離 `=== 1`、守方未被夾擊、未被衝鋒破盾、非弓手。
  - `counterDamage = max(0, counterAtkTotal - 1 - counterDefTotal)`

---

## 二、單檔架構與硬性紅線

1. **一演算法一檔、100% 自包含**：
   - 每個演算法必須封裝於單一 `.js` 檔（例如 `ai/my_bot.js`），**禁止依賴其他演算法檔或外部套件**。
   - 放進 `ai/` 目錄即可自動探索生效；刪除該檔案即完全移除，不影響遊戲本體或其他演算法。
2. **嚴格零作弊（Fog Isolation）**：
   - 僅能讀取本體傳入的 `initCtx`、`event`、`obs` 與 `postObs`。
   - 嚴禁存取 `window` 內部遊戲狀態、DOM、或跨陣營／跨對局共享隱密變數（藍紅雙方即使使用同一個演算法檔，兩次 `createAgent()` 產生的實例狀態必須完全獨立）。
3. **座標系：優先使用 `'canonical'`（推薦）**：
   - 協議支援 `coordinateSpace: 'canonical'`（預設、推薦）與 `'world'`。
   - 選擇 `'canonical'` 時，本體會自動進行 180° 中心鏡像轉換：**演算法永遠以「自己是紅方（`myFaction === 'red'`、`R1..R8`，開局在上方 `y=0..1` 向下攻）、敵方為藍方（`B1..B8`，開局在下方 `y=8..9`）」的統一視角運作**；回傳的動作由本體自動鏡像還原回真實藍／紅方，演算法只需寫一套邏輯即可零偏差勝任先後手。
4. **Web Worker 隔離與降級**：
   - 若使用 `runtime.spawnBlobWorker(sourceCode)`，傳入的 Worker 程式碼必須 100% 自包含，嚴禁閉包引用外層變數。
   - 當 `runtime.canUseWorker === false`（例如 `file://` 或 Node.js 無頭測試環境）時，演算法必須自動降級至主執行緒同步或時間切片計算。

---

## 三、TFC AI Protocol v1 完整介面規格

### 1. 標準 UMD 註冊外殼（瀏覽器 + Node.js 雙相容）
```js
(function (root, factory) {
  const algo = factory();
  if (typeof module === 'object' && module.exports) module.exports = algo;
  if (root && root.TFC_AI && typeof root.TFC_AI.register === 'function') {
    root.TFC_AI.register(algo);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return { /* Manifest 物件 */ };
});
```

### 2. Manifest 欄位定義

| 欄位 | 型別 | 必填 | 預設值 | 說明 |
|---|---|---|---|---|
| `protocolVersion` | `number` | **是** | — | 固定為 `1` |
| `id` | `string` | **是** | — | 唯一識別碼（符合 `/^[A-Za-z0-9._#-]+$/`，建議與檔名一致） |
| `name` | `string` | **是** | — | 短名稱（狀態列、戰報、結算彈窗顯示） |
| `label` | `string` | 否 | `name` | 下拉選單顯示文字（例：`星火 · 蒙地卡羅`） |
| `order` | `number` | 否 | `100` | 下拉選單排序（數字小者靠前） |
| `coordinateSpace` | `'canonical' \| 'world'` | 否 | `'canonical'` | **強烈建議使用 `'canonical'`** |
| `thinkingText` | `string` | 否 | `'推演中…'` | 思考時狀態列文案（全難度統一滿 3 秒起顯示秒數） |
| `pacingDelayMs` | `number` | 否 | `0` | 短考演算法的介面呈現延遲（毫秒，非負） |
| `timeoutMs` | `number` | 否 | `30000` | 單步決策硬逾時（毫秒）；超時後本體中止並採最後合法 `reportProgress.bestAction` 或 `skip` |
| `createAgent(initCtx)` | `Function` | **是** | — | 工廠函式；每局每個陣營獨立呼叫一次，回傳 Agent 實例 |

### 3. `initCtx` 與唯讀 Rules SDK
呼叫 `createAgent(initCtx)` 時傳入：
- `initCtx.protocolVersion`: `1`
- `initCtx.rng`: `() => number`（`[0, 1)` 亂數函式；建議演算法所有隨機性一律透過此函式或 `runtime.rng`，以利決定性測試）
- `initCtx.match`（唯讀凍結）：
  - `boardSize`: `10`
  - `maxTurns`: `120`
  - `coordinateSpace`: `'canonical'` 或 `'world'`
  - `myFaction`: `'red'`（canonical 下固定為 `'red'`）或 `'blue'`/`'red'`（world 下為真實陣營）
  - `realFaction`: `'blue'` 或 `'red'`
  - `terrainMap`: `10×10` 地形二維陣列 `{ terrain: 'plain' | 'hill' | 'forest', elev: 0 | 1 }`
  - `initialBlueUnits`: 藍方開局 8 子編制陣列（canonical 下即為敵方開局編制）
- `initCtx.rules`（純函式唯讀工具箱，不存取任何全域遊戲狀態）：
  - 常數：`BOARD_SIZE`, `MAX_TURNS`, `CELL_COUNT`, `VISION_WORDS`, `DIRS`, `HILL_COORDS`, `FOREST_COORDS`, `UNIT_DEFS`, `TYPE_NAMES`, `INITIAL_BLUE_UNITS`, `BLUE_SLOTS`
  - 查詢函式：
    - `keyOf(x, y)`, `inBounds(x, y)`, `manhattan(x1, y1, x2, y2)`, `cellIndex(x, y)`, `opponentOf(faction)`, `factionName(faction)`
    - `getUnitById(id, board)`, `getUnitAt(x, y, board)`, `getAliveFlag(faction, board)`
    - `hasLineOfSight(x0, y0, x1, y1, obsElev, board)`
    - `computeVisionData(faction, board)`
    - `isTileScanned(x, y, vision, map)`
    - `isInEnemyShieldZoc(x, y, myFaction, visionObj, board)`
    - `getMoveStepCost(fromX, fromY, toX, toY, board)`
    - `computeReachableFor(unit, visionObj, board)` → `Map<"x,y", { x, y, cost, steps, entersZoc, path }>`
    - `canUnitAttackTargetWithVision(attacker, target, visionObj, board)`
    - `getValidAttackTargetsFor(attacker, visionObj, board)` → `Set<unitId>`
    - `countAdjacentUnits(x, y, targetFaction, board, excludeId)`
    - `hasFlagAura(unit, board)`, `isChargeActive(attacker, chargeDisplacement, board)`
    - `calcEffectiveAtk(attacker, defender, dist, isCounter, chargeDisplacement, board)`
    - `calcEffectiveDef(defender, attacker, dist, isShattered, board)`
    - `previewCombat(attacker, defender, chargeDisplacement, board)`
    - `countOccupiedHills(faction, board)`, `evaluateVictory(board)`, `evaluateTurnLimitVictory(board)`
    - `generateLegalActions(obs)` → 依 `obs` 產生全部合法動作陣列
    - `validateAction(action, board, vision, faction)` → `{ valid, action?, reason? }`

### 4. Agent 實例方法
`createAgent(initCtx)` 回傳物件：
- `onMatchStart?(matchInfo)`（選填）：對局建立完成時呼叫一次。
- `onEvent?(event)`（選填）：接收本體防火牆過濾後的 6 種合法情報事件：
  1. `vision_sync`：`{ type, turn, isMyTurn, myFaction, board, vision }`（開局與每次視野重算後觸發）
  2. `enemy_seen_action`：`{ type, turn, unitId, x, y, cell, kind: 'move' | 'attack' }`（敵軍於我方視野內移動或開火）
  3. `fog_attack_received`：`{ type, turn, targetId, targetX, targetY, targetCell, damage, canCounter, rangedOnly, targetElev, targetBaseDef }`（我方遭迷霧中未現形敵軍攻擊）
  4. `enemy_killed`：`{ type, turn, unitId }`（敵方單位陣亡）
  5. `turn_advance`：`{ type, turn, turnsSinceDamage, myFaction, board, vision }`（敵方回合結束、切換到我方新回合前觸發）
  6. `self_action_result`：`{ type, turn, actionType, unitId, from?, to?, displacement, ambushed, zocInterrupted }`（我方執行動作後的實際結果，若移動則於 `decidePostMoveAttack` 之前觸發）
- `decideTurn(obs, runtime)`（**必填**）：同步回傳 `Action` 或非同步回傳 `Promise<Action>`。
  - `obs` 欄位：`{ protocolVersion, turn, maxTurns, turnsSinceDamage, coordinateSpace, myFaction, realFaction, board: { map, units }, vision: { tileVisible, forestReveal, detectedEnemyIds } }`
    - `obs.board.units` **僅包含己方存活單位＋當前視野內可見敵軍**（嚴格不含迷霧中隱藏敵軍）。
  - `runtime` 欄位：
    - `signal`：`AbortSignal`（重開／暫停／超時時觸發 `abort`）
    - `rng`：`() => number`
    - `now`：`() => number`（高精度毫秒時鐘）
    - `canUseWorker`：`boolean`
    - `hardwareConcurrency`：`number`
    - `isAiVsAi` / `speedFactor`：觀戰模式與節奏倍率
    - `spawnBlobWorker(sourceCode)`：託管建立 Blob Worker（搜尋結束或中止時本體自動 `terminate` 並釋放 URL）
    - `reportProgress({ depth?, bestAction?, info? })`：回報搜尋進度與暫定最佳合法動作
- `decidePostMoveAttack?(postObs, ctx)`（選填）：
  - 當棋子移動後揭露原本看不見的新敵軍，或因隱藏重盾 ZoC 中斷原定計畫時觸發。
  - `ctx`: `{ unitId, displacement, initiallyVisibleEnemyIds, reconsider, legalTargetIds, rng }`
  - 回傳欲攻擊的 `targetId` 字串，或 `null`（放棄追加攻擊）。
- `dispose?()`（選填）：終局、重開或切換模式時呼叫，釋放內部資源。

### 5. 標準動作格式（Action Contract）
所有座標與 `unitId` / `targetId` 皆須使用本演算法宣告的 `coordinateSpace`：

```js
// 1. 跳過回合
{ type: 'skip' }

// 2. 原地攻擊
{ type: 'stand_attack', unitId: 'R3', targetId: 'B1' }

// 3. 純移動（path[0] 必須為單位起點，相鄰步進、MP 與可見 ZoC 合法）
{ type: 'move', unitId: 'R5', path: [{ x: 8, y: 1 }, { x: 8, y: 2 }, { x: 8, y: 3 }] }

// 4. 移動後攻擊（目標須在起點合法視野內，且從 path 終點可合法命中）
{ type: 'move_attack', unitId: 'R5', path: [{ x: 8, y: 1 }, { x: 8, y: 2 }], targetId: 'B5' }
```

---

## 四、最小零策略空殼範本（複製存成 `ai/my_bot.js` 即可執行）

以下僅示範完整合規的介面結構（從合法動作中隨機挑選），不含任何戰術啟發式：

```js
(function (root, factory) {
  const algo = factory();
  if (typeof module === 'object' && module.exports) module.exports = algo;
  if (root && root.TFC_AI && typeof root.TFC_AI.register === 'function') {
    root.TFC_AI.register(algo);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  return {
    protocolVersion: 1,
    id: 'my_bot',
    name: '我的AI',
    label: '我的AI · 範例空殼',
    order: 100,
    coordinateSpace: 'canonical',
    thinkingText: '思考中…',
    pacingDelayMs: 0,
    timeoutMs: 30000,

    createAgent(initCtx) {
      const { rules } = initCtx;
      return {
        onEvent(event) {
          // 可依需求追蹤 vision_sync / enemy_seen_action / fog_attack_received / enemy_killed / turn_advance / self_action_result
        },
        decideTurn(obs, runtime) {
          const legal = rules.generateLegalActions(obs);
          const idx = Math.floor(runtime.rng() * legal.length);
          return legal[idx] || { type: 'skip' };
        },
        decidePostMoveAttack(postObs, ctx) {
          if (!ctx.legalTargetIds.length) return null;
          return ctx.legalTargetIds[0];
        },
        dispose() {}
      };
    }
  };
});
```

---

## 五、驗證與對戰指令速查（零外部套件，需 Node.js ≥ 18）

```bash
# 1. 驗證單一演算法（介面合規 + 合法動作 + 迷霧零作弊審計 + Worker 隔離 + 中止測試）
node tools/verify-ai.mjs ai/my_bot.js

# 2. 驗證 ai/ 資料夾內全部演算法
node tools/verify-ai.mjs

# 3. 兩支演算法藍紅交替對戰（例：各執藍紅 2 場，共 4 場）
node tools/arena.mjs --blue ai/my_bot.js --red ai/warrior.js --games 4 --swap

# 4. 針對 ai/ 內全部演算法跑單循環賽（每組合 2 局，藍紅各 1）
node tools/arena.mjs --round-robin --games 2

# 5. 網頁觀戰與互動測試（自動探索 ai/*.js）
python3 -m http.server 8080
```
