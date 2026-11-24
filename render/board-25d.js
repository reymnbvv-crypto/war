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

  function create(hostEl, callbacks = {}) {
    const canvas = hostEl.querySelector('canvas');
    if (!canvas) throw new Error('TFCBoard25D 需要 hostEl 內的 <canvas>');
    const ctx = canvas.getContext('2d', { alpha: false });

    let active = false;
    let width = 720;
    let height = 540;
    let dpr = 1;
    let rafId = null;
    let dirty = true;
    let lastFrameAt = 0;

    // 鏡頭狀態（rot: 0..3，zoom: 0.85..2.4，panX/panY: CSS px）
    const camera = {
      rot: 0,
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
      const elevH = th * 0.52;
      const baseDepth = th * 0.54;
      const originX = width * 0.5;
      const originY = height * 0.5 - (BOARD_SIZE - 1) * (th * 0.5) + th * 0.08;
      return { tw, th, elevH, baseDepth, originX, originY };
    }

    function projectBase(x, y, elev = 0, metrics = getMetrics()) {
      const { rx, ry } = toRotated(x, y, camera.rot);
      const bx = metrics.originX + (rx - ry) * (metrics.tw * 0.5);
      const by = metrics.originY + (rx + ry) * (metrics.th * 0.5) - elev * metrics.elevH;
      return { bx, by, rx, ry };
    }

    function projectFloatBase(fx, fy, felev = 0, metrics = getMetrics()) {
      let rx, ry;
      if (camera.rot === 0) { rx = fx; ry = fy; }
      else if (camera.rot === 1) { rx = BOARD_SIZE - 1 - fy; ry = fx; }
      else if (camera.rot === 2) { rx = BOARD_SIZE - 1 - fx; ry = BOARD_SIZE - 1 - fy; }
      else { rx = fy; ry = BOARD_SIZE - 1 - fx; }
      return {
        bx: metrics.originX + (rx - ry) * (metrics.tw * 0.5),
        by: metrics.originY + (rx + ry) * (metrics.th * 0.5) - felev * metrics.elevH
      };
    }

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
      dirty = true;
      if (active && !rafId) {
        rafId = requestAnimationFrame(loop);
      }
    }

    function emitCameraChange(isDragging = false) {
      if (typeof callbacks.onCameraChange === 'function') {
        callbacks.onCameraChange({
          zoom: camera.zoom,
          rot: camera.rot,
          panX: camera.panX,
          panY: camera.panY,
          isDragging
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

      // 由最前景往最背景逐格檢測：先命中的即為玩家眼前最靠前的表面（含高地頂面與岩壁）
      for (let sum = (BOARD_SIZE - 1) * 2; sum >= 0; sum--) {
        for (let rx = BOARD_SIZE - 1; rx >= 0; rx--) {
          const ry = sum - rx;
          if (ry < 0 || ry >= BOARD_SIZE) continue;
          const { x, y } = fromRotated(rx, ry, camera.rot);
          const elev = map[y][x].elev || 0;
          const cx = metrics.originX + (rx - ry) * halfW;
          const cy = metrics.originY + (rx + ry) * halfH - elev * elevH;

          // 1. 頂面菱形精確解析判定
          const dx = Math.abs(bx - cx);
          if (dx <= halfW) {
            const dy = Math.abs(by - cy);
            if (dx / halfW + dy / halfH <= 1.0005) {
              return { x, y };
            }
            // 2. 高地前側左右岩壁判定（保留外緣 1px 不搶走後方相鄰平地格心）
            if (elev > 0 && dx < halfW - 1) {
              const topEdgeY = cy + (1 - dx / halfW) * halfH;
              if (by >= topEdgeY && by <= topEdgeY + elevH) {
                return { x, y };
              }
            }
          }
        }
      }
      return null;
    }

    function pickTileAtClient(clientX, clientY) {
      if (!scene || !scene.board) return null;
      const rect = canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      if (sx < 0 || sy < 0 || sx >= rect.width || sy >= rect.height) return null;

      const { bx, by } = screenToBase(sx, sy);

      // 1. 優先檢查可見棋子下半主體（由最前景往後檢查），方便直接點選立體棋身
      for (let i = unitHitBoxes.length - 1; i >= 0; i--) {
        const hb = unitHitBoxes[i];
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

    function drawTileBase(c, x, y, cell, bx, by, metrics) {
      const { tw, th, elevH } = metrics;
      const halfW = tw * 0.5;
      const halfH = th * 0.5;
      const isEven = (x + y) % 2 === 0;
      const h1 = tileHash(x, y, 1);
      const h2 = tileHash(x, y, 2);

      if (cell.terrain === 'hill') {
        // 左側暖岩壁（受光面）
        const rockL = c.createLinearGradient(bx - halfW, by, bx, by + halfH + elevH);
        rockL.addColorStop(0, '#c9a36b');
        rockL.addColorStop(0.45, '#9d7446');
        rockL.addColorStop(1, '#6e4f2f');
        c.fillStyle = rockL;
        c.beginPath();
        c.moveTo(bx - halfW, by);
        c.lineTo(bx, by + halfH);
        c.lineTo(bx, by + halfH + elevH);
        c.lineTo(bx - halfW, by + elevH);
        c.closePath();
        c.fill();

        // 右側暗岩壁（背光面）
        const rockR = c.createLinearGradient(bx, by + halfH, bx + halfW, by + elevH);
        rockR.addColorStop(0, '#7a5935');
        rockR.addColorStop(0.5, '#563c22');
        rockR.addColorStop(1, '#392615');
        c.fillStyle = rockR;
        c.beginPath();
        c.moveTo(bx, by + halfH);
        c.lineTo(bx + halfW, by);
        c.lineTo(bx + halfW, by + elevH);
        c.lineTo(bx, by + halfH + elevH);
        c.closePath();
        c.fill();

        // 天然岩石節理與微斜岩層裂紋
        c.strokeStyle = 'rgba(38, 22, 10, 0.34)';
        c.lineWidth = 0.9;
        for (const frac of [0.38, 0.72]) {
          const j1 = (tileHash(x, y, frac * 100) - 0.5) * elevH * 0.14;
          c.beginPath();
          c.moveTo(bx - halfW, by + elevH * frac + j1);
          c.lineTo(bx, by + halfH + elevH * frac);
          c.lineTo(bx + halfW, by + elevH * frac - j1);
          c.stroke();
        }
        // 垂直岩塊切面暗線
        c.strokeStyle = 'rgba(38, 22, 10, 0.25)';
        c.beginPath();
        c.moveTo(bx - halfW * 0.48, by + halfH * 0.48 + elevH * 0.15);
        c.lineTo(bx - halfW * 0.48, by + halfH * 0.48 + elevH * 0.92);
        c.moveTo(bx + halfW * 0.45, by + halfH * 0.55 + elevH * 0.18);
        c.lineTo(bx + halfW * 0.45, by + halfH * 0.55 + elevH * 0.88);
        c.stroke();
        // 中脊微光
        c.strokeStyle = 'rgba(255, 232, 185, 0.22)';
        c.beginPath();
        c.moveTo(bx, by + halfH);
        c.lineTo(bx, by + halfH + elevH);
        c.stroke();

        // 崖頂垂掛暖綠苔草緣（打破木箱感，營造自然懸崖草坡）
        c.fillStyle = '#9aa85a';
        c.beginPath();
        c.moveTo(bx - halfW, by);
        c.lineTo(bx, by + halfH);
        c.lineTo(bx, by + halfH + elevH * 0.22);
        c.lineTo(bx - halfW * 0.52, by + halfH * 0.52 + elevH * 0.14);
        c.lineTo(bx - halfW, by + elevH * 0.20);
        c.closePath();
        c.fill();
        c.fillStyle = '#738241';
        c.beginPath();
        c.moveTo(bx, by + halfH);
        c.lineTo(bx + halfW, by);
        c.lineTo(bx + halfW, by + elevH * 0.19);
        c.lineTo(bx + halfW * 0.48, by + halfH * 0.52 + elevH * 0.13);
        c.lineTo(bx, by + halfH + elevH * 0.22);
        c.closePath();
        c.fill();

        // 高地頂面：暖陽金砂岩緣＋高地苔草台面（一眼區別於低平地草甸）
        const topGrad = c.createLinearGradient(bx - halfW, by - halfH, bx + halfW, by + halfH);
        topGrad.addColorStop(0, '#dfc27f');
        topGrad.addColorStop(0.42, '#c8b06a');
        topGrad.addColorStop(1, '#ae9654');
        drawDiamondPath(c, bx, by, halfW, halfH);
        c.fillStyle = topGrad;
        c.fill();

        // 頂面柔和草苔斑塊（自然有機，不生硬）
        c.fillStyle = 'rgba(130, 166, 86, 0.34)';
        c.beginPath();
        c.ellipse(bx + (h1 - 0.5) * halfW * 0.22, by + (h2 - 0.5) * halfH * 0.18, halfW * 0.52, halfH * 0.44, 0, 0, Math.PI * 2);
        c.fill();

        // 高地頂緣受光高光
        c.strokeStyle = 'rgba(255, 246, 214, 0.55)';
        c.lineWidth = 1.15;
        c.beginPath();
        c.moveTo(bx - halfW + 1, by);
        c.lineTo(bx, by - halfH + 0.8);
        c.lineTo(bx + halfW - 1, by);
        c.stroke();

        // 小塊高地綴石與高地草芽
        const rxOff = (h1 - 0.5) * halfW * 0.52;
        const ryOff = (h2 - 0.5) * halfH * 0.32 - halfH * 0.12;
        c.fillStyle = '#8b6f47';
        c.beginPath();
        c.ellipse(bx + rxOff, by + ryOff, tw * 0.055, th * 0.055, 0, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = 'rgba(255, 240, 210, 0.35)';
        c.beginPath();
        c.ellipse(bx + rxOff - 1, by + ryOff - 1, tw * 0.025, th * 0.025, 0, 0, Math.PI * 2);
        c.fill();
      } else if (cell.terrain === 'forest') {
        const fGrad = c.createLinearGradient(bx - halfW, by - halfH, bx + halfW, by + halfH);
        fGrad.addColorStop(0, '#467448');
        fGrad.addColorStop(0.55, '#375f3a');
        fGrad.addColorStop(1, '#29492c');
        drawDiamondPath(c, bx, by, halfW, halfH);
        c.fillStyle = fGrad;
        c.fill();

        // 苔蘚林地暗斑
        c.fillStyle = 'rgba(20, 44, 24, 0.35)';
        c.beginPath();
        c.ellipse(bx + (h1 - 0.5) * halfW * 0.4, by + (h2 - 0.5) * halfH * 0.35, halfW * 0.34, halfH * 0.28, 0, 0, Math.PI * 2);
        c.fill();
      } else {
        // 奇幻草甸平地（雙色格紋、柔光漸層）
        const pGrad = c.createLinearGradient(bx - halfW, by - halfH, bx + halfW, by + halfH);
        if (isEven) {
          pGrad.addColorStop(0, '#8db46d');
          pGrad.addColorStop(0.55, '#7ca35e');
          pGrad.addColorStop(1, '#6a904f');
        } else {
          pGrad.addColorStop(0, '#80a761');
          pGrad.addColorStop(0.55, '#709653');
          pGrad.addColorStop(1, '#5f8445');
        }
        drawDiamondPath(c, bx, by, halfW, halfH);
        c.fillStyle = pGrad;
        c.fill();

        // 細微草葉簇與陽光小草點（完全不干擾閱讀）
        c.strokeStyle = 'rgba(42, 74, 30, 0.28)';
        c.lineWidth = 0.9;
        for (let i = 0; i < 3; i++) {
          const gx = bx + (tileHash(x, y, 10 + i) - 0.5) * halfW * 0.95;
          const gy = by + (tileHash(x, y, 20 + i) - 0.5) * halfH * 0.85;
          c.beginPath();
          c.moveTo(gx, gy);
          c.lineTo(gx - 1.5, gy - 3.2);
          c.moveTo(gx, gy);
          c.lineTo(gx + 1.8, gy - 2.8);
          c.stroke();
        }
        if (h1 > 0.72) {
          // 偶爾點綴微小白花／黃花
          const fx = bx + (h2 - 0.5) * halfW * 0.65;
          const fy = by + (tileHash(x, y, 31) - 0.5) * halfH * 0.55;
          c.fillStyle = h1 > 0.86 ? 'rgba(254, 240, 138, 0.7)' : 'rgba(241, 245, 249, 0.62)';
          c.beginPath();
          c.arc(fx, fy, 1.35, 0, Math.PI * 2);
          c.fill();
        }
      }

      // 格線細框（讓 10×10 格界在任何縮放都清晰好讀）
      drawDiamondPath(c, bx, by, halfW, halfH);
      c.strokeStyle = cell.terrain === 'hill'
        ? 'rgba(92, 54, 18, 0.48)'
        : (cell.terrain === 'forest' ? 'rgba(18, 42, 22, 0.52)' : 'rgba(34, 58, 28, 0.32)');
      c.lineWidth = 0.9;
      c.stroke();

      // 若鄰近左後或右後是高地，在平地／樹林邊緣投射一點柔和山崖陰影
      if (cell.elev === 0 && scene && scene.board) {
        const { rx, ry } = toRotated(x, y, camera.rot);
        if (rx > 0) {
          const backL = fromRotated(rx - 1, ry, camera.rot);
          if (scene.board.map[backL.y][backL.x].elev > 0) {
            c.fillStyle = 'rgba(15, 23, 42, 0.2)';
            c.beginPath();
            c.moveTo(bx - halfW, by);
            c.lineTo(bx, by - halfH);
            c.lineTo(bx + halfW * 0.25, by - halfH * 0.75);
            c.lineTo(bx - halfW * 0.75, by + halfH * 0.25);
            c.closePath();
            c.fill();
          }
        }
        if (ry > 0) {
          const backR = fromRotated(rx, ry - 1, camera.rot);
          if (scene.board.map[backR.y][backR.x].elev > 0) {
            c.fillStyle = 'rgba(15, 23, 42, 0.16)';
            c.beginPath();
            c.moveTo(bx, by - halfH);
            c.lineTo(bx + halfW, by);
            c.lineTo(bx + halfW * 0.75, by + halfH * 0.25);
            c.lineTo(bx - halfW * 0.25, by - halfH * 0.75);
            c.closePath();
            c.fill();
          }
        }
      }
    }

    function drawPineTree(c, tx, ty, scale, alpha, isFogged) {
      c.save();
      c.globalAlpha = alpha;
      const trunkH = 6.5 * scale;
      const trunkW = 2.6 * scale;

      // 樹底柔影
      c.fillStyle = 'rgba(10, 24, 14, 0.36)';
      c.beginPath();
      c.ellipse(tx + 2.2 * scale, ty + 1.2 * scale, 7.2 * scale, 3.6 * scale, 0, 0, Math.PI * 2);
      c.fill();

      // 樹幹
      c.fillStyle = isFogged ? '#2d2420' : '#573b26';
      c.fillRect(tx - trunkW * 0.5, ty - trunkH, trunkW, trunkH + 1);

      // 三層層疊松針樹冠（左亮右暗立體層次）
      const tiers = [
        { yOff: 4.5, w: 8.6, h: 10.5 },
        { yOff: 10.5, w: 7.0, h: 9.8 },
        { yOff: 16.0, w: 5.0, h: 8.4 }
      ];
      for (const tier of tiers) {
        const baseY = ty - tier.yOff * scale;
        const tipY = baseY - tier.h * scale;
        const hw = tier.w * scale;

        // 左半受光面
        c.fillStyle = isFogged ? '#244034' : '#4a8b4d';
        c.beginPath();
        c.moveTo(tx, tipY);
        c.lineTo(tx - hw, baseY);
        c.lineTo(tx, baseY + 2.2 * scale);
        c.closePath();
        c.fill();

        // 右半陰影面
        c.fillStyle = isFogged ? '#182b25' : '#25522c';
        c.beginPath();
        c.moveTo(tx, tipY);
        c.lineTo(tx, baseY + 2.2 * scale);
        c.lineTo(tx + hw, baseY);
        c.closePath();
        c.fill();

        // 頂脊微光
        if (!isFogged) {
          c.strokeStyle = 'rgba(187, 247, 208, 0.25)';
          c.lineWidth = 0.7;
          c.beginPath();
          c.moveTo(tx, tipY);
          c.lineTo(tx - hw * 0.72, baseY - 1.2 * scale);
          c.stroke();
        }
      }
      c.restore();
    }

    function drawForestCluster(c, x, y, bx, by, metrics, options) {
      const { tw, th } = metrics;
      const scaleBase = clamp(tw / 64, 0.62, 1.35);
      const { occupied, softFade, isFogged, layer } = options;
      // layer: 'back' 畫在單位後方, 'front' 畫在單位前方（若格內有單位則讓開並減淡）
      const slots = occupied
        ? [
            { dx: -0.27, dy: -0.17, s: 0.86, back: true },
            { dx: 0.26, dy: -0.16, s: 0.82, back: true },
            { dx: -0.31, dy: 0.08, s: 0.72, back: false },
            { dx: 0.30, dy: 0.09, s: 0.70, back: false }
          ]
        : [
            { dx: -0.18, dy: -0.18, s: 0.96, back: true },
            { dx: 0.16, dy: -0.14, s: 0.88, back: true },
            { dx: -0.22, dy: 0.08, s: 0.86, back: false },
            { dx: 0.14, dy: 0.12, s: 0.94, back: false }
          ];

      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i];
        if ((layer === 'back') !== sl.back) continue;
        const jx = (tileHash(x, y, 40 + i) - 0.5) * 0.06;
        const jy = (tileHash(x, y, 50 + i) - 0.5) * 0.05;
        const tx = bx + (sl.dx + jx) * tw;
        const ty = by + (sl.dy + jy) * th;
        const treeAlpha = layer === 'front'
          ? (occupied ? 0.44 : (softFade ? 0.55 : 0.96))
          : (softFade ? 0.72 : 0.98);
        drawPineTree(c, tx, ty, scaleBase * sl.s, treeAlpha, isFogged);
      }
    }

    /* =========================================================
     * 戰爭迷霧與林內「隱」覆蓋層
     * ========================================================= */
    function drawFogOverlay(c, x, y, bx, by, metrics, nowSec) {
      const { tw, th } = metrics;
      const halfW = tw * 0.5;
      const halfH = th * 0.5;

      // 基底幽暗迷霧層（保留底層高地／樹林地形輪廓）
      drawDiamondPath(c, bx, by, halfW, halfH);
      c.fillStyle = 'rgba(11, 20, 38, 0.58)';
      c.fill();

      // 細緻霧氣紋理＋柔和緩慢飄動雲團
      const drift = isReducedMotion() ? 0 : Math.sin(nowSec * 0.55 + x * 0.9 + y * 0.7) * (tw * 0.08);
      const driftY = isReducedMotion() ? 0 : Math.cos(nowSec * 0.42 + x * 0.6 - y * 0.8) * (th * 0.07);
      const puffX = bx + (tileHash(x, y, 71) - 0.5) * halfW * 0.42 + drift;
      const puffY = by + (tileHash(x, y, 72) - 0.5) * halfH * 0.36 + driftY;
      const puffR = tw * (0.34 + tileHash(x, y, 73) * 0.14);

      c.save();
      drawDiamondPath(c, bx, by, halfW * 1.04, halfH * 1.04);
      c.clip();
      const mistGrad = c.createRadialGradient(puffX, puffY, puffR * 0.08, puffX, puffY, puffR);
      mistGrad.addColorStop(0, 'rgba(148, 178, 214, 0.24)');
      mistGrad.addColorStop(0.55, 'rgba(71, 100, 140, 0.14)');
      mistGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
      c.fillStyle = mistGrad;
      c.beginPath();
      c.ellipse(puffX, puffY, puffR, puffR * 0.58, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    function drawForestConcealOverlay(c, bx, by, metrics) {
      const { tw, th } = metrics;
      drawDiamondPath(c, bx, by, tw * 0.5, th * 0.5);
      c.fillStyle = 'rgba(8, 20, 32, 0.26)';
      c.fill();

      // 林內未近距探明角標「隱」
      const badgeW = clamp(tw * 0.22, 13, 18);
      const badgeH = clamp(th * 0.36, 12, 15);
      const px = bx - badgeW * 0.5;
      const py = by + th * 0.14;
      drawRoundedRectPath(c, px, py, badgeW, badgeH, 3);
      c.fillStyle = 'rgba(15, 23, 42, 0.78)';
      c.fill();
      c.strokeStyle = 'rgba(110, 231, 183, 0.55)';
      c.lineWidth = 0.9;
      c.stroke();
      c.fillStyle = '#a7f3d0';
      c.font = `800 ${clamp(tw * 0.145, 8.5, 11)}px system-ui, "PingFang TC", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('隱', bx, py + badgeH * 0.52);
    }

    /* =========================================================
     * 戰術高亮疊層（ZoC、上回合軌跡、可達格、衝鋒格、可攻格、回放標記）
     * ========================================================= */
    function drawTileTacticalOverlays(c, x, y, bx, by, metrics, flags, nowSec) {
      const { tw, th } = metrics;
      const halfW = tw * 0.5;
      const halfH = th * 0.5;
      const pulse = isReducedMotion() ? 0.5 : (0.5 + 0.5 * Math.sin(nowSec * 5.2));

      // 1. 敵方可見重盾 ZoC
      if (flags.inZoc) {
        c.save();
        drawDiamondPath(c, bx, by, halfW * 0.88, halfH * 0.88);
        c.fillStyle = 'rgba(239, 68, 68, 0.12)';
        c.fill();
        c.strokeStyle = 'rgba(249, 115, 22, 0.92)';
        c.lineWidth = 1.6;
        c.setLineDash([4, 3]);
        c.stroke();
        c.setLineDash([]);

        const zw = clamp(tw * 0.34, 18, 25);
        const zh = clamp(th * 0.34, 11, 14);
        const zx = bx - halfW * 0.42;
        const zy = by + halfH * 0.28;
        drawRoundedRectPath(c, zx - zw * 0.5, zy - zh * 0.5, zw, zh, 3);
        c.fillStyle = 'rgba(194, 65, 12, 0.92)';
        c.fill();
        c.fillStyle = '#ffedd5';
        c.font = `900 ${clamp(tw * 0.125, 7.5, 10)}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('ZoC', zx, zy + 0.5);
        c.restore();
      }

      // 2. 上回合 AI 可見軌跡／攻擊高亮
      if (flags.enemyAttack) {
        drawDiamondPath(c, bx, by, halfW * 0.92, halfH * 0.92);
        c.fillStyle = 'rgba(244, 63, 94, 0.28)';
        c.fill();
        c.strokeStyle = 'rgba(244, 63, 94, 0.92)';
        c.lineWidth = 2;
        c.stroke();
      } else if (flags.enemyTrail) {
        drawDiamondPath(c, bx, by, halfW * 0.88, halfH * 0.88);
        c.fillStyle = `rgba(249, 115, 22, ${0.18 + pulse * 0.12})`;
        c.fill();
        c.strokeStyle = `rgba(251, 146, 60, ${0.65 + pulse * 0.3})`;
        c.lineWidth = 1.8;
        c.stroke();
      }

      // 3. 可移動格 / 輕騎衝鋒金格
      if (flags.reachable) {
        drawDiamondPath(c, bx, by, halfW * 0.90, halfH * 0.90);
        if (flags.charge) {
          c.fillStyle = 'rgba(245, 158, 11, 0.38)';
          c.fill();
          c.strokeStyle = 'rgba(251, 191, 36, 0.98)';
          c.lineWidth = 2.1;
          c.stroke();

          // ⚡ 衝鋒角標
          const bSize = clamp(tw * 0.24, 13, 18);
          const cx = bx + halfW * 0.42;
          const cy = by - halfH * 0.34;
          drawRoundedRectPath(c, cx - bSize * 0.5, cy - bSize * 0.5, bSize, bSize, 4);
          c.fillStyle = '#fbbf24';
          c.fill();
          c.strokeStyle = '#fef3c7';
          c.lineWidth = 1;
          c.stroke();
          c.fillStyle = '#451a03';
          c.font = `900 ${clamp(tw * 0.155, 9, 12)}px system-ui, sans-serif`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText('⚡', cx, cy + 0.5);
        } else {
          c.fillStyle = 'rgba(14, 165, 233, 0.33)';
          c.fill();
          c.strokeStyle = 'rgba(56, 189, 248, 0.94)';
          c.lineWidth = 1.9;
          c.stroke();
        }
      }

      // 4. 伏擊閃爍
      if (flags.ambushFlash) {
        drawDiamondPath(c, bx, by, halfW * 0.94, halfH * 0.94);
        c.fillStyle = `rgba(239, 68, 68, ${0.22 + pulse * 0.24})`;
        c.fill();
        c.strokeStyle = pulse > 0.5 ? '#ef4444' : '#f59e0b';
        c.lineWidth = 2.8;
        c.stroke();
      }

      // 5. 可攻擊目標脈動紅框
      if (flags.attackable) {
        drawDiamondPath(c, bx, by, halfW * 0.94, halfH * 0.94);
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
          drawDiamondPath(c, bx, by, halfW * 0.88, halfH * 0.88);
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
        drawDiamondPath(c, bx, by, halfW * 0.96, halfH * 0.96);
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

    function drawUnitMiniature(c, unit, bx, by, metrics, opts, nowSec, hudQueue) {
      const { tw, th } = metrics;
      const s = clamp(tw / 66, 0.52, 1.32);
      const isGhost = Boolean(opts.isGhost);
      const isSelected = Boolean(opts.isSelected);
      const pal = getFactionPalette(unit.faction, isGhost);
      const dir = facingSignFor(unit.faction, camera.rot);
      const liftY = isSelected ? -3.5 * s : 0;
      const shakeX = opts.shakeX || 0;
      const cx = bx + shakeX;
      const cy = by + liftY;

      // 1. 選中光環或落地陰影
      if (isSelected) {
        const pulse = isReducedMotion() ? 0.5 : (0.5 + 0.5 * Math.sin(nowSec * 6));
        c.save();
        c.strokeStyle = `rgba(250, 204, 21, ${0.72 + pulse * 0.28})`;
        c.lineWidth = 2.6 * s;
        c.beginPath();
        c.ellipse(cx, by + 1.5 * s, 19.2 * s, 10.0 * s, 0, 0, Math.PI * 2);
        c.stroke();
        c.fillStyle = 'rgba(250, 204, 21, 0.22)';
        c.fill();
        c.restore();
      }

      // 落地投影
      c.fillStyle = isGhost ? 'rgba(15, 23, 42, 0.25)' : 'rgba(2, 6, 23, 0.48)';
      c.beginPath();
      c.ellipse(cx + 2 * s, by + 2.2 * s, 16.2 * s, 8.4 * s, 0, 0, Math.PI * 2);
      c.fill();

      // 2. 立體圓形微縮底座
      const baseRx = 14.8 * s;
      const baseRy = 7.6 * s;
      const baseH = 4.5 * s;

      c.save();
      if (isGhost) c.globalAlpha = 0.72;

      // 底座側邊厚度
      c.fillStyle = pal.baseSide;
      c.beginPath();
      c.ellipse(cx, cy + baseH, baseRx, baseRy, 0, 0, Math.PI);
      c.lineTo(cx - baseRx, cy);
      c.ellipse(cx, cy, baseRx, baseRy, 0, Math.PI, 0, true);
      c.closePath();
      c.fill();

      // 底座頂面
      const discGrad = c.createRadialGradient(cx - 4 * s, cy - 2 * s, 2 * s, cx, cy, baseRx);
      discGrad.addColorStop(0, pal.rim);
      discGrad.addColorStop(0.28, pal.baseTop);
      discGrad.addColorStop(1, pal.baseSide);
      c.fillStyle = discGrad;
      c.beginPath();
      c.ellipse(cx, cy, baseRx, baseRy, 0, 0, Math.PI * 2);
      c.fill();

      // 底座金屬邊框（殘影為虛線）
      c.strokeStyle = isSelected ? '#fde047' : pal.rim;
      c.lineWidth = (isSelected ? 2 : 1.45) * s;
      if (isGhost) c.setLineDash([3.5 * s, 2.5 * s]);
      c.stroke();
      c.setLineDash([]);

      // 3. 繪製五兵種純造型微縮立雕
      c.save();
      c.translate(cx, cy - 1 * s);
      drawUnitSculpt(c, unit.type, pal, s, dir, nowSec, isGhost);
      c.restore();

      // 受擊瞬間白閃
      if (opts.hitFlash > 0) {
        c.fillStyle = `rgba(255, 255, 255, ${opts.hitFlash * 0.65})`;
        c.beginPath();
        c.ellipse(cx, cy - 14 * s, 14 * s, 18 * s, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();

      // 記錄可見實兵的互動命中框（便於玩家直接點擊立體身軀）
      if (!isGhost && opts.recordHitBox) {
        unitHitBoxes.push({
          x: unit.x,
          y: unit.y,
          left: cx - 15 * s,
          right: cx + 15 * s,
          top: cy - 26 * s,
          bottom: cy + 8 * s
        });
      }

      // 將 HUD 資訊排入前景層繪製，徹底避免被前方相鄰地塊截斷血條
      if (hudQueue) {
        hudQueue.push({ unit, cx, cy, s, baseRx, baseRy, pal, opts });
      }
    }

    function drawUnitHud(c, item, metrics) {
      const { tw, th } = metrics;
      const { unit, cx, cy, s, baseRx, baseRy, pal, opts } = item;
      const isGhost = Boolean(opts.isGhost);
      const isSelected = Boolean(opts.isSelected);

      if (isGhost) {
        const label = opts.turnsAgo === 0 ? '剛目擊' : `${opts.turnsAgo}回前`;
        const fontPx = clamp(tw * 0.125, 8, 10.5);
        c.font = `800 ${fontPx}px system-ui, "PingFang TC", sans-serif`;
        const lw = c.measureText(label).width + 7;
        const lh = 12;
        const ly = cy + baseRy * 0.85;
        drawRoundedRectPath(c, cx - lw * 0.5, ly - lh * 0.5, lw, lh, 4);
        c.fillStyle = 'rgba(15, 23, 42, 0.88)';
        c.fill();
        c.strokeStyle = pal.rim;
        c.lineWidth = 0.9;
        c.stroke();
        c.fillStyle = '#e2e8f0';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(label, cx, ly + 0.5);
        return;
      }

      // 精簡清晰血條膠囊（貼於底座前緣，絕不被相鄰地塊遮切）
      const hpPct = clamp(unit.hp / unit.maxHp, 0, 1);
      const hpColor = hpPct > 0.55 ? '#4ade80' : (hpPct > 0.25 ? '#facc15' : '#f87171');
      const pillW = clamp(tw * 0.48, 27, 39);
      const pillH = clamp(th * 0.34, 11.5, 14);
      const py = cy + baseRy * 0.82;

      drawRoundedRectPath(c, cx - pillW * 0.5, py - pillH * 0.5, pillW, pillH, 3.5);
      c.fillStyle = 'rgba(7, 13, 27, 0.92)';
      c.fill();
      c.strokeStyle = isSelected ? 'rgba(250, 204, 21, 0.95)' : 'rgba(148, 163, 184, 0.52)';
      c.lineWidth = 0.9;
      c.stroke();

      const barX = cx - pillW * 0.5 + 2.5;
      const barY = py - pillH * 0.5 + 2;
      const barW = pillW - 5;
      const barH = 2.8;
      c.fillStyle = 'rgba(30, 41, 59, 0.95)';
      c.fillRect(barX, barY, barW, barH);
      c.fillStyle = hpColor;
      c.fillRect(barX, barY, Math.max(1.5, barW * hpPct), barH);

      c.fillStyle = '#f8fafc';
      c.font = `800 ${clamp(tw * 0.118, 7.6, 9.6)}px ui-monospace, SFMono-Regular, monospace`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(`${unit.hp}/${unit.maxHp}`, cx, py + 2.4);

      // 緊湊微徽章：★ 軍旗激勵、+1/+2 援護、夾 夾擊（貼靠底座兩側不遮臉）
      const badgeFont = clamp(tw * 0.118, 7.5, 9.5);
      c.font = `900 ${badgeFont}px system-ui, "PingFang TC", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';

      if (opts.hasAura) {
        const ax = cx + baseRx * 0.86;
        const ay = cy - 13 * s;
        c.fillStyle = '#eab308';
        c.beginPath();
        c.arc(ax, ay, 5.2 * Math.min(1.1, s), 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#fef08a';
        c.lineWidth = 0.9;
        c.stroke();
        c.fillStyle = '#422006';
        c.fillText('★', ax, ay + 0.4);
      }

      if (opts.support > 0) {
        const sx = cx - baseRx * 0.88;
        const sy = cy - 13 * s;
        const sw = 13.5 * Math.min(1.1, s);
        const sh = 10.5 * Math.min(1.1, s);
        drawRoundedRectPath(c, sx - sw * 0.5, sy - sh * 0.5, sw, sh, 3);
        c.fillStyle = 'rgba(15, 23, 42, 0.92)';
        c.fill();
        c.strokeStyle = '#38bdf8';
        c.lineWidth = 0.9;
        c.stroke();
        c.fillStyle = '#38bdf8';
        c.fillText(`+${opts.support}`, sx, sy + 0.4);
      }

      if (opts.flanked) {
        const fx = cx + baseRx * 0.9;
        const fy = py;
        const fw = 12 * Math.min(1.1, s);
        const fh = 11 * Math.min(1.1, s);
        drawRoundedRectPath(c, fx - fw * 0.5, fy - fh * 0.5, fw, fh, 3);
        c.fillStyle = '#991b1b';
        c.fill();
        c.strokeStyle = '#fca5a5';
        c.lineWidth = 0.9;
        c.stroke();
        c.fillStyle = '#fef2f2';
        c.fillText('夾', fx, fy + 0.4);
      }
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

      // 途經點光球
      for (let i = 1; i < pts.length; i++) {
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(pts[i].bx, pts[i].by, i === pts.length - 1 ? 5.2 : 3.6, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = '#0ea5e9';
        c.lineWidth = 1.6;
        c.stroke();
      }

      // 終點 MP 氣泡
      const lastCoord = hover.previewPath[hover.previewPath.length - 1];
      const lastPt = pts[pts.length - 1];
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

      for (const fx of activeEffects) {
        const elapsed = nowMs - fx.startMs;
        if (elapsed < 0) {
          next.push(fx);
          continue;
        }
        const t = elapsed / fx.durationMs;
        if (t >= 1) continue;
        next.push(fx);

        if (fx.type === 'move') {
          if (isReducedMotion()) continue;
          const ownOrAll = showAll || viewer === fx.faction;
          const visibleSteps = ownOrAll
            ? fx.steps
            : fx.steps.filter(st => st.observed);
          if (visibleSteps.length < 2) continue;

          const segCount = visibleSteps.length - 1;
          const scaled = easeInOutQuad(t) * segCount;
          const segIdx = Math.min(segCount - 1, Math.floor(scaled));
          const segT = scaled - segIdx;
          const a = visibleSteps[segIdx];
          const b = visibleSteps[segIdx + 1];
          const elevA = scene.board.map[a.y][a.x].elev || 0;
          const elevB = scene.board.map[b.y][b.x].elev || 0;
          const hop = Math.sin(segT * Math.PI) * (elevA !== elevB ? 0.36 : 0.12);
          const pos = projectFloatBase(
            lerp(a.x, b.x, segT),
            lerp(a.y, b.y, segT),
            lerp(elevA, elevB, segT) + hop,
            metrics
          );
          unitOverrides.set(fx.unitId, { bx: pos.bx, by: pos.by, shakeX: 0, hitFlash: 0 });
          if (fx.isCharge && (ownOrAll || b.observed)) {
            renderFx.push({ kind: 'chargeTrail', bx: pos.bx, by: pos.by, t });
          }
        } else if (fx.type === 'attack') {
          if (isReducedMotion()) continue;
          const canSeeTarget = showAll || !fx.viewers || fx.viewers.includes(viewer);
          if (!canSeeTarget) continue;
          // 嚴格防洩密：敵方從迷霧發動攻擊時，防守方絕不可看到起點位置或箭矢出發軌跡
          const canSeeOrigin = showAll || viewer === fx.attackerFaction || Boolean(fx.attackerObserved);
          const elevFrom = scene.board.map[fx.fromY][fx.fromX].elev || 0;
          const elevTo = scene.board.map[fx.toY][fx.toX].elev || 0;
          const pFrom = projectBase(fx.fromX, fx.fromY, elevFrom, metrics);
          const pTo = projectBase(fx.toX, fx.toY, elevTo, metrics);

          // 受擊抖動與白閃（在命中階段觸發）
          if (t > 0.38) {
            const ht = (t - 0.38) / 0.62;
            const prev = unitOverrides.get(fx.targetId) || {};
            unitOverrides.set(fx.targetId, {
              ...prev,
              shakeX: Math.sin(ht * Math.PI * 5) * (1 - ht) * 5,
              hitFlash: Math.max(0, 1 - ht * 1.6)
            });
          }

          renderFx.push({
            kind: 'attack',
            fx,
            canSeeOrigin,
            pFrom,
            pTo,
            t
          });
        } else if (fx.type === 'ambush') {
          const canSee = showAll || !fx.viewers || fx.viewers.includes(viewer);
          if (!canSee) continue;
          const elev = scene.board.map[fx.y][fx.x].elev || 0;
          const p = projectBase(fx.x, fx.y, elev, metrics);
          renderFx.push({ kind: 'ambush', p, t });
        }
      }

      activeEffects = next;
      return { unitOverrides, renderFx };
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
          const { fx, canSeeOrigin, pFrom, pTo, t } = item;
          c.save();

          if (canSeeOrigin && fx.attackerType === 'archer' && t < 0.72) {
            // 弓手高拋物線羽箭
            const at = clamp(t / 0.62, 0, 1);
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
          } else if (canSeeOrigin && fx.attackerType === 'spear' && t < 0.62) {
            // 長矛閃亮突刺穿刺線
            const st = easeOutCubic(clamp(t / 0.5, 0, 1));
            const sx = lerp(pFrom.bx, pTo.bx, st);
            const sy = lerp(pFrom.by - 16, pTo.by - 14, st);
            c.strokeStyle = `rgba(224, 242, 254, ${1 - t * 1.4})`;
            c.lineWidth = 3.2;
            c.lineCap = 'round';
            c.beginPath();
            c.moveTo(pFrom.bx, pFrom.by - 16);
            c.lineTo(sx, sy);
            c.stroke();
          } else if (canSeeOrigin && fx.isCharge && t < 0.65) {
            // 輕騎衝鋒金光軌跡
            c.strokeStyle = `rgba(251, 191, 36, ${0.85 * (1 - t / 0.65)})`;
            c.lineWidth = 4.5;
            c.lineCap = 'round';
            c.beginPath();
            c.moveTo(pFrom.bx, pFrom.by - 12);
            c.lineTo(pTo.bx, pTo.by - 12);
            c.stroke();
          }

          // 命中斬擊／破盾爆裂（迷霧中受擊只顯示此局部爆發，絕不洩露攻方位置）
          if (t >= 0.32) {
            const bt = clamp((t - 0.32) / 0.68, 0, 1);
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
    function drawFrame(nowMs) {
      if (!scene || !scene.board) return;
      const nowSec = nowMs * 0.001;
      const metrics = getMetrics();

      // 鏡頭平滑重置動畫
      if (camera.anim) {
        const t = clamp((nowMs - camera.anim.start) / camera.anim.dur, 0, 1);
        const e = easeOutCubic(t);
        camera.zoom = lerp(camera.anim.fromZoom, camera.anim.toZoom, e);
        camera.panX = lerp(camera.anim.fromPanX, camera.anim.toPanX, e);
        camera.panY = lerp(camera.anim.fromPanY, camera.anim.toPanY, e);
        clampPan();
        if (t >= 1) camera.anim = null;
        emitCameraChange(false);
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 背景夜空戰術微光漸層
      const bgGrad = ctx.createRadialGradient(width * 0.42, height * 0.34, width * 0.06, width * 0.5, height * 0.52, Math.max(width, height) * 0.78);
      bgGrad.addColorStop(0, '#13233b');
      bgGrad.addColorStop(0.55, '#0b1426');
      bgGrad.addColorStop(1, '#060a14');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // 鏡頭變換（以畫布中心為樞紐進行縮放與平移）
      ctx.translate(width * 0.5 + camera.panX, height * 0.5 + camera.panY);
      ctx.scale(camera.zoom, camera.zoom);
      ctx.translate(-width * 0.5, -height * 0.5);

      // 1. 沙盤台座與外緣座標
      drawDioramaPlinth(ctx, metrics);

      // 2. 預處理滑行／受擊動畫覆寫與單位索引
      const { unitOverrides, renderFx } = pruneAndSampleEffects(nowMs);
      const board = scene.board;
      const showAll = Boolean(scene.showAll);
      const vv = scene.vision;
      const selUnit = scene.selUnit || null;
      const hovered = hover.hoveredTile;
      const hoveredRot = hovered ? toRotated(hovered.x, hovered.y, camera.rot) : null;
      const selRot = selUnit ? toRotated(selUnit.x, selUnit.y, camera.rot) : null;

      unitHitBoxes = [];
      const unitHudQueue = [];

      // 3. 畫家演算法（由遠到近逐格渲染地形、森林、迷霧、戰術疊層與微縮棋子）
      for (let sum = 0; sum <= (BOARD_SIZE - 1) * 2; sum++) {
        for (let rx = 0; rx < BOARD_SIZE; rx++) {
          const ry = sum - rx;
          if (ry < 0 || ry >= BOARD_SIZE) continue;
          const { x, y } = fromRotated(rx, ry, camera.rot);
          const k = keyOf(x, y);
          const cell = board.map[y][x];
          const elev = cell.elev || 0;
          const { bx, by } = projectBase(x, y, elev, metrics);

          const isVis = showAll || vv.tileVisible[y][x];
          const isForestRev = showAll || vv.forestReveal[y][x];
          const unit = scene.visibleUnitsByKey.get(k) || null;
          const ghost = !unit && scene.ghostsByKey ? scene.ghostsByKey.get(k) : null;
          const occupied = Boolean(unit || ghost);

          // 若後方相鄰格有選中單位或滑鼠懸停，前景樹冠柔和淡出防遮擋
          const softFadeTree = Boolean(
            (hoveredRot && ((rx === hoveredRot.rx + 1 && ry === hoveredRot.ry) || (rx === hoveredRot.rx && ry === hoveredRot.ry + 1) || (rx === hoveredRot.rx + 1 && ry === hoveredRot.ry + 1))) ||
            (selRot && ((rx === selRot.rx + 1 && ry === selRot.ry) || (rx === selRot.rx && ry === selRot.ry + 1)))
          );

          // 3a. 地塊與岩壁
          drawTileBase(ctx, x, y, cell, bx, by, metrics);

          // 3b. 戰爭迷霧或林內隱蔽（放於地塊上、戰術框下，讓可達格等操作清楚）
          if (!isVis) {
            drawFogOverlay(ctx, x, y, bx, by, metrics, nowSec);
          }

          // 3c. 戰術疊層
          const flags = {
            inZoc: scene.zocKeys.has(k),
            enemyAttack: scene.enemyAttackKeys.has(k),
            enemyTrail: scene.enemyTrailKeys.has(k),
            reachable: scene.reachableKeys.has(k),
            charge: scene.chargeKeys.has(k),
            attackable: Boolean(unit && scene.attackableIds.has(unit.id)),
            ambushFlash: Boolean(scene.ambushFlashKey === k),
            replayMarkers: scene.markersByKey ? scene.markersByKey.get(k) : null,
            isHovered: Boolean(hovered && hovered.x === x && hovered.y === y)
          };
          drawTileTacticalOverlays(ctx, x, y, bx, by, metrics, flags, nowSec);

          // 3d. 後排松樹
          if (cell.terrain === 'forest') {
            drawForestCluster(ctx, x, y, bx, by, metrics, {
              occupied,
              softFade: softFadeTree || flags.isHovered,
              isFogged: !isVis,
              layer: 'back'
            });
          }

          // 3e. 單位微縮模型或殘影
          if (unit) {
            const ov = unitOverrides.get(unit.id);
            const drawX = ov && Number.isFinite(ov.bx) ? ov.bx : bx;
            const drawY = ov && Number.isFinite(ov.by) ? ov.by : by;
            const meta = scene.unitMetaById.get(unit.id) || {};
            drawUnitMiniature(ctx, unit, drawX, drawY, metrics, {
              isGhost: false,
              isSelected: Boolean(selUnit && selUnit.id === unit.id),
              hasAura: Boolean(meta.hasAura),
              support: meta.support || 0,
              flanked: Boolean(meta.flanked),
              shakeX: ov ? (ov.shakeX || 0) : 0,
              hitFlash: ov ? (ov.hitFlash || 0) : 0,
              recordHitBox: true
            }, nowSec, unitHudQueue);
          } else if (ghost) {
            drawUnitMiniature(ctx, ghost, bx, by, metrics, {
              isGhost: true,
              turnsAgo: Math.max(0, board.turn - ghost.turn),
              recordHitBox: false
            }, nowSec, unitHudQueue);
          }

          // 3f. 前排松樹與未探明樹林暗幕
          if (cell.terrain === 'forest') {
            drawForestCluster(ctx, x, y, bx, by, metrics, {
              occupied,
              softFade: softFadeTree || flags.isHovered,
              isFogged: !isVis,
              layer: 'front'
            });
            if (isVis && !isForestRev) {
              drawForestConcealOverlay(ctx, bx, by, metrics);
            }
          }
        }
      }

      // 3.5 前景單位血條與微徽章層（完整不被前方地塊截切）
      for (const hudItem of unitHudQueue) {
        drawUnitHud(ctx, hudItem, metrics);
      }

      // 4. 懸停移動路徑線（繪在地形與棋子層之上，指引清晰）
      drawHoverMovePath(ctx, metrics);

      // 5. 動態攻擊／箭矢／衝鋒／伏擊特效
      drawForegroundEffects(ctx, renderFx, metrics);

      // 6. 浮動傷害與狀態文字
      drawFloatTexts(ctx, metrics, nowMs);

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
    }

    function needsContinuousAnimation() {
      if (!active || !scene) return false;
      if (camera.anim || activeEffects.length > 0 || pulseStart > 0) return true;
      if (scene.floatEffects && scene.floatEffects.length > 0) return true;
      if (isReducedMotion()) return false;
      // 柔和飄霧、旗幟擺動、可攻脈衝與敵軍軌跡（限制為平滑節能更新）
      return true;
    }

    function loop(nowMs) {
      rafId = null;
      if (!active) return;
      const highRate = Boolean(camera.anim || activeEffects.length > 0 || pulseStart > 0 || dragState?.moved || pinchState || (scene && scene.floatEffects && scene.floatEffects.length > 0));
      const minInterval = highRate ? 0 : 42; // 靜態待機下以 ~24fps 柔和飄霧省電，互動／動畫全速 60fps
      if (dirty || (nowMs - lastFrameAt >= minInterval)) {
        dirty = false;
        lastFrameAt = nowMs;
        drawFrame(nowMs);
      }
      if (needsContinuousAnimation()) {
        rafId = requestAnimationFrame(loop);
      }
    }

    /* =========================================================
     * 滑鼠與觸控互動（游標中心縮放、6px 防誤觸平移、雙指縮放、點格）
     * ========================================================= */
    function handleWheel(e) {
      if (!active) return;
      e.preventDefault();
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
      if (!active) return;
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
          markDirty();
          emitCameraChange(false);
        } else {
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
          pointers.clear();
          dragState = null;
          pinchState = null;
          canvas.classList.remove('is-dragging');
        }
      },

      setScene(nextScene) {
        scene = nextScene;
        markDirty();
      },

      setHover(nextHover) {
        hover = nextHover || { hoveredTile: null, previewPath: [] };
        markDirty();
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
        markDirty();
      },

      triggerBlueTurnPulse() {
        pulseStart = typeof performance === 'object' ? performance.now() : Date.now();
        markDirty();
      },

      rotate(delta) {
        camera.rot = (camera.rot + (delta >= 0 ? 1 : 3)) % 4;
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
        if (!scene || !scene.board) return null;
        const metrics = getMetrics();
        const elev = scene.board.map[y][x].elev || 0;
        const base = projectBase(x, y, elev, metrics);
        const pt = baseToScreen(base.bx, base.by);
        const unitLift = clamp(metrics.tw * 0.56, 28, 52) * camera.zoom;
        return {
          x: pt.sx,
          y: pt.sy,
          topY: pt.sy - unitLift,
          bottomY: pt.sy + metrics.th * 0.52 * camera.zoom,
          width,
          height
        };
      },

      resize,

      destroy() {
        this.setActive(false);
        resizeObserver?.disconnect();
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
