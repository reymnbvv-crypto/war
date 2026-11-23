/* =========================================================
 * 迷霧陣線 AI 演算法：將軍 · 迷霧推演（general）
 * 完全自包含單檔，遵循 TFC AI Protocol v1。
 * 保留原版單子邊際信念、4 世界抽樣、Alpha-Beta（至 Depth 3+Q1）與時間預算。
 * ========================================================= */
(function (root, factory) {
  const algo = factory();
  if (typeof module === 'object' && module.exports) module.exports = algo;
  if (root && root.TFC_AI && typeof root.TFC_AI.register === 'function') {
    root.TFC_AI.register(algo);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 這個搜尋函式也在內嵌 Worker 內執行，僅接收紅方觀測與候選。
   * 世界盤面只配置一次；遞迴時以落子／還原修改扁平陣列。
   */
  function* searchAdvancedAi(packet, emit, options = {}) {
    const {
      size, maxTurns, blueSlots, slotTypes, definitions, geometry, estimatedHp, beliefs,
      knownPositions, scanned, turn, difficulty, seed, roots
    } = packet;
    const { terrain, neighbors, costs, distance, scans } = geometry;
    const count = size * size;
    const words = Math.ceil(count / 32);
    const units = slotTypes.length;
    const flagType = 0;
    const shieldType = 1;
    const spearType = 2;
    const archerType = 3;
    const cavalryType = 4;
    const hill = 1;
    const forest = 2;
    const flag = [slotTypes.indexOf(flagType), slotTypes.lastIndexOf(flagType)];
    const marshal = difficulty === 'marshal';
    const now = options.clock || (() => typeof performance === 'object' ? performance.now() : Date.now());
    const sliceMs = options.sliceMs || Infinity;
    const startTime = now();
    const deadline = startTime + options.budget;
    let stageDeadline = deadline;
    let sliceDeadline = startTime + sliceMs;
    const timeout = {};
    const WIN = 100000;
    const INF = 1000000;
    let nodes = 0;

    let randomState = seed >>> 0 || 0x72b31d85;
    function nextRandom() {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      return randomState >>> 0;
    }
    const random = () => nextRandom() / 4294967296;
    const team = slot => Number(slot >= blueSlots);
    const hasBit = (bits, cell) => (bits[cell >>> 5] & (1 << (cell & 31))) !== 0;
    const rangeBetween = (a, b) => distance[a * count + b];
    const scanStart = (slot, cell) => (slotTypes[slot] * count + cell) * words;

    const hpScale = Math.max(...definitions.map(item => item.maxHp)) + 1;
    const locationKeys = new Uint32Array(units * count * hpScale);
    const turnKeys = new Uint32Array(maxTurns + 20);
    for (let i = 0; i < locationKeys.length; i++) locationKeys[i] = nextRandom();
    for (let i = 0; i < turnKeys.length; i++) turnKeys[i] = nextRandom();
    const pieceKey = (id, cell, hp) => locationKeys[(id * count + cell) * hpScale + hp];

    const TABLE_MASK = (1 << 16) - 1;
    const tableKeys = new Uint32Array(TABLE_MASK + 1);
    const tableDepth = new Int8Array(TABLE_MASK + 1).fill(-1);
    const tableValue = new Float32Array(TABLE_MASK + 1);
    const tableBounds = new Uint8Array(TABLE_MASK + 1);
    const tableFirst = new Int32Array(TABLE_MASK + 1).fill(-1);
    const frames = Array.from({ length: 20 }, () => ({}));
    const priorSeen = new Uint32Array(words);
    const living = estimatedHp.reduce((total, hp) => total + Number(hp > 0), 0);
    const frontierSize = (1 + Math.max(...definitions.map(type => type.mp))) ** 2;
    const frontierHead = new Int16Array(frontierSize);
    const frontierTail = new Int16Array(frontierSize);
    const queuedCells = new Int16Array(count * 5);
    const queuedNext = new Int16Array(queuedCells.length);
    const bestRoute = new Int16Array(count);
    const routeParent = new Int16Array(count);
    const destinations = new Int16Array(count);
    const route = [];
    const staticKeys = new Uint32Array(TABLE_MASK + 1);
    const staticValues = new Float32Array(TABLE_MASK + 1);
    const staticValid = new Uint8Array(TABLE_MASK + 1);

    function* checkpoint() {
      const elapsed = now();
      if (elapsed >= stageDeadline) throw timeout;
      if (elapsed >= sliceDeadline) {
        yield;
        sliceDeadline = now() + sliceMs;
        if (now() >= stageDeadline) throw timeout;
      }
    }

    function sampleWorlds(number) {
      const worlds = new Map();
      const hidden = [];
      const free = [];
      const used = new Uint8Array(count);
      for (let slot = 0; slot < units; slot++) {
        if (knownPositions[slot] >= 0) used[knownPositions[slot]] = 1;
        else if (slot < blueSlots && estimatedHp[slot] > 0) {
          let support = 0;
          for (const p of beliefs[slot]) if (p > 0) support++;
          hidden.push({ slot, support });
        }
      }
      hidden.sort((a, b) => a.support - b.support || a.slot - b.slot);
      for (let cell = 0; cell < count; cell++) if (!used[cell] && !hasBit(scanned, cell)) free.push(cell);

      const dangerous = new Float32Array(count);
      for (let cell = 0; cell < count; cell++) {
        let nearest = count;
        for (let slot = blueSlots; slot < units; slot++) {
          if (knownPositions[slot] >= 0) nearest = Math.min(nearest, rangeBetween(cell, knownPositions[slot]));
        }
        dangerous[cell] = 1 + Math.max(0, 6 - nearest) * 0.78 + Number(terrain[cell] === forest) * 1.35;
      }

      for (let i = 0; i < number; i++) {
        const position = Int16Array.from(knownPositions);
        const occupied = Uint8Array.from(used);
        const worstCase = marshal && i >= number - Math.floor(number / 4);
        for (const { slot } of hidden) {
          // 抽取各棋子的邊際機率，同一假想盤面不得疊子。
          let sum = 0;
          const row = beliefs[slot];
          for (const cell of free) {
            if (!occupied[cell]) sum += row[cell] * (worstCase ? dangerous[cell] : 1);
          }
          let cell = -1;
          if (sum > 0) {
            let needle = random() * sum;
            for (const candidate of free) {
              if (occupied[candidate] || row[candidate] === 0) continue;
              cell = candidate;
              needle -= row[candidate] * (worstCase ? dangerous[candidate] : 1);
              if (needle <= 0) break;
            }
          } else {
            // 已被同世界的棋子佔用時，從仍未證實為空的合法格補足條件分布。
            const available = free.filter(candidate => !occupied[candidate]);
            if (available.length) cell = available[Math.floor(random() * available.length)];
          }
          position[slot] = cell;
          if (cell >= 0) occupied[cell] = 1;
        }

        const key = position.join(',');
        const existing = worlds.get(key);
        if (existing) {
          existing.weight++;
          continue;
        }
        const hp = Int16Array.from(estimatedHp);
        const cells = new Int16Array(count).fill(-1);
        let hash = 0;
        for (let slot = 0; slot < units; slot++) {
          if (position[slot] < 0) {
            hp[slot] = 0;
            continue;
          }
          cells[position[slot]] = slot;
          hash ^= pieceKey(slot, position[slot], hp[slot]);
        }
        worlds.set(key, { position, hp, cells, hash, turn, weight: 1 });
      }
      return [...worlds.values()];
    }

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
      const middle = (from + to) / 2;
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
      let allies = 0;
      let rivals = 0;
      for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
        const adjacent = neighbors[edge];
        if (adjacent < 0) continue;
        const id = board.cells[adjacent];
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

    function relocate(board, id, destination) {
      const previous = board.position[id];
      if (previous === destination) return;
      if (previous >= 0) {
        board.hash ^= pieceKey(id, previous, board.hp[id]);
        board.cells[previous] = -1;
      }
      board.cells[destination] = id;
      board.position[id] = destination;
      board.hash ^= pieceKey(id, destination, board.hp[id]);
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

    function landing(board, id, path) {
      const side = team(id);
      let stop = board.position[id];
      for (let i = 1; i < path.length; i++) {
        const next = path[i];
        const occupant = board.cells[next];
        if (occupant >= 0 && team(occupant) !== side) return -stop - 2;
        if (occupant < 0) stop = next;
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
        const value = (kills ? (slotTypes[target] === flagType ? WIN : 42) : 0)
          + Math.min(damage, board.hp[target]) * 8 - counter * 9 - (dying ? 45 : 0);
        if (value > score) {
          best = target;
          score = value;
        }
      }
      return best;
    }

    function make(board, move, frame, root = false) {
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

      const stopped = move.landing ?? landing(board, id, move.path);
      const ambushed = stopped < 0;
      const end = ambushed ? -stopped - 2 : stopped;
      let target = move.target;
      if (root && !ambushed && move.path.length) scanSide(board, side, priorSeen);
      relocate(board, id, end);
      if (ambushed) return;
      const displacement = rangeBetween(start, end);

      if (root && (target < 0 || !strikeInRange(board, id, target) || !sideDetects(board, side, board.position[target]))) {
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

    function unmake(board, frame) {
      board.turn--;
      board.hash = frame.hash;
      const id = frame.actor;
      if (id < 0) return;
      const current = board.position[id];
      if (current >= 0) board.cells[current] = -1;
      board.position[id] = frame.start;
      board.cells[frame.start] = id;
      board.hp[id] = frame.actorHp;
      if (frame.target >= 0) {
        board.cells[frame.targetCell] = frame.target;
        board.position[frame.target] = frame.targetCell;
        board.hp[frame.target] = frame.targetHp;
      }
    }

    function attackPriority(board, actor, target, displacement) {
      const hit = battle(board, actor, target, displacement);
      const damage = hit & 255;
      if (damage >= board.hp[target]) return slotTypes[target] === flagType ? 20000 : 10000 + damage;
      if (slotTypes[actor] === cavalryType && displacement >= 3 && slotTypes[target] === shieldType
          && terrain[board.position[actor]] !== forest) return 8000 + damage;
      if ((neighborCounts(board, board.position[target], team(target)) >>> 4) >= 2) return 6000 + damage;
      return 700 + damage * 12 - (hit >>> 8) * 9;
    }

    function reachableCells(board, id, seen) {
      const start = board.position[id];
      const side = team(id);
      const mp = definitions[slotTypes[id]].mp;
      const stepLimit = mp + 1;
      const leaveZoC = Number(enemyZoc(board, start, side, seen));
      frontierHead.fill(-1);
      frontierTail.fill(-1);
      bestRoute.fill(32767);
      routeParent.fill(-1);
      let queued = 0;
      let found = 0;
      const enqueue = (priority, cell) => {
        const tail = frontierTail[priority];
        queuedCells[queued] = cell;
        queuedNext[queued] = -1;
        if (tail >= 0) queuedNext[tail] = queued;
        else frontierHead[priority] = queued;
        frontierTail[priority] = queued++;
      };
      enqueue(0, start);
      bestRoute[start] = 0;

      for (let priority = 0; priority < stepLimit * stepLimit; priority++) {
        const spent = Math.floor(priority / stepLimit);
        const steps = priority % stepLimit;
        for (let cursor = frontierHead[priority]; cursor >= 0; cursor = queuedNext[cursor]) {
          const cell = queuedCells[cursor];
          if (bestRoute[cell] !== priority) continue;
          if (cell !== start) {
            const occupant = board.cells[cell];
            if (occupant < 0 || team(occupant) !== side) destinations[found++] = cell;
            if (enemyZoc(board, cell, side, seen)) continue;
          }
          for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
            const next = neighbors[edge];
            if (next < 0) continue;
            const occupant = board.cells[next];
            if (occupant >= 0 && team(occupant) !== side && hasBit(seen, next)) continue;
            const price = spent + costs[edge] + (cell === start ? leaveZoC : 0);
            const rank = price * stepLimit + steps + 1;
            if (price <= mp && rank < bestRoute[next]) {
              bestRoute[next] = rank;
              routeParent[next] = cell;
              enqueue(rank, next);
            }
          }
        }
      }
      return found;
    }

    const moveKey = move => ((move.unit + 1) * (count + 1) + move.destination + 1) * (units + 1) + move.target + 1;

    function movesFor(board, side, onlyAttacks, limit, firstChoice = -1) {
      const moves = [];
      const seen = new Uint32Array(words);
      scanSide(board, side, seen);
      const first = side * blueSlots;
      const enemyFirst = (side ^ 1) * blueSlots;
      const add = (unit, target, destination, landingCell, rank) => {
        const key = ((unit + 1) * (count + 1) + destination + 1) * (units + 1) + target + 1;
        const order = key === firstChoice ? rank + 40000 : rank;
        if (moves.length === limit && order <= moves[limit - 1].order) return;
        let index = moves.length;
        while (index > 0 && moves[index - 1].order < order) index--;
        moves.splice(index, 0, { unit, target, destination, landing: landingCell, order });
        if (moves.length > limit) moves.pop();
      };
      for (let id = first; id < first + blueSlots; id++) {
        const origin = board.position[id];
        if (origin < 0) continue;
        const type = slotTypes[id];
        const reach = definitions[type].mp + (type === archerType ? 4 : (type === spearType ? 2 : 1));
        const enemies = [];
        for (let target = enemyFirst; target < enemyFirst + blueSlots; target++) {
          const pos = board.position[target];
          if (pos >= 0 && rangeBetween(origin, pos) <= reach) enemies.push(target);
        }
        if (onlyAttacks && !enemies.length) continue;

        for (const target of enemies) {
          if (hasBit(seen, board.position[target]) && strikeInRange(board, id, target)) {
            add(id, target, -1, origin, attackPriority(board, id, target, 0));
          }
        }
        const landed = new Uint8Array(count);
        const found = reachableCells(board, id, seen);
        for (let j = 0; j < found; j++) {
          const destination = destinations[j];
          route.length = 0;
          for (let cell = destination; cell >= 0; cell = routeParent[cell]) route.push(cell);
          route.reverse();

          const stopped = landing(board, id, route);
          if (stopped < 0 && onlyAttacks) continue;
          const end = stopped < 0 ? -stopped - 2 : stopped;
          if (end === origin && !onlyAttacks) continue;
          const landingKind = stopped < 0 ? 1 : 2;
          if (landed[end] & landingKind) continue;
          landed[end] |= landingKind;
          const forward = (side ? 1 : -1) * (Math.floor(end / size) - Math.floor(origin / size));
          const quiet = stopped < 0 ? -45 : 8 * forward
            + (terrain[end] === hill ? (type === archerType ? 55 : 36) : 0)
            + (terrain[end] === forest && type === flagType ? 18 : 0)
            - (type === flagType ? Math.max(0, forward) * 11 : 0);
          if (!onlyAttacks) add(id, -1, destination, stopped, quiet);
          if (stopped < 0 || !enemies.length) continue;

          const displacement = rangeBetween(origin, end);
          relocate(board, id, end);
          for (const target of enemies) {
            if (strikeInRange(board, id, target) && sideDetects(board, side, board.position[target])) {
              add(id, target, destination, end, attackPriority(board, id, target, displacement) + quiet * 0.04);
            }
          }
          relocate(board, id, origin);
        }
      }
      if (!onlyAttacks) add(-1, -1, -1, -1, -4);
      return moves;
    }

    function terminal(board) {
      if (board.hp[flag[0]] === 0 || board.hp[flag[1]] === 0) {
        return (Number(board.hp[flag[1]] > 0) - Number(board.hp[flag[0]] > 0)) * (WIN - board.turn);
      }
      if (board.turn <= maxTurns) return null;
      let hp = 0;
      let hills = 0;
      for (let id = 0; id < units; id++) {
        const pos = board.position[id];
        if (pos < 0) continue;
        const sign = team(id) ? 1 : -1;
        hp += sign * board.hp[id];
        if (terrain[pos] === hill) hills += sign;
      }
      return Math.sign(hp || hills) * (WIN - board.turn);
    }

    function chargeLanes(board, id, side, cell) {
      if (slotTypes[id] !== cavalryType) return 0;
      let threat = 0;
      for (let direction = 0; direction < 4; direction++) {
        let to = cell;
        let fuel = definitions[cavalryType].mp - Number(enemyZoc(board, cell, side));
        for (let step = 1; step <= 4; step++) {
          const edge = to * 4 + direction;
          to = neighbors[edge];
          if (to < 0) break;
          fuel -= costs[edge];
          const occupant = board.cells[to];
          if (fuel < 0 || (occupant >= 0 && team(occupant) !== side)) break;
          if (step >= 3 && occupant < 0 && terrain[to] !== forest) {
            for (let adjacent = to * 4; adjacent < to * 4 + 4; adjacent++) {
              const next = neighbors[adjacent];
              if (next < 0) continue;
              const target = board.cells[next];
              if (target < 0 || team(target) === side) continue;
              const type = slotTypes[target];
              threat = Math.max(threat, type === flagType ? 23 : (type === shieldType || type === archerType ? 15 : 8));
            }
          }
          if (enemyZoc(board, to, side)) break;
        }
      }
      return threat;
    }

    function evaluate(board, tactical = marshal) {
      let score = 0;
      const late = board.turn >= maxTurns - 16;
      const key = (board.hash ^ (tactical ? 0xec820704 : 0) ^ (late ? 0xcf7a5642 : 0)) >>> 0;
      const entry = key & TABLE_MASK;
      if (staticValid[entry] && staticKeys[entry] === key) return staticValues[entry];
      for (let id = 0; id < units; id++) {
        const cell = board.position[id];
        if (cell < 0) continue;
        const side = team(id);
        const type = slotTypes[id];
        const home = side ? Math.floor(cell / size) : size - 1 - Math.floor(cell / size);
        const signs = side ? 1 : -1;
        const support = neighborCounts(board, cell, side) & 15;
        let value = definitions[type].aiValue * (late ? 0.42 : 0.82) + board.hp[id] * (late ? 15 : 8)
          + Math.min(support, 2) * 3 + aura(board, id) * 4;
        if (type === flagType) {
          value += board.hp[id] * 11 + Math.min(support, 2) * 9 - Math.max(0, home - 4) * 5;
        } else {
          value += Math.min(home, 6) * (type === cavalryType ? 1.8 : 3.5)
            + (size / 2 - Math.abs(cell % size - (size - 1) / 2)) * 1.6;
        }
        if (terrain[cell] === hill) value += late ? 19 : (type === archerType ? 24 : 11);
        if (terrain[cell] === forest) value += type === flagType ? 14 : (type === cavalryType ? -3 : 5);
        if (tactical) {
          let exposedTargets = 0;
          const first = (side ^ 1) * blueSlots;
          for (let target = first; target < first + blueSlots; target++) {
            if (board.position[target] >= 0 && strikeInRange(board, id, target)
                && sideDetects(board, side, board.position[target])) exposedTargets++;
          }
          if (exposedTargets >= 2) value += 9 + (exposedTargets - 2) * 3;
          value += chargeLanes(board, id, side, cell);
        }
        score += signs * value;
      }
      staticValid[entry] = 1;
      staticKeys[entry] = key;
      staticValues[entry] = score;
      return score;
    }

    function* quiescence(board, side, alpha, beta, remaining, ply, firstReply = true) {
      if ((++nodes & 15) === 0) yield* checkpoint();
      const result = terminal(board);
      if (result !== null) return result;
      let best = evaluate(board);
      if (remaining <= 0) return best;
      if (side === 1) alpha = Math.max(alpha, best);
      else beta = Math.min(beta, best);
      if (alpha >= beta) return best;

      const frame = frames[ply];
      const attacks = movesFor(board, side, true, 4);
      for (const move of attacks) {
        // 延伸首步還會檢查一般反擊，後續只延伸斬首與有明顯傷亡的交戰。
        if (!firstReply && move.order < 735 && slotTypes[move.target] !== flagType) continue;
        make(board, move, frame);
        let score;
        try {
          score = yield* quiescence(board, side ^ 1, alpha, beta, remaining - 1, ply + 1, false);
        } finally {
          unmake(board, frame);
        }
        if (side === 1) {
          best = Math.max(best, score);
          alpha = Math.max(alpha, best);
        } else {
          best = Math.min(best, score);
          beta = Math.min(beta, best);
        }
        if (alpha >= beta) break;
      }
      return best;
    }

    function* alphaBeta(board, side, depth, alpha, beta, ply, extension, fast) {
      if ((++nodes & 15) === 0) yield* checkpoint();
      const result = terminal(board);
      if (result !== null) return result;
      if (!depth) return extension
        ? yield* quiescence(board, side, alpha, beta, extension, ply)
        : evaluate(board, false);

      const originalAlpha = alpha;
      const originalBeta = beta;
      const key = (board.hash ^ turnKeys[board.turn] ^ Math.imul(extension, 0x1bcc902f)) >>> 0;
      const tableIndex = key & TABLE_MASK;
      let firstChoice = -1;
      if (marshal && !fast && tableKeys[tableIndex] === key && tableDepth[tableIndex] >= 0) {
        firstChoice = tableFirst[tableIndex];
        if (tableDepth[tableIndex] >= depth) {
          const value = tableValue[tableIndex];
          if (tableBounds[tableIndex] === 0 || (tableBounds[tableIndex] === 1 && value <= alpha)
              || (tableBounds[tableIndex] === 2 && value >= beta)) return value;
        }
      }

      let best = side === 1 ? -INF : INF;
      let bestMove = -1;
      const width = fast ? 3 : (marshal ? (living <= 7 ? 3 : 4) : (depth === 1 ? 5 : 6));
      const moves = movesFor(board, side, false, width, firstChoice);
      const frame = frames[ply];
      for (const move of moves) {
        make(board, move, frame);
        let score;
        try {
          score = yield* alphaBeta(board, side ^ 1, depth - 1, alpha, beta, ply + 1, extension, fast);
        } finally {
          unmake(board, frame);
        }
        if (side === 1 ? score > best : score < best) {
          best = score;
          bestMove = moveKey(move);
        }
        if (side === 1) alpha = Math.max(alpha, best);
        else beta = Math.min(beta, best);
        if (alpha >= beta) break;
      }
      if (marshal && !fast) {
        tableKeys[tableIndex] = key;
        tableDepth[tableIndex] = depth;
        tableValue[tableIndex] = best;
        tableBounds[tableIndex] = best <= originalAlpha ? 1 : (best >= originalBeta ? 2 : 0);
        tableFirst[tableIndex] = bestMove;
      }
      return best;
    }

    const sampled = marshal ? 12 : 4;
    const worlds = sampleWorlds(sampled);
    function* rank(pool, depth, extension, fast, forceCheck = false) {
      const scored = [];
      for (const move of pool) {
        let total = 0;
        let worst = INF;
        for (const board of worlds) {
          yield* checkpoint();
          const frame = frames[0];
          make(board, move, frame, true);
          let score;
          try {
            score = yield* alphaBeta(board, 0, depth - 1, -INF, INF, 1, extension, fast);
          } finally {
            unmake(board, frame);
          }
          // 偵察價值與陣形取捨是各世界評估的同一部分，強制勝負優先。
          const evaluated = Math.abs(score) > WIN - 150 ? score : score + move.bias;
          total += board.weight * evaluated;
          worst = Math.min(worst, evaluated);
        }
        const average = total / sampled;
        const score = marshal ? average * 0.7 + worst * 0.3 : average;
        scored.push({ move, score, forced: forceCheck && worst > WIN - 140 });
      }
      scored.sort((a, b) => b.score - a.score || a.move.index - b.move.index);
      return scored;
    }

    function guaranteedCapture(move) {
      if (move.target !== flag[0]) return false;
      if (!knownPositions.every((cell, slot) => cell >= 0 || estimatedHp[slot] === 0)) {
        // 若有隱軍，逐格確認路徑、可能攔截的相鄰格與旗手援護範圍。
        for (const cell of [...move.path, knownPositions[move.target]]) {
          if (!hasBit(scanned, cell)) return false;
          for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
            const next = neighbors[edge];
            if (next >= 0 && !hasBit(scanned, next)) return false;
          }
        }
      }
      return true;
    }

    const sortedRoots = roots.slice().sort((a, b) => b.order - a.order || a.index - b.index);
    let best = sortedRoots[0];
    let completedDepth = 0;
    let forced = false;
    const result = () => ({ index: best.index, depth: completedDepth, worlds: sampled, nodes, forced });
    emit(result());

    try {
      const pool = sortedRoots.slice(0, marshal ? 24 : 10);
      // 戰術搜尋逾時時留用完整比較過的上一層。
      let ranked = yield* rank(pool, 1, 0, true, true);
      best = ranked[0].move;
      completedDepth = 1;
      forced = ranked[0].forced && guaranteedCapture(best);
      emit(result());
      if (forced) return result();

      if (!marshal) {
        ranked = yield* rank(ranked.map(item => item.move), 2, 0, true);
        best = ranked[0].move;
        completedDepth = 2;
        emit(result());
        ranked = yield* rank(ranked.map(item => item.move), 3, 1, false);
        best = ranked[0].move;
        completedDepth = 3;
        return result();
      }

      stageDeadline = Math.min(deadline, startTime + 300);
      try {
        ranked = yield* rank(ranked.map(item => item.move), 2, 0, true);
        best = ranked[0].move;
        completedDepth = 2;
        emit(result());
      } catch (error) {
        if (error !== timeout) throw error;
      }
      stageDeadline = deadline;

      const maxDepth = living <= 5 ? 8 : (living <= 8 || turn >= maxTurns - 16 ? 6 : 5);
      const extension = living <= 7 ? 5 : 3;
      ranked = ranked.slice(0, 16);
      for (let depth = 3; depth <= maxDepth; depth++) {
        const replyDepth = depth === 3 ? 1 : extension;
        ranked = yield* rank(ranked.map(item => item.move), depth, replyDepth, false);
        best = ranked[0].move;
        completedDepth = depth;
        emit(result());
      }
    } catch (error) {
      if (error !== timeout) throw error;
    }
    return result();
  }

  function advancedWorkerSource() {
    return `'use strict';
      ${searchAdvancedAi.toString()}
      self.onmessage = ({ data: { id, payload, budget } }) => {
        const emit = value => self.postMessage({ id, kind: 'progress', value });
        try {
          const job = searchAdvancedAi(payload, emit, { budget });
          let step = job.next();
          while (!step.done) step = job.next();
          self.postMessage({ id, kind: 'done', value: step.value });
        } catch {
          self.postMessage({ id, kind: 'failed' });
        }
      };`;
  }

  return {
    protocolVersion: 1,
    id: 'general',
    name: '將軍',
    label: '將軍 · 迷霧推演',
    order: 30,
    coordinateSpace: 'canonical',
    thinkingText: '推演中…',
    pacingDelayMs: 0,
    timeoutMs: 5000,
    _workerSourceForTest: advancedWorkerSource,

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


      const config = { budget: 570, deadline: 700, minTime: 400 };
      const memory = createAiMemory(agentRng);
      const beliefs = INITIAL_BLUE_UNITS.map(({ x, y }) => {
        const probability = new Float32Array(CELL_COUNT);
        probability[cellIndex(x, y)] = 1;
        return probability;
      });
      let observedEnemyAction = null;
      let searchSeq = 0;

      function filterEnemyBeliefs(knowledge) {
        const { seen, blocked } = knowledge;
        for (const [slot, row] of beliefs.entries()) {
          const entry = memory.redKnowledge['B' + (slot + 1)];
          if (!entry.alive || seen[slot] >= 0) {
            row.fill(0);
            if (entry.alive) row[seen[slot]] = 1;
            continue;
          }
          let total = 0;
          for (let cell = 0; cell < CELL_COUNT; cell++) {
            if (blocked[cell]) row[cell] = 0;
            total += row[cell];
          }
          if (total === 0) {
            const anchor = entry.lastX === null ? INITIAL_BLUE_UNITS[slot] : { x: entry.lastX, y: entry.lastY };
            for (let cell = 0; cell < CELL_COUNT; cell++) {
              if (blocked[cell]) continue;
              const distance = manhattan(cell % BOARD_SIZE, Math.floor(cell / BOARD_SIZE), anchor.x, anchor.y);
              row[cell] = 1 / (1 + distance * distance);
              total += row[cell];
            }
          }
          if (total > 0) {
            for (let cell = 0; cell < CELL_COUNT; cell++) row[cell] /= total;
          }
        }
      }

      function advanceEnemyBeliefs(board, cVision) {
        const knowledge = buildCanonicalKnowledge(board, cVision);
        const { seen, myPositions } = knowledge;
        const observation = observedEnemyAction;
        const geometry = advancedGeometryFor(board.map);
        const redOccupied = new Uint8Array(CELL_COUNT);
        const redZoC = new Uint8Array(CELL_COUNT);
        const observedBlueCells = new Set(seen);
        for (const { cell, shield } of myPositions) {
          redOccupied[cell] = 1;
          if (!shield) continue;
          for (let edge = cell * 4; edge < cell * 4 + 4; edge++) {
            const next = geometry.neighbors[edge];
            if (next >= 0) redZoC[next] = 1;
          }
        }
        const hiddenLiving = beliefs.filter((_, slot) =>
          seen[slot] < 0 && memory.redKnowledge['B' + (slot + 1)].alive).length;

        for (const [slot, row] of beliefs.entries()) {
          const entry = memory.redKnowledge['B' + (slot + 1)];
          if (!entry.alive || seen[slot] >= 0 || (observation && observation.id !== entry.id)) continue;
          const movingProbability = observation ? 1 : 0.88 / Math.max(1, hiddenLiving);
          const prior = new Float32Array(CELL_COUNT);
          if (observation) prior[observation.cell] = 1;
          else prior.set(row);
          row.fill(0);
          const mp = UNIT_DEFS[entry.type].mp;
          for (let from = 0; from < CELL_COUNT; from++) {
            if (!prior[from]) continue;
            const destinations = beliefDestinations(from, mp, geometry, redOccupied, redZoC)
              .filter(cell => !observedBlueCells.has(cell));
            row[from] += destinations.length ? prior[from] * (1 - movingProbability) : prior[from];
            if (destinations.length) {
              const share = prior[from] * movingProbability / destinations.length;
              for (const cell of destinations) row[cell] += share;
            }
          }
        }

        observedEnemyAction = null;
        filterEnemyBeliefs(knowledge);
      }

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
  function advancedSearchPacket(observation, difficulty, seed) {
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

    const information = new Float32Array(CELL_COUNT);
    const beliefs = observation.beliefs;
    for (const [slot, row] of beliefs.entries()) {
      if (knownPositions[slot] >= 0 || !estimatedHp[slot]) continue;
      const role = INITIAL_BLUE_UNITS[slot].type;
      const weight = role === 'flag' ? 4.2 : (role === 'archer' ? 2 : 1);
      for (let cell = 0; cell < CELL_COUNT; cell++) information[cell] += row[cell] * weight;
    }

    const roots = actions.map((action, index) => {
      const unit = slotOf(action.unitId);
      const target = slotOf(action.targetId);
      const path = action.path ? action.path.map(({ x, y }) => cellIndex(x, y)) : [];
      const utility = scoreCandidateAction(action, ctx);
      let informationValue = 0;
      let priority = 0;
      if (path.length) {
        const destination = path[path.length - 1];
        const type = TYPE_NAMES.indexOf(INITIAL_BLUE_UNITS[unit % BLUE_SLOTS].type);
        const offset = (type * CELL_COUNT + destination) * VISION_WORDS;
        for (let cell = 0; cell < CELL_COUNT; cell++) {
          const word = cell >>> 5;
          if ((geometry.scans[offset + word] & ~scanned[word] & (1 << (cell & 31))) !== 0) {
            informationValue += information[cell];
          }
        }
        if (geometry.terrain[destination] === 1) priority += 24;
      }
      if (target >= 0) {
        const attacker = getUnitById(action.unitId, board);
        const defender = getUnitById(action.targetId, board);
        const from = { x: attacker.x, y: attacker.y };
        if (path.length) {
          attacker.x = action.tx;
          attacker.y = action.ty;
        }
        try {
          const preview = previewCombat(attacker, defender, action.disp || 0, board);
          if (!preview.defenderSurvives) priority += defender.type === 'flag' ? 40000 : 1200;
          else if (preview.isShattered) priority += 900;
          else if (preview.defRes.isFlanked) priority += 600;
          else priority += 60;
        } finally {
          Object.assign(attacker, from);
        }
      }
      // 旗手受威脅時，把避開斬首線的退路／護衛也列入初篩。
      if (ctx.stance === 'DEFEND' && ctx.myFlag && unit >= 0) {
        if (action.unitId === ctx.myFlag.id && path.length) priority += Math.max(0, utility) * 0.9;
        if (target >= 0 && ctx.visibleEnemies.some(enemy => enemy.id === action.targetId
            && manhattan(enemy.x, enemy.y, ctx.myFlag.x, ctx.myFlag.y) <= 4)) priority += 110;
      }
      return {
        index, unit, target, path,
        order: utility + priority + informationValue * 16,
        bias: Math.max(-18, Math.min(20, utility * 0.18)) + informationValue * 7
      };
    });
    const slotTypes = Int8Array.from({ length: knownPositions.length }, (_, slot) =>
      TYPE_NAMES.indexOf(INITIAL_BLUE_UNITS[slot % BLUE_SLOTS].type));
    const definitions = TYPE_NAMES.map(name => {
      const { maxHp, mp, baseAtk, baseDef, aiValue } = UNIT_DEFS[name];
      return { maxHp, mp, baseAtk, baseDef, aiValue };
    });
    return {
      actions,
      payload: {
        size: BOARD_SIZE, maxTurns: MAX_TURNS, blueSlots: BLUE_SLOTS, turn: observation.turn,
        slotTypes, definitions, geometry, knownPositions, estimatedHp, scanned, beliefs, roots,
        difficulty, seed
      }
    };
  }

      return {
        onEvent(event) {
          if (!event) return;
          if (event.type === 'vision_sync') {
            updateMemoryFromVision(memory, event.board, event.vision, event.turn);
            if (event.isMyTurn) {
              filterEnemyBeliefs(buildCanonicalKnowledge(event.board, event.vision));
            }
          } else if (event.type === 'enemy_seen_action') {
            observedEnemyAction = { id: event.unitId, cell: event.cell };
          } else if (event.type === 'enemy_killed') {
            if (memory.redKnowledge[event.unitId]) {
              Object.assign(memory.redKnowledge[event.unitId], { alive: false, knownHp: 0 });
            }
          } else if (event.type === 'turn_advance') {
            advanceEnemyBeliefs(event.board, event.vision);
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
            beliefs,
            particles: null,
            memory,
            turnsSinceDamage: obs.turnsSinceDamage
          };
          const seed = runtime.testOverrides && runtime.testOverrides.searchSeed !== undefined
            ? (runtime.testOverrides.searchSeed >>> 0)
            : ((rngFn() * 0xffffffff) >>> 0);
          const { actions, payload } = advancedSearchPacket(observation, 'general', seed);

          if (runtime.testOverrides && runtime.testOverrides.syncExact) {
            if (runtime.testOverrides.fixedMaxDepth) payload.maxDepth = runtime.testOverrides.fixedMaxDepth;
            let best = null;
            const emit = (val) => {
              if (val && Number.isInteger(val.index) && actions[val.index]) {
                if (!best || val.depth >= best.depth) best = val;
              }
            };
            const job = searchAdvancedAi(payload, emit, { budget: runtime.testOverrides.budget || 1e9 });
            let step = job.next();
            while (!step.done) step = job.next();
            emit(step.value);
            return best && best.depth > 0 ? actions[best.index] : chooseRedAiAction(observation, rngFn);
          }

          return new Promise((resolve) => {
            const now = runtime.now;
            const started = now();
            const searchId = ++searchSeq;
            const budgetMs = (runtime.testOverrides && runtime.testOverrides.budget) || config.budget;
            const deadlineMs = (runtime.testOverrides && runtime.testOverrides.deadline) || config.deadline;
            const minTimeMs = (runtime.testOverrides && runtime.testOverrides.minTime !== undefined)
              ? runtime.testOverrides.minTime
              : config.minTime;

            let best = null;
            let worker = null;
            let nextTimer = null;
            let deadlineTimer = null;
            let finishing = false;
            let local = false;
            let settled = false;

            const cleanup = () => {
              if (nextTimer !== null) { clearTimeout(nextTimer); nextTimer = null; }
              if (deadlineTimer !== null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
              if (worker) { try { worker.terminate(); } catch {} worker = null; }
            };

            const onAbort = () => {
              if (settled) return;
              settled = true;
              finishing = true;
              cleanup();
              resolve(null);
            };
            if (runtime.signal) {
              if (runtime.signal.aborted) { onAbort(); return; }
              runtime.signal.addEventListener('abort', onAbort, { once: true });
            }

            const receive = (value) => {
              if (!value || !Number.isInteger(value.index) || !actions[value.index]) return;
              if (!best || value.depth >= best.depth) {
                best = value;
                runtime.reportProgress({ depth: value.depth, bestAction: actions[value.index] });
              }
            };

            const finish = () => {
              if (finishing || settled) return;
              finishing = true;
              cleanup();
              const minWait = runtime.isAiVsAi ? Math.round(minTimeMs * runtime.speedFactor) : minTimeMs;
              const delay = Math.max(0, minWait - (now() - started));
              const done = () => {
                if (settled) return;
                settled = true;
                if (runtime.signal) runtime.signal.removeEventListener('abort', onAbort);
                const canonicalAction = best && best.depth > 0 ? actions[best.index] : chooseRedAiAction(observation, rngFn);
                resolve(canonicalAction);
              };
              if (delay <= 0) done();
              else nextTimer = setTimeout(done, delay);
            };

            const runLocally = () => {
              if (local || finishing || settled) return;
              if (worker) { try { worker.terminate(); } catch {} worker = null; }
              local = true;
              const budget = Math.min(budgetMs, deadlineMs - (now() - started) - 30);
              if (budget <= 0) { finish(); return; }
              const job = searchAdvancedAi(payload, receive, { budget, sliceMs: 7 });
              const resume = () => {
                if (finishing || settled) return;
                try {
                  const step = job.next();
                  if (!step.done) nextTimer = setTimeout(resume, 0);
                  else {
                    receive(step.value);
                    finish();
                  }
                } catch {
                  finish();
                }
              };
              nextTimer = setTimeout(resume, 0);
            };

            deadlineTimer = setTimeout(finish, Math.max(0, deadlineMs - (now() - started)));

            if (!runtime.canUseWorker) {
              runLocally();
              return;
            }
            try {
              worker = runtime.spawnBlobWorker(advancedWorkerSource());
              worker.onmessage = ({ data }) => {
                if (finishing || settled || data.id !== searchId) return;
                if (data.kind === 'failed') { runLocally(); return; }
                receive(data.value);
                if (data.kind === 'done') finish();
              };
              worker.onerror = (event) => {
                if (event && event.preventDefault) event.preventDefault();
                runLocally();
              };
              worker.onmessageerror = runLocally;
              worker.postMessage({ id: searchId, payload, budget: budgetMs });
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
            beliefs,
            particles: null,
            memory,
            turnsSinceDamage: postObs.turnsSinceDamage
          };
          return chooseNewlySeenAttack(
            observation, ctx.unitId, ctx.displacement, ctx.initiallyVisibleEnemyIds, ctx.reconsider, ctx.rng || agentRng
          );
        },

        dispose() {}
      };
    }
  };

});
