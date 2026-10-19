/* global Scoring, Overlay, Exporter, FfmpegKit, YouTube */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const STORAGE_PREFIX = 'badminton-scoreboard:v1:';

  const app = {
    source: null, // 'file' | 'youtube'
    file: null,
    youtube: null, // YouTube player wrapper (see js/youtube.js) when scoring from a link
    videoUrl: null,
    video: { width: 0, height: 0, duration: 0 },
    config: null, // raw config from the form
    look: null,
    events: [], // { id, t, w }
    nextId: 1,
    timeline: null,
    pendingProject: null, // project file loaded before the video was chosen
    started: false, // autosave only once scoring has begun (so a fresh form never overwrites a saved session)
    exporting: null, // AbortController while an export runs
  };

  // ---------------------------------------------------------------- utils

  function storageKey() {
    if (app.source === 'youtube') return `${STORAGE_PREFIX}yt:${app.youtube.id}`;
    return app.file ? `${STORAGE_PREFIX}${app.file.name}:${app.file.size}` : null;
  }

  // The local <video> element, behind the same small interface as the YouTube player.
  const videoEl = $('#video');
  const filePlayer = {
    getTime: () => videoEl.currentTime,
    seek: (t) => (videoEl.currentTime = Math.max(0, Math.min(videoEl.duration || 0, t))),
    play: () => videoEl.play(),
    pause: () => videoEl.pause(),
    isPaused: () => videoEl.paused,
    setRate: (r) => (videoEl.playbackRate = r),
    duration: () => videoEl.duration || 0,
    maxRate: () => 3,
  };

  function player() {
    return app.source === 'youtube' ? app.youtube : filePlayer;
  }

  function safeStorage(fn) {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  }

  function formatBytes(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
    return Math.round(n / 1e3) + ' KB';
  }

  function teamLabel(side) {
    const team = app.config && app.config.teams[side];
    const name = team ? Scoring.teamName(team) : '';
    return name && name !== '—' ? name : `Side ${side + 1}`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function baseName() {
    const n = app.source === 'file' && app.file ? app.file.name : 'match.mp4';
    const dot = n.lastIndexOf('.');
    return dot > 0 ? n.slice(0, dot) : n;
  }

  function parseScore(text) {
    const m = String(text || '').match(/(\d+)\s*[-–:\/ ]\s*(\d+)/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
  }

  // ---------------------------------------------------------------- screens

  function show(screen) {
    for (const s of ['setup', 'score', 'export']) $(`#screen-${s}`).hidden = s !== screen;
    $$('.step').forEach((el) => el.classList.toggle('active', el.dataset.step === screen));
    if (screen !== 'score' && app.source && !player().isPaused()) player().pause();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- setup form

  const form = $('#setup-form');

  function readForm() {
    const fd = new FormData(form);
    const format = fd.get('format');
    const count = format === 'singles' ? 1 : format === 'doubles' ? 2 : 3;
    const teams = [0, 1].map((side) => ({
      players: [0, 1, 2].slice(0, count).map((i) => String(fd.get(`p${side}_${i}`) || '').trim()),
    }));
    const priorGames = [fd.get('prior0'), fd.get('prior1')].map(parseScore).filter(Boolean);
    const config = {
      format,
      category: fd.get('category'),
      title: String(fd.get('title') || '').trim(),
      teams,
      pointsToWin: fd.get('pointsToWin'),
      winBy: fd.get('winBy'),
      cap: fd.get('cap'),
      bestOf: fd.get('bestOf'),
      firstServer: fd.get('firstServer'),
      priorGames,
      startScore: parseScore(fd.get('startScore')) || [0, 0],
      gameEndHold: fd.get('gameEndHold'),
      preset: fd.get('preset'),
    };
    const look = {
      theme: fd.get('theme'),
      scale: parseFloat(fd.get('scale')) || 1,
      position: fd.get('position'),
      showHeader: fd.get('showHeader') === 'on',
    };
    return { config, look };
  }

  function setRadio(name, value) {
    const el = form.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  }

  function writeForm(config, look) {
    const c = config || {};
    setRadio('format', c.format || 'singles');
    setRadio('category', c.category || 'M');
    setRadio('bestOf', String(c.bestOf || 3));
    setRadio('firstServer', String(c.firstServer || 0));
    setRadio('preset', c.preset || 'custom');
    form.elements.title.value = c.title || '';
    form.elements.pointsToWin.value = c.pointsToWin || 21;
    form.elements.winBy.value = String(c.winBy || 2);
    form.elements.cap.value = c.cap != null ? c.cap : 30;
    form.elements.gameEndHold.value = c.gameEndHold != null ? c.gameEndHold : 20;
    for (const side of [0, 1]) {
      for (const i of [0, 1, 2]) {
        form.elements[`p${side}_${i}`].value = (c.teams && c.teams[side] && c.teams[side].players[i]) || '';
      }
    }
    const pg = c.priorGames || [];
    form.elements.prior0.value = pg[0] ? pg[0].join('-') : '';
    form.elements.prior1.value = pg[1] ? pg[1].join('-') : '';
    const ss = c.startScore || [0, 0];
    form.elements.startScore.value = ss[0] || ss[1] ? ss.join('-') : '';
    if (look) {
      form.elements.theme.value = look.theme || 'bwf';
      form.elements.scale.value = look.scale || 1;
      form.elements.position.value = look.position || 'tl';
      form.elements.showHeader.checked = look.showHeader !== false;
    }
    onFormChange();
  }

  function onFormChange(e) {
    // Preset → rules
    if (e && e.target.name === 'preset' && e.target.value !== 'custom') {
      const p = Scoring.PRESETS[e.target.value];
      form.elements.pointsToWin.value = p.pointsToWin;
      form.elements.winBy.value = String(p.winBy);
      form.elements.cap.value = p.cap;
    }
    if (e && ['pointsToWin', 'winBy', 'cap'].includes(e.target.name)) setRadio('preset', 'custom');

    const format = new FormData(form).get('format');
    $$('[data-min="doubles"]').forEach((el) => (el.hidden = format === 'singles'));
    $$('[data-min="3v3"]').forEach((el) => (el.hidden = format !== '3v3'));
    const mixed = form.querySelector('[data-only="team"]');
    mixed.hidden = format === 'singles';
    if (format === 'singles' && form.querySelector('input[name="category"][value="X"]').checked) setRadio('category', 'M');
    $$('[name="p0_0"], [name="p1_0"]').forEach((el) => (el.placeholder = format === 'singles' ? 'Player name' : 'Player 1'));

    const { config, look } = readForm();
    app.config = config;
    app.look = look;
    $('#serve-label-0').textContent = teamLabel(0);
    $('#serve-label-1').textContent = teamLabel(1);
    drawSetupPreview();
    if (app.events.length) rebuild();
    persist();
  }

  function drawSetupPreview() {
    const canvas = $('#setup-preview');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cfg = Scoring.normalizeConfig(app.config);
    if (!app.config.teams[0].players.some(Boolean)) cfg.teams[0] = { players: cfg.format === 'singles' ? ['Your name'] : ['Your name', 'Partner'] };
    if (!app.config.teams[1].players.some(Boolean)) cfg.teams[1] = { players: cfg.format === 'singles' ? ['Opponent'] : ['Opponent 1', 'Opponent 2'] };
    const sample = {
      games: cfg.bestOf > 1 ? [{ score: [cfg.pointsToWin, cfg.pointsToWin - 4], winner: 0 }] : [],
      score: [cfg.pointsToWin - 1, cfg.pointsToWin - 4],
      server: 0,
      gameNo: cfg.bestOf > 1 ? 2 : 1,
      status: cfg.bestOf > 1 && cfg.bestOf <= 3 ? 'MATCH POINT' : 'GAME POINT',
      statusSide: 0,
      matchWinner: null,
    };
    Overlay.draw(ctx, cfg, sample, Object.assign({}, app.look, { width: canvas.width, height: 720 }));
  }

  form.addEventListener('input', onFormChange);
  form.addEventListener('change', onFormChange);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!app.source) return;
    startScoring();
  });

  // ---------------------------------------------------------------- choosing the video

  const dropzone = $('#dropzone');
  $('#file-input').addEventListener('change', (e) => e.target.files[0] && chooseFile(e.target.files[0]));
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) chooseFile(f);
  });

  function resetSource() {
    if (app.youtube) app.youtube.destroy();
    app.youtube = null;
    // The YouTube API replaces the placeholder with an iframe; put a fresh one back.
    $('#yt-wrap').replaceChildren(Object.assign(document.createElement('div'), { id: 'yt-player' }));
    app.events = [];
    app.nextId = 1;
    app.started = false;
    $('#resume-box').hidden = true;
  }

  function useSourceUi(kind) {
    $('#video').hidden = kind !== 'file';
    $('#yt-wrap').hidden = kind !== 'youtube';
    $('#yt-catcher').hidden = kind !== 'youtube';
    $('#speed-3').hidden = kind === 'youtube'; // YouTube plays at most 2×
    $('.dz-empty').hidden = true;
    $('.dz-file').hidden = false;
  }

  function chooseFile(file) {
    resetSource();
    app.source = 'file';
    useSourceUi('file');
    app.file = file;
    if (app.videoUrl) URL.revokeObjectURL(app.videoUrl);
    app.videoUrl = URL.createObjectURL(file);
    $('#file-name').textContent = file.name;
    $('#file-meta').textContent = `${formatBytes(file.size)} · reading…`;
    $('#start-btn').disabled = true;
    $('#start-hint').textContent = 'Loading video…';

    const video = $('#video');
    video.src = app.videoUrl;
    video.onloadedmetadata = () => {
      app.video = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
      $('#file-meta').textContent = `${formatBytes(file.size)} · ${video.videoWidth}×${video.videoHeight} · ${Scoring.formatTime(video.duration)}`;
      $('#start-btn').disabled = false;
      $('#start-hint').textContent = '';
      offerResume();
    };
    video.onerror = () => {
      $('#file-meta').textContent = `${formatBytes(file.size)} · this browser can't play this video`;
      $('#start-hint').textContent =
        "Your browser can't play this file. iPhone HEVC videos play in Safari and in Chrome/Edge on most computers; or set the iPhone camera to 'Most Compatible'.";
    };
  }

  async function chooseYouTube(input) {
    const id = YouTube.parseId(input);
    const status = $('#file-meta');
    if (!id) {
      alert("That doesn't look like a YouTube video link. Copy it from the Share button on YouTube.");
      return false;
    }
    resetSource();
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    app.file = null;
    app.source = 'youtube';
    useSourceUi('youtube');
    $('#file-name').textContent = 'YouTube video';
    status.textContent = 'Loading from YouTube…';
    $('#start-btn').disabled = true;
    $('#start-hint').textContent = 'Loading video…';
    try {
      app.youtube = await YouTube.createPlayer($('#yt-player'), id);
    } catch (e) {
      app.source = null;
      $('#file-name').textContent = 'YouTube video';
      status.textContent = e.message;
      $('#start-hint').textContent = e.message;
      return false;
    }
    const d = app.youtube.duration();
    app.video = { width: 1920, height: 1080, duration: d };
    $('#file-name').textContent = app.youtube.title;
    status.textContent = `YouTube · ${Scoring.formatTime(d)}`;
    $('#start-btn').disabled = false;
    $('#start-hint').textContent = '';
    offerResume();
    return true;
  }

  $('#yt-load').addEventListener('click', () => chooseYouTube($('#yt-url').value));
  $('#yt-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      chooseYouTube(e.target.value);
    }
  });

  function offerResume() {
    const box = $('#resume-box');
    box.hidden = true;
    if (app.pendingProject) {
      loadProject(app.pendingProject);
      app.pendingProject = null;
      return;
    }
    const saved = safeStorage(() => JSON.parse(localStorage.getItem(storageKey()) || 'null'));
    if (!saved || !saved.events || !saved.events.length) return;
    box.hidden = false;
    box.innerHTML = '';
    const p = document.createElement('div');
    p.innerHTML = `<b>Welcome back!</b> You already scored <b>${saved.events.length} rallies</b> in this video.`;
    const resume = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Continue where I left off' });
    const fresh = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Start over' });
    resume.type = fresh.type = 'button';
    resume.onclick = () => {
      box.hidden = true;
      loadProject(saved);
      startScoring();
    };
    fresh.onclick = () => {
      box.hidden = true;
      safeStorage(() => localStorage.removeItem(storageKey()));
    };
    box.append(p, resume, fresh);
  }

  // ---------------------------------------------------------------- project save / load

  function projectData() {
    return {
      app: 'badminton-scoreboard',
      version: 1,
      savedAt: new Date().toISOString(),
      video:
        app.source === 'youtube'
          ? { youtube: app.youtube.id, title: app.youtube.title, duration: app.video.duration }
          : app.file
            ? { name: app.file.name, size: app.file.size, duration: app.video.duration }
            : null,
      config: app.config,
      look: app.look,
      events: app.events.map((e) => ({ t: Math.round(e.t * 1000) / 1000, w: e.w })),
    };
  }

  function persist() {
    const key = storageKey();
    if (!key || !app.config || !app.started) return;
    safeStorage(() => localStorage.setItem(key, JSON.stringify(projectData())));
  }

  function loadProject(p) {
    if (!p || !p.config) return;
    writeForm(p.config, p.look);
    app.events = (p.events || []).map((e, i) => ({ id: i + 1, t: Number(e.t) || 0, w: e.w === 1 ? 1 : 0 }));
    app.nextId = app.events.length + 1;
    rebuild();
  }

  $('#project-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (p.app !== 'badminton-scoreboard') throw new Error('not a project file');
      if (app.source) {
        loadProject(p);
        const made = p.video && (p.video.name || p.video.title);
        const current = app.source === 'youtube' ? app.youtube.title : app.file.name;
        if (made && made !== current) alert(`Loaded. Note: this project was made for "${made}", but the current video is "${current}".`);
      } else if (p.video && p.video.youtube) {
        // Scored on YouTube: reopen that video automatically.
        app.pendingProject = p;
        writeForm(p.config, p.look);
        $('#yt-url').value = `https://youtu.be/${p.video.youtube}`;
        chooseYouTube(p.video.youtube);
      } else {
        app.pendingProject = p;
        writeForm(p.config, p.look);
        alert(`Project loaded (${(p.events || []).length} rallies). Now choose the video${p.video && p.video.name ? ` "${p.video.name}"` : ''}.`);
      }
    } catch (err) {
      alert("That file couldn't be loaded as a scoreboard project.");
    }
    e.target.value = '';
  });

  $('#save-project').addEventListener('click', () => {
    download(new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' }), `${baseName()}-scoreboard.json`);
  });

  // ---------------------------------------------------------------- scoring screen

  const overlay = $('#overlay');
  const octx = overlay.getContext('2d');
  let lastDrawKey = '';

  function startScoring() {
    app.started = true;
    $('#resume-box').hidden = true;
    onFormChange();
    overlay.width = app.video.width;
    overlay.height = app.video.height;
    $('#stage').style.aspectRatio = `${app.video.width} / ${app.video.height}`;
    const speed = $('#speed');
    if (parseFloat(speed.value) > player().maxRate()) {
      speed.value = '1';
      player().setRate(1);
    }
    $('#point0-name').textContent = teamLabel(0);
    $('#point1-name').textContent = teamLabel(1);
    rebuild();
    show('score');
    lastDrawKey = '';
  }

  function rebuild() {
    app.timeline = Scoring.buildTimeline(app.config, app.events);
    lastDrawKey = '';
    renderRallyList();
    renderSummary($('#match-summary'), false);
    persist();
  }

  function overlayOpts(width, height) {
    return Object.assign({}, app.look, { width, height });
  }

  function renderLoop() {
    requestAnimationFrame(renderLoop);
    if ($('#screen-score').hidden || !app.timeline) return;
    const t = player().getTime();
    const st = Scoring.stateAt(app.timeline, t);
    const key = JSON.stringify(st) + JSON.stringify(app.look);
    if (key !== lastDrawKey) {
      lastDrawKey = key;
      octx.clearRect(0, 0, overlay.width, overlay.height);
      Overlay.draw(octx, app.timeline.cfg, st, overlayOpts(overlay.width, overlay.height));
      highlightCurrentRally(st.rallies - 1);
    }
    updateTransport();
  }

  function updateTransport() {
    const p = player();
    const d = p.duration();
    const t = p.getTime();
    const seek = $('#seek');
    if (!seek.matches(':active')) seek.value = d ? Math.round((t / d) * 1000) : 0;
    const withHours = d >= 3600;
    $('#time').textContent = `${Scoring.formatTime(t, withHours)} / ${Scoring.formatTime(d, withHours)}`;
    $('#play').textContent = p.isPaused() ? '▶' : '❚❚';
  }

  function togglePlay() {
    const p = player();
    if (p.isPaused()) p.play();
    else p.pause();
  }

  function seekBy(dt) {
    player().seek(player().getTime() + dt);
  }

  let flashTimer = null;
  function flash(text) {
    const el = $('#flash');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), 1200);
  }

  function addPoint(w) {
    const t = player().getTime();
    const before = Scoring.stateAt(app.timeline, t);
    if (before.matchWinner !== null && before.rallies === app.timeline.steps.length) {
      flash('The match is already over. Undo or delete points to change it.');
      return;
    }
    app.events.push({ id: app.nextId++, t, w });
    rebuild();
    const st = Scoring.stateAt(app.timeline, t);
    const btn = $(`#point${w}`);
    btn.classList.add('hit');
    setTimeout(() => btn.classList.remove('hit'), 150);
    let msg = `${teamLabel(w)}  ${st.score[0]}–${st.score[1]}`;
    if (st.status === 'GAME' || st.status === 'MATCH') msg = `${st.status} ${teamLabel(w)}  ${st.score[0]}–${st.score[1]}`;
    else if (st.status) msg += ` · ${st.status}`;
    flash(msg);
  }

  function undo() {
    if (!app.events.length) return;
    let idx = 0;
    app.events.forEach((e, i) => {
      if (e.id > app.events[idx].id) idx = i;
    });
    const [removed] = app.events.splice(idx, 1);
    rebuild();
    flash(`Undone: point to ${teamLabel(removed.w)} at ${Scoring.formatTime(removed.t)}`);
  }

  function renderRallyList() {
    const list = $('#rally-list');
    const steps = app.timeline.steps;
    $('#rally-count').textContent = String(steps.length);
    // Match each step back to its event (same order as the sorted events).
    const sortedEvents = app.events.slice().sort((a, b) => a.t - b.t || a.id - b.id);
    const frag = document.createDocumentFragment();
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      const ev = sortedEvents[i];
      const li = document.createElement('li');
      li.dataset.index = String(i);
      if (step.ignored) li.classList.add('ignored');
      const s = step.state;
      let scoreText;
      let endTag = '';
      if (s.gameJustEnded) {
        const g = s.games[s.games.length - 1];
        scoreText = `${g.score[0]}–${g.score[1]}`;
        endTag = s.matchWinner !== null ? 'MATCH' : 'GAME';
      } else scoreText = `${s.score[0]}–${s.score[1]}`;
      li.innerHTML = `<span class="n">${i + 1}</span><span class="mono"></span><span><span class="who${step.w}"></span> <span class="sc"></span>${endTag ? `<span class="game-end">${endTag}</span>` : ''}</span><button title="Delete this point" aria-label="Delete">✕</button>`;
      li.children[1].textContent = Scoring.formatTime(step.t);
      li.querySelector(`.who${step.w}`).textContent = teamLabel(step.w);
      li.querySelector('.sc').textContent = step.ignored ? '(after match end)' : scoreText;
      li.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
          app.events = app.events.filter((x) => x.id !== ev.id);
          rebuild();
          return;
        }
        player().seek(step.t - 3);
      });
      frag.appendChild(li);
    }
    list.replaceChildren(frag);
  }

  function highlightCurrentRally(index) {
    $$('#rally-list li.current').forEach((li) => li.classList.remove('current'));
    if (index < 0) return;
    const li = $(`#rally-list li[data-index="${index}"]`);
    if (li) li.classList.add('current');
  }

  function renderSummary(el, big) {
    if (!app.timeline) return;
    const steps = app.timeline.steps;
    const s = steps.length ? steps[steps.length - 1].state : app.timeline.initial;
    const cols = s.games.map((g) => g);
    const showCurrent = s.matchWinner === null;
    const table = document.createElement('table');
    for (const side of [0, 1]) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = teamLabel(side) + (s.matchWinner === side ? ' 🏆' : '');
      tr.appendChild(name);
      for (const g of cols) {
        const td = document.createElement('td');
        td.textContent = String(g.score[side]);
        if (g.winner === side) td.className = 'win';
        tr.appendChild(td);
      }
      if (showCurrent) {
        const td = document.createElement('td');
        td.textContent = String(s.score[side]);
        td.style.opacity = '0.75';
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    el.replaceChildren(table);
    const note = document.createElement('div');
    note.className = 'status';
    if (s.matchWinner !== null) note.textContent = `${teamLabel(s.matchWinner)} won the match`;
    else if (!steps.length) note.textContent = big ? 'No points scored yet.' : '';
    else note.textContent = `Game ${s.games.length + 1} in progress`;
    if (note.textContent) el.appendChild(note);
  }

  // transport
  $('#play').addEventListener('click', togglePlay);
  $('#back5').addEventListener('click', () => seekBy(-5));
  $('#fwd5').addEventListener('click', () => seekBy(5));
  $('#seek').addEventListener('input', (e) => player().seek((e.target.value / 1000) * player().duration()));
  $('#speed').addEventListener('change', (e) => player().setRate(parseFloat(e.target.value)));
  $('#point0').addEventListener('click', () => addPoint(0));
  $('#point1').addEventListener('click', () => addPoint(1));
  $('#undo').addEventListener('click', undo);
  $('#back-setup').addEventListener('click', () => show('setup'));
  $('#to-export').addEventListener('click', openExport);
  $('#stage').addEventListener('click', togglePlay);

  function changeSpeed(dir) {
    const sel = $('#speed');
    const max = player().maxRate();
    let i = sel.selectedIndex;
    do i += dir;
    while (i >= 0 && i < sel.options.length && parseFloat(sel.options[i].value) > max);
    if (i < 0 || i >= sel.options.length) return;
    sel.selectedIndex = i;
    player().setRate(parseFloat(sel.value));
    flash(`Speed ${sel.value}×`);
  }

  document.addEventListener('keydown', (e) => {
    if ($('#screen-score').hidden) return;
    if (e.target.closest('input, select, textarea') && e.target.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') addPoint(0);
    else if (k === 'l' || k === 'L' || k === 'ArrowRight') addPoint(1);
    else if (k === 'z' || k === 'Z' || k === 'Backspace') undo();
    else if (k === ' ' || k === 'Spacebar') togglePlay();
    else if (k === 'j' || k === 'J') seekBy(e.shiftKey ? -30 : -5);
    else if (k === 'k' || k === 'K') seekBy(e.shiftKey ? 30 : 5);
    else if (k === ',' || k === '.') {
      player().pause();
      seekBy(k === ',' ? -1 / 30 : 1 / 30);
    } else if (k === '[') changeSpeed(-1);
    else if (k === ']') changeSpeed(1);
    else handled = false;
    if (handled) {
      e.preventDefault();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
  });

  // ---------------------------------------------------------------- export screen

  function openExport() {
    rebuild();
    show('export');
    renderSummary($('#export-summary'), true);
    $('#yt-text').value = Scoring.youtubeSummary(app.timeline, app.video.duration);
    const yt = app.source === 'youtube';
    $('#yt-orig-note').hidden = !yt;
    $('#kit-shape-field').hidden = !yt;
    $('#browser-blurb').hidden = yt;
    $('#export-browser').textContent = yt ? 'Choose original file & create video' : 'Create video';
    $('#out-name').textContent = FfmpegKit.outputName(baseName() + '.mp4');
    const canBrowser = Exporter.isSupported() && (yt || /\.(mp4|m4v|mov)$/i.test(app.file.name));
    $('#browser-unsupported').hidden = canBrowser;
    $('#export-browser').disabled = !canBrowser;
  }

  $('#back-score').addEventListener('click', () => {
    if (app.exporting) return;
    show('score');
  });

  $('#copy-yt').addEventListener('click', async () => {
    const ta = $('#yt-text');
    try {
      await navigator.clipboard.writeText(ta.value);
    } catch (e) {
      ta.select();
      document.execCommand('copy');
    }
    $('#copy-yt').textContent = 'Copied ✓';
    setTimeout(() => ($('#copy-yt').textContent = 'Copy description'), 1500);
  });

  async function loadFonts() {
    if (!document.fonts) return;
    const weights = [500, 600, 700, 800];
    await Promise.all(weights.map((w) => document.fonts.load(`${w} 32px "Barlow Condensed"`).catch(() => null)));
  }

  function formatEta(sec) {
    if (!isFinite(sec)) return '';
    if (sec < 60) return `${Math.round(sec)} s left`;
    return `${Math.round(sec / 60)} min left`;
  }

  $('#export-browser').addEventListener('click', () => {
    if (app.source === 'youtube') $('#orig-input').click();
    else exportInBrowser(app.file);
  });

  $('#orig-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/\.(mp4|m4v|mov)$/i.test(f.name)) {
      alert('Please choose an MP4 or MOV file, or use the ffmpeg kit for other formats.');
      return;
    }
    exportInBrowser(f);
  });

  async function exportInBrowser(file) {
    const outName = FfmpegKit.outputName(file.name);
    let writable = null;
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: outName,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        });
        writable = await handle.createWritable();
      } catch (e) {
        if (e.name === 'AbortError') return;
        writable = null; // fall back to a download
      }
    }

    await loadFonts();
    const controller = new AbortController();
    app.exporting = controller;
    let wakeLock = null;
    try {
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      /* not critical */
    }
    $('#export-browser').disabled = true;
    $('#export-kit').disabled = true;
    $('#export-progress').hidden = false;
    $('#export-result').hidden = true;
    $('#progress-fill').style.width = '0%';
    $('#progress-text').textContent = 'Reading video…';

    const quality = $('#quality').value;
    const bitrate = quality === 'high' ? 12e6 : quality === 'small' ? 6e6 : undefined;
    const timeline = app.timeline;
    const look = app.look;
    // Cache the last drawn state: consecutive frames almost always share it.
    let cacheKey = '';
    let cacheCanvas = null;

    try {
      const result = await Exporter.exportVideo({
        file,
        writable,
        bitrate,
        signal: controller.signal,
        drawOverlay: (ctx, t, w, h) => {
          const st = Scoring.stateAt(timeline, t);
          const key = JSON.stringify(st, (k, v) => (k === 'rallies' ? undefined : v));
          if (key !== cacheKey || !cacheCanvas || cacheCanvas.width !== w) {
            cacheKey = key;
            cacheCanvas = cacheCanvas && cacheCanvas.width === w ? cacheCanvas : Object.assign(document.createElement('canvas'), { width: w, height: Math.ceil(h / 3) });
            const c = cacheCanvas.getContext('2d');
            c.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
            Overlay.draw(c, timeline.cfg, st, Object.assign({}, look, { width: w, height: h }));
          }
          ctx.drawImage(cacheCanvas, 0, 0);
        },
        onProgress: (p) => {
          $('#progress-fill').style.width = `${(p.fraction * 100).toFixed(1)}%`;
          $('#progress-text').textContent =
            p.fraction >= 1 ? 'Finishing…' : `${Math.floor(p.fraction * 100)}% · ${p.fps.toFixed(0)} frames/s · ${formatEta(p.etaSeconds)}`;
        },
      });
      const res = $('#export-result');
      res.hidden = false;
      res.className = 'notice ok';
      if (result.blob) {
        download(result.blob, outName);
        res.textContent = `Done! ${outName} (${formatBytes(result.blob.size)}) is downloading.`;
      } else {
        res.textContent = `Done! Saved ${outName}.`;
      }
      if (result.warnings.length) res.textContent += ' ' + result.warnings.join(' ');
    } catch (e) {
      const res = $('#export-result');
      res.hidden = false;
      res.className = 'notice warn';
      res.textContent = e.name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${e.message}. The ffmpeg kit works with any video.`;
      if (writable) {
        try {
          await writable.abort();
        } catch (err) {
          /* already closed */
        }
      }
      console.error(e);
    } finally {
      app.exporting = null;
      if (wakeLock) wakeLock.release().catch(() => null);
      $('#export-browser').disabled = false;
      $('#export-kit').disabled = false;
      $('#export-progress').hidden = true;
    }
  }

  $('#export-cancel').addEventListener('click', () => app.exporting && app.exporting.abort());

  $('#export-kit').addEventListener('click', async () => {
    const btn = $('#export-kit');
    btn.disabled = true;
    try {
      await loadFonts();
      // From YouTube we don't know the original file's size, only its shape; the
      // kit's script scales the graphics to the real video anyway.
      const portrait = app.source === 'youtube' && $('#kit-shape').value === 'portrait';
      const size = app.source === 'youtube' ? (portrait ? [1080, 1920] : [1920, 1080]) : [app.video.width, app.video.height];
      const zip = await FfmpegKit.build({
        Scoring,
        Overlay,
        timeline: app.timeline,
        overlayOpts: app.look,
        width: size[0],
        height: size[1],
        duration: app.video.duration,
        videoName: app.source === 'youtube' ? 'match.mp4' : app.file.name,
        fromYouTube: app.source === 'youtube',
        project: projectData(),
        onProgress: (f) => ($('#kit-progress').textContent = `Drawing scoreboards… ${Math.round(f * 100)}%`),
      });
      download(zip, `${baseName()}-scoreboard-kit.zip`);
      $('#kit-progress').textContent = 'Downloaded. Unzip it next to your video and follow README.txt.';
    } catch (e) {
      $('#kit-progress').textContent = `Couldn't build the kit: ${e.message}`;
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (app.exporting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------------------------------------------------------------- init

  writeForm(Object.assign({}, Scoring.DEFAULT_CONFIG, { teams: [{ players: [] }, { players: [] }], preset: '21' }), {
    theme: 'bwf',
    scale: 1,
    position: 'tl',
    showHeader: true,
  });
  show('setup');
  loadFonts().then(drawSetupPreview);
  requestAnimationFrame(renderLoop);
})();
