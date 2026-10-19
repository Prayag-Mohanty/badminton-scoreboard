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

  const TOUR = {
    frameTop: '#f7f7f7',
    frameBottom: '#a9a9a9',
    frameEdge: 'rgba(60,60,60,0.55)',
    rowLeft: '#fbfbfb',
    rowRight: '#ececec',
    nameText: '#262626',
    prevTop: '#efefef',
    prevBottom: '#d9d9d9',
    prevText: '#1f1f1f',
    curTop: '#bdbdbd',
    curBottom: '#6f6f6f',
    curText: '#ffffff',
    shuttle: '#9a9a9a',
    tagBg: '#2f2f2f',
    tagText: '#ffffff',
  };

  function vGradient(ctx, y, h, top, bottom) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  }

  /** Rounded rectangle with the top-left corner cut on a diagonal, like the broadcast frame. */
  function chamferRect(ctx, x, y, w, h, cut, r) {
    ctx.beginPath();
    ctx.moveTo(x + cut, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + cut);
    ctx.closePath();
  }

  /** Grey shuttle silhouette, cork bottom-left, as in the broadcast serve marker. */
  function drawShuttleMono(ctx, cx, cy, size, color) {
    const s = size;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.PI / 4.2);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-s * 0.16, s * 0.1);
    ctx.lineTo(-s * 0.38, -s * 0.5);
    ctx.lineTo(s * 0.38, -s * 0.5);
    ctx.lineTo(s * 0.16, s * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, s * 0.2, s * 0.17, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function nameOf(cfg, side) {
    const team = cfg.teams[side] || { players: [] };
    return (team.players || []).filter(Boolean).join(' / ').toUpperCase() || (side ? 'PLAYER 2' : 'PLAYER 1');
  }

  /** Geometry of the tour board in pixels (shared by draw and measure). */
  function tourLayout(ctx, cfg, st, opts) {
    const u = (Math.min(opts.width, opts.height) / 1080) * (opts.scale || 1);
    const L = {
      u,
      pad: 4 * u,
      gap: 3 * u,
      rowH: Math.round(44 * u),
      flagW: opts.flags && (opts.flags[0] || opts.flags[1]) ? Math.round(62 * u) : 0,
      colW: Math.round(46 * u),
      curW: Math.round(52 * u),
      curGap: Math.round(2 * u),
      serveW: Math.round(34 * u),
      nameSize: Math.round(29 * u),
      headerH: opts.showHeader ? Math.round(24 * u) : 0,
    };
    // Name column fits the longer name (like the broadcast), within limits.
    ctx.font = `600 ${L.nameSize}px ${FONT}`;
    const longest = Math.max(ctx.measureText(nameOf(cfg, 0)).width, ctx.measureText(nameOf(cfg, 1)).width);
    const maxName = (cfg.format === 'singles' ? 330 : 470) * u;
    L.nameW = Math.round(Math.min(maxName, Math.max(250 * u, longest + 40 * u)) + L.serveW);
    L.games = st.games.length;
    L.mainW = L.pad + L.flagW + L.nameW + L.games * L.colW + L.pad;
    L.w = L.mainW + L.curGap + L.curW;
    L.h = L.headerH + L.pad * 2 + L.rowH * 2 + L.gap;
    const margin = Math.round(30 * u);
    L.x = opts.position === 'tr' ? opts.width - margin - L.w : margin;
    L.y = margin;
    return L;
  }

  function drawTour(ctx, cfg, st, opts) {
    const L = tourLayout(ctx, cfg, st, opts);
    const { u, pad, gap, rowH } = L;
    const x0 = L.x;
    const y0 = L.y + L.headerH;
    const frameH = pad * 2 + rowH * 2 + gap;
    const cut = 9 * u;
    const r = 5 * u;

    ctx.save();
    ctx.textBaseline = 'middle';

    // optional title strip above the board
    if (L.headerH) {
      const parts = [];
      if (cfg.title) parts.push(cfg.title);
      if (cfg.categoryLabel) parts.push(cfg.categoryLabel);
      parts.push(st.matchWinner !== null ? 'FINAL' : `GAME ${st.gameNo}`);
      roundRect(ctx, x0 + cut, L.y, L.mainW - cut, L.headerH - 2 * u, 4 * u);
      ctx.fillStyle = 'rgba(30,30,30,0.85)';
      ctx.fill();
      const text = fitText(ctx, parts.join('  ·  ').toUpperCase(), L.mainW - cut - 16 * u, 600, Math.round(15 * u), Math.round(10 * u));
      ctx.fillStyle = '#f2f2f2';
      ctx.textAlign = 'left';
      ctx.fillText(text, x0 + cut + 8 * u, L.y + (L.headerH - 2 * u) / 2 + 1 * u);
    }

    // main frame with drop shadow and bevel
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 10 * u;
    ctx.shadowOffsetY = 2 * u;
    chamferRect(ctx, x0, y0, L.mainW, frameH, cut, r);
    ctx.fillStyle = vGradient(ctx, y0, frameH, TOUR.frameTop, TOUR.frameBottom);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(1, 1 * u);
    ctx.strokeStyle = TOUR.frameEdge;
    ctx.stroke();

    // current-game box: its own darker piece on the right
    const cx = x0 + L.mainW + L.curGap;
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 10 * u;
    ctx.shadowOffsetY = 2 * u;
    roundRect(ctx, cx, y0, L.curW, frameH, r);
    ctx.fillStyle = vGradient(ctx, y0, frameH, '#9a9a9a', '#5a5a5a');
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = TOUR.frameEdge;
    ctx.stroke();

    for (let side = 0; side < 2; side++) {
      const ry = y0 + pad + side * (rowH + gap);
      const rx = x0 + pad;
      const rowW = L.mainW - pad * 2;

      // row background: white fading to light grey
      const g = ctx.createLinearGradient(rx, 0, rx + rowW, 0);
      g.addColorStop(0, TOUR.rowLeft);
      g.addColorStop(1, TOUR.rowRight);
      ctx.save();
      if (side === 0) chamferRect(ctx, rx, ry, rowW, rowH, cut - pad * 0.6, 2 * u);
      else roundRect(ctx, rx, ry, rowW, rowH, 2 * u);
      ctx.clip();
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rowW, rowH);
      // soft top highlight / bottom shade for the glossy look
      ctx.fillStyle = vGradient(ctx, ry, rowH, 'rgba(255,255,255,0.6)', 'rgba(0,0,0,0.04)');
      ctx.fillRect(rx, ry, rowW, rowH);

      let x = rx;
      // flag in a white tab with a slanted right edge
      if (L.flagW) {
        const fw = Math.round(40 * u);
        const fh = Math.round(30 * u);
        const tabW = L.flagW - 6 * u;
        ctx.beginPath();
        ctx.moveTo(x, ry);
        ctx.lineTo(x + tabW, ry);
        ctx.lineTo(x + tabW - 8 * u, ry + rowH);
        ctx.lineTo(x, ry + rowH);
        ctx.closePath();
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.lineWidth = Math.max(1, u);
        ctx.stroke();
        const img = opts.flags[side];
        const fx = x + 6 * u;
        const fy = ry + (rowH - fh) / 2;
        if (img) {
          ctx.drawImage(img, fx, fy, fw, fh);
          ctx.strokeStyle = 'rgba(0,0,0,0.15)';
          ctx.strokeRect(fx, fy, fw, fh);
        }
        x += L.flagW;
      } else {
        x += 8 * u;
      }

      // name
      const nameRoom = L.nameW - L.serveW - (L.flagW ? 0 : 8 * u);
      const name = fitText(ctx, nameOf(cfg, side), nameRoom - 6 * u, 600, L.nameSize, Math.round(16 * u));
      ctx.fillStyle = TOUR.nameText;
      ctx.textAlign = 'left';
      ctx.fillText(name, x, ry + rowH / 2 + 2 * u);
      x += nameRoom;
      if (st.server === side) drawShuttleMono(ctx, x + L.serveW / 2 - 2 * u, ry + rowH / 2 + 1 * u, 24 * u, TOUR.shuttle);
      x += L.serveW;

      // finished games: dark numbers on light boxes
      for (const game of st.games) {
        ctx.fillStyle = vGradient(ctx, ry, rowH, TOUR.prevTop, TOUR.prevBottom);
        ctx.fillRect(x + 1 * u, ry, L.colW - 2 * u, rowH);
        ctx.fillStyle = TOUR.prevText;
        ctx.font = `700 ${Math.round(33 * u)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(String(game.score[side]), x + L.colW / 2, ry + rowH / 2 + 2 * u);
        x += L.colW;
      }
      ctx.restore();

      // current game: white numbers on grey
      const cy = ry;
      ctx.save();
      roundRect(ctx, cx + pad * 0.75, cy, L.curW - pad * 1.5, rowH, 2 * u);
      ctx.fillStyle = vGradient(ctx, cy, rowH, TOUR.curTop, TOUR.curBottom);
      ctx.fill();
      ctx.fillStyle = TOUR.curText;
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 2 * u;
      ctx.font = `700 ${Math.round(34 * u)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(st.score[side]), cx + L.curW / 2, cy + rowH / 2 + 2 * u);
      ctx.restore();
    }

    // GAME POINT / MATCH POINT / GAME / MATCH tag beside the row it refers to
    if (st.status && opts.showStatus !== false) {
      ctx.font = `700 ${Math.round(19 * u)}px ${FONT}`;
      const pw = ctx.measureText(st.status).width + 18 * u;
      const ph = Math.round(30 * u);
      const ry = y0 + pad + (st.statusSide || 0) * (rowH + gap) + (rowH - ph) / 2;
      const px = opts.position === 'tr' ? x0 - 8 * u - pw : x0 + L.w + 8 * u;
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = 6 * u;
      roundRect(ctx, px, ry, pw, ph, 4 * u);
      ctx.fillStyle = TOUR.tagBg;
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = TOUR.tagText;
      ctx.textAlign = 'center';
      ctx.fillText(st.status, px + pw / 2, ry + ph / 2 + 1 * u);
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
