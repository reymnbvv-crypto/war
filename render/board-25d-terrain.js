(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TFC25DTerrain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 10;
  const MASK_TILE = 32;
  const MASK_SIZE = SIZE * MASK_TILE;
  const SLOPE_WIDTH = 0.21;
  const PLATFORM_JOIN = 0.018;
  const LEVEL_EDGES = [0, 0, 0, 0];
  // 依世界座標排列北、東、南、西四條邊以及其外法線。
  const SIDES = [
    { dx: 0, dy: -1, a: 0, b: 1 },
    { dx: 1, dy: 0, a: 1, b: 2 },
    { dx: 0, dy: 1, a: 2, b: 3 },
    { dx: -1, dy: 0, a: 3, b: 0 }
  ];
  const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const keyOf = (x, y) => `${x},${y}`;
  const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
  const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const elevAt = (map, x, y) => map[y]?.[x]?.elev || 0;

  function cliffHeight(map, x, y, side) {
    return Math.max(0, elevAt(map, x, y) - elevAt(map, x + side.dx, y + side.dy));
  }

  function edgePoint([ax, ay], [bx, by], fraction) {
    return [ax + (bx - ax) * fraction, ay + (by - ay) * fraction];
  }

  // 坡腳落在格邊，頂緣只沿落差邊內收。同高度相鄰格共用頂面。
  // 使用相同投影輪廓繪製坡面與判定點格。
  function projectHill(map, x, y, project) {
    const elevation = elevAt(map, x, y);
    const drops = SIDES.map(side => cliffHeight(map, x, y, side));
    const insets = drops.map(drop => drop ? SLOPE_WIDTH : 0);
    // 同一高度的邊緣少量交疊，避免透出抗鋸齒亮縫。
    const [north, east, south, west] = insets.map(inset => inset || -PLATFORM_JOIN);
    const corners = [[west, north], [1 - east, north], [1 - east, 1 - south], [west, 1 - south]];
    const at = ([u, v], height) => project(x + u - 0.5, y + v - 0.5, height);
    const edges = SIDES.map((side, i) => {
      const a = corners[side.a];
      const b = corners[side.b];
      const drop = drops[i];
      if (!drop) return { rim: [at(a, elevation), at(b, elevation)] };

      const cutStart = drops[(i + 3) % 4] ? 0.12 : 0;
      const cutEnd = drops[(i + 1) % 4] ? 0.12 : 0;
      const irregularity = (x + y + i) % 2 === 0 ? 0.03 : -0.03;
      const rim = [cutStart, 0.34, 0.67, 1 - cutEnd].map((fraction, index) => {
        const [u, v] = edgePoint(a, b, fraction);
        const offset = index === 1 ? irregularity : index === 2 ? -irregularity : 0;
        return at([u - side.dx * offset, v - side.dy * offset], elevation);
      });
      const foot = [cutStart * 0.42, 1 - cutEnd * 0.42].map(fraction =>
        at(edgePoint(CORNERS[side.a], CORNERS[side.b], fraction), elevation - drop));
      return { rim, foot };
    });

    const slopes = [];
    function addSlope(rim, foot, shade, textureSpan = 1) {
      const polygon = [...rim, foot[1], foot[0]];
      const area = polygon.reduce((sum, point, i) => {
        const next = polygon[(i + 1) % polygon.length];
        return sum + point.bx * next.by - point.by * next.bx;
      }, 0);
      if (area < -0.01) slopes.push({ polygon, rim, foot, shade, textureSpan });
    }
    for (const [i, edge] of edges.entries()) {
      if (!edge.foot) continue;
      const shade = i === 1 || i === 2;
      addSlope(edge.rim, edge.foot, shade);
      const next = edges[(i + 1) % 4];
      if (next.foot) {
        addSlope([edge.rim.at(-1), next.rim[0]], [edge.foot[1], next.foot[0]], shade, 0.14);
      }
    }
    return { top: edges.flatMap(edge => edge.rim), slopes, insets };
  }

  function polygonContains(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j];
      const b = points[i];
      if ((a.by > y) !== (b.by > y) && x < (b.bx - a.bx) * (y - a.by) / (b.by - a.by) + a.bx) inside = !inside;
    }
    return inside;
  }

  function hillContains(hill, x, y) {
    return polygonContains(hill.top, x, y) || hill.slopes.some(slope => polygonContains(slope.polygon, x, y));
  }

  function tracePolygon(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].bx, points[0].by);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].bx, points[i].by);
    ctx.closePath();
  }

  function transformSurface(ctx, project, x, y, elev = 0) {
    const origin = project(x, y, elev);
    const east = project(x + 1, y, elev);
    const south = project(x, y + 1, elev);
    ctx.transform(east.bx - origin.bx, east.by - origin.by,
      south.bx - origin.bx, south.by - origin.by, origin.bx, origin.by);
  }

  function roundedRect(ctx, l, t, r, b, [nw, ne, se, sw]) {
    ctx.moveTo(l + nw, t);
    ctx.lineTo(r - ne, t);
    ctx.quadraticCurveTo(r, t, r, t + ne);
    ctx.lineTo(r, b - se);
    ctx.quadraticCurveTo(r, b, r - se, b);
    ctx.lineTo(l + sw, b);
    ctx.quadraticCurveTo(l, b, l, b - sw);
    ctx.lineTo(l, t + nw);
    ctx.quadraticCurveTo(l, t, l + nw, t);
    ctx.closePath();
  }

  // 視野與林緣只需檢查相鄰八格，柔化寬度遠小於一格。
  function sampleMask(canvas, grid, alphaFor, color) {
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(MASK_SIZE, MASK_SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const inside = grid[y][x];
        const edges = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const neighbor = grid[y + dy]?.[x + dx];
            if (neighbor !== undefined && neighbor !== inside) edges.push([dx, dy]);
          }
        }
        for (let py = 0; py < MASK_TILE; py++) {
          const fy = (py + 0.5) / MASK_TILE;
          for (let px = 0; px < MASK_TILE; px++) {
            const fx = (px + 0.5) / MASK_TILE;
            let distance = 1;
            for (const [dx, dy] of edges) {
              const wx = dx < 0 ? fx : dx > 0 ? 1 - fx : 0;
              const wy = dy < 0 ? fy : dy > 0 ? 1 - fy : 0;
              distance = Math.min(distance, wx && wy ? Math.sqrt(wx * wx + wy * wy) : wx + wy);
            }
            const i = ((y * MASK_TILE + py) * MASK_SIZE + x * MASK_TILE + px) * 4;
            image.data[i] = color[0];
            image.data[i + 1] = color[1];
            image.data[i + 2] = color[2];
            image.data[i + 3] = alphaFor(inside, distance, x + fx, y + fy);
          }
        }
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  function create({ assets, canvas, tileHash }) {
    function newCanvas(width, height) {
      const result = canvas();
      result.width = width;
      result.height = height;
      return result;
    }

    const ground = newCanvas(1, 1);
    const hillSurface = newCanvas(1, 1);
    const scree = newCanvas(384, 144);
    const forestMask = newCanvas(MASK_SIZE, MASK_SIZE);
    const fogMask = newCanvas(MASK_SIZE, MASK_SIZE);
    const fogClouds = newCanvas(MASK_SIZE, MASK_SIZE);
    const fallbackTextures = new Map();
    const shadedTrees = new Map();
    const reveals = new Map();
    let mapForGround;
    let groundQuality;
    let groundVersion;
    let forestLayout = [];
    let fogScene;
    let fogBits = '';
    let fogMap;
    let fogView;
    let hasFog = false;
    let hillSurfaceKey = '';
    let screeSource;
    let hillPixels = 96;
    let cloudAt = -Infinity;
    let cloudMode = '';
    let tacticsScene;
    let tacticsByTile = new Map();

    function texture(name) {
      const loaded = assets(`terrain/${name}.png`);
      if (loaded) return loaded;
      if (fallbackTextures.has(name)) return fallbackTextures.get(name);

      const image = newCanvas(256, name === 'cliff_face' ? 96 : 256);
      const ctx = image.getContext('2d');
      if (name === 'cliff_face') {
        const gradient = ctx.createLinearGradient(0, 0, 0, image.height);
        gradient.addColorStop(0, '#818558');
        gradient.addColorStop(0.23, '#8e7b5e');
        gradient.addColorStop(1, '#403d31');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 256, 96);
        for (let col = 0; col < 13; col++) {
          const x = col * 22 - 7;
          const y = 10 + 16 * tileHash(col, 0, 73);
          ctx.fillStyle = tileHash(col, 0, 14) < 0.5 ? '#b1a18442' : '#272c2152';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + 19, y - 5);
          ctx.lineTo(x + 24, 73);
          ctx.lineTo(x + 6, 92);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = '#92965c';
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(256, 0);
        for (let x = 256; x >= 0; x -= 8) ctx.lineTo(x, 8 + 6 * tileHash(x, 0, 86));
        ctx.closePath();
        ctx.fill();
      } else if (name === 'fog_cloud') {
        // 週期化零素材雲紋，四周可平鋪。
        const pixels = ctx.createImageData(256, 256);
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 256; x++) {
            const u = x * Math.PI / 128;
            const v = y * Math.PI / 128;
            const cloud = 0.54 + Math.sin(u * 3 + Math.cos(v * 2)) * 0.19
              + Math.sin(u * 2 - v * 3) * 0.13 + Math.cos(u * 5 + v * 2) * 0.10;
            const i = (y * 256 + x) * 4;
            pixels.data.set([172, 193, 214, Math.round(smooth(cloud) * 180)], i);
          }
        }
        ctx.putImageData(pixels, 0, 0);
      } else {
        const color = { grass: '#82995d', forest_floor: '#476347', hilltop: '#9da464' }[name];
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 256, 256);
        for (let i = 0; i < 330; i++) {
          const x = tileHash(i, 0, 41) * 256;
          const y = tileHash(i, 0, 42) * 256;
          const radius = 1 + tileHash(i, 0, 43) * (i < 22 ? 26 : 3.4);
          ctx.fillStyle = i % 2 === 0 ? '#172d2023' : '#d3d89b27';
          ctx.beginPath();
          ctx.ellipse(x, y, radius, radius * 0.69, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      fallbackTextures.set(name, image);
      return image;
    }

    function fillTexture(ctx, image, width, tilePixels) {
      const scale = tilePixels / image.width;
      ctx.save();
      ctx.scale(scale, scale);
      ctx.fillStyle = ctx.createPattern(image, 'repeat');
      ctx.fillRect(0, 0, width / scale, width / scale);
      ctx.restore();
    }

    function makeForestLayout(map) {
      const layout = Array.from({ length: SIZE * SIZE }, () => []);
      const candidates = [];
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (map[y][x].terrain !== 'forest') continue;
          for (let i = 0; i < 28; i++) {
            candidates.push({
              x, y, px: x + (tileHash(x, y, 150 + i) - 0.5) * 0.9,
              py: y + (tileHash(x, y, 240 + i) - 0.5) * 0.9,
              rank: tileHash(x, y, 340 + i),
              scale: 0.77 + tileHash(x, y, 442 + i) * 0.36,
              name: `pine_${'abc'[i % 3]}`
            });
          }
        }
      }
      candidates.sort((a, b) => a.rank - b.rank);
      for (const point of candidates) {
        const cellTrees = layout[point.y * SIZE + point.x];
        if (cellTrees.length >= 4) continue;
        let near = false;
        for (let y = Math.max(0, point.y - 1); y <= Math.min(SIZE - 1, point.y + 1); y++) {
          for (let x = Math.max(0, point.x - 1); x <= Math.min(SIZE - 1, point.x + 1); x++) {
            near ||= layout[y * SIZE + x].some(other =>
              (other.px - point.px) ** 2 + (other.py - point.py) ** 2 < 0.32 ** 2);
          }
        }
        if (!near) cellTrees.push(point);
      }
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (map[y][x].terrain !== 'forest') continue;
          const cellTrees = layout[y * SIZE + x];
          if (cellTrees.length === 0) cellTrees.push({ px: x, py: y, scale: 1, name: 'pine_a' });
          for (const [i, side] of SIDES.entries()) {
            if (map[y + side.dy]?.[x + side.dx]?.terrain === 'forest') continue;
            const along = (tileHash(x, y, 610 + i) - 0.5) * 0.52;
            cellTrees.push({
              px: x + side.dx * 0.42 + side.dy * along,
              py: y + side.dy * 0.42 + side.dx * along,
              scale: 0.9 + tileHash(x, y, 620 + i) * 0.3,
              name: ['bush_a', 'fern', 'bush_b'][Math.floor(tileHash(x, y, 630 + i) * 3)]
            });
          }
        }
      }
      return layout;
    }

    function groundShadow(ctx, x, y, rx, ry, angle, alpha) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.scale(rx, ry);
      const gradient = ctx.createRadialGradient(0, 0, 0.21, 0, 0, 1);
      gradient.addColorStop(0, `rgba(18, 27, 23, ${alpha})`);
      gradient.addColorStop(1, 'rgba(18, 27, 23, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }

    function addGroundDetails(ctx, map, pixels) {
      const decor = ['grass_tuft', 'flowers', 'rock_a', 'rock_b'];
      ctx.save();
      ctx.scale(pixels, pixels);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const centerX = x + 0.5;
          const centerY = y + 0.5;
          if (map[y][x].elev) {
            // 世界座標的影子跟著台地旋轉，無須因鏡頭角度重建底圖。
            groundShadow(ctx, centerX + 0.30, centerY + 0.44, 0.92, 0.57, 0.72, 0.54);
            for (const [i, side] of SIDES.entries()) {
              if (!cliffHeight(map, x, y, side)) continue;
              const px = centerX + side.dx * 0.57 + side.dy * 0.22;
              const py = centerY + side.dy * 0.57 + side.dx * 0.22;
              const rubble = assets('props/rubble.png');
              if (rubble) ctx.drawImage(rubble, px - 0.16, py - 0.10, 0.32, 0.20);
              else {
                ctx.fillStyle = '#857a58';
                ctx.beginPath();
                ctx.ellipse(px, py, 0.074 + i * 0.007, 0.047, 0.8, 0, Math.PI * 2);
                ctx.fill();
              }
            }
            continue;
          }
          for (const tree of forestLayout[y * SIZE + x]) {
            if (tree.name.startsWith('pine_')) {
              groundShadow(ctx, tree.px + 0.66, tree.py + 0.63, 0.35, 0.13, 0.75, 0.36);
            }
          }
          if (map[y][x].terrain !== 'plain' || tileHash(x, y, 523) < 0.35) continue;
          const angle = tileHash(x, y, 524) * Math.PI * 2;
          const px = centerX + Math.cos(angle) * 0.35;
          const py = centerY + Math.sin(angle) * 0.35;
          const name = decor[Math.floor(tileHash(x, y, 525) * decor.length)];
          const image = assets(`props/${name}.png`);
          if (image) ctx.drawImage(image, px - 0.075, py - 0.055, 0.15, 0.11);
          else {
            ctx.fillStyle = '#d9df9a74';
            ctx.beginPath();
            ctx.ellipse(px, py, 0.027, 0.021, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    function rebuildGround(map, quality, version) {
      const pixels = quality === 'high' ? 192 : 96;
      if (mapForGround !== map) forestLayout = makeForestLayout(map);
      mapForGround = map;
      groundQuality = quality;
      groundVersion = version;
      ground.width = SIZE * pixels;
      ground.height = ground.width;
      const ctx = ground.getContext('2d');
      const forestGrid = map.map(row => row.map(cell => cell.terrain === 'forest'));
      sampleMask(forestMask, forestGrid, (inside, distance, x, y) => {
        const noise = Math.sin(x * 9.2 - y * 7.3) * 0.045 + Math.cos(y * 6.1 + x * 4.9) * 0.053;
        return 255 * smooth(0.5 + ((inside ? distance : -distance) + noise) / 0.34);
      }, [255, 255, 255]);
      fillTexture(ctx, texture('forest_floor'), ground.width, pixels * 2.5);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(forestMask, 0, 0, ground.width, ground.height);
      ctx.globalCompositeOperation = 'destination-over';
      fillTexture(ctx, texture('grass'), ground.width, pixels * 3);
      ctx.globalCompositeOperation = 'source-over';
      addGroundDetails(ctx, map, pixels);
    }

    function prepareFog(scene, frame) {
      const nowMs = frame.nowMs;
      const vision = scene.visibleTiles;
      const view = scene.viewKey ?? (scene.showAll ? 'all' : scene.faction);
      const dissolve = scene.animateFog && frame.quality === 'high' && !frame.reducedMotion;
      if (!dissolve) reveals.clear();
      if (fogScene !== scene || fogView !== view) {
        const next = scene.showAll ? '' : vision.flat().map(visible => visible ? '1' : '0').join('');
        const sameContext = fogMap === scene.board.map && fogView === view;
        if (!sameContext) reveals.clear();
        if (sameContext && dissolve && fogBits && next !== fogBits) {
          for (let i = 0; i < next.length; i++) {
            if (next[i] === '1' && fogBits[i] === '0') reveals.set(i, nowMs);
            if (next[i] === '0') reveals.delete(i);
          }
        }
        hasFog = next.includes('0');
        if (hasFog && next !== fogBits) {
          sampleMask(fogMask, vision, (visible, distance) =>
            visible ? 0 : 168 * smooth((distance - 0.035) / 0.25), [23, 43, 65]);
          cloudMode = '';
        }
        fogBits = next;
        fogScene = scene;
        fogMap = scene.board.map;
        fogView = view;
      }
      for (const [tile, start] of reveals) if (nowMs - start >= 300) reveals.delete(tile);
      if (!hasFog) return;

      const animated = frame.quality === 'high' && !frame.reducedMotion;
      const mode = `${animated}:${frame.assetVersion ?? 0}`;
      if (cloudMode === mode && (!animated || nowMs - cloudAt < 80)) return;
      const ctx = fogClouds.getContext('2d');
      const cloud = texture('fog_cloud');
      cloudAt = nowMs;
      cloudMode = mode;
      ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
      ctx.save();
      if (animated) {
        ctx.translate((nowMs * 0.009) % 132 - 132, (nowMs * 0.003) % 132 - 132);
      }
      fillTexture(ctx, cloud, MASK_SIZE + 132, 132);
      if (animated) {
        ctx.globalAlpha = 0.42;
        ctx.translate(-((nowMs * 0.014) % 107), 0);
        fillTexture(ctx, cloud, MASK_SIZE + 239, 107);
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(fogMask, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }

    function prepareTactics(scene) {
      if (scene === tacticsScene) return;
      tacticsScene = scene;
      tacticsByTile = new Map();
      const map = scene.board.map;
      const kinds = [
        ['reachable', scene.reachableKeys, scene.chargeKeys, 'rgba(14,165,233,0.31)', '#62d1ff'],
        ['charge', scene.chargeKeys, null, 'rgba(245,158,11,0.35)', '#ffd476'],
        ['inZoc', scene.zocKeys, null, 'rgba(159,68,26,0.19)', '#ffab6c']
      ];
      for (const [kind, keys, excluded, fill, stroke] of kinds) {
        if (!keys) continue;
        const remaining = new Set([...keys].filter(key => !excluded?.has(key)));
        while (remaining.size) {
          const first = remaining.values().next().value;
          remaining.delete(first);
          const group = [first];
          const groupTiles = [];
          let sumX = 0;
          let sumY = 0;
          for (const key of group) {
            const [x, y] = key.split(',').map(Number);
            const elev = elevAt(map, x, y);
            const boundary = SIDES.map(({ dx, dy }) => {
              const neighbor = keyOf(x + dx, y + dy);
              const joins = keys.has(neighbor) && !excluded?.has(neighbor) && elevAt(map, x + dx, y + dy) === elev;
              if (joins && remaining.delete(neighbor)) group.push(neighbor);
              return !joins;
            });
            const region = { kind, boundary, fill, stroke, label: '' };
            if (!tacticsByTile.has(key)) tacticsByTile.set(key, []);
            tacticsByTile.get(key).push(region);
            groupTiles.push({ x, y, region });
            sumX += x;
            sumY += y;
          }

          // 同一片戰術區域以一枚標誌提示用途，避免逐格標籤重新蓋住棋盤。
          if (kind === 'charge' || kind === 'inZoc') {
            const centerX = sumX / group.length;
            const centerY = sumY / group.length;
            const distance = tile => (tile.x - centerX) ** 2 + (tile.y - centerY) ** 2;
            const representative = groupTiles.reduce((best, tile) => distance(tile) < distance(best) ? tile : best);
            representative.region.label = kind === 'charge' ? 'ϟ' : 'ZoC';
          }
        }
      }
    }

    function prepareHillSurface(frame) {
      const key = `${frame.quality}:${frame.assetVersion ?? 0}:${fogBits}`;
      if (hillSurfaceKey === key) return;
      hillSurfaceKey = key;
      hillPixels = frame.quality === 'high' ? 128 : 72;
      const size = SIZE * hillPixels;
      if (hillSurface.width !== size) {
        hillSurface.width = size;
        hillSurface.height = size;
      }
      const ctx = hillSurface.getContext('2d');
      fillTexture(ctx, texture('hilltop'), size, hillPixels * 3.2);
      // 把迷霧合成到連續凸台材質後才逐格裁切，避免半透明反鋸齒露出亮縫。
      if (hasFog) ctx.drawImage(fogMask, 0, 0, size, size);
    }

    function drawGround(ctx, scene, frame) {
      const map = scene.board.map;
      if (mapForGround !== map || groundQuality !== frame.quality || groundVersion !== frame.assetVersion) {
        rebuildGround(map, frame.quality, frame.assetVersion);
      }
      prepareFog(scene, frame);
      prepareHillSurface(frame);
      prepareTactics(scene);
      const project = frame.projectFloat;
      ctx.save();
      transformSurface(ctx, project, -0.5, -0.5);
      ctx.drawImage(ground, 0, 0, SIZE, SIZE);
      if (hasFog) {
        ctx.drawImage(fogMask, 0, 0, SIZE, SIZE);
        ctx.globalAlpha *= 0.55;
        ctx.drawImage(fogClouds, 0, 0, SIZE, SIZE);
      }
      ctx.restore();

      if (frame.gridVisible !== false) {
        ctx.save();
        ctx.strokeStyle = 'rgba(26, 41, 22, 0.39)';
        ctx.lineWidth = 0.72 / Math.max(1, frame.zoom || 1) ** 0.3;
        ctx.beginPath();
        for (let coordinate = -0.5; coordinate <= SIZE - 0.5; coordinate++) {
          const a = project(coordinate, -0.5, 0);
          const b = project(coordinate, SIZE - 0.5, 0);
          const c = project(-0.5, coordinate, 0);
          const d = project(SIZE - 0.5, coordinate, 0);
          ctx.moveTo(a.bx, a.by);
          ctx.lineTo(b.bx, b.by);
          ctx.moveTo(c.bx, c.by);
          ctx.lineTo(d.bx, d.by);
        }
        ctx.stroke();
        ctx.restore();
      }
      return true;
    }

    function screeTexture() {
      const cliff = texture('cliff_face');
      if (screeSource === cliff) return scree;
      screeSource = cliff;
      const ctx = scree.getContext('2d');
      const { width, height } = scree;
      const moss = Math.floor(cliff.height * 0.14);
      ctx.drawImage(cliff, 0, moss, cliff.width, cliff.height - moss, 0, 0, width, height);

      // 碎片大多落在坡的下半，交錯亮面與陰影保留粗糙的岩面層次。
      for (let i = 0; i < 180; i++) {
        const x = tileHash(i, 0, 242) * width;
        const y = Math.sqrt(tileHash(i, 0, 243)) * height;
        const radius = 2 + tileHash(i, 0, 244) ** 2 * 13;
        const gray = tileHash(i, 0, 245) * 25;
        ctx.beginPath();
        ctx.moveTo(x - radius, y + radius * 0.3);
        ctx.lineTo(x - radius * 0.46, y - radius * 0.55);
        ctx.lineTo(x + radius * 0.55, y - radius * 0.61);
        ctx.lineTo(x + radius, y + radius * 0.14);
        ctx.lineTo(x + radius * 0.31, y + radius * 0.64);
        ctx.closePath();
        ctx.fillStyle = `rgb(${101 + gray} ${93 + gray} ${74 + gray} / 0.82)`;
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x - radius * 0.46, y - radius * 0.55);
        ctx.lineTo(x + radius * 0.55, y - radius * 0.61);
        ctx.lineTo(x + radius * 0.64, y);
        ctx.lineTo(x - radius * 0.63, y + radius * 0.02);
        ctx.closePath();
        ctx.fillStyle = `rgb(${151 + gray} ${141 + gray} ${114 + gray} / 0.75)`;
        ctx.fill();
      }
      return scree;
    }

    function drawSlope(ctx, { polygon, rim, foot, shade, textureSpan }, fogged) {
      const [a, b] = foot;
      const topA = rim[0];
      const topB = rim.at(-1);
      const dx = (a.bx + b.bx - topA.bx - topB.bx) * 0.5;
      const dy = (a.by + b.by - topA.by - topB.by) * 0.5;
      ctx.save();
      tracePolygon(ctx, polygon);
      ctx.fillStyle = '#897857';
      ctx.fill();
      ctx.clip();
      ctx.transform(b.bx - a.bx, b.by - a.by, dx, dy, a.bx - dx, a.by - dy);
      const texture = screeTexture();
      const strip = texture.width * textureSpan;
      ctx.drawImage(texture, (texture.width - strip) * 0.5, 0, strip, texture.height, -0.15, -0.22, 1.30, 1.24);

      const tint = ctx.createLinearGradient(0, 0, 0, 1);
      tint.addColorStop(0, shade ? '#272b2560' : '#eed09628');
      tint.addColorStop(0.76, shade ? '#25281c36' : '#78714910');
      tint.addColorStop(1, '#656b3d90');
      ctx.fillStyle = tint;
      ctx.fillRect(-0.15, -0.22, 1.30, 1.24);
      if (fogged) {
        ctx.fillStyle = 'rgba(23, 43, 65, 0.52)';
        ctx.fillRect(-0.15, -0.22, 1.30, 1.24);
      }
      ctx.restore();
    }

    function drawHill(ctx, scene, frame, tile) {
      const { x, y, cell, hill } = tile;
      for (const slope of hill.slopes) drawSlope(ctx, slope, !scene.visibleTiles[y][x]);

      ctx.save();
      tracePolygon(ctx, hill.top);
      ctx.clip();
      transformSurface(ctx, frame.projectFloat, x - 0.5, y - 0.5, cell.elev);
      const l = Math.max(0, x - 0.04);
      const t = Math.max(0, y - 0.04);
      const r = Math.min(SIZE, x + 1.04);
      const b = Math.min(SIZE, y + 1.04);
      ctx.drawImage(hillSurface, l * hillPixels, t * hillPixels, (r - l) * hillPixels, (b - t) * hillPixels,
        l - x, t - y, r - l, b - t);
      ctx.restore();
    }

    function drawFog(ctx, scene, frame, tile) {
      if (scene.showAll) return;
      const { x, y, cell } = tile;
      const revealedAt = reveals.get(y * SIZE + x);
      if (revealedAt === undefined || frame.quality !== 'high' || frame.reducedMotion) return;
      ctx.save();
      if (tile.hill) {
        tracePolygon(ctx, tile.hill.top);
        ctx.clip();
      }
      transformSurface(ctx, frame.projectFloat, x - 0.5, y - 0.5, cell.elev || 0);
      const decay = 1 - clamp((frame.nowMs - revealedAt) / 300);
      ctx.globalAlpha *= decay * 0.19;
      const mist = ctx.createLinearGradient(0, 0, 0.63, 0.78);
      mist.addColorStop(0, '#bbd3edca');
      mist.addColorStop(1, '#bbd3ed00');
      ctx.fillStyle = mist;
      ctx.fillRect(0, 0, 1, 1);
      ctx.restore();
    }

    function shadeProp(image, name) {
      const cached = shadedTrees.get(name);
      if (cached?.source === image) return cached.result;
      const result = newCanvas(image.width, image.height);
      const ctx = result.getContext('2d');
      ctx.drawImage(image, 0, 0);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = '#172c49a3';
      ctx.fillRect(0, 0, image.width, image.height);
      shadedTrees.set(name, { source: image, result });
      return result;
    }

    function drawFallbackProp(ctx, point, scale, name, fogged) {
      const { bx, by } = point;
      if (name.startsWith('pine_')) {
        ctx.fillStyle = fogged ? '#302f2c' : '#514938';
        ctx.fillRect(bx - 0.033 * scale, by - 0.135 * scale, 0.066 * scale, 0.14 * scale);
        for (let tier = 0; tier < 3; tier++) {
          const lower = by - (0.088 + tier * 0.115) * scale;
          const peak = lower - (0.216 - tier * 0.018) * scale;
          const radius = (0.14 - tier * 0.023) * scale;
          ctx.fillStyle = fogged ? '#2c514b' : '#4f7649';
          ctx.beginPath();
          ctx.moveTo(bx, peak);
          ctx.lineTo(bx - radius, lower);
          ctx.lineTo(bx, lower + 0.047 * scale);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = fogged ? '#223c39' : '#284633';
          ctx.beginPath();
          ctx.moveTo(bx, peak);
          ctx.lineTo(bx + radius, lower);
          ctx.lineTo(bx, lower + 0.047 * scale);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        ctx.fillStyle = fogged ? '#344b3d' : '#698451';
        ctx.beginPath();
        ctx.ellipse(bx, by - scale * 0.027, scale * 0.082, scale * 0.058, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function drawForest(ctx, scene, frame, tile, { occupied, softFade, isFogged, layer }) {
      const { x, y, by } = tile;
      const points = forestLayout[y * SIZE + x];
      if (!points.length) return;
      const placed = [];
      for (const tree of points) {
        const p = frame.projectFloat(tree.px, tree.py, 0);
        if ((p.by > by) !== (layer === 'front')) continue;
        placed.push({ tree, p });
      }
      placed.sort((a, b) => a.p.by - b.p.by);
      for (const { tree, p } of placed) {
        const isPine = tree.name.startsWith('pine_');
        const center = Math.hypot(tree.px - x, tree.py - y) < 0.28;
        const faded = (isPine && softFade) || (isPine && occupied && (center || layer === 'front'));
        const scale = frame.metrics.tw * tree.scale * (faded && center ? 0.84 : 1);
        const image = assets(`props/${tree.name}.png`);
        ctx.save();
        if (faded) ctx.globalAlpha *= occupied && center ? 0.35 : 0.46;
        if (image) {
          const art = isFogged ? shadeProp(image, tree.name) : image;
          const h = scale * (isPine ? 0.54 : 0.14);
          const w = h * art.width / art.height;
          ctx.drawImage(art, p.bx - w * 0.5, p.by - h * (isPine ? 0.94 : 0.95), w, h);
        } else {
          drawFallbackProp(ctx, p, scale, tree.name, isFogged);
        }
        ctx.restore();
      }
    }

    function drawUpperFog(ctx, scene, frame, tile) {
      if (frame.quality !== 'high' || frame.reducedMotion || scene.showAll) return;
      const { x, y, cell } = tile;
      if (cell.terrain !== 'forest' || x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) return;
      if (scene.visibleTiles[y][x]) return;
      // 可見實兵或已知殘影周圍留空，霧絲永遠不會壓到其輪廓或血量提示。
      for (let cy = y - 1; cy <= y + 1; cy++) {
        for (let cx = x - 1; cx <= x + 1; cx++) {
          const key = keyOf(cx, cy);
          if (scene.visibleTiles[cy][cx] || scene.visibleUnitsByKey.has(key) || scene.ghostsByKey?.has(key)) return;
        }
      }
      ctx.save();
      ctx.globalAlpha *= 0.38;
      ctx.translate(0, -frame.metrics.th * 0.26);
      transformSurface(ctx, frame.projectFloat, x - 0.5, y - 0.5, 0);
      ctx.drawImage(fogClouds, x * MASK_TILE, y * MASK_TILE, MASK_TILE, MASK_TILE, 0, 0, 1, 1);
      ctx.restore();
    }

    function drawTactics(ctx, scene, frame, tile) {
      const { x, y, cell } = tile;
      const regions = tacticsByTile.get(keyOf(x, y));
      if (!regions) return;
      const elev = cell.elev || 0;
      const [top, right, bottom, left] = tile.hill?.insets ?? LEVEL_EDGES;
      for (const region of regions) {
        const [north, east, south, west] = region.boundary;
        const l = left + (west ? 0.06 : 0);
        const t = top + (north ? 0.06 : 0);
        const r = 1 - right - (east ? 0.06 : 0);
        const b = 1 - bottom - (south ? 0.06 : 0);
        const radius = 0.11;
        const corners = [north && west, north && east, south && east, south && west].map(exposed => exposed ? radius : 0);
        const project = (dx, dy) => frame.projectFloat(x + dx - 0.5, y + dy - 0.5, elev);
        ctx.save();
        ctx.save();
        transformSurface(ctx, frame.projectFloat, x - 0.5, y - 0.5, elev);
        ctx.beginPath();
        roundedRect(ctx, l, t, r, b, corners);
        ctx.fillStyle = region.fill;
        ctx.fill();
        ctx.restore();

        // 只畫聯集的外露邊，同高度共邊的格子不再各自描框。
        const starts = [[l + corners[0], t], [r, t + corners[1]], [r - corners[2], b], [l, b - corners[3]]];
        const ends = [[r - corners[1], t], [r, b - corners[2]], [l + corners[3], b], [l, t + corners[0]]];
        const bounds = [[l, t], [r, t], [r, b], [l, b]];
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          if (!region.boundary[i]) continue;
          const a = project(...starts[i]);
          const b = project(...ends[i]);
          ctx.moveTo(a.bx, a.by);
          ctx.lineTo(b.bx, b.by);
          const j = (i + 1) % 4;
          if (corners[j]) {
            const control = project(...bounds[j]);
            const end = project(...starts[j]);
            ctx.quadraticCurveTo(control.bx, control.by, end.bx, end.by);
          }
        }
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = region.kind === 'charge' ? 1.7 : 1.35;
        ctx.strokeStyle = region.stroke;
        if (region.kind === 'inZoc') {
          ctx.setLineDash([4, 3]);
          ctx.lineDashOffset = frame.reducedMotion ? 0 : -(frame.nowMs * 0.018) % 7;
        }
        ctx.stroke();
        if (region.label) {
          const labelSize = clamp(frame.metrics.tw * (region.kind === 'charge' ? 0.22 : 0.14), 8, 15);
          ctx.font = `800 ${labelSize}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.setLineDash([]);
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(28, 25, 20, 0.82)';
          ctx.fillStyle = region.stroke;
          ctx.strokeText(region.label, tile.bx, tile.by);
          ctx.fillText(region.label, tile.bx, tile.by);
        }
        ctx.restore();
      }
    }

    return {
      drawGround, drawHill, drawFog, drawForest, drawUpperFog, drawTactics,
      hasActiveAnimation: nowMs => Array.from(reveals.values()).some(start => nowMs - start < 300),
      invalidateAssets() { groundVersion = Symbol(); hillSurfaceKey = ''; cloudMode = ''; shadedTrees.clear(); }
    };
  }

  return { create, projectHill, hillContains };
});
