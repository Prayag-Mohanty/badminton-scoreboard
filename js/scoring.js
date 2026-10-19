/*
 * Badminton rally-point scoring engine.
 *
 * Pure logic, no DOM. Works in the browser (window.Scoring) and in Node (require).
 *
 * A match is described by a config and a list of rally events:
 *   event = { t: <seconds into the video>, w: 0 | 1 }   // w = side that won the rally
 *
 * From those, buildTimeline() replays the match and stateAt() tells you exactly
 * what the scoreboard should show at any moment of the video.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRESETS = {
    // BWF standard: 3 games to 21, win by 2, capped at 30.
    '21': { pointsToWin: 21, winBy: 2, cap: 30 },
    // BWF 3x15 format: 15 points, win by 2, capped at 21.
    '15': { pointsToWin: 15, winBy: 2, cap: 21 },
    // 5x11 experimental format: win by 2, capped at 15.
    '11': { pointsToWin: 11, winBy: 2, cap: 15 },
  };

  const DEFAULT_CONFIG = {
    format: 'singles', // singles | doubles | 3v3
    category: 'M', // M (men's) | W (women's) | X (mixed) | O (open / not shown)
    title: '', // e.g. "State Ranking Tournament – Quarter Final"
    teams: [
      { players: ['Player 1'] },
      { players: ['Player 2'] },
    ],
    pointsToWin: 21,
    winBy: 2, // 1 = no deuce, first to pointsToWin wins
    cap: 30, // golden point; 0 = no cap
    bestOf: 3,
    firstServer: 0,
    // If the recording started mid-match: games already finished and the score
    // of the game in progress when the video starts.
    priorGames: [], // e.g. [[21, 17]]
    startScore: [0, 0],
    // After a game ends, the final score stays on screen this many seconds
    // before the board resets to 0-0 for the next game.
    gameEndHold: 20,
    // Camera behind one baseline: which side is on the near court (back to
    // the camera) when the video starts, and whether players change ends
    // (after each game, and mid-way through the deciding game).
    startNear: 0,
    changeEnds: true,
  };

  function normalizeConfig(cfg) {
    const c = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    c.pointsToWin = Math.max(1, parseInt(c.pointsToWin, 10) || 21);
    c.winBy = parseInt(c.winBy, 10) === 1 ? 1 : 2;
    c.cap = parseInt(c.cap, 10) || 0;
    if (c.cap && c.cap < c.pointsToWin) c.cap = 0;
    c.bestOf = [1, 3, 5].includes(parseInt(c.bestOf, 10)) ? parseInt(c.bestOf, 10) : 3;
    c.firstServer = parseInt(c.firstServer, 10) === 1 ? 1 : 0;
    c.priorGames = (c.priorGames || []).map((g) => [parseInt(g[0], 10) || 0, parseInt(g[1], 10) || 0]);
    c.startScore = [parseInt(c.startScore && c.startScore[0], 10) || 0, parseInt(c.startScore && c.startScore[1], 10) || 0];
    c.gameEndHold = Math.max(0, Number(c.gameEndHold) || 0);
    c.startNear = parseInt(c.startNear, 10) === 1 ? 1 : 0;
    c.changeEnds = c.changeEnds !== false && c.changeEnds !== 'false';
    if (!FORMAT_NAMES[c.format]) c.format = 'singles';
    if (!CATEGORY_PREFIX[c.category] && c.category !== 'O') c.category = 'O';
    if (c.format === 'singles' && c.category === 'X') c.category = 'O';
    c.categoryLabel = categoryLabel(c);
    return c;
  }

  /** Score at which players change ends in the deciding game: 11 of 21, 8 of 15, 6 of 11. */
  function midGameChange(cfg) {
    return Math.ceil(cfg.pointsToWin / 2);
  }

  /** Number of end changes that have happened by this (raw, not display) state. */
  function endChanges(cfg, state) {
    let n = state.games.length;
    const deciding = state.matchWinner === null && state.games.length === cfg.bestOf - 1;
    if (deciding && Math.max(state.score[0], state.score[1]) >= midGameChange(cfg)) n++;
    return n;
  }

  /**
   * Which side (0/1) is on the near court — back to the camera — right after
   * the last rally before video time `t`. That's who the next rally's
   * "near" button belongs to.
   */
  function nearSideAt(timeline, t) {
    const cfg = timeline.cfg;
    if (!cfg.changeEnds) return cfg.startNear;
    const idx = stepIndexAt(timeline, t);
    const s = idx >= 0 ? timeline.steps[idx].state : timeline.initial;
    const flips = endChanges(cfg, s) - endChanges(cfg, timeline.initial);
    return flips % 2 === 0 ? cfg.startNear : 1 - cfg.startNear;
  }

  function gamesToWin(cfg) {
    return Math.ceil(cfg.bestOf / 2);
  }

  /** Has `s` (score of one side) beaten `o` (the other side) under these rules? */
  function isGameWon(cfg, s, o) {
    if (cfg.cap && s >= cfg.cap) return true;
    return s >= cfg.pointsToWin && s - o >= cfg.winBy;
  }

  /** Would side `p` win the game by winning the next rally? */
  function isGamePoint(cfg, score, p) {
    return isGameWon(cfg, score[p] + 1, score[1 - p]);
  }

  function initialState(cfg) {
    const games = [];
    const gamesWon = [0, 0];
    for (const g of cfg.priorGames) {
      const winner = g[0] > g[1] ? 0 : 1;
      games.push({ score: [g[0], g[1]], winner });
      gamesWon[winner]++;
    }
    return {
      games, // completed games
      score: cfg.startScore.slice(), // game in progress
      gamesWon,
      server: cfg.firstServer,
      matchWinner: null,
      gameJustEnded: false, // the last rally ended a game
    };
  }

  function cloneState(s) {
    return {
      games: s.games.map((g) => ({ score: g.score.slice(), winner: g.winner })),
      score: s.score.slice(),
      gamesWon: s.gamesWon.slice(),
      server: s.server,
      matchWinner: s.matchWinner,
      gameJustEnded: s.gameJustEnded,
    };
  }

  /** Apply one rally won by side `w`. Returns a new state. */
  function applyRally(cfg, state, w) {
    const s = cloneState(state);
    if (s.matchWinner !== null) return s;
    s.gameJustEnded = false;
    s.score[w]++;
    s.server = w; // rally point: the rally winner serves next
    if (isGameWon(cfg, s.score[w], s.score[1 - w])) {
      s.games.push({ score: s.score.slice(), winner: w });
      s.gamesWon[w]++;
      s.score = [0, 0];
      s.gameJustEnded = true;
      if (s.gamesWon[w] >= gamesToWin(cfg)) s.matchWinner = w;
      // The winner of a game serves first in the next game: s.server already = w.
    }
    return s;
  }

  /**
   * Replay all events. Returns
   *   { cfg, initial, steps: [{ t, w, state, ignored }] }
   * Events after the match is over are kept but flagged `ignored`.
   */
  function buildTimeline(config, events) {
    const cfg = normalizeConfig(config);
    const sorted = (events || [])
      .map((e, i) => ({ t: Number(e.t) || 0, w: e.w === 1 ? 1 : 0, i }))
      .sort((a, b) => a.t - b.t || a.i - b.i);
    const initial = initialState(cfg);
    const steps = [];
    let cur = initial;
    for (const e of sorted) {
      const ignored = cur.matchWinner !== null;
      const next = ignored ? cur : applyRally(cfg, cur, e.w);
      steps.push({ t: e.t, w: e.w, state: next, ignored });
      cur = next;
    }
    return { cfg, initial, steps };
  }

  /** Index of the last step with step.t <= t, or -1. */
  function stepIndexAt(timeline, t) {
    const steps = timeline.steps;
    let lo = 0;
    let hi = steps.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (steps[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * Everything the scoreboard needs to draw at video time `t`:
   *   games      completed games to show as columns
   *   score      big "current" score
   *   server     side holding the serve (null once the match is over)
   *   gameNo     1-based number of the game being shown in the big box
   *   status     '' | 'GAME POINT' | 'MATCH POINT' | 'GAME' | 'MATCH'
   *   statusSide which side the status refers to
   */
  function stateAt(timeline, t) {
    const cfg = timeline.cfg;
    const idx = stepIndexAt(timeline, t);
    const step = idx >= 0 ? timeline.steps[idx] : null;
    const s = step ? step.state : timeline.initial;

    // Right after a game ends, keep its final score in the big box for a while
    // (the interval between games) instead of jumping straight to 0-0.
    const holding =
      s.gameJustEnded &&
      (s.matchWinner !== null || (step && t - step.t < cfg.gameEndHold));

    let games;
    let score;
    let status = '';
    let statusSide = null;
    if (holding) {
      const last = s.games[s.games.length - 1];
      games = s.games.slice(0, -1);
      score = last.score.slice();
      status = s.matchWinner !== null ? 'MATCH' : 'GAME';
      statusSide = last.winner;
    } else {
      games = s.games;
      score = s.score.slice();
      const gp = [isGamePoint(cfg, score, 0), isGamePoint(cfg, score, 1)];
      for (const p of [0, 1]) {
        if (!gp[p]) continue;
        statusSide = p;
        status = s.gamesWon[p] + 1 >= gamesToWin(cfg) ? 'MATCH POINT' : 'GAME POINT';
        // Only one side can be on game point in rally scoring (except at the
        // cap, e.g. 29-29, where both are; then show it for the server).
        if (gp[0] && gp[1]) {
          statusSide = s.server;
          status = s.gamesWon[s.server] + 1 >= gamesToWin(cfg) ? 'MATCH POINT' : 'GAME POINT';
        }
        break;
      }
    }

    return {
      games: games.map((g) => ({ score: g.score.slice(), winner: g.winner })),
      score,
      gamesWon: s.gamesWon.slice(),
      server: s.matchWinner !== null || holding ? null : s.server,
      gameNo: games.length + 1,
      status,
      statusSide,
      matchWinner: s.matchWinner,
      rallies: idx + 1,
    };
  }

  /** Distinct moments where the drawn scoreboard can change (for pre-rendering). */
  function changeTimes(timeline) {
    const times = [0];
    for (const step of timeline.steps) {
      times.push(step.t);
      if (step.state.gameJustEnded && step.state.matchWinner === null) {
        times.push(step.t + timeline.cfg.gameEndHold);
      }
    }
    return Array.from(new Set(times.filter((x) => x >= 0))).sort((a, b) => a - b);
  }

  function formatTime(sec, withHours) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0 || withHours) return `${h}:${pad(m)}:${pad(s)}`;
    return `${m}:${pad(s)}`;
  }

  function teamName(team) {
    return (team.players || []).filter(Boolean).join(' / ') || '—';
  }

  const FORMAT_NAMES = { singles: 'Singles', doubles: 'Doubles', '3v3': '3 vs 3' };
  const CATEGORY_PREFIX = { M: "Men's", W: "Women's", X: 'Mixed' };

  /** e.g. "Men's Singles", "Mixed Doubles", "Women's 3 vs 3"; '' for open play. */
  function categoryLabel(cfg) {
    const prefix = CATEGORY_PREFIX[cfg.category];
    if (!prefix) return '';
    return `${prefix} ${FORMAT_NAMES[cfg.format] || ''}`.trim();
  }

  /**
   * Text for a YouTube description: result line, game scores and chapter
   * timestamps (YouTube turns "m:ss Title" lines into chapters when the first
   * one is 0:00).
   */
  function youtubeSummary(timeline, duration) {
    const cfg = timeline.cfg;
    const names = cfg.teams.map(teamName);
    const lines = [];
    const last = timeline.steps.length ? timeline.steps[timeline.steps.length - 1].state : timeline.initial;
    const withHours = (duration || 0) >= 3600;

    const head = [cfg.title, cfg.categoryLabel].filter(Boolean).join(' – ');
    if (head) lines.push(head);
    lines.push(`${names[0]} vs ${names[1]}`);
    if (last.games.length) {
      const scores = last.games.map((g) => `${g.score[0]}-${g.score[1]}`).join(', ');
      if (last.matchWinner !== null) {
        const w = last.matchWinner;
        const wScores = last.games.map((g) => `${g.score[w]}-${g.score[1 - w]}`).join(', ');
        lines.push(`Result: ${names[w]} won ${last.gamesWon[w]}-${last.gamesWon[1 - w]} (${wScores})`);
      } else {
        lines.push(`Games: ${scores}`);
      }
    }

    // Chapters: a game starts right after the previous one's last rally.
    const chapters = [{ t: 0, label: `Game ${cfg.priorGames.length + 1}` }];
    let gameNo = cfg.priorGames.length + 1;
    for (const step of timeline.steps) {
      if (step.ignored || !step.state.gameJustEnded) continue;
      const g = step.state.games[step.state.games.length - 1];
      chapters[chapters.length - 1].label += ` (${g.score[0]}-${g.score[1]})`;
      if (step.state.matchWinner !== null) break;
      gameNo++;
      chapters.push({ t: step.t, label: `Game ${gameNo}` });
    }
    lines.push('');
    lines.push('Chapters:');
    for (const ch of chapters) lines.push(`${formatTime(ch.t, withHours)} ${ch.label}`);
    return lines.join('\n');
  }

  return {
    PRESETS,
    DEFAULT_CONFIG,
    categoryLabel,
    normalizeConfig,
    gamesToWin,
    isGameWon,
    isGamePoint,
    applyRally,
    buildTimeline,
    stateAt,
    stepIndexAt,
    changeTimes,
    formatTime,
    teamName,
    youtubeSummary,
    nearSideAt,
    midGameChange,
  };
});
