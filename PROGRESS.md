# PROGRESS.md — 迷霧陣線專案進度與實驗帳本

本檔案跨對話追蹤專案最新狀態、關鍵架構決策、實證基準數據與未來待辦。開發與驗證規則詳見 [`AGENTS.md`](./AGENTS.md)。

---

## 一、目前狀態快照（Current Snapshot）

- **最新架構形態**：零外部套件、零建置鏈純靜態模組架構（[`index.html`](./index.html) 約 4,050 行 + [`core/engine.js`](./core/engine.js) + [`core/ai-host.js`](./core/ai-host.js) + 5 支完全自包含單檔 [`ai/*.js`](./ai/) + [`tools/`](./tools/) CLI 驗證與對戰工具）
- **核心文件體系**：[`README.md`](./README.md)（玩家／架構手冊）、[`AI_PROTOCOL.md`](./AI_PROTOCOL.md)（TFC AI Protocol v1 自製演算法規範書，可於規則頁直接下載）、[`AGENTS.md`](./AGENTS.md)（開發憲法）、[`PROGRESS.md`](./PROGRESS.md)（進度與基準帳本）
- **對戰模式**：人機對戰（`pve`）、雙人熱座（`hotseat`）、AI 對弈觀戰（`aivai`，開局待命、預設全圖、三視野即時切換）；完整支援 **0 演算法白板模式**（刪空 `ai/*.js` 即得純淨無演算法版本）與**網頁多檔匯入對戰**
- **內附 AI 演算法（共 5 支獨立單檔，皆嚴格零作弊）**：`ai/recruit.js`（新兵）、`ai/warrior.js`（戰士）、`ai/general.js`（將軍）、`ai/marshal.js`（元帥）、`ai/wargod.js`（軍神）
- **回放規格**：`.tfc-replay.json`（`format: "tactical-fog-chess-replay"`、`version: 1`，向下相容舊版 `pve` / `hotseat` / `aivai` 回放，亦相容未知自訂演算法 `id` 與 0-AI 環境載入播放）

---

## 二、關鍵設計決策紀錄（Key Design Decisions / Why）

1. **獨立建立 `wargod` 而不修改既有四難度**
   - 經規則與原始碼審計，原版將軍／元帥在 `scoreCandidateAction`、根部 `bias`、搜尋樹內 `skip` 排序（`-4`）與同分索引決勝等多層對 `skip` 有結構性抑制，導致極少於殘局跳過。
   - 決策：完整保留原版四難度演算法與實力階梯（經回歸測試與 `cc4f435` 100% bit-for-bit 一致），另建完全獨立的 `searchWargodShard` 與 192 粒子濾波引擎。
2. **軍神保留 `30% 對抗伏擊世界 + 0.35 CVaR25` 風險聚合**
   - 曾以 A/B 實戰測試調降至 `15% 對抗世界 + 0.20 CVaR25`，結果軍神對元帥勝率由前 4 盤 **4–0** 明顯下滑至 **1–2**。
   - 結論：在存在迷霧伏擊與輕騎破盾一擊重創的規則下，較高的尾部風險防範正是軍神遠超元帥的核心優勢之一，維持 `70% 粒子後驗 + 30% 對抗伏擊世界` 與 `0.65 Mean + 0.35 CVaR25`。
3. **軍神效能與搜尋核心定案**
   - 採用 32-bit 打包走法、O(1) stamp reset、預計算可見 ZoC 位元遮罩、射程快篩、分層展開寬度、PVS + Aspiration Windows + LMR + Depth-1 Futility + 強制戰術 Quiescence ＋二階段置換表預熱（`28→10` 手）＋全敵可見時單世界無損根部剪枝。
   - 實測 4-Worker 分片下中盤 20 世界達 Depth 5 約 2.6s、Depth 6 約 5.3s，殘局精確世界可直達 Depth 12。
4. **克制型殘局跳過機制（防濫用＋防消極等輸）**
   - 開中盤未接敵與殘局血量／高地落後時施加負節奏門檻（`skipTempoPts`）；低子數殘局／臨近 120 回合時於搜尋樹各層保證 `skip` 展開槽不被剪除；必敗同分（`isForcedLoss`）時明確排斥 `skip`、優先主動求戰製造變數。
5. **UI / 體驗拍板規格**
   - 思考秒數顯示套用全難度，且**滿 3 秒起才顯示**；
   - AI 對弈開局停在**待命狀態**、預設**全圖**、隨時可切三視野、**不設置「立即落子」按鈕**；
   - 終局自動切回全圖同時保留三視野自由切換檢視能力。
6. **單檔熱插拔演算法架構與 TFC AI Protocol v1（2026-11-22 拍板定案）**
   - **目標驅動**：為支援後續切出「全新無演算法版本」供 AI 從零撰寫，並且增減任一演算法僅需動 **1 個檔案**。
   - **核心分離**：抽出純規則單一真相源 [`core/engine.js`](./core/engine.js)（刻意移除 `UNIT_DEFS.*.aiValue`，對新演算法零提示）與 [`core/ai-host.js`](./core/ai-host.js)（迷霧防火牆 `FogFirewall`、唯讀 Rules SDK、6 種標準情報事件流、雙陣營獨立實例化、動作合法性守門員、逾時保護與 Worker 託管）。
   - **廢除 `ai/shared/`**：全部 5 支既有演算法拆為 100% 完全自包含單檔 `ai/*.js`，無跨檔共用殘留，刪空 `ai/*.js` 即得純淨 0-AI 白板版。
   - **載入策略（A1 + B1）**：
     - 本地 HTTP（`python3 -m http.server`）與 Node CLI 自動掃描 `ai/*.js`（零清單檔、零 404）；
     - GitHub Pages 採 **A1**（[`.github/workflows/pages.yml`](./.github/workflows/pages.yml) 僅在發佈產物即時生成 `ai/manifest.json`，不回寫 `main`）；
     - 網頁「匯入 AI」採 **B1**（支援一次多選與分次累加 2 支以上 `.js` 檔同台對戰，僅限當次分頁有效不寫 `localStorage`、不改寫儲存庫；同檔名熱更新覆蓋、不同檔名同 `id` 自動區隔編號）。
   - **座標系與開發手冊**：協議同時支援 `'canonical'` 與 `'world'`，推薦新演算法優先使用 `'canonical'`；規則彈窗提供單一真相源 [`AI_PROTOCOL.md`](./AI_PROTOCOL.md) 直接下載。

---

## 三、已驗證基準帳本（Benchmark Ledger）

### 1. 軍神（`wargod`）vs 元帥（`marshal`）實力驗證
- **8 盤藍紅交替實測**（Node 單執行緒限時測試；實際瀏覽器 2～4 Worker 並行下軍神優勢更大）：
  - **總戰績：軍神 7 勝 0 和 1 敗（87.5%）**（執紅 4–0、執藍 3–1）。
  - 勝局涵蓋 4 場斬首（終局 HP `38:4`、`31:1`、`23:3`、`39:16`，全程 0 次跳過）、2 場滿 120 回合血量守勝（`16:6`、`12:7`），以及 1 場滿 120 回合 `27:27` 同血下靠 **3 次精準跳過**鎖定 **3:2 高地決勝**。
- **高預算深搜對 1000ms 元帥**：首盤即於第 49 回合以 **52:22 HP** 斬首勝出。

### 2. 五難度同演算法鏡像先後手測試（各 3 局，共 15 局）
- **合計**：**藍方 7 勝（46.7%） vs 紅方 8 勝（53.3%），0 和局**；高階兩段（元帥＋軍神）恰好 **3 : 3**。
- **分難度**：新兵 `藍 1 : 2 紅`｜戰士 `藍 3 : 0 紅`｜將軍 `藍 0 : 3 紅`｜元帥 `藍 2 : 1 紅`｜軍神 `藍 1 : 2 紅`。
- **勝負型態**：斬首局 13 場（藍 7 : 6 紅）；滿 120 回合結算 2 場全出現在軍神對局（`18:18` 同血紅方 2:0 高地勝、`4:5` 紅方險勝，紅方皆以 5 次跳過＋第 120 回合收官權守勝）。

### 3. 原版四難度單循環 BO6（打滿 6 局，3 藍 3 紅交替，共 36 局）
> 條件：100% 原版參數（將軍 `570ms`、元帥 `3070ms`），勝 1 分、和 0.5 分、滿分 18 分。

| 名次 | 難度 | 總積分 | 勝–和–敗 | 勝率 | 執藍 | 執紅 | 斬首勝 | 平均終局 HP 差 | 平均回合 |
|:---:|---|---:|:---:|---:|:---:|:---:|---:|---:|---:|
| 1 | **元帥 (`marshal`)** | **18** | 18–0–0 | 100.0% | 9/9 | 9/9 | 18 | `+22.9` | 54.9 |
| 2 | **將軍 (`general`)** | **9** | 9–0–9 | 50.0% | 5/9 | 4/9 | 9 | `-5.9` | 71.7 |
| 3 | **戰士 (`warrior`)** | **7** | 7–0–11 | 38.9% | 4/9 | 3/9 | 6 | `-1.7` | 70.7 |
| 4 | **新兵 (`recruit`)** | **2** | 2–0–16 | 11.1% | 1/9 | 1/9 | 2 | `-15.2` | 54.8 |

- **交叉戰績**：元帥對其餘三隊全數 `6:0`；將軍對新兵 `6:0`、對戰士 `3:3`；戰士對新兵 `4:2`。
- **跨測試紅藍總匯（15 局鏡像 ＋ 36 局循環賽 ＝ 51 局）**：**藍方 26 勝（51.0%） vs 紅方 25 勝（49.0%）**，0 和局。

### 4. 核心安全、模組化拆分與功能回歸驗證
- **Golden Master 回歸（對照 `1342e8c` 原版單檔 `index.html`）**：拆出 `core/` 與 5 支獨立 `ai/*.js` 後，固定種子逐手驗證 `recruit`（16 步）、`warrior`（20 步）、`general`（8 步）、`marshal`（6 步）、`wargod`（6 步）全部 **100% bit-for-bit 一致**。
- **`node tools/verify-ai.mjs` 全通過**：5 支獨立演算法檔＋`AI_PROTOCOL.md` 最小空殼範本全數通過協議契約、藍紅雙陣營嚴格合法步（`strict: true`）、乾淨 `vm` Worker 沙盒隔離、藍紅雙向迷霧零作弊審計（移動隱藏敵旗手與輕騎前後決策 100% bit-for-bit 一致）與 Abort／Dispose 健檢。
- **0-AI / 多檔匯入 / HTTP 自動探索 / 回放相容端對端驗證**：
  - `file://` 與空 `ai/` 0-AI 啟動自動切換熱座且零崩潰、不遮擋操作列；
  - 一次多選匯入 2 支同 `id` 檔＋壞檔容錯、自動區隔編號（`my_bot` vs `my_bot#2`）、同檔名熱覆蓋、分次累加並成功於 `aivai` 單步開打；
  - 真實 `python3 -m http.server` 下自動探索載入全部 5 支 `ai/*.js`（零 `manifest.json` 404），`AI_PROTOCOL.md` 下載端點回傳 200；
  - 原版 `pve` / `hotseat` / `aivai` v1 回放檔與未知自訂演算法 `id` 回放檔於 0-AI 狀態下皆成功解碼；
  - `index.html` 語法與 73 個獨立 DOM ID 完整吻合。

---

## 四、已完成里程碑（Completed Milestones）

- **2026-11-22（演算法全面單檔化與 TFC AI Protocol v1 里程碑）**
  - 抽離純規則引擎 [`core/engine.js`](./core/engine.js)（零 `aiValue`）與協議宿主 [`core/ai-host.js`](./core/ai-host.js)（FogFirewall、Rules SDK、AiRegistry、動作合法性守門員、自動探索載入器）。
  - 將 5 階演算法完全拆分為自包含單檔 `ai/{recruit,warrior,general,marshal,wargod}.js`，且經 Golden Master 驗證 **100% bit-for-bit 一致**。
  - 重構 [`index.html`](./index.html)（由 8,638 行瘦身至約 4,050 行，0 行 AI 演算法），支援 0-AI 白板模式、多檔「匯入 AI」同台對戰（B1）、規則頁下載 [`AI_PROTOCOL.md`](./AI_PROTOCOL.md) 與未知演算法回放相容。
  - 新增 [`AI_PROTOCOL.md`](./AI_PROTOCOL.md)、零相依 CLI 工具 [`tools/verify-ai.mjs`](./tools/verify-ai.mjs) 與 [`tools/arena.mjs`](./tools/arena.mjs)，以及 GitHub Pages 自動探索流程 [`.github/workflows/pages.yml`](./.github/workflows/pages.yml)（A1）。
  - 依使用者授權更新 [`AGENTS.md`](./AGENTS.md)、[`README.md`](./README.md) 與 [`PROGRESS.md`](./PROGRESS.md)。
- **2026-11-22（`88e87a5` + `1342e8c`）**
  - 新增最高難度 **軍神 · 極限推演（`wargod`）**、**AI 對弈觀戰模式（`aivai`）**、全難度 `≥ 3s` 統一思考計時，並建立標準三文件體系。
- **早期基線（`cc4f435` 及之前）**
  - 完成 10×10 中心對稱戰爭迷霧戰棋核心規則、DDA 射線、ZoC／伏擊／衝鋒破盾、人機／熱座模式、四段 AI 與 `.tfc-replay.json` v1 回放系統。

---

## 五、已知觀察與未來待辦（Known Observations & Backlog）

- **已知觀察**：
  - 原版 `general` 在 `570ms` 預算內多數停在 Depth 2（平均 `d ≈ 2.0`），正面對決自帶 2-Ply 反擊前瞻的 `warrior` 呈 `3:3` 平手（但對 `recruit` 以 `6:0` 較 `warrior` 的 `4:2` 穩定許多）；目前依鎖定原則維持原版不動。
  - 在頂尖長局（Turn 100+）下，紅方憑偶數 `MAX_TURNS = 120` 最後一動＋跳過守陣具有隱性殘局優勢，藍方則靠前中期主動搶高地與斬首對沖，整體 51 局達 51:49 高度均衡。
- **未來可選 Backlog（未排程）**：
  - 基於本次架構建立「全新無演算法版本」（刪空 `ai/*.js`）交由 AI 從零開始撰寫全新演算法並透過 `tools/arena.mjs` 與現有五階 AI 打擂台。
  - 使用 `tools/arena.mjs --round-robin` 進行 5 難度完整大循環或 Elo 天梯實測。
  - 回放全圖視角可選疊加信念／粒子熱圖供賽後復盤學習。
  - 自訂殘局擺盤／開局編輯器。

---

## 六、近期對話紀錄（Session Log）

- **2026-11-22｜核心引擎與單檔熱插拔 AI 演算法架構拆分（TFC AI Protocol v1）**
  - **設計討論與拍板**：確認目標為「後續可切出全新無演算法版本供 AI 從零撰寫，且增減任一演算法僅動 1 個檔案」。拍板廢除 `ai/shared/`、採 A1（GitHub Pages 部署產物動態生成 `manifest.json`）+ B1（網頁多檔匯入僅限當次分頁有效、同檔覆蓋、不同檔同 `id` 自動區隔）、推薦 `'canonical'` 座標系、規則頁直接提供 `AI_PROTOCOL.md` 下載、以及交付零相依 CLI 驗證與對戰工具。
  - **程式碼與文件變更**：新增 [`core/engine.js`](./core/engine.js)、[`core/ai-host.js`](./core/ai-host.js)、5 支自包含單檔 [`ai/*.js`](./ai/)、[`AI_PROTOCOL.md`](./AI_PROTOCOL.md)、[`tools/verify-ai.mjs`](./tools/verify-ai.mjs)、[`tools/arena.mjs`](./tools/arena.mjs)、[`.github/workflows/pages.yml`](./.github/workflows/pages.yml)；瘦身改寫 [`index.html`](./index.html) 並更新 [`AGENTS.md`](./AGENTS.md)、[`README.md`](./README.md)、[`PROGRESS.md`](./PROGRESS.md)。
  - **驗證結果**：5 階既有 AI 與 `1342e8c` Golden Master **100% bit-for-bit 一致**；全數通過 `verify-ai.mjs`（協議、合法步、Worker 沙盒、雙向迷霧零作弊）；`arena.mjs`、`AI_PROTOCOL.md` 空殼範本、0-AI 啟動、多檔匯入對戰、真實 HTTP 自動探索與 v1 舊版／未知演算法回放相容測試全數通過。
  - **GitHub Pages 上線修復（雙保險）**：排查線上站台為 0 演算法之主因為 Repo Pages `build_type` 仍停在 `legacy`（`main` 分支部署晚於 Actions 19 秒覆蓋了 `ai/manifest.json`）；經使用者授權切換 GitHub Pages 來源為 `workflow`（GitHub Actions），並於 [`core/ai-host.js`](./core/ai-host.js) 新增 `*.github.io` 找不到 `manifest.json` 時自動退回 GitHub Contents API 讀取 `ai/*.js` 清單之防呆備援。
- **2026-11-22｜軍神難度實作、AI 對弈觀戰、紅藍與循環賽基準測試、建立標準開發文件**
  - 完成 `index.html` 軍神引擎、AI 對弈三視野觀戰、全難度 `≥ 3s` 思考計時與三文件體系（`88e87a5`、`1342e8c`）；軍神 vs 元帥 8 盤 **7–0–1（87.5%）**、15 局鏡像＋36 局四難度原版 BO6 循環賽合計 51 局呈現藍 26 : 25 紅高度平衡。
