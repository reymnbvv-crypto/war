# AGENTS.md — 迷霧陣線（Tactical Fog Chess）開發規範

本檔案為 AI Coding Agent 與開發者的專案憲法與操作指南。開始修改前請先完整閱讀，並搭配 [`PROGRESS.md`](./PROGRESS.md) 了解最新進度與歷史決策。

---

## 一、專案定位與技術約束

- **單檔零相依架構**：整個遊戲（HTML / CSS / Vanilla JS）封裝於單一 IIFE 的 [`index.html`](./index.html) 中。未經使用者明確同意，**禁止引入需要建置鏈的框架或外部 CDN 套件**。
- **執行與測試環境**：
  - 建議以靜態伺服器啟動（例如 `python3 -m http.server 8080`），使高階 AI 可啟用內嵌 Blob Web Worker 平行推演。
  - 任何 Worker 相關功能必須同時保留 `file://` 受限環境下的**主執行緒時間切片自動降級路徑**。
- **語言規範**：所有 UI 文案、三視角戰報、程式碼註解與專案文件（`README.md` / `AGENTS.md` / `PROGRESS.md`）一律維持**繁體中文**；無關改動的既有註解與文件必須保留。

---

## 二、硬性不變量與技術紅線（Hard Invariants）

1. **所有現有 AI 難度鎖定原則**
   - `DIFFICULTIES` 中**所有既有 AI 難度**的演算法、評估權重、搜尋參數與時間預算，**未經使用者明確允許一律不得修改**。
   - 新增 AI 難度或周邊功能（UI、觀戰、回放、計時等）時，必須與既有難度的搜尋／評估路徑完全隔離。
2. **嚴格零作弊（Fog Isolation）**
   - 任何 AI 僅能透過 `observeAiTurn(faction, difficulty)` 取得該陣營的合法視野、獨立情報記憶（`aiMemoryByFaction`）與信念／粒子狀態（`aiBeliefByFaction` / `aiParticlesByFaction`）。
   - **嚴禁**在 AI 決策、啟發式、抽樣或搜尋中讀取 `state.units` 的隱藏敵軍座標，且藍／紅兩陣營在 `aivai` 模式下的記憶與信念必須完全隔離。
3. **180° 中心對稱不變量**
   - `HILL_COORDS`、`FOREST_COORDS` 與 `INITIAL_BLUE_UNITS` 必須嚴格維持 `(x, y) ↔ (9 - x, 9 - y)` 中心旋轉對稱，確保 `canonicalCoord` / `canonicalVision` / `fromCanonicalAction` 鏡像適配層零偏差。
4. **Blob Worker 序列化隔離**
   - `searchAdvancedAi` 與 `searchWargodShard` 會經由 `.toString()` 注入 Blob Web Worker 執行。
   - 兩者內部**嚴禁閉包引用任何外層全域變數、常數或輔助函式**；所有相依資料必須明確透過 `payload` / `packet` 傳入。
5. **零 DOM 破壞渲染原則**
   - `#board` 的 100 個 `.tile` 由 `buildBoardDOM` 一次性建立；懸停、路徑預覽與選取只能切換 CSS class 或就地更新，**禁止**在 `pointermove` 等高頻事件中重建棋盤 DOM。
6. **回放格式 v1 向下相容**
   - 調整遊戲模式、難度鍵值或事件結構時，必須維持 `.tfc-replay.json`（`format: "tactical-fog-chess-replay"`、`version: 1`）對既有 `pve`／`hotseat`／`aivai` 回放檔的編解碼相容性（`encodeReplayFile` / `decodeReplayFile`）。

---

## 三、UI / UX 既定規格

- **統一思考計時**：所有 AI 難度套用一致規則，推演時間達 **≥ 3 秒**起才於狀態列顯示已思考秒數（`formatThinkingStatus` / `startThinkingClock`），且中途切換觀戰視野不得閃爍重置秒數。
- **AI 對弈模式（`aivai`）**：
  - 支援獨立選擇藍／紅雙方 AI（允許相同難度鏡像對戰）。
  - 開局與重開後停在**待命狀態**、預設**全圖**視野，未開賽前切換雙方 AI 不跳出確認彈窗。
  - 提供與回放一致的「全圖／藍方視野／紅方視野」三視野即時切換（含 AI 思考途中與終局檢視），同步更新棋盤迷霧、ZoC、殘影、軌跡、兵力摘要、檢視器與防洩漏戰報。
  - 控制項維持「開始／暫停／繼續」、「單步推進」與「節奏速度」，**不設置「立即落子」按鈕**。
- **彈窗與焦點管理**：所有模態視窗統一納入 `MODAL_IDS`，經由 `setModalOpen` / `syncModalState` 控制 `inert` 與焦點還原。

---

## 四、`index.html` 快速導航地圖

因 `index.html` 為大型單檔，修改前請優先使用 `rg` 定位以下區塊與核心符號，避免全檔盲讀：

- **樣式與版面**：`<style>`（棋盤／迷霧／ZoC／回放列／觀戰面板）、`#topBar`、`#battleLayout`、`#spectatorPanel`、`MODAL_IDS` 四大彈窗。
- **核心常數與狀態**：`BOARD_SIZE`、`MAX_TURNS`、`HILL_COORDS`、`FOREST_COORDS`、`UNIT_DEFS`、`INITIAL_BLUE_UNITS`、`DIFFICULTIES`、`initGame`。
- **鏡像適配與信念／粒子**：`canonicalCoord`、`canonicalObservedBoard`、`fromCanonicalAction`、`advancedGeometryFor`、`advanceEnemyBeliefsFor`、`createParticleFilter`、`advanceParticlesFor`、`filterParticlesFor`、`observeFogAttack`。
- **規則與回合引擎**：`hasLineOfSight`、`computeVisionData`、`isInEnemyShieldZoc`、`computeReachableFor`、`previewCombat`、`performMoveStepByStep`、`resolveCombat`、`triggerGameOver`、`endTurnAndSwitch`。
- **AI 引擎與排程**：
  - 啟發式：`buildAiStrategicContext`、`scoreCandidateAction`、`evaluateTwoPlyEnemyBestReply`、`chooseRedAiAction`
  - 將軍／元帥：`searchAdvancedAi`、`advancedSearchPacket`、`advancedWorkerSource`、`startAdvancedAiSearch`
  - 軍神：`searchWargodShard`、`wargodSearchPacket`、`aggregateWargodScores`、`wargodWorkerSource`、`startWargodAiSearch`
  - 通用排程：`observeAiTurn`、`beginAiTurn`、`executeAiAction`、`formatThinkingStatus`、`startThinkingClock`
- **回放、渲染與互動**：`encodeReplayFile`、`decodeReplayFile`、`getBoardView`、`switchSpectatorView`、`toggleAiMatch`、`stepAiMatch`、`renderSpectatorPanel`、`renderHeaderAndBanner`、`renderBoard`、`renderBattleLog`、`requestGameChange`。

---

## 五、改動後必做驗證清單（Verification Playbook）

依修改範圍執行對應檢查；**臨時測試腳本僅置於暫存目錄，嚴禁提交至儲存庫**：

1. **DOM 與語法完整性**：確認腳本無語法錯誤，且所有 `document.getElementById(...)` 皆對應實際 HTML `id`。
2. **Worker 隔離沙盒測試**（動到搜尋引擎時必做）：於乾淨的 Node `vm` 沙盒中編譯並執行 `advancedWorkerSource()` 與 `wargodWorkerSource()`，確認零外層閉包洩漏。
3. **迷霧零作弊測試**（動到 AI／視野／鏡像時必做）：在固定種子與虛擬時鐘下移動迷霧中隱藏敵軍，驗證 AI 觀測盤面、抽樣世界與最終決策 100% bit-for-bit 一致。
4. **既有 AI 回歸檢查**（動到共用觀測或資料結構時必做）：與上個穩定 commit 比對未獲准修改的難度，確認輸出無非預期偏移。
5. **AI 戰術與強度驗證**（獲准修改或新增 AI 時必做）：執行殘局 `skip` 校準（必勝跳過／落後禁跳／開局禁跳）與藍紅交替多盤實戰基準測試。
6. **互動與回放相容測試**（動到 UI／模式／回放時必做）：驗證模式切換、三視野切換、完整對局錄製編解碼，以及舊版 v1 回放載入。

---

## 六、交付流程、Git 推送與對話收尾規則

1. **開發完成自動交付**：
   - 每次開發或修改並通過上述對應驗證後：
     1. 若影響玩家可見的規則、介面、模式、AI 難度或回放規格，同步更新 [`README.md`](./README.md)；
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
