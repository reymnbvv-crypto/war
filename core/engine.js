(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TFCEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =========================================================
   * 迷霧陣線（Tactical Fog Chess）純規則核心引擎
   * 零相依、無 DOM、無任何 AI 策略或子力估值常數。
   * 瀏覽器與 Node.js 共用單一規則真相源。
   * ========================================================= */

  const BOARD_SIZE = 10;
  const MAX_TURNS = 120;
  const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;
  const VISION_WORDS = Math.ceil(CELL_COUNT / 32);

  const DIRS = Object.freeze([
    Object.freeze({ dx: 0, dy: -1 }),
    Object.freeze({ dx: 0, dy: 1 }),
    Object.freeze({ dx: -1, dy: 0 }),
    Object.freeze({ dx: 1, dy: 0 })
  ]);

  // 180° 中心旋轉對稱地形：(x, y) 與 (9 - x, 9 - y) 完全鏡像
  const HILL_COORDS = Object.freeze([
    [4, 4], [5, 4], [4, 5], [5, 5],
    [1, 4], [2, 4],
    [8, 5], [7, 5]
  ].map(pair => Object.freeze(pair)));

  const FOREST_COORDS = Object.freeze([
    [2, 2], [3, 2], [2, 3],
    [7, 7], [6, 7], [7, 6],
    [7, 3], [8, 3], [6, 4],
    [2, 6], [1, 6], [3, 5]
  ].map(pair => Object.freeze(pair)));

  // 純規則兵種數值（不含任何 AI 評估權重）
  const UNIT_DEFS = Object.freeze({
    flag: Object.freeze({
      name: '旗手', char: '旗', maxHp: 9, baseAtk: 4, baseDef: 3, mp: 3, vision: 3,
      rangeDesc: '1 格',
      traitDesc: '軍旗激勵（周圍曼距 1～2 格友軍攻+1、防+1）；陣亡立即敗北。'
    }),
    shield: Object.freeze({
      name: '重盾步兵', char: '盾', maxHp: 10, baseAtk: 4, baseDef: 5, mp: 2, vision: 2,
      rangeDesc: '1 格',
      traitDesc: '控制區 ZoC（踏入即停、離開 +1MP）；受距 ≥2 遠程防+2；遭輕騎衝鋒時破防 -3 且無法反擊。'
    }),
    spear: Object.freeze({
      name: '長矛兵', char: '矛', maxHp: 10, baseAtk: 6, baseDef: 3, mp: 3, vision: 2,
      rangeDesc: '1～2 格直線',
      traitDesc: '長柄突刺（可越友軍攻直線 2 格，距2攻-1，不可平地高打/隔高）；反騎槍陣（對輕騎攻+2）。'
    }),
    archer: Object.freeze({
      name: '弓手', char: '弓', maxHp: 7, baseAtk: 7, baseDef: 1, mp: 2, vision: 3,
      rangeDesc: '2～3 格（高地 2～4）',
      traitDesc: '曲射支援（可射擊共享視野內目標）；無法攻距 1、無法近戰反擊。'
    }),
    cavalry: Object.freeze({
      name: '輕騎', char: '騎', maxHp: 9, baseAtk: 5, baseDef: 2, mp: 4, vision: 4,
      rangeDesc: '1 格',
      traitDesc: '衝鋒（起終曼距 ≥3 且非樹林攻+2）；破盾衝散（衝鋒打重盾時重盾防-3且無法反擊，援護照算）。'
    })
  });

  const TYPE_NAMES = Object.freeze(['flag', 'shield', 'spear', 'archer', 'cavalry']);

  // 藍方開局佈陣（紅方以 (9 - x, 9 - y) 鏡像）
  const INITIAL_BLUE_UNITS = Object.freeze([
    { type: 'shield',  x: 3, y: 8 },
    { type: 'shield',  x: 6, y: 8 },
    { type: 'spear',   x: 4, y: 8 },
    { type: 'spear',   x: 5, y: 8 },
    { type: 'cavalry', x: 1, y: 8 },
    { type: 'cavalry', x: 8, y: 8 },
    { type: 'archer',  x: 4, y: 9 },
    { type: 'flag',    x: 5, y: 9 }
  ].map(cfg => Object.freeze(cfg)));

  const BLUE_SLOTS = INITIAL_BLUE_UNITS.length;

  const keyOf = (x, y) => `${x},${y}`;
  const inBounds = (x, y) => x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
  const manhattan = (x1, y1, x2, y2) => Math.abs(x1 - x2) + Math.abs(y1 - y2);
  const cellIndex = (x, y) => y * BOARD_SIZE + x;
  const opponentOf = (faction) => (faction === 'blue' ? 'red' : 'blue');
  const factionName = (faction) => (faction === 'blue' ? '藍方' : '紅方');

  function getTerrainName(terrain) {
    if (terrain === 'hill') return '▲ 高地（海拔 1）';
    if (terrain === 'forest') return '🌲 樹林（海拔 0）';
    return '平地（海拔 0）';
  }

  function createTerrainGrid() {
    const grid = [];
    for (let y = 0; y < BOARD_SIZE; y++) {
      const row = [];
      for (let x = 0; x < BOARD_SIZE; x++) {
        row.push({ terrain: 'plain', elev: 0 });
      }
      grid.push(row);
    }
    for (const [x, y] of HILL_COORDS) {
      if (inBounds(x, y)) grid[y][x] = { terrain: 'hill', elev: 1 };
    }
    for (const [x, y] of FOREST_COORDS) {
      if (inBounds(x, y)) grid[y][x] = { terrain: 'forest', elev: 0 };
    }
    return grid;
  }

  function createInitialUnits() {
    const units = [];
    let bId = 1;
    for (const cfg of INITIAL_BLUE_UNITS) {
      const def = UNIT_DEFS[cfg.type];
      units.push({
        id: `B${bId++}`,
        faction: 'blue',
        type: cfg.type,
        x: cfg.x,
        y: cfg.y,
        hp: def.maxHp,
        maxHp: def.maxHp,
        alive: true
      });
    }
    let rId = 1;
    for (const cfg of INITIAL_BLUE_UNITS) {
      const def = UNIT_DEFS[cfg.type];
      units.push({
        id: `R${rId++}`,
        faction: 'red',
        type: cfg.type,
        x: BOARD_SIZE - 1 - cfg.x,
        y: BOARD_SIZE - 1 - cfg.y,
        hp: def.maxHp,
        maxHp: def.maxHp,
        alive: true
      });
    }
    return units;
  }

  function cloneMap(map) {
    return map.map(row => row.map(cell => ({ terrain: cell.terrain, elev: cell.elev })));
  }

  function getUnitById(id, board) {
    if (!board || !id) return null;
    return board.units.find(u => u.id === id) || null;
  }

  function getUnitAt(x, y, board) {
    if (!board) return null;
    return board.units.find(u => u.alive && u.x === x && u.y === y) || null;
  }

  function getAliveFlag(faction, board) {
    if (!board) return null;
    return board.units.find(u => u.alive && u.faction === faction && u.type === 'flag') || null;
  }

  /**
   * 格心對格心 DDA 超覆蓋射線檢測（防止斜角縫隙穿牆）
   */
  function hasLineOfSight(x0, y0, x1, y1, obsElev, board) {
    if (x0 === x1 && y0 === y1) return true;
    const map = board.map || board;
    const targetElev = map[y1][x1].elev;
    const mDist = manhattan(x0, y0, x1, y1);

    // 平地看不到高地，除非相鄰（曼距=1）
    if (obsElev === 0 && targetElev === 1) {
      return mDist === 1;
    }
    if (mDist === 1) return true;

    const isBlocker = (cx, cy) => {
      const cell = map[cy][cx];
      if (obsElev === 0) {
        return cell.elev > 0 || cell.terrain === 'forest';
      } else {
        // 高地視線越過低地樹林；但穿過另一座高地會遮蔽其後方低地
        if (cell.elev > obsElev) return true;
        if (cell.elev >= obsElev && targetElev < obsElev) return true;
        return false;
      }
    };

    const dx = x1 - x0;
    const dy = y1 - y0;
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);

    const stepTx = dx === 0 ? Infinity : Math.abs(1 / dx);
    const stepTy = dy === 0 ? Infinity : Math.abs(1 / dy);
    let tMaxX = dx === 0 ? Infinity : stepTx * 0.5;
    let tMaxY = dy === 0 ? Infinity : stepTy * 0.5;

    let cx = x0;
    let cy = y0;
    const EPS = 1e-9;

    while (cx !== x1 || cy !== y1) {
      if (Math.abs(tMaxX - tMaxY) < EPS) {
        // 精準經過格角：若兩側皆為阻擋物（或嚴格超覆蓋阻擋），禁止穿縫
        const b1 = inBounds(cx + sx, cy) && isBlocker(cx + sx, cy);
        const b2 = inBounds(cx, cy + sy) && isBlocker(cx, cy + sy);
        if (b1 && b2) return false;
        cx += sx;
        cy += sy;
        tMaxX += stepTx;
        tMaxY += stepTy;
      } else if (tMaxX < tMaxY) {
        cx += sx;
        tMaxX += stepTx;
      } else {
        cy += sy;
        tMaxY += stepTy;
      }

      if (cx === x1 && cy === y1) return true;
      if (!inBounds(cx, cy)) return false;
      if (isBlocker(cx, cy)) return false;
    }

    return true;
  }

  function computeVisionData(faction, board) {
    const tileVisible = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));
    const forestReveal = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));
    const allies = board.units.filter(u => u.alive && u.faction === faction);

    for (const u of allies) {
      const def = UNIT_DEFS[u.type];
      const obsElev = board.map[u.y][u.x].elev;
      const radius = def.vision + (obsElev === 1 ? 1 : 0);
      const maxEuclid = radius + 0.5;

      for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
          const eDist = Math.hypot(x - u.x, y - u.y);
          if (eDist > maxEuclid) continue;
          if (hasLineOfSight(u.x, u.y, x, y, obsElev, board)) {
            tileVisible[y][x] = true;
            if (eDist <= 2.05) {
              forestReveal[y][x] = true;
            }
          }
        }
      }
    }

    const detectedEnemyIds = new Set();
    const enemies = board.units.filter(u => u.alive && u.faction !== faction);
    for (const e of enemies) {
      const cell = board.map[e.y][e.x];
      const detected = cell.terrain === 'forest'
        ? forestReveal[e.y][e.x]
        : tileVisible[e.y][e.x];
      if (detected) detectedEnemyIds.add(e.id);
    }

    return { tileVisible, forestReveal, detectedEnemyIds };
  }

  function isTileScanned(x, y, vision, map) {
    return map[y][x].terrain === 'forest' ? vision.forestReveal[y][x] : vision.tileVisible[y][x];
  }

  function createObservedBoard(board, faction, vision, revealAll = false) {
    return {
      map: board.map,
      units: board.units
        .filter(unit => unit.alive && (revealAll || unit.faction === faction || vision.detectedEnemyIds.has(unit.id)))
        .map(unit => ({ ...unit }))
    };
  }

  function isInEnemyShieldZoc(x, y, myFaction, visionObj, board) {
    // visionObj 傳入 null 代表以真實棋盤檢查（實際移動攔截）；傳入陣營視野物件則只看已知重盾
    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (!inBounds(nx, ny)) continue;
      const u = getUnitAt(nx, ny, board);
      if (u && u.faction !== myFaction && u.type === 'shield') {
        if (!visionObj || visionObj.detectedEnemyIds.has(u.id)) {
          return true;
        }
      }
    }
    return false;
  }

  function getMoveStepCost(fromX, fromY, toX, toY, board) {
    const map = board.map || board;
    const fromCell = map[fromY][fromX];
    const toCell = map[toY][toX];
    if (toCell.terrain === 'forest') return 2;
    if (toCell.terrain === 'hill') {
      return fromCell.elev === 0 ? 2 : 1;
    }
    return 1;
  }

  function computeReachableFor(unit, visionObj, board) {
    const maxMp = UNIT_DEFS[unit.type].mp;
    const startsInZoc = isInEnemyShieldZoc(unit.x, unit.y, unit.faction, visionObj, board);

    const best = new Map();
    const startKey = keyOf(unit.x, unit.y);
    best.set(startKey, {
      x: unit.x, y: unit.y, cost: 0, steps: 0, locked: false, parentKey: null
    });

    const open = [best.get(startKey)];

    while (open.length > 0) {
      open.sort((a, b) => (a.cost !== b.cost ? a.cost - b.cost : a.steps - b.steps));
      const cur = open.shift();
      const curKey = keyOf(cur.x, cur.y);
      if (cur !== best.get(curKey)) continue;
      if (cur.locked) continue;

      for (const d of DIRS) {
        const nx = cur.x + d.dx;
        const ny = cur.y + d.dy;
        if (!inBounds(nx, ny)) continue;

        const occ = getUnitAt(nx, ny, board);
        if (occ && occ.faction !== unit.faction && (!visionObj || visionObj.detectedEnemyIds.has(occ.id))) {
          continue;
        }

        let stepCost = getMoveStepCost(cur.x, cur.y, nx, ny, board);
        if (cur.x === unit.x && cur.y === unit.y && startsInZoc) {
          stepCost += 1;
        }

        const newCost = cur.cost + stepCost;
        if (newCost > maxMp) continue;

        const newSteps = cur.steps + 1;
        const nextLocked = isInEnemyShieldZoc(nx, ny, unit.faction, visionObj, board);
        const nKey = keyOf(nx, ny);
        const prev = best.get(nKey);

        if (!prev || newCost < prev.cost || (newCost === prev.cost && newSteps < prev.steps)) {
          const node = {
            x: nx, y: ny, cost: newCost, steps: newSteps, locked: nextLocked, parentKey: curKey
          };
          best.set(nKey, node);
          open.push(node);
        }
      }
    }

    const result = new Map();
    for (const [k, node] of best.entries()) {
      if (k === startKey) continue;
      const occ = getUnitAt(node.x, node.y, board);
      if (occ && occ.faction === unit.faction) continue;

      const path = [];
      let pKey = k;
      while (pKey !== null) {
        const pNode = best.get(pKey);
        path.unshift({ x: pNode.x, y: pNode.y });
        pKey = pNode.parentKey;
      }
      result.set(k, {
        x: node.x,
        y: node.y,
        cost: node.cost,
        steps: node.steps,
        entersZoc: node.locked,
        path
      });
    }
    return result;
  }

  function canUnitAttackTargetWithVision(attacker, target, visionObj, board) {
    if (!attacker || !target || !attacker.alive || !target.alive) return false;
    if (attacker.faction === target.faction) return false;
    if (visionObj && !visionObj.detectedEnemyIds.has(target.id)) return false;

    const dist = manhattan(attacker.x, attacker.y, target.x, target.y);
    const atkElev = board.map[attacker.y][attacker.x].elev;
    const defElev = board.map[target.y][target.x].elev;

    if (attacker.type === 'archer') {
      const maxRange = atkElev === 1 ? 4 : 3;
      return dist >= 2 && dist <= maxRange;
    }

    if (attacker.type === 'spear') {
      const dx = target.x - attacker.x;
      const dy = target.y - attacker.y;
      if (dx !== 0 && dy !== 0) return false;
      if (dist === 1) return true;
      if (dist === 2) {
        if (atkElev === 0 && defElev === 1) return false;
        const mx = attacker.x + dx / 2;
        const my = attacker.y + dy / 2;
        if (atkElev === 0 && board.map[my][mx].elev === 1) return false;
        const midUnit = getUnitAt(mx, my, board);
        if (midUnit && midUnit.faction !== attacker.faction) return false;
        return true;
      }
      return false;
    }

    return dist === 1;
  }

  function getValidAttackTargetsFor(attacker, visionObj, board) {
    const ids = new Set();
    for (const u of board.units) {
      if (u.alive && u.faction !== attacker.faction && canUnitAttackTargetWithVision(attacker, u, visionObj, board)) {
        ids.add(u.id);
      }
    }
    return ids;
  }

  function countAdjacentUnits(x, y, targetFaction, board, excludeId = null) {
    let count = 0;
    for (const d of DIRS) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (!inBounds(nx, ny)) continue;
      const u = getUnitAt(nx, ny, board);
      if (u && u.faction === targetFaction && u.id !== excludeId) count++;
    }
    return count;
  }

  function hasFlagAura(unit, board) {
    if (unit.type === 'flag') return false;
    const flag = getAliveFlag(unit.faction, board);
    if (!flag) return false;
    const d = manhattan(unit.x, unit.y, flag.x, flag.y);
    return d >= 1 && d <= 2;
  }

  function isChargeActive(attacker, chargeDisplacement, board) {
    return (
      attacker.type === 'cavalry' &&
      chargeDisplacement >= 3 &&
      board.map[attacker.y][attacker.x].terrain !== 'forest'
    );
  }

  function calcEffectiveAtk(attacker, defender, dist, isCounter, chargeDisplacement, board) {
    const def = UNIT_DEFS[attacker.type];
    let total = def.baseAtk;
    const items = [{ label: '基礎攻擊', val: def.baseAtk }];

    if (hasFlagAura(attacker, board)) {
      total += 1;
      items.push({ label: '軍旗激勵', val: +1 });
    }

    const atkElev = board.map[attacker.y][attacker.x].elev;
    const defElev = board.map[defender.y][defender.x].elev;
    if (atkElev > defElev) {
      total += 1;
      items.push({ label: '高打低', val: +1 });
    } else if (atkElev < defElev) {
      total -= 1;
      items.push({ label: '低打高', val: -1 });
    }

    if (!isCounter && attacker.type === 'spear' && dist === 2) {
      total -= 1;
      items.push({ label: '長柄距2', val: -1 });
    }

    if (attacker.type === 'spear' && defender.type === 'cavalry') {
      total += 2;
      items.push({ label: '反騎槍陣', val: +2 });
    }

    const charged = !isCounter && isChargeActive(attacker, chargeDisplacement, board);
    if (charged) {
      total += 2;
      items.push({ label: `衝鋒⚡(位移${chargeDisplacement})`, val: +2 });
    }

    return { total, items, charged };
  }

  function calcEffectiveDef(defender, attacker, dist, isShattered, board) {
    const def = UNIT_DEFS[defender.type];
    let total = def.baseDef;
    const items = [{ label: '基礎防禦', val: def.baseDef }];

    if (hasFlagAura(defender, board)) {
      total += 1;
      items.push({ label: '軍旗激勵', val: +1 });
    }

    const defTerrain = board.map[defender.y][defender.x].terrain;
    if (defTerrain === 'forest') {
      total += 1;
      items.push({ label: '樹林掩護', val: +1 });
      if (dist >= 2) {
        total += 1;
        items.push({ label: '林內遠程減傷', val: +1 });
      }
    }

    if (defender.type === 'shield' && dist >= 2) {
      total += 2;
      items.push({ label: '盾牌格擋', val: +2 });
    }

    // 鄰接友軍援護（即便被破盾衝散仍照常計算）
    const allyAdj = countAdjacentUnits(defender.x, defender.y, defender.faction, board, defender.id);
    const supportBonus = Math.min(2, allyAdj);
    if (supportBonus > 0) {
      total += supportBonus;
      items.push({ label: `鄰接援護(${allyAdj}友)`, val: +supportBonus });
    }

    const enemyAdj = countAdjacentUnits(defender.x, defender.y, opponentOf(defender.faction), board);
    const isFlanked = enemyAdj >= 2;
    if (isFlanked) {
      total -= 2;
      items.push({ label: `夾擊破防(${enemyAdj}敵)`, val: -2 });
    }

    // 輕騎衝鋒破盾衝散：對重盾步兵額外破防 -3 且使其無法反擊
    if (isShattered) {
      total -= 3;
      items.push({ label: '破盾衝散⚡', val: -3 });
    }

    return { total, items, isFlanked, supportBonus };
  }

  function previewCombat(attacker, defender, chargeDisplacement, board) {
    const dist = manhattan(attacker.x, attacker.y, defender.x, defender.y);
    const atkRes = calcEffectiveAtk(attacker, defender, dist, false, chargeDisplacement, board);
    const isShattered = atkRes.charged && defender.type === 'shield';
    const defRes = calcEffectiveDef(defender, attacker, dist, isShattered, board);

    const damage = Math.max(1, atkRes.total - defRes.total);
    const defenderSurvives = (defender.hp - damage) > 0;

    let canCounter = true;
    let noCounterReason = '';
    if (!defenderSurvives) {
      canCounter = false;
      noCounterReason = '守方預計陣亡';
    } else if (dist !== 1) {
      canCounter = false;
      noCounterReason = '遠程攻擊無法反擊';
    } else if (defRes.isFlanked) {
      canCounter = false;
      noCounterReason = '守方遭夾擊無法反擊';
    } else if (isShattered) {
      canCounter = false;
      noCounterReason = '重盾遭衝鋒衝散無法反擊';
    } else if (defender.type === 'archer') {
      canCounter = false;
      noCounterReason = '弓手無法近戰反擊';
    }

    let counterDamage = 0;
    let counterAtkRes = null;
    let counterDefRes = null;

    if (canCounter) {
      counterAtkRes = calcEffectiveAtk(defender, attacker, 1, true, 0, board);
      counterDefRes = calcEffectiveDef(attacker, defender, 1, false, board);
      counterDamage = Math.max(0, counterAtkRes.total - 1 - counterDefRes.total);
    }

    return {
      dist,
      atkRes,
      defRes,
      isShattered,
      damage,
      defenderSurvives,
      canCounter,
      noCounterReason,
      counterDamage,
      counterAtkRes,
      counterDefRes,
      attackerSurvives: (attacker.hp - counterDamage) > 0
    };
  }

  function countOccupiedHills(faction, board) {
    return board.units.filter(
      u => u.alive && u.faction === faction && board.map[u.y][u.x].terrain === 'hill'
    ).length;
  }

  function evaluateVictory(board) {
    const blueFlag = getAliveFlag('blue', board);
    const redFlag = getAliveFlag('red', board);
    if (!blueFlag && !redFlag) {
      return { over: true, winner: 'draw', reason: '雙方旗手同歸於盡，平手！' };
    }
    if (!redFlag) {
      return { over: true, winner: 'blue', reason: '成功斬首紅方旗手！' };
    }
    if (!blueFlag) {
      return { over: true, winner: 'red', reason: '藍方旗手陣亡，紅方斬首成功！' };
    }
    return { over: false, winner: null, reason: '' };
  }

  function evaluateTurnLimitVictory(board) {
    const blueUnits = board.units.filter(u => u.alive && u.faction === 'blue');
    const redUnits = board.units.filter(u => u.alive && u.faction === 'red');
    const blueHp = blueUnits.reduce((s, u) => s + u.hp, 0);
    const redHp = redUnits.reduce((s, u) => s + u.hp, 0);

    if (blueHp > redHp) {
      return { over: true, winner: 'blue', reason: `滿 ${MAX_TURNS} 回合，藍方總剩餘生命值勝出（${blueHp} vs ${redHp}）！` };
    }
    if (redHp > blueHp) {
      return { over: true, winner: 'red', reason: `滿 ${MAX_TURNS} 回合，紅方總剩餘生命值勝出（${redHp} vs ${blueHp}）！` };
    }

    const blueHills = countOccupiedHills('blue', board);
    const redHills = countOccupiedHills('red', board);
    if (blueHills > redHills) {
      return { over: true, winner: 'blue', reason: `滿 ${MAX_TURNS} 回合且總 HP 同分（${blueHp}），藍方佔領高地格數較多勝出（${blueHills} vs ${redHills}）！` };
    }
    if (redHills > blueHills) {
      return { over: true, winner: 'red', reason: `滿 ${MAX_TURNS} 回合且總 HP 同分（${blueHp}），紅方佔領高地格數較多勝出（${redHills} vs ${blueHills}）！` };
    }

    return { over: true, winner: 'draw', reason: `滿 ${MAX_TURNS} 回合，雙方總 HP（${blueHp}）與高地佔領數（${blueHills}）皆相同，握手言和！` };
  }

  /**
   * 僅根據己方觀測盤面與視野，產生所有合法候選動作（供新演算法與驗證器使用）
   */
  function generateLegalActions(board, vision, faction) {
    const actions = [];
    const myUnits = board.units.filter(u => u.alive && u.faction === faction);
    for (const unit of myUnits) {
      const standTargets = getValidAttackTargetsFor(unit, vision, board);
      for (const targetId of standTargets) {
        actions.push({ type: 'stand_attack', unitId: unit.id, targetId });
      }
      const reachMap = computeReachableFor(unit, vision, board);
      const origX = unit.x;
      const origY = unit.y;
      for (const info of reachMap.values()) {
        const path = info.path.map(({ x, y }) => ({ x, y }));
        actions.push({
          type: 'move',
          unitId: unit.id,
          tx: info.x,
          ty: info.y,
          path
        });
        unit.x = info.x;
        unit.y = info.y;
        try {
          const targets = getValidAttackTargetsFor(unit, vision, board);
          for (const targetId of targets) {
            actions.push({
              type: 'move_attack',
              unitId: unit.id,
              tx: info.x,
              ty: info.y,
              path: path.map(({ x, y }) => ({ x, y })),
              targetId
            });
          }
        } finally {
          unit.x = origX;
          unit.y = origY;
        }
      }
    }
    actions.push({ type: 'skip' });
    return actions;
  }

  /**
   * 動作合法性守門員：嚴格檢驗演算法輸出是否符合迷霧與棋盤規則
   */
  function validateAction(action, board, vision, faction) {
    if (!action || typeof action !== 'object') {
      return { valid: false, reason: '動作必須是非空物件' };
    }
    if (action.type === 'skip') {
      return { valid: true, action: { type: 'skip' } };
    }
    if (action.type !== 'stand_attack' && action.type !== 'move' && action.type !== 'move_attack') {
      return { valid: false, reason: `不支援的動作類型：${String(action.type)}` };
    }

    const unit = getUnitById(action.unitId, board);
    if (!unit || !unit.alive || unit.faction !== faction) {
      return { valid: false, reason: `無效的己方單位：${String(action.unitId)}` };
    }

    if (action.type === 'stand_attack') {
      const target = getUnitById(action.targetId, board);
      if (!target || !canUnitAttackTargetWithVision(unit, target, vision, board)) {
        return { valid: false, reason: `原地攻擊目標不合法：${String(action.targetId)}` };
      }
      return {
        valid: true,
        action: { type: 'stand_attack', unitId: unit.id, targetId: target.id }
      };
    }

    // move 或 move_attack：驗證路徑
    if (!Array.isArray(action.path) || action.path.length < 2) {
      return { valid: false, reason: '移動路徑必須為長度 ≥ 2 的座標陣列' };
    }
    const path = [];
    for (const pt of action.path) {
      if (!pt || !Number.isInteger(pt.x) || !Number.isInteger(pt.y) || !inBounds(pt.x, pt.y)) {
        return { valid: false, reason: '路徑包含超出邊界或非整數座標' };
      }
      path.push({ x: pt.x, y: pt.y });
    }
    if (path[0].x !== unit.x || path[0].y !== unit.y) {
      return { valid: false, reason: `路徑起點 (${path[0].x},${path[0].y}) 與單位位置 (${unit.x},${unit.y}) 不符` };
    }

    const maxMp = UNIT_DEFS[unit.type].mp;
    const startsInZoc = isInEnemyShieldZoc(unit.x, unit.y, faction, vision, board);
    let spent = 0;
    let enteredZoc = false;
    for (let i = 1; i < path.length; i++) {
      if (enteredZoc) {
        return { valid: false, reason: '踏入可見敵方重盾 ZoC 後不可繼續移動' };
      }
      const prev = path[i - 1];
      const next = path[i];
      if (manhattan(prev.x, prev.y, next.x, next.y) !== 1) {
        return { valid: false, reason: `路徑第 ${i} 步非相鄰四方向移動` };
      }
      const occ = getUnitAt(next.x, next.y, board);
      if (occ && occ.faction !== faction && (!vision || vision.detectedEnemyIds.has(occ.id))) {
        return { valid: false, reason: `路徑試圖踏入可見敵軍格 (${next.x},${next.y})` };
      }
      let stepCost = getMoveStepCost(prev.x, prev.y, next.x, next.y, board);
      if (i === 1 && startsInZoc) stepCost += 1;
      spent += stepCost;
      if (spent > maxMp) {
        return { valid: false, reason: `移動消耗 ${spent} MP 超過上限 ${maxMp} MP` };
      }
      if (isInEnemyShieldZoc(next.x, next.y, faction, vision, board)) {
        enteredZoc = true;
      }
    }

    const dest = path[path.length - 1];
    const destOcc = getUnitAt(dest.x, dest.y, board);
    if (destOcc && destOcc.id !== unit.id && destOcc.faction === faction) {
      return { valid: false, reason: `終點 (${dest.x},${dest.y}) 已被己方單位佔據` };
    }

    if (action.type === 'move') {
      return {
        valid: true,
        action: { type: 'move', unitId: unit.id, tx: dest.x, ty: dest.y, path }
      };
    }

    // move_attack：驗證在終點是否可攻指定目標（以起點合法視野檢驗）
    const target = getUnitById(action.targetId, board);
    if (!target || !target.alive || target.faction === faction) {
      return { valid: false, reason: `移動攻擊目標無效：${String(action.targetId)}` };
    }
    const origX = unit.x;
    const origY = unit.y;
    let canHit = false;
    try {
      unit.x = dest.x;
      unit.y = dest.y;
      canHit = canUnitAttackTargetWithVision(unit, target, vision, board);
    } finally {
      unit.x = origX;
      unit.y = origY;
    }
    if (!canHit) {
      return { valid: false, reason: `移動至 (${dest.x},${dest.y}) 後無法合法攻擊目標 ${target.id}` };
    }

    return {
      valid: true,
      action: { type: 'move_attack', unitId: unit.id, tx: dest.x, ty: dest.y, path, targetId: target.id }
    };
  }

  return Object.freeze({
    BOARD_SIZE,
    MAX_TURNS,
    CELL_COUNT,
    VISION_WORDS,
    DIRS,
    HILL_COORDS,
    FOREST_COORDS,
    UNIT_DEFS,
    TYPE_NAMES,
    INITIAL_BLUE_UNITS,
    BLUE_SLOTS,
    keyOf,
    inBounds,
    manhattan,
    cellIndex,
    opponentOf,
    factionName,
    getTerrainName,
    createTerrainGrid,
    createInitialUnits,
    cloneMap,
    getUnitById,
    getUnitAt,
    getAliveFlag,
    hasLineOfSight,
    computeVisionData,
    isTileScanned,
    createObservedBoard,
    isInEnemyShieldZoc,
    getMoveStepCost,
    computeReachableFor,
    canUnitAttackTargetWithVision,
    getValidAttackTargetsFor,
    countAdjacentUnits,
    hasFlagAura,
    isChargeActive,
    calcEffectiveAtk,
    calcEffectiveDef,
    previewCombat,
    countOccupiedHills,
    evaluateVictory,
    evaluateTurnLimitVictory,
    generateLegalActions,
    validateAction
  });
});
