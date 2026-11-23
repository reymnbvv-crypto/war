#!/usr/bin/env node
/**
 * 迷霧陣線（Tactical Fog Chess）AI 演算法合規與零作弊自動化驗證工具
 * 用法：
 *   node tools/verify-ai.mjs                 # 自動掃描並驗證 ai/*.js 全部演算法
 *   node tools/verify-ai.mjs ai/my_bot.js    # 驗證指定的一或多個演算法檔案
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const Engine = require(path.join(ROOT, 'core/engine.js'));
const AiHost = require(path.join(ROOT, 'core/ai-host.js'));

function createSeededRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createFreshGameState() {
  const state = {
    map: Engine.createTerrainGrid(),
    units: Engine.createInitialUnits(),
    turn: 1,
    turnsSinceDamage: 0,
    damageThisTurn: false,
    activeFaction: 'blue',
    phase: 'SELECT_OR_ACT',
    winner: null,
    visionByFaction: { blue: null, red: null }
  };
  state.visionByFaction.blue = Engine.computeVisionData('blue', state);
  state.visionByFaction.red = Engine.computeVisionData('red', state);
  return state;
}

function makeStepHelpers(state, host) {
  const recompute = () => {
    state.visionByFaction.blue = Engine.computeVisionData('blue', state);
    state.visionByFaction.red = Engine.computeVisionData('red', state);
    host.notifyVisionSync(state, 'blue');
    host.notifyVisionSync(state, 'red');
  };
  const applyDamage = (unit, dmg) => {
    const lost = Math.min(unit.hp, dmg);
    unit.hp -= lost;
    unit.alive = unit.hp > 0;
    if (!unit.alive) host.notifyEnemyKilled(state, Engine.opponentOf(unit.faction), unit.id);
    return lost;
  };
  const resolveCombat = (attacker, target, chargeDisp) => {
    const result = Engine.previewCombat(attacker, target, chargeDisp, state);
    const obs = state.visionByFaction[target.faction].detectedEnemyIds.has(attacker.id);
    if (obs) host.notifyEnemySeenAction(state, target.faction, attacker.id, attacker.x, attacker.y, 'attack');
    const loss = applyDamage(target, result.damage);
    if (!obs) host.notifyFogAttack(state, target.faction, target, loss, result.canCounter);
    state.turnsSinceDamage = 0;
    state.damageThisTurn = true;
    if (result.canCounter) applyDamage(attacker, result.counterDamage);
    recompute();
  };
  const performMove = (unit, pathCoords) => {
    const startX = unit.x;
    const startY = unit.y;
    const actor = unit.faction;
    const observer = Engine.opponentOf(actor);
    const initialVision = state.visionByFaction[actor];
    let ambushEnemy = null;
    let zocInterrupted = false;
    for (let i = 1; i < pathCoords.length; i++) {
      const next = pathCoords[i];
      const occ = Engine.getUnitAt(next.x, next.y, state);
      if (occ && occ.faction !== actor) {
        ambushEnemy = occ;
        recompute();
        break;
      }
      if (state.visionByFaction[observer].detectedEnemyIds.has(unit.id)) {
        host.notifyEnemySeenAction(state, observer, unit.id, unit.x, unit.y, 'move');
      }
      unit.x = next.x;
      unit.y = next.y;
      recompute();
      if (state.visionByFaction[observer].detectedEnemyIds.has(unit.id)) {
        host.notifyEnemySeenAction(state, observer, unit.id, unit.x, unit.y, 'move');
      }
      if (Engine.isInEnemyShieldZoc(unit.x, unit.y, actor, null, state)) {
        zocInterrupted = !Engine.isInEnemyShieldZoc(unit.x, unit.y, actor, initialVision, state);
        break;
      }
    }
    return {
      startX, startY, endX: unit.x, endY: unit.y,
      displacement: Engine.manhattan(startX, startY, unit.x, unit.y),
      ambushEnemy, zocInterrupted
    };
  };
  const executeTurn = (faction, action, rng) => {
    if (action.type === 'skip') {
      host.notifySelfAction(state, faction, { actionType: 'skip' });
    } else {
      const unit = Engine.getUnitById(action.unitId, state);
      if (action.type === 'stand_attack') {
        host.notifySelfAction(state, faction, { actionType: 'stand_attack', unitId: unit.id });
        const target = Engine.getUnitById(action.targetId, state);
        if (target && Engine.canUnitAttackTargetWithVision(unit, target, state.visionByFaction[faction], state)) {
          resolveCombat(unit, target, 0);
        }
      } else {
        const initVis = new Set(state.visionByFaction[faction].detectedEnemyIds);
        const mv = performMove(unit, action.path);
        host.notifySelfAction(state, faction, {
          actionType: action.type,
          unitId: unit.id,
          from: { x: mv.startX, y: mv.startY },
          to: { x: mv.endX, y: mv.endY },
          displacement: mv.displacement,
          ambushed: Boolean(mv.ambushEnemy),
          zocInterrupted: mv.zocInterrupted
        });
        if (!mv.ambushEnemy) {
          const vis = state.visionByFaction[faction];
          let target = Engine.getUnitById(action.targetId, state);
          if (!target || !Engine.canUnitAttackTargetWithVision(unit, target, vis, state)) {
            const postId = host.decidePostMoveAttack(state, faction, {
              unitId: unit.id,
              displacement: mv.displacement,
              initiallyVisibleEnemyIds: initVis,
              reconsider: mv.zocInterrupted || Boolean(action.targetId),
              rng
            });
            target = Engine.getUnitById(postId, state);
          }
          if (target && Engine.canUnitAttackTargetWithVision(unit, target, vis, state)) {
            resolveCombat(unit, target, mv.displacement);
          }
        }
      }
    }
    const v1 = Engine.evaluateVictory(state);
    if (v1.over) { state.phase = 'GAME_OVER'; state.winner = v1.winner; return; }
    if (state.turn >= Engine.MAX_TURNS) {
      const v2 = Engine.evaluateTurnLimitVictory(state);
      state.phase = 'GAME_OVER';
      state.winner = v2.winner;
      return;
    }
    const nextFaction = Engine.opponentOf(faction);
    state.turn += 1;
    state.turnsSinceDamage = state.damageThisTurn ? 0 : state.turnsSinceDamage + 1;
    state.damageThisTurn = false;
    host.notifyTurnAdvance(state, nextFaction);
    state.activeFaction = nextFaction;
    recompute();
  };
  return { recompute, executeTurn };
}

function testWorkerSandbox(workerSourceFn) {
  const source = workerSourceFn();
  const posted = [];
  const sandbox = {
    self: {
      onmessage: null,
      postMessage(msg) { posted.push(msg); }
    },
    performance: { now: () => 0 },
    Date,
    Math,
    Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, Map, Set, Array, Object, Number, String, Boolean, Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  if (typeof sandbox.self.onmessage !== 'function') {
    throw new Error('Worker 程式碼未綁定 self.onmessage');
  }
}

async function verifyFile(filePath) {
  const rel = path.relative(ROOT, filePath);
  const code = fs.readFileSync(filePath, 'utf8');
  const registry = AiHost.createRegistry();
  const evalRes = AiHost.evaluateAiSource(registry, path.basename(filePath), code, { source: 'discovered' });
  if (!evalRes.ok) {
    throw new Error(`載入／契約驗證失敗：${evalRes.error}`);
  }
  const spec = evalRes.results[0].entry;
  const rawModule = require(filePath);

  // 1. 檢查引擎純淨度（無 aiValue）
  for (const def of Object.values(Engine.UNIT_DEFS)) {
    if ('aiValue' in def) throw new Error('core/engine.js UNIT_DEFS 不得包含 aiValue');
  }

  // 2. Worker 沙盒隔離檢查（若有提供 Worker 原始碼）
  let workerChecked = false;
  if (rawModule && typeof rawModule._workerSourceForTest === 'function') {
    testWorkerSandbox(rawModule._workerSourceForTest);
    workerChecked = true;
  }

  // 3. 藍紅雙陣營 6 回合嚴格合法性自對戰（strict: true）
  const rngMatch = createSeededRng(20261122);
  const state = createFreshGameState();
  const host = AiHost.createMatchHost(registry, { engine: Engine, strict: true, allowWorkers: false });
  host.initMatch(state, { blueAlgoId: spec.id, redAlgoId: spec.id, rngFor: () => rngMatch });
  const { recompute, executeTurn } = makeStepHelpers(state, host);
  recompute();

  const timings = [];
  for (let ply = 0; ply < 6; ply++) {
    if (state.phase === 'GAME_OVER') break;
    const faction = state.activeFaction;
    const t0 = performance.now();
    const res = await host.decideTurn(state, faction, {
      rng: rngMatch,
      allowWorkers: false,
      testOverrides: { budget: 180, deadline: 240, softBudget: 180, hardBudget: 240, hardMax: 300, minTime: 0 }
    });
    const dt = performance.now() - t0;
    timings.push(dt);
    if (res.aborted || !res.action) throw new Error(`第 ${ply + 1} 動未回傳有效動作`);
    executeTurn(faction, res.action, rngMatch);
  }
  host.dispose();

  // 4. 迷霧零作弊審計（分別移動藍方與紅方迷霧內隱藏棋子，驗證決策 100% bit-for-bit 一致）
  for (const actorFaction of ['blue', 'red']) {
    const enemyFaction = Engine.opponentOf(actorFaction);
    const runProbe = async (mutateHidden) => {
      const probeRng = createSeededRng(998877);
      const st = createFreshGameState();
      st.activeFaction = actorFaction;
      st.turn = actorFaction === 'blue' ? 1 : 2;
      if (mutateHidden) {
        const enemyFlag = Engine.getAliveFlag(enemyFaction, st);
        const enemyCav = st.units.find(u => u.faction === enemyFaction && u.type === 'cavalry');
        const targetFlagX = enemyFaction === 'blue' ? 0 : 9;
        const targetFlagY = enemyFaction === 'blue' ? 9 : 0;
        const targetCavX = enemyFaction === 'blue' ? 0 : 9;
        const targetCavY = enemyFaction === 'blue' ? 8 : 1;
        enemyFlag.x = targetFlagX;
        enemyFlag.y = targetFlagY;
        enemyCav.x = targetCavX;
        enemyCav.y = targetCavY;
      }
      st.visionByFaction.blue = Engine.computeVisionData('blue', st);
      st.visionByFaction.red = Engine.computeVisionData('red', st);
      // 確認移動後的目標確實仍處於 actorFaction 迷霧之外（否則不構成迷霧測試）
      const vis = st.visionByFaction[actorFaction];
      if (vis.detectedEnemyIds.size !== 0) {
        throw new Error('零作弊審計前置條件失敗：開局視野不應看到隱藏敵軍');
      }
      const probeHost = AiHost.createMatchHost(registry, { engine: Engine, strict: true, allowWorkers: false });
      probeHost.initMatch(st, {
        blueAlgoId: actorFaction === 'blue' ? spec.id : null,
        redAlgoId: actorFaction === 'red' ? spec.id : null,
        rngFor: () => probeRng
      });
      probeHost.notifyVisionSync(st, actorFaction);
      let fakeTime = 1000;
      const res = await probeHost.decideTurn(st, actorFaction, {
        rng: probeRng,
        now: () => fakeTime,
        allowWorkers: false,
        testOverrides: { syncExact: true, searchSeed: 424242, fixedMaxDepth: 2, s1Depth: 1, s2Depth: 2, budget: 1e9, minTime: 0 }
      });
      probeHost.dispose();
      return JSON.stringify(res.action);
    };
    const actA = await runProbe(false);
    const actB = await runProbe(true);
    if (actA !== actB) {
      throw new Error(`迷霧零作弊審計失敗（${actorFaction}）：移動隱藏敵軍後決策改變！A=${actA} vs B=${actB}`);
    }
  }

  // 5. Abort / Dispose 健壯性檢查
  const abortState = createFreshGameState();
  const abortHost = AiHost.createMatchHost(registry, { engine: Engine, strict: false, allowWorkers: false });
  abortHost.initMatch(abortState, { blueAlgoId: spec.id, redAlgoId: null });
  abortHost.notifyVisionSync(abortState, 'blue');
  const pending = abortHost.decideTurn(abortState, 'blue', { allowWorkers: false });
  abortHost.cancelActive();
  await pending;
  abortHost.dispose();

  const avgMs = timings.reduce((a, b) => a + b, 0) / Math.max(1, timings.length);
  const maxMs = Math.max(0, ...timings);
  return {
    rel,
    id: spec.id,
    name: spec.name,
    coordinateSpace: spec.coordinateSpace,
    workerChecked,
    avgMs: Math.round(avgMs),
    maxMs: Math.round(maxMs)
  };
}

async function main() {
  const args = process.argv.slice(2);
  let targets = [];
  if (args.length > 0) {
    targets = args.map(p => path.resolve(process.cwd(), p));
  } else {
    const aiDir = path.join(ROOT, 'ai');
    if (fs.existsSync(aiDir)) {
      targets = fs.readdirSync(aiDir)
        .filter(f => f.endsWith('.js'))
        .sort((a, b) => a.localeCompare(b))
        .map(f => path.join(aiDir, f));
    }
  }

  if (targets.length === 0) {
    console.log('未發現可驗證的演算法檔案（ai/ 目前為空，屬正常無演算法狀態）。');
    return;
  }

  let failed = 0;
  for (const filePath of targets) {
    try {
      const report = await verifyFile(filePath);
      console.log(
        `[PASS] ${report.rel} | id=${report.id} (${report.name}) | space=${report.coordinateSpace} | ` +
        `workerSandbox=${report.workerChecked ? 'OK' : 'N/A'} | fogZeroCheat=OK | avg=${report.avgMs}ms max=${report.maxMs}ms`
      );
    } catch (err) {
      failed++;
      console.error(`[FAIL] ${path.relative(ROOT, filePath)}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  if (failed > 0) {
    console.error(`\n驗證失敗：${failed} / ${targets.length} 個演算法未通過。`);
    process.exit(1);
  }
  console.log(`\n全部 ${targets.length} 個演算法通過合規、合法性與迷霧零作弊審計！`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
