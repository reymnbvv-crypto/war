(function (root, factory) {
  const engine = (typeof module === 'object' && module.exports && typeof require === 'function')
    ? require('./engine.js')
    : (root && root.TFCEngine);
  const api = factory(engine);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TFC_AI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Engine) {
  'use strict';

  /* =========================================================
   * 迷霧陣線（Tactical Fog Chess）AI 協議宿主（Protocol v1）
   * 負責：
   *  1. AiRegistry（演算法註冊表、多檔匯入、重複 id 智慧區隔）
   *  2. FogFirewall（180° 規範化適配、嚴格零作弊觀測過濾）
   *  3. 唯讀 Rules SDK（零全域狀態存取）
   *  4. MatchAgentHost（每局雙陣營實例隔離、生命週期事件流、
   *     Worker 託管與自動清理、超時保護、動作合法性守門員）
   *  5. 瀏覽器自動探索載入器（HTTP 目錄 / A1 manifest / 檔案匯入）
   * ========================================================= */

  const PROTOCOL_VERSION = 1;
  const DEFAULT_TIMEOUT_MS = 30000;
  const ID_PATTERN = /^[A-Za-z0-9._#-]+$/;

  /* ---------------- 180° 中心鏡像適配層 ---------------- */
  function canonicalCoord(x, y, faction) {
    return faction === 'red'
      ? { x, y }
      : { x: Engine.BOARD_SIZE - 1 - x, y: Engine.BOARD_SIZE - 1 - y };
  }

  function canonicalCell(x, y, faction) {
    const p = canonicalCoord(x, y, faction);
    return Engine.cellIndex(p.x, p.y);
  }

  function canonicalId(id, faction) {
    if (!id || faction === 'red') return id;
    return (id[0] === 'B' ? 'R' : 'B') + id.slice(1);
  }

  function canonicalFaction(f, actorFaction) {
    return actorFaction === 'red' ? f : Engine.opponentOf(f);
  }

  function cloneVision(vision) {
    return {
      tileVisible: vision.tileVisible.map(row => row.slice()),
      forestReveal: vision.forestReveal.map(row => row.slice()),
      detectedEnemyIds: new Set(vision.detectedEnemyIds)
    };
  }

  function canonicalVision(vision, faction) {
    if (faction === 'red') return cloneVision(vision);
    const N = Engine.BOARD_SIZE;
    const tileVisible = Array.from({ length: N }, (_, y) =>
      Array.from({ length: N }, (_, x) => vision.tileVisible[N - 1 - y][N - 1 - x]));
    const forestReveal = Array.from({ length: N }, (_, y) =>
      Array.from({ length: N }, (_, x) => vision.forestReveal[N - 1 - y][N - 1 - x]));
    const detectedEnemyIds = new Set();
    for (const id of vision.detectedEnemyIds) detectedEnemyIds.add(canonicalId(id, 'blue'));
    return { tileVisible, forestReveal, detectedEnemyIds };
  }

  function canonicalObservedBoard(board, vision, faction) {
    const raw = Engine.createObservedBoard(board, faction, vision, false);
    const mapCopy = Engine.cloneMap(raw.map);
    if (faction === 'red') {
      return {
        map: mapCopy,
        units: raw.units.map(u => ({ ...u }))
      };
    }
    const N = Engine.BOARD_SIZE;
    return {
      map: mapCopy,
      units: raw.units.map(unit => ({
        ...unit,
        id: canonicalId(unit.id, 'blue'),
        faction: canonicalFaction(unit.faction, 'blue'),
        x: N - 1 - unit.x,
        y: N - 1 - unit.y
      }))
    };
  }

  function worldObservedBoard(board, vision, faction) {
    const raw = Engine.createObservedBoard(board, faction, vision, false);
    return {
      map: Engine.cloneMap(raw.map),
      units: raw.units.map(u => ({ ...u }))
    };
  }

  function fromCanonicalAction(action, faction) {
    if (!action || faction === 'red' || action.type === 'skip') return action;
    const N = Engine.BOARD_SIZE;
    const mapped = {
      ...action,
      unitId: canonicalId(action.unitId, 'blue'),
      targetId: action.targetId ? canonicalId(action.targetId, 'blue') : null
    };
    if (typeof action.tx === 'number' && typeof action.ty === 'number') {
      mapped.tx = N - 1 - action.tx;
      mapped.ty = N - 1 - action.ty;
    }
    if (Array.isArray(action.path)) {
      mapped.path = action.path.map(({ x, y }) => ({ x: N - 1 - x, y: N - 1 - y }));
    }
    return mapped;
  }

  /* ---------------- 唯讀 Rules SDK ---------------- */
  function createRulesSdk(engine = Engine) {
    return Object.freeze({
      BOARD_SIZE: engine.BOARD_SIZE,
      MAX_TURNS: engine.MAX_TURNS,
      CELL_COUNT: engine.CELL_COUNT,
      VISION_WORDS: engine.VISION_WORDS,
      DIRS: engine.DIRS,
      HILL_COORDS: engine.HILL_COORDS,
      FOREST_COORDS: engine.FOREST_COORDS,
      UNIT_DEFS: engine.UNIT_DEFS,
      TYPE_NAMES: engine.TYPE_NAMES,
      INITIAL_BLUE_UNITS: engine.INITIAL_BLUE_UNITS,
      BLUE_SLOTS: engine.BLUE_SLOTS,
      keyOf: engine.keyOf,
      inBounds: engine.inBounds,
      manhattan: engine.manhattan,
      cellIndex: engine.cellIndex,
      opponentOf: engine.opponentOf,
      factionName: engine.factionName,
      getUnitById: engine.getUnitById,
      getUnitAt: engine.getUnitAt,
      getAliveFlag: engine.getAliveFlag,
      hasLineOfSight: engine.hasLineOfSight,
      computeVisionData: engine.computeVisionData,
      isTileScanned: engine.isTileScanned,
      isInEnemyShieldZoc: engine.isInEnemyShieldZoc,
      getMoveStepCost: engine.getMoveStepCost,
      computeReachableFor: engine.computeReachableFor,
      canUnitAttackTargetWithVision: engine.canUnitAttackTargetWithVision,
      getValidAttackTargetsFor: engine.getValidAttackTargetsFor,
      countAdjacentUnits: engine.countAdjacentUnits,
      hasFlagAura: engine.hasFlagAura,
      isChargeActive: engine.isChargeActive,
      calcEffectiveAtk: engine.calcEffectiveAtk,
      calcEffectiveDef: engine.calcEffectiveDef,
      previewCombat: engine.previewCombat,
      countOccupiedHills: engine.countOccupiedHills,
      evaluateVictory: engine.evaluateVictory,
      evaluateTurnLimitVictory: engine.evaluateTurnLimitVictory,
      validateAction: engine.validateAction,
      generateLegalActions(obsOrBoard, vision, faction) {
        if (obsOrBoard && obsOrBoard.board && obsOrBoard.vision && obsOrBoard.myFaction) {
          return engine.generateLegalActions(obsOrBoard.board, obsOrBoard.vision, obsOrBoard.myFaction);
        }
        return engine.generateLegalActions(obsOrBoard, vision, faction);
      }
    });
  }

  /* ---------------- 演算法描述驗證與註冊表 ---------------- */
  function validateManifest(algo) {
    if (!algo || typeof algo !== 'object') {
      throw new Error('演算法模組必須匯出物件');
    }
    if (algo.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`不支援的 protocolVersion：${String(algo.protocolVersion)}（需要 ${PROTOCOL_VERSION}）`);
    }
    if (typeof algo.id !== 'string' || !algo.id.trim() || !ID_PATTERN.test(algo.id.trim())) {
      throw new Error('演算法 id 必須為非空英數／符號字串（^[A-Za-z0-9._#-]+$）');
    }
    if (typeof algo.name !== 'string' || !algo.name.trim()) {
      throw new Error('演算法 name 必須為非空字串');
    }
    if (typeof algo.createAgent !== 'function') {
      throw new Error('演算法必須提供 createAgent(initCtx) 工廠函式');
    }
    const coord = algo.coordinateSpace ?? 'canonical';
    if (coord !== 'canonical' && coord !== 'world') {
      throw new Error(`無效的 coordinateSpace：${String(coord)}（僅允許 "canonical" 或 "world"）`);
    }
    const pacingDelayMs = algo.pacingDelayMs ?? 0;
    if (typeof pacingDelayMs !== 'number' || !Number.isFinite(pacingDelayMs) || pacingDelayMs < 0) {
      throw new Error('pacingDelayMs 必須為非負有限數字');
    }
    const timeoutMs = algo.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs) || timeoutMs < 0) {
      throw new Error('timeoutMs 必須為非負數字');
    }
    const order = algo.order ?? 100;
    if (typeof order !== 'number' || !Number.isFinite(order)) {
      throw new Error('order 必須為有限數字');
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      id: algo.id.trim(),
      name: algo.name.trim(),
      label: typeof algo.label === 'string' && algo.label.trim() ? algo.label.trim() : algo.name.trim(),
      order,
      coordinateSpace: coord,
      thinkingText: typeof algo.thinkingText === 'string' && algo.thinkingText.trim()
        ? algo.thinkingText.trim()
        : '推演中…',
      pacingDelayMs,
      timeoutMs,
      createAgent: algo.createAgent,
      // 保留選填自訂詮釋資料（如 version / author / description）
      version: typeof algo.version === 'string' ? algo.version : '',
      author: typeof algo.author === 'string' ? algo.author : '',
      description: typeof algo.description === 'string' ? algo.description : ''
    };
  }

  function createRegistry() {
    const entries = new Map();
    const listeners = new Set();

    const notify = () => {
      for (const fn of listeners) {
        try { fn(list()); } catch (err) { console.error('Registry listener error', err); }
      }
    };

    function shortFileLabel(sourceFile) {
      if (!sourceFile) return '';
      const base = sourceFile.split(/[\\/]/).pop() || sourceFile;
      return base.replace(/\.js$/i, '');
    }

    function register(rawAlgo, meta = {}) {
      const spec = validateManifest(rawAlgo);
      const source = meta.source || 'discovered';
      const sourceFile = meta.sourceFile || '';
      const originalId = spec.id;
      let finalId = originalId;
      let finalName = spec.name;
      let finalLabel = spec.label;
      let status = 'added';

      if (entries.has(originalId)) {
        const existing = entries.get(originalId);
        if (source === 'imported') {
          const sameImportedFile = existing.source === 'imported'
            && existing.sourceFile && sourceFile && existing.sourceFile === sourceFile;
          if (sameImportedFile) {
            status = 'updated';
          } else {
            // 同檔名未匹配且 id 重複：為多版本同場競技自動分配不衝突執行期 ID
            let n = 2;
            while (entries.has(`${originalId}#${n}`)) n++;
            // 若同一個檔案先前已曾被重新命名註冊過，改為覆蓋它
            let matchedPrevious = null;
            if (sourceFile) {
              for (const item of entries.values()) {
                if (item.source === 'imported' && item.sourceFile === sourceFile && item.originalId === originalId) {
                  matchedPrevious = item;
                  break;
                }
              }
            }
            if (matchedPrevious) {
              finalId = matchedPrevious.id;
              finalName = matchedPrevious.name;
              finalLabel = matchedPrevious.label;
              status = 'updated';
            } else {
              finalId = `${originalId}#${n}`;
              const tag = shortFileLabel(sourceFile) || `#${n}`;
              finalName = `${spec.name}(${tag})`;
              finalLabel = `${spec.label} [${tag}]`;
              status = 'renamed';
            }
          }
        } else {
          status = 'updated';
        }
      }

      const displayLabel = source === 'imported' && !finalLabel.includes('匯入')
        ? `${finalLabel} · 匯入`
        : finalLabel;

      const entry = Object.freeze({
        ...spec,
        id: finalId,
        originalId,
        name: finalName,
        label: displayLabel,
        source,
        sourceFile
      });
      entries.set(finalId, entry);
      notify();
      return { status, originalId, entry };
    }

    function list() {
      return [...entries.values()].sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        if ((a.source === 'imported') !== (b.source === 'imported')) {
          return a.source === 'imported' ? 1 : -1;
        }
        return a.id.localeCompare(b.id);
      });
    }

    function get(id) {
      return entries.get(id) || null;
    }

    function has(id) {
      return entries.has(id);
    }

    function unregister(id) {
      const removed = entries.delete(id);
      if (removed) notify();
      return removed;
    }

    function clear() {
      entries.clear();
      notify();
    }

    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    return { register, list, get, has, unregister, clear, subscribe };
  }

  /* ---------------- 隔離式單檔程式碼載入 ---------------- */
  function evaluateAiSource(registry, filename, sourceCode, meta = {}) {
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) {
      return { ok: false, filename, error: '檔案內容為空' };
    }
    const captured = [];
    const scopedProxy = {
      PROTOCOL_VERSION,
      register(algo) {
        captured.push(algo);
      }
    };
    const initExports = {};
    const mod = { exports: initExports };
    const prevGlobal = typeof globalThis !== 'undefined' ? globalThis.TFC_AI : undefined;
    const hadGlobal = typeof globalThis !== 'undefined' && Object.prototype.hasOwnProperty.call(globalThis, 'TFC_AI');

    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.TFC_AI = Object.assign(Object.create(prevGlobal || Object.prototype), {
          register: scopedProxy.register
        });
      }
      const runner = new Function('TFC_AI', 'module', 'exports', 'TFCEngine', `${sourceCode}\n//# sourceURL=${filename}`);
      runner(scopedProxy, mod, mod.exports, Engine);
    } catch (err) {
      return { ok: false, filename, error: `腳本執行失敗：${err && err.message ? err.message : String(err)}` };
    } finally {
      if (typeof globalThis !== 'undefined') {
        if (hadGlobal) globalThis.TFC_AI = prevGlobal;
        else delete globalThis.TFC_AI;
      }
    }

    // 若檔案只用 module.exports 匯出而未呼叫 TFC_AI.register，同樣支援！
    if (captured.length === 0 && mod.exports && typeof mod.exports === 'object' && mod.exports !== initExports) {
      captured.push(mod.exports);
    }
    if (captured.length === 0) {
      return { ok: false, filename, error: '檔案未呼叫 TFC_AI.register(...) 亦未匯出演算法物件' };
    }

    const registered = [];
    const errors = [];
    for (const algo of captured) {
      try {
        const res = registry.register(algo, {
          source: meta.source || 'imported',
          sourceFile: filename
        });
        registered.push(res);
      } catch (err) {
        errors.push(err && err.message ? err.message : String(err));
      }
    }
    if (registered.length === 0) {
      return { ok: false, filename, error: errors.join('；') || '演算法註冊失敗' };
    }
    return { ok: true, filename, results: registered, warnings: errors };
  }

  /* ---------------- 瀏覽器自動探索（HTTP 目錄 / A1 manifest） ---------------- */
  function parseDirectoryHtmlForJs(htmlText) {
    if (typeof htmlText !== 'string') return [];
    const found = new Set();
    const regex = /href\s*=\s*["']([^"'?#]+)["']/gi;
    let m;
    while ((m = regex.exec(htmlText)) !== null) {
      let href = m[1].trim();
      try { href = decodeURIComponent(href); } catch {}
      if (href.startsWith('./')) href = href.slice(2);
      if (href.startsWith('/')) {
        const parts = href.split('/').filter(Boolean);
        href = parts[parts.length - 1] || '';
      }
      if (!href || href.includes('/') || href.includes('\\') || href.includes('..')) continue;
      if (/^[A-Za-z0-9._-]+\.js$/i.test(href)) {
        found.add(href);
      }
    }
    return [...found].sort((a, b) => a.localeCompare(b));
  }

  async function tryFetchManifest(baseDir) {
    try {
      const res = await fetch(`${baseDir}manifest.json`, { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      const rawList = Array.isArray(data) ? data : (Array.isArray(data?.files) ? data.files : null);
      if (!rawList) return null;
      return rawList
        .filter(item => typeof item === 'string' && /^[A-Za-z0-9._-]+\.js$/i.test(item))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return null;
    }
  }

  async function tryFetchDirectoryListing(baseDir) {
    try {
      const res = await fetch(baseDir, { cache: 'no-store' });
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.includes('text/html') && !ct.includes('text/plain')) return null;
      const text = await res.text();
      // 避免誤把 SPA fallback index.html 當成目錄列表
      if (text.includes('id="battleLayout"') || text.includes('id="board"')) return null;
      return parseDirectoryHtmlForJs(text);
    } catch {
      return null;
    }
  }

  async function discoverAndLoadBrowserAis(registry, baseDir = './ai/') {
    if (typeof location === 'object' && location.protocol === 'file:') {
      return { mode: 'file', files: [], loaded: [], errors: [] };
    }
    if (typeof fetch !== 'function') {
      return { mode: 'unsupported', files: [], loaded: [], errors: [] };
    }

    const host = (typeof location === 'object' && location.hostname) ? location.hostname.toLowerCase() : '';
    const preferManifest = host.endsWith('.github.io') || (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '[::1]' && host !== '');

    let files = null;
    let mode = 'none';
    if (preferManifest) {
      files = await tryFetchManifest(baseDir);
      if (files !== null) mode = 'manifest';
      else {
        files = await tryFetchDirectoryListing(baseDir);
        if (files !== null) mode = 'directory';
      }
    } else {
      files = await tryFetchDirectoryListing(baseDir);
      if (files !== null) mode = 'directory';
      else {
        files = await tryFetchManifest(baseDir);
        if (files !== null) mode = 'manifest';
      }
    }

    if (!files || files.length === 0) {
      return { mode, files: [], loaded: [], errors: [] };
    }

    const loaded = [];
    const errors = [];
    for (const filename of files) {
      try {
        const res = await fetch(`${baseDir}${encodeURIComponent(filename)}`, { cache: 'no-store' });
        if (!res.ok) {
          errors.push({ filename, error: `HTTP ${res.status}` });
          continue;
        }
        const code = await res.text();
        const evalRes = evaluateAiSource(registry, filename, code, { source: 'discovered' });
        if (evalRes.ok) {
          loaded.push(...evalRes.results.map(r => r.entry));
        } else {
          errors.push({ filename, error: evalRes.error });
        }
      } catch (err) {
        errors.push({ filename, error: err && err.message ? err.message : String(err) });
      }
    }
    return { mode, files, loaded, errors };
  }

  /* ---------------- 對局宿主（FogFirewall + 實例隔離 + 守門員） ---------------- */
  function createMatchHost(registry, options = {}) {
    const engine = options.engine || Engine;
    const rulesSdk = createRulesSdk(engine);
    const strict = Boolean(options.strict);

    const slots = { blue: null, red: null };
    let activeSession = null;

    function createWorkerTracker() {
      const workers = new Set();
      const urls = new Set();
      const cleanup = () => {
        for (const w of workers) {
          try { w.terminate(); } catch {}
        }
        workers.clear();
        for (const u of urls) {
          try { URL.revokeObjectURL(u); } catch {}
        }
        urls.clear();
      };
      const canUseWorker = (() => {
        if (options.allowWorkers === false) return false;
        if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL !== 'function' || typeof URL.createObjectURL !== 'function') {
          return false;
        }
        if (typeof location === 'object' && location.protocol === 'file:') return false;
        return true;
      })();

      const spawnBlobWorker = (sourceCode) => {
        if (!canUseWorker) {
          throw new Error('當前環境不支援 Blob Worker');
        }
        const url = URL.createObjectURL(new Blob([sourceCode], { type: 'text/javascript' }));
        urls.add(url);
        try {
          const worker = new Worker(url);
          workers.add(worker);
          const origTerminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            workers.delete(worker);
            return origTerminate();
          };
          return worker;
        } catch (err) {
          try { URL.revokeObjectURL(url); } catch {}
          urls.delete(url);
          throw err;
        }
      };

      return { canUseWorker, spawnBlobWorker, cleanup };
    }

    function cancelActive() {
      const s = activeSession;
      activeSession = null;
      if (!s) return;
      if (s.timeoutTimer !== null) clearTimeout(s.timeoutTimer);
      try { s.controller.abort(); } catch {}
      s.tracker.cleanup();
    }

    function dispose() {
      cancelActive();
      for (const faction of ['blue', 'red']) {
        const slot = slots[faction];
        slots[faction] = null;
        if (slot && slot.agent && typeof slot.agent.dispose === 'function') {
          try { slot.agent.dispose(); } catch (err) { console.error('AI dispose 異常', err); }
        }
      }
    }

    function initMatch(gameState, config = {}) {
      dispose();
      const mapCopy = engine.cloneMap(gameState.map);
      const rngFor = config.rngFor || (() => Math.random);

      for (const faction of ['blue', 'red']) {
        const algoId = faction === 'blue' ? config.blueAlgoId : config.redAlgoId;
        if (!algoId) continue;
        const spec = registry.get(algoId);
        if (!spec) {
          if (strict) throw new Error(`找不到演算法：${algoId}`);
          continue;
        }
        const coordSpace = spec.coordinateSpace;
        const myFaction = coordSpace === 'canonical' ? 'red' : faction;
        const rng = rngFor(faction, spec);
        const matchInfo = Object.freeze({
          boardSize: engine.BOARD_SIZE,
          maxTurns: engine.MAX_TURNS,
          coordinateSpace: coordSpace,
          myFaction,
          realFaction: faction,
          terrainMap: engine.cloneMap(mapCopy),
          initialBlueUnits: engine.INITIAL_BLUE_UNITS
        });
        const initCtx = Object.freeze({
          protocolVersion: PROTOCOL_VERSION,
          rules: rulesSdk,
          match: matchInfo,
          rng
        });
        const agent = spec.createAgent(initCtx);
        if (!agent || typeof agent.decideTurn !== 'function') {
          throw new Error(`演算法「${spec.id}」的 createAgent() 未回傳含 decideTurn 的實例`);
        }
        if (typeof agent.onMatchStart === 'function') {
          agent.onMatchStart(matchInfo);
        }
        slots[faction] = { spec, agent, coordSpace, myFaction, rng };
      }
    }

    function buildObservationForSlot(gameState, faction, slot) {
      const rawVision = gameState.visionByFaction[faction];
      const useCanonical = slot.coordSpace === 'canonical';
      const board = useCanonical
        ? canonicalObservedBoard(gameState, rawVision, faction)
        : worldObservedBoard(gameState, rawVision, faction);
      const vision = useCanonical
        ? canonicalVision(rawVision, faction)
        : cloneVision(rawVision);
      return {
        protocolVersion: PROTOCOL_VERSION,
        turn: gameState.turn,
        maxTurns: engine.MAX_TURNS,
        turnsSinceDamage: gameState.turnsSinceDamage,
        coordinateSpace: slot.coordSpace,
        myFaction: slot.myFaction,
        realFaction: faction,
        board,
        vision
      };
    }

    function dispatchEvent(faction, event) {
      const slot = slots[faction];
      if (!slot || typeof slot.agent.onEvent !== 'function') return;
      try {
        slot.agent.onEvent(event);
      } catch (err) {
        if (strict) throw err;
        console.error(`AI(${slot.spec.id}) 處理事件 ${event.type} 異常`, err);
      }
    }

    function notifyVisionSync(gameState, faction) {
      const slot = slots[faction];
      if (!slot) return;
      const obs = buildObservationForSlot(gameState, faction, slot);
      dispatchEvent(faction, {
        type: 'vision_sync',
        turn: gameState.turn,
        isMyTurn: gameState.activeFaction === faction,
        myFaction: obs.myFaction,
        board: obs.board,
        vision: obs.vision
      });
    }

    function notifyEnemySeenAction(gameState, observerFaction, unitId, x, y, kind = 'move') {
      const slot = slots[observerFaction];
      if (!slot) return;
      const useCanonical = slot.coordSpace === 'canonical';
      const pos = useCanonical ? canonicalCoord(x, y, observerFaction) : { x, y };
      dispatchEvent(observerFaction, {
        type: 'enemy_seen_action',
        turn: gameState.turn,
        unitId: useCanonical ? canonicalId(unitId, observerFaction) : unitId,
        x: pos.x,
        y: pos.y,
        cell: engine.cellIndex(pos.x, pos.y),
        kind
      });
    }

    function notifyFogAttack(gameState, defenderFaction, target, damage, canCounter) {
      const slot = slots[defenderFaction];
      if (!slot) return;
      const useCanonical = slot.coordSpace === 'canonical';
      const pos = useCanonical ? canonicalCoord(target.x, target.y, defenderFaction) : { x: target.x, y: target.y };
      const cellObj = gameState.map[target.y][target.x];
      dispatchEvent(defenderFaction, {
        type: 'fog_attack_received',
        turn: gameState.turn,
        targetId: useCanonical ? canonicalId(target.id, defenderFaction) : target.id,
        targetX: pos.x,
        targetY: pos.y,
        targetCell: engine.cellIndex(pos.x, pos.y),
        damage,
        canCounter,
        rangedOnly: !canCounter && target.type !== 'archer',
        targetElev: cellObj.elev,
        targetBaseDef: engine.UNIT_DEFS[target.type].baseDef + (cellObj.terrain === 'forest' ? 1 : 0)
      });
    }

    function notifyEnemyKilled(gameState, observerFaction, unitId) {
      const slot = slots[observerFaction];
      if (!slot) return;
      const useCanonical = slot.coordSpace === 'canonical';
      dispatchEvent(observerFaction, {
        type: 'enemy_killed',
        turn: gameState.turn,
        unitId: useCanonical ? canonicalId(unitId, observerFaction) : unitId
      });
    }

    function notifyTurnAdvance(gameState, nextFaction) {
      const slot = slots[nextFaction];
      if (!slot) return;
      const obs = buildObservationForSlot(gameState, nextFaction, slot);
      dispatchEvent(nextFaction, {
        type: 'turn_advance',
        turn: gameState.turn,
        turnsSinceDamage: gameState.turnsSinceDamage,
        myFaction: obs.myFaction,
        board: obs.board,
        vision: obs.vision
      });
    }

    function notifySelfAction(gameState, faction, details) {
      const slot = slots[faction];
      if (!slot) return;
      const useCanonical = slot.coordSpace === 'canonical';
      const mapped = {
        type: 'self_action_result',
        turn: gameState.turn,
        actionType: details.actionType,
        unitId: details.unitId ? (useCanonical ? canonicalId(details.unitId, faction) : details.unitId) : null,
        displacement: details.displacement || 0,
        ambushed: Boolean(details.ambushed),
        zocInterrupted: Boolean(details.zocInterrupted)
      };
      if (details.from) {
        mapped.from = useCanonical ? canonicalCoord(details.from.x, details.from.y, faction) : { ...details.from };
      }
      if (details.to) {
        mapped.to = useCanonical ? canonicalCoord(details.to.x, details.to.y, faction) : { ...details.to };
      }
      dispatchEvent(faction, mapped);
    }

    function toWorldAndValidate(rawAction, gameState, faction, slot) {
      const worldVision = gameState.visionByFaction[faction];
      const worldBoard = engine.createObservedBoard(gameState, faction, worldVision, false);
      const worldAction = slot.coordSpace === 'canonical'
        ? fromCanonicalAction(rawAction, faction)
        : rawAction;
      return engine.validateAction(worldAction, worldBoard, worldVision, faction);
    }

    async function decideTurn(gameState, faction, runtimeOpts = {}) {
      const slot = slots[faction];
      if (!slot) throw new Error(`陣營 ${faction} 尚未掛載 AI 實例`);
      cancelActive();

      const obs = buildObservationForSlot(gameState, faction, slot);
      const controller = new AbortController();
      const tracker = createWorkerTracker();
      const timeoutMs = runtimeOpts.timeoutMs !== undefined ? runtimeOpts.timeoutMs : slot.spec.timeoutMs;
      let latestValidProgressAction = null;
      let timedOut = false;

      const session = { controller, tracker, timeoutTimer: null };
      activeSession = session;

      const runtime = Object.freeze({
        signal: controller.signal,
        rng: runtimeOpts.rng || slot.rng || Math.random,
        now: runtimeOpts.now || (() => (typeof performance === 'object' ? performance.now() : Date.now())),
        canUseWorker: runtimeOpts.allowWorkers === false ? false : tracker.canUseWorker,
        hardwareConcurrency: runtimeOpts.hardwareConcurrency
          || ((typeof navigator === 'object' && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 2),
        isAiVsAi: Boolean(runtimeOpts.isAiVsAi),
        speedFactor: typeof runtimeOpts.speedFactor === 'number' ? runtimeOpts.speedFactor : 1,
        spawnBlobWorker: tracker.spawnBlobWorker,
        reportProgress(info) {
          if (activeSession !== session || !info) return;
          if (info.bestAction) {
            const check = toWorldAndValidate(info.bestAction, gameState, faction, slot);
            if (check.valid) latestValidProgressAction = check.action;
          }
          if (typeof runtimeOpts.onProgress === 'function') {
            try { runtimeOpts.onProgress(info); } catch {}
          }
        },
        // 選填測試／決定性回放鉤子（實戰皆為 undefined）
        testOverrides: runtimeOpts.testOverrides || null
      });

      const decisionPromise = Promise.resolve().then(() => slot.agent.decideTurn(obs, runtime));

      let resultPromise = decisionPromise;
      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        resultPromise = new Promise((resolve, reject) => {
          session.timeoutTimer = setTimeout(() => {
            timedOut = true;
            try { controller.abort(); } catch {}
            tracker.cleanup();
            if (strict) {
              reject(new Error(`AI(${slot.spec.id}) 思考超時（>${timeoutMs}ms）`));
            } else {
              resolve(null);
            }
          }, timeoutMs);

          decisionPromise.then(
            val => {
              clearTimeout(session.timeoutTimer);
              session.timeoutTimer = null;
              resolve(val);
            },
            err => {
              clearTimeout(session.timeoutTimer);
              session.timeoutTimer = null;
              reject(err);
            }
          );
        });
      }

      let rawAction = null;
      try {
        rawAction = await resultPromise;
      } catch (err) {
        if (controller.signal.aborted && !timedOut) {
          tracker.cleanup();
          return { aborted: true, action: null };
        }
        if (strict) {
          tracker.cleanup();
          throw err;
        }
        console.error(`AI(${slot.spec.id}) 決策拋出例外，將安全降級`, err);
      } finally {
        if (session.timeoutTimer !== null) clearTimeout(session.timeoutTimer);
        tracker.cleanup();
        if (activeSession === session) activeSession = null;
      }

      if (controller.signal.aborted && !timedOut) {
        return { aborted: true, action: null };
      }

      if (timedOut) {
        const fallback = latestValidProgressAction || { type: 'skip' };
        console.warn(`AI(${slot.spec.id}) 超過 ${timeoutMs}ms，採用${latestValidProgressAction ? '最後暫定最佳手' : '安全跳過'}`);
        return { aborted: false, timedOut: true, action: fallback };
      }

      const check = toWorldAndValidate(rawAction, gameState, faction, slot);
      if (check.valid) {
        return { aborted: false, timedOut: false, action: check.action };
      }

      const reason = `AI(${slot.spec.id}) 回傳不合法動作（${check.reason}）`;
      if (strict) throw new Error(reason);
      console.warn(reason, rawAction);
      return {
        aborted: false,
        timedOut: false,
        invalidReason: check.reason,
        action: latestValidProgressAction || { type: 'skip' }
      };
    }

    function decidePostMoveAttack(gameState, faction, postCtx) {
      const slot = slots[faction];
      if (!slot || typeof slot.agent.decidePostMoveAttack !== 'function') return null;

      const worldVision = gameState.visionByFaction[faction];
      const worldBoard = engine.createObservedBoard(gameState, faction, worldVision, false);
      const unit = engine.getUnitById(postCtx.unitId, worldBoard);
      if (!unit || !unit.alive) return null;

      const allLegalTargets = [...engine.getValidAttackTargetsFor(unit, worldVision, worldBoard)];
      const eligibleWorldTargets = allLegalTargets.filter(
        id => postCtx.reconsider || !postCtx.initiallyVisibleEnemyIds.has(id)
      );
      if (!eligibleWorldTargets.length) return null;

      const useCanonical = slot.coordSpace === 'canonical';
      const obs = buildObservationForSlot(gameState, faction, slot);
      const mappedInitial = new Set();
      for (const id of postCtx.initiallyVisibleEnemyIds) {
        mappedInitial.add(useCanonical ? canonicalId(id, faction) : id);
      }
      const mappedLegal = eligibleWorldTargets.map(id => (useCanonical ? canonicalId(id, faction) : id));

      const ctx = {
        unitId: useCanonical ? canonicalId(postCtx.unitId, faction) : postCtx.unitId,
        displacement: postCtx.displacement,
        initiallyVisibleEnemyIds: mappedInitial,
        reconsider: Boolean(postCtx.reconsider),
        legalTargetIds: mappedLegal,
        rng: postCtx.rng || slot.rng || Math.random
      };

      let chosen = null;
      try {
        chosen = slot.agent.decidePostMoveAttack(obs, ctx);
      } catch (err) {
        if (strict) throw err;
        console.error(`AI(${slot.spec.id}) decidePostMoveAttack 異常`, err);
        return null;
      }
      if (!chosen) return null;
      const worldTargetId = useCanonical ? canonicalId(chosen, faction) : chosen;
      if (allLegalTargets.includes(worldTargetId)) return worldTargetId;
      if (strict) throw new Error(`AI(${slot.spec.id}) 追加攻擊目標不合法：${String(chosen)}`);
      console.warn(`AI(${slot.spec.id}) 追加攻擊目標不合法，已忽略`, chosen);
      return null;
    }

    function getSlotSpec(faction) {
      return slots[faction]?.spec || null;
    }

    return {
      initMatch,
      cancelActive,
      dispose,
      getSlotSpec,
      notifyVisionSync,
      notifyEnemySeenAction,
      notifyFogAttack,
      notifyEnemyKilled,
      notifyTurnAdvance,
      notifySelfAction,
      decideTurn,
      decidePostMoveAttack
    };
  }

  const defaultRegistry = createRegistry();

  return {
    PROTOCOL_VERSION,
    DEFAULT_TIMEOUT_MS,
    register: defaultRegistry.register,
    list: defaultRegistry.list,
    get: defaultRegistry.get,
    has: defaultRegistry.has,
    unregister: defaultRegistry.unregister,
    clear: defaultRegistry.clear,
    subscribe: defaultRegistry.subscribe,
    createRegistry,
    validateManifest,
    createRulesSdk,
    evaluateAiSource,
    parseDirectoryHtmlForJs,
    discoverAndLoadBrowserAis,
    createMatchHost,
    canonicalCoord,
    canonicalCell,
    canonicalId,
    canonicalFaction,
    canonicalVision,
    canonicalObservedBoard,
    fromCanonicalAction
  };
});
