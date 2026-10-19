/*
 * Draws a BWF-TV-style scoreboard onto a 2D canvas context.
 *
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

  return { THEMES, draw };
});
