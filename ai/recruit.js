/* =========================================================
 * 迷霧陣線 AI 演算法：新兵 · 單步評估（recruit）
 * 完全自包含單檔，遵循 TFC AI Protocol v1。
 * 保留原版評估權重與前 4 手機率抽樣，100% 嚴格零作弊。
 * ========================================================= */
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
    id: 'recruit',
    name: '新兵',
    label: '新兵 · 單步評估',
    order: 10,
    coordinateSpace: 'canonical',
    thinkingText: '推演中…',
    pacingDelayMs: 350,
    timeoutMs: 10000,

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

      const flankBias = agentRng() < 0.5 ? -1 : 1;

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

      return {
        onEvent() {},
        decideTurn(obs, runtime) {
          const observation = {
            faction: obs.realFaction,
            board: obs.board,
            redVision: obs.vision,
            turn: obs.turn,
            flankBias,
            beliefs: null,
            particles: null,
            memory: null,
            turnsSinceDamage: 0
          };
          return chooseRedAiAction(observation, runtime.rng || agentRng);
        },
        decidePostMoveAttack(postObs, ctx) {
          const observation = {
            faction: postObs.realFaction,
            board: postObs.board,
            redVision: postObs.vision,
            turn: postObs.turn,
            flankBias,
            beliefs: null,
            particles: null,
            memory: null,
            turnsSinceDamage: 0
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
