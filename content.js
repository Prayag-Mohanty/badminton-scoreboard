/* global Scoring, Overlay, chrome */
/*
 * Badminton Scoreboard for YouTube — content script.
 *
 * Adds a panel beside the YouTube player with a BWF-style scoreboard, buttons
 * (and keys) to award each rally, and match setup. Optionally draws the same
 * scoreboard on top of the video itself, including in full screen.
 *
 * Everything is stored per video in chrome.storage.local, in the same project
 * format as the Badminton Scoreboard web app, so a match scored here can be
 * loaded there to burn the scoreboard into the original file.
 */
(() => {
  'use strict';
  if (window.__bsbLoaded) return;
  window.__bsbLoaded = true;

  const STORE_PREFIX = 'match:';
  const SETTINGS_KEY = 'settings';
  const KEYS = { side0: 'q', side1: 'p', undo: 'u' };

  const DEFAULT_CONFIG = {
    format: 'singles',
    category: 'M',
    title: '',
    teams: [{ players: [''] }, { players: [''] }],
    preset: '21',
    pointsToWin: 21,
    winBy: 2,
    cap: 30,
    bestOf: 3,
    firstServer: 0,
    priorGames: [],
    startScore: [0, 0],
    gameEndHold: 20,
  };
  const DEFAULT_LOOK = { theme: 'bwf', scale: 1, position: 'tl', showHeader: true };

  const st = {
    videoId: null,
    project: null, // { config, look, events: [{ t, w }] }
    timeline: null,
    settings: { onVideo: true },
    panelOpen: false,
    scoring: false,
    lastKey: '',
    saveTimer: null,
  };

  // ------------------------------------------------------------------ helpers

  const h = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) el.append(c);
    return el;
  };

  function storageGet(key) {
    return new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r[key])));
  }
  function storageSet(key, value) {
    return new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));
  }
  function storageRemove(key) {
    return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
  }

  function currentVideoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:live|shorts)\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function videoEl() {
    return document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video.html5-main-video');
  }
  function playerEl() {
    return document.getElementById('movie_player');
  }
  function adShowing() {
    const p = playerEl();
    return !!(p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
  }
  function videoTitle() {
    const t = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1');
    return (t && t.textContent.trim()) || document.title.replace(/ - YouTube$/, '');
  }

  function teamLabel(side) {
    const team = st.project && st.project.config.teams[side];
    const name = team ? Scoring.teamName(team) : '';
    return name && name !== '—' ? name : `Side ${side + 1}`;
  }

  async function loadFonts() {
    try {
      for (const w of [600, 700, 800]) {
        const f = new FontFace('Barlow Condensed', `url(${chrome.runtime.getURL(`fonts/BarlowCondensed-${w}.ttf`)})`, { weight: String(w) });
        document.fonts.add(await f.load());
      }
    } catch (e) {
      /* falls back to a system condensed font */
    }
    st.lastKey = '';
  }

  // ------------------------------------------------------------------ project state

  function rebuild() {
    st.timeline = Scoring.buildTimeline(st.project.config, st.project.events);
    st.lastKey = '';
    renderRallies();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(st.saveTimer);
    const id = st.videoId;
    const data = projectData();
    st.saveTimer = setTimeout(() => storageSet(STORE_PREFIX + id, data), 300);
  }

  function projectData() {
    const v = videoEl();
    return {
      app: 'badminton-scoreboard',
      version: 1,
      savedAt: new Date().toISOString(),
      video: { youtube: st.videoId, title: videoTitle(), duration: v ? v.duration || 0 : 0 },
      config: st.project.config,
      look: st.project.look,
      events: st.project.events.map((e) => ({ t: Math.round(e.t * 1000) / 1000, w: e.w })),
    };
  }

  function normalizeProject(p) {
    return {
      config: Object.assign({}, DEFAULT_CONFIG, p && p.config),
      look: Object.assign({}, DEFAULT_LOOK, p && p.look),
      events: ((p && p.events) || []).map((e) => ({ t: Number(e.t) || 0, w: e.w === 1 ? 1 : 0 })),
    };
  }

  // ------------------------------------------------------------------ UI: panel

  let panel = null;
  let ui = {};

  function buildPanel() {
    ui = {};
    ui.board = h('canvas', { class: 'bsb-board' });
    ui.flash = h('div', { class: 'bsb-flash' });
    ui.onVideo = h('input', { type: 'checkbox', onchange: (e) => setSetting('onVideo', e.target.checked) });
    ui.scoring = h('input', { type: 'checkbox', onchange: (e) => setScoring(e.target.checked) });
    ui.names = [h('span', { class: 'bsb-name' }), h('span', { class: 'bsb-name' })];
    ui.pt = [0, 1].map((side) =>
      h('button', { class: `bsb-pt bsb-side${side}`, type: 'button', onclick: () => addPoint(side) }, [
        h('kbd', { text: side ? KEYS.side1.toUpperCase() : KEYS.side0.toUpperCase() }),
        ui.names[side],
      ])
    );
    ui.undo = h('button', { class: 'bsb-undo', type: 'button', onclick: undo }, [h('kbd', { text: KEYS.undo.toUpperCase() }), ' Undo']);
    ui.rallies = h('ol', { class: 'bsb-rallies', reversed: true });
    ui.count = h('span', { class: 'bsb-count' });
    ui.scoringBox = h('div', { class: 'bsb-scoring' }, [
      h('div', { class: 'bsb-points' }, [ui.pt[0], ui.undo, ui.pt[1]]),
      h('div', { class: 'bsb-hint', text: 'Press when each rally ends. The score changes at that moment of the video.' }),
      h('div', { class: 'bsb-rallies-head' }, [h('span', { text: 'Rallies ' }), ui.count]),
      ui.rallies,
    ]);
    ui.setup = buildSetup();
    ui.menu = buildMenu();
    ui.adNote = h('div', { class: 'bsb-ad', text: 'Ad playing: the scoreboard is paused until the match video is back.' });

    panel = h('div', { id: 'bsb-panel' }, [
      h('div', { class: 'bsb-head' }, [
        h('span', { class: 'bsb-title', text: '🏸 Badminton scoreboard' }),
        h('div', { class: 'bsb-head-btns' }, [
          h('button', { type: 'button', title: 'Match setup', text: '⚙', onclick: () => togglePane('setup') }),
          h('button', { type: 'button', title: 'Description, save & load', text: '⋯', onclick: () => togglePane('menu') }),
          h('button', { type: 'button', title: 'Hide (toolbar icon brings it back)', text: '✕', onclick: () => setPanelOpen(false) }),
        ]),
      ]),
      ui.board,
      ui.adNote,
      h('div', { class: 'bsb-toggles' }, [
        h('label', {}, [ui.onVideo, ' Show on the video']),
        h('label', {}, [ui.scoring, ' Scoring mode']),
      ]),
      ui.scoringBox,
      ui.setup.el,
      ui.menu,
      ui.flash,
    ]);
  }

  function field(label, input) {
    return h('label', { class: 'bsb-field' }, [h('span', { text: label }), input]);
  }
  function select(name, options) {
    return h(
      'select',
      { name },
      options.map(([v, t]) => h('option', { value: v, text: t }))
    );
  }

  function buildSetup() {
    const f = h('form', { class: 'bsb-setup', hidden: true, onsubmit: (e) => e.preventDefault() });
    const inputs = {
      format: select('format', [['singles', 'Singles'], ['doubles', 'Doubles'], ['3v3', '3 vs 3']]),
      category: select('category', [['M', "Men's"], ['W', "Women's"], ['X', 'Mixed'], ['O', "Don't show"]]),
      preset: select('preset', [['21', '21 points (cap 30)'], ['15', '15 points (cap 21)'], ['11', '11 points (cap 15)'], ['nodeuce', '21 points, no deuce']]),
      bestOf: select('bestOf', [['1', '1 game'], ['3', 'Best of 3'], ['5', 'Best of 5']]),
      firstServer: select('firstServer', [['0', 'Side 1'], ['1', 'Side 2']]),
      title: h('input', { name: 'title', maxlength: 60, placeholder: 'e.g. Hyderabad Open · Final' }),
      theme: select('theme', [['bwf', 'BWF blue'], ['dark', 'Dark'], ['red', 'Red']]),
      scale: h('input', { name: 'scale', type: 'range', min: 0.6, max: 1.6, step: 0.05 }),
      startScore: h('input', { name: 'startScore', placeholder: '0-0', size: 6 }),
    };
    const players = [0, 1].map((side) =>
      [0, 1, 2].map((i) => h('input', { name: `p${side}_${i}`, maxlength: 40, placeholder: i === 0 ? 'Player' : i === 1 ? 'Partner' : 'Third player' }))
    );
    f.append(
      h('div', { class: 'bsb-grid2' }, [field('Match type', inputs.format), field('Category', inputs.category)]),
      h('div', { class: 'bsb-grid2' }, [
        h('fieldset', { class: 'bsb-team' }, [h('legend', { text: 'Side 1' })].concat(players[0])),
        h('fieldset', { class: 'bsb-team' }, [h('legend', { text: 'Side 2' })].concat(players[1])),
      ]),
      h('div', { class: 'bsb-grid2' }, [field('Points', inputs.preset), field('Games', inputs.bestOf)]),
      h('div', { class: 'bsb-grid2' }, [field('Serves first', inputs.firstServer), field('Score at video start', inputs.startScore)]),
      field('Title (optional)', inputs.title),
      h('div', { class: 'bsb-grid2' }, [field('Colours', inputs.theme), field('Size on video', inputs.scale)]),
      h('div', { class: 'bsb-row' }, [h('button', { type: 'button', class: 'bsb-primary', text: 'Done', onclick: () => togglePane(null) })])
    );

    const read = () => {
      const fd = new FormData(f);
      const format = fd.get('format');
      const count = format === 'singles' ? 1 : format === 'doubles' ? 2 : 3;
      const preset = fd.get('preset');
      const rules = preset === 'nodeuce' ? { pointsToWin: 21, winBy: 1, cap: 0 } : Scoring.PRESETS[preset];
      const ss = String(fd.get('startScore') || '').match(/(\d+)\s*[-–: ]\s*(\d+)/);
      Object.assign(st.project.config, rules, {
        format,
        category: format === 'singles' && fd.get('category') === 'X' ? 'M' : fd.get('category'),
        preset: preset === 'nodeuce' ? 'custom' : preset,
        bestOf: parseInt(fd.get('bestOf'), 10),
        firstServer: parseInt(fd.get('firstServer'), 10),
        title: String(fd.get('title') || '').trim(),
        startScore: ss ? [parseInt(ss[1], 10), parseInt(ss[2], 10)] : [0, 0],
        teams: [0, 1].map((side) => ({ players: [0, 1, 2].slice(0, count).map((i) => String(fd.get(`p${side}_${i}`) || '').trim()) })),
      });
      Object.assign(st.project.look, { theme: fd.get('theme'), scale: parseFloat(fd.get('scale')) || 1 });
      for (const side of [0, 1]) players[side].forEach((el, i) => (el.hidden = i >= count));
      inputs.category.querySelector('option[value="X"]').hidden = format === 'singles';
      refreshLabels();
      rebuild();
    };
    f.addEventListener('input', read);
    f.addEventListener('change', read);

    const write = () => {
      const c = st.project.config;
      inputs.format.value = c.format;
      inputs.category.value = c.category;
      inputs.preset.value = c.winBy === 1 && c.pointsToWin === 21 ? 'nodeuce' : String(c.pointsToWin) in Scoring.PRESETS ? String(c.pointsToWin) : '21';
      inputs.bestOf.value = String(c.bestOf);
      inputs.firstServer.value = String(c.firstServer);
      inputs.title.value = c.title || '';
      inputs.startScore.value = c.startScore && (c.startScore[0] || c.startScore[1]) ? c.startScore.join('-') : '';
      inputs.theme.value = st.project.look.theme;
      inputs.scale.value = st.project.look.scale;
      const count = c.format === 'singles' ? 1 : c.format === 'doubles' ? 2 : 3;
      for (const side of [0, 1]) {
        players[side].forEach((el, i) => {
          el.value = (c.teams[side] && c.teams[side].players[i]) || '';
          el.hidden = i >= count;
        });
      }
      inputs.category.querySelector('option[value="X"]').hidden = c.format === 'singles';
    };
    return { el: f, write, firstServer: inputs.firstServer };
  }

  function buildMenu() {
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: importProject });
    return h('div', { class: 'bsb-menu', hidden: true }, [
      h('button', { type: 'button', text: '📋 Copy YouTube description (result + chapters)', onclick: copyDescription }),
      h('button', { type: 'button', text: '💾 Save project file (.json)', onclick: exportProject }),
      h('button', { type: 'button', text: '📂 Load project file', onclick: () => fileInput.click() }),
      h('button', { type: 'button', class: 'bsb-danger', text: '🗑 Reset the score for this video', onclick: resetMatch }),
      h('p', {
        class: 'bsb-note',
        text: 'Project files also open in the Badminton Scoreboard web app, which can burn the scoreboard into your original video file.',
      }),
      fileInput,
    ]);
  }

  function togglePane(which) {
    const setupOpen = which === 'setup' && ui.setup.el.hidden;
    const menuOpen = which === 'menu' && ui.menu.hidden;
    ui.setup.el.hidden = !setupOpen;
    ui.menu.hidden = !menuOpen;
    if (setupOpen) ui.setup.write();
  }

  function refreshLabels() {
    for (const side of [0, 1]) {
      ui.names[side].textContent = teamLabel(side);
      ui.setup.firstServer.options[side].textContent = teamLabel(side);
    }
  }

  let flashTimer = null;
  function flash(text) {
    ui.flash.textContent = text;
    ui.flash.classList.add('bsb-show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ui.flash.classList.remove('bsb-show'), 1400);
    // Also show it on the video, where the viewer is looking.
    if (videoFlash) {
      videoFlash.textContent = text;
      videoFlash.classList.add('bsb-show');
      clearTimeout(videoFlash._t);
      videoFlash._t = setTimeout(() => videoFlash.classList.remove('bsb-show'), 1200);
    }
  }

  function renderRallies() {
    if (!ui.rallies) return;
    const steps = st.timeline.steps;
    ui.count.textContent = String(steps.length);
    const sorted = st.project.events.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i);
    const items = [];
    for (let i = steps.length - 1; i >= 0 && items.length < 40; i--) {
      const step = steps[i];
      const s = step.state;
      const g = s.gameJustEnded ? s.games[s.games.length - 1] : null;
      const score = g ? `${g.score[0]}–${g.score[1]}` : `${s.score[0]}–${s.score[1]}`;
      const idx = sorted[i].i;
      items.push(
        h('li', { class: step.ignored ? 'bsb-ignored' : '', title: 'Jump to this rally', onclick: () => seek(step.t - 3) }, [
          h('span', { class: 'bsb-t', text: Scoring.formatTime(step.t) }),
          h('span', { class: `bsb-who bsb-side${step.w}`, text: teamLabel(step.w) }),
          h('b', { text: step.ignored ? '(after match)' : score }),
          h('span', { class: 'bsb-tag', text: g ? (s.matchWinner !== null ? 'MATCH' : 'GAME') : '' }),
          h('button', {
            type: 'button',
            title: 'Delete this point',
            text: '✕',
            onclick: (ev) => {
              ev.stopPropagation();
              st.project.events.splice(idx, 1);
              rebuild();
            },
          }),
        ])
      );
    }
    ui.rallies.replaceChildren(...items);
  }

  // ------------------------------------------------------------------ actions

  function seek(t) {
    const v = videoEl();
    if (v) v.currentTime = Math.max(0, t);
  }

  function addPoint(w) {
    const v = videoEl();
    if (!v || !st.project) return;
    if (adShowing()) return flash('Wait for the ad to finish.');
    const t = v.currentTime;
    const before = Scoring.stateAt(st.timeline, t);
    if (before.matchWinner !== null && before.rallies === st.timeline.steps.length) {
      return flash('The match is already over. Undo or delete points to change it.');
    }
    st.project.events.push({ t, w });
    rebuild();
    const s = Scoring.stateAt(st.timeline, t);
    let msg = `${teamLabel(w)}  ${s.score[0]}–${s.score[1]}`;
    if (s.status === 'GAME' || s.status === 'MATCH') msg = `${s.status} ${msg}`;
    else if (s.status) msg += ` · ${s.status}`;
    flash(msg);
  }

  function undo() {
    const ev = st.project && st.project.events;
    if (!ev || !ev.length) return;
    const removed = ev.pop(); // events are kept in the order they were added
    rebuild();
    flash(`Undone: point to ${teamLabel(removed.w)} at ${Scoring.formatTime(removed.t)}`);
  }

  async function copyDescription() {
    const v = videoEl();
    const text = Scoring.youtubeSummary(st.timeline, v ? v.duration : 0);
    try {
      await navigator.clipboard.writeText(text);
      flash('Description copied');
    } catch (e) {
      prompt('Copy the description:', text);
    }
  }

  function exportProject() {
    const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${st.videoId}-scoreboard.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  async function importProject(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let p;
    try {
      p = JSON.parse(await file.text());
      if (p.app !== 'badminton-scoreboard' || !p.config) throw new Error();
    } catch (err) {
      alert("That file isn't a Badminton Scoreboard project.");
      return;
    }
    if (p.video && p.video.youtube && p.video.youtube !== st.videoId) {
      if (!confirm('This project was saved for a different YouTube video. Load it here anyway?')) return;
    }
    if (st.project.events.length && !confirm(`Replace the ${st.project.events.length} rallies already scored for this video?`)) return;
    st.project = normalizeProject(p);
    refreshLabels();
    rebuild();
    togglePane(null);
    flash(`Loaded ${st.project.events.length} rallies`);
  }

  async function resetMatch() {
    if (!confirm('Delete all scored rallies for this video? Match setup is kept.')) return;
    st.project.events = [];
    rebuild();
    togglePane(null);
  }

  function setScoring(on) {
    st.scoring = on;
    ui.scoring.checked = on;
    ui.scoringBox.hidden = !on;
  }

  async function setSetting(key, value) {
    st.settings[key] = value;
    await storageSet(SETTINGS_KEY, st.settings);
    st.lastKey = '';
    placeOverlay();
  }

  function setPanelOpen(open) {
    st.panelOpen = open;
    if (open) {
      mountPanel();
      // A brand-new match: open setup and scoring straight away.
      if (!st.project.events.length && !st.project.config.teams[0].players[0]) {
        togglePane('setup');
        setScoring(true);
      }
    } else if (panel) panel.remove();
    st.lastKey = '';
    placeOverlay();
  }

  // Keys only while scoring mode is on, and never while typing.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!st.panelOpen || !st.scoring || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      let handled = true;
      if (k === KEYS.side0) addPoint(0);
      else if (k === KEYS.side1) addPoint(1);
      else if (k === KEYS.undo) undo();
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation(); // keep YouTube's own shortcuts from also firing
      }
    },
    true
  );

  // ------------------------------------------------------------------ placement

  function mountPanel() {
    if (!panel) buildPanel();
    ui.onVideo.checked = !!st.settings.onVideo;
    ui.scoring.checked = st.scoring;
    ui.scoringBox.hidden = !st.scoring;
    ui.setup.write();
    refreshLabels();
    renderRallies();
    placePanel();
  }

  /** Beside the player in the normal layout; below it in theatre mode or on narrow windows. */
  function placePanel() {
    if (!panel) return;
    const secondary = document.querySelector('#secondary-inner') || document.querySelector('#secondary');
    const visible = secondary && secondary.offsetParent !== null && secondary.getBoundingClientRect().width > 250;
    const host = visible ? secondary : document.querySelector('#below') || document.querySelector('#primary-inner') || document.body;
    if (panel.parentElement !== host) host.prepend(panel);
    panel.classList.toggle('bsb-floating', host === document.body);
  }

  let overlayCanvas = null;
  let videoFlash = null;

  function placeOverlay() {
    const p = playerEl();
    const show = st.panelOpen && st.settings.onVideo && p;
    if (!show) {
      if (overlayCanvas) overlayCanvas.remove();
      if (videoFlash) videoFlash.remove();
      return;
    }
    if (!overlayCanvas) {
      overlayCanvas = h('canvas', { class: 'bsb-video-board' });
      videoFlash = h('div', { class: 'bsb-video-flash' });
    }
    if (overlayCanvas.parentElement !== p) p.append(overlayCanvas, videoFlash);
  }

  function sizeOverlay() {
    const v = videoEl();
    if (!overlayCanvas || !v || !overlayCanvas.isConnected) return false;
    // YouTube sizes and positions the <video> element to the visible picture.
    const dpr = window.devicePixelRatio || 1;
    const w = v.offsetWidth;
    const hgt = v.offsetHeight;
    if (!w || !hgt) return false;
    const css = `left:${v.offsetLeft}px;top:${v.offsetTop}px;width:${w}px;height:${hgt}px`;
    if (overlayCanvas.style.cssText !== css) overlayCanvas.style.cssText = css;
    const pw = Math.round(w * dpr);
    const ph = Math.round(hgt * dpr);
    if (overlayCanvas.width !== pw || overlayCanvas.height !== ph) {
      overlayCanvas.width = pw;
      overlayCanvas.height = ph;
      return true;
    }
    return false;
  }

  /** Draw the board into the panel canvas so it fills the panel's width. */
  function drawPanelBoard(cfg, s, look) {
    const c = ui.board;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 380;
    // Board width in overlay units: serve + names + game columns + current + status pill.
    const nameU = cfg.format === 'singles' ? 300 : 400;
    const units = 28 + 36 + nameU + Math.max(1, cfg.bestOf - 1) * 44 + 56 + 130;
    const u = (cssW * dpr) / units;
    const width = Math.round(cssW * dpr);
    const height = Math.round((28 + 26 + 92 + 14) * u);
    if (c.width !== width || c.height !== height) {
      c.width = width;
      c.height = height;
      c.style.height = `${height / dpr}px`;
    }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, width, height);
    // Overlay sizes by min(width, height)/1080 × scale; pick the scale that gives `u`.
    const ref = Math.min(width, 1080);
    Overlay.draw(ctx, cfg, s, Object.assign({}, look, { position: 'tl', width, height: 1080, scale: (u * 1080) / ref }));
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!st.panelOpen || !st.timeline) return;
    const v = videoEl();
    const ad = adShowing();
    const t = v ? v.currentTime : 0;
    const s = Scoring.stateAt(st.timeline, t);
    const resized = sizeOverlay();
    const key = JSON.stringify(s) + JSON.stringify(st.project.look) + ad + (ui.board.clientWidth || 0);
    if (key === st.lastKey && !resized) return;
    st.lastKey = key;
    ui.adNote.hidden = !ad;
    ui.pt.forEach((b) => (b.disabled = ad));
    const cfg = st.timeline.cfg;
    drawPanelBoard(cfg, s, st.project.look);
    if (overlayCanvas && overlayCanvas.isConnected) {
      const ctx = overlayCanvas.getContext('2d');
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      if (!ad) Overlay.draw(ctx, cfg, s, Object.assign({}, st.project.look, { width: overlayCanvas.width, height: overlayCanvas.height }));
    }
    if (ui.rallies) {
      ui.rallies.querySelectorAll('.bsb-current').forEach((li) => li.classList.remove('bsb-current'));
      const idx = st.timeline.steps.length - s.rallies; // list is newest first
      const li = ui.rallies.children[idx];
      if (s.rallies > 0 && li) li.classList.add('bsb-current');
    }
  }

  // ------------------------------------------------------------------ page lifecycle

  async function onPage() {
    const id = currentVideoId();
    if (id === st.videoId) return;
    // Leaving a video: flush its save first.
    if (st.videoId && st.project) {
      clearTimeout(st.saveTimer);
      await storageSet(STORE_PREFIX + st.videoId, projectData());
    }
    st.videoId = id;
    if (!id) {
      st.project = null;
      st.timeline = null;
      setPanelOpen(false);
      return;
    }
    const saved = await storageGet(STORE_PREFIX + id);
    st.project = normalizeProject(saved);
    st.timeline = Scoring.buildTimeline(st.project.config, st.project.events);
    st.scoring = false;
    // Videos you've scored before open with their scoreboard; others stay untouched
    // until you click the toolbar icon.
    if (saved && saved.events && saved.events.length) setPanelOpen(true);
    else if (st.panelOpen) setPanelOpen(true);
    else setPanelOpen(false);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle-panel') {
      if (!st.videoId) {
        alert('Open a YouTube video to use the badminton scoreboard.');
        return;
      }
      setPanelOpen(!st.panelOpen);
    }
  });

  async function init() {
    st.settings = Object.assign({ onVideo: true }, await storageGet(SETTINGS_KEY));
    loadFonts();
    window.addEventListener('yt-navigate-finish', onPage);
    // Fallback for navigations that don't fire the event, and for YouTube re-rendering the sidebar.
    setInterval(() => {
      onPage();
      if (st.panelOpen && panel && !panel.isConnected) mountPanel();
      else if (st.panelOpen) placePanel();
      if (st.panelOpen) placeOverlay();
    }, 1000);
    await onPage();
    requestAnimationFrame(frame);
  }

  init();
})();
