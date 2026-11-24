(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TFCBoard25D = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =========================================================
   * 迷霧陣線（Tactical Fog Chess）2.5D 高清奇幻微縮沙盤渲染器
   * 零外部套件、純原生 HTML5 Canvas 2D、支援 HiDPI、
   * 4 向 90° 旋轉、游標中心縮放、6px 防誤觸平移、
   * 逆畫家序精確解析點格與嚴格迷霧零洩密特效。
   * ========================================================= */

  const BOARD_SIZE = 10;
  const MIN_ZOOM = 0.85;
  const MAX_ZOOM = 2.4;
  const DRAG_THRESHOLD_PX = 6;
  const TOUCH_DRAG_THRESHOLD_PX = 8;

  const keyOf = (x, y) => `${x},${y}`;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  // 決定性雜湊：確保每格草叢、石塊、樹群紋理自然多樣且跨幀與旋轉穩定
  function tileHash(x, y, salt = 0) {
    let n = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    n = n ^ (n >>> 16);
    return (n >>> 0) / 4294967296;
  }

  function toRotated(x, y, rot) {
    if (rot === 0) return { rx: x, ry: y };
    if (rot === 1) return { rx: BOARD_SIZE - 1 - y, ry: x };
    if (rot === 2) return { rx: BOARD_SIZE - 1 - x, ry: BOARD_SIZE - 1 - y };
    return { rx: y, ry: BOARD_SIZE - 1 - x };
  }

  function fromRotated(rx, ry, rot) {
    if (rot === 0) return { x: rx, y: ry };
    if (rot === 1) return { x: ry, y: BOARD_SIZE - 1 - rx };
    if (rot === 2) return { x: BOARD_SIZE - 1 - rx, y: BOARD_SIZE - 1 - ry };
    return { x: BOARD_SIZE - 1 - ry, y: rx };
  }

  function facingSignFor(faction, rot) {
    // 藍方預設朝 y 減小方向前進，紅方朝 y 增大方向前進
    const dy = faction === 'blue' ? -1 : 1;
    const p0 = toRotated(5, 5, rot);
    const p1 = toRotated(5, 5 + dy, rot);
    const dxIso = (p1.rx - p1.ry) - (p0.rx - p0.ry);
    return dxIso >= 0 ? 1 : -1;
  }

  function drawRoundedRectPath(ctx, x, y, w, h, r) {
    let tl, tr, br, bl;
    if (Array.isArray(r)) {
      [tl, tr, br, bl] = r;
    } else {
      tl = tr = br = bl = r;
    }
    const maxR = Math.min(w / 2, h / 2);
    tl = Math.min(tl, maxR);
    tr = Math.min(tr, maxR);
    br = Math.min(br, maxR);
    bl = Math.min(bl, maxR);
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
  }

  function create(hostEl, callbacks = {}, options = {}) {
    const canvas = hostEl.querySelector('canvas');
    if (!canvas) throw new Error('TFCBoard25D 需要 hostEl 內的 <canvas>');
    const ctx = canvas.getContext('2d', { alpha: false });

    let active = false;
    let width = 720;
    let height = 540;
    let dpr = 1;
    let rafId = null;
    let lastFrameAt = 0;
    let idleTimer = null;
    let lastInteraction = -Infinity;
    let lastInteractiveFrame = null;
    let interactionFrameCount = 0;
    let interactionFrameTotal = 0;
    let quality = options.quality === 'standard' ? 'standard' : 'high';
    let showHudDetails = false;
    let gridVisible = true;
    let backgroundCache = null;
    let plinthCache = null;
    let cameraLayer = null;
    let cameraLayerValid = false;
    let orderedTiles = null;
    let orderedRotation = null;
    let assetVersion = 0;
    let lastPointer = null;

    const assets = globalThis.TFC25DAssets?.create(name => {
      if (!name.startsWith('units/')) assetVersion++;
      invalidateBoard();
    });
    const getAsset = name => assets?.get(name) || null;
    const makeCanvas = () => canvas.ownerDocument.createElement('canvas');
    const terrainModule = globalThis.TFC25DTerrain;
    const terrainRenderer = terrainModule.create({
      assets: getAsset, canvas: makeCanvas, tileHash
    });
    const unitArt = globalThis.TFCBoard25DUnits.create({
      getAsset, getQuality: () => quality, isReducedMotion, getFactionPalette,
      drawUnitSculpt, drawRoundedRectPath, facingSignFor
    });

    // 鏡頭狀態（rot: 0..3，zoom: 0.85..2.4，panX/panY: CSS px）
    const camera = {
      rot: 0,
      theta: 0,
      rotation: null,
      zoom: 1,
      panX: 0,
      panY: 0,
      anim: null // { start, dur, fromZoom, toZoom, fromPanX, toPanX, fromPanY, toPanY }
    };

    // 場景資料與懸停狀態
    let scene = null;
    let hover = { hoveredTile: null, previewPath: [] };
    let unitHitBoxes = []; // 由遠到近記錄本幀可見單位的互動框（以基礎座標系儲存）
    let activeEffects = []; // 移動滑行／攻擊箭矢／衝鋒／受擊／伏擊動畫
    let pulseStart = 0;

    // 互動指標追蹤（支援滑鼠拖曳與雙指縮放）
    const pointers = new Map();
    let dragState = null; // { pointerId, button, downX, downY, startPanX, startPanY, moved }
    let pinchState = null; // { startDist, startZoom, midBaseX, midBaseY }

    const reducedMotionQuery = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;

    function isReducedMotion() {
      return Boolean(reducedMotionQuery && reducedMotionQuery.matches);
    }

    function getMetrics() {
      // 10×10 菱形橫跨 10*tw，縱跨 10*th + 台座厚 + 高地 + 頂部單位旗幟空間，100% 滿版舒展
      const tw = Math.min(width * 0.094, height * 0.162);
      const th = tw * 0.50;
      const elevH = th * 0.47; // 不讓高地頂面壓過後方平地的格心
      const baseDepth = th * 0.54;
      const originX = width * 0.5;
      const originY = height * 0.5 - (BOARD_SIZE - 1) * (th * 0.5) + th * 0.08;
      return { tw, th, elevH, baseDepth, originX, originY };
    }

    function rotatedPoint(x, y) {
      if (!camera.rotation) return toRotated(x, y, camera.rot);
      const center = (BOARD_SIZE - 1) * 0.5;
      const cos = Math.cos(camera.theta);
      const sin = Math.sin(camera.theta);
      return {
        rx: center + (x - center) * cos - (y - center) * sin,
        ry: center + (x - center) * sin + (y - center) * cos
      };
    }

    function projectBase(x, y, elev = 0, metrics = getMetrics()) {
      const { rx, ry } = rotatedPoint(x, y);
      const bx = metrics.originX + (rx - ry) * (metrics.tw * 0.5);
      const by = metrics.originY + (rx + ry) * (metrics.th * 0.5) - elev * metrics.elevH;
      return { bx, by, rx, ry };
    }

    const projectFloatBase = projectBase;

    function baseToScreen(bx, by) {
      return {
        sx: (bx - width * 0.5) * camera.zoom + width * 0.5 + camera.panX,
        sy: (by - height * 0.5) * camera.zoom + height * 0.5 + camera.panY
      };
    }

    function screenToBase(sx, sy) {
      return {
        bx: (sx - width * 0.5 - camera.panX) / camera.zoom + width * 0.5,
        by: (sy - height * 0.5 - camera.panY) / camera.zoom + height * 0.5
      };
    }

    function clampPan() {
      const maxX = width * 0.44 * camera.zoom;
      const maxY = height * 0.44 * camera.zoom;
      camera.panX = clamp(camera.panX, -maxX, maxX);
      camera.panY = clamp(camera.panY, -maxY, maxY);
    }

    function markDirty() {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (active && !canvas.ownerDocument.hidden && rafId === null) {
        rafId = requestAnimationFrame(loop);
      }
    }

    function invalidateBoard() {
      cameraLayerValid = false;
      markDirty();
    }

    function emitCameraChange(isDragging = false) {
      if (typeof callbacks.onCameraChange === 'function') {
        callbacks.onCameraChange({
          zoom: camera.zoom,
          rot: camera.rot,
          panX: camera.panX,
          panY: camera.panY,
          isDragging,
          isRotating: Boolean(camera.rotation)
        });
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nextW = Math.max(280, Math.round(rect.width));
      const nextH = Math.max(220, Math.round(rect.height));
      const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
      if (nextW === width && nextH === height && nextDpr === dpr && canvas.width === Math.round(nextW * nextDpr)) {
        return;
      }
      width = nextW;
      height = nextH;
      dpr = nextDpr;
      backgroundCache = null;
      plinthCache = null;
      cameraLayer = null;
      cameraLayerValid = false;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      clampPan();
      markDirty();
      emitCameraChange(false);
    }

    /* =========================================================
     * 精確逆畫家序解析命中檢測（零反鋸齒縫隙、零 GPU 回讀延遲、
     * 支援任意縮放／平移／4 向旋轉與高地海拔立體遮擋）
     * ========================================================= */
    function hitTestTileAnalytic(bx, by, metrics) {
      const { tw, th, elevH } = metrics;
      const halfW = tw * 0.5;
      const halfH = th * 0.5;
      const map = scene.board.map;
      const project = (x, y, elev) => projectBase(x, y, elev, metrics);

      // 由最前景往最背景逐格檢測：先命中的即為玩家眼前最靠前的表面（含高地頂面與碎石坡）
      for (let sum = (BOARD_SIZE - 1) * 2; sum >= 0; sum--) {
        for (let rx = BOARD_SIZE - 1; rx >= 0; rx--) {
          const ry = sum - rx;
          if (ry < 0 || ry >= BOARD_SIZE) continue;
          const { x, y } = fromRotated(rx, ry, camera.rot);
          const elev = map[y][x].elev || 0;
          const cx = metrics.originX + (rx - ry) * halfW;
          const cy = metrics.originY + (rx + ry) * halfH - elev * elevH;

          const dx = Math.abs(bx - cx);
          if (dx > halfW) continue;
          if (elev) {
            if (by < cy - halfH || by > cy + halfH + elev * elevH) continue;
            const hill = terrainModule.projectHill(map, x, y, project);
            if (terrainModule.hillContains(hill, bx, by)) return { x, y };
          } else if (dx / halfW + Math.abs(by - cy) / halfH <= 1.0005) {
            return { x, y };
          }
        }
      }
      return null;
    }

    function pickTileAtClient(clientX, clientY) {
      if (!scene || !scene.board || camera.rotation) return null;
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      if (sx < 0 || sy < 0 || sx >= rect.width || sy >= rect.height) return null;

      const { bx, by } = screenToBase(sx, sy);

      // 1. 優先檢查可見棋子下半主體（由最前景往後檢查），方便直接點選立體棋身
      for (let i = unitHitBoxes.length - 1; i >= 0; i--) {
        const hb = unitHitBoxes[i];
        if (!scene.visibleUnitsByKey.has(keyOf(hb.x, hb.y))) continue;
        if (bx >= hb.left && bx <= hb.right && by >= hb.top && by <= hb.bottom) {
          return { x: hb.x, y: hb.y };
        }
      }

      // 2. 逆畫家序精確解析命中檢測
      return hitTestTileAnalytic(bx, by, getMetrics());
    }

    /* =========================================================
     * 奇幻自然地景繪製（平地草甸、層岩高地、蔥鬱松林、台座與座標）
     * ========================================================= */
    function drawDiamondPath(c, cx, cy, halfW, halfH) {
      c.beginPath();
      c.moveTo(cx, cy - halfH);
      c.lineTo(cx + halfW, cy);
      c.lineTo(cx, cy + halfH);
      c.lineTo(cx - halfW, cy);
      c.closePath();
    }

    function drawDioramaPlinth(c, metrics) {
      const { tw, th, baseDepth, originX, originY } = metrics;
      const halfW = tw * 0.5;
      const halfH = th * 0.5;

      // 四角點（最遠、最右、最近、最左）
      const topX = originX;
      const topY = originY - halfH;
      const rightX = originX + BOARD_SIZE * halfW;
      const rightY = originY + (BOARD_SIZE - 1) * halfH;
      const bottomX = originX;
      const bottomY = originY + (BOARD_SIZE * 2 - 1) * halfH;
      const leftX = originX - BOARD_SIZE * halfW;
      const leftY = originY + (BOARD_SIZE - 1) * halfH;

      // 沙盤底座落地柔影
      c.save();
      c.fillStyle = 'rgba(2, 6, 16, 0.62)';
      c.beginPath();
      c.moveTo(topX, topY + baseDepth + th * 0.35);
      c.lineTo(rightX + tw * 0.16, rightY + baseDepth + th * 0.42);
      c.lineTo(bottomX, bottomY + baseDepth + th * 0.65);
      c.lineTo(leftX - tw * 0.16, leftY + baseDepth + th * 0.42);
      c.closePath();
      c.fill();
      c.restore();

      const plinthH = baseDepth * 1.15;
      // 左前石土斷面（受光面）
      const leftGrad = c.createLinearGradient(leftX, leftY, leftX, leftY + plinthH);
      leftGrad.addColorStop(0, '#5a4a3a');
      leftGrad.addColorStop(0.28, '#46382c');
      leftGrad.addColorStop(1, '#261f1a');
      c.fillStyle = leftGrad;
      c.beginPath();
      c.moveTo(leftX, leftY);
      c.lineTo(bottomX, bottomY);
      c.lineTo(bottomX, bottomY + plinthH);
      c.lineTo(leftX, leftY + plinthH);
      c.closePath();
      c.fill();

      // 右前石土斷面（背光面）
      const rightGrad = c.createLinearGradient(rightX, rightY, rightX, rightY + plinthH);
      rightGrad.addColorStop(0, '#3e3329');
      rightGrad.addColorStop(0.3, '#2d251e');
      rightGrad.addColorStop(1, '#191411');
      c.fillStyle = rightGrad;
      c.beginPath();
      c.moveTo(bottomX, bottomY);
      c.lineTo(rightX, rightY);
      c.lineTo(rightX, rightY + plinthH);
      c.lineTo(bottomX, bottomY + plinthH);
      c.closePath();
      c.fill();

      // 台座木石邊框收邊亮線
      c.strokeStyle = 'rgba(226, 203, 164, 0.22)';
      c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(leftX, leftY + plinthH * 0.22);
      c.lineTo(bottomX, bottomY + plinthH * 0.22);
      c.lineTo(rightX, rightY + plinthH * 0.22);
      c.stroke();

      // 沿兩條前景邊緣繪製準確對應旋轉方向的座標刻度（0–9）
      const fontSize = clamp(tw * 0.175, 8.5, 13);
      c.font = `800 ${fontSize}px system-ui, "PingFang TC", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';

      const bottomLeftAxis = (camera.rot === 0 || camera.rot === 2) ? 'X' : 'Y';
      const bottomRightAxis = (camera.rot === 0 || camera.rot === 2) ? 'Y' : 'X';

      for (let i = 0; i < BOARD_SIZE; i++) {
        // 左前緣：ry = 9, rx = i（置中於該格左前斜邊中點）
        const blCell = fromRotated(i, BOARD_SIZE - 1, camera.rot);
        const blVal = bottomLeftAxis === 'X' ? blCell.x : blCell.y;
        const blCx = originX + (i - (BOARD_SIZE - 1)) * halfW - halfW * 0.50;
        const blCy = originY + (i + (BOARD_SIZE - 1)) * halfH + halfH * 0.50 + plinthH * 0.56;
        c.fillStyle = 'rgba(232, 220, 196, 0.86)';
        c.fillText(String(blVal), blCx, blCy);

        // 右前緣：rx = 9, ry = i（置中於該格右前斜邊中點）
        const brCell = fromRotated(BOARD_SIZE - 1, i, camera.rot);
        const brVal = bottomRightAxis === 'X' ? brCell.x : brCell.y;
        const brCx = originX + ((BOARD_SIZE - 1) - i) * halfW + halfW * 0.50;
        const brCy = originY + ((BOARD_SIZE - 1) + i) * halfH + halfH * 0.50 + plinthH * 0.56;
        c.fillStyle = 'rgba(202, 192, 172, 0.78)';
        c.fillText(String(brVal), brCx, brCy);
      }

      // 軸名角標（X / Y）
      c.font = `900 ${Math.max(9, fontSize * 0.92)}px system-ui, sans-serif`;
      c.fillStyle = '#fbbf24';
      c.fillText(bottomLeftAxis, leftX - tw * 0.16, leftY + plinthH * 0.65);
      c.fillText(bottomRightAxis, rightX + tw * 0.16, rightY + plinthH * 0.65);
    }

    /* =========================================================
     * 戰術高亮疊層（ZoC、上回合軌跡、可達格、衝鋒格、可攻格、回放標記）
     * ========================================================= */
    function drawTileMarkPath(c, tile, metrics, scale) {
      const { bx, by, hill } = tile;
      if (!hill) {
        drawDiamondPath(c, bx, by, metrics.tw * 0.5 * scale, metrics.th * 0.5 * scale);
        return;
      }
      c.beginPath();
      for (const [i, point] of hill.top.entries()) {
        const x = lerp(bx, point.bx, scale);
        const y = lerp(by, point.by, scale);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
    }

    function drawTileTacticalOverlays(c, tile, metrics, flags, nowSec) {
      const { bx, by } = tile;
      const { tw, th } = metrics;
      const halfW = tw * 0.5;
      const halfH = th * 0.5;
      const pulse = isReducedMotion() ? 0.5 : (0.5 + 0.5 * Math.sin(nowSec * 5.2));

      // 2. 上回合 AI 可見軌跡／攻擊高亮
      if (flags.enemyAttack) {
        drawTileMarkPath(c, tile, metrics, 0.92);
        c.fillStyle = 'rgba(244, 63, 94, 0.28)';
        c.fill();
        c.strokeStyle = 'rgba(244, 63, 94, 0.92)';
        c.lineWidth = 2;
        c.stroke();
      } else if (flags.enemyTrail) {
        drawTileMarkPath(c, tile, metrics, 0.88);
        c.fillStyle = `rgba(249, 115, 22, ${0.18 + pulse * 0.12})`;
        c.fill();
        c.strokeStyle = `rgba(251, 146, 60, ${0.65 + pulse * 0.3})`;
        c.lineWidth = 1.8;
        c.stroke();
      }

      // 4. 伏擊閃爍
      if (flags.ambushFlash) {
        drawTileMarkPath(c, tile, metrics, 0.94);
        c.fillStyle = `rgba(239, 68, 68, ${0.22 + pulse * 0.24})`;
        c.fill();
        c.strokeStyle = pulse > 0.5 ? '#ef4444' : '#f59e0b';
        c.lineWidth = 2.8;
        c.stroke();
      }

      // 5. 可攻擊目標脈動紅框
      if (flags.attackable) {
        drawTileMarkPath(c, tile, metrics, 0.94);
        c.fillStyle = `rgba(239, 68, 68, ${0.24 + pulse * 0.18})`;
        c.fill();
        c.strokeStyle = pulse > 0.5 ? '#fecaca' : '#ef4444';
        c.lineWidth = 2.6;
        c.stroke();
      }

      // 6. 回放標記
      if (flags.replayMarkers && flags.replayMarkers.length) {
        for (const marker of flags.replayMarkers) {
          c.save();
          drawTileMarkPath(c, tile, metrics, 0.88);
          let strokeColor = '#7dd3fc';
          if (marker.kind === 'from') { c.setLineDash([4, 3]); strokeColor = '#7dd3fc'; }
          else if (marker.kind === 'to') strokeColor = '#22d3ee';
          else if (marker.kind === 'hit') strokeColor = '#fb7185';
          else if (marker.kind === 'counter') strokeColor = '#facc15';
          else if (marker.kind === 'alert') strokeColor = '#f59e0b';
          c.strokeStyle = strokeColor;
          c.lineWidth = 2.2;
          c.stroke();
          c.setLineDash([]);

          if (marker.label) {
            c.font = `900 ${clamp(tw * 0.145, 9, 11.5)}px system-ui, "PingFang TC", sans-serif`;
            const twLbl = c.measureText(marker.label).width + 8;
            const thLbl = 14;
            const lx = bx + halfW * 0.36;
            const ly = by - halfH * 0.48;
            drawRoundedRectPath(c, lx - twLbl * 0.5, ly - thLbl * 0.5, twLbl, thLbl, 3);
            c.fillStyle = 'rgba(2, 6, 23, 0.9)';
            c.fill();
            c.strokeStyle = strokeColor;
            c.lineWidth = 1;
            c.stroke();
            c.fillStyle = '#f8fafc';
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.fillText(marker.label, lx, ly + 0.5);
          }
          c.restore();
        }
      }

      // 7. 滑鼠懸停格亮邊
      if (flags.isHovered) {
        drawTileMarkPath(c, tile, metrics, 0.96);
        c.strokeStyle = 'rgba(255, 255, 255, 0.88)';
        c.lineWidth = 2;
        c.stroke();
      }
    }

    /* =========================================================
     * 五兵種純造型奇幻微縮棋子（不含漢字，造型辨識度極高）
     * ========================================================= */
    function getFactionPalette(faction, isGhost) {
      if (isGhost) {
        return faction === 'blue'
          ? {
              baseTop: 'rgba(59, 130, 246, 0.52)',
              baseSide: 'rgba(30, 58, 138, 0.58)',
              rim: 'rgba(191, 219, 254, 0.72)',
              primary: 'rgba(96, 165, 250, 0.72)',
              dark: 'rgba(30, 64, 175, 0.72)',
              accent: 'rgba(219, 234, 254, 0.82)',
              metal: 'rgba(203, 213, 225, 0.75)',
              metalDark: 'rgba(100, 116, 139, 0.7)',
              gold: 'rgba(253, 224, 71, 0.75)',
              horse: 'rgba(148, 163, 184, 0.7)',
              horseDark: 'rgba(71, 85, 105, 0.7)'
            }
          : {
              baseTop: 'rgba(239, 68, 68, 0.52)',
              baseSide: 'rgba(127, 29, 29, 0.58)',
              rim: 'rgba(254, 202, 202, 0.72)',
              primary: 'rgba(248, 113, 113, 0.72)',
              dark: 'rgba(153, 27, 27, 0.72)',
              accent: 'rgba(254, 226, 226, 0.82)',
              metal: 'rgba(203, 213, 225, 0.75)',
              metalDark: 'rgba(100, 116, 139, 0.7)',
              gold: 'rgba(253, 224, 71, 0.75)',
              horse: 'rgba(180, 140, 130, 0.7)',
              horseDark: 'rgba(100, 65, 60, 0.7)'
            };
      }
      return faction === 'blue'
        ? {
            baseTop: '#2563eb',
            baseSide: '#172554',
            rim: '#93c5fd',
            primary: '#2563eb',
            dark: '#1e3a8a',
            accent: '#bfdbfe',
            metal: '#e2e8f0',
            metalDark: '#64748b',
            gold: '#fbbf24',
            horse: '#e7dfd3',
            horseDark: '#9e9282'
          }
        : {
            baseTop: '#dc2626',
            baseSide: '#450a0a',
            rim: '#fca5a5',
            primary: '#dc2626',
            dark: '#7f1d1d',
            accent: '#fecaca',
            metal: '#e2e8f0',
            metalDark: '#64748b',
            gold: '#f59e0b',
            horse: '#8c5338',
            horseDark: '#4f2a1a'
          };
    }

    function drawUnitSculpt(c, type, pal, s, dir, nowSec, isGhost) {
      c.save();
      c.scale(dir, 1); // 面對敵陣

      if (type === 'flag') {
        // 【旗手】高聳金色戰旗＋飄揚燕尾大旗＋披風持旗官
        const wave = (isReducedMotion() || isGhost) ? 0 : Math.sin(nowSec * 4.2) * 1.6 * s;

        // 披風與身軀
        c.fillStyle = pal.dark;
        c.beginPath();
        c.moveTo(-7.5 * s, -2 * s);
        c.quadraticCurveTo(-9.5 * s, -10 * s, -4.5 * s, -16.5 * s);
        c.lineTo(3.5 * s, -16.5 * s);
        c.lineTo(5 * s, -2 * s);
        c.closePath();
        c.fill();

        c.fillStyle = pal.primary;
        drawRoundedRectPath(c, -4.5 * s, -16.5 * s, 8.5 * s, 14.5 * s, 3 * s);
        c.fill();

        // 金邊盔甲肩飾與頭盔
        c.fillStyle = pal.gold;
        c.beginPath();
        c.ellipse(-0.3 * s, -16 * s, 5.5 * s, 2.3 * s, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = pal.metal;
        c.beginPath();
        c.arc(-0.3 * s, -20.5 * s, 4.1 * s, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = pal.gold;
        c.fillRect(-3.8 * s, -21.2 * s, 7 * s, 1.4 * s);

        // 長旗桿（高聳醒目）
        c.strokeStyle = '#78350f';
        c.lineWidth = 2.4 * s;
        c.beginPath();
        c.moveTo(4.2 * s, -1 * s);
        c.lineTo(4.2 * s, -40.5 * s);
        c.stroke();

        // 頂端金色矛尖／星冠
        c.fillStyle = pal.gold;
        c.beginPath();
        c.moveTo(4.2 * s, -45 * s);
        c.lineTo(6.6 * s, -40 * s);
        c.lineTo(4.2 * s, -38.5 * s);
        c.lineTo(1.8 * s, -40 * s);
        c.closePath();
        c.fill();

        // 飄揚燕尾大戰旗
        const flagGrad = c.createLinearGradient(4 * s, -39 * s, -17 * s, -25 * s);
        flagGrad.addColorStop(0, pal.primary);
        flagGrad.addColorStop(1, pal.dark);
        c.fillStyle = flagGrad;
        c.beginPath();
        c.moveTo(3.4 * s, -38.5 * s);
        c.quadraticCurveTo(-5 * s, -40.5 * s + wave, -16.5 * s, -37.2 * s + wave * 1.1);
        c.lineTo(-12.2 * s, -31.5 * s + wave * 0.7);
        c.lineTo(-16.8 * s, -26.2 * s + wave * 0.9);
        c.quadraticCurveTo(-5 * s, -28.5 * s + wave * 0.4, 3.4 * s, -25.8 * s);
        c.closePath();
        c.fill();
        c.strokeStyle = pal.gold;
        c.lineWidth = 1.2 * s;
        c.stroke();

        // 旗面金星徽章
        c.fillStyle = pal.gold;
        c.beginPath();
        const cx = -5.4 * s;
        const cy = -32.2 * s + wave * 0.55;
        for (let i = 0; i < 10; i++) {
          const r = (i % 2 === 0 ? 3.5 : 1.55) * s;
          const ang = -Math.PI / 2 + (i * Math.PI) / 5;
          if (i === 0) c.moveTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
          else c.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
        }
        c.closePath();
        c.fill();
      } else if (type === 'shield') {
        // 【重盾步兵】寬厚鐵緣巨型塔盾＋厚重筒盔，一眼讀出銅牆鐵壁
        // 背後身軀與厚甲
        c.fillStyle = pal.dark;
        drawRoundedRectPath(c, -8.5 * s, -20 * s, 14.5 * s, 18.5 * s, 3.5 * s);
        c.fill();

        // 厚重騎士筒盔
        c.fillStyle = pal.metal;
        drawRoundedRectPath(c, -5.2 * s, -29 * s, 10.2 * s, 10.2 * s, [4.5 * s, 4.5 * s, 2 * s, 2 * s]);
        c.fill();
        c.strokeStyle = pal.metalDark;
        c.lineWidth = 1.1 * s;
        c.stroke();
        // 頭盔眼縫
        c.fillStyle = '#0f172a';
        c.fillRect(-1.5 * s, -24.5 * s, 5.6 * s, 1.7 * s);
        // 盔頂羽脊
        c.fillStyle = pal.gold;
        c.fillRect(-3.8 * s, -30.6 * s, 7.2 * s, 2.1 * s);

        // 巨型弧頂塔盾（前置主視覺）
        const shGrad = c.createLinearGradient(-9 * s, -24 * s, 11 * s, -1 * s);
        shGrad.addColorStop(0, pal.primary);
        shGrad.addColorStop(0.55, pal.dark);
        shGrad.addColorStop(1, '#0f172a');
        c.fillStyle = shGrad;
        c.beginPath();
        c.moveTo(-7.5 * s, -22.5 * s);
        c.quadraticCurveTo(2.2 * s, -25.2 * s, 11.2 * s, -21.8 * s);
        c.lineTo(10.4 * s, -7.2 * s);
        c.quadraticCurveTo(2.4 * s, 1.5 * s, -6.5 * s, -6.8 * s);
        c.closePath();
        c.fill();

        // 精鋼盾框
        c.strokeStyle = pal.metal;
        c.lineWidth = 2.3 * s;
        c.stroke();

        // 盾面十字加強鐵肋與中央金鉚
        c.strokeStyle = pal.accent;
        c.lineWidth = 1.6 * s;
        c.beginPath();
        c.moveTo(2.2 * s, -22.5 * s);
        c.lineTo(2.2 * s, -3.4 * s);
        c.moveTo(-5.8 * s, -14.2 * s);
        c.lineTo(9.8 * s, -14.2 * s);
        c.stroke();

        c.fillStyle = pal.gold;
        c.beginPath();
        c.arc(2.2 * s, -14.2 * s, 2.7 * s, 0, Math.PI * 2);
        c.fill();
      } else if (type === 'spear') {
        // 【長矛兵】輕甲步兵斜舉超長亮銀長矛＋小矛穗
        // 戰甲軀幹與陣營罩袍
        c.fillStyle = pal.dark;
        c.beginPath();
        c.moveTo(-6.2 * s, -1.5 * s);
        c.lineTo(-4.8 * s, -18.5 * s);
        c.lineTo(4.2 * s, -18.5 * s);
        c.lineTo(5.6 * s, -1.5 * s);
        c.closePath();
        c.fill();

        c.fillStyle = pal.primary;
        drawRoundedRectPath(c, -4.6 * s, -18.5 * s, 9.2 * s, 12.5 * s, 2.8 * s);
        c.fill();

        // 寬簷鋼盔（Kettle Helm，與重盾明確區分）
        c.fillStyle = pal.metal;
        c.beginPath();
        c.arc(-0.3 * s, -23 * s, 4.3 * s, Math.PI, 0);
        c.lineTo(6.2 * s, -21.5 * s);
        c.lineTo(-6.8 * s, -21.5 * s);
        c.closePath();
        c.fill();
        c.strokeStyle = pal.metalDark;
        c.lineWidth = 1 * s;
        c.stroke();
        // 臉部陰影
        c.fillStyle = '#334155';
        c.beginPath();
        c.arc(0.3 * s, -20.5 * s, 2.8 * s, 0, Math.PI);
        c.fill();

        // 斜向超長木質矛桿（由左後直衝右前上方）
        c.strokeStyle = '#92400e';
        c.lineWidth = 2.4 * s;
        c.beginPath();
        c.moveTo(-11.5 * s, -5.5 * s);
        c.lineTo(14.5 * s, -33.5 * s);
        c.stroke();

        // 矛桿下方陣營小紅／藍流蘇
        c.fillStyle = pal.primary;
        c.beginPath();
        c.moveTo(10.5 * s, -29.2 * s);
        c.lineTo(5.2 * s, -28.0 * s);
        c.lineTo(7.4 * s, -24.2 * s);
        c.closePath();
        c.fill();

        // 閃亮銳利柳葉鋼矛頭
        c.fillStyle = pal.metal;
        c.beginPath();
        c.moveTo(21.2 * s, -40.8 * s);
        c.lineTo(15.8 * s, -30.8 * s);
        c.lineTo(12.2 * s, -32.2 * s);
        c.lineTo(13.2 * s, -35.6 * s);
        c.closePath();
        c.fill();
        c.strokeStyle = '#ffffff';
        c.lineWidth = 0.9 * s;
        c.stroke();
      } else if (type === 'archer') {
        // 【弓手】兜帽遊俠＋背後羽箭筒＋拉滿大彎弓
        // 背後箭筒與箭羽
        c.save();
        c.translate(-5.5 * s, -17 * s);
        c.rotate(-0.35);
        c.fillStyle = '#78350f';
        c.fillRect(-2.4 * s, -5 * s, 4.4 * s, 11 * s);
        c.fillStyle = '#fef3c7';
        c.beginPath();
        c.moveTo(-2.5 * s, -5 * s);
        c.lineTo(-0.5 * s, -9.2 * s);
        c.lineTo(2.4 * s, -5 * s);
        c.closePath();
        c.fill();
        c.restore();

        // 遊俠斗篷與長衫
        c.fillStyle = pal.dark;
        c.beginPath();
        c.moveTo(-8.5 * s, -1.5 * s);
        c.quadraticCurveTo(-7.5 * s, -15 * s, -3.5 * s, -21 * s);
        c.lineTo(2.5 * s, -20 * s);
        c.lineTo(4.2 * s, -1.5 * s);
        c.closePath();
        c.fill();

        c.fillStyle = pal.primary;
        c.beginPath();
        c.moveTo(-4.8 * s, -18.5 * s);
        c.lineTo(3.4 * s, -18.5 * s);
        c.lineTo(4.4 * s, -3 * s);
        c.lineTo(-5.4 * s, -3 * s);
        c.closePath();
        c.fill();

        // 尖頂遊俠兜帽（極高辨識度）
        c.fillStyle = pal.primary;
        c.beginPath();
        c.moveTo(-8.2 * s, -21.5 * s);
        c.quadraticCurveTo(-4.2 * s, -29.2 * s, 2.2 * s, -27.2 * s);
        c.quadraticCurveTo(4.8 * s, -24.5 * s, 3.2 * s, -20.2 * s);
        c.lineTo(-4.8 * s, -19.5 * s);
        c.closePath();
        c.fill();
        c.strokeStyle = pal.accent;
        c.lineWidth = 1 * s;
        c.stroke();

        // 大型拉滿反曲木弓（前置核心輪廓）
        c.strokeStyle = '#d97706';
        c.lineWidth = 2.9 * s;
        c.beginPath();
        c.moveTo(5.8 * s, -31.8 * s);
        c.quadraticCurveTo(15.2 * s, -18.8 * s, 5.4 * s, -5.8 * s);
        c.stroke();
        c.strokeStyle = '#fef3c7';
        c.lineWidth = 1 * s;
        c.beginPath();
        c.moveTo(5.8 * s, -31.8 * s);
        c.lineTo(1.8 * s, -18.8 * s);
        c.lineTo(5.4 * s, -5.8 * s);
        c.stroke();

        // 上弦銳箭
        c.strokeStyle = '#fef9c3';
        c.lineWidth = 1.6 * s;
        c.beginPath();
        c.moveTo(1.6 * s, -18.8 * s);
        c.lineTo(17.5 * s, -19.6 * s);
        c.stroke();
        c.fillStyle = pal.metal;
        c.beginPath();
        c.moveTo(20.6 * s, -19.8 * s);
        c.lineTo(15.6 * s, -22.2 * s);
        c.lineTo(15.8 * s, -17.4 * s);
        c.closePath();
        c.fill();
      } else if (type === 'cavalry') {
        // 【輕騎】奔騰戰馬＋陣營馬衣＋羽飾騎兵與前指騎槍
        // 馬尾
        c.strokeStyle = pal.horseDark;
        c.lineWidth = 2.6 * s;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(-10.5 * s, -13 * s);
        c.quadraticCurveTo(-15.5 * s, -11.5 * s, -14.8 * s, -5.5 * s);
        c.stroke();

        // 馬腿（動態躍步）
        c.strokeStyle = pal.horseDark;
        c.lineWidth = 2.3 * s;
        c.beginPath();
        c.moveTo(-8.2 * s, -9.5 * s);
        c.lineTo(-10.8 * s, -1.5 * s);
        c.moveTo(-5.2 * s, -9.2 * s);
        c.lineTo(-4.6 * s, -1.8 * s);
        c.moveTo(5.2 * s, -9.5 * s);
        c.lineTo(8.5 * s, -2.5 * s);
        c.moveTo(7.4 * s, -10.5 * s);
        c.lineTo(12.2 * s, -5.8 * s);
        c.stroke();

        // 戰馬軀幹、馬頸與昂首馬頭
        c.fillStyle = pal.horse;
        c.beginPath();
        c.ellipse(-1 * s, -12.8 * s, 10.2 * s, 5.4 * s, -0.08, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.moveTo(5.5 * s, -14.2 * s);
        c.lineTo(10.4 * s, -24.8 * s);
        c.lineTo(15.8 * s, -21.2 * s);
        c.lineTo(14.5 * s, -18.2 * s);
        c.lineTo(10.6 * s, -18.8 * s);
        c.lineTo(9.2 * s, -10.8 * s);
        c.closePath();
        c.fill();
        // 馬耳與鬃毛
        c.fillStyle = pal.horseDark;
        c.beginPath();
        c.moveTo(9.8 * s, -24.4 * s);
        c.lineTo(11.6 * s, -27.4 * s);
        c.lineTo(12.4 * s, -23.6 * s);
        c.closePath();
        c.fill();

        // 陣營戰馬披甲馬衣
        c.fillStyle = pal.primary;
        c.beginPath();
        c.moveTo(-8.6 * s, -15.2 * s);
        c.lineTo(7.2 * s, -15.8 * s);
        c.lineTo(8.5 * s, -8.5 * s);
        c.lineTo(-8.8 * s, -9.2 * s);
        c.closePath();
        c.fill();
        c.strokeStyle = pal.gold;
        c.lineWidth = 1.1 * s;
        c.stroke();

        // 騎士上身、頭盔與飄逸羽飾
        c.fillStyle = pal.dark;
        drawRoundedRectPath(c, -4.6 * s, -25.8 * s, 7.6 * s, 10.6 * s, 2.5 * s);
        c.fill();
        c.fillStyle = pal.metal;
        c.beginPath();
        c.arc(-0.8 * s, -28.6 * s, 3.6 * s, 0, Math.PI * 2);
        c.fill();
        // 頭盔高羽飾
        c.strokeStyle = pal.primary;
        c.lineWidth = 2.6 * s;
        c.beginPath();
        c.moveTo(-1.2 * s, -31.8 * s);
        c.quadraticCurveTo(-7.2 * s, -34.5 * s, -9.2 * s, -28.5 * s);
        c.stroke();

        // 前衝長騎槍
        c.strokeStyle = pal.gold;
        c.lineWidth = 2.2 * s;
        c.beginPath();
        c.moveTo(-4.5 * s, -20.5 * s);
        c.lineTo(20.8 * s, -25.8 * s);
        c.stroke();
        c.fillStyle = pal.metal;
        c.beginPath();
        c.moveTo(24.5 * s, -26.5 * s);
        c.lineTo(18.5 * s, -28.2 * s);
        c.lineTo(18.8 * s, -23.8 * s);
        c.closePath();
        c.fill();
      }

      c.restore();
    }

    /* =========================================================
     * 懸停路徑導引線與 MP 消耗氣泡
     * ========================================================= */
    function drawHoverMovePath(c, metrics) {
      if (!scene || !scene.board || !hover.previewPath || hover.previewPath.length < 2) return;
      const pts = hover.previewPath.map(p => {
        const elev = scene.board.map[p.y][p.x].elev || 0;
        return projectBase(p.x, p.y, elev, metrics);
      });

      c.save();
      // 外發光路徑線
      c.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      c.lineWidth = 6;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.beginPath();
      pts.forEach((p, i) => (i === 0 ? c.moveTo(p.bx, p.by) : c.lineTo(p.bx, p.by)));
      c.stroke();

      c.strokeStyle = 'rgba(224, 242, 254, 0.95)';
      c.lineWidth = 2.4;
      c.stroke();

      // 途經點與終點箭頭
      for (let i = 1; i < pts.length - 1; i++) {
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(pts[i].bx, pts[i].by, 3.6, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#0ea5e9';
        c.lineWidth = 1.6;
        c.stroke();
      }

      // 終點 MP 氣泡
      const lastCoord = hover.previewPath[hover.previewPath.length - 1];
      const lastPt = pts[pts.length - 1];
      const previous = pts[pts.length - 2];
      const angle = Math.atan2(lastPt.by - previous.by, lastPt.bx - previous.bx);
      c.save();
      c.translate(lastPt.bx, lastPt.by);
      c.rotate(angle);
      c.fillStyle = '#e0f2fe';
      c.beginPath();
      c.moveTo(2, 0);
      c.lineTo(-10, -5);
      c.lineTo(-10, 5);
      c.closePath();
      c.fill();
      c.restore();
      const rInfo = scene.reachableMap ? scene.reachableMap.get(keyOf(lastCoord.x, lastCoord.y)) : null;
      if (rInfo) {
        const label = `${rInfo.cost}MP`;
        c.font = '900 10.5px ui-monospace, SFMono-Regular, monospace';
        const bw = c.measureText(label).width + 10;
        const bh = 16;
        const lx = lastPt.bx + metrics.tw * 0.28;
        const ly = lastPt.by + metrics.th * 0.22;
        drawRoundedRectPath(c, lx - bw * 0.5, ly - bh * 0.5, bw, bh, 4);
        c.fillStyle = 'rgba(15, 23, 42, 0.94)';
        c.fill();
        c.strokeStyle = 'rgba(56, 189, 248, 0.9)';
        c.lineWidth = 1.1;
        c.stroke();
        c.fillStyle = '#7dd3fc';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(label, lx, ly + 0.5);
      }
      c.restore();
    }

    /* =========================================================
     * 嚴格遵守迷霧之動態特效（移動滑行、拋物線箭矢、衝鋒、破盾、伏擊）
     * ========================================================= */
    function pruneAndSampleEffects(nowMs) {
      const unitOverrides = new Map(); // unitId -> { bx, by, shakeX, hitFlash }
      const renderFx = [];
      const next = [];
      const metrics = getMetrics();
      const showAll = Boolean(scene && scene.showAll);
      const viewer = scene ? scene.faction : 'blue';

      const casualties = new Map();
      const pendingHealth = new Map();
      const reducedMotion = isReducedMotion();
      for (const fx of activeEffects) {
        if (!showAll && fx.viewers && !fx.viewers.includes(viewer)) continue;
        const elapsed = nowMs - fx.startMs;
        const t = elapsed / fx.durationMs;
        const impact = reducedMotion ? 0 : (fx.impactFrac ?? 0.48);
        const deathMs = fx.deathDurationMs || 600;
        const afterImpact = elapsed - fx.durationMs * impact;
        if (afterImpact < 0 && fx.targetSnapshot) {
          if (fx.targetKilled && !reducedMotion) {
            casualties.set(keyOf(fx.toX, fx.toY), {
              unit: fx.targetSnapshot, opacity: 1
            });
          } else if (!pendingHealth.has(fx.targetId)) {
            pendingHealth.set(fx.targetId, fx.targetSnapshot.hp);
          }
        }
        if (elapsed < 0) {
          next.push(fx);
          continue;
        }
        const stillFalling = fx.targetKilled && !reducedMotion && afterImpact < deathMs;
        if (t >= 1 && !stillFalling) continue;
        next.push(fx);

        if (fx.type === 'move') {
          if (reducedMotion || fx.steps.length < 2) continue;
          const steps = fx.steps;
          const ownOrAll = showAll || viewer === fx.faction;
          const stepCount = steps.length - 1;
          const scaled = easeInOutQuad(t) * stepCount;
          const segIdx = Math.min(stepCount - 1, Math.floor(scaled));
          const segT = scaled - segIdx;
          const a = steps[segIdx];
          const b = steps[segIdx + 1];
          const seeA = a && (ownOrAll || a.observed);
          const seeB = b && (ownOrAll || b.observed);
          if (!seeA || !seeB) {
            // 兩段可見路徑之間保留斷點，輪廓和衝鋒光跡都不跨過迷霧。
            unitOverrides.set(fx.unitId, { hide: true });
            continue;
          }
          const elevA = scene.board.map[a.y][a.x].elev || 0;
          const elevB = scene.board.map[b.y][b.x].elev || 0;
          const hop = Math.sin(segT * Math.PI) * (elevA !== elevB ? 0.36 : 0.12);
          const pos = projectFloatBase(
            lerp(a.x, b.x, segT), lerp(a.y, b.y, segT),
            lerp(elevA, elevB, segT) + hop, metrics
          );
          unitOverrides.set(fx.unitId, pos);
          if (fx.isCharge) renderFx.push({ kind: 'chargeTrail', bx: pos.bx, by: pos.by, t });
        } else if (fx.type === 'attack') {
          const canSeeOrigin = fx.canSeeOrigin ??
            (showAll || viewer === fx.attackerFaction || Boolean(fx.attackerObserved));
          const pTo = projectBase(fx.toX, fx.toY, scene.board.map[fx.toY][fx.toX].elev || 0, metrics);
          const pFrom = canSeeOrigin
            ? projectBase(fx.fromX, fx.fromY, scene.board.map[fx.fromY][fx.fromX].elev || 0, metrics)
            : null;
          if (afterImpact >= 0 && stillFalling && fx.targetSnapshot) {
            const collapse = clamp(afterImpact / deathMs, 0, 1);
            casualties.set(keyOf(fx.toX, fx.toY), {
              unit: fx.targetSnapshot,
              collapse: easeOutCubic(collapse),
              opacity: 1 - clamp((collapse - 0.38) / 0.62, 0, 1),
              tilt: collapse * 0.9
            });
          }
          if (!reducedMotion && canSeeOrigin && t < 1 && fx.attackerType !== 'archer') {
            const lunge = Math.sin(Math.PI * t) * 0.15;
            const prev = unitOverrides.get(fx.attackerId) || {};
            unitOverrides.set(fx.attackerId, {
              ...prev, bx: lerp(prev.bx ?? pFrom.bx, pTo.bx, lunge),
              by: lerp(prev.by ?? pFrom.by, pTo.by, lunge)
            });
          }
          if (!reducedMotion && afterImpact >= 0 && t < 1) {
            const fade = Math.max(0, 1 - afterImpact / 190);
            const prev = unitOverrides.get(fx.targetId) || {};
            unitOverrides.set(fx.targetId, {
              ...prev, tilt: fade * 0.22,
              shakeX: Math.sin(afterImpact * 0.07) * fade * 4,
              hitFlash: fade
            });
          }
          renderFx.push({ kind: 'attack', fx, canSeeOrigin, pFrom, pTo, t, impact, afterImpact });
        } else if (fx.type === 'ambush') {
          const canSee = showAll || !fx.viewers || fx.viewers.includes(viewer);
          if (!canSee) continue;
          const elev = scene.board.map[fx.y][fx.x].elev || 0;
          const p = projectBase(fx.x, fx.y, elev, metrics);
          renderFx.push({ kind: 'ambush', p, t });
        }
      }

      activeEffects = next;
      return { unitOverrides, renderFx, casualties, pendingHealth };
    }

    function drawForegroundEffects(c, renderFx, metrics) {
      const { tw, th } = metrics;
      for (const item of renderFx) {
        if (item.kind === 'chargeTrail') {
          c.save();
          c.strokeStyle = `rgba(251, 191, 36, ${0.75 * (1 - item.t)})`;
          c.lineWidth = 2.5;
          c.beginPath();
          c.ellipse(item.bx, item.by + 2, tw * 0.24 * (0.8 + item.t * 0.5), th * 0.22 * (0.8 + item.t * 0.5), 0, 0, Math.PI * 2);
          c.stroke();
          c.restore();
        } else if (item.kind === 'attack') {
          const { fx, canSeeOrigin, pFrom, pTo, t, impact, afterImpact } = item;
          const reduced = isReducedMotion();
          c.save();

          if (!reduced && canSeeOrigin && fx.attackerType === 'archer' && t < impact) {
            // 弓手高拋物線羽箭
            const at = clamp(t / impact, 0, 1);
            const arcH = Math.max(36, Math.hypot(pTo.bx - pFrom.bx, pTo.by - pFrom.by) * 0.34);
            const x1 = lerp(pFrom.bx, pTo.bx, at);
            const y1 = lerp(pFrom.by - 18, pTo.by - 14, at) - Math.sin(at * Math.PI) * arcH;
            const prevT = Math.max(0, at - 0.12);
            const x0 = lerp(pFrom.bx, pTo.bx, prevT);
            const y0 = lerp(pFrom.by - 18, pTo.by - 14, prevT) - Math.sin(prevT * Math.PI) * arcH;

            c.strokeStyle = 'rgba(254, 240, 138, 0.95)';
            c.lineWidth = 2.4;
            c.lineCap = 'round';
            c.beginPath();
            c.moveTo(x0, y0);
            c.lineTo(x1, y1);
            c.stroke();

            // 亮白箭鏃
            c.fillStyle = '#ffffff';
            c.beginPath();
            c.arc(x1, y1, 2.4, 0, Math.PI * 2);
            c.fill();
          } else if (!reduced && canSeeOrigin && fx.attackerType === 'spear' && t < impact) {
            // 長矛閃亮突刺穿刺線
            const st = easeOutCubic(clamp(t / impact, 0, 1));
            const sx = lerp(pFrom.bx, pTo.bx, st);
            const sy = lerp(pFrom.by - 16, pTo.by - 14, st);
            c.strokeStyle = `rgba(224, 242, 254, ${1 - t * 1.4})`;
            c.lineWidth = 3.2;
            c.lineCap = 'round';
            c.beginPath();
            c.moveTo(pFrom.bx, pFrom.by - 16);
            c.lineTo(sx, sy);
            c.stroke();
          } else if (!reduced && canSeeOrigin && fx.isCharge && t < impact) {
            // 輕騎衝鋒金光軌跡
            c.strokeStyle = `rgba(251, 191, 36, ${0.85 * (1 - t / impact)})`;
            c.lineWidth = 4.5;
            c.lineCap = 'round';
            c.beginPath();
            c.moveTo(pFrom.bx, pFrom.by - 12);
            c.lineTo(pTo.bx, pTo.by - 12);
            c.stroke();
          }

          // 命中斬擊／破盾爆裂（迷霧中受擊只顯示此局部爆發，絕不洩露攻方位置）
          if (!reduced && t >= impact && t < 1) {
            const bt = clamp((t - impact) / (1 - impact), 0, 1);
            const r = tw * (0.14 + easeOutCubic(bt) * (fx.isShattered ? 0.44 : 0.3));
            const alpha = 1 - bt;
            const ringColor = fx.isShattered
              ? `rgba(251, 191, 36, ${alpha})`
              : (fx.isCounter ? `rgba(250, 204, 21, ${alpha})` : `rgba(248, 113, 113, ${alpha})`);

            c.strokeStyle = ringColor;
            c.lineWidth = fx.isShattered ? 3.2 : 2.2;
            c.beginPath();
            c.ellipse(pTo.bx, pTo.by - 12, r, r * 0.6, 0, 0, Math.PI * 2);
            c.stroke();

            // 斬擊／火花放射絲
            const rays = fx.isShattered ? 8 : 5;
            for (let i = 0; i < rays; i++) {
              const ang = (i / rays) * Math.PI * 2 + 0.35;
              const r0 = r * 0.45;
              const r1 = r * 1.12;
              c.beginPath();
              c.moveTo(pTo.bx + Math.cos(ang) * r0, pTo.by - 12 + Math.sin(ang) * r0 * 0.65);
              c.lineTo(pTo.bx + Math.cos(ang) * r1, pTo.by - 12 + Math.sin(ang) * r1 * 0.65);
              c.stroke();
            }
          }
          if (fx.damageText && afterImpact >= 0) {
            const progress = clamp((t - impact) / (1 - impact), 0, 1);
            const y = pTo.by - 24 - (reduced ? 0 : progress * 16);
            c.globalAlpha = progress < 0.78 ? 1 : (1 - progress) / 0.22;
            c.font = '900 13px system-ui, sans-serif';
            c.textAlign = 'center';
            c.lineWidth = 3.5;
            c.strokeStyle = '#080c18';
            c.fillStyle = fx.damageColor || '#fca5a5';
            c.strokeText(fx.damageText, pTo.bx, y);
            c.fillText(fx.damageText, pTo.bx, y);
          }
          c.restore();
        } else if (item.kind === 'ambush') {
          const r = tw * (0.2 + easeOutCubic(item.t) * 0.55);
          c.save();
          c.strokeStyle = `rgba(245, 158, 11, ${1 - item.t})`;
          c.lineWidth = 3;
          c.beginPath();
          c.ellipse(item.p.bx, item.p.by, r, r * 0.52, 0, 0, Math.PI * 2);
          c.stroke();
          c.restore();
        }
      }
    }

    function drawFloatTexts(c, metrics, nowMs) {
      if (!scene || !scene.floatEffects || !scene.floatEffects.length) return;
      const showAll = Boolean(scene.showAll);
      const viewer = scene.faction;

      c.save();
      c.font = `900 ${clamp(metrics.tw * 0.21, 11.5, 15)}px system-ui, "PingFang TC", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';

      for (const fx of scene.floatEffects) {
        if (!showAll && !fx.viewers.includes(viewer)) continue;
        const elev = scene.board.map[fx.y][fx.x].elev || 0;
        const p = projectBase(fx.x, fx.y, elev, metrics);
        const age = Math.max(0, nowMs - (fx.createdAt || nowMs));
        const t = clamp(age / 1500, 0, 1);
        const rise = easeOutCubic(t) * 28;
        const alpha = t < 0.14 ? t / 0.14 : (t > 0.78 ? (1 - t) / 0.22 : 1);

        c.globalAlpha = clamp(alpha, 0, 1);
        c.lineWidth = 3.5;
        c.strokeStyle = 'rgba(2, 6, 23, 0.92)';
        c.strokeText(fx.text, p.bx, p.by - 26 - rise);
        c.fillStyle = fx.color || '#f8fafc';
        c.fillText(fx.text, p.bx, p.by - 26 - rise);
      }
      c.restore();
    }

    /* =========================================================
     * 主繪圖幀
     * ========================================================= */
    function drawBackground(c) {
      const glow = c.createRadialGradient(width * 0.46, height * 0.32, 12,
        width * 0.51, height * 0.5, Math.max(width, height) * 0.74);
      glow.addColorStop(0, '#283b50');
      glow.addColorStop(0.58, '#152439');
      glow.addColorStop(1, '#09111e');
      c.fillStyle = glow;
      c.fillRect(0, 0, width, height);

      // 遠山置於棋盤後方，輪廓的亮度低於棋格與戰術提示。
      for (let layer = 0; layer < 2; layer++) {
        c.beginPath();
        c.moveTo(0, height);
        for (let i = 0; i <= 30; i++) {
          const peak = Math.sin(i * 0.47 + layer) * 0.044 + tileHash(i, layer, 63) * 0.047;
          c.lineTo(width * i / 30, height * (0.42 + layer * 0.12 - peak));
        }
        c.lineTo(width, height);
        c.closePath();
        c.fillStyle = layer ? 'rgba(8, 18, 32, 0.40)' : 'rgba(12, 24, 38, 0.42)';
        c.fill();
      }
      const vignette = c.createRadialGradient(width * 0.5, height * 0.47, width * 0.18,
        width * 0.5, height * 0.47, Math.max(width, height) * 0.68);
      vignette.addColorStop(0, 'rgba(4, 9, 18, 0)');
      vignette.addColorStop(1, 'rgba(4, 9, 18, 0.52)');
      c.fillStyle = vignette;
      c.fillRect(0, 0, width, height);
    }

    function cachedCanvas(draw) {
      const layer = makeCanvas();
      layer.width = canvas.width;
      layer.height = canvas.height;
      const layerCtx = layer.getContext('2d');
      layerCtx.scale(dpr, dpr);
      draw(layerCtx);
      return layer;
    }

    function drawTurningPlinth(c, metrics) {
      const n = BOARD_SIZE - 0.5;
      const corners = [[-0.5, -0.5], [n, -0.5], [n, n], [-0.5, n]]
        .map(([x, y]) => projectBase(x, y, 0, metrics));
      const h = metrics.baseDepth * 1.15;
      c.beginPath();
      corners.forEach((p, i) => i ? c.lineTo(p.bx, p.by + h) : c.moveTo(p.bx, p.by + h));
      c.closePath();
      c.fillStyle = '#080e17';
      c.fill();
      c.beginPath();
      corners.forEach((p, i) => i ? c.lineTo(p.bx, p.by) : c.moveTo(p.bx, p.by));
      c.closePath();
      c.fillStyle = '#425334';
      c.fill();
      for (let i = 0; i < 4; i++) {
        const p = corners[i];
        const q = corners[(i + 1) % 4];
        if (q.bx >= p.bx) continue;
        const shade = c.createLinearGradient(0, Math.min(p.by, q.by), 0, Math.max(p.by, q.by) + h);
        shade.addColorStop(0, '#564332');
        shade.addColorStop(1, '#1b1715');
        c.fillStyle = shade;
        c.beginPath();
        c.moveTo(p.bx, p.by);
        c.lineTo(q.bx, q.by);
        c.lineTo(q.bx, q.by + h);
        c.lineTo(p.bx, p.by + h);
        c.closePath();
        c.fill();
      }
    }

    function getOrderedTiles() {
      if (!camera.rotation && orderedTiles && orderedRotation === camera.rot) return orderedTiles;
      const tiles = [];
      for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
          const { rx, ry } = rotatedPoint(x, y);
          tiles.push({ x, y, rx, ry, key: keyOf(x, y) });
        }
      }
      tiles.sort((a, b) => (a.rx + a.ry) - (b.rx + b.ry) || a.rx - b.rx);
      if (!camera.rotation) {
        orderedTiles = tiles;
        orderedRotation = camera.rot;
      }
      return tiles;
    }

    function drawParticles(c, nowSec, metrics) {
      if (quality !== 'high' || isReducedMotion()) return;
      c.save();
      for (let i = 0; i < 16; i++) {
        const x = tileHash(i, 1, 81) * BOARD_SIZE - 0.5;
        const y = tileHash(i, 2, 81) * BOARD_SIZE - 0.5;
        const p = projectBase(x, y, 0, metrics);
        const opacity = 0.24 + 0.14 * Math.sin(nowSec * 0.8 + i);
        c.fillStyle = `rgba(255, 231, 154, ${opacity})`;
        c.beginPath();
        c.arc(p.bx + Math.cos(nowSec + i) * 5, p.by - 8 + Math.sin(nowSec * 0.6 + i) * 4,
          0.75 + tileHash(i, 5, 81) * 0.8, 0, 2 * Math.PI);
        c.fill();
      }
      c.restore();
    }

    function drawFrame(nowMs) {
      if (!scene || !scene.board) return;
      const nowSec = nowMs * 0.001;
      const metrics = getMetrics();
      let cameraChanged = false;

      if (camera.anim) {
        const t = clamp((nowMs - camera.anim.start) / camera.anim.dur, 0, 1);
        const e = easeOutCubic(t);
        camera.zoom = lerp(camera.anim.fromZoom, camera.anim.toZoom, e);
        camera.panX = lerp(camera.anim.fromPanX, camera.anim.toPanX, e);
        camera.panY = lerp(camera.anim.fromPanY, camera.anim.toPanY, e);
        clampPan();
        if (t >= 1) camera.anim = null;
        cameraChanged = true;
      }
      if (camera.rotation) {
        const { start, from, to } = camera.rotation;
        const t = clamp((nowMs - start) / 250, 0, 1);
        camera.theta = lerp(from, to, easeInOutQuad(t));
        if (t >= 1) {
          camera.rotation = null;
          camera.theta = camera.rot * Math.PI * 0.5;
          cameraChanged = true;
        }
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      backgroundCache ||= cachedCanvas(drawBackground);
      ctx.drawImage(backgroundCache, 0, 0, width, height);
      ctx.translate(width * 0.5 + camera.panX, height * 0.5 + camera.panY);
      ctx.scale(camera.zoom, camera.zoom);
      ctx.translate(-width * 0.5, -height * 0.5);

      if (camera.rotation) {
        drawTurningPlinth(ctx, metrics);
      } else {
        if (plinthCache?.rot !== camera.rot) {
          plinthCache = { rot: camera.rot, canvas: cachedCanvas(c => drawDioramaPlinth(c, metrics)) };
        }
        ctx.drawImage(plinthCache.canvas, 0, 0, width, height);
      }

      const movingCamera = !camera.rotation && (camera.anim || dragState?.moved ||
        pinchState || nowMs - lastInteraction < 105);
      const canReuse = movingCamera && !activeEffects.length && !scene.floatEffects?.length &&
        !terrainRenderer.hasActiveAnimation?.(nowMs);
      if (canReuse) {
        // 鏡頭移動時重用未套平移與縮放的棋盤像素，手勢結束時重畫完整細節。
        cameraLayer ||= makeCanvas();
        if (!cameraLayerValid) {
          cameraLayer.width = canvas.width;
          cameraLayer.height = canvas.height;
          const layerCtx = cameraLayer.getContext('2d');
          layerCtx.scale(dpr, dpr);
          drawBoardContents(layerCtx, nowMs, metrics, nowSec);
          cameraLayerValid = true;
        }
        ctx.drawImage(cameraLayer, 0, 0, width, height);
      } else {
        cameraLayerValid = false;
        drawBoardContents(ctx, nowMs, metrics, nowSec);
      }
      drawParticles(ctx, nowSec, metrics);

      // 7. 藍方輪到提示柔光邊框（對應經典版 blue-turn-pulse）
      if (pulseStart > 0 && !isReducedMotion()) {
        const pt = (nowMs - pulseStart) / 780;
        if (pt >= 1) {
          pulseStart = 0;
        } else {
          ctx.restore();
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const a = Math.sin(pt * Math.PI) * 0.72;
          ctx.strokeStyle = `rgba(96, 165, 250, ${a})`;
          ctx.lineWidth = 4;
          drawRoundedRectPath(ctx, 2, 2, width - 4, height - 4, 12);
          ctx.stroke();
        }
      }

      ctx.restore();
      if (cameraChanged) emitCameraChange(false);
    }

    function drawBoardContents(ctx, nowMs, metrics, nowSec) {
      const { unitOverrides, renderFx, casualties, pendingHealth } = pruneAndSampleEffects(nowMs);
      const board = scene.board;
      const selUnit = scene.selUnit || null;
      const hovered = camera.rotation ? null : hover.hoveredTile;
      const hoveredRot = hovered ? rotatedPoint(hovered.x, hovered.y) : null;
      const selRot = selUnit ? rotatedPoint(selUnit.x, selUnit.y) : null;
      const project = (x, y, elev) => projectBase(x, y, elev, metrics);
      const frame = {
        quality, metrics, nowMs, project, projectFloat: project, rot: camera.rot,
        theta: camera.theta, zoom: camera.zoom, dpr, gridVisible, assetVersion,
        reducedMotion: isReducedMotion()
      };

      unitHitBoxes = [];
      const unitHudQueue = [];
      const occluders = [];
      const tiles = getOrderedTiles();
      terrainRenderer.drawGround(ctx, scene, frame);

      for (const [order, { x, y, rx, ry, key }] of tiles.entries()) {
        const cell = board.map[y][x];
        const { bx, by } = project(x, y, cell.elev || 0);
        const hill = cell.elev ? terrainModule.projectHill(board.map, x, y, project) : null;
        const tile = { x, y, bx, by, cell, hill };
        const isVis = scene.visibleTiles[y][x];
        const unit = scene.visibleUnitsByKey.get(key) || null;
        const ghost = !unit && scene.ghostsByKey?.get(key);
        const fallen = !unit && casualties.get(key);
        const occupied = Boolean(unit || ghost || fallen);
        const isHovered = hovered?.x === x && hovered.y === y;
        const inFrontOf = point => point && rx >= point.rx && ry >= point.ry &&
          rx - point.rx <= 1 && ry - point.ry <= 1;
        const softFade = isHovered || Boolean(inFrontOf(hoveredRot) || inFrontOf(selRot));
        const flags = {
          enemyAttack: scene.enemyAttackKeys.has(key),
          enemyTrail: scene.enemyTrailKeys.has(key),
          attackable: Boolean(unit && scene.attackableIds.has(unit.id)),
          ambushFlash: scene.ambushFlashKey === key,
          replayMarkers: scene.markersByKey?.get(key),
          isHovered
        };

        if (hill) {
          terrainRenderer.drawHill(ctx, scene, frame, tile);
          occluders.push({
            left: bx - metrics.tw * 0.38, right: bx + metrics.tw * 0.38,
            top: by - metrics.th * 0.35, bottom: by + metrics.th * 0.5 + metrics.elevH, order: order * 2 - 1
          });
        }
        terrainRenderer.drawFog(ctx, scene, frame, tile);
        terrainRenderer.drawTactics(ctx, scene, frame, tile);
        drawTileTacticalOverlays(ctx, tile, metrics, flags, nowSec);

        const forest = layer => terrainRenderer.drawForest(ctx, scene, frame, tile, {
          occupied, softFade, isFogged: !isVis, layer
        });
        if (cell.terrain === 'forest') forest('back');

        if (unit || ghost || fallen) {
          const moving = (unit || fallen) && unitOverrides.get((unit || fallen.unit).id);
          const ov = fallen ? { ...moving, ...fallen } : moving;
          if (!ov?.hide) {
            const raw = unit || fallen?.unit || ghost;
            const hp = pendingHealth.get(raw.id);
            const piece = unit && hp !== undefined ? { ...raw, hp } : raw;
            const meta = unit && scene.unitMetaById.get(unit.id);
            const opts = {
              ...meta, ...ov, isGhost: piece === ghost, isCasualty: Boolean(fallen),
              turnsAgo: piece === ghost ? Math.max(0, board.turn - ghost.turn) : 0,
              isSelected: Boolean(unit && selUnit?.id === unit.id),
              recordHitBox: Boolean(unit), order: order * 2,
              rot: camera.rot, zoom: camera.zoom, dpr
            };
            unitArt.drawMiniature(ctx, piece, ov?.bx ?? bx, ov?.by ?? by,
              metrics, opts, nowSec, unitHudQueue, unitHitBoxes);
          }
        }
        if (cell.terrain === 'forest') {
          forest('front');
          if (!softFade) {
            occluders.push({
              left: bx - metrics.tw * 0.27, right: bx + metrics.tw * 0.27,
              top: by - metrics.tw * 0.46, bottom: by + metrics.th * 0.35, order: order * 2 + 1
            });
          }
        }
        terrainRenderer.drawUpperFog(ctx, scene, frame, tile);
      }

      unitArt.drawXray(ctx, unitHudQueue, occluders);
      const topLeft = screenToBase(0, 0);
      const bottomRight = screenToBase(width, height);
      unitArt.drawHud(ctx, unitHudQueue, metrics, {
        zoom: camera.zoom, hoveredTile: hovered, showDetails: showHudDetails,
        viewBounds: { left: topLeft.bx, right: bottomRight.bx, top: topLeft.by, bottom: bottomRight.by }
      });

      // 4. 懸停移動路徑線（繪在地形與棋子層之上，指引清晰）
      if (!camera.rotation) drawHoverMovePath(ctx, metrics);

      // 5. 動態攻擊／箭矢／衝鋒／伏擊特效
      drawForegroundEffects(ctx, renderFx, metrics);

      // 6. 浮動傷害與狀態文字
      drawFloatTexts(ctx, metrics, nowMs);

    }

    function resetInteractiveSamples() {
      lastInteractiveFrame = null;
      interactionFrameCount = 0;
      interactionFrameTotal = 0;
    }

    function trackInteractiveFrame(nowMs, interactive) {
      if (quality !== 'high' || !interactive) {
        // 待機期間停止取樣，以免把刻意限幀的等待時間算進去。
        lastInteractiveFrame = null;
        return;
      }
      if (lastInteractiveFrame !== null) {
        const elapsed = nowMs - lastInteractiveFrame;
        if (elapsed > 250) {
          resetInteractiveSamples();
        } else {
          interactionFrameCount++;
          interactionFrameTotal += elapsed;
        }
      }
      lastInteractiveFrame = nowMs;
      if (interactionFrameCount < 90) return;
      if (interactionFrameTotal / interactionFrameCount > 28) setQuality('standard', true);
      resetInteractiveSamples();
    }

    function setQuality(next, automaticallyLowered = false) {
      const resolved = next === 'high' ? 'high' : 'standard';
      if (resolved === quality) return;
      quality = resolved;
      resetInteractiveSamples();
      unitArt.clearCache();
      callbacks.onQualityChange?.({ quality, automaticallyLowered });
      invalidateBoard();
    }

    function stopFrames() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (idleTimer !== null) clearTimeout(idleTimer);
      rafId = null;
      idleTimer = null;
    }

    function loop(nowMs) {
      rafId = null;
      if (!active || !scene || canvas.ownerDocument.hidden) return;
      const interactive = Boolean(camera.anim || camera.rotation || dragState?.moved ||
        pinchState || nowMs - lastInteraction < 105);
      const finishingRotation = Boolean(camera.rotation);
      trackInteractiveFrame(nowMs, interactive);
      lastFrameAt = nowMs;
      drawFrame(nowMs);
      if (finishingRotation && !camera.rotation && lastPointer) {
        const hit = pickTileAtClient(lastPointer.x, lastPointer.y);
        if (hit) callbacks.onTileHover?.(hit.x, hit.y);
      }

      if (rafId !== null) return;
      if (interactive || activeEffects.length || pulseStart ||
          terrainRenderer.hasActiveAnimation?.(nowMs)) {
        rafId = requestAnimationFrame(loop);
        return;
      }
      const hasText = scene.floatEffects?.some(fx => nowMs - fx.createdAt < 1500);
      const ambient = !isReducedMotion() &&
        (quality === 'high' || Array.from(scene.visibleUnitsByKey.values()).some(unit => unit.type === 'flag'));
      if (ambient || hasText) {
        const interval = 1000 / (quality === 'high' ? 24 : 12);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          if (active && !canvas.ownerDocument.hidden && rafId === null) {
            rafId = requestAnimationFrame(loop);
          }
        }, Math.max(0, interval - (performance.now() - lastFrameAt)));
      }
    }

    function onVisibilityChange() {
      resetInteractiveSamples();
      if (canvas.ownerDocument.hidden) stopFrames();
      else markDirty();
    }

    function onMotionPreferenceChange() {
      if (isReducedMotion()) {
        camera.rotation = null;
        camera.theta = camera.rot * Math.PI * 0.5;
        if (camera.anim) {
          camera.zoom = camera.anim.toZoom;
          camera.panX = camera.anim.toPanX;
          camera.panY = camera.anim.toPanY;
          camera.anim = null;
        }
        pulseStart = 0;
        emitCameraChange(false);
      }
      markDirty();
    }

    /* =========================================================
     * 滑鼠與觸控互動（游標中心縮放、6px 防誤觸平移、雙指縮放、點格）
     * ========================================================= */
    function handleWheel(e) {
      if (!active) return;
      e.preventDefault();
      if (camera.rotation) return;
      lastInteraction = performance.now();
      camera.anim = null;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = screenToBase(sx, sy);
      const factor = Math.exp(-e.deltaY * 0.0014);
      camera.zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      camera.panX = sx - width * 0.5 - (before.bx - width * 0.5) * camera.zoom;
      camera.panY = sy - height * 0.5 - (before.by - height * 0.5) * camera.zoom;
      clampPan();
      markDirty();
      emitCameraChange(false);
    }

    function handlePointerDown(e) {
      if (!active || camera.rotation) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      canvas.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

      if (pointers.size === 2) {
        // 雙指捏合縮放初始化
        const pts = Array.from(pointers.values());
        const rect = canvas.getBoundingClientRect();
        const midSx = (pts[0].x + pts[1].x) * 0.5 - rect.left;
        const midSy = (pts[0].y + pts[1].y) * 0.5 - rect.top;
        const midBase = screenToBase(midSx, midSy);
        pinchState = {
          startDist: Math.max(12, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)),
          startZoom: camera.zoom,
          midBaseX: midBase.bx,
          midBaseY: midBase.by
        };
        dragState = null;
        camera.anim = null;
        emitCameraChange(true);
        return;
      }

      if (pointers.size === 1) {
        camera.anim = null;
        dragState = {
          pointerId: e.pointerId,
          button: e.button,
          pointerType: e.pointerType,
          downX: e.clientX,
          downY: e.clientY,
          startPanX: camera.panX,
          startPanY: camera.panY,
          moved: false
        };
      }
    }

    function handlePointerMove(e) {
      if (!active) return;
      if (e.pointerType !== 'touch') lastPointer = { x: e.clientX, y: e.clientY };
      if (camera.rotation) return;
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      }

      if (pinchState && pointers.size === 2) {
        const pts = Array.from(pointers.values());
        const rect = canvas.getBoundingClientRect();
        const dist = Math.max(12, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y));
        const midSx = (pts[0].x + pts[1].x) * 0.5 - rect.left;
        const midSy = (pts[0].y + pts[1].y) * 0.5 - rect.top;
        camera.zoom = clamp(pinchState.startZoom * (dist / pinchState.startDist), MIN_ZOOM, MAX_ZOOM);
        camera.panX = midSx - width * 0.5 - (pinchState.midBaseX - width * 0.5) * camera.zoom;
        camera.panY = midSy - height * 0.5 - (pinchState.midBaseY - height * 0.5) * camera.zoom;
        clampPan();
        markDirty();
        emitCameraChange(true);
        return;
      }

      if (dragState && dragState.pointerId === e.pointerId) {
        const dx = e.clientX - dragState.downX;
        const dy = e.clientY - dragState.downY;
        const threshold = dragState.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX;
        if (!dragState.moved && Math.hypot(dx, dy) >= threshold) {
          dragState.moved = true;
          canvas.classList.add('is-dragging');
        }
        if (dragState.moved) {
          camera.panX = dragState.startPanX + dx;
          camera.panY = dragState.startPanY + dy;
          clampPan();
          markDirty();
          emitCameraChange(true);
          return;
        }
      }

      if (e.pointerType === 'touch') return;
      const hit = pickTileAtClient(e.clientX, e.clientY);
      if (hit) {
        canvas.style.cursor = 'pointer';
        callbacks.onTileHover?.(hit.x, hit.y);
      } else {
        canvas.style.cursor = 'grab';
        callbacks.onPointerLeave?.();
      }
    }

    function handlePointerUpOrCancel(e) {
      if (!active) return;
      const wasDrag = dragState && dragState.pointerId === e.pointerId ? dragState : null;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchState = null;

      if (wasDrag) {
        dragState = null;
        canvas.classList.remove('is-dragging');
        if (wasDrag.moved) {
          emitCameraChange(false);
          return;
        }
        // 未超過門檻且為左鍵（或觸控單擊）→ 執行精準選格
        if (e.type === 'pointerup' && (wasDrag.pointerType === 'touch' || wasDrag.button === 0)) {
          const hit = pickTileAtClient(e.clientX, e.clientY);
          if (hit) callbacks.onTileClick?.(hit.x, hit.y);
        }
      }
    }

    function handlePointerLeave() {
      lastPointer = null;
      if (!active) return;
      if (!dragState) {
        canvas.style.cursor = 'grab';
        callbacks.onPointerLeave?.();
      }
    }

    function handleContextMenu(e) {
      // 允許右鍵拖曳時不跳出瀏覽器右鍵選單
      if (active) e.preventDefault();
    }

    canvas.ownerDocument.addEventListener('visibilitychange', onVisibilityChange);
    reducedMotionQuery?.addEventListener('change', onMotionPreferenceChange);
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUpOrCancel);
    canvas.addEventListener('pointercancel', handlePointerUpOrCancel);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('contextmenu', handleContextMenu);

    let resizeObserver = null;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        if (active) resize();
      });
      resizeObserver.observe(hostEl);
    }

    /* =========================================================
     * 公開控制 API
     * ========================================================= */
    return {
      setActive(nextActive) {
        const flag = Boolean(nextActive);
        if (flag === active) return;
        active = flag;
        if (active) {
          resize();
          assets?.load();
          markDirty();
          emitCameraChange(false);
        } else {
          stopFrames();
          resetInteractiveSamples();
          activeEffects = [];
          pulseStart = 0;
          unitHitBoxes = [];
          cameraLayer = null;
          cameraLayerValid = false;
          lastPointer = null;
          camera.rotation = null;
          camera.theta = camera.rot * Math.PI * 0.5;
          pointers.clear();
          dragState = null;
          pinchState = null;
          canvas.classList.remove('is-dragging');
        }
      },

      setScene(nextScene) {
        if (scene?.viewKey !== nextScene.viewKey || scene?.board.map !== nextScene.board.map) {
          activeEffects = [];
          pulseStart = 0;
          unitHitBoxes = [];
        }
        scene = nextScene;
        invalidateBoard();
      },

      setQuality,

      setGridVisible(value) {
        gridVisible = Boolean(value);
        invalidateBoard();
      },

      setHudDetails(value) {
        showHudDetails = Boolean(value);
        invalidateBoard();
      },

      setHover(nextHover) {
        hover = nextHover || { hoveredTile: null, previewPath: [] };
        invalidateBoard();
      },

      pushEffect(fx) {
        if (!fx) return;
        const nowMs = typeof performance === 'object' ? performance.now() : Date.now();
        activeEffects.push({
          ...fx,
          startMs: nowMs + (fx.delayMs || 0),
          durationMs: fx.durationMs || 340
        });
        markDirty();
      },

      clearEffects() {
        activeEffects = [];
        pulseStart = 0;
        invalidateBoard();
      },

      triggerBlueTurnPulse() {
        if (isReducedMotion()) return;
        pulseStart = typeof performance === 'object' ? performance.now() : Date.now();
        markDirty();
      },

      rotate(delta) {
        if (camera.rotation || dragState || pinchState) return;
        const step = delta >= 0 ? 1 : -1;
        if (!isReducedMotion()) {
          camera.rotation = { start: performance.now(), from: camera.theta,
            to: camera.theta + step * Math.PI * 0.5 };
        }
        camera.rot = (camera.rot + step + 4) % 4;
        if (!camera.rotation) camera.theta = camera.rot * Math.PI * 0.5;
        unitHitBoxes = [];
        lastInteraction = performance.now();
        markDirty();
        emitCameraChange(false);
      },

      zoomBy(factor) {
        const nextZoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const nowMs = typeof performance === 'object' ? performance.now() : Date.now();
        const scaleRatio = nextZoom / camera.zoom;
        camera.anim = isReducedMotion() ? null : {
          start: nowMs,
          dur: 180,
          fromZoom: camera.zoom,
          toZoom: nextZoom,
          fromPanX: camera.panX,
          toPanX: camera.panX * scaleRatio,
          fromPanY: camera.panY,
          toPanY: camera.panY * scaleRatio
        };
        if (isReducedMotion()) {
          camera.zoom = nextZoom;
          camera.panX *= scaleRatio;
          camera.panY *= scaleRatio;
          clampPan();
          emitCameraChange(false);
        }
        markDirty();
      },

      resetCamera() {
        camera.rot = 0;
        camera.theta = 0;
        camera.rotation = null;
        unitHitBoxes = [];
        const nowMs = typeof performance === 'object' ? performance.now() : Date.now();
        if (isReducedMotion()) {
          camera.zoom = 1;
          camera.panX = 0;
          camera.panY = 0;
          camera.anim = null;
          emitCameraChange(false);
        } else {
          camera.anim = {
            start: nowMs,
            dur: 240,
            fromZoom: camera.zoom,
            toZoom: 1,
            fromPanX: camera.panX,
            toPanX: 0,
            fromPanY: camera.panY,
            toPanY: 0
          };
        }
        markDirty();
      },

      getCameraState() {
        return { zoom: camera.zoom, rot: camera.rot, panX: camera.panX, panY: camera.panY };
      },

      // 回傳該格單位上方在 hostEl 內的螢幕定位點，供戰鬥預測浮動小窗精準對齊
      getTileScreenPoint(x, y) {
        if (!scene || !scene.board || camera.rotation) return null;
        const metrics = getMetrics();
        const elev = scene.board.map[y][x].elev || 0;
        const base = projectBase(x, y, elev, metrics);
        const pt = baseToScreen(base.bx, base.by);
        const unitLift = clamp(metrics.tw * 0.56, 28, 52) * camera.zoom;
        return {
          x: pt.sx,
          y: pt.sy,
          topY: pt.sy - unitLift - 16,
          bottomY: pt.sy + metrics.th * 0.52 * camera.zoom,
          width,
          height
        };
      },

      resize,

      destroy() {
        this.setActive(false);
        resizeObserver?.disconnect();
        canvas.ownerDocument.removeEventListener('visibilitychange', onVisibilityChange);
        reducedMotionQuery?.removeEventListener('change', onMotionPreferenceChange);
        canvas.removeEventListener('wheel', handleWheel);
        canvas.removeEventListener('pointerdown', handlePointerDown);
        canvas.removeEventListener('pointermove', handlePointerMove);
        canvas.removeEventListener('pointerup', handlePointerUpOrCancel);
        canvas.removeEventListener('pointercancel', handlePointerUpOrCancel);
        canvas.removeEventListener('pointerleave', handlePointerLeave);
        canvas.removeEventListener('contextmenu', handleContextMenu);
      }
    };
  }

  return { create };
});
