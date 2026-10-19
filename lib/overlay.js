/*
 * Draws a BWF-TV-style scoreboard onto a 2D canvas context.
 *
 * Default 'tour' style copies the BWF World Tour broadcast graphic:
 *
 *    ╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾╲┌────┐
 *   │ [flag╱ AN S.Y.                 │ 21 ││ 18 │   <- light rows, dark names,
 *   │ [flag╱ YAMAGUCHI            🏸 │ 23 ││ 14 │      finished games dark on light,
 *    ╲______________________________________╱└────┘      current game white on grey
 *
 * The older block styles ('bwf', 'dark', 'red') look like this:
 *   ┌──────────────────────────────────────────┐
 *   │ TITLE · MEN'S SINGLES · GAME 2            │  <- header strip
 *   ├──┬────────────────────────┬────┬────┬────┤
 *   │🏸│ PLAYER ONE             │ 21 │ 18 │ 11 │  <- previous games, current game
 *   │  │ PLAYER TWO             │ 15 │ 21 │  7 │
 *   └──┴────────────────────────┴────┴────┴────┘
 *                                 [GAME POINT]
 *
 * Shared by the live preview and both export paths, so what you see while
 * tagging is exactly what ends up in the video.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Overlay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const THEMES = {
    bwf: {
      header: '#0a1a3f', headerText: '#c9d6ff',
      name: '#13285e', nameText: '#ffffff',
      prev: '#0d1f4d', prevWin: '#ffffff', prevLose: '#7f8fb8',
      cur: '#ffffff', curText: '#0a1a3f',
      accent: '#ffcc00', accentText: '#0a1a3f',
      divider: 'rgba(255,255,255,0.12)',
    },
    dark: {
      header: '#111111', headerText: '#bbbbbb',
      name: '#1d1d1d', nameText: '#ffffff',
      prev: '#161616', prevWin: '#ffffff', prevLose: '#777777',
      cur: '#2ecc71', curText: '#08130c',
      accent: '#2ecc71', accentText: '#08130c',
      divider: 'rgba(255,255,255,0.10)',
    },
    red: {
      header: '#5a0d14', headerText: '#ffd6d9',
      name: '#8a1520', nameText: '#ffffff',
      prev: '#6b1019', prevWin: '#ffffff', prevLose: '#e39aa1',
      cur: '#ffffff', curText: '#5a0d14',
      accent: '#ffd23f', accentText: '#3a0a0f',
      divider: 'rgba(255,255,255,0.15)',
    },
  };

  const FONT = '"Barlow Condensed", "Arial Narrow", "Roboto Condensed", Arial, sans-serif';

  function fitText(ctx, text, maxWidth, weight, size, minSize) {
    let s = size;
    ctx.font = `${weight} ${s}px ${FONT}`;
    while (s > minSize && ctx.measureText(text).width > maxWidth) {
      s -= 1;
      ctx.font = `${weight} ${s}px ${FONT}`;
    }
    if (ctx.measureText(text).width <= maxWidth) return text;
    // Still too long at minimum size: truncate with an ellipsis.
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) t = t.slice(0, -1);
    return t + '…';
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** A small shuttlecock: cork at the bottom, feather skirt opening upward, tilted. */
  function drawShuttle(ctx, cx, cy, size, color) {
    const s = size;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 6);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // feather skirt
    const topY = -s * 0.5;
    const baseY = s * 0.12;
    const topHalf = s * 0.4;
    const baseHalf = s * 0.15;
    ctx.beginPath();
    ctx.moveTo(-baseHalf, baseY);
    ctx.lineTo(-topHalf, topY);
    ctx.quadraticCurveTo(0, topY - s * 0.1, topHalf, topY);
    ctx.lineTo(baseHalf, baseY);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    // feather shafts
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = Math.max(1, s * 0.05);
    for (const f of [-0.5, 0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(f * baseHalf, baseY);
      ctx.lineTo(f * topHalf, topY - (f === 0 ? s * 0.05 : 0));
      ctx.stroke();
    }
    // band where feathers meet the cork
    ctx.fillStyle = color;
    ctx.fillRect(-baseHalf * 1.1, baseY - s * 0.06, baseHalf * 2.2, s * 0.08);
    // cork
    ctx.beginPath();
    ctx.arc(0, baseY + s * 0.02, s * 0.17, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * opts: { width, height, scale (1 = default), theme, position: 'tl'|'tr', showHeader }
   * cfg:  normalized match config (Scoring.normalizeConfig)
   * st:   Scoring.stateAt(...)
   */
  function draw(ctx, cfg, st, opts) {
    const theme = THEMES[opts.theme] || THEMES.bwf;
    const H = opts.height;
    const W = opts.width;
    // Base unit: sized against the shorter side so vertical phone videos work too.
    const u = (Math.min(W, H) / 1080) * (opts.scale || 1);
    const margin = Math.round(28 * u);
    const rowH = Math.round(46 * u);
    const serveW = Math.round(36 * u);
    const colW = Math.round(44 * u);
    const curW = Math.round(56 * u);
    const nameW = Math.round((cfg.format === 'singles' ? 300 : 400) * u);
    const headerH = opts.showHeader === false ? 0 : Math.round(26 * u);
    const radius = Math.round(6 * u);

    const games = st.games;
    const totalW = serveW + nameW + games.length * colW + curW;
    const totalH = headerH + rowH * 2;
    const x0 = opts.position === 'tr' ? W - margin - totalW : margin;
    const y0 = margin;

    ctx.save();
    ctx.textBaseline = 'middle';

    // drop shadow behind the whole block
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 12 * u;
    ctx.shadowOffsetY = 3 * u;
    roundRect(ctx, x0, y0, totalW, totalH, radius);
    ctx.fillStyle = theme.name;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    ctx.save();
    roundRect(ctx, x0, y0, totalW, totalH, radius);
    ctx.clip();

    // header
    if (headerH) {
      ctx.fillStyle = theme.header;
      ctx.fillRect(x0, y0, totalW, headerH);
      const parts = [];
      if (cfg.title) parts.push(cfg.title);
      if (cfg.categoryLabel) parts.push(cfg.categoryLabel);
      parts.push(st.matchWinner !== null ? 'FINAL' : `GAME ${st.gameNo}`);
      const text = fitText(ctx, parts.join('  ·  ').toUpperCase(), totalW - 20 * u, 600, Math.round(16 * u), Math.round(10 * u));
      ctx.fillStyle = theme.headerText;
      ctx.textAlign = 'left';
      ctx.fillText(text, x0 + 10 * u, y0 + headerH / 2 + 1 * u);
    }

    for (let side = 0; side < 2; side++) {
      const y = y0 + headerH + side * rowH;
      let x = x0;

      // serve column + name
      ctx.fillStyle = theme.name;
      ctx.fillRect(x, y, serveW + nameW, rowH);
      if (st.server === side) drawShuttle(ctx, x + serveW / 2 + 1 * u, y + rowH / 2 + 2 * u, 24 * u, theme.accent);
      if (st.matchWinner === side) {
        ctx.fillStyle = theme.accent;
        ctx.fillRect(x, y, Math.max(2, 5 * u), rowH);
      }
      x += serveW;

      const team = cfg.teams[side] || { players: [] };
      const name = (team.players || []).filter(Boolean).join(' / ').toUpperCase() || (side ? 'PLAYER 2' : 'PLAYER 1');
      const txt = fitText(ctx, name, nameW - 12 * u, 700, Math.round(26 * u), Math.round(15 * u));
      ctx.fillStyle = theme.nameText;
      ctx.textAlign = 'left';
      ctx.fillText(txt, x, y + rowH / 2 + 1 * u);
      x += nameW;

      // completed games
      for (const g of games) {
        ctx.fillStyle = theme.prev;
        ctx.fillRect(x, y, colW, rowH);
        const won = g.winner === side;
        ctx.fillStyle = won ? theme.prevWin : theme.prevLose;
        ctx.font = `${won ? 700 : 500} ${Math.round(26 * u)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(String(g.score[side]), x + colW / 2, y + rowH / 2 + 1 * u);
        x += colW;
      }

      // current game
      ctx.fillStyle = theme.cur;
      ctx.fillRect(x, y, curW, rowH);
      ctx.fillStyle = theme.curText;
      ctx.font = `800 ${Math.round(32 * u)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(st.score[side]), x + curW / 2, y + rowH / 2 + 2 * u);
    }

    // row divider
    ctx.fillStyle = theme.divider;
    ctx.fillRect(x0, y0 + headerH + rowH - Math.max(1, u) / 2, totalW, Math.max(1, u));
    ctx.restore(); // clip

    // status pill (GAME POINT / MATCH POINT / GAME / MATCH) next to the side it refers to
    if (st.status) {
      ctx.font = `800 ${Math.round(18 * u)}px ${FONT}`;
      const label = st.status;
      const pw = ctx.measureText(label).width + 20 * u;
      const ph = Math.round(28 * u);
      const rowY = y0 + headerH + (st.statusSide || 0) * rowH;
      const px = x0 + totalW + 8 * u;
      const py = rowY + (rowH - ph) / 2;
      const flip = opts.position === 'tr';
      const fx = flip ? x0 - 8 * u - pw : px;
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = 8 * u;
      roundRect(ctx, fx, py, pw, ph, ph / 2);
      ctx.fillStyle = theme.accent;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = theme.accentText;
      ctx.textAlign = 'center';
      ctx.fillText(label, fx + pw / 2, py + ph / 2 + 1 * u);
    }

    ctx.restore();
  }

  // ------------------------------------------------------------------ BWF World Tour style
  //
  // Measured from BWF World Tour broadcast frames. Every size is a multiple
  // of the row height H, so the board scales cleanly to any video size.

  const TOUR = {
    frameTop: '#c6c6c9',
    frameBottom: '#adadb1',
    frameHighlight: 'rgba(255,255,255,0.55)',
    frameEdge: 'rgba(40,40,45,0.55)',
    // Every cell is two-tone: lighter above 55% of its height, darker below.
    split: 0.55,
    nameLeftTop: '#e4e4e4',
    nameRightTop: '#f5f5f5',
    nameLeftBottom: '#dcdcdc',
    nameRightBottom: '#ececec',
    tabTop: '#fdfdfd',
    tabBottom: '#f7f7f7',
    prevTop: '#e6e6e6',
    prevBottom: '#dedede',
    separator: '#f6f6f6',
    curTop: '#8e8e8f',
    curBottom: '#707071',
    curGap: '#5e5e60',
    text: '#232323',
    curText: '#ffffff',
    shuttle: '#8f8f8f',
    tagBg: '#2b2b2b',
    tagText: '#ffffff',
  };

  const K = {
    rowH: 40, // px at 1080p and size 1
    padTop: 0.186,
    padBottom: 0.186,
    padLeft: 0.21,
    rowGap: 0.116,
    tabW: 1.44,
    tabSlant: 0.12,
    flagW: 0.98,
    flagH: 0.72,
    flagLeft: 0.2,
    nameLeft: 0.22, // from the end of the flag tab
    nameMinW: 5.44, // name area width, flag tab end to first score column
    shuttleFromScores: 0.38,
    shuttleSize: 0.52,
    prevW: 1.22,
    curW: 1.163,
    sepW: 0.05,
    frameBeyondCur: 0.25, // light frame peeks out to the right under the current column
    radiusTL: 0.34,
    radius: 0.18,
    digitCap: 0.634, // digit height / H
    nameCap: 0.485, // capital letter height / H
    capPerEm: 0.71, // Barlow Condensed cap height / font size
  };

  function vGradient(ctx, y, h, top, bottom) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  }

  function roundRectCorners(ctx, x, y, w, h, tl, tr, br, bl) {
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.arcTo(x + w, y, x + w, y + tr, tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
    ctx.lineTo(x + bl, y + h);
    ctx.arcTo(x, y + h, x, y + h - bl, bl);
    ctx.lineTo(x, y + tl);
    ctx.arcTo(x, y, x + tl, y, tl);
    ctx.closePath();
  }

  /** Fill the current path with a hard two-tone split (the broadcast's glossy look). */
  function fillTwoTone(ctx, y, h, top, bottom) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(TOUR.split, top);
    g.addColorStop(TOUR.split, bottom);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fill();
  }

  /** Serve marker: rounded feather skirt pointing up-right, cork at the bottom-left. */
  function drawShuttleMono(ctx, cx, cy, size, color) {
    const s = size;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = color;
    // skirt: a slightly flared, rounded block
    ctx.beginPath();
    ctx.moveTo(-s * 0.2, s * 0.12);
    ctx.lineTo(-s * 0.3, -s * 0.42);
    ctx.quadraticCurveTo(0, -s * 0.56, s * 0.3, -s * 0.42);
    ctx.lineTo(s * 0.2, s * 0.12);
    ctx.closePath();
    ctx.fill();
    // cork
    ctx.beginPath();
    ctx.arc(0, s * 0.3, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function nameOf(cfg, side) {
    const team = cfg.teams[side] || { players: [] };
    return (team.players || []).filter(Boolean).join(' / ').toUpperCase() || (side ? 'PLAYER 2' : 'PLAYER 1');
  }

  // Weight 600 matches the broadcast's stroke thickness and narrowness.
  function tourFont(px) {
    return `600 ${px}px ${FONT}`;
  }

  /** Geometry of the tour board in pixels (shared by draw and measure). */
  function tourLayout(ctx, cfg, st, opts) {
    const u = (Math.min(opts.width, opts.height) / 1080) * (opts.scale || 1);
    const H = K.rowH * u;
    const hasFlags = !!(opts.flags && (opts.flags[0] || opts.flags[1]));
    const L = {
      u,
      H,
      hasFlags,
      nameFont: (K.nameCap / K.capPerEm) * H,
      digitFont: (K.digitCap / K.capPerEm) * H,
      headerH: opts.showHeader ? Math.round(0.62 * H) : 0,
    };
    L.padTop = K.padTop * H;
    L.padBottom = K.padBottom * H;
    L.padLeft = K.padLeft * H;
    L.gap = K.rowGap * H;
    L.tabW = hasFlags ? K.tabW * H : 0;
    L.nameLeft = K.nameLeft * H;
    ctx.font = tourFont(L.nameFont);
    const longest = Math.max(ctx.measureText(nameOf(cfg, 0)).width, ctx.measureText(nameOf(cfg, 1)).width);
    const shuttleRoom = (K.shuttleFromScores + K.shuttleSize) * H + 0.2 * H;
    const maxName = (cfg.format === 'singles' ? 8 : 11) * H;
    L.nameW = Math.min(maxName, Math.max(K.nameMinW * H, L.nameLeft + longest + shuttleRoom));
    L.prevW = K.prevW * H;
    L.curW = K.curW * H;
    L.sepW = Math.max(1, K.sepW * H);
    L.games = st.games.length;
    // x positions, relative to the frame's left edge
    L.tabX = L.padLeft;
    L.nameX = L.tabX + L.tabW;
    L.prevX = L.nameX + L.nameW;
    L.curX = L.prevX + L.games * L.prevW + L.sepW;
    L.frameW = L.curX + K.frameBeyondCur * H;
    L.w = L.curX + L.curW;
    L.frameH = L.padTop + 2 * H + L.gap + L.padBottom;
    L.h = L.headerH + L.frameH;
    const margin = Math.round(30 * u);
    L.x = opts.position === 'tr' ? opts.width - margin - L.w : margin;
    L.y = margin;
    return L;
  }

  function drawTour(ctx, cfg, st, opts) {
    const L = tourLayout(ctx, cfg, st, opts);
    const { H, gap } = L;
    const x0 = L.x;
    const y0 = L.y + L.headerH;
    const rTL = K.radiusTL * H;
    const r = K.radius * H;
    const rowY = (side) => y0 + L.padTop + side * (H + gap);

    ctx.save();
    ctx.textBaseline = 'alphabetic';

    // optional title strip above the board
    if (L.headerH) {
      const parts = [];
      if (cfg.title) parts.push(cfg.title);
      if (cfg.categoryLabel) parts.push(cfg.categoryLabel);
      parts.push(st.matchWinner !== null ? 'FINAL' : `GAME ${st.gameNo}`);
      const hh = L.headerH - 0.1 * H;
      roundRectCorners(ctx, x0, L.y, L.frameW, hh, r, r, 0, 0);
      ctx.fillStyle = 'rgba(35,35,38,0.88)';
      ctx.fill();
      const fs = 0.42 * H / K.capPerEm;
      const text = fitText(ctx, parts.join('  ·  ').toUpperCase(), L.frameW - 0.6 * H, 600, Math.round(fs), Math.round(fs * 0.6));
      ctx.fillStyle = '#f0f0f0';
      ctx.textAlign = 'left';
      ctx.fillText(text, x0 + 0.3 * H, L.y + hh / 2 + (0.42 * H) / 2);
    }

    // ---- light frame (behind everything) ----
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 0.3 * H;
    ctx.shadowOffsetY = 0.05 * H;
    roundRectCorners(ctx, x0, y0, L.frameW, L.frameH, rTL, r, r, r);
    ctx.fillStyle = vGradient(ctx, y0, L.frameH, TOUR.frameTop, TOUR.frameBottom);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1, 0.04 * H);
    ctx.strokeStyle = TOUR.frameEdge;
    ctx.stroke();
    // thin highlight along the top edge
    ctx.save();
    ctx.clip();
    ctx.fillStyle = TOUR.frameHighlight;
    ctx.fillRect(x0, y0 + 0.04 * H, L.frameW, Math.max(1, 0.05 * H));
    ctx.restore();

    for (let side = 0; side < 2; side++) {
      const ry = rowY(side);
      const rx = x0 + L.tabX;
      const rowRight = x0 + L.curX - L.sepW;
      // corners follow the frame: the top row's top-left is rounder
      const tl = side === 0 ? rTL - L.padLeft * 0.6 : 0.08 * H;
      const bl = side === 1 ? r - L.padLeft * 0.5 : 0.08 * H;

      ctx.save();
      roundRectCorners(ctx, rx, ry, rowRight - rx, H, Math.max(0, tl), 0, 0, Math.max(0, bl));
      ctx.clip();

      // name area: brighter towards the right, two-tone
      const nx = x0 + L.nameX;
      const nw = L.prevX - L.nameX;
      const top = ctx.createLinearGradient(nx, 0, nx + nw, 0);
      top.addColorStop(0, TOUR.nameLeftTop);
      top.addColorStop(1, TOUR.nameRightTop);
      const bottom = ctx.createLinearGradient(nx, 0, nx + nw, 0);
      bottom.addColorStop(0, TOUR.nameLeftBottom);
      bottom.addColorStop(1, TOUR.nameRightBottom);
      const splitY = ry + H * TOUR.split;
      ctx.fillStyle = top;
      ctx.fillRect(rx, ry, rowRight - rx, splitY - ry);
      ctx.fillStyle = bottom;
      ctx.fillRect(rx, splitY, rowRight - rx, ry + H - splitY);

      // flag tab: white, right edge slanting out towards the bottom
      if (L.tabW) {
        const tx = rx;
        const tw = L.tabW;
        const slant = K.tabSlant * H;
        ctx.beginPath();
        ctx.moveTo(tx, ry);
        ctx.lineTo(tx + tw - slant, ry);
        ctx.lineTo(tx + tw, ry + H);
        ctx.lineTo(tx, ry + H);
        ctx.closePath();
        fillTwoTone(ctx, ry, H, TOUR.tabTop, TOUR.tabBottom);
        ctx.strokeStyle = 'rgba(0,0,0,0.10)';
        ctx.lineWidth = Math.max(1, 0.03 * H);
        ctx.beginPath();
        ctx.moveTo(tx + tw - slant, ry);
        ctx.lineTo(tx + tw, ry + H);
        ctx.stroke();
        const img = opts.flags && opts.flags[side];
        if (img) {
          const fw = K.flagW * H;
          const fh = K.flagH * H;
          const fx = tx + K.flagLeft * H;
          const fy = ry + (H - fh) / 2;
          ctx.drawImage(img, fx, fy, fw, fh);
        }
      }

      // name, vertically centred on its capital letters
      const nameX = x0 + L.nameX + (L.tabW ? L.nameLeft : L.nameLeft * 0.6);
      const room = x0 + L.prevX - nameX - (K.shuttleFromScores + K.shuttleSize) * H - 0.15 * H;
      const nameText = fitText(ctx, nameOf(cfg, side), room, 600, L.nameFont, L.nameFont * 0.6);
      const capH = parseFloat(ctx.font.match(/(\d+(?:\.\d+)?)px/)[1]) * K.capPerEm;
      ctx.fillStyle = TOUR.text;
      ctx.textAlign = 'left';
      ctx.fillText(nameText, nameX, ry + H / 2 + capH / 2 + 0.02 * H);

      // serve marker just before the score columns
      if (st.server === side) {
        drawShuttleMono(ctx, x0 + L.prevX - K.shuttleFromScores * H, ry + H / 2 + 0.02 * H, K.shuttleSize * H, TOUR.shuttle);
      }

      // finished games: dark digits on light two-tone cells, hairline separators
      ctx.font = tourFont(L.digitFont);
      ctx.textAlign = 'center';
      let px = x0 + L.prevX;
      for (const game of st.games) {
        ctx.beginPath();
        ctx.rect(px, ry, L.prevW, H);
        fillTwoTone(ctx, ry, H, TOUR.prevTop, TOUR.prevBottom);
        ctx.fillStyle = TOUR.separator;
        ctx.fillRect(px - L.sepW, ry, L.sepW, H);
        ctx.fillStyle = TOUR.text;
        ctx.fillText(String(game.score[side]), px + L.prevW / 2, ry + H / 2 + (K.digitCap * H) / 2);
        px += L.prevW;
      }
      ctx.restore();

      // separator in front of the current column
      ctx.fillStyle = TOUR.separator;
      ctx.fillRect(x0 + L.curX - L.sepW, ry, L.sepW, H);
    }

    // ---- current game: one grey block, flush with the rows, split in two ----
    const cx = x0 + L.curX;
    const cy = rowY(0);
    const ch = 2 * H + gap;
    const cr = 0.1 * H;
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 0.2 * H;
    roundRectCorners(ctx, cx, cy, L.curW, ch, 0, cr, cr, 0);
    ctx.fillStyle = TOUR.curGap;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    for (let side = 0; side < 2; side++) {
      const ry = rowY(side);
      roundRectCorners(ctx, cx, ry, L.curW, H, 0, side === 0 ? cr : 0, side === 1 ? cr : 0, 0);
      fillTwoTone(ctx, ry, H, TOUR.curTop, TOUR.curBottom);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; // light bevel on the right edge
      ctx.fillRect(cx + L.curW - Math.max(1, 0.05 * H), ry, Math.max(1, 0.05 * H), H);
      ctx.font = tourFont(L.digitFont);
      ctx.textAlign = 'center';
      ctx.fillStyle = TOUR.curText;
      ctx.fillText(String(st.score[side]), cx + L.curW / 2, ry + H / 2 + (K.digitCap * H) / 2);
    }

    // optional GAME POINT / MATCH POINT tag beside the row it refers to
    if (st.status && opts.showStatus) {
      const fs = (0.42 * H) / K.capPerEm;
      ctx.font = tourFont(fs);
      const pw = ctx.measureText(st.status).width + 0.6 * H;
      const ph = 0.8 * H;
      const ry = rowY(st.statusSide || 0) + (H - ph) / 2;
      const tx = opts.position === 'tr' ? x0 - 0.25 * H - pw : x0 + L.w + 0.25 * H;
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = 0.2 * H;
      roundRect(ctx, tx, ry, pw, ph, 0.12 * H);
      ctx.fillStyle = TOUR.tagBg;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = TOUR.tagText;
      ctx.textAlign = 'center';
      ctx.fillText(st.status, tx + pw / 2, ry + ph / 2 + (0.42 * H) / 2);
    }
    ctx.restore();
  }

  /** Bounding box of the tour board (without the status tag), for sizing previews. */
  function measure(ctx, cfg, st, opts) {
    const L = tourLayout(ctx, cfg, st, opts);
    return { x: L.x, y: L.y, width: L.w, height: L.h, unit: L.u };
  }

  function drawAny(ctx, cfg, st, opts) {
    if (!opts.theme || opts.theme === 'tour') return drawTour(ctx, cfg, st, opts);
    return draw(ctx, cfg, st, opts);
  }

  return { THEMES, draw: drawAny, measure };
});
