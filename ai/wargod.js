/* =========================================================
 * 迷霧陣線 AI 演算法：軍神 · 極限推演（wargod）
 * 完全自包含單檔，遵循 TFC AI Protocol v1。
 * 保留原版 192 粒子濾波＋迷霧遭襲反推＋2～4 Worker Pool＋PVS/LMR/Futility/CVaR/VOI
 * ＋動態 1～20s 長考＋克制型殘局跳過機制。
 * ========================================================= */
(function (root, factory) {
  const algo = factory();
  if (typeof module === 'object' && module.exports) module.exports = algo;
  if (root && root.TFC_AI && typeof root.TFC_AI.register === 'function') {
    root.TFC_AI.register(algo);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function* searchWargodShard(packet, emit, options = {}) {
    const {
      size, maxTurns, blueSlots, slotTypes, definitions, geometry, worlds,
      roots, maxDepth, startDepth, endDepth, reportFromDepth, singleWorld
    } = packet;
    const { terrain, neighbors, costs, distance, scans } = geometry;
    const count = size * size;
    const words = Math.ceil(count / 32);
    const units = slotTypes.length;
    const flagType = 0, shieldType = 1, spearType = 2, archerType = 3, cavalryType = 4;
    const hill = 1, forest = 2;
    const flag = [slotTypes.indexOf(flagType), slotTypes.lastIndexOf(flagType)];
    const now = options.clock || (() => typeof performance === 'object' ? performance.now() : Date.now());
    const sliceMs = options.sliceMs || Infinity;
    const startTime = now();
    const deadline = startTime + (options.budget || 20000);
    let sliceDeadline = startTime + sliceMs;
    const timeout = {};
    const SCALE = 4; // 0.25 分精度整數刻度，讓 PVS 零窗 [alpha, alpha+1] 精確無浮點誤差
    const WIN = 400000;
    const INF = 2000000;
    const MAX_PLY = 24;
    const MAX_GEN = 220;
    let nodes = 0;

    let rng = (packet.seed >>> 0) || 0x9e3779b9;
    function nextRng() {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      return rng >>> 0;
    }
    const team = slot => Number(slot >= blueSlots);
    const hasBit = (bits, cell) => (bits[cell >>> 5] & (1 << (cell & 31))) !== 0;
    const rangeBetween = (a, b) => distance[a * count + b];
    const scanStart = (slot, cell) => (slotTypes[slot] * count + cell) * words;

    const hpScale = Math.max(...definitions.map(item => item.maxHp)) + 1;
    const locationKeys = new Uint32Array(units * count * hpScale);
    const turnKeys = new Uint32Array(maxTurns + 28);
    for (let i = 0; i < locationKeys.length; i++) locationKeys[i] = nextRng();
    for (let i = 0; i < turnKeys.length; i++) turnKeys[i] = nextRng();
    const pieceKey = (id, cell, hp) => locationKeys[(id * count + cell) * hpScale + hp];

    const TT_MASK = (1 << 18) - 1;
    const ttKeys = new Uint32Array(TT_MASK + 1);
    const ttDepth = new Int8Array(TT_MASK + 1).fill(-1);
    const ttValue = new Int32Array(TT_MASK + 1);
    const ttBound = new Uint8Array(TT_MASK + 1);
    const ttMove = new Int32Array(TT_MASK + 1).fill(-1);

    const EVAL_MASK = (1 << 17) - 1;
    const evalKeys = new Uint32Array(EVAL_MASK + 1);
    const evalVals = new Int32Array(EVAL_MASK + 1);
    const evalValid = new Uint8Array(EVAL_MASK + 1);

    const killer1 = new Int32Array(MAX_PLY).fill(-1);
    const killer2 = new Int32Array(MAX_PLY).fill(-1);
    const history = new Int32Array(units * count);
    const frames = Array.from({ length: MAX_PLY + 2 }, () => ({}));
    const plyMoves = Array.from({ length: MAX_PLY + 2 }, () => new Int32Array(MAX_GEN));
    const plyScores = Array.from({ length: MAX_PLY + 2 }, () => new Int32Array(MAX_GEN));
    const seenBuf = Array.from({ length: MAX_PLY + 2 }, () => new Uint32Array(words));
    const zocSeenBuf = Array.from({ length: MAX_PLY + 2 }, () => new Uint32Array(words));
    const nearEnemies = new Int8Array(blueSlots);
    const priorSeen = new Uint32Array(words);
    const evalSeen0 = new Uint32Array(words);
    const evalSeen1 = new Uint32Array(words);
    const evalZoc0 = new Uint32Array(words);
    const evalZoc1 = new Uint32Array(words);

    // 尋路與騎兵全向衝鋒 BFS 共用固定緩衝區（零配置）
    const frontierSize = (1 + Math.max(...definitions.map(type => type.mp))) ** 2;
    const frontierHead = new Int16Array(frontierSize);
    const frontierTail = new Int16Array(frontierSize);
    const queuedCells = new Int16Array(count * 5);
    const queuedNext = new Int16Array(queuedCells.length);
    const bestRoute = new Int16Array(count);
    const routeStamp = new Int32Array(count);
    let curRouteStamp = 0;
    const routeParent = new Int16Array(count);
    const destinations = new Int16Array(count);
    const landedBuf = new Uint8Array(count);
    const landedStamp = new Int32Array(count);
    let curLandedStamp = 0;
    const routeBuf = new Int16Array(12);
    const cavDist = new Uint8Array(count);
    const cavStamp = new Int32Array(count);
    let curCavStamp = 0;
    const cavQueue = new Int16Array(count);

    const packMove = (u, t, d, l) =>
      ((u < 0 ? 16 : u) & 31) |
      (((t < 0 ? 16 : t) & 31) << 5) |
      (((d < 0 ? 100 : d) & 127) << 10) |
      (((l + 102) & 255) << 17);
    const moveUnit = m => { const v = m & 31; return v === 16 ? -1 : v; };
    const moveTarget = m => { const v = (m >>> 5) & 31; return v === 16 ? -1 : v; };
    const moveDest = m => { const v = (m >>> 10) & 127; return v === 100 ? -1 : v; };
    const moveLanding = m => ((m >>> 17) & 255) - 102;
    const SKIP_PACKED = packMove(-1, -1, -1, -1);

    function* checkpoint() {
      const t = now();
      if (t >= deadline) throw timeout;
      if (t >= sliceDeadline) {
        yield;
        sliceDeadline = now() + sliceMs;
        if (now() >= deadline) throw timeout;
      }
    }

    function buildBoard(w) {
      const position = Int16Array.from(w.position);
      const hp = Int16Array.from(w.hp);
      const cells = new Int16Array(count).fill(-1);
      let hash = 0;
      for (let slot = 0; slot < units; slot++) {
        if (position[slot] < 0 || hp[slot] <= 0) {
          position[slot] = -1;
          hp[slot] = 0;
          continue;
        }
        cells[position[slot]] = slot;
        hash ^= pieceKey(slot, position[slot], hp[slot]);
      }
      return { position, hp, cells, hash, turn: packet.turn, weight: w.weight, worldIdx: w.worldIdx };
    }

    const boards = worlds.map(buildBoard);

    function scanSide(board, side, out) {
      out.fill(0);
      const first = side * blueSlots;
      for (let id = first; id < first + blueSlots; id++) {
        const cell = board.position[id];
        if (cell < 0) continue;
        const start = scanStart(id, cell);
        for (let word = 0; word < words; word++) out[word] |= scans[start + word];
      }
    }

    function sideDetects(board, side, cell) {
      const first = side * blueSlots;
      const word = cell >>> 5;
      const bit = 1 << (cell & 31);
      for (let id = first; id < first + blueSlots; id++) {
        const origin = board.position[id];
        if (origin >= 0 && (scans[scanStart(id, origin) + word] & bit)) return true;
      }
      return false;
    }

    function enemyZoc(board, cell, side, seen = null) {
      for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
        const next = neighbors[edge];
        if (next < 0) continue;
        const id = board.cells[next];
        if (id >= 0 && team(id) !== side && slotTypes[id] === shieldType && (!seen || hasBit(seen, next))) return true;
      }
      return false;
    }

    function strikeInRange(board, actor, target) {
      const from = board.position[actor];
      const to = board.position[target];
      const dist = rangeBetween(from, to);
      const type = slotTypes[actor];
      if (type === archerType) return dist >= 2 && dist <= (terrain[from] === hill ? 4 : 3);
      if (dist === 1) return true;
      if (type !== spearType || dist !== 2 || (from % size !== to % size && Math.floor(from / size) !== Math.floor(to / size))) return false;
      const middle = (from + to) >> 1;
      if (terrain[from] !== hill && (terrain[to] === hill || terrain[middle] === hill)) return false;
      const occupant = board.cells[middle];
      return occupant < 0 || team(occupant) === team(actor);
    }

    function aura(board, id) {
      const sideFlag = flag[team(id)];
      if (sideFlag === id || board.position[sideFlag] < 0) return 0;
      return Number(rangeBetween(board.position[id], board.position[sideFlag]) <= 2);
    }

    function neighborCounts(board, cell, side, exclude = -1) {
      let allies = 0, rivals = 0;
      for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
        const adj = neighbors[edge];
        if (adj < 0) continue;
        const id = board.cells[adj];
        if (id < 0 || id === exclude) continue;
        if (team(id) === side) allies++;
        else rivals++;
      }
      return allies | (rivals << 4);
    }

    function defense(board, id, adjacent, dist, broken) {
      const cell = board.position[id];
      const type = slotTypes[id];
      return definitions[type].baseDef + aura(board, id) + Math.min(2, adjacent & 15)
        - ((adjacent >>> 4) >= 2 ? 2 : 0) - (broken ? 3 : 0)
        + (terrain[cell] === forest ? (dist >= 2 ? 2 : 1) : 0)
        + (type === shieldType && dist >= 2 ? 2 : 0);
    }

    function battle(board, actor, target, displacement) {
      const from = board.position[actor];
      const to = board.position[target];
      const dist = rangeBetween(from, to);
      const actorType = slotTypes[actor];
      const targetType = slotTypes[target];
      const elevation = Number(terrain[from] === hill) - Number(terrain[to] === hill);
      const charge = actorType === cavalryType && displacement >= 3 && terrain[from] !== forest;
      const broken = charge && targetType === shieldType;
      const targetAdjacency = neighborCounts(board, to, team(target));
      const attack = definitions[actorType].baseAtk + aura(board, actor) + elevation
        + (actorType === spearType && dist === 2 ? -1 : 0)
        + (actorType === spearType && targetType === cavalryType ? 2 : 0) + (charge ? 2 : 0);
      const damage = Math.max(1, attack - defense(board, target, targetAdjacency, dist, broken));
      if (damage >= board.hp[target] || dist !== 1 || (targetAdjacency >>> 4) >= 2 || broken || targetType === archerType) return damage;
      const counterAttack = definitions[targetType].baseAtk + aura(board, target) - elevation
        + (targetType === spearType && actorType === cavalryType ? 2 : 0);
      const counter = Math.max(0, counterAttack - 1 - defense(board, actor, neighborCounts(board, from, team(actor)), 1, false));
      return damage | (counter << 8);
    }

    function relocate(board, id, dest) {
      const prev = board.position[id];
      if (prev === dest) return;
      if (prev >= 0) {
        board.hash ^= pieceKey(id, prev, board.hp[id]);
        board.cells[prev] = -1;
      }
      board.cells[dest] = id;
      board.position[id] = dest;
      board.hash ^= pieceKey(id, dest, board.hp[id]);
    }

    function loseHp(board, id, lost) {
      if (lost === 0) return;
      const cell = board.position[id];
      board.hash ^= pieceKey(id, cell, board.hp[id]);
      board.hp[id] = Math.max(0, board.hp[id] - lost);
      if (board.hp[id] > 0) board.hash ^= pieceKey(id, cell, board.hp[id]);
      else {
        board.position[id] = -1;
        board.cells[cell] = -1;
      }
    }

    function landingPath(board, id, path, len) {
      const side = team(id);
      let stop = board.position[id];
      for (let i = 1; i < len; i++) {
        const next = path[i];
        const occ = board.cells[next];
        if (occ >= 0 && team(occ) !== side) return -stop - 2;
        if (occ < 0) stop = next;
        if (enemyZoc(board, next, side)) break;
      }
      return stop;
    }

    function opportunisticTarget(board, id, displacement, seenBefore, reconsider) {
      const side = team(id);
      const first = (side ^ 1) * blueSlots;
      let best = -1;
      let score = 0;
      for (let target = first; target < first + blueSlots; target++) {
        const cell = board.position[target];
        if (cell < 0 || (!reconsider && hasBit(seenBefore, cell)) || !strikeInRange(board, id, target)
            || !sideDetects(board, side, cell)) continue;
        const hit = battle(board, id, target, displacement);
        const damage = hit & 255;
        const counter = hit >>> 8;
        const dying = counter >= board.hp[id];
        const kills = damage >= board.hp[target];
        if (slotTypes[id] === flagType && dying) continue;
        const value = (kills ? (slotTypes[target] === flagType ? WIN : 58) : 0)
          + Math.min(damage, board.hp[target]) * 9 - counter * 10 - (dying ? 55 : 0);
        if (value > score) {
          best = target;
          score = value;
        }
      }
      return best;
    }

    function makeRoot(board, move, frame) {
      frame.hash = board.hash;
      frame.actor = move.unit;
      frame.target = -1;
      board.turn++;
      if (move.unit < 0) return;
      const id = move.unit;
      const side = team(id);
      const start = board.position[id];
      frame.start = start;
      frame.actorHp = board.hp[id];
      const stopped = move.path.length ? landingPath(board, id, move.path, move.path.length) : start;
      const ambushed = stopped < 0;
      const end = ambushed ? -stopped - 2 : stopped;
      let target = move.target;
      if (!ambushed && move.path.length) scanSide(board, side, priorSeen);
      relocate(board, id, end);
      if (ambushed) return;
      const displacement = rangeBetween(start, end);
      if (target < 0 || !strikeInRange(board, id, target) || !sideDetects(board, side, board.position[target])) {
        const reconsider = target >= 0 || (move.path.length > 0 && end !== move.path[move.path.length - 1]);
        target = move.path.length ? opportunisticTarget(board, id, displacement, priorSeen, reconsider) : -1;
      }
      if (target < 0) return;
      frame.target = target;
      frame.targetCell = board.position[target];
      frame.targetHp = board.hp[target];
      const hit = battle(board, id, target, displacement);
      loseHp(board, target, hit & 255);
      loseHp(board, id, hit >>> 8);
    }

    function makePacked(board, packed, frame) {
      frame.hash = board.hash;
      const id = moveUnit(packed);
      frame.actor = id;
      frame.target = -1;
      board.turn++;
      if (id < 0) return;
      const start = board.position[id];
      frame.start = start;
      frame.actorHp = board.hp[id];
      const stopped = moveLanding(packed);
      const ambushed = stopped < 0;
      const end = ambushed ? -stopped - 2 : stopped;
      relocate(board, id, end);
      if (ambushed) return;
      const target = moveTarget(packed);
      if (target < 0) return;
      frame.target = target;
      frame.targetCell = board.position[target];
      frame.targetHp = board.hp[target];
      const hit = battle(board, id, target, rangeBetween(start, end));
      loseHp(board, target, hit & 255);
      loseHp(board, id, hit >>> 8);
    }

    function unmake(board, frame) {
      board.turn--;
      board.hash = frame.hash;
      const id = frame.actor;
      if (id < 0) return;
      const cur = board.position[id];
      if (cur >= 0) board.cells[cur] = -1;
      board.position[id] = frame.start;
      board.cells[frame.start] = id;
      board.hp[id] = frame.actorHp;
      if (frame.target >= 0) {
        board.cells[frame.targetCell] = frame.target;
        board.position[frame.target] = frame.targetCell;
        board.hp[frame.target] = frame.targetHp;
      }
    }

    function terminal(board) {
      if (board.hp[flag[0]] === 0 || board.hp[flag[1]] === 0) {
        return (Number(board.hp[flag[1]] > 0) - Number(board.hp[flag[0]] > 0)) * (WIN - board.turn * 4);
      }
      if (board.turn <= maxTurns) return null;
      let hp = 0, hills = 0;
      for (let id = 0; id < units; id++) {
        const pos = board.position[id];
        if (pos < 0) continue;
        const sign = team(id) ? 1 : -1;
        hp += sign * board.hp[id];
        if (terrain[pos] === hill) hills += sign;
      }
      return Math.sign(hp || hills) * (WIN - board.turn * 4);
    }

    // 修正元帥只掃直線的盲點：精確計算輕騎 4MP 全向（含轉彎）曼距 ≥3 衝鋒威脅
    function cavalryChargeThreat(board, side, origin, enemyZocBits, seenBits) {
      const enemyFirst = (side ^ 1) * blueSlots;
      let anyNear = false;
      for (let eId = enemyFirst; eId < enemyFirst + blueSlots; eId++) {
        const ePos = board.position[eId];
        if (ePos >= 0 && rangeBetween(origin, ePos) <= 5 && hasBit(seenBits, ePos)) {
          anyNear = true;
          break;
        }
      }
      if (!anyNear) return 0;

      const mp = definitions[cavalryType].mp;
      const leaveCost = hasBit(enemyZocBits, origin) ? 1 : 0;
      const stamp = ++curCavStamp;
      cavStamp[origin] = stamp;
      cavDist[origin] = 0;
      let head = 0, tail = 0;
      cavQueue[tail++] = origin;
      let best = 0;
      while (head < tail) {
        const cell = cavQueue[head++];
        const spent = cavDist[cell];
        if (cell !== origin) {
          if (rangeBetween(origin, cell) >= 3 && terrain[cell] !== forest && board.cells[cell] < 0) {
            for (let e = cell * 4; e < cell * 4 + 4; e++) {
              const adj = neighbors[e];
              if (adj < 0) continue;
              const tId = board.cells[adj];
              if (tId < 0 || team(tId) === side || !hasBit(seenBits, adj)) continue;
              const tType = slotTypes[tId];
              const val = tType === flagType ? 26 : (tType === shieldType ? 17 : (tType === archerType ? 15 : 8));
              if (val > best) best = val;
            }
          }
          if (hasBit(enemyZocBits, cell)) continue;
        }
        for (let e = cell * 4; e < cell * 4 + 4; e++) {
          const next = neighbors[e];
          if (next < 0) continue;
          const occ = board.cells[next];
          if (occ >= 0 && team(occ) !== side) continue;
          const price = spent + costs[e] + (cell === origin ? leaveCost : 0);
          if (price <= mp && (cavStamp[next] !== stamp || price < cavDist[next])) {
            cavStamp[next] = stamp;
            cavDist[next] = price;
            cavQueue[tail++] = next;
          }
        }
      }
      return best;
    }

    function evaluateWargod(board) {
      const key = (board.hash ^ turnKeys[board.turn]) >>> 0;
      const slotIdx = key & EVAL_MASK;
      if (evalValid[slotIdx] && evalKeys[slotIdx] === key) return evalVals[slotIdx];

      evalSeen0.fill(0);
      evalSeen1.fill(0);
      evalZoc0.fill(0);
      evalZoc1.fill(0);
      let living = 0;
      let hp0 = 0, hp1 = 0, hills0 = 0, hills1 = 0;

      for (let id = 0; id < units; id++) {
        const cell = board.position[id];
        if (cell < 0) continue;
        living++;
        const side = team(id);
        const start = scanStart(id, cell);
        const out = side ? evalSeen1 : evalSeen0;
        for (let w = 0; w < words; w++) out[w] |= scans[start + w];
        if (side) {
          hp1 += board.hp[id];
          if (terrain[cell] === hill) hills1++;
        } else {
          hp0 += board.hp[id];
          if (terrain[cell] === hill) hills0++;
        }
        if (slotTypes[id] === shieldType) {
          const zOut = side ? evalZoc1 : evalZoc0;
          for (let e = cell * 4; e < cell * 4 + 4; e++) {
            const adj = neighbors[e];
            if (adj >= 0) zOut[adj >>> 5] |= 1 << (adj & 31);
          }
        }
      }

      const phase = Math.max(0, Math.min(1, (living - 4) / 12));
      const clockFrac = Math.max(0, Math.min(1, (board.turn - 70) / 50));
      const endgame = Math.max(1 - phase, clockFrac);
      const hpWeight = 9.0 + endgame * 9.0;
      const pieceWeight = 0.85 - endgame * 0.42;

      let score = 0;
      for (let id = 0; id < units; id++) {
        const cell = board.position[id];
        if (cell < 0) continue;
        const side = team(id);
        const type = slotTypes[id];
        const hp = board.hp[id];
        const sign = side ? 1 : -1;
        const x = cell % size;
        const y = Math.floor(cell / size);
        const home = side ? y : size - 1 - y;
        const adj = neighborCounts(board, cell, side);
        const allies = adj & 15;
        const rivals = adj >>> 4;
        const mySeen = side ? evalSeen1 : evalSeen0;
        const oppSeen = side ? evalSeen0 : evalSeen1;
        const oppZoc = side ? evalZoc0 : evalZoc1;
        const enemyFirst = (side ^ 1) * blueSlots;

        let val = definitions[type].aiValue * pieceWeight + hp * hpWeight
          + Math.min(2, allies) * (type === flagType ? 10 : 4.2)
          + aura(board, id) * 6.0;

        if (rivals >= 2) val -= (type === flagType ? 28 : 11);

        const terr = terrain[cell];
        if (terr === hill) val += type === archerType ? 26 : (type === cavalryType ? 9 : 13);
        else if (terr === forest) {
          val += type === flagType ? (hp <= 5 ? 18 : 13) : (type === cavalryType ? -4 : 6);
          if (!hasBit(oppSeen, cell)) {
            if (type === flagType) val += hp <= 5 ? 16 : 11;
            else if (type !== archerType) val += 4.5;
          }
        }

        if (type === flagType) {
          val += hp * 12;
          if (hp <= 4) val -= (5 - hp) * 14;
          if (hasBit(oppZoc, cell)) val -= 14;
          if (home > 4) val -= (home - 4) * (6 * phase + 2);
          let threats = 0;
          for (let eId = enemyFirst; eId < enemyFirst + blueSlots; eId++) {
            const ePos = board.position[eId];
            if (ePos < 0) continue;
            const eType = slotTypes[eId];
            const reach = definitions[eType].mp + (eType === archerType ? 4 : (eType === spearType ? 2 : 1));
            if (rangeBetween(cell, ePos) <= reach) threats++;
          }
          val -= threats * (hp <= 5 ? 11 : 4.5);
          if (threats > 0) {
            let escapes = 0;
            for (let e = cell * 4; e < cell * 4 + 4; e++) {
              const adjC = neighbors[e];
              if (adjC >= 0 && board.cells[adjC] < 0 && !hasBit(oppZoc, adjC)) escapes++;
            }
            if (escapes === 0) val -= 14;
          }
        } else {
          // 空間與中路推進分隨子數減少平滑淡出，殘局不因盲目前衝拆陣
          val += (Math.min(home, 6) * (type === cavalryType ? 1.6 : 2.8) + (5 - Math.abs(x - 4.5)) * 1.4) * phase;

          const oppFlagSlot = flag[side ^ 1];
          const oppFlagPos = board.position[oppFlagSlot];
          if (oppFlagPos >= 0 && hasBit(mySeen, oppFlagPos)) {
            const dFlag = rangeBetween(cell, oppFlagPos);
            if (dFlag < 8) val += (8 - dFlag) * (board.hp[oppFlagSlot] <= 5 ? 2.4 : 0.75);
          }
          const myFlagSlot = flag[side];
          const myFlagPos = board.position[myFlagSlot];
          if (myFlagPos >= 0 && board.hp[myFlagSlot] <= 6 && rangeBetween(cell, myFlagPos) <= 3) {
            val += 4.5;
          }

          if (type === archerType) {
            if (rivals >= 1) val -= 22;
            let targetsInRange = 0;
            for (let eId = enemyFirst; eId < enemyFirst + blueSlots; eId++) {
              const ePos = board.position[eId];
              if (ePos < 0) continue;
              if (hasBit(mySeen, ePos) && strikeInRange(board, id, eId)) targetsInRange++;
            }
            if (targetsInRange > 0) val += 9 + (targetsInRange - 1) * 4.5;
          } else {
            let exposedTargets = 0;
            for (let eId = enemyFirst; eId < enemyFirst + blueSlots; eId++) {
              const ePos = board.position[eId];
              if (ePos >= 0 && hasBit(mySeen, ePos) && strikeInRange(board, id, eId)) exposedTargets++;
            }
            if (exposedTargets >= 2) val += 7 + (exposedTargets - 2) * 3.5;

            if (type === shieldType) {
              for (let e = cell * 4; e < cell * 4 + 4; e++) {
                const adjC = neighbors[e];
                if (adjC < 0) continue;
                const tId = board.cells[adjC];
                if (tId >= 0 && team(tId) !== side) {
                  const tType = slotTypes[tId];
                  val += (tType === cavalryType || tType === archerType || tType === flagType) ? 10 : 5;
                }
              }
              if (myFlagPos >= 0 && rangeBetween(cell, myFlagPos) <= 2) val += 4.5;
            } else if (type === spearType) {
              for (let eId = enemyFirst; eId < enemyFirst + blueSlots; eId++) {
                const ePos = board.position[eId];
                if (ePos >= 0 && slotTypes[eId] === cavalryType && rangeBetween(cell, ePos) <= 2) val += 8.5;
              }
              for (let e = cell * 4; e < cell * 4 + 4; e++) {
                const adjC = neighbors[e];
                if (adjC >= 0) {
                  const aId = board.cells[adjC];
                  if (aId >= 0 && team(aId) === side && slotTypes[aId] === shieldType) { val += 3.5; break; }
                }
              }
            } else if (type === cavalryType) {
              val += cavalryChargeThreat(board, side, cell, oppZoc, mySeen);
              for (let eId = enemyFirst; eId < enemyFirst + blueSlots; eId++) {
                const ePos = board.position[eId];
                if (ePos >= 0 && slotTypes[eId] === spearType && rangeBetween(cell, ePos) <= 2) val -= 7;
              }
            }
          }
        }

        score += sign * val;
      }

      // 終局 120 回合高地決勝與平滑時鐘梯度（領先保分／落後逼戰）
      const hpDiff = hp1 - hp0;
      const hillDiff = hills1 - hills0;
      if (board.turn >= maxTurns - 26 && Math.abs(hpDiff) <= 4) {
        score += hillDiff * (Math.abs(hpDiff) <= 1 ? 28 : 14);
      }
      if (board.turn >= 50) {
        const leader = hpDiff !== 0 ? Math.sign(hpDiff) : Math.sign(hillDiff);
        const rate = board.turn >= 96 ? 0.55 : 0.22;
        score += leader * (board.turn - 48) * rate;
      }

      const scaled = Math.round(score * SCALE);
      evalValid[slotIdx] = 1;
      evalKeys[slotIdx] = key;
      evalVals[slotIdx] = scaled;
      return scaled;
    }

    function attackOrderScore(board, actor, target, displacement) {
      const hit = battle(board, actor, target, displacement);
      const damage = hit & 255;
      const counter = hit >>> 8;
      if (damage >= board.hp[target]) return slotTypes[target] === flagType ? 32000 : 12000 + damage * 25;
      if (slotTypes[actor] === flagType && counter >= board.hp[actor]) return -25000;
      if (slotTypes[actor] === cavalryType && displacement >= 3 && slotTypes[target] === shieldType
          && terrain[board.position[actor]] !== forest) return 8500 + damage * 20;
      if ((neighborCounts(board, board.position[target], team(target)) >>> 4) >= 2) return 6500 + damage * 20;
      return 1200 + damage * 28 - counter * 22 - (counter >= board.hp[actor] ? 900 : 0);
    }

    function reachableCells(board, id, seen, enemyZocSeen) {
      const start = board.position[id];
      const side = team(id);
      const mp = definitions[slotTypes[id]].mp;
      const stepLimit = mp + 1;
      const prioLimit = stepLimit * stepLimit;
      const leaveZoC = Number(hasBit(enemyZocSeen, start));
      for (let i = 0; i < prioLimit; i++) {
        frontierHead[i] = -1;
        frontierTail[i] = -1;
      }
      const stamp = ++curRouteStamp;
      let queued = 0, found = 0;
      const enqueue = (prio, cell) => {
        const tail = frontierTail[prio];
        queuedCells[queued] = cell;
        queuedNext[queued] = -1;
        if (tail >= 0) queuedNext[tail] = queued;
        else frontierHead[prio] = queued;
        frontierTail[prio] = queued++;
      };
      enqueue(0, start);
      routeStamp[start] = stamp;
      bestRoute[start] = 0;
      routeParent[start] = -1;
      for (let prio = 0; prio < prioLimit; prio++) {
        const spent = Math.floor(prio / stepLimit);
        const steps = prio % stepLimit;
        for (let cur = frontierHead[prio]; cur >= 0; cur = queuedNext[cur]) {
          const cell = queuedCells[cur];
          if (bestRoute[cell] !== prio) continue;
          if (cell !== start) {
            const occ = board.cells[cell];
            if (occ < 0 || team(occ) !== side) destinations[found++] = cell;
            if (hasBit(enemyZocSeen, cell)) continue;
          }
          for (let e = cell * 4; e < cell * 4 + 4; e++) {
            const next = neighbors[e];
            if (next < 0) continue;
            const occ = board.cells[next];
            if (occ >= 0 && team(occ) !== side && hasBit(seen, next)) continue;
            const price = spent + costs[e] + (cell === start ? leaveZoC : 0);
            const rank = price * stepLimit + steps + 1;
            if (price <= mp && (routeStamp[next] !== stamp || rank < bestRoute[next])) {
              routeStamp[next] = stamp;
              bestRoute[next] = rank;
              routeParent[next] = cell;
              enqueue(rank, next);
            }
          }
        }
      }
      return found;
    }

    function generateMoves(board, side, ply, onlyAttacks, limit, ttBest) {
      const mBuf = plyMoves[ply];
      const sBuf = plyScores[ply];
      const seen = seenBuf[ply];
      scanSide(board, side, seen);
      const first = side * blueSlots;
      const enemyFirst = (side ^ 1) * blueSlots;
      const enemyZocSeen = zocSeenBuf[ply];
      enemyZocSeen.fill(0);
      for (let t = enemyFirst; t < enemyFirst + blueSlots; t++) {
        if (slotTypes[t] !== shieldType) continue;
        const pos = board.position[t];
        if (pos < 0 || !hasBit(seen, pos)) continue;
        for (let e = pos * 4; e < pos * 4 + 4; e++) {
          const adj = neighbors[e];
          if (adj >= 0) enemyZocSeen[adj >>> 5] |= 1 << (adj & 31);
        }
      }
      const k1 = killer1[ply];
      const k2 = killer2[ply];
      let living = 0;
      for (let i = 0; i < units; i++) if (board.position[i] >= 0) living++;
      const myFlagPos = board.position[flag[side]];
      const oppFlagPos = board.position[flag[side ^ 1]];
      let n = 0;

      const push = (packed, score) => {
        let ord = score;
        if (packed === ttBest) ord += 80000;
        else if (packed === k1) ord += 4800;
        else if (packed === k2) ord += 3800;
        if (n < MAX_GEN) {
          mBuf[n] = packed;
          sBuf[n] = ord;
          n++;
        }
      };

      let anyEnemyNear = false;
      for (let id = first; id < first + blueSlots; id++) {
        const origin = board.position[id];
        if (origin < 0) continue;
        const type = slotTypes[id];
        const reach = definitions[type].mp + (type === archerType ? 4 : (type === spearType ? 2 : 1));
        let nearEnemyCount = 0;
        for (let t = enemyFirst; t < enemyFirst + blueSlots; t++) {
          const pos = board.position[t];
          if (pos >= 0) {
            const d = rangeBetween(origin, pos);
            if (d <= reach) nearEnemies[nearEnemyCount++] = t;
            if (d <= 4 && hasBit(seen, pos)) anyEnemyNear = true;
          }
        }
        if (onlyAttacks && nearEnemyCount === 0) continue;

        for (let ei = 0; ei < nearEnemyCount; ei++) {
          const t = nearEnemies[ei];
          if (hasBit(seen, board.position[t]) && strikeInRange(board, id, t)) {
            push(packMove(id, t, -1, origin), attackOrderScore(board, id, t, 0));
          }
        }

        const originRivals = onlyAttacks ? 0 : (neighborCounts(board, origin, side) >>> 4);
        const found = reachableCells(board, id, seen, enemyZocSeen);
        const lStamp = ++curLandedStamp;
        const minAtkR = type === archerType ? 2 : 1;
        for (let j = 0; j < found; j++) {
          const dest = destinations[j];
          let len = 0;
          for (let c = dest; c >= 0; c = routeParent[c]) routeBuf[len++] = c;
          for (let a = 0, b = len - 1; a < b; a++, b--) {
            const tmp = routeBuf[a]; routeBuf[a] = routeBuf[b]; routeBuf[b] = tmp;
          }
          const stopped = landingPath(board, id, routeBuf, len);
          if (stopped < 0 && onlyAttacks) continue;
          const end = stopped < 0 ? -stopped - 2 : stopped;
          if (end === origin) continue;
          const kind = stopped < 0 ? 1 : 2;
          const prevMask = landedStamp[end] === lStamp ? landedBuf[end] : 0;
          if (prevMask & kind) continue;
          landedStamp[end] = lStamp;
          landedBuf[end] = prevMask | kind;

          if (!onlyAttacks) {
            const forward = (side ? 1 : -1) * (Math.floor(end / size) - Math.floor(origin / size));
            let quiet;
            if (stopped < 0) {
              quiet = -90;
            } else {
              quiet = forward * (living <= 8 ? 3 : 7) + (history[id * count + end] >> 2);
              if (terrain[end] === hill) quiet += type === archerType ? 56 : 34;
              if (type === flagType) {
                if (terrain[end] === forest) quiet += 26;
                if (forward > 0) quiet -= forward * 12;
                if (originRivals > 0 || board.hp[id] <= 5) {
                  // 旗手脫離近身威脅給予高優先序（修補元帥剪掉後撤的盲區）
                  let nearOrig = 0, nearEnd = 0;
                  for (let ei = 0; ei < nearEnemyCount; ei++) {
                    const ep = board.position[nearEnemies[ei]];
                    if (rangeBetween(origin, ep) <= 3) nearOrig++;
                    if (rangeBetween(end, ep) <= 3) nearEnd++;
                  }
                  if (nearEnd < nearOrig) quiet += (nearOrig - nearEnd) * 42;
                }
              } else if (type === archerType) {
                if (originRivals > 0 && (neighborCounts(board, end, side, id) >>> 4) === 0) quiet += 54;
              } else if (type === shieldType) {
                if (myFlagPos >= 0 && rangeBetween(end, myFlagPos) <= 2) quiet += 14;
                for (let ei = 0; ei < nearEnemyCount; ei++) {
                  const t = nearEnemies[ei];
                  if (rangeBetween(end, board.position[t]) === 1) {
                    const tt = slotTypes[t];
                    quiet += (tt === cavalryType || tt === flagType || tt === archerType) ? 30 : 14;
                  }
                }
              }
              // 補齊夾擊與援護加權
              const endAdj = neighborCounts(board, end, side, id);
              if ((endAdj & 15) > 0) quiet += 9;
              if (oppFlagPos >= 0 && rangeBetween(end, oppFlagPos) < rangeBetween(origin, oppFlagPos) && type !== flagType) {
                quiet += 10;
              }
            }
            push(packMove(id, -1, dest, stopped), quiet);
          }
          if (stopped < 0 || nearEnemyCount === 0) continue;

          // 先做距離快篩，無敵在射程內就跳過臨時移子
          const maxAtkR = type === archerType ? (terrain[end] === hill ? 4 : 3) : (type === spearType ? 2 : 1);
          let anyInRange = false;
          for (let ei = 0; ei < nearEnemyCount; ei++) {
            const d = rangeBetween(end, board.position[nearEnemies[ei]]);
            if (d >= minAtkR && d <= maxAtkR) { anyInRange = true; break; }
          }
          if (!anyInRange) continue;

          const disp = rangeBetween(origin, end);
          board.cells[origin] = -1;
          board.cells[end] = id;
          board.position[id] = end;
          for (let ei = 0; ei < nearEnemyCount; ei++) {
            const t = nearEnemies[ei];
            if (strikeInRange(board, id, t) && sideDetects(board, side, board.position[t])) {
              push(packMove(id, t, dest, end), attackOrderScore(board, id, t, disp) + 25);
            }
          }
          board.cells[end] = -1;
          board.cells[origin] = id;
          board.position[id] = origin;
        }
      }

      const guaranteeSkip = !onlyAttacks && (living <= 8 || board.turn >= maxTurns - 18);
      if (!onlyAttacks && (guaranteeSkip || living <= 10 || anyEnemyNear)) {
        push(SKIP_PACKED, guaranteeSkip ? 22 : 2);
      }

      // 部分選擇排序取前 limit 手（比全排更快）
      const take = Math.min(limit, n);
      for (let i = 0; i < take; i++) {
        let bestIdx = i;
        let bestVal = sBuf[i];
        for (let j = i + 1; j < n; j++) {
          if (sBuf[j] > bestVal) {
            bestVal = sBuf[j];
            bestIdx = j;
          }
        }
        if (bestIdx !== i) {
          const tm = mBuf[i]; mBuf[i] = mBuf[bestIdx]; mBuf[bestIdx] = tm;
          const ts = sBuf[i]; sBuf[i] = sBuf[bestIdx]; sBuf[bestIdx] = ts;
        }
      }
      // 在殘局／終局保證 skip 絕不被擠出展開寬度外
      if (guaranteeSkip && take > 0) {
        let hasSkip = false;
        for (let i = 0; i < take; i++) if (mBuf[i] === SKIP_PACKED) { hasSkip = true; break; }
        if (!hasSkip) mBuf[take - 1] = SKIP_PACKED;
      }
      return take;
    }

    function* quiescence(board, side, alpha, beta, remaining, ply, firstReply = true) {
      if ((++nodes & 31) === 0) yield* checkpoint();
      const term = terminal(board);
      if (term !== null) return term;
      let stand = evaluateWargod(board);
      if (remaining <= 0 || ply >= MAX_PLY) return stand;
      if (side === 1) {
        if (stand >= beta) return stand;
        if (stand > alpha) alpha = stand;
      } else {
        if (stand <= alpha) return stand;
        if (stand < beta) beta = stand;
      }

      const countMoves = generateMoves(board, side, ply, true, 5, -1);
      const mBuf = plyMoves[ply];
      const sBuf = plyScores[ply];
      const frame = frames[ply];
      let best = stand;
      for (let i = 0; i < countMoves; i++) {
        const packed = mBuf[i];
        const t = moveTarget(packed);
        const isFlagHit = t >= 0 && slotTypes[t] === flagType;
        // 首步排除明顯送頭換血；後續僅延伸斬首、擊殺、衝鋒破盾、夾擊破防等強制戰術打擊
        if (firstReply) {
          if (sBuf[i] < 900 && !isFlagHit) continue;
        } else {
          if (sBuf[i] < 6000 && !isFlagHit) continue;
        }
        makePacked(board, packed, frame);
        let sc;
        try {
          sc = yield* quiescence(board, side ^ 1, alpha, beta, remaining - 1, ply + 1, false);
        } finally {
          unmake(board, frame);
        }
        if (side === 1) {
          if (sc > best) best = sc;
          if (best > alpha) alpha = best;
        } else {
          if (sc < best) best = sc;
          if (best < beta) beta = best;
        }
        if (alpha >= beta) break;
      }
      return best;
    }

    function* alphaBeta(board, side, depth, alpha, beta, ply, qDepth) {
      if ((++nodes & 31) === 0) yield* checkpoint();
      const term = terminal(board);
      if (term !== null) return term;
      if (depth <= 0 || ply >= MAX_PLY) {
        return qDepth > 0
          ? yield* quiescence(board, side, alpha, beta, qDepth, ply)
          : evaluateWargod(board);
      }

      const origAlpha = alpha;
      const origBeta = beta;
      const key = (board.hash ^ turnKeys[board.turn] ^ Math.imul(qDepth, 0x2c1b3c6d)) >>> 0;
      const ttIdx = key & TT_MASK;
      let ttBest = -1;
      if (ttKeys[ttIdx] === key && ttDepth[ttIdx] >= 0) {
        ttBest = ttMove[ttIdx];
        if (ttDepth[ttIdx] >= depth) {
          const v = ttValue[ttIdx];
          const b = ttBound[ttIdx];
          if (b === 0 || (b === 1 && v <= alpha) || (b === 2 && v >= beta)) return v;
        }
      }

      let living = 0;
      for (let i = 0; i < units; i++) if (board.position[i] >= 0) living++;
      const width = depth === 1 ? (living <= 8 ? 5 : 6)
        : (depth === 2 ? (living <= 8 ? 6 : 7) : (living <= 8 ? 7 : 8));
      const countMoves = generateMoves(board, side, ply, false, width, ttBest);
      if (countMoves === 0) return evaluateWargod(board);

      let futilityOk = false;
      if (depth === 1 && Math.abs(alpha) < WIN - 2000 && Math.abs(beta) < WIN - 2000) {
        const se = evaluateWargod(board);
        futilityOk = side === 1 ? (se + 260 <= alpha) : (se - 260 >= beta);
      }

      const mBuf = plyMoves[ply];
      const frame = frames[ply];
      let best = side === 1 ? -INF : INF;
      let bestMove = -1;

      for (let i = 0; i < countMoves; i++) {
        const packed = mBuf[i];
        const isAttack = moveTarget(packed) >= 0;
        const isSkip = packed === SKIP_PACKED;
        const isKiller = packed === killer1[ply] || packed === killer2[ply];
        if (futilityOk && i >= 3 && !isAttack && !isSkip && !isKiller && moveUnit(packed) !== flag[side]) {
          continue;
        }
        const lateEndgame = board.turn >= maxTurns - 16 || living <= 7;

        let reduction = 0;
        if (depth >= 3 && i >= 3 && !isAttack && !isKiller && !(isSkip && lateEndgame)) {
          reduction = (i >= 6 && depth >= 4) ? 2 : 1;
        }

        makePacked(board, packed, frame);
        let sc;
        try {
          if (i === 0) {
            sc = yield* alphaBeta(board, side ^ 1, depth - 1, alpha, beta, ply + 1, qDepth);
          } else if (side === 1) {
            sc = yield* alphaBeta(board, side ^ 1, depth - 1 - reduction, alpha, alpha + 1, ply + 1, qDepth);
            if (sc > alpha && reduction > 0) {
              sc = yield* alphaBeta(board, side ^ 1, depth - 1, alpha, alpha + 1, ply + 1, qDepth);
            }
            if (sc > alpha && sc < beta) {
              sc = yield* alphaBeta(board, side ^ 1, depth - 1, alpha, beta, ply + 1, qDepth);
            }
          } else {
            sc = yield* alphaBeta(board, side ^ 1, depth - 1 - reduction, beta - 1, beta, ply + 1, qDepth);
            if (sc < beta && reduction > 0) {
              sc = yield* alphaBeta(board, side ^ 1, depth - 1, beta - 1, beta, ply + 1, qDepth);
            }
            if (sc < beta && sc > alpha) {
              sc = yield* alphaBeta(board, side ^ 1, depth - 1, alpha, beta, ply + 1, qDepth);
            }
          }
        } finally {
          unmake(board, frame);
        }

        if (side === 1 ? sc > best : sc < best) {
          best = sc;
          bestMove = packed;
        }
        if (side === 1) {
          if (best > alpha) alpha = best;
        } else {
          if (best < beta) beta = best;
        }
        if (alpha >= beta) {
          if (!isAttack && !isSkip) {
            if (killer1[ply] !== packed) {
              killer2[ply] = killer1[ply];
              killer1[ply] = packed;
            }
            const u = moveUnit(packed);
            const end = moveLanding(packed);
            if (u >= 0 && end >= 0) {
              const hIdx = u * count + end;
              history[hIdx] = Math.min(20000, history[hIdx] + depth * depth * 12);
            }
          }
          break;
        }
      }

      ttKeys[ttIdx] = key;
      ttDepth[ttIdx] = depth;
      ttValue[ttIdx] = best;
      ttBound[ttIdx] = best <= origAlpha ? 1 : (best >= origBeta ? 2 : 0);
      ttMove[ttIdx] = bestMove;
      return best;
    }

    function* searchAspirated(board, depthMinusOne, center, qDepth) {
      if (Math.abs(center) >= WIN - 2000) {
        return yield* alphaBeta(board, 0, depthMinusOne, -INF, INF, 1, qDepth);
      }
      let delta = 140;
      let lo = Math.max(-INF, center - delta);
      let hi = Math.min(INF, center + delta);
      while (true) {
        const sc = yield* alphaBeta(board, 0, depthMinusOne, lo, hi, 1, qDepth);
        if (sc <= lo && lo > -INF) {
          delta *= 3;
          lo = delta > 20000 ? -INF : Math.max(-INF, sc - delta);
        } else if (sc >= hi && hi < INF) {
          delta *= 3;
          hi = delta > 20000 ? INF : Math.min(INF, sc + delta);
        } else {
          return sc;
        }
      }
    }

    const fromD = startDepth || 1;
    const toD = endDepth || maxDepth || 6;
    const emitFrom = reportFromDepth || fromD;
    const rootOrder = roots.map((_, idx) => idx);
    const prevAdj = new Float64Array(roots.length);
    const prevWorldScores = Array.from({ length: roots.length }, () => new Int32Array(boards.length));
    let hasPrevWorld = false;
    let lastReport = null;

    try {
      for (let depth = fromD; depth <= toD; depth++) {
        // 深度加深時微衰減歷史表，保留近層經驗
        if (depth > fromD) {
          for (let i = 0; i < history.length; i++) history[i] >>= 1;
        }
        const qDepth = depth <= 2 ? 0 : (depth === 3 ? 2 : (packet.living <= 8 ? 4 : 3));
        const scores = new Array(roots.length);
        const useSingleCutoff = Boolean(singleWorld) && boards.length === 1 && depth >= emitFrom;

        if (useSingleCutoff) {
          if (depth > fromD) rootOrder.sort((a, b) => prevAdj[b] - prevAdj[a]);
          let top1 = -INF;
          let top2 = -INF;
          const board = boards[0];
          const frame = frames[0];
          for (let oi = 0; oi < rootOrder.length; oi++) {
            yield* checkpoint();
            const r = rootOrder[oi];
            const move = roots[r];
            const off = (move.voi || 0) + (move.tempo || 0);
            makeRoot(board, move, frame);
            let sc;
            try {
              if (oi >= 2 && top2 > -INF + 1000) {
                const alphaBound = Math.abs(top2) >= WIN - 700
                  ? top2 - 4
                  : Math.min(WIN - 700, top2 - off - 4);
                sc = yield* alphaBeta(board, 0, depth - 1, alphaBound, INF, 1, qDepth);
              } else if (hasPrevWorld && depth >= 4) {
                sc = yield* searchAspirated(board, depth - 1, prevWorldScores[r][0], qDepth);
              } else {
                sc = yield* alphaBeta(board, 0, depth - 1, -INF, INF, 1, qDepth);
              }
            } finally {
              unmake(board, frame);
            }
            scores[r] = Int32Array.of(sc);
            prevWorldScores[r][0] = sc;
            const adj = (sc > WIN - 600 || sc < -(WIN - 600)) ? sc : sc + off;
            prevAdj[r] = adj;
            if (adj > top1) {
              top2 = top1;
              top1 = adj;
            } else if (adj > top2) {
              top2 = adj;
            }
          }
          hasPrevWorld = true;
        } else {
          for (let r = 0; r < roots.length; r++) {
            const move = roots[r];
            const perWorld = new Int32Array(boards.length);
            for (let w = 0; w < boards.length; w++) {
              yield* checkpoint();
              const board = boards[w];
              const frame = frames[0];
              makeRoot(board, move, frame);
              let sc;
              try {
                if (hasPrevWorld && depth >= 4) {
                  sc = yield* searchAspirated(board, depth - 1, prevWorldScores[r][w], qDepth);
                } else {
                  sc = yield* alphaBeta(board, 0, depth - 1, -INF, INF, 1, qDepth);
                }
              } finally {
                unmake(board, frame);
              }
              perWorld[w] = sc;
            }
            scores[r] = perWorld;
            prevWorldScores[r].set(perWorld);
            if (boards.length === 1) {
              const sc = perWorld[0];
              prevAdj[r] = (sc > WIN - 600 || sc < -(WIN - 600)) ? sc : sc + (move.voi || 0) + (move.tempo || 0);
            }
          }
          hasPrevWorld = true;
        }

        if (depth >= emitFrom || depth === toD) {
          lastReport = { depth, nodes, scores, worldWeights: boards.map(b => b.weight) };
          emit(lastReport);
        }
      }
    } catch (error) {
      if (error !== timeout) throw error;
    }
    return lastReport;
  }

  function wargodWorkerSource() {
    return `'use strict';
      ${searchWargodShard.toString()}
      self.onmessage = ({ data: { id, stage, packet, budget } }) => {
        const emit = value => self.postMessage({ id, stage, kind: 'progress', value });
        try {
          const job = searchWargodShard(packet, emit, { budget });
          let step = job.next();
          while (!step.done) step = job.next();
          self.postMessage({ id, stage, kind: 'done', value: step.value });
        } catch {
          self.postMessage({ id, stage, kind: 'failed' });
        }
      };`;
  }

  return {
    protocolVersion: 1,
    id: 'wargod',
    name: '軍神',
    label: '軍神 · 極限推演',
    order: 50,
    coordinateSpace: 'canonical',
    thinkingText: '極限推演中…',
    pacingDelayMs: 0,
    timeoutMs: 25000,
    _workerSourceForTest: wargodWorkerSource,

    createAgent(initCtx) {
      const { rules } = initCtx;
      const agentRng = initCtx.rng || Math.random;

      const {
        BOARD_SIZE, MAX_TURNS, CELL_COUNT, VISION_WORDS, DIRS,
        TYPE_NAMES, INITIAL_BLUE_UNITS, BLUE_SLOTS,
        inBounds, manhattan, cellIndex,
        getUnitById, getUnitAt, getAliveFlag,
        hasLineOfSight, isTileScanned, getMoveStepCost,
        computeReachableFor, canUnitAttackTargetWithVision, getValidAttackTargetsFor,
        countAdjacentUnits, hasFlagAura, calcEffectiveDef, previewCombat
      } = rules;
      const AI_VALUE = { flag: 180, shield: 68, spear: 66, archer: 78, cavalry: 72 };
      const UNIT_DEFS = Object.fromEntries(
        Object.entries(rules.UNIT_DEFS).map(([k, v]) => [k, { ...v, aiValue: AI_VALUE[k] }])
      );


      function createAiMemory(rngFn) {
        const redKnowledge = Object.fromEntries(INITIAL_BLUE_UNITS.map(({ type }, index) => {
          const id = 'B' + (index + 1);
          const maxHp = UNIT_DEFS[type].maxHp;
          return [id, {
            id, type, maxHp, knownHp: maxHp, lastX: null, lastY: null,
            lastSeenTurn: -1, lastPositionCleared: false, alive: true
          }];
        }));
        return {
          redKnowledge,
          redTileLastSeen: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0)),
          recentPositions: Object.fromEntries(INITIAL_BLUE_UNITS.map(({ x, y }, index) =>
            ['R' + (index + 1), [{ x: BOARD_SIZE - 1 - x, y: BOARD_SIZE - 1 - y }]])),
          lastMovedUnitId: null,
          consecutiveMoves: 0,
          flankBias: rngFn() < 0.5 ? -1 : 1
        };
      }

      function updateMemoryFromVision(memory, board, cVision, turn) {
        const { redKnowledge, redTileLastSeen } = memory;
        for (let y = 0; y < BOARD_SIZE; y++) {
          for (let x = 0; x < BOARD_SIZE; x++) {
            if (isTileScanned(x, y, cVision, board.map)) redTileLastSeen[y][x] = turn;
          }
        }
        for (const cId of cVision.detectedEnemyIds) {
          const unit = getUnitById(cId, board);
          if (!unit || !redKnowledge[cId]) continue;
          Object.assign(redKnowledge[cId], {
            knownHp: unit.hp, lastX: unit.x, lastY: unit.y,
            lastSeenTurn: turn, lastPositionCleared: false
          });
        }
        for (const entry of Object.values(redKnowledge)) {
          if (entry.alive && entry.lastX !== null && !cVision.detectedEnemyIds.has(entry.id)
              && isTileScanned(entry.lastX, entry.lastY, cVision, board.map)) {
            entry.lastPositionCleared = true;
          }
        }
      }

      function updateMemoryFromSelfAction(memory, event) {
        if (event.actionType === 'skip') {
          memory.lastMovedUnitId = null;
          memory.consecutiveMoves = 0;
          return;
        }
        const cUnitId = event.unitId;
        if (!cUnitId) return;
        if (memory.lastMovedUnitId === cUnitId) memory.consecutiveMoves += 1;
        else {
          memory.lastMovedUnitId = cUnitId;
          memory.consecutiveMoves = 1;
        }
        if (event.displacement > 0 && event.to) {
          const positions = memory.recentPositions[cUnitId];
          if (positions) {
            positions.push({ x: event.to.x, y: event.to.y });
            if (positions.length > 3) positions.shift();
          }
        }
      }


      let cachedGeometry = null;
      function advancedGeometryFor(map) {
        if (cachedGeometry) return cachedGeometry;
        const terrain = new Uint8Array(CELL_COUNT);
        const neighbors = new Int16Array(CELL_COUNT * DIRS.length).fill(-1);
        const costs = new Uint8Array(neighbors.length);
        const distance = new Uint8Array(CELL_COUNT * CELL_COUNT);
        const scans = new Uint32Array(TYPE_NAMES.length * CELL_COUNT * VISION_WORDS);
        const board = { map };
        const maxVision = Math.max(...TYPE_NAMES.map(type => UNIT_DEFS[type].vision));

        for (let from = 0; from < CELL_COUNT; from++) {
          const x = from % BOARD_SIZE;
          const y = Math.floor(from / BOARD_SIZE);
          const cell = map[y][x];
          terrain[from] = cell.terrain === 'forest' ? 2 : cell.elev;
          for (const [direction, { dx, dy }] of DIRS.entries()) {
            const nx = x + dx;
            const ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            const edge = from * DIRS.length + direction;
            neighbors[edge] = cellIndex(nx, ny);
            costs[edge] = getMoveStepCost(x, y, nx, ny, board);
          }
          for (let to = 0; to < CELL_COUNT; to++) {
            const tx = to % BOARD_SIZE;
            const ty = Math.floor(to / BOARD_SIZE);
            distance[from * CELL_COUNT + to] = manhattan(x, y, tx, ty);
            const euclid = Math.hypot(tx - x, ty - y);
            if (euclid > maxVision + cell.elev + 0.5 || (map[ty][tx].terrain === 'forest' && euclid > 2.05)
                || !hasLineOfSight(x, y, tx, ty, cell.elev, board)) continue;
            for (const [type, name] of TYPE_NAMES.entries()) {
              if (euclid <= UNIT_DEFS[name].vision + cell.elev + 0.5) {
                const offset = (type * CELL_COUNT + from) * VISION_WORDS;
                scans[offset + (to >>> 5)] |= 1 << (to & 31);
              }
            }
          }
        }
        cachedGeometry = { terrain, neighbors, costs, distance, scans };
        return cachedGeometry;
      }

      function buildCanonicalKnowledge(board, cVision) {
        const seen = new Int16Array(BLUE_SLOTS).fill(-1);
        const blocked = new Uint8Array(CELL_COUNT);
        const scanned = new Uint8Array(CELL_COUNT);
        const myPositions = [];
        for (const cId of cVision.detectedEnemyIds) {
          const unit = getUnitById(cId, board);
          if (!unit) continue;
          const cell = cellIndex(unit.x, unit.y);
          seen[Number(cId.slice(1)) - 1] = cell;
          blocked[cell] = 1;
        }
        for (const unit of board.units) {
          if (unit.faction === 'red' && unit.alive) {
            const cell = cellIndex(unit.x, unit.y);
            blocked[cell] = 1;
            myPositions.push({ cell, shield: unit.type === 'shield', type: unit.type });
          }
        }
        for (let cell = 0; cell < CELL_COUNT; cell++) {
          if (isTileScanned(cell % BOARD_SIZE, Math.floor(cell / BOARD_SIZE), cVision, board.map)) {
            blocked[cell] = 1;
            scanned[cell] = 1;
          }
        }
        return { seen, blocked, scanned, myPositions };
      }

      function beliefDestinations(start, mp, geometry, occupied, enemyZoC, avoidCells = null) {
        const cost = new Uint8Array(CELL_COUNT).fill(255);
        const queue = Array.from({ length: mp + 1 }, () => []);
        const destinations = [];
        cost[start] = 0;
        queue[0].push(start);
        for (let spent = 0; spent <= mp; spent++) {
          for (const cell of queue[spent]) {
            if (cost[cell] !== spent) continue;
            if (cell !== start) {
              destinations.push(cell);
              if (enemyZoC[cell]) continue;
            }
            for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
              const next = geometry.neighbors[edge];
              if (next < 0 || occupied[next] || (avoidCells && avoidCells[next])) continue;
              const price = spent + geometry.costs[edge] + (cell === start ? enemyZoC[start] : 0);
              if (price <= mp && price < cost[next]) {
                cost[next] = price;
                queue[price].push(next);
              }
            }
          }
        }
        return destinations;
      }


      const config = { minTime: 500, softMax: 18500, hardMax: 21500 };
      const memory = createAiMemory(agentRng);
      let observedEnemyAction = null;
      let observedFogAttack = null;
      let searchSeq = 0;

  const PARTICLE_COUNT = 192;

  function createParticleFilter() {
    const startPos = Int16Array.from(INITIAL_BLUE_UNITS.map(({ x, y }) => cellIndex(x, y)));
    return Array.from({ length: PARTICLE_COUNT }, () => ({
      pos: Int16Array.from(startPos),
      weight: 1 / PARTICLE_COUNT
    }));
  }

  function wargodTacticalTilePrior(type, cell, geometry) {
    const x = cell % BOARD_SIZE;
    const y = Math.floor(cell / BOARD_SIZE);
    const t = geometry.terrain[cell];
    let w = 1.0;
    if (type === 'flag') {
      if (t === 2) w *= 2.3;
      else if (t === 1) w *= 1.45;
      if (y >= 6) w *= 1.35;
      else if (y <= 3) w *= 0.45;
    } else if (type === 'archer') {
      if (t === 1) w *= 3.0;
      else if (t === 2) w *= 1.25;
      if (y >= 4 && y <= 8) w *= 1.3;
    } else if (type === 'cavalry') {
      if (t === 2) w *= 0.55;
      else if (t === 1) w *= 1.6;
      if (x <= 2 || x >= 7) w *= 1.45;
      if (y >= 2 && y <= 7) w *= 1.25;
    } else {
      if (t === 1) w *= 2.2;
      else if (t === 2) w *= 1.3;
      if (x >= 2 && x <= 7 && y >= 3 && y <= 7) w *= 1.35;
    }
    return w;
  }

  function canonicalCanHitCell(type, fromCell, targetCell, geometry) {
    const dist = geometry.distance[fromCell * CELL_COUNT + targetCell];
    if (type === 'archer') {
      const maxR = geometry.terrain[fromCell] === 1 ? 4 : 3;
      return dist >= 2 && dist <= maxR;
    }
    if (dist === 1) return true;
    if (type === 'spear' && dist === 2) {
      const fx = fromCell % BOARD_SIZE, fy = Math.floor(fromCell / BOARD_SIZE);
      const tx = targetCell % BOARD_SIZE, ty = Math.floor(targetCell / BOARD_SIZE);
      if (fx !== tx && fy !== ty) return false;
      const mid = (fromCell + targetCell) >> 1;
      if (geometry.terrain[fromCell] !== 1 && (geometry.terrain[targetCell] === 1 || geometry.terrain[mid] === 1)) return false;
      return true;
    }
    return false;
  }

  function repairParticleForKnowledge(particle, knowledge, memory, geometry) {
    const { seen, blocked } = knowledge;
    const used = new Uint8Array(CELL_COUNT);
    for (let cell = 0; cell < CELL_COUNT; cell++) if (blocked[cell]) used[cell] = 1;
    for (let slot = 0; slot < BLUE_SLOTS; slot++) {
      const entry = memory.redKnowledge['B' + (slot + 1)];
      if (!entry.alive) {
        particle.pos[slot] = -1;
      } else if (seen[slot] >= 0) {
        particle.pos[slot] = seen[slot];
        used[seen[slot]] = 1;
      }
    }
    let valid = true;
    for (let slot = 0; slot < BLUE_SLOTS; slot++) {
      const entry = memory.redKnowledge['B' + (slot + 1)];
      if (!entry.alive || seen[slot] >= 0) continue;
      const cur = particle.pos[slot];
      if (cur >= 0 && !used[cur]) {
        used[cur] = 1;
        continue;
      }
      valid = false;
      const anchor = entry.lastX === null ? INITIAL_BLUE_UNITS[slot] : { x: entry.lastX, y: entry.lastY };
      let bestSum = 0;
      const candidates = [];
      for (let cell = 0; cell < CELL_COUNT; cell++) {
        if (used[cell]) continue;
        const d = manhattan(cell % BOARD_SIZE, Math.floor(cell / BOARD_SIZE), anchor.x, anchor.y);
        const w = wargodTacticalTilePrior(entry.type, cell, geometry) / (1 + d * d * 0.65);
        candidates.push([cell, w]);
        bestSum += w;
      }
      if (bestSum > 0) {
        let pick = agentRng() * bestSum;
        let chosen = candidates[candidates.length - 1][0];
        for (const [cell, w] of candidates) {
          pick -= w;
          if (pick <= 0) { chosen = cell; break; }
        }
        particle.pos[slot] = chosen;
        used[chosen] = 1;
      } else {
        particle.pos[slot] = -1;
      }
    }
    return valid;
  }

  function resampleParticles(particles) {
    const n = particles.length;
    let sum = 0;
    for (const p of particles) sum += p.weight;
    if (sum <= 0) {
      for (const p of particles) p.weight = 1 / n;
      return;
    }
    let essInv = 0;
    for (const p of particles) {
      p.weight /= sum;
      essInv += p.weight * p.weight;
    }
    const ess = essInv > 0 ? 1 / essInv : 0;
    if (ess >= n * 0.55) return;

    const next = new Array(n);
    const step = 1 / n;
    let r = agentRng() * step;
    let cum = particles[0].weight;
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const target = r + i * step;
      while (target > cum && idx < n - 1) cum += particles[++idx].weight;
      next[i] = { pos: Int16Array.from(particles[idx].pos), weight: step };
    }
    for (let i = 0; i < n; i++) particles[i] = next[i];
  }

  function filterParticlesFor(knowledge, map) {
    if (!particles || !memory) return;
    const geometry = advancedGeometryFor(map);
    const { seen, blocked } = knowledge;
    let survivingWeight = 0;

    for (const p of particles) {
      let consistent = true;
      const seenSet = new Set();
      for (let slot = 0; slot < BLUE_SLOTS; slot++) {
        const entry = memory.redKnowledge['B' + (slot + 1)];
        if (!entry.alive) {
          p.pos[slot] = -1;
          continue;
        }
        if (seen[slot] >= 0) {
          p.pos[slot] = seen[slot];
          seenSet.add(seen[slot]);
        } else {
          const c = p.pos[slot];
          if (c < 0 || blocked[c] || seenSet.has(c)) {
            consistent = false;
          } else {
            seenSet.add(c);
          }
        }
      }
      if (!consistent) {
        p.weight *= 0.002;
        repairParticleForKnowledge(p, knowledge, memory, geometry);
      } else {
        survivingWeight += p.weight;
      }
    }
    if (survivingWeight <= 1e-6) {
      for (const p of particles) p.weight = 1 / particles.length;
    }
    resampleParticles(particles);
  }

  function advanceParticlesFor(board, cVision) {
    if (!particles || !memory) return;
    const knowledge = buildCanonicalKnowledge(board, cVision);
    const { seen, blocked, scanned, myPositions } = knowledge;
    const observation = observedEnemyAction;
    const fogAttack = observedFogAttack;
    const geometry = advancedGeometryFor(board.map);

    const myOccupied = new Uint8Array(CELL_COUNT);
    const myZoC = new Uint8Array(CELL_COUNT);
    for (const { cell, shield } of myPositions) {
      myOccupied[cell] = 1;
      if (!shield) continue;
      for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
        const next = geometry.neighbors[edge];
        if (next >= 0) myZoC[next] = 1;
      }
    }

    const hiddenSlots = [];
    for (let slot = 0; slot < BLUE_SLOTS; slot++) {
      const entry = memory.redKnowledge['B' + (slot + 1)];
      if (entry.alive && seen[slot] < 0) hiddenSlots.push(slot);
    }

    const slotMobilityWeight = { cavalry: 1.55, spear: 1.25, shield: 1.1, archer: 1.0, flag: 0.65 };

    for (const p of particles) {
      for (let slot = 0; slot < BLUE_SLOTS; slot++) {
        const entry = memory.redKnowledge['B' + (slot + 1)];
        if (!entry.alive) p.pos[slot] = -1;
        else if (seen[slot] >= 0) p.pos[slot] = seen[slot];
      }

      if (!hiddenSlots.length) continue;

      if (observation) {
        const obsSlot = Number(observation.id.slice(1)) - 1;
        if (obsSlot >= 0 && seen[obsSlot] < 0 && memory.redKnowledge[observation.id].alive) {
          const entry = memory.redKnowledge[observation.id];
          const occupied = Uint8Array.from(myOccupied);
          for (let s = 0; s < BLUE_SLOTS; s++) if (s !== obsSlot && p.pos[s] >= 0) occupied[p.pos[s]] = 1;
          const dests = beliefDestinations(observation.cell, UNIT_DEFS[entry.type].mp, geometry, occupied, myZoC)
            .filter(c => !blocked[c] && !occupied[c]);
          if (dests.length) {
            let sum = 0;
            const weights = dests.map(c => { const w = wargodTacticalTilePrior(entry.type, c, geometry); sum += w; return w; });
            let pick = agentRng() * sum;
            let chosen = dests[dests.length - 1];
            for (let i = 0; i < dests.length; i++) { pick -= weights[i]; if (pick <= 0) { chosen = dests[i]; break; } }
            p.pos[obsSlot] = chosen;
          } else {
            p.weight *= 0.05;
          }
        }
      } else if (fogAttack) {
        // 合法反推：紅方某格遭迷霧內敵軍攻擊，找出粒子中能合法移動並從未掃描格擊中目標的隱身敵軍。
        const candidates = [];
        let totalW = 0;
        for (const slot of hiddenSlots) {
          const entry = memory.redKnowledge['B' + (slot + 1)];
          const from = p.pos[slot];
          if (from < 0) continue;
          // 若為遠程無反擊且未見攻方，排除無法從遠程發動攻擊的兵種
          if (fogAttack.rangedOnly && entry.type !== 'archer' && entry.type !== 'spear') continue;
          const occupied = Uint8Array.from(myOccupied);
          for (let s = 0; s < BLUE_SLOTS; s++) if (s !== slot && p.pos[s] >= 0) occupied[p.pos[s]] = 1;
          const reachable = [from, ...beliefDestinations(from, UNIT_DEFS[entry.type].mp, geometry, occupied, myZoC, scanned)];
          for (const dest of reachable) {
            if (blocked[dest] || (dest !== from && occupied[dest])) continue;
            if (!canonicalCanHitCell(entry.type, dest, fogAttack.targetCell, geometry)) continue;
            const dist = geometry.distance[dest * CELL_COUNT + fogAttack.targetCell];
            if (fogAttack.rangedOnly && dist < 2) continue;
            // 簡易傷害一致性加權（合法傷害範圍）
            const atkEst = UNIT_DEFS[entry.type].baseAtk + (geometry.terrain[dest] === 1 && fogAttack.targetElev === 0 ? 1 : 0);
            const dmgGap = Math.abs(Math.max(1, atkEst - fogAttack.targetBaseDef) - fogAttack.damage);
            const matchFactor = dmgGap <= 2 ? 2.4 : (dmgGap <= 4 ? 0.9 : 0.25);
            const w = wargodTacticalTilePrior(entry.type, dest, geometry) * matchFactor;
            candidates.push({ slot, dest, w });
            totalW += w;
          }
        }
        if (candidates.length && totalW > 0) {
          let pick = agentRng() * totalW;
          let chosen = candidates[candidates.length - 1];
          for (const c of candidates) { pick -= c.w; if (pick <= 0) { chosen = c; break; } }
          p.pos[chosen.slot] = chosen.dest;
          p.weight *= 1.8;
        } else {
          p.weight *= 0.01;
        }
      } else if (agentRng() < 0.92) {
        // 迷霧中無觀測事件：每個粒子嚴格只推進「至多一枚」隱身敵軍，並避開已掃描格。
        let slotSum = 0;
        const slotWeights = hiddenSlots.map(slot => {
          const w = slotMobilityWeight[memory.redKnowledge['B' + (slot + 1)].type] || 1;
          slotSum += w;
          return w;
        });
        let pickSlot = agentRng() * slotSum;
        let chosenSlot = hiddenSlots[hiddenSlots.length - 1];
        for (let i = 0; i < hiddenSlots.length; i++) {
          pickSlot -= slotWeights[i];
          if (pickSlot <= 0) { chosenSlot = hiddenSlots[i]; break; }
        }
        const entry = memory.redKnowledge['B' + (chosenSlot + 1)];
        const from = p.pos[chosenSlot];
        if (from >= 0) {
          const occupied = Uint8Array.from(myOccupied);
          for (let s = 0; s < BLUE_SLOTS; s++) if (s !== chosenSlot && p.pos[s] >= 0) occupied[p.pos[s]] = 1;
          const dests = beliefDestinations(from, UNIT_DEFS[entry.type].mp, geometry, occupied, myZoC, scanned)
            .filter(c => !blocked[c] && !occupied[c]);
          if (dests.length) {
            let sum = 0;
            const weights = dests.map(c => { const w = wargodTacticalTilePrior(entry.type, c, geometry); sum += w; return w; });
            let pick = agentRng() * sum;
            let chosen = dests[dests.length - 1];
            for (let i = 0; i < dests.length; i++) { pick -= weights[i]; if (pick <= 0) { chosen = dests[i]; break; } }
            p.pos[chosenSlot] = chosen;
          }
        }
      }
    }

    observedEnemyAction = null;
    observedFogAttack = null;
    filterParticlesFor(knowledge, board.map);
  }

  function particleMarginals(particles, knownPositions, estimatedHp) {
    const marginals = Array.from({ length: BLUE_SLOTS }, () => new Float32Array(CELL_COUNT));
    for (let slot = 0; slot < BLUE_SLOTS; slot++) {
      if (knownPositions[slot] >= 0) {
        marginals[slot][knownPositions[slot]] = 1;
      } else if (estimatedHp[slot] > 0 && particles) {
        let sum = 0;
        for (const p of particles) {
          const cell = p.pos[slot];
          if (cell >= 0) {
            marginals[slot][cell] += p.weight;
            sum += p.weight;
          }
        }
        if (sum > 0) {
          for (let cell = 0; cell < CELL_COUNT; cell++) marginals[slot][cell] /= sum;
        }
      }
    }
    return marginals;
  }
      const particles = createParticleFilter();

  /**
   * 計算紅軍單位站上 (tx, ty) 能新揭露幾個目前未見格子（嚴格僅參考 redVision）
   */
  function countNewlyRevealedTiles(unit, tx, ty, redVision, board) {
    const def = UNIT_DEFS[unit.type];
    const obsElev = board.map[ty][tx].elev;
    const radius = def.vision + (obsElev === 1 ? 1 : 0);
    const maxEuclid = radius + 0.5;
    let newly = 0;
    let forestScanBonus = 0;

    const minY = Math.max(0, ty - radius - 1);
    const maxY = Math.min(BOARD_SIZE - 1, ty + radius + 1);
    const minX = Math.max(0, tx - radius - 1);
    const maxX = Math.min(BOARD_SIZE - 1, tx + radius + 1);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const eDist = Math.hypot(x - tx, y - ty);
        if (eDist > maxEuclid) continue;
        const cell = board.map[y][x];
        const alreadyKnown = cell.terrain === 'forest'
          ? redVision.forestReveal[y][x]
          : redVision.tileVisible[y][x];
        if (alreadyKnown) continue;

        if (hasLineOfSight(tx, ty, x, y, obsElev, board)) {
          if (cell.terrain === 'forest') {
            if (eDist <= 2.05) {
              newly += 1;
              forestScanBonus += 0.65;
            }
          } else {
            newly += 1;
          }
        }
      }
    }
    return { newly, forestScanBonus };
  }

  /**
   * 建構紅方 AI 唯一允許使用的「已知敵軍清單」（僅含視野內可見藍軍＋進階模式近期高可信殘影）
   */
  function getKnownEnemySnapshots(board, memory, turn) {
    const known = board.units.filter(unit => unit.faction === 'blue')
      .map(unit => ({ ...unit, isVisible: true, confidence: 1 }));
    if (!memory) return known;

    const visibleIds = new Set(known.map(unit => unit.id));
    for (const entry of Object.values(memory.redKnowledge)) {
      const age = turn - entry.lastSeenTurn;
      if (!entry.alive || visibleIds.has(entry.id) || entry.lastX === null || entry.lastPositionCleared
          || age < 1 || age > 4) continue;
      known.push({
        id: entry.id, type: entry.type, faction: 'blue', x: entry.lastX, y: entry.lastY,
        hp: entry.knownHp, maxHp: entry.maxHp, alive: true,
        age, confidence: Math.pow(0.76, age), isVisible: false
      });
    }
    return known;
  }
  /**
   * 估算某格受到已知敵軍下回合的潛在最大傷害（不偷看迷霧）
   */
  function estimateImmediateThreatOn(unit, tx, ty, knownEnemies, board) {
    let maxDmg = 0;
    let totalThreat = 0;
    const origX = unit.x;
    const origY = unit.y;
    unit.x = tx;
    unit.y = ty;

    try {
      for (const e of knownEnemies) {
        const eDef = UNIT_DEFS[e.type];
        const dist = manhattan(e.x, e.y, tx, ty);
        const reach = eDef.mp + (e.type === 'archer' ? (board.map[e.y][e.x].elev === 1 ? 4 : 3) : (e.type === 'spear' ? 2 : 1));
        if (dist > reach) continue;

        let estAtk = eDef.baseAtk + 1; // 預留旗手/高地餘裕
        let isShattered = false;
        if (e.type === 'cavalry' && dist >= 3 && board.map[ty][tx].terrain !== 'forest') {
          estAtk += 2;
          if (unit.type === 'shield') isShattered = true;
        }
        if (e.type === 'spear' && unit.type === 'cavalry') estAtk += 2;

        const defEst = calcEffectiveDef(unit, e, e.type === 'archer' ? 2 : 1, isShattered, board).total;
        const rawDmg = Math.max(1, estAtk - defEst) * e.confidence;
        if (rawDmg > maxDmg) maxDmg = rawDmg;
        totalThreat += rawDmg * 0.45;
      }
    } finally {
      unit.x = origX;
      unit.y = origY;
    }
    return { maxDmg, totalThreat };
  }

  /**
   * 決定紅軍 AI 的隱藏動態戰術姿態（不顯示於 UI）
   * 內含：剩餘回合殘局門檻、無交戰僵持破局層數、第 36 回合封頂推進壓力
   */
  function buildAiStrategicContext(observation) {
    const { board, redVision, turn, memory, turnsSinceDamage, flankBias } = observation;
    const isAdvanced = memory !== null;
    const myUnits = board.units.filter(unit => unit.faction === 'red');
    const myFlag = getAliveFlag('red', board);
    const myHp = myUnits.reduce((total, unit) => total + unit.hp, 0);
    const knownEnemies = getKnownEnemySnapshots(board, memory, turn);
    const visibleEnemies = knownEnemies.filter(unit => unit.isVisible);
    const avgTeamY = myUnits.reduce((total, unit) => total + unit.y, 0) / Math.max(1, myUnits.length);
    const remTurns = MAX_TURNS - turn;
    const ctx = {
      board, redVision, turn, memory, flankBias, isAdvanced, myUnits, myFlag, knownEnemies, visibleEnemies, avgTeamY,
      remTurns, stance: 'ADVANCE', hpDiff: 0, pushFactor: 0, staleLayers: 0, isMidLateBlind: false, searchTargets: []
    };
    if (!isAdvanced) return ctx;

    const survivingEstimates = Object.values(memory.redKnowledge).filter(entry => entry.alive);
    const estEnemyHp = survivingEstimates.reduce((total, entry) => total + entry.knownHp, 0);
    ctx.hpDiff = myHp - estEnemyHp;
    ctx.pushFactor = Math.min(1, turn / 36);
    if (turn >= 14 && turnsSinceDamage >= 10) {
      ctx.staleLayers = Math.min(5, 1 + Math.floor((turnsSinceDamage - 10) / 2));
    }

    const flagThreat = myFlag ? estimateImmediateThreatOn(myFlag, myFlag.x, myFlag.y, knownEnemies, board) : null;
    const enemyFlag = visibleEnemies.find(unit => unit.type === 'flag');
    const enemyFlagThreatened = enemyFlag && (enemyFlag.hp <= 6 || myUnits.some(unit =>
      manhattan(unit.x, unit.y, enemyFlag.x, enemyFlag.y) <= UNIT_DEFS[unit.type].mp + 2));
    const recentGhost = knownEnemies.some(unit => !unit.isVisible && unit.age <= 3);

    if ((myFlag && (myFlag.hp <= 5 || flagThreat.maxDmg >= myFlag.hp - 1))
        || (remTurns <= 10 && ctx.hpDiff > 0)) {
      ctx.stance = 'DEFEND';
    } else if ((remTurns <= 16 && ctx.hpDiff < 0) || enemyFlagThreatened || ctx.hpDiff >= 11 || ctx.staleLayers >= 3) {
      ctx.stance = 'ASSAULT';
    } else if (ctx.hpDiff <= -14) {
      ctx.stance = 'DEFEND';
    } else if (!visibleEnemies.length && !recentGhost) {
      ctx.stance = 'SCOUT';
    }

    ctx.isMidLateBlind = !visibleEnemies.length && (turn > 20 || survivingEstimates.length < 8 || estEnemyHp < 72);
    if (ctx.isMidLateBlind) {
      const lastFlag = survivingEstimates.find(entry => entry.type === 'flag' && entry.lastX !== null);
      const staleTiles = [];
      for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
          const terrain = board.map[y][x].terrain;
          const age = turn - memory.redTileLastSeen[y][x];
          const terrainValue = terrain === 'forest' ? 6 : (terrain === 'hill' ? 4 : 0);
          staleTiles.push({ x, y, score: age + terrainValue });
        }
      }
      if (lastFlag) {
        const nearby = staleTiles.filter(tile => manhattan(tile.x, tile.y, lastFlag.lastX, lastFlag.lastY) <= 2)
          .sort((a, b) => b.score - a.score)[0];
        ctx.searchTargets.push({ x: nearby.x, y: nearby.y, weight: 3.6 });
      }
      staleTiles.sort((a, b) => b.score - a.score);
      for (const tile of staleTiles) {
        if (ctx.searchTargets.length >= 6) break;
        if (ctx.searchTargets.every(target => manhattan(target.x, target.y, tile.x, tile.y) >= 3)) {
          ctx.searchTargets.push({ x: tile.x, y: tile.y, weight: 1.5 });
        }
      }
    }
    return ctx;
  }

  /**
   * 評估單一候選動作的 1-Ply 戰術效用分數
   */
  function scoreCandidateAction(action, ctx) {
    if (action.type === 'skip') {
      if (ctx.stance === 'DEFEND' && ctx.remTurns <= 10 && ctx.hpDiff > 0) {
        return 4;
      }
      return -22 - ctx.staleLayers * 4;
    }

    const { board, memory, turn, flankBias } = ctx;
    const u = getUnitById(action.unitId, board);
    const origX = u.x;
    const origY = u.y;
    const tx = action.type === 'stand_attack' ? origX : action.tx;
    const ty = action.type === 'stand_attack' ? origY : action.ty;
    const disp = action.type === 'stand_attack' ? 0 : action.disp;

    let score = 0;

    // 姿態權重係數
    const atkMult = ctx.stance === 'ASSAULT' ? 1.38 : (ctx.stance === 'DEFEND' ? 0.82 : 1.0);
    const defMult = (ctx.stance === 'DEFEND' ? 1.45 : (ctx.stance === 'ASSAULT' ? 0.72 : 1.0)) * Math.max(0.45, 1 - ctx.staleLayers * 0.11);
    const scoutMult = ctx.stance === 'SCOUT' ? 1.65 : (ctx.isMidLateBlind ? 1.55 : 0.85);
    const aggroStaleBonus = ctx.staleLayers * 2.4;

    // 暫時移動以計算落點局面與戰鬥
    u.x = tx;
    u.y = ty;

    try {
      // 1. 戰鬥與斬殺收益
      if (action.targetId) {
        const target = getUnitById(action.targetId, board);
        const c = previewCombat(u, target, disp, board);
        const targetDef = UNIT_DEFS[target.type];

        if (!c.defenderSurvives) {
          if (target.type === 'flag') {
            return 100000; // 斬首藍方旗手必走
          }
          score += (targetDef.aiValue * 1.15 + 24) * atkMult;
        } else {
          const flagFocus = target.type === 'flag' ? 2.15 : 1.0;
          score += c.damage * (7.8 + aggroStaleBonus * 0.5) * atkMult * flagFocus;
          // 9 HP 旗手壓進低血斬殺線額外獎勵
          if (target.type === 'flag' && (target.hp - c.damage) <= 4) {
            score += 24 * atkMult;
          }
        }

        // 輕騎衝鋒破盾衝散額外嘉獎（打穿重盾且無反擊）
        if (c.isShattered) {
          score += 14 * atkMult;
        }

        // 反擊代價
        if (c.canCounter) {
          if (!c.attackerSurvives) {
            if (u.type === 'flag') return -90000; // 禁止旗手自殺
            score -= (UNIT_DEFS[u.type].aiValue * 0.95) * defMult;
          } else {
            const flagSelfPenalty = u.type === 'flag' ? 2.4 : 1.0;
            score -= c.counterDamage * 6.4 * defMult * flagSelfPenalty;
          }
        } else {
          // 白嫖無反擊傷害獎勵
          score += 5.5;
        }
      }

      // 2. 開圖收益（嚴格根據紅方視野計算）
      if (action.newTilesRevealed > 0) {
        score += (action.newTilesRevealed * 2.4 + action.forestScanBonus * 2.2) * scoutMult;
      }

      // 3. 防 A-B 雙格踱步折返懲罰（無攻擊且未揭露新迷霧卻走回近 3 步落點）
      if (memory && !action.targetId && action.newTilesRevealed === 0) {
        const hist = memory.recentPositions[u.id] || [];
        const prevIdx = hist.findIndex(p => p.x === tx && p.y === ty);
        if (prevIdx !== -1) {
          // 剛離開不久的格子扣分最重
          const recencyWeight = prevIdx === hist.length - 1 ? 1.3 : 1.0;
          score -= (26 + ctx.staleLayers * 4) * recencyWeight;
        }
      }

      // 4. 地形價值（高地 / 樹林）
      const destCell = board.map[ty][tx];
      const origCell = board.map[origY][origX];
      if (destCell.terrain === 'hill') {
        const hillVal = u.type === 'archer' ? 21 : (u.type === 'cavalry' ? 8 : 11);
        score += hillVal;
      } else if (origCell.terrain === 'hill' && u.type === 'archer' && !action.targetId) {
        score -= 10;
      }

      if (destCell.terrain === 'forest') {
        if (u.type === 'cavalry') {
          score += (u.hp <= 4 ? 4 : -5.5); // 滿血輕騎盡量不在林內失去衝鋒
        } else if (u.type === 'flag') {
          score += (ctx.stance === 'DEFEND' ? 12 : 4);
        } else {
          score += 4.5 * defMult;
        }
      }

      if (memory && ctx.remTurns <= 10) {
        const hillDelta = Number(destCell.terrain === 'hill') - Number(origCell.terrain === 'hill');
        score += hillDelta * (Math.abs(ctx.hpDiff) <= 2 ? 18 : 10);
      }

      // 5. 布陣與光環協同
      const adjAllies = countAdjacentUnits(tx, ty, 'red', board, u.id);
      const supportCap = Math.min(2, adjAllies);
      if (u.type === 'shield' || u.type === 'spear' || u.type === 'flag') {
        score += supportCap * 4.2 * defMult;
      } else {
        score += supportCap * 1.8;
      }

      if (u.type === 'flag') {
        let covered = 0;
        for (const ally of ctx.myUnits) {
          if (ally.id !== u.id && manhattan(tx, ty, ally.x, ally.y) <= 2) covered++;
        }
        score += covered * 3.8;
        // 旗手不該衝在最前線
        if (ty > ctx.avgTeamY + 1 && ctx.stance !== 'ASSAULT') {
          score -= (ty - ctx.avgTeamY) * 6.5;
        }
      } else if (hasFlagAura(u, board)) {
        score += 4.8;
      }

      // 夾擊加分（與友軍合力夾擊可見藍軍）
      for (const e of ctx.visibleEnemies) {
        if (manhattan(tx, ty, e.x, e.y) === 1) {
          const redAdj = countAdjacentUnits(e.x, e.y, 'red', board);
          if (redAdj >= 2) {
            score += (9 + aggroStaleBonus) * atkMult;
          }
        }
      }

      // 6. 兵種專屬站位邏輯
      if (u.type === 'archer') {
        // 弓手嚴格防貼身
        for (const e of ctx.knownEnemies) {
          const d = manhattan(tx, ty, e.x, e.y);
          if (d <= 2) score -= (22 - d * 5) * e.confidence;
        }
        // 站定後若有敵人在射程內加分
        const maxR = destCell.elev === 1 ? 4 : 3;
        const inRangeCount = ctx.visibleEnemies.filter(e => {
          const d = manhattan(tx, ty, e.x, e.y);
          return d >= 2 && d <= maxR;
        }).length;
        if (!action.targetId && inRangeCount > 0) score += 7;
      }

      if (u.type === 'shield') {
        // 重盾優先卡住中路要道或護衛旗手/弓手前方
        const myFlag = ctx.myFlag;
        if (myFlag && ty === myFlag.y + 1 && Math.abs(tx - myFlag.x) <= 2) {
          score += 6 * defMult;
        }
        // ZoC 鎖定可見敵軍（特別是輕騎與旗手）
        for (const e of ctx.visibleEnemies) {
          if (manhattan(tx, ty, e.x, e.y) === 1) {
            score += (e.type === 'cavalry' || e.type === 'archer' || e.type === 'flag') ? 9 : 4.5;
          }
        }
      }

      if (u.type === 'spear') {
        // 長矛站重盾背後一格架設反騎陣線
        const shieldAhead = ctx.myUnits.some(a => a.type === 'shield' && a.x === tx && a.y === ty + 1);
        if (shieldAhead) score += 5.5;
        // 面向可見藍方輕騎拉近保護距離
        for (const e of ctx.visibleEnemies) {
          if (e.type === 'cavalry') {
            const d = manhattan(tx, ty, e.x, e.y);
            if (d <= 2) score += 6.5;
          }
        }
      }

      if (u.type === 'cavalry') {
        // 輕騎偏愛保留衝鋒破盾角度，避免無意義深陷重盾＋長矛包圍
        if (action.targetId && disp >= 3 && destCell.terrain !== 'forest') {
          score += 5;
        }
        // 開局多樣化翼側傾向
        if (turn <= 8) {
          const flankX = flankBias < 0 ? 1 : 8;
          score += Math.max(0, 4 - Math.abs(tx - flankX)) * 0.9;
        }
      }

      // 7. 戰線推進引力與殘局迷霧抓旗手搜捕引力
      if (ctx.isMidLateBlind && ctx.searchTargets.length > 0) {
        // 依單位編號分流不同搜捕點，讓紅軍分兵掃圖抓藍旗手
        const unitIdx = Number(u.id.slice(1)) || 1;
        const primaryTarget = ctx.searchTargets[(unitIdx - 1) % ctx.searchTargets.length];
        const flagGhostTarget = ctx.searchTargets[0];
        const targetPt = (u.type === 'cavalry' || unitIdx % 2 === 1) ? flagGhostTarget : primaryTarget;

        const oldDist = manhattan(origX, origY, targetPt.x, targetPt.y);
        const newDist = manhattan(tx, ty, targetPt.x, targetPt.y);
        score += (oldDist - newDist) * (4.2 + ctx.staleLayers * 1.1) * targetPt.weight;
      } else if (ctx.visibleEnemies.length > 0) {
        // 鎖定最靠近或最具價值的可見敵人推進
        let bestTarget = ctx.visibleEnemies[0];
        let bestW = -Infinity;
        for (const e of ctx.visibleEnemies) {
          const w = (e.type === 'flag' ? 28 : UNIT_DEFS[e.type].aiValue * 0.2) - manhattan(tx, ty, e.x, e.y) * 2.2;
          if (w > bestW) {
            bestW = w;
            bestTarget = e;
          }
        }
        const oldDist = manhattan(origX, origY, bestTarget.x, bestTarget.y);
        const newDist = manhattan(tx, ty, bestTarget.x, bestTarget.y);
        if (u.type !== 'archer' && u.type !== 'flag') {
          score += (oldDist - newDist) * (2.6 + ctx.pushFactor * 2.0 + aggroStaleBonus * 0.5) * atkMult;
        }
      } else {
        // 開局無敵人：朝中央高地與對稱高地前哨推進，並防慢速主力掉隊
        const goalX = u.type === 'cavalry' ? (origX < 5 ? 1 : 8) : (origX < 5 ? 4 : 5);
        const goalY = u.type === 'archer' ? 4 : (u.type === 'flag' ? 3 : 5);
        const oldDist = manhattan(origX, origY, goalX, goalY);
        const newDist = manhattan(tx, ty, goalX, goalY);
        score += (oldDist - newDist) * (3.0 + ctx.pushFactor * 2.4);
      }

      // 8. 防輕騎獨走：落後隊伍平均戰線的慢速單位獲得推進加權；剛動過且非交戰單位輕微衰減
      if (u.type !== 'cavalry' && ty > origY && origY < ctx.avgTeamY) {
        score += (ty - origY) * (2.8 + ctx.pushFactor * 2.2);
      }
      if (memory && !action.targetId && u.id === memory.lastMovedUnitId) {
        score -= 4.8 * Math.min(3, memory.consecutiveMoves);
      }

      // 9. 即時暴露威脅與紅旗安全紅線
      const threat = estimateImmediateThreatOn(u, tx, ty, ctx.knownEnemies, board);
      if (u.type === 'flag') {
        if (threat.maxDmg >= u.hp) {
          score -= 350; // 旗手落入已知斬殺線極重扣分
        } else {
          score -= threat.maxDmg * 18 * defMult + threat.totalThreat * 7;
        }
        // 若原本旗手處於高危，成功脫離危險區給高額獎勵
        const origThreat = estimateImmediateThreatOn(u, origX, origY, ctx.knownEnemies, board);
        if (origThreat.maxDmg >= u.hp - 2 && threat.maxDmg < origThreat.maxDmg) {
          score += (origThreat.maxDmg - threat.maxDmg) * 26;
        }
      } else {
        const threatWeight = ctx.stance === 'ASSAULT' ? 2.4 : 4.2 * defMult;
        score -= threat.maxDmg * threatWeight;
        if (threat.maxDmg >= u.hp) {
          score -= UNIT_DEFS[u.type].aiValue * 0.48 * defMult;
        }
      }

      // 10. 進階 AI 專屬：未偵察前線樹林與高地崖邊的伏擊風險評估
      if (ctx.isAdvanced && !action.targetId && u.type !== 'shield') {
        let blindAmbushRisk = 0;
        for (const d of DIRS) {
          const nx = tx + d.dx;
          const ny = ty + d.dy;
          if (!inBounds(nx, ny)) continue;
          const nCell = board.map[ny][nx];
          const unseenForest = nCell.terrain === 'forest' && !ctx.redVision.forestReveal[ny][nx];
          const unseenHill = nCell.terrain === 'hill' && !ctx.redVision.tileVisible[ny][nx];
          if ((unseenForest || unseenHill) && ny >= 3) {
            blindAmbushRisk += (u.type === 'flag' || u.type === 'archer') ? 6.5 : 2.6;
          }
        }
        score -= blindAmbushRisk * Math.max(0.35, 1 - ctx.staleLayers * 0.14);
      }

      // 進階殘局保旗意識：當旗手處於威脅區而本動作並非移動旗手，若能擊殺或卡住威脅者給予加權
      if (ctx.isAdvanced && ctx.myFlag && u.id !== ctx.myFlag.id && action.targetId) {
        const tUnit = getUnitById(action.targetId, board);
        if (tUnit && manhattan(tUnit.x, tUnit.y, ctx.myFlag.x, ctx.myFlag.y) <= 4) {
          score += 18;
        }
      }
    } finally {
      u.x = origX;
      u.y = origY;
    }

    return score;
  }

  /**
   * 進階 AI 專屬：Top 12 兩層反擊前瞻（2-Ply Threat Lookahead）
   * 嚴格只模擬「已知藍軍（可見＋近期殘影）」下回合能打出的最痛反擊
   */
  function evaluateTwoPlyEnemyBestReply(action, ctx) {
    // 前瞻使用可見盤面的副本，殘影只作為低可信的假設。
    const board = { map: ctx.board.map, units: ctx.board.units.map(unit => ({ ...unit })) };
    if (action.type !== 'skip') {
      const actor = getUnitById(action.unitId, board);
      if (action.type !== 'stand_attack') {
        actor.x = action.tx;
        actor.y = action.ty;
      }
      if (action.targetId) {
        const target = getUnitById(action.targetId, board);
        const combat = previewCombat(actor, target, action.disp || 0, board);
        target.hp = Math.max(0, target.hp - combat.damage);
        target.alive = target.hp > 0;
        actor.hp = Math.max(0, actor.hp - combat.counterDamage);
        actor.alive = actor.hp > 0;
        if (!getAliveFlag('red', board)) return 90000;
        if (target.type === 'flag' && !target.alive) return 0;
      }
    }

    for (const enemy of ctx.knownEnemies) {
      if (!enemy.isVisible && !getUnitAt(enemy.x, enemy.y, board)) board.units.push({ ...enemy });
    }
    const redUnits = board.units.filter(unit => unit.alive && unit.faction === 'red');
    const blueUnits = board.units.filter(unit => unit.alive && unit.faction === 'blue');
    let worstReply = 0;

    for (const enemy of ctx.knownEnemies) {
      const actor = getUnitById(enemy.id, board);
      if (!actor || !actor.alive) continue;
      const startX = actor.x;
      const startY = actor.y;
      const scoreAttacks = (displacement) => {
        for (const target of redUnits) {
          if (!canUnitAttackTargetWithVision(actor, target, null, board)) continue;
          if (!blueUnits.some(observer => canDetectUnit(observer, target, board))) continue;
          const combat = previewCombat(actor, target, displacement, board);
          worstReply = Math.max(worstReply, scoreEnemyReplyCombat(actor, target, combat) * enemy.confidence);
        }
      };
      scoreAttacks(0);
      for (const { x, y } of computeReachableFor(actor, null, board).values()) {
        actor.x = x;
        actor.y = y;
        scoreAttacks(manhattan(startX, startY, x, y));
      }
      actor.x = startX;
      actor.y = startY;
    }
    return worstReply;
  }

  function canDetectUnit(observer, target, board) {
    const elev = board.map[observer.y][observer.x].elev;
    const range = board.map[target.y][target.x].terrain === 'forest'
      ? 2.05 : UNIT_DEFS[observer.type].vision + elev + 0.5;
    const dx = target.x - observer.x;
    const dy = target.y - observer.y;
    return dx * dx + dy * dy <= range * range
      && hasLineOfSight(observer.x, observer.y, target.x, target.y, elev, board);
  }

  function scoreEnemyReplyCombat(blueAttacker, redDefender, comb) {
    let threat = 0;
    if (!comb.defenderSurvives) {
      if (redDefender.type === 'flag') return 60000;
      threat += UNIT_DEFS[redDefender.type].aiValue * 1.15 + 18;
    } else {
      const flagMult = redDefender.type === 'flag' ? 2.5 : 1.0;
      threat += comb.damage * 8.0 * flagMult;
      if (redDefender.type === 'flag' && (redDefender.hp - comb.damage) <= 3) {
        threat += 35;
      }
    }
    if (comb.isShattered) threat += 10;

    // 扣除紅方反擊給藍方帶來的損失
    if (comb.canCounter) {
      if (!comb.attackerSurvives) {
        threat -= UNIT_DEFS[blueAttacker.type].aiValue * 0.75;
      } else {
        threat -= comb.counterDamage * 4.5;
      }
    }
    return Math.max(0, threat);
  }

  function generateRedAiCandidates(ctx) {
    const candidates = [];
    const { board, redVision } = ctx;

    for (const u of ctx.myUnits) {
      // A. 原地攻擊（僅限紅方視野內可見藍軍）
      const standTargets = getValidAttackTargetsFor(u, null, board);
      for (const tid of standTargets) {
        candidates.push({
          type: 'stand_attack',
          unitId: u.id,
          targetId: tid,
          newTilesRevealed: 0,
          forestScanBonus: 0
        });
      }

      // B. 移動與移動後攻擊（尋路僅參考紅方視野內可見敵人與可見 ZoC）
      const reachMap = computeReachableFor(u, null, board);
      const origX = u.x;
      const origY = u.y;

      for (const rInfo of reachMap.values()) {
        const disp = manhattan(origX, origY, rInfo.x, rInfo.y);
        const reveal = countNewlyRevealedTiles(u, rInfo.x, rInfo.y, redVision, board);

        // 純移動候選
        candidates.push({
          type: 'move',
          unitId: u.id,
          tx: rInfo.x,
          ty: rInfo.y,
          path: rInfo.path,
          cost: rInfo.cost,
          disp,
          newTilesRevealed: reveal.newly,
          forestScanBonus: reveal.forestScanBonus,
          targetId: null
        });

        // 移動後攻擊可見敵人候選
        u.x = rInfo.x;
        u.y = rInfo.y;
        const postTargets = getValidAttackTargetsFor(u, null, board);
        for (const tid of postTargets) {
          candidates.push({
            type: 'move_attack',
            unitId: u.id,
            tx: rInfo.x,
            ty: rInfo.y,
            path: rInfo.path,
            cost: rInfo.cost,
            disp,
            newTilesRevealed: reveal.newly,
            forestScanBonus: reveal.forestScanBonus,
            targetId: tid
          });
        }
      }

      u.x = origX;
      u.y = origY;
    }

    candidates.push({ type: 'skip', unitId: null, targetId: null, newTilesRevealed: 0, forestScanBonus: 0 });
    return candidates;
  }

  function chooseRedAiAction(observation, random = Math.random) {
    const ctx = buildAiStrategicContext(observation);
    return chooseAiCandidate(generateRedAiCandidates(ctx), ctx, random);
  }

  function chooseAiCandidate(candidates, ctx, random) {
    const scored = candidates.map(action => ({
      action, score: scoreCandidateAction(action, ctx) + random() * (ctx.isAdvanced ? 0.35 : 0.9)
    }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score >= 50000) return scored[0].action;

    if (!ctx.isAdvanced) {
      const pool = scored.slice(0, 4).filter(item => item.score > -80000);
      if (!pool.length) return scored[0].action;
      const weights = [0.52, 0.25, 0.15, 0.08].slice(0, pool.length);
      let sample = random() * weights.reduce((total, weight) => total + weight, 0);
      for (const [index, item] of pool.entries()) {
        sample -= weights[index];
        if (sample <= 0) return item.action;
      }
      return pool[pool.length - 1].action;
    }

    let bestAction = scored[0].action;
    let bestScore = -Infinity;
    const replyWeight = ctx.stance === 'ASSAULT' ? 0.68 : (ctx.stance === 'DEFEND' ? 1.02 : 0.86);
    for (const item of scored.slice(0, 12)) {
      const score = item.score - evaluateTwoPlyEnemyBestReply(item.action, ctx) * replyWeight;
      if (score > bestScore) {
        bestScore = score;
        bestAction = item.action;
      }
    }
    return bestAction;
  }

  function chooseNewlySeenAttack(observation, unitId, displacement, initiallyVisible, reconsider, random = Math.random) {
    const ctx = buildAiStrategicContext(observation);
    const unit = getUnitById(unitId, ctx.board);
    const targetIds = [...getValidAttackTargetsFor(unit, null, ctx.board)]
      .filter(id => reconsider || !initiallyVisible.has(id));
    if (!targetIds.length) return null;

    const hold = {
      type: 'move', unitId, tx: unit.x, ty: unit.y, disp: displacement,
      targetId: null, newTilesRevealed: 0, forestScanBonus: 0
    };
    const options = [hold, ...targetIds.map(targetId => ({ ...hold, type: 'move_attack', targetId }))];
    return chooseAiCandidate(options, ctx, random).targetId;
  }
  function wargodSearchPacket(observation, seed) {
    const ctx = buildAiStrategicContext(observation);
    const actions = generateRedAiCandidates(ctx);
    const { board } = observation;
    const geometry = advancedGeometryFor(board.map);
    const scanned = new Uint32Array(VISION_WORDS);
    const knownPositions = new Int16Array(BLUE_SLOTS * 2).fill(-1);
    const estimatedHp = new Int16Array(knownPositions.length);
    const slotOf = id => id ? Number(id.slice(1)) - 1 + (id[0] === 'R' ? BLUE_SLOTS : 0) : -1;

    for (const entry of Object.values(observation.memory.redKnowledge)) {
      if (entry.alive) estimatedHp[slotOf(entry.id)] = entry.knownHp;
    }
    for (const unit of board.units) {
      const slot = slotOf(unit.id);
      knownPositions[slot] = cellIndex(unit.x, unit.y);
      estimatedHp[slot] = unit.hp;
    }
    for (let cell = 0; cell < CELL_COUNT; cell++) {
      if (isTileScanned(cell % BOARD_SIZE, Math.floor(cell / BOARD_SIZE), observation.redVision, board.map)) {
        scanned[cell >>> 5] |= 1 << (cell & 31);
      }
    }

    const particles = observation.particles;
    const marginals = particleMarginals(particles, knownPositions, estimatedHp);

    // 1. 從聯合粒子濾波器建構 12～20 個分層世界（若敵全可見則僅 1 個精確世界！）
    let hiddenCount = 0;
    for (let s = 0; s < BLUE_SLOTS; s++) if (knownPositions[s] < 0 && estimatedHp[s] > 0) hiddenCount++;

    const buildWorlds = () => {
      if (hiddenCount === 0) {
        return [{ position: Int16Array.from(knownPositions), hp: Int16Array.from(estimatedHp), weight: 1, worldIdx: 0 }];
      }
      const targetWorlds = hiddenCount <= 2 ? 12 : 20;
      const posteriorCount = Math.max(1, Math.round(targetWorlds * 0.7));
      const worldMap = new Map();
      const addWorld = (pos, w) => {
        const key = pos.join(',');
        const existing = worldMap.get(key);
        if (existing) existing.weight += w;
        else worldMap.set(key, { position: Int16Array.from(pos), hp: Int16Array.from(estimatedHp), weight: w, worldIdx: worldMap.size });
      };

      // A. 70% 後驗代表粒子（系統抽樣保留聯合相關性）
      if (particles && particles.length) {
        const step = 1 / posteriorCount;
        let ptr = ((seed & 0xffff) / 65536) * step;
        let cum = particles[0].weight;
        let idx = 0;
        for (let i = 0; i < posteriorCount; i++) {
          const target = ptr + i * step;
          while (target > cum && idx < particles.length - 1) cum += particles[++idx].weight;
          const pos = Int16Array.from(knownPositions);
          for (let s = 0; s < BLUE_SLOTS; s++) if (pos[s] < 0 && estimatedHp[s] > 0) pos[s] = particles[idx].pos[s];
          addWorld(pos, 1);
        }
      }

      // B. 30% 對抗伏擊世界（偏向把隱身敵軍放在鄰近前線的林／高地威脅格）
      const advCount = targetWorlds - posteriorCount;
      const danger = new Float32Array(CELL_COUNT);
      for (let cell = 0; cell < CELL_COUNT; cell++) {
        let nearest = CELL_COUNT;
        for (let s = BLUE_SLOTS; s < BLUE_SLOTS * 2; s++) {
          if (knownPositions[s] >= 0) nearest = Math.min(nearest, geometry.distance[cell * CELL_COUNT + knownPositions[s]]);
        }
        danger[cell] = 1 + Math.max(0, 6 - nearest) * 0.95
          + (geometry.terrain[cell] === 2 ? 1.8 : (geometry.terrain[cell] === 1 ? 0.9 : 0));
      }
      const free = [];
      const baseUsed = new Uint8Array(CELL_COUNT);
      for (let s = 0; s < BLUE_SLOTS * 2; s++) if (knownPositions[s] >= 0) baseUsed[knownPositions[s]] = 1;
      for (let c = 0; c < CELL_COUNT; c++) {
        if (!baseUsed[c] && (scanned[c >>> 5] & (1 << (c & 31))) === 0) free.push(c);
      }
      let localRng = (seed ^ 0x517cc1b7) >>> 0 || 1;
      const nextR = () => {
        localRng ^= localRng << 13; localRng ^= localRng >>> 17; localRng ^= localRng << 5;
        return (localRng >>> 0) / 4294967296;
      };
      for (let i = 0; i < advCount; i++) {
        const pos = Int16Array.from(knownPositions);
        const used = Uint8Array.from(baseUsed);
        for (let s = 0; s < BLUE_SLOTS; s++) {
          if (pos[s] >= 0 || estimatedHp[s] <= 0) continue;
          const row = marginals[s];
          let sum = 0;
          for (const c of free) if (!used[c] && row[c] > 0) sum += row[c] * danger[c];
          let chosen = -1;
          if (sum > 0) {
            let pick = nextR() * sum;
            for (const c of free) {
              if (used[c] || row[c] <= 0) continue;
              chosen = c;
              pick -= row[c] * danger[c];
              if (pick <= 0) break;
            }
          } else {
            const avail = free.filter(c => !used[c]);
            if (avail.length) chosen = avail[Math.floor(nextR() * avail.length)];
          }
          pos[s] = chosen;
          if (chosen >= 0) used[chosen] = 1;
        }
        addWorld(pos, 1);
      }
      return [...worldMap.values()];
    };

    const worlds = buildWorlds();

    // 2. 資訊價值（VOI）格位權重：只重視對我方關鍵單位有威脅／有價值的未偵察格
    const infoWeight = new Float32Array(CELL_COUNT);
    const roleInfo = { flag: 4.5, archer: 2.4, cavalry: 2.2, spear: 1.6, shield: 1.6 };
    let fogTension = 0;
    for (let slot = 0; slot < BLUE_SLOTS; slot++) {
      if (knownPositions[slot] >= 0 || estimatedHp[slot] <= 0) continue;
      const rw = roleInfo[INITIAL_BLUE_UNITS[slot].type] || 1.2;
      const row = marginals[slot];
      for (let c = 0; c < CELL_COUNT; c++) {
        if (row[c] <= 0) continue;
        let nearest = CELL_COUNT;
        for (let s = BLUE_SLOTS; s < BLUE_SLOTS * 2; s++) {
          if (knownPositions[s] >= 0) nearest = Math.min(nearest, geometry.distance[c * CELL_COUNT + knownPositions[s]]);
        }
        const prox = nearest <= 5 ? 1.5 : 0.6;
        infoWeight[c] += row[c] * rw * prox;
        if (nearest <= 4) fogTension += row[c] * rw;
      }
    }

    // 3. 計算局面複雜度與克制 skip 的動態微節奏門檻
    const myUnits = ctx.myUnits;
    const myFlag = ctx.myFlag;
    let myHp = 0, myHills = 0, estEnemyHp = 0, visibleEnemyHills = 0;
    for (const u of myUnits) {
      myHp += u.hp;
      if (board.map[u.y][u.x].terrain === 'hill') myHills++;
    }
    for (const entry of Object.values(observation.memory.redKnowledge)) {
      if (entry.alive) estEnemyHp += entry.knownHp;
    }
    for (const e of ctx.visibleEnemies) {
      if (board.map[e.y][e.x].terrain === 'hill') visibleEnemyHills++;
    }
    const living = estimatedHp.reduce((t, h) => t + Number(h > 0), 0);
    const estHpDiff = myHp - estEnemyHp;
    const hillDiff = myHills - visibleEnemyHills;

    let minEnemyDist = 99;
    let tacticalTension = 0;
    let flagDanger = false;
    for (const e of ctx.visibleEnemies) {
      const eDef = UNIT_DEFS[e.type];
      const eReach = eDef.mp + (e.type === 'archer' ? 4 : (e.type === 'spear' ? 2 : 1));
      if (myFlag && manhattan(myFlag.x, myFlag.y, e.x, e.y) <= eReach + 1) flagDanger = true;
      for (const u of myUnits) {
        const d = manhattan(u.x, u.y, e.x, e.y);
        if (d < minEnemyDist) minEnemyDist = d;
        if (d <= eReach + 1) tacticalTension++;
      }
      if (e.type === 'flag' && (e.hp <= 6 || myUnits.some(u => manhattan(u.x, u.y, e.x, e.y) <= UNIT_DEFS[u.type].mp + 2))) {
        flagDanger = true;
      }
    }
    if (myFlag && myFlag.hp <= 5) flagDanger = true;

    // 克制 skip 門檻（以整數刻度 1pt = 4 表示）：開中盤／落後防消極，殘局守陣／鎖勝幾乎無罰分
    let skipTempoPts = -1.2;
    const remTurns = MAX_TURNS - observation.turn;
    if (remTurns <= 20 && (estHpDiff > 0 || (estHpDiff === 0 && hillDiff > 0))) {
      skipTempoPts = 0;
    } else if (remTurns <= 24 && (estHpDiff < 0 || (estHpDiff === 0 && hillDiff < 0))) {
      skipTempoPts = -12;
    } else if (observation.turn < 22 && minEnemyDist > 4 && !flagDanger) {
      skipTempoPts = -10;
    } else if (myUnits.length >= 5 && minEnemyDist > 5 && !flagDanger) {
      skipTempoPts = -8;
    }

    // 4. 根節點初篩候選（無 1-ply bias 扭曲深搜，改用乾淨的 VOI 與安全決勝鍵）
    const roots = actions.map((action, index) => {
      const unit = slotOf(action.unitId);
      const target = slotOf(action.targetId);
      const path = action.path ? action.path.map(({ x, y }) => cellIndex(x, y)) : [];
      const utility = scoreCandidateAction(action, ctx);
      let voi = 0;
      let order = utility;
      let safetyTie = 0;
      if (action.type === 'skip') {
        // 保證 skip 一定能進入初篩池，由深搜與 skipTempoPts 決定是否採用
        order = 9000;
        safetyTie = 10;
      } else {
        if (path.length) {
          const dest = path[path.length - 1];
          const typeIdx = TYPE_NAMES.indexOf(INITIAL_BLUE_UNITS[unit % BLUE_SLOTS].type);
          const offset = (typeIdx * CELL_COUNT + dest) * VISION_WORDS;
          for (let c = 0; c < CELL_COUNT; c++) {
            const w = c >>> 5;
            if ((geometry.scans[offset + w] & ~scanned[w] & (1 << (c & 31))) !== 0) {
              voi += infoWeight[c];
            }
          }
          if (geometry.terrain[dest] === 1) { order += 26; safetyTie += 3; }
          if (geometry.terrain[dest] === 2) safetyTie += 2;
        }
        if (target >= 0) {
          const attacker = getUnitById(action.unitId, board);
          const defender = getUnitById(action.targetId, board);
          const from = { x: attacker.x, y: attacker.y };
          if (path.length) { attacker.x = action.tx; attacker.y = action.ty; }
          try {
            const preview = previewCombat(attacker, defender, action.disp || 0, board);
            if (!preview.defenderSurvives) order += defender.type === 'flag' ? 50000 : 1400;
            else if (preview.isShattered) order += 950;
            else if (preview.defRes.isFlanked) order += 650;
            else order += 90;
            safetyTie -= preview.counterDamage;
          } finally {
            Object.assign(attacker, from);
          }
        }
        if (myFlag && action.unitId === myFlag.id && path.length && flagDanger) {
          order += Math.max(0, utility) * 0.9 + 60;
        }
        voi = Math.min(14, voi * 8.5);
        order += voi * 14;
      }
      return {
        index, unit, target, path, order,
        voi: Math.round(voi * 4),
        tempo: action.type === 'skip' ? Math.round(skipTempoPts * 4) : 0,
        safetyTie
      };
    });

    const slotTypes = Int8Array.from({ length: knownPositions.length }, (_, slot) =>
      TYPE_NAMES.indexOf(INITIAL_BLUE_UNITS[slot % BLUE_SLOTS].type));
    const definitions = TYPE_NAMES.map(name => {
      const { maxHp, mp, baseAtk, baseDef, aiValue } = UNIT_DEFS[name];
      return { maxHp, mp, baseAtk, baseDef, aiValue };
    });

    // 5. 動態時間配置 [softBudget, hardBudget, maxDepth]
    const isLowPiece = living <= 8 || remTurns <= 20;
    let softBudget = 6500;
    let hardBudget = 11500;
    let minEarlyMs = 2200;
    if (!flagDanger && tacticalTension === 0 && fogTension < 1.2 && !isLowPiece) {
      softBudget = 2800;
      hardBudget = 5500;
      minEarlyMs = 1200;
    } else if (flagDanger || isLowPiece || tacticalTension >= 5 || fogTension >= 3.2) {
      softBudget = 14000;
      hardBudget = 20500;
      minEarlyMs = 3000;
    }
    const maxDepth = living <= 5 ? 12 : (living <= 8 || remTurns <= 18 ? 10 : 8);

    const checkGuaranteedFlagCapture = (root) => {
      const enemyFlagSlot = slotTypes.indexOf(0);
      if (root.target !== enemyFlagSlot) return false;
      if (!knownPositions.every((c, s) => c >= 0 || estimatedHp[s] === 0)) {
        for (const c of [...root.path, knownPositions[root.target]]) {
          if ((scanned[c >>> 5] & (1 << (c & 31))) === 0) return false;
          for (let e = c * 4; e < c * 4 + 4; e++) {
            const nxt = geometry.neighbors[e];
            if (nxt >= 0 && (scanned[nxt >>> 5] & (1 << (nxt & 31))) === 0) return false;
          }
        }
      }
      return true;
    };

    return {
      actions,
      roots,
      worlds,
      living,
      flagDanger,
      isLowPiece,
      softBudget,
      hardBudget,
      minEarlyMs,
      maxDepth,
      checkGuaranteedFlagCapture,
      basePayload: {
        size: BOARD_SIZE, maxTurns: MAX_TURNS, blueSlots: BLUE_SLOTS, turn: observation.turn,
        slotTypes, definitions, geometry, living, seed
      }
    };
  }

  function aggregateWargodScores(roots, mergedPerRoot, worldWeights) {
    const WIN = 400000;
    const totalWeight = worldWeights.reduce((a, b) => a + b, 0) || 1;
    const cvarMass = totalWeight * 0.25;
    const ranked = [];
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      const scores = mergedPerRoot[r];
      let weightedSum = 0;
      let worst = Infinity;
      const pairs = [];
      for (let w = 0; w < scores.length; w++) {
        const s = scores[w];
        const wt = worldWeights[w];
        weightedSum += s * wt;
        if (s < worst) worst = s;
        pairs.push([s, wt]);
      }
      pairs.sort((a, b) => a[0] - b[0]);
      let rem = cvarMass;
      let tailSum = 0;
      let tailW = 0;
      for (const [s, wt] of pairs) {
        const take = Math.min(wt, rem);
        if (take <= 0) break;
        tailSum += s * take;
        tailW += take;
        rem -= take;
      }
      const mean = weightedSum / totalWeight;
      const cvar25 = tailW > 0 ? tailSum / tailW : worst;
      const baseScore = scores.length > 1 ? (mean * 0.65 + cvar25 * 0.35) : mean;
      const isForcedWin = baseScore > WIN - 600;
      const isForcedLoss = baseScore < -(WIN - 600);
      const finalScore = (isForcedWin || isForcedLoss) ? baseScore : baseScore + root.voi + root.tempo;
      ranked.push({
        root,
        score: finalScore,
        rawScore: baseScore,
        worst,
        isForcedLoss,
        forced: worst > WIN - 560
      });
    }
    ranked.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.5) return b.score - a.score;
      if (b.worst !== a.worst) return b.worst - a.worst;
      // 必敗同分時優先主動求戰製造變數，絕不消極跳過等輸
      if (a.isForcedLoss && b.isForcedLoss) {
        const aSkip = a.root.unit < 0 ? 1 : 0;
        const bSkip = b.root.unit < 0 ? 1 : 0;
        if (aSkip !== bSkip) return aSkip - bSkip;
        return b.root.order - a.root.order;
      }
      // 終局必勝或均勢同分時，不讓 skip 因 index 最大吃虧，依安全度決勝
      if (b.root.safetyTie !== a.root.safetyTie) return b.root.safetyTie - a.root.safetyTie;
      return a.root.index - b.root.index;
    });
    return ranked;
  }
  function chooseWargodNewlySeenAttack(observation, canonicalUnitId, displacement, initiallyVisible, reconsider) {
    const { board } = observation;
    const unit = getUnitById(canonicalUnitId, board);
    if (!unit) return null;
    const targetIds = [...getValidAttackTargetsFor(unit, null, board)]
      .filter(id => reconsider || !initiallyVisible.has(id));
    if (!targetIds.length) return null;

    let bestId = null;
    let bestVal = 0;
    for (const tid of targetIds) {
      const target = getUnitById(tid, board);
      if (!target) continue;
      const c = previewCombat(unit, target, displacement, board);
      if (unit.type === 'flag' && c.canCounter && !c.attackerSurvives) continue;
      let val = 0;
      if (!c.defenderSurvives) {
        if (target.type === 'flag') return tid;
        val += UNIT_DEFS[target.type].aiValue * 1.2 + 28;
      } else {
        val += c.damage * (target.type === 'flag' ? 18 : 9);
      }
      if (c.isShattered) val += 16;
      if (c.canCounter) {
        if (!c.attackerSurvives) val -= UNIT_DEFS[unit.type].aiValue * 1.15;
        else val -= c.counterDamage * (unit.type === 'flag' ? 18 : 9.5);
      } else {
        val += 6;
      }
      if (val > bestVal) {
        bestVal = val;
        bestId = tid;
      }
    }
    return bestId;
  }

      return {
        onEvent(event) {
          if (!event) return;
          if (event.type === 'vision_sync') {
            updateMemoryFromVision(memory, event.board, event.vision, event.turn);
            if (event.isMyTurn) {
              filterParticlesFor(buildCanonicalKnowledge(event.board, event.vision), event.board.map);
            }
          } else if (event.type === 'enemy_seen_action') {
            observedEnemyAction = { id: event.unitId, cell: event.cell };
          } else if (event.type === 'fog_attack_received') {
            observedFogAttack = {
              targetCell: event.targetCell,
              damage: event.damage,
              rangedOnly: event.rangedOnly,
              targetElev: event.targetElev,
              targetBaseDef: event.targetBaseDef
            };
          } else if (event.type === 'enemy_killed') {
            if (memory.redKnowledge[event.unitId]) {
              Object.assign(memory.redKnowledge[event.unitId], { alive: false, knownHp: 0 });
            }
            const slot = Number(event.unitId.slice(1)) - 1;
            if (slot >= 0 && slot < BLUE_SLOTS) {
              for (const p of particles) p.pos[slot] = -1;
            }
          } else if (event.type === 'turn_advance') {
            advanceParticlesFor(event.board, event.vision);
          } else if (event.type === 'self_action_result') {
            updateMemoryFromSelfAction(memory, event);
          }
        },

        decideTurn(obs, runtime) {
          const rngFn = runtime.rng || agentRng;
          const observation = {
            faction: obs.realFaction,
            board: obs.board,
            redVision: obs.vision,
            turn: obs.turn,
            flankBias: memory.flankBias,
            beliefs: null,
            particles,
            memory,
            turnsSinceDamage: obs.turnsSinceDamage
          };
          const seed = runtime.testOverrides && runtime.testOverrides.searchSeed !== undefined
            ? (runtime.testOverrides.searchSeed >>> 0)
            : ((rngFn() * 0xffffffff) >>> 0);
          const prep = wargodSearchPacket(observation, seed);
          const { actions, roots, worlds } = prep;
          const sortedRoots = roots.slice().sort((a, b) => b.order - a.order || a.index - b.index);
          const stage1Pool = sortedRoots.slice(0, 28);
          const skipRoot = roots.find(r => actions[r.index].type === 'skip');
          if (skipRoot && !stage1Pool.includes(skipRoot)) stage1Pool[stage1Pool.length - 1] = skipRoot;

          const pickShortlist = (ranked) => {
            const shortlist = ranked.slice(0, 10).map(item => item.root);
            if (skipRoot && !shortlist.includes(skipRoot)) {
              const skipItem = ranked.find(item => item.root === skipRoot);
              if (prep.isLowPiece || prep.flagDanger || (skipItem && ranked[0].score - skipItem.score <= 90)) {
                shortlist[shortlist.length - 1] = skipRoot;
              }
            }
            return shortlist;
          };

          if (runtime.testOverrides && runtime.testOverrides.syncExact) {
            const s1Depth = runtime.testOverrides.s1Depth || 2;
            const s2Depth = runtime.testOverrides.s2Depth || 3;
            let s1Ranked = null;
            const s1Packet = {
              ...prep.basePayload,
              worlds: worlds.slice(0, Math.min(worlds.length, 8)),
              roots: stage1Pool,
              startDepth: 1,
              endDepth: s1Depth,
              maxDepth: s1Depth
            };
            const job1 = searchWargodShard(s1Packet, (rep) => {
              s1Ranked = aggregateWargodScores(stage1Pool, rep.scores, rep.worldWeights);
            }, { budget: runtime.testOverrides.budget || 1e9 });
            let st1 = job1.next();
            while (!st1.done) st1 = job1.next();

            let bestIndex = stage1Pool[0].index;
            if (s1Ranked) {
              bestIndex = s1Ranked[0].root.index;
              const shortlist = pickShortlist(s1Ranked);
              const stage2Worlds = worlds.slice(0, Math.min(worlds.length, 16));
              const s2Packet = {
                ...prep.basePayload,
                worlds: stage2Worlds,
                roots: shortlist,
                startDepth: 2,
                reportFromDepth: s2Depth,
                endDepth: s2Depth,
                maxDepth: s2Depth,
                singleWorld: stage2Worlds.length === 1
              };
              const job2 = searchWargodShard(s2Packet, (rep) => {
                const ranked = aggregateWargodScores(shortlist, rep.scores, rep.worldWeights);
                bestIndex = ranked[0].root.index;
              }, { budget: runtime.testOverrides.budget || 1e9 });
              let st2 = job2.next();
              while (!st2.done) st2 = job2.next();
            }
            return actions[bestIndex] || chooseRedAiAction(observation, rngFn);
          }

          return new Promise((resolve) => {
            const now = runtime.now;
            const started = now();
            const searchId = ++searchSeq;
            const minTimeMs = (runtime.testOverrides && runtime.testOverrides.minTime !== undefined)
              ? runtime.testOverrides.minTime
              : config.minTime;
            const hardMaxMs = (runtime.testOverrides && runtime.testOverrides.hardMax) || config.hardMax;

            const search = {
              workers: [],
              nextTimer: null,
              deadlineTimer: null,
              bestIndex: stage1Pool[0].index,
              bestDepth: 0,
              finishing: false,
              local: false,
              settled: false,
              softBudget: (runtime.testOverrides && runtime.testOverrides.softBudget) || prep.softBudget,
              hardBudget: (runtime.testOverrides && runtime.testOverrides.hardBudget) || prep.hardBudget,
              lastBestIndex: -1,
              stableCount: 0
            };

            const releaseWorkers = () => {
              for (const w of search.workers) { try { w.terminate(); } catch {} }
              search.workers = [];
            };

            const cleanup = () => {
              if (search.nextTimer !== null) { clearTimeout(search.nextTimer); search.nextTimer = null; }
              if (search.deadlineTimer !== null) { clearTimeout(search.deadlineTimer); search.deadlineTimer = null; }
              releaseWorkers();
            };

            const onAbort = () => {
              if (search.settled) return;
              search.settled = true;
              search.finishing = true;
              cleanup();
              resolve(null);
            };
            if (runtime.signal) {
              if (runtime.signal.aborted) { onAbort(); return; }
              runtime.signal.addEventListener('abort', onAbort, { once: true });
            }

            const finish = () => {
              if (search.finishing || search.settled) return;
              search.finishing = true;
              cleanup();
              const minWait = runtime.isAiVsAi ? Math.round(minTimeMs * runtime.speedFactor) : minTimeMs;
              const delay = Math.max(0, minWait - (now() - started));
              const done = () => {
                if (search.settled) return;
                search.settled = true;
                if (runtime.signal) runtime.signal.removeEventListener('abort', onAbort);
                resolve(actions[search.bestIndex] || chooseRedAiAction(observation, rngFn));
              };
              if (delay <= 0) done();
              else search.nextTimer = setTimeout(done, delay);
            };

            const evaluateStageCompletion = (depth, ranked, isStage2) => {
              const top = ranked[0];
              const second = ranked[1];
              search.bestIndex = top.root.index;
              search.bestDepth = depth;
              runtime.reportProgress({ depth, bestAction: actions[top.root.index] });
              if (top.forced && prep.checkGuaranteedFlagCapture(top.root)) {
                finish();
                return 'stop';
              }
              if (!isStage2) return 'continue';

              const elapsed = now() - started;
              const marginPts = second ? (top.score - second.score) / 4 : 999;
              if (top.root.index === search.lastBestIndex) search.stableCount++;
              else {
                if (search.lastBestIndex !== -1 && depth >= 4) {
                  search.softBudget = Math.min(search.hardBudget, Math.max(search.softBudget, prep.flagDanger || prep.isLowPiece ? 19500 : 14500));
                }
                search.lastBestIndex = top.root.index;
                search.stableCount = 1;
              }
              if (marginPts < 12 && depth >= 4) {
                search.softBudget = Math.min(search.hardBudget, Math.max(search.softBudget, prep.flagDanger || prep.isLowPiece ? 19500 : 14000));
              }
              if (depth >= 4 && elapsed >= prep.minEarlyMs) {
                if ((search.stableCount >= 3 && marginPts >= 32) || (top.forced && elapsed >= 1500)) {
                  finish();
                  return 'stop';
                }
              }
              if (elapsed >= search.softBudget && depth >= 4) {
                finish();
                return 'stop';
              }
              return 'continue';
            };

            const runLocally = () => {
              if (search.local || search.finishing || search.settled) return;
              releaseWorkers();
              search.local = true;
              const stage1Worlds = worlds.slice(0, Math.min(worlds.length, 8));
              const remaining = Math.max(400, search.hardBudget - (now() - started) - 80);
              const stage1Budget = Math.min(2600, Math.round(remaining * 0.3));
              let stage1Ranked = null;

              const stage1Packet = {
                ...prep.basePayload,
                worlds: stage1Worlds,
                roots: stage1Pool,
                startDepth: 1,
                endDepth: 3,
                maxDepth: 3
              };
              const job1 = searchWargodShard(stage1Packet, (report) => {
                const ranked = aggregateWargodScores(stage1Pool, report.scores, report.worldWeights);
                stage1Ranked = ranked;
                evaluateStageCompletion(report.depth, ranked, false);
              }, { budget: stage1Budget, sliceMs: 8 });

              const step1 = () => {
                if (search.finishing || search.settled) return;
                try {
                  const s = job1.next();
                  if (!s.done) { search.nextTimer = setTimeout(step1, 0); return; }
                  if (!stage1Ranked) { finish(); return; }
                  const shortlist = pickShortlist(stage1Ranked);
                  const stage2Budget = Math.max(300, search.hardBudget - (now() - started) - 60);
                  const stage2Worlds = worlds.slice(0, Math.min(worlds.length, 16));
                  const stage2Packet = {
                    ...prep.basePayload,
                    worlds: stage2Worlds,
                    roots: shortlist,
                    startDepth: 2,
                    reportFromDepth: 4,
                    endDepth: prep.maxDepth,
                    maxDepth: prep.maxDepth,
                    singleWorld: stage2Worlds.length === 1
                  };
                  const job2 = searchWargodShard(stage2Packet, (report) => {
                    const ranked = aggregateWargodScores(shortlist, report.scores, report.worldWeights);
                    evaluateStageCompletion(report.depth, ranked, true);
                  }, { budget: stage2Budget, sliceMs: 8 });

                  const step2 = () => {
                    if (search.finishing || search.settled) return;
                    try {
                      const s2 = job2.next();
                      if (!s2.done) search.nextTimer = setTimeout(step2, 0);
                      else finish();
                    } catch { finish(); }
                  };
                  search.nextTimer = setTimeout(step2, 0);
                } catch { finish(); }
              };
              search.nextTimer = setTimeout(step1, 0);
            };

            search.deadlineTimer = setTimeout(finish, Math.max(0, hardMaxMs - (now() - started)));

            if (!runtime.canUseWorker) {
              runLocally();
              return;
            }

            try {
              const cores = runtime.hardwareConcurrency || 2;
              const workerCount = Math.max(1, Math.min(4, cores - 1 || 1, worlds.length));
              const workerSrc = wargodWorkerSource();

              const stage1WorldsAll = worlds.slice(0, Math.min(worlds.length, 8));
              const shardWorlds = (list) => {
                const shards = Array.from({ length: workerCount }, () => []);
                for (let i = 0; i < list.length; i++) shards[i % workerCount].push(list[i]);
                return shards.filter(s => s.length > 0);
              };

              const s1Shards = shardWorlds(stage1WorldsAll);
              const s2Shards = shardWorlds(worlds);
              let activeStage = 1;
              let activeRoots = stage1Pool;
              let activeShards = s1Shards;
              const depthReports = new Map();
              const mergedDepths = new Set();
              let stage1DoneCount = 0;
              let stage2DoneCount = 0;
              let latestStage1Ranked = null;

              const launchStage2 = () => {
                if (search.finishing || search.settled || activeStage !== 1) return;
                activeStage = 2;
                activeRoots = latestStage1Ranked ? pickShortlist(latestStage1Ranked) : stage1Pool.slice(0, 10);
                activeShards = s2Shards;
                depthReports.clear();
                mergedDepths.clear();
                const budget2 = Math.max(400, search.hardBudget - (now() - started) - 100);
                for (let i = 0; i < s2Shards.length; i++) {
                  const w = search.workers[i];
                  if (!w) continue;
                  w.postMessage({
                    id: searchId,
                    stage: 2,
                    budget: budget2,
                    packet: {
                      ...prep.basePayload,
                      seed: (prep.basePayload.seed + i * 2654435761) >>> 0,
                      worlds: s2Shards[i],
                      roots: activeRoots,
                      startDepth: 2,
                      reportFromDepth: 4,
                      endDepth: prep.maxDepth,
                      maxDepth: prep.maxDepth,
                      singleWorld: worlds.length === 1 && s2Shards.length === 1
                    }
                  });
                }
              };

              const mergeDepth = (stage, shardIdx, report) => {
                if (!report || stage !== activeStage) return;
                const d = report.depth;
                if (mergedDepths.has(d)) return;
                if (!depthReports.has(d)) depthReports.set(d, new Array(activeShards.length).fill(null));
                const bucket = depthReports.get(d);
                bucket[shardIdx] = report;
                if (bucket.some(item => item === null)) return;
                mergedDepths.add(d);

                const mergedWeights = [];
                for (const rep of bucket) mergedWeights.push(...rep.worldWeights);
                const mergedPerRoot = Array.from({ length: activeRoots.length }, (_, r) => {
                  const arr = [];
                  for (const rep of bucket) {
                    const sc = rep.scores[r];
                    for (let k = 0; k < sc.length; k++) arr.push(sc[k]);
                  }
                  return arr;
                });
                const ranked = aggregateWargodScores(activeRoots, mergedPerRoot, mergedWeights);
                if (stage === 1) latestStage1Ranked = ranked;
                evaluateStageCompletion(d, ranked, stage === 2);
              };

              const totalWorkers = Math.max(s1Shards.length, s2Shards.length);
              for (let i = 0; i < totalWorkers; i++) {
                const w = runtime.spawnBlobWorker(workerSrc);
                w.onmessage = ({ data }) => {
                  if (search.finishing || search.settled || data.id !== searchId) return;
                  if (data.kind === 'failed') { runLocally(); return; }
                  if (data.kind === 'progress') {
                    mergeDepth(data.stage, i, data.value);
                  } else if (data.kind === 'done') {
                    if (data.value) mergeDepth(data.stage, i, data.value);
                    if (data.stage === 1) {
                      stage1DoneCount++;
                      if (stage1DoneCount >= s1Shards.length) launchStage2();
                    } else if (data.stage === 2) {
                      stage2DoneCount++;
                      if (stage2DoneCount >= s2Shards.length) finish();
                    }
                  }
                };
                w.onerror = (event) => {
                  if (event && event.preventDefault) event.preventDefault();
                  runLocally();
                };
                w.onmessageerror = runLocally;
                search.workers.push(w);
              }

              const stage1Budget = Math.min(3200, Math.round(search.softBudget * 0.35));
              for (let i = 0; i < s1Shards.length; i++) {
                search.workers[i].postMessage({
                  id: searchId,
                  stage: 1,
                  budget: stage1Budget,
                  packet: {
                    ...prep.basePayload,
                    seed: (prep.basePayload.seed + i * 2654435761) >>> 0,
                    worlds: s1Shards[i],
                    roots: stage1Pool,
                    startDepth: 1,
                    endDepth: 3,
                    maxDepth: 3
                  }
                });
              }
            } catch {
              runLocally();
            }
          });
        },

        decidePostMoveAttack(postObs, ctx) {
          const observation = {
            faction: postObs.realFaction,
            board: postObs.board,
            redVision: postObs.vision,
            turn: postObs.turn,
            flankBias: memory.flankBias,
            beliefs: null,
            particles,
            memory,
            turnsSinceDamage: postObs.turnsSinceDamage
          };
          return chooseWargodNewlySeenAttack(
            observation, ctx.unitId, ctx.displacement, ctx.initiallyVisibleEnemyIds, ctx.reconsider
          );
        },

        dispose() {}
      };
    }
  };

});
