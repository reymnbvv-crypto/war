#!/usr/bin/env node
/**
 * 迷霧陣線（Tactical Fog Chess）無頭自動對戰與循環賽裁判
 * 零外部相依，直接共用 core/engine.js 與 core/ai-host.js。
 *
 * 常用指令：
 *   node tools/arena.mjs --blue ai/marshal.js --red ai/wargod.js --games 4 --swap
 *   node tools/arena.mjs --round-robin --games 2
 *   node tools/arena.mjs --blue ai/recruit.js --red ai/warrior.js --games 6 --swap --seed 100
 *   node tools/arena.mjs --blue ai/general.js --red ai/marshal.js --games 2 --swap --budget 250
 */

import fs from 'node:fs';
import path from 'node:path';
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

function parseArgs(argv) {
  const opts = {
    blue: null,
    red: null,
    roundRobin: false,
    games: 2,
    swap: false,
    seed: null,
    budget: null,
    quiet: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--blue') opts.blue = argv[++i];
    else if (arg === '--red') opts.red = argv[++i];
    else if (arg === '--round-robin') opts.roundRobin = true;
    else if (arg === '--games') opts.games = Math.max(1, Number(argv[++i]) || 2);
    else if (arg === '--swap') opts.swap = true;
    else if (arg === '--seed') opts.seed = Number(argv[++i]);
    else if (arg === '--budget') opts.budget = Math.max(50, Number(argv[++i]) || 0);
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`用法：
  node tools/arena.mjs --blue <檔名或id> --red <檔名或id> [--games N] [--swap] [--seed S] [--budget MS]
  node tools/arena.mjs --round-robin [--games N] [--seed S] [--budget MS]`);
      process.exit(0);
    }
  }
  return opts;
}

function loadAiIntoRegistry(registry, specOrPath) {
  const resolved = fs.existsSync(specOrPath)
    ? path.resolve(specOrPath)
    : (fs.existsSync(path.join(ROOT, 'ai', `${specOrPath}.js`))
      ? path.join(ROOT, 'ai', `${specOrPath}.js`)
      : null);
  if (!resolved) {
    if (registry.has(specOrPath)) return registry.get(specOrPath);
    throw new Error(`找不到演算法檔案或 ID：${specOrPath}`);
  }
  const code = fs.readFileSync(resolved, 'utf8');
  const res = AiHost.evaluateAiSource(registry, path.basename(resolved), code, { source: 'discovered' });
  if (!res.ok) throw new Error(`載入 ${specOrPath} 失敗：${res.error}`);
  return res.results[0].entry;
}

function loadAllAiFromDir(registry) {
  const aiDir = path.join(ROOT, 'ai');
  if (!fs.existsSync(aiDir)) return [];
  const files = fs.readdirSync(aiDir).filter(f => f.endsWith('.js')).sort((a, b) => a.localeCompare(b));
  const entries = [];
  for (const f of files) {
    const code = fs.readFileSync(path.join(aiDir, f), 'utf8');
    const res = AiHost.evaluateAiSource(registry, f, code, { source: 'discovered' });
    if (!res.ok) throw new Error(`載入 ai/${f} 失敗：${res.error}`);
    entries.push(res.results[0].entry);
  }
  return entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

async function playSingleGame(registry, blueId, redId, { seed = null, budgetOverride = null } = {}) {
  const rng = seed !== null ? createSeededRng(seed) : Math.random;
  const state = {
    map: Engine.createTerrainGrid(),
    units: Engine.createInitialUnits(),
    turn: 1,
    turnsSinceDamage: 0,
    damageThisTurn: false,
    activeFaction: 'blue',
    phase: 'SELECT_OR_ACT',
    winner: null,
    victoryReason: '',
    visionByFaction: { blue: null, red: null }
  };

  const host = AiHost.createMatchHost(registry, { engine: Engine, strict: true, allowWorkers: false });
  host.initMatch(state, { blueAlgoId: blueId, redAlgoId: redId, rngFor: () => rng });

  const recompute = () => {
    state.visionByFaction.blue = Engine.computeVisionData('blue', state);
    state.visionByFaction.red = Engine.computeVisionData('red', state);
    host.notifyVisionSync(state, 'blue');
    host.notifyVisionSync(state, 'red');
  };
  recompute();

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

  const stats = {
    skips: { blue: 0, red: 0 },
    timeMs: { blue: 0, red: 0 },
    moves: { blue: 0, red: 0 }
  };

  const testOverrides = budgetOverride
    ? { budget: budgetOverride, deadline: budgetOverride + 80, softBudget: budgetOverride, hardBudget: budgetOverride + 100, hardMax: budgetOverride + 180, minTime: 0 }
    : { minTime: 0 };

  while (state.phase !== 'GAME_OVER') {
    const faction = state.activeFaction;
    const t0 = performance.now();
    const res = await host.decideTurn(state, faction, {
      rng,
      allowWorkers: false,
      testOverrides
    });
    stats.timeMs[faction] += performance.now() - t0;
    stats.moves[faction] += 1;
    const action = res.action;

    if (action.type === 'skip') {
      stats.skips[faction] += 1;
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
    if (v1.over) {
      state.phase = 'GAME_OVER';
      state.winner = v1.winner;
      state.victoryReason = v1.reason;
      break;
    }
    if (state.turn >= Engine.MAX_TURNS) {
      const v2 = Engine.evaluateTurnLimitVictory(state);
      state.phase = 'GAME_OVER';
      state.winner = v2.winner;
      state.victoryReason = v2.reason;
      break;
    }

    const nextFaction = Engine.opponentOf(faction);
    state.turn += 1;
    state.turnsSinceDamage = state.damageThisTurn ? 0 : state.turnsSinceDamage + 1;
    state.damageThisTurn = false;
    host.notifyTurnAdvance(state, nextFaction);
    state.activeFaction = nextFaction;
    recompute();
  }

  host.dispose();

  const blueHp = state.units.filter(u => u.alive && u.faction === 'blue').reduce((s, u) => s + u.hp, 0);
  const redHp = state.units.filter(u => u.alive && u.faction === 'red').reduce((s, u) => s + u.hp, 0);
  const blueHills = Engine.countOccupiedHills('blue', state);
  const redHills = Engine.countOccupiedHills('red', state);
  const isBehead = !Engine.getAliveFlag('blue', state) || !Engine.getAliveFlag('red', state);

  return {
    blueId,
    redId,
    winner: state.winner,
    turns: state.turn,
    isBehead,
    blueHp,
    redHp,
    blueHills,
    redHills,
    skips: stats.skips,
    avgMs: {
      blue: Math.round(stats.timeMs.blue / Math.max(1, stats.moves.blue)),
      red: Math.round(stats.timeMs.red / Math.max(1, stats.moves.red))
    },
    reason: state.victoryReason
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const registry = AiHost.createRegistry();

  if (opts.roundRobin) {
    const entries = loadAllAiFromDir(registry);
    if (entries.length < 2) {
      console.log(`循環賽至少需要 2 個演算法，目前 ai/ 內僅找到 ${entries.length} 個。`);
      return;
    }
    const table = new Map(entries.map(e => [e.id, { id: e.id, name: e.name, pts: 0, w: 0, d: 0, l: 0, hpDiff: 0, games: 0 }]));
    let gameNo = 0;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        for (let g = 0; g < opts.games; g++) {
          gameNo++;
          const swap = g % 2 === 1;
          const b = swap ? entries[j] : entries[i];
          const r = swap ? entries[i] : entries[j];
          const seed = opts.seed !== null ? opts.seed + gameNo * 1009 : null;
          const res = await playSingleGame(registry, b.id, r.id, { seed, budgetOverride: opts.budget });
          const tb = table.get(b.id);
          const tr = table.get(r.id);
          tb.games++; tr.games++;
          tb.hpDiff += res.blueHp - res.redHp;
          tr.hpDiff += res.redHp - res.blueHp;
          if (res.winner === 'blue') { tb.w++; tb.pts += 1; tr.l++; }
          else if (res.winner === 'red') { tr.w++; tr.pts += 1; tb.l++; }
          else { tb.d++; tr.d++; tb.pts += 0.5; tr.pts += 0.5; }
          if (!opts.quiet) {
            console.log(`#${gameNo} 藍[${b.id}] vs 紅[${r.id}] -> ${res.winner} | T${res.turns} | HP ${res.blueHp}:${res.redHp} | ${res.isBehead ? '斬首' : '滿回合'}`);
          }
        }
      }
    }
    const ranked = [...table.values()].sort((a, b) => b.pts - a.pts || b.hpDiff - a.hpDiff);
    console.log('\n=== 循環賽排行榜 ===');
    for (const [idx, row] of ranked.entries()) {
      const avgHp = (row.hpDiff / Math.max(1, row.games)).toFixed(1);
      console.log(`${idx + 1}. ${row.name} (${row.id}) | 積分 ${row.pts} | ${row.w}W-${row.d}D-${row.l}L | 平均HP差 ${avgHp}`);
    }
    return;
  }

  if (!opts.blue || !opts.red) {
    console.error('請指定 --blue 與 --red（或使用 --round-robin）。加 --help 查看用法。');
    process.exit(1);
  }
  const specA = loadAiIntoRegistry(registry, opts.blue);
  const specB = loadAiIntoRegistry(registry, opts.red);

  const summary = { [specA.id]: 0, [specB.id]: 0, draw: 0, blueWins: 0, redWins: 0 };
  for (let g = 0; g < opts.games; g++) {
    const swapped = opts.swap && g % 2 === 1;
    const bSpec = swapped ? specB : specA;
    const rSpec = swapped ? specA : specB;
    const seed = opts.seed !== null ? opts.seed + g * 1009 : null;
    const res = await playSingleGame(registry, bSpec.id, rSpec.id, { seed, budgetOverride: opts.budget });
    if (res.winner === 'blue') {
      summary[bSpec.id]++;
      summary.blueWins++;
    } else if (res.winner === 'red') {
      summary[rSpec.id]++;
      summary.redWins++;
    } else {
      summary.draw++;
    }
    if (!opts.quiet) {
      console.log(
        `Game ${g + 1}/${opts.games} | 藍[${bSpec.id}] vs 紅[${rSpec.id}] -> ${res.winner} | ` +
        `T${res.turns} | HP ${res.blueHp}:${res.redHp} | 高地 ${res.blueHills}:${res.redHills} | ` +
        `skip ${res.skips.blue}:${res.skips.red} | avgMs ${res.avgMs.blue}:${res.avgMs.red}`
      );
    }
  }
  console.log('\n=== 對戰總結 ===');
  if (specA.id === specB.id) {
    console.log(`鏡像對戰 [${specA.id}]：藍勝 ${summary.blueWins} / 紅勝 ${summary.redWins} / 和 ${summary.draw}`);
  } else {
    console.log(`${specA.name}(${specA.id}): ${summary[specA.id]} 勝 | ${specB.name}(${specB.id}): ${summary[specB.id]} 勝 | 和: ${summary.draw}（藍 ${summary.blueWins} : 紅 ${summary.redWins}）`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
