(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TFCBoard25DUnits = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const CACHE_LIMIT = 12 * 1024 * 1024;
  const ART_SIZE = 56;
  const FOOT_ANCHOR = 0.88;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const profiles = {
    flag: { halfWidth: 21, height: 46 },
    shield: { halfWidth: 16, height: 36 },
    spear: { halfWidth: 23, height: 44 },
    archer: { halfWidth: 21, height: 39 },
    cavalry: { halfWidth: 24, height: 42 }
  };

  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function inside(a, b) {
    return !b || (a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom);
  }

  function basePath(c, x, y, rx, ry, faction) {
    c.beginPath();
    if (faction === 'blue') {
      c.ellipse(x, y, rx, ry, 0, 0, TAU);
    } else {
      for (let i = 0; i < 8; i++) {
        const angle = (i + 0.5) * TAU / 8;
        c.lineTo(x + Math.cos(angle) * rx, y + Math.sin(angle) * ry);
      }
    }
    c.closePath();
  }

  function drawSelection(c, x, y, s, nowSec, animate) {
    c.save();
    c.translate(x, y);
    c.scale(1, 0.5);
    c.strokeStyle = 'rgba(253, 224, 71, 0.9)';
    c.lineWidth = 1.55 * s;
    c.beginPath();
    c.arc(0, 0, 20 * s, 0, TAU);
    c.stroke();
    c.rotate(animate ? nowSec * 0.65 : 0);
    c.beginPath();
    for (let i = 0; i < 8; i++) {
      c.rotate(TAU / 8);
      c.moveTo(19 * s, -1.7 * s);
      c.lineTo(23 * s, 0);
      c.lineTo(19 * s, 1.7 * s);
    }
    c.stroke();
    c.restore();
  }

  function drawBase(c, item, nowSec, animate) {
    const { unit, x, y, s, rx, ry, palette, opts } = item;
    const selected = opts.isSelected;
    const ghost = opts.isGhost;
    c.save();
    if (selected) drawSelection(c, x, y, s, nowSec, animate);

    // 接觸陰影在不同地表色調上仍保留落地感。
    const shadow = c.createRadialGradient(x + s, y + 2 * s, 2 * s, x + s, y + 2 * s, 17 * s);
    shadow.addColorStop(0, 'rgba(5, 9, 19, 0.56)');
    shadow.addColorStop(1, 'rgba(5, 9, 19, 0)');
    c.save();
    c.translate(x + s, y + 2 * s);
    c.scale(1, 0.52);
    c.translate(-x - s, -y - 2 * s);
    c.fillStyle = shadow;
    c.beginPath();
    c.arc(x + s, y + 2 * s, 17 * s, 0, TAU);
    c.fill();
    c.restore();

    if (ghost) c.globalAlpha *= 0.65;
    basePath(c, x, y + 3 * s, rx, ry, unit.faction);
    c.fillStyle = palette.baseSide;
    c.fill();
    const gradient = c.createLinearGradient(x, y - ry, x, y + ry);
    const baseTop = unit.faction === 'blue' ? '#36587e' : '#754445';
    gradient.addColorStop(0, ghost ? palette.baseTop : baseTop);
    gradient.addColorStop(1, palette.baseSide);
    basePath(c, x, y, rx, ry, unit.faction);
    c.fillStyle = gradient;
    c.fill();
    c.strokeStyle = selected ? '#fde047' : palette.rim;
    c.lineWidth = 1.15 * s;
    if (ghost) c.setLineDash([2.5 * s, 1.8 * s]);
    c.stroke();

    if (!ghost) {
      // 圓底座的獅首與八角底座的展翼徽記提供不依賴衣色的辨識。
      c.translate(x, y + 2.5 * s);
      c.scale(s, s);
      c.strokeStyle = opts.hasAura ? '#fde68a' : palette.rim;
      c.lineWidth = 1;
      c.beginPath();
      if (unit.faction === 'blue') {
        c.moveTo(-4.1, 0.2);
        c.lineTo(-3.6, -2.1);
        c.lineTo(-1.6, -1.7);
        c.lineTo(0, -2.4);
        c.lineTo(1.6, -1.7);
        c.lineTo(3.6, -2.1);
        c.lineTo(4.1, 0.2);
        c.lineTo(0, 2.7);
        c.closePath();
      } else {
        c.moveTo(-6, -1.6);
        c.lineTo(-3.5, 0.8);
        c.lineTo(-1.3, 0.3);
        c.lineTo(0, 2.6);
        c.lineTo(1.3, 0.3);
        c.lineTo(3.5, 0.8);
        c.lineTo(6, -1.6);
      }
      c.stroke();
    }
    c.restore();
  }

  function create({ getAsset, getQuality, isReducedMotion, getFactionPalette, drawUnitSculpt, drawRoundedRectPath, facingSignFor }) {
    const spriteCache = new Map();
    let spriteBytes = 0;

    function releaseSprite(key) {
      const entry = spriteCache.get(key);
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      spriteCache.delete(key);
      spriteBytes -= entry.bytes;
    }

    function clearCache() {
      for (const key of spriteCache.keys()) releaseSprite(key);
    }

    function drawSpriteSource(c, model, px) {
      if (model.image) {
        if (model.dir < 0) {
          c.translate(px, 0);
          c.scale(-1, 1);
        }
        c.drawImage(model.image, 0, 0, px, px);
        return;
      }
      c.translate(px * 0.5, px * FOOT_ANCHOR);
      drawUnitSculpt(c, model.unit.type, model.palette, px / ART_SIZE, model.dir, 0, false);
    }

    function getSprite(model, variant) {
      if (!model.image && variant !== 'outline') return null;
      const supersampling = getQuality() === 'high' ? 2 : 1;
      const scale = (model.opts.zoom || 1) * (model.opts.dpr || 1) * supersampling;
      // 棋子的原圖為 384px，剪影與全息殘影保留較低解析度即可。
      const px = clamp(Math.round(ART_SIZE * model.s * scale / 32) * 32, 32, variant === 'normal' ? 384 : 256);
      const key = [model.unit.faction, model.unit.type, model.dir, px, variant].join(':');
      const entry = spriteCache.get(key);
      if (entry && entry.image === model.image) {
        spriteCache.delete(key);
        spriteCache.set(key, entry);
        return entry.canvas;
      }
      if (entry) releaseSprite(key);
      const canvas = document.createElement('canvas');
      canvas.width = px;
      canvas.height = px;
      const c = canvas.getContext('2d');
      if (!c) return null;
      c.save();
      drawSpriteSource(c, model, px);
      c.restore();
      if (variant === 'ghost') {
        c.globalCompositeOperation = 'source-atop';
        c.fillStyle = 'rgba(135, 195, 224, 0.60)';
        c.fillRect(0, 0, px, px);
        c.fillStyle = 'rgba(190, 235, 255, 0.46)';
        const step = Math.max(3, Math.round(px / 32));
        for (let y = 0; y < px; y += step) c.fillRect(0, y, px, Math.max(1, step / 4));
      } else if (variant === 'outline') {
        const mask = document.createElement('canvas');
        mask.width = mask.height = px;
        mask.getContext('2d').drawImage(canvas, 0, 0);
        c.clearRect(0, 0, px, px);
        const edge = Math.max(1, Math.round(px / ART_SIZE));
        c.drawImage(mask, -edge, 0);
        c.drawImage(mask, edge, 0);
        c.drawImage(mask, 0, -edge);
        c.drawImage(mask, 0, edge);
        c.globalCompositeOperation = 'destination-out';
        c.drawImage(mask, 0, 0);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = model.unit.faction === 'blue' ? '#9edbff' : '#ffb3a9';
        c.fillRect(0, 0, px, px);
        mask.width = mask.height = 0;
      }
      const bytes = px * px * 4;
      while (spriteBytes + bytes > CACHE_LIMIT) releaseSprite(spriteCache.keys().next().value);
      spriteCache.set(key, { canvas, bytes, image: model.image });
      spriteBytes += bytes;
      return canvas;
    }

    function drawModel(c, model, nowSec) {
      const { unit, x, y, s, palette, dir, opts } = model;
      const animate = !isReducedMotion() && !opts.isGhost;
      const lively = animate && getQuality() === 'high';
      const phase = nowSec * 3 + unit.x * 1.7 + unit.y * 2.2;
      const bounce = lively && unit.type === 'cavalry' ? Math.sin(phase) * s : 0;
      const sway = animate && unit.type === 'flag' ? Math.sin(phase * 0.72) * 0.021 : 0;
      const collapse = opts.collapse || 0;
      c.save();
      c.translate(x, y - s + bounce + collapse * 7 * s);
      c.rotate((opts.tilt || 0) + sway + collapse * dir * 1.3);
      c.scale(1, lively ? 1 + Math.sin(phase) * 0.012 : 1);
      const sprite = getSprite(model, opts.isGhost ? 'ghost' : 'normal');
      if (sprite) {
        if (opts.isGhost) {
          c.globalAlpha *= 0.62;
          c.shadowColor = 'rgba(125, 211, 252, 0.55)';
          c.shadowBlur = 2.5 * s;
        }
        c.drawImage(sprite, -ART_SIZE * s * 0.5, -ART_SIZE * s * FOOT_ANCHOR, ART_SIZE * s, ART_SIZE * s);
      } else {
        drawUnitSculpt(c, unit.type, palette, s, dir, animate ? nowSec : 0, Boolean(opts.isGhost));
      }
      if (opts.hitFlash > 0) {
        c.fillStyle = `rgba(250, 79, 72, ${opts.hitFlash * 0.37})`;
        c.beginPath();
        c.ellipse(0, -18 * s, 12 * s, 15 * s, 0, 0, TAU);
        c.fill();
      }
      c.restore();

      if (collapse > 0.55) {
        c.save();
        c.fillStyle = `rgba(226, 232, 240, ${(1 - collapse) * 0.8})`;
        for (let i = 0; i < 7; i++) {
          const angle = i * TAU / 7;
          const radius = (collapse - 0.45) * 35 * s;
          c.fillRect(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius * 0.5, 1.8 * s, 1.8 * s);
        }
        c.restore();
      }
    }

    function drawMiniature(c, unit, bx, by, metrics, opts, nowSec, hudQueue, hitBoxes) {
      const s = clamp(metrics.tw / 66, 0.52, 1.32);
      const x = bx + (opts.shakeX || 0);
      const y = by - (opts.isSelected ? 1.8 * s : 0);
      const profile = profiles[unit.type] || profiles.shield;
      const body = {
        left: x - profile.halfWidth * s,
        right: x + profile.halfWidth * s,
        top: y - profile.height * s,
        bottom: y + 8 * s
      };
      const item = {
        unit, x, y, s, body, opts, rx: 13.5 * s, ry: 6.5 * s,
        palette: getFactionPalette(unit.faction, Boolean(opts.isGhost)),
        dir: facingSignFor(unit.faction, opts.theta || 0),
        image: getAsset(`units/${unit.faction}_${unit.type}.png`) || null
      };
      c.save();
      c.globalAlpha *= opts.opacity ?? 1;
      drawBase(c, item, nowSec, !isReducedMotion());
      // 血量環貼在底座，讓前景棋身自然遮住後排血量環。
      if (!opts.isGhost && !opts.isCasualty) drawHealthRing(c, item, nowSec);
      drawModel(c, item, nowSec);
      c.restore();

      if (opts.isCasualty) return;
      if (opts.recordHitBox && !opts.isGhost && hitBoxes) {
        hitBoxes.push({
          id: unit.id, x: unit.x, y: unit.y,
          baseX: x, baseY: y, baseRx: item.rx, baseRy: item.ry,
          left: x - 14.5 * s, right: x + 14.5 * s,
          top: y - Math.min(27, profile.height) * s, bottom: y + 7 * s
        });
      }
      if (hudQueue) hudQueue.push(item);
    }

    function drawXray(c, queue, occluders = []) {
      for (const [index, item] of queue.entries()) {
        if (item.opts.isGhost) continue;
        const order = item.opts.order ?? index;
        const covers = occluders.filter(rect => rect.order > order && overlaps(item.body, rect));
        for (let next = index + 1; next < queue.length; next++) {
          const foreground = queue[next];
          if (!foreground.opts.isGhost && overlaps(item.body, foreground.body)) covers.push(foreground.body);
        }
        if (!covers.length) continue;
        const silhouette = getSprite(item, 'outline');
        if (!silhouette) continue;
        const size = ART_SIZE * item.s;
        const left = item.x - size * 0.5;
        const top = item.y - size * FOOT_ANCHOR - item.s;
        c.save();
        c.beginPath();
        for (const cover of covers) c.rect(cover.left, cover.top, cover.right - cover.left, cover.bottom - cover.top);
        c.clip();
        // 彩色輪廓只出現在遮擋區，手勢命中仍由棋盤決定。
        c.globalAlpha *= 0.54;
        c.drawImage(silhouette, left, top, size, size);
        c.restore();
      }
    }

    function drawHealthRing(c, item, nowSec) {
      const { unit, x, y, s, rx, ry, opts } = item;
      const fraction = clamp(unit.hp / unit.maxHp, 0, 1);
      const color = fraction > 0.55 ? '#83db9e' : (fraction > 0.25 ? '#efd46d' : '#f18e96');
      const ringX = rx + 1.25 * s;
      const ringY = ry + 0.95 * s;
      c.save();
      c.beginPath();
      c.ellipse(x, y, ringX, ringY, 0, 0, TAU);
      c.lineWidth = 2.9 * s;
      c.strokeStyle = 'rgba(9, 15, 25, 0.84)';
      c.stroke();
      if (opts.flanked) {
        c.beginPath();
        c.ellipse(x, y, ringX + 2.3 * s, ringY + 1.75 * s, 0, 0, TAU);
        c.lineWidth = 1.25 * s;
        c.strokeStyle = '#f87171';
        c.setLineDash([2 * s, 2 * s]);
        c.stroke();
        c.setLineDash([]);
      }
      c.beginPath();
      c.ellipse(x, y, ringX, ringY, 0, -Math.PI * 0.5, -Math.PI * 0.5 + TAU * fraction);
      c.strokeStyle = color;
      c.lineWidth = 1.65 * s;
      if (fraction <= 0.25 && !isReducedMotion() && getQuality() === 'high') {
        c.globalAlpha *= 0.77 + Math.sin(nowSec * 4) * 0.2;
      }
      c.stroke();
      c.restore();
    }

    function drawLabel(c, text, bounds, color) {
      const width = bounds.right - bounds.left;
      const height = bounds.bottom - bounds.top;
      drawRoundedRectPath(c, bounds.left, bounds.top, width, height, height * 0.26);
      c.fillStyle = 'rgba(9, 16, 28, 0.95)';
      c.fill();
      c.strokeStyle = color;
      c.lineWidth = Math.min(0.85, height * 0.075);
      c.stroke();
      c.fillStyle = '#f8fafc';
      c.fillText(text, bounds.left + width * 0.5, bounds.top + height * 0.52);
    }

    function drawHud(c, queue, metrics, { zoom = 1, hoveredTile, showDetails, viewBounds } = {}) {
      const font = clamp(metrics.tw * 0.152 * zoom, 9.5, 13) / zoom;
      const labelHeight = font + 4 / zoom;
      const bodyBoxes = queue.map(item => item.body);
      const labels = [];
      const candidates = [];
      c.save();
      c.font = `800 ${font}px system-ui, "PingFang TC", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (const item of queue) {
        const { unit, x, y, opts, palette } = item;
        if (opts.isGhost) {
          const text = opts.turnsAgo ? `${opts.turnsAgo}回前` : '剛目擊';
          const width = c.measureText(text).width + 6 / zoom;
          const top = y + item.ry + 3 / zoom;
          const bounds = { left: x - width / 2, right: x + width / 2, top, bottom: top + labelHeight };
          labels.push(bounds);
          drawLabel(c, text, bounds, palette.rim);
          continue;
        }
        const isHovered = hoveredTile && unit.x === hoveredTile.x && unit.y === hoveredTile.y;
        const priority = isHovered ? 3 : (opts.isSelected ? 2 : 1);
        if (priority > 1 || showDetails || zoom >= 1.4) candidates.push({ item, priority });
      }

      // 優先安置指向與已選棋子的詳情，其他標籤只使用未被棋子或標籤遮住的位置。
      candidates.sort((a, b) => b.priority - a.priority);
      for (const { item, priority } of candidates) {
        const { unit, x, body, opts, palette } = item;
        const badges = [opts.support > 0 ? `+${opts.support}` : '', opts.hasAura ? '★' : '', opts.flanked ? '夾' : ''];
        const text = [`${unit.hp}/${unit.maxHp}`, ...badges.filter(Boolean)].join('  ');
        const width = c.measureText(text).width + 8 / zoom;
        const above = body.top - labelHeight - 3 / zoom;
        const sideOffset = Math.min(width * 0.65, metrics.tw * 0.38);
        const positions = [[x, above], [x - sideOffset, above], [x + sideOffset, above]];
        if (priority > 1 || showDetails) {
          positions.push([x, above - labelHeight - 3 / zoom], [x, body.bottom + 3 / zoom]);
        }
        for (const [center, top] of positions) {
          const bounds = { left: center - width / 2, right: center + width / 2, top, bottom: top + labelHeight };
          if (!inside(bounds, viewBounds) || bodyBoxes.some(box => overlaps(bounds, box)) || labels.some(label => overlaps(bounds, label))) continue;
          labels.push(bounds);
          drawLabel(c, text, bounds, opts.isSelected ? '#fde68a' : palette.rim);
          break;
        }
      }
      c.restore();
    }

    return { clearCache, drawMiniature, drawXray, drawHud };
  }

  return { create };
});
