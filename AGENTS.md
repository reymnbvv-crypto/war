# AGENTS.md — 迷霧陣線（Tactical Fog Chess）開發規範

本檔案為 AI Coding Agent 與開發者的專案憲法與操作指南。開始修改前請先完整閱讀，並搭配 [`PROGRESS.md`](./PROGRESS.md) 了解最新進度與歷史決策；開發新 AI 演算法請詳閱 [`AI_PROTOCOL.md`](./AI_PROTOCOL.md)。

---

## 一、專案定位與技術約束

- **多檔零相依、零建置鏈純靜態架構**：
  - 專案由 [`index.html`](./index.html)（UI／渲染／互動／回放）、[`core/engine.js`](./core/engine.js)（純規則引擎）、[`core/ai-host.js`](./core/ai-host.js)（TFC AI Protocol v1 防火牆與宿主）及熱插拔演算法目錄 [`ai/`](./ai/) 組成，另附零相依 Node 驗證與對戰工具 [`tools/`](./tools/)。
  - 未經使用者明確同意，**禁止引入需要建置鏈的框架、打包工具或外部 CDN / npm 套件**。
- **執行與載入環境**：
  - 建議以靜態伺服器啟動（例如 `python3 -m http.server 8080`）：網頁會自動探索載入 `ai/*.js`（不需維護清單檔），並啟用高階 AI 的內嵌 Blob Web Worker 平行推演。
  - GitHub Pages 透過 [`.github/workflows/pages.yml`](./.github/workflows/pages.yml) 於部署產物中動態產生 `ai/manifest.json`（**嚴禁**提交 `manifest.json` 回 `main` 分支，保持增減演算法僅動單檔）。
  - `file://` 受限環境下須保留「匯入 AI（多選 `.js`，僅當次分頁有效）」與主執行緒時間切片自動降級路徑。
- **語言規範**：所有 UI 文案、三視角戰報、程式碼註解與專案文件（`README.md` / `AGENTS.md` / `PROGRESS.md` / `AI_PROTOCOL.md`）一律維持**繁體中文**；無關改動的既有註解與文件必須保留。

---

## 二、硬性不變量與技術紅線（Hard Invariants）

1. **所有現有 AI 難度鎖定原則**
   - [`ai/`](./ai/) 中**所有既有 AI 難度**（`recruit` / `warrior` / `general` / `marshal` / `wargod`）的演算法、評估權重、搜尋參數與時間預算，**未經使用者明確允許一律不得修改**。
   - 新增演算法或修改本體功能時，既有難度的決策必須維持 bit-for-bit 一致。
2. **一演算法一檔完全自包含（Zero `ai/shared/`）與純淨 0-AI 可運行**
   - [`ai/`](./ai/) 僅放完全獨立自包含的單檔演算法（遵循 [`AI_PROTOCOL.md`](./AI_PROTOCOL.md) 的 TFC AI Protocol v1）；**禁止建立跨演算法共用檔（如 `ai/shared/`）或在本體寫死演算法清單**，確保增減任一演算法僅需增刪該單一 `.js` 檔。
   - [`core/engine.js`](./core/engine.js) 僅含純規則常數與函式，**嚴禁夾帶 `aiValue` 或任何戰術啟發式**，確保清空 `ai/*.js` 即可直接得到 100% 純淨、開箱可運作的「全新無演算法版本」（自動落回熱座模式與回放，且零報錯）。
3. **嚴格零作弊（Fog Isolation）**
   - 任何 AI 僅能透過 [`core/ai-host.js`](./core/ai-host.js) 的迷霧防火牆（`FogFirewall`）接收該陣營合法可見盤面、唯讀 Rules SDK 與 6 種防洩漏事件流；每局藍／紅雙方各自獨立呼叫 `createAgent()` 實例化，物理隔離狀態。
   - **嚴禁**在演算法中偷讀真實盤面、全域 DOM 或跨實例共享隱藏情報。
4. **180° 中心對稱不變量**
   - `HILL_COORDS`、`FOREST_COORDS` 與 `INITIAL_BLUE_UNITS` 必須嚴格維持 `(x, y) ↔ (9 - x, 9 - y)` 中心旋轉對稱，確保 `canonicalCoord` / `canonicalVision` / `fromCanonicalAction` 鏡像適配層零偏差。
5. **Blob Worker 序列化隔離**
   - 任何傳入 `runtime.spawnBlobWorker(...)` 的搜尋函式（如 `searchAdvancedAi`、`searchWargodShard`）必須 100% 自包含，**嚴禁閉包引用外層變數或函式**，且必須實作 `runtime.canUseWorker === false` 的降級路徑。
6. **零 DOM 破壞渲染原則**
   - `#board` 的 100 個 `.tile` 由 `buildBoardDOM` 一次性建立；懸停、路徑預覽與選取只能切換 CSS class 或就地更新，**禁止**在 `pointermove` 等高頻事件中重建棋盤 DOM。
7. **回放格式 v1 向下相容**
   - 必須維持 `.tfc-replay.json`（`format: "tactical-fog-chess-replay"`、`version: 1`）對既有 `pve`／`hotseat`／`aivai` 回放檔、自訂／未安裝演算法 `id` 回放檔以及 0-AI 環境載入播放的完全相容性。

---

## 三、UI / UX 既定規格

- **統一思考計時**：所有 AI 難度套用一致規則，推演時間達 **≥ 3 秒**起才於狀態列顯示已思考秒數（`formatThinkingStatus` / `startThinkingClock`），且中途切換觀戰視野不得閃爍重置秒數。
- **AI 對弈模式（`aivai`）**：
  - 動態讀取註冊表支援自由配對藍／紅雙方 AI（允許相同難度鏡像對戰，亦允許兩支以上網頁匯入 `.js` 檔同台對戰）。
  - 開局與重開後停在**待命狀態**、預設**全圖**視野，未開賽前切換雙方 AI 不跳出確認彈窗。
  - 提供與回放一致的「全圖／藍方視野／紅方視野」三視野即時切換（含 AI 思考途中與終局檢視），控制項維持「開始／暫停／繼續」、「單步推進」與「節奏速度」，**不設置「立即落子」按鈕**。
- **網頁多檔匯入與規則下載**：
  - 「匯入 AI」支援一次多選與分次累加 `.js` 檔，**僅限當次分頁有效（不存 `localStorage`、不改寫儲存庫）**；同檔名重匯入採熱更新覆蓋，不同檔名同 `id` 自動配發區隔 ID 供同台競技。
  - 規則彈窗（`#rulesModal`）提供單一真相源 [`AI_PROTOCOL.md`](./AI_PROTOCOL.md) 下載按鈕與本機匯入入口。
- **雙地圖模式切換（戰略圖 ↔ 2.5D 高清圖）**：
  - 地圖正下方以單一按鈕切換（`切換高清圖` ↔ `切換戰略圖`），初次預設為**戰略圖**（記憶於 `localStorage`）；可於人機／熱座／AI 對弈／回放中即時無縫切換。
  - 2.5D 高清圖（[`render/board-25d.js`](./render/board-25d.js)）為 Canvas 2D 微縮沙盤，使用本地 PNG（`assets/hd25d/`）。素材缺失或 `file://` 下使用程序繪圖。繪製過 PNG 的畫布避免像素回讀，迷霧遮罩使用獨立程序畫布。
  - 採游標中心縮放、6px 滑鼠／8px 觸控防誤觸平移、4 向 90° 平滑旋轉與逆畫家序解析點格。`resize()` 量測畫布本身。高地繪圖與點格共用平台和坡面的投影，坡腳沿原格邊，旋轉動畫期間暫停點格。
  - Canvas 場景僅接收公開地形與視角授權資料。雙地圖依同一顯示判斷為未探明的林地套用迷霧。切換視角或跳轉回放時重置特效與迷霧轉場，移動特效在未偵測路徑處中斷。
- **戰鬥預測（方案 C）、硬性定高檢視卡與零抖動排版**：
  - 右側「單位與地形檢視」與「即時戰鬥預測拆解」採同區切換（`#inspectorCard` 桌面固定硬性高度 `324px`、內部自適應捲動安全網），唯有選中己方單位並懸停於可攻擊敵軍上方時才切換顯示預測，同時於該敵子上方浮現簡潔攻防／反擊小窗（雙模式共用、嚴格呼叫 `createObservedBoard` 遵守迷霧）。
  - 全域 `html { scrollbar-gutter: stable; }` 搭配選項 A 戰報區高度平衡（`pve`/`hotseat` `11.25rem`、`aivai`/`replaying` `7.5rem`）及 `#statusBanner`/`#actionSubHint` 固定最小高度，確保懸停、切換模式或展開速查時零左右／上下抖動。
  - CSS `.hidden` 須維持 `display: none !important;` 避免被 `.spectator-panel` 等 `display: flex` 規則覆寫；「AI 對弈觀戰」與「藍方 AI」僅於 `aivai` 模式顯示，頂部「AI 難度」選單維持於各模式顯示（熱座時停用）。
- **彈窗與焦點管理**：所有模態視窗統一納入 `MODAL_IDS`，經由 `setModalOpen` / `syncModalState` 控制 `inert` 與焦點還原。

---

## 四、專案架構導航地圖

- **[`core/engine.js`](./core/engine.js)**：純規則引擎（常數、地形、`hasLineOfSight`、`computeVisionData`、`isInEnemyShieldZoc`、`computeReachableFor`、`previewCombat`、`evaluateVictory`、`evaluateTurnLimitVictory`、`generateLegalActions`、`validateAction`）。
- **[`core/ai-host.js`](./core/ai-host.js)**：TFC AI Protocol v1 宿主（180° 鏡像適配層、`createRulesSdk`、`validateManifest`、`createRegistry`、`evaluateAiSource`、`discoverAndLoadBrowserAis`、`createMatchHost`）。
- **[`render/board-25d.js`](./render/board-25d.js)**：2.5D 高清奇幻微縮沙盤渲染器（鏡頭、投影、解析點格、幀排程與戰鬥特效）。同目錄模組負責素材載入、地形／迷霧／戰術區域，以及棋子與 HUD。
- **[`assets/hd25d/`](./assets/hd25d/)**：僅存放正式的本地棋子、地形與裝飾 PNG。
- **[`ai/`](./ai/)**（純熱插拔演算法槽，單檔自包含）：
  - `recruit.js`、`warrior.js`、`general.js`、`marshal.js`、`wargod.js`（清空即為無演算法版本）。
- **[`index.html`](./index.html)**：靜態樣式、頂部控制列、戰略圖 DOM／2.5D 渲染橋接／觀戰／回放／方案 C 檢視預測／戰報渲染、人類操作、多檔匯入 AI、`AI_PROTOCOL.md` 下載與 `bootstrapGame` 自動探索啟動。
- **[`tools/`](./tools/)**：
  - [`tools/verify-ai.mjs`](./tools/verify-ai.mjs)：單檔或全目錄協議合規、合法步、Worker 沙盒隔離、迷霧零作弊審計與中止健檢。
  - [`tools/arena.mjs`](./tools/arena.mjs)：無頭自動對戰與全循環賽裁判。
- **[`AI_PROTOCOL.md`](./AI_PROTOCOL.md)**：純規則＋TFC AI Protocol v1 完整開發手冊與無策略空殼範本。
- **[`.github/workflows/pages.yml`](./.github/workflows/pages.yml)**：GitHub Pages 部署組裝靜態產物（含 `render/` 與 `assets/`）並自動產生 `ai/manifest.json` 流程。

---

## 五、改動後必做驗證清單（Verification Playbook）

依修改範圍執行對應檢查；**臨時測試腳本僅置於暫存目錄，嚴禁提交至儲存庫**：

1. **演算法合規與零作弊審計（動到 `core/` 或 `ai/` 時必做）**：執行 `node tools/verify-ai.mjs`（或指定單檔），驗證契約、合法動作、Worker 沙盒與迷霧零作弊 100% 通過。
2. **無頭對戰回歸測試（動到引擎或演算法時必做）**：執行 `node tools/arena.mjs` 驗證多盤藍紅交替正常完賽。
3. **DOM 與語法完整性**：確認 `core/*.js`、`render/*.js`、`ai/*.js`、`tools/*.mjs` 與 `index.html` 內嵌腳本無語法錯誤，且所有 `document.getElementById(...)` 皆對應實際 HTML `id`。
4. **0-AI / 單 AI / 多檔匯入與自動探索驗證（動到本體載入或 UI 時必做）**：驗證清空 `ai/`（0 演算法）開箱可運作、多選重複 `id` 匯入對戰、以及本地 HTTP 目錄自動探索零 404。
5. **既有 AI 回歸檢查（動到共用宿主或事件流時必做）**：固定種子下比對既有難度輸出無非預期偏移。
6. **回放相容測試（動到 UI／模式／回放時必做）**：驗證舊版 v1 回放與未知自訂演算法 `id` 回放於 0-AI／多 AI 狀態下皆可編解碼播放。

---

## 六、交付流程、Git 推送與對話收尾規則

1. **開發完成自動交付**：
   - 每次開發或修改並通過上述對應驗證後：
     1. 若影響玩家可見的規則、介面、模式、AI 難度、協議或回放規格，同步更新 [`README.md`](./README.md)（及必要時 [`AI_PROTOCOL.md`](./AI_PROTOCOL.md)）；
     2. 同步更新 [`PROGRESS.md`](./PROGRESS.md)（更新快照、關鍵決策、測試數據與對話紀錄）；
     3. 確認 `git status` 未混入暫存檔後，直接 `git commit` 並 **`git push origin main`**，無需等使用者再次指示推送。
2. **每個對話收尾更新 `PROGRESS.md`**：
   - 不論對話是否修改程式碼，凡有實質產出（開發成果、基準測試／循環賽數據、平衡分析結論、已拍板設計決策），於收尾時**直接更新 [`PROGRESS.md`](./PROGRESS.md) 並 `git push origin main`**。
   - 若使用者明確表示「先討論、不要開始」，則於討論中途不寫檔與推送，待討論定案或整段任務收尾時一次寫入並推送。

---

## 七、本檔案（`AGENTS.md`）的維護原則

- **保持精煉**：僅記錄長期有效的架構紅線、流程規範、防呆地雷與模組導航；**不寫精確行號，不寫實驗數據流水帳**（均歸 [`PROGRESS.md`](./PROGRESS.md)）。
- **技術同步類更新**（拆檔／重構後的導航同步、新增正式測試命令、補記新發現的隱蔽技術地雷）：可隨開發完成一併更新並說明。
- **核心規則類更新**（變更 AI 鎖定原則、調整 Git 推送流程、放寬或修改硬性不變量）：**必須先取得使用者明確同意**後方可修改本檔。
