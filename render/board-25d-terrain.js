(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TFC25DTerrain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SIZE = 10;
  const MASK_TILE = 32;
  const MASK_SIZE = SIZE * MASK_TILE;
  const SLOPE_HALF_WIDTH = 0.21;
  const worldMeshes = new WeakMap();
  // 依世界座標排列北、東、南、西四條邊。
  const SIDES = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 }
  ];
  const keyOf = (x, y) => `${x},${y}`;
  const clamp = (value, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, value));
  const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const elevAt = (map, x, y) => map[y]?.[x]?.elev || 0;

  // 每一側提供半個坡寬。兩端的高度曲線逐漸接平，格線位於坡中央。
  function heightWeights(value) {
    const cell = clamp(Math.floor(value + 0.5), 0, SIZE - 1);
    const offset = value - cell;
    const gap = 0.5 - Math.abs(offset);
    if (gap >= SLOPE_HALF_WIDTH) return [cell, cell, 0];
    const neighbor = cell + (offset < 0 ? -1 : 1);
    const boardEdge = neighbor < 0 || neighbor >= SIZE;
    const t = 1 - gap / SLOPE_HALF_WIDTH;
    return [cell, neighbor, smooth(boardEdge ? t : t * 0.5)];
  }

  function heightFromWeights(map, [x, nx, tx], [y, ny, ty]) {
    const near = elevAt(map, x, y) * (1 - tx) + elevAt(map, nx, y) * tx;
    const far = elevAt(map, x, ny) * (1 - tx) + elevAt(map, nx, ny) * tx;
    return near * (1 - ty) + far * ty;
  }

  function heightAt(map, x, y) {
    return heightFromWeights(map, heightWeights(x), heightWeights(y));
  }

  function cuts(hasStart, hasEnd) {
    const half = SLOPE_HALF_WIDTH;
    return [-0.5, ...(hasStart ? [-0.5 + half * 0.5, -0.5 + half] : []),
      ...(hasEnd ? [0.5 - half, 0.5 - half * 0.5] : []), 0.5];
  }

  function meshFaces(rows, x, y) {
    const width = rows[0].length - 1, height = rows.length - 1;
    const painted = Array.from({ length: height }, () => Array(width).fill(false));
    const faces = [];
    const append = (a, b, c, d) => {
      if (a.elev + b.elev + c.elev + d.elev > 0) faces.push({ points: [a, b, c, d], x, y });
    };
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        if (painted[j][i]) continue;
        const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i + 1], d = rows[j + 1][i];
        if (Math.abs(a.elev + c.elev - b.elev - d.elev) >= 1e-7) {
          append(a, b, c, d);
          continue;
        }
        // 沿同一平面合併相鄰片面，使平頂與連續坡帶可用一次貼圖繪製。
        const slopeX = (b.elev - a.elev) / (b.x - a.x);
        const slopeY = (d.elev - a.elev) / (d.y - a.y);
        const onPlane = point =>
          Math.abs(point.elev - a.elev - slopeX * (point.x - a.x) - slopeY * (point.y - a.y)) < 1e-7;
        let right = i + 1, bottom = j + 1;
        while (right < width && !painted[j][right] && onPlane(rows[j][right + 1]) && onPlane(rows[j + 1][right + 1])) right++;
        while (bottom < height) {
          let fits = onPlane(rows[bottom + 1][right]);
          for (let column = i; fits && column < right; column++) {
            fits = !painted[bottom][column] && onPlane(rows[bottom + 1][column]);
          }
          if (!fits) break;
          bottom++;
        }
        for (let row = j; row < bottom; row++) painted[row].fill(true, i, right);
        append(a, rows[j][right], rows[bottom][right], rows[bottom][i]);
      }
    }
    return faces;
  }

  function worldMesh(map) {
    if (worldMeshes.has(map)) return worldMeshes.get(map);
    const cells = map.flatMap((row, y) => row.map((_, x) => {
      // 斜角也參與取樣，讓同一角上的四格共用高度。
      const adjacent = [-1, 0, 1];
      const differsX = dx => adjacent.some(dy => elevAt(map, x, y + dy) !== elevAt(map, x + dx, y + dy));
      const differsY = dy => adjacent.some(dx => elevAt(map, x + dx, y) !== elevAt(map, x + dx, y + dy));
      const xs = cuts(differsX(-1), differsX(1)).map(u => x + u);
      const ys = cuts(differsY(-1), differsY(1)).map(v => y + v);
      const rows = ys.map(v => xs.map(u => ({ x: u, y: v, elev: heightAt(map, u, v) })));
      const faces = meshFaces(rows, x, y);
      const edges = [
        rows[0], rows.map(row => row.at(-1)), [...rows.at(-1)].reverse(),
        rows.map(row => row[0]).reverse()
      ];
      return { faces, edges };
    }));
    worldMeshes.set(map, cells);
    return cells;
  }

  function blendFaceEdges(points) {
    // 紋理在相鄰片面微量重疊，遮住 Canvas 裁切反鋸齒造成的亮縫。
    const normals = points.map((a, i) => {
      const b = points[(i + 1) % points.length];
      const dx = b.bx - a.bx, dy = b.by - a.by, length = Math.hypot(dx, dy) || 1;
      return [dy / length, -dx / length];
    });
    return points.map((point, i) => {
      const [ax, ay] = normals[(i + points.length - 1) % points.length];
      const [bx, by] = normals[i];
      const scale = Math.min(1.25, 0.6 / Math.max(0.08, 1 + ax * bx + ay * by));
      return { bx: point.bx + (ax + bx) * scale, by: point.by + (ay + by) * scale };
    });
  }

  function projectTerrain(map, project) {
    const projected = point => ({ ...point, ...project(point.x, point.y, point.elev) });
    return worldMesh(map).map((cell, index) => {
      const faces = [];
      const area = (a, b, c) => (b.bx - a.bx) * (c.by - a.by) - (b.by - a.by) * (c.bx - a.bx);
      function append(face, points) {
        const [a, b, c, d] = points;
        const u = b.x - a.x, v = b.y - a.y;
        const p = c.x - a.x, q = c.y - a.y;
        const det = u * q - v * p;
        const dx = b.bx - a.bx, dy = b.by - a.by;
        const ex = c.bx - a.bx, ey = c.by - a.by;
        let xx = (dx * q - ex * v) / det, xy = (ex * u - dx * p) / det;
        let yx = (dy * q - ey * v) / det, yy = (ey * u - dy * p) / det;
        let tx = a.bx - xx * (a.x + 0.5) - xy * (a.y + 0.5);
        let ty = a.by - yx * (a.x + 0.5) - yy * (a.y + 0.5);
        if (d) {
          // 用角點的平均位置對齊貼圖，坡角的非平面四邊形仍只需畫一次。
          xx = (b.bx - a.bx + c.bx - d.bx) / (2 * u);
          xy = (d.bx - a.bx + c.bx - b.bx) / (2 * q);
          yx = (b.by - a.by + c.by - d.by) / (2 * u);
          yy = (d.by - a.by + c.by - b.by) / (2 * q);
          tx = (a.bx + b.bx + c.bx + d.bx) * 0.25 - xx * ((a.x + c.x) * 0.5 + 0.5) - xy * ((a.y + c.y) * 0.5 + 0.5);
          ty = (a.by + b.by + c.by + d.by) * 0.25 - yx * ((a.x + c.x) * 0.5 + 0.5) - yy * ((a.y + c.y) * 0.5 + 0.5);
        }
        const bx = points.map(point => point.bx), by = points.map(point => point.by);
        faces.push({ ...face, points, padded: blendFaceEdges(points),
          transform: [xx, yx, xy, yy, tx, ty],
          left: Math.min(...bx), top: Math.min(...by), right: Math.max(...bx), bottom: Math.max(...by) });
      }

      for (const face of cell.faces) {
        const points = face.points.map(projected);
        const [a, b, c, d] = points;
        const frontABC = area(a, b, c) > 1e-7;
        const frontACD = area(a, c, d) > 1e-7;
        if (frontABC && frontACD) append(face, points);
        else if (frontABC) append(face, [a, b, c]);
        else if (frontACD) append(face, [a, c, d]);
      }
      const edges = cell.edges.map(edge => edge.map(projected));
      const x = index % SIZE, y = Math.floor(index / SIZE);
      const center = project(x, y, 0);
      // 共用的格線由較前方的一格繪製，避免被該格的地表蓋掉。
      const gridEdges = edges.filter((_, i) => {
        const { dx, dy } = SIDES[i];
        if (!map[y + dy]?.[x + dx]) return true;
        const neighbor = project(x + dx, y + dy, 0);
        const delta = center.by - neighbor.by;
        return Math.abs(delta) > 1e-8 ? delta > 0 : center.bx > neighbor.bx;
      });
      return { faces, edges, gridEdges };
    });
  }

  function heightInTriangle(a, b, c, x, y) {
    const dx = x - a.bx, dy = y - a.by;
    const u = b.bx - a.bx, v = b.by - a.by;
    const p = c.bx - a.bx, q = c.by - a.by;
    const det = u * q - v * p;
    if (Math.abs(det) < 1e-9) return -1;
    const s = (dx * q - dy * p) / det, t = (u * dy - v * dx) / det;
    if (s < -1e-7 || t < -1e-7 || s + t > 1 + 1e-7) return -1;
    return a.elev + s * (b.elev - a.elev) + t * (c.elev - a.elev);
  }

  function pickTerrain(terrain, x, y) {
    let hit = null;
    let frontHeight = 1e-7;
    for (const cell of terrain) {
      for (const face of cell.faces) {
        if (x < face.left || x > face.right || y < face.top || y > face.bottom) continue;
        const [a, b, c, d] = face.points;
        const h = Math.max(heightInTriangle(a, b, c, x, y),
          d ? heightInTriangle(a, c, d, x, y) : -1);
        // 同一像素重疊時，沿視線取較高、較近的表面。
        if (h > frontHeight) {
          frontHeight = h;
          hit = { x: face.x, y: face.y };
        }
      }
    }
    return hit;
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
    const reliefSurface = newCanvas(1, 1);
    const rockSurface = newCanvas(1, 1);
    const rockMask = newCanvas(MASK_SIZE, MASK_SIZE);
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
    let reliefKey = '';
    let reliefPixels = 96;
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
              if (elevAt(map, x + side.dx, y + side.dy)) continue;
              const px = centerX + side.dx * 0.68 + side.dy * 0.22;
              const py = centerY + side.dy * 0.68 + side.dx * 0.22;
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
      // 轉動途中重用同一張雲紋，視野變動則在上方立即更新遮罩與雲紋。
      if (cloudMode === mode && (!animated || frame.turning || nowMs - cloudAt < 80)) return;
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

    function rebuildRockMask(map) {
      const ctx = rockMask.getContext('2d');
      const image = ctx.createImageData(MASK_SIZE, MASK_SIZE);
      const weights = Array.from({ length: MASK_SIZE }, (_, i) => heightWeights((i + 0.5) / MASK_TILE - 0.5));
      for (let y = 0; y < MASK_SIZE; y++) {
        for (let x = 0; x < MASK_SIZE; x++) {
          const elev = heightFromWeights(map, weights[x], weights[y]);
          const cx = Math.floor(x / MASK_TILE), cy = Math.floor(y / MASK_TILE);
          const u = x / MASK_TILE - cx, v = y / MASK_TILE - cy;
          const grassX = 0.22 + 0.56 * tileHash(cx, cy, 195);
          const grassY = 0.22 + 0.56 * tileHash(cx, cy, 196);
          const grass = smooth((0.23 - Math.hypot(u - grassX, (v - grassY) * 1.15)) / 0.14);
          const variation = Math.sin(x * 0.31 + y * 0.22) * 0.025 + Math.cos(x * 0.18 - y * 0.4) * 0.025;
          const alpha = smooth((elev - (0.08 + variation)) / 0.76);
          image.data[(y * MASK_SIZE + x) * 4 + 3] = alpha * (1 - grass * 0.90 * smooth((elev - 0.72) / 0.28)) * 255;
        }
      }
      ctx.putImageData(image, 0, 0);
    }

    function rebuildRockSurface(map, pixels, size) {
      rockSurface.width = rockSurface.height = size;
      const ctx = rockSurface.getContext('2d');
      fillTexture(ctx, texture('cliff_face'), size, pixels * 1.8);
      ctx.fillStyle = 'rgba(89, 90, 83, 0.52)';
      ctx.fillRect(0, 0, size, size);
      ctx.save();
      ctx.scale(pixels, pixels);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (!map[y][x].elev) continue;
          for (let i = 0; i < 34; i++) {
            const u = x + tileHash(x, y, 1100 + i);
            const v = y + tileHash(x, y, 1200 + i);
            const radius = 0.023 + tileHash(x, y, 1300 + i) ** 2 * 0.077;
            const angle = tileHash(x, y, 1400 + i) * Math.PI * 2;
            ctx.save();
            ctx.translate(u, v);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(-radius, radius * 0.22);
            ctx.lineTo(-radius * 0.56, -radius * 0.54);
            ctx.lineTo(radius * 0.48, -radius * 0.74);
            ctx.lineTo(radius, -radius * 0.08);
            ctx.lineTo(radius * 0.51, radius * 0.58);
            ctx.closePath();
            ctx.fillStyle = i % 3 === 0 ? '#5e6057' : '#747269';
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(-radius * 0.56, -radius * 0.54);
            ctx.lineTo(radius * 0.48, -radius * 0.74);
            ctx.lineTo(radius * 0.52, -radius * 0.12);
            ctx.lineTo(-radius * 0.63, radius * 0.06);
            ctx.closePath();
            ctx.fillStyle = i % 3 === 0 ? '#8f9389' : '#a6a494';
            ctx.fill();
            ctx.restore();
          }
        }
      }
      ctx.restore();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(rockMask, 0, 0, size, size);
      ctx.globalCompositeOperation = 'source-over';
    }

    function prepareRelief(frame) {
      const key = `${frame.quality}:${frame.assetVersion ?? 0}:${fogBits}:${hasFog ? cloudAt : ''}`;
      if (reliefKey === key) return;
      reliefKey = key;
      reliefPixels = frame.quality === 'high' ? 128 : 72;
      const size = SIZE * reliefPixels;
      if (reliefSurface.width !== size) reliefSurface.width = reliefSurface.height = size;
      const ctx = reliefSurface.getContext('2d');
      ctx.drawImage(ground, 0, 0, size, size);
      ctx.drawImage(rockSurface, 0, 0, size, size);
      if (hasFog) {
        ctx.drawImage(fogMask, 0, 0, size, size);
        ctx.globalAlpha = 0.55;
        ctx.drawImage(fogClouds, 0, 0, size, size);
        ctx.globalAlpha = 1;
      }
    }

    function drawGround(ctx, scene, frame) {
      const map = scene.board.map;
      if (mapForGround !== map || groundQuality !== frame.quality || groundVersion !== frame.assetVersion) {
        if (mapForGround !== map) rebuildRockMask(map);
        rebuildGround(map, frame.quality, frame.assetVersion);
        const pixels = frame.quality === 'high' ? 128 : 72;
        rebuildRockSurface(map, pixels, SIZE * pixels);
        reliefKey = '';
      }
      prepareFog(scene, frame);
      prepareRelief(frame);
      frame.reliefPattern = ctx.createPattern(reliefSurface, 'no-repeat');
      frame.reliefMatrix = new DOMMatrix();
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
        for (const cell of frame.terrain) {
          for (const edge of cell.gridEdges) {
            for (let i = 1; i < edge.length; i++) {
              const a = edge[i - 1], b = edge[i];
              if (a.elev || b.elev) continue;
              ctx.moveTo(a.bx, a.by);
              ctx.lineTo(b.bx, b.by);
            }
          }
        }
        ctx.stroke();
        ctx.restore();
      }
      return true;
    }

    function drawRelief(ctx, frame, tile) {
      if (!tile.surface.faces.length) return;
      const { reliefPattern, reliefMatrix } = frame;
      ctx.save();
      for (const { padded, transform } of tile.surface.faces) {
        const [xx, yx, xy, yy, tx, ty] = transform;
        reliefMatrix.a = xx / reliefPixels;
        reliefMatrix.b = yx / reliefPixels;
        reliefMatrix.c = xy / reliefPixels;
        reliefMatrix.d = yy / reliefPixels;
        reliefMatrix.e = tx;
        reliefMatrix.f = ty;
        reliefPattern.setTransform(reliefMatrix);
        tracePolygon(ctx, padded);
        ctx.fillStyle = reliefPattern;
        ctx.fill();
      }
      ctx.restore();
      if (frame.gridVisible === false) return;
      ctx.save();
      ctx.strokeStyle = 'rgba(26, 36, 25, 0.3)';
      ctx.lineWidth = 0.72 / Math.max(1, frame.zoom || 1) ** 0.3;
      ctx.beginPath();
      for (const edge of tile.surface.gridEdges) {
        for (let i = 1; i < edge.length; i++) {
          const a = edge[i - 1], b = edge[i];
          if (!a.elev && !b.elev) continue;
          ctx.moveTo(a.bx, a.by);
          ctx.lineTo(b.bx, b.by);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    function drawFog(ctx, scene, frame, tile) {
      if (scene.showAll) return;
      const { x, y, bx, by } = tile;
      const revealedAt = reveals.get(y * SIZE + x);
      if (revealedAt === undefined || frame.quality !== 'high' || frame.reducedMotion) return;
      ctx.save();
      tracePolygon(ctx, tile.surface.edges.flat());
      ctx.globalAlpha *= (1 - clamp((frame.nowMs - revealedAt) / 300)) * 0.19;
      const mist = ctx.createLinearGradient(bx - frame.metrics.tw * 0.3, by - frame.metrics.th * 0.3,
        bx + frame.metrics.tw * 0.3, by + frame.metrics.th * 0.3);
      mist.addColorStop(0, '#bbd3edca');
      mist.addColorStop(1, '#bbd3ed00');
      ctx.fillStyle = mist;
      ctx.fill();
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
        const p = frame.projectFloat(tree.px, tree.py, heightAt(scene.board.map, tree.px, tree.py));
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
      const { x, y } = tile;
      const regions = tacticsByTile.get(keyOf(x, y));
      if (!regions) return;
      for (const region of regions) {
        const [north, east, south, west] = region.boundary;
        const l = west ? 0.06 : 0;
        const t = north ? 0.06 : 0;
        const r = east ? 0.94 : 1;
        const b = south ? 0.94 : 1;
        const radius = 0.11;
        const corners = [north && west, north && east, south && east, south && west].map(exposed => exposed ? radius : 0);
        const project = (dx, dy) => frame.projectFloat(x + dx - 0.5, y + dy - 0.5,
          heightAt(scene.board.map, x + dx - 0.5, y + dy - 0.5));
        const starts = [[l + corners[0], t], [r, t + corners[1]], [r - corners[2], b], [l, b - corners[3]]];
        const ends = [[r - corners[1], t], [r, b - corners[2]], [l + corners[3], b], [l, t + corners[0]]];
        const bounds = [[l, t], [r, t], [r, b], [l, b]];
        const sections = starts.map(([ax, ay], i) => {
          const [bx, by] = ends[i];
          const points = [];
          const steps = tile.surface.faces.length ? 8 : 1;
          for (let j = 0; j <= steps; j++) {
            points.push(project(ax + (bx - ax) * j / steps, ay + (by - ay) * j / steps));
          }
          const next = (i + 1) % 4;
          if (corners[next]) {
            const [cx, cy] = bounds[next];
            const [dx, dy] = starts[next];
            for (const f of [1 / 3, 2 / 3, 1]) {
              const k = 1 - f;
              points.push(project(k * k * bx + 2 * f * k * cx + f * f * dx,
                k * k * by + 2 * f * k * cy + f * f * dy));
            }
          }
          return points;
        });
        ctx.save();
        tracePolygon(ctx, sections.flat());
        ctx.fillStyle = region.fill;
        ctx.fill();

        // 地面提示沿坡面取樣，同高度的相鄰格共用區域輪廓。
        ctx.beginPath();
        for (let i = 0; i < sections.length; i++) {
          if (!region.boundary[i]) continue;
          const points = sections[i];
          ctx.moveTo(points[0].bx, points[0].by);
          for (let j = 1; j < points.length; j++) ctx.lineTo(points[j].bx, points[j].by);
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
      drawGround, drawRelief, drawFog, drawForest, drawUpperFog, drawTactics,
      hasActiveAnimation: nowMs => Array.from(reveals.values()).some(start => nowMs - start < 300),
      invalidateAssets() { groundVersion = Symbol(); reliefKey = ''; cloudMode = ''; shadedTrees.clear(); }
    };
  }

  return { create, projectTerrain, pickTerrain, heightAt };
});
