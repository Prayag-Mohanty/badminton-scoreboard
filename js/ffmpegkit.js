/*
 * "ffmpeg kit" export: a ZIP with one transparent PNG per scoreboard state, an
 * ffconcat timeline saying how long each one is shown, and ready-to-run
 * scripts that burn it into the original video with ffmpeg (audio copied).
 *
 * Works in any browser and gives the best quality/speed on a laptop, at the
 * cost of installing ffmpeg once.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FfmpegKit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function canvasToPng(canvas) {
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)), reject) : reject(new Error('PNG encoding failed'))), 'image/png')
    );
  }

  function outputName(videoName) {
    const dot = videoName.lastIndexOf('.');
    const base = dot > 0 ? videoName.slice(0, dot) : videoName;
    return `${base}-scoreboard.mp4`;
  }

  function shellQuote(s) {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  /**
   * opts: { Scoring, Overlay, timeline, overlayOpts, width, height, duration,
   *         videoName, project, onProgress }
   */
  async function build(opts) {
    const { Scoring, Overlay, timeline, overlayOpts, width, height, duration, videoName, project, onProgress, fromYouTube } = opts;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    // Collapse change times into segments with distinct visuals.
    const times = Scoring.changeTimes(timeline).filter((t) => t < duration);
    const segments = [];
    for (const t of times) {
      const st = Scoring.stateAt(timeline, t);
      const key = JSON.stringify(st, (k, v) => (k === 'rallies' ? undefined : v));
      const prev = segments[segments.length - 1];
      if (prev && prev.key === key) continue;
      segments.push({ t, st, key });
    }

    const files = [];
    const lines = ['ffconcat version 1.0'];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      ctx.clearRect(0, 0, width, height);
      Overlay.draw(ctx, timeline.cfg, seg.st, Object.assign({}, overlayOpts, { width, height }));
      const name = `frames/score_${String(i).padStart(4, '0')}.png`;
      files.push({ name, data: await canvasToPng(canvas) });
      const end = i + 1 < segments.length ? segments[i + 1].t : duration;
      lines.push(`file '${name}'`);
      lines.push(`duration ${Math.max(0.001, end - seg.t).toFixed(3)}`);
      if (onProgress) onProgress((i + 1) / segments.length);
    }
    // The concat demuxer ignores the last duration unless the file is repeated.
    if (segments.length) lines.push(`file 'frames/score_${String(segments.length - 1).padStart(4, '0')}.png'`);
    files.push({ name: 'scoreboard.ffconcat', data: lines.join('\n') + '\n' });

    const out = outputName(videoName);
    // The graphics are scaled to the real video size, so the kit still fits if
    // the video isn't exactly the size they were drawn at. ffmpeg 7.1+ does
    // this with scale=rw:rh; older versions only have scale2ref.
    const overlayTail = 'overlay=0:0:eof_action=repeat:format=auto,format=yuv420p[v]';
    const filterOld = `[1:v]format=rgba[sb0];[sb0][0:v]scale2ref=w=iw:h=ih[sb][base];[base][sb]${overlayTail}`;
    const filterNew = `[0:v]split[base][ref];[1:v]format=rgba[sb0];[sb0][ref]scale=rw:rh[sb];[base][sb]${overlayTail}`;
    const ffArgs = (input, output, filter) =>
      `-i ${input} -f concat -safe 0 -i scoreboard.ffconcat -filter_complex "${filter}" -map "[v]" -map 0:a? -c:v libx264 -preset medium -crf 18 -c:a copy -movflags +faststart ${output}`;

    files.push({
      name: 'add-scoreboard.sh',
      executable: true,
      data: [
        '#!/bin/sh',
        '# Burns the scoreboard into your match video.',
        '# Usage: ./add-scoreboard.sh [path/to/video]   (default: the video next to this script)',
        'cd "$(dirname "$0")" || exit 1',
        `IN="\${1:-${videoName.replace(/["$`\\]/g, '\\$&')}}"`,
        'OUT="${IN%.*}-scoreboard.mp4"',
        'command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is not installed. Mac: brew install ffmpeg  |  Linux: sudo apt install ffmpeg"; exit 1; }',
        '[ -f "$IN" ] || { echo "Video not found: $IN  (put it next to this script, or run: sh add-scoreboard.sh path/to/video.mp4)"; exit 1; }',
        'if ffmpeg -hide_banner -filters 2>/dev/null | grep -q scale2ref; then',
        `  ffmpeg ${ffArgs('"$IN"', '"$OUT"', filterOld)}`,
        'else',
        `  ffmpeg ${ffArgs('"$IN"', '"$OUT"', filterNew)}`,
        'fi',
        'echo "Done: $OUT"',
        '',
      ].join('\n'),
    });
    files.push({
      name: 'add-scoreboard.bat',
      data: [
        '@echo off',
        'REM Burns the scoreboard into your match video.',
        'REM Drag the video onto this file, or put the video next to it and double-click.',
        'cd /d "%~dp0"',
        `set "IN=${videoName}"`,
        'if not "%~1"=="" set "IN=%~1"',
        'for %%F in ("%IN%") do set "OUT=%%~dpnF-scoreboard.mp4"',
        'where ffmpeg >nul 2>nul || (echo ffmpeg is not installed. Run: winget install ffmpeg & pause & exit /b 1)',
        'if not exist "%IN%" (echo Video not found: %IN% - put it next to this file or drag it onto this file. & pause & exit /b 1)',
        'ffmpeg -hide_banner -filters 2>nul | findstr /c:"scale2ref" >nul',
        'if errorlevel 1 (',
        `  ffmpeg ${ffArgs('"%IN%"', '"%OUT%"', filterNew)}`,
        ') else (',
        `  ffmpeg ${ffArgs('"%IN%"', '"%OUT%"', filterOld)}`,
        ')',
        'echo Done: %OUT%',
        'pause',
        '',
      ].join('\r\n'),
    });
    files.push({ name: 'project.json', data: JSON.stringify(project, null, 2) });
    files.push({
      name: 'README.txt',
      data: [
        'Badminton Scoreboard – ffmpeg kit',
        '',
        fromYouTube
          ? '1. Put your ORIGINAL match video (the file you uploaded to YouTube) in this folder and rename it to match.mp4 (or drag it onto add-scoreboard.bat). The timings match the YouTube video, so the file must start at the same moment.'
          : `1. Put your video (${videoName}) in this folder, next to these files.`,
        '2. Install ffmpeg once:',
        '     Windows: open PowerShell and run   winget install ffmpeg',
        '     Mac:     brew install ffmpeg      (https://brew.sh)',
        '3. Run the script:',
        '     Windows: double-click add-scoreboard.bat (or drag the video onto it)',
        '     Mac/Linux: open Terminal in this folder and run   sh add-scoreboard.sh',
        '',
        `The result is saved as ${out}. Audio is copied unchanged.`,
        '',
        'Manual command:',
        `  ffmpeg ${ffArgs(shellQuote(videoName), shellQuote(out), filterOld)}`,
        '(ffmpeg 7.1 and newer can use this filter instead:',
        `  ${filterNew} )`,
        '',
        'project.json can be loaded back into the app to continue editing.',
        '',
      ].join('\n'),
    });

    return window.Zip.create(files);
  }

  return { build, outputName };
});
