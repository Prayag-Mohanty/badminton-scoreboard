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
    // __PIX__ becomes nv12 for hardware encoders and yuv420p for the standard one.
    const overlayTail = 'overlay=0:0:eof_action=repeat:format=auto,format=__PIX__[v]';
    const filterOld = `[1:v]format=rgba[sb0];[sb0][0:v]scale2ref=w=iw:h=ih[sb][base];[base][sb]${overlayTail}`;
    const filterNew = `[0:v]split[base][ref];[1:v]format=rgba[sb0];[sb0][ref]scale=rw:rh[sb];[base][sb]${overlayTail}`;
    const inputs = (input) => `-hide_banner -hwaccel auto -i ${input} -f concat -safe 0 -i scoreboard.ffconcat`;
    const outputs = (output) => `-map "[v]" -map 0:a? -c:a copy -movflags +faststart -y ${output}`;
    // Software fallback: 'veryfast' is 2–3x quicker than the default with the same visible quality.
    const x264 = '-c:v libx264 -preset veryfast -crf 20';

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
        `FT='${filterOld}'`,
        `ffmpeg -hide_banner -filters 2>/dev/null | grep -q scale2ref || FT='${filterNew}'`,
        '# Keep about the same bitrate as the original for hardware encoding.',
        'BR=$(ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate -of csv=p=0 "$IN" 2>/dev/null)',
        'case "$BR" in ""|*[!0-9]*) BR=12000000 ;; esac',
        'BR=$((BR * 11 / 10))',
        '# Use the graphics chip if ffmpeg can (much faster): Mac, NVIDIA, Intel, AMD.',
        'ENC=""',
        'for e in h264_videotoolbox h264_nvenc h264_qsv h264_amf; do',
        '  if ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=1280x720:d=0.2 -pix_fmt nv12 -c:v $e -f null - >/dev/null 2>&1; then ENC=$e; break; fi',
        'done',
        'if [ -n "$ENC" ]; then',
        '  echo "Using hardware encoder: $ENC"',
        `  if ffmpeg ${inputs('"$IN"')} -filter_complex "$(printf %s "$FT" | sed s/__PIX__/nv12/)" -c:v $ENC -b:v $BR -maxrate $((BR * 3 / 2)) -bufsize $((BR * 2)) ${outputs('"$OUT"')}; then`,
        '    echo "Done: $OUT"; exit 0',
        '  fi',
        '  echo "Hardware encoding failed; using the standard encoder instead."',
        'fi',
        `ffmpeg ${inputs('"$IN"')} -filter_complex "$(printf %s "$FT" | sed s/__PIX__/yuv420p/)" ${x264} ${outputs('"$OUT"')} || { echo "Something went wrong - see the messages above."; exit 1; }`,
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
        `set "FT=${filterOld}"`,
        'ffmpeg -hide_banner -filters 2>nul | findstr /c:"scale2ref" >nul',
        `if errorlevel 1 set "FT=${filterNew}"`,
        'REM Keep about the same bitrate as the original for hardware encoding.',
        'set "BR="',
        `for /f "delims=" %%B in ('ffprobe -v error -select_streams v:0 -show_entries stream^=bit_rate -of csv^=p^=0 "%IN%" 2^>nul') do set "BR=%%B"`,
        'if not defined BR set "BR=12000000"',
        'echo %BR%| findstr /r "^[0-9][0-9]*$" >nul || set "BR=12000000"',
        'set /a BR=BR/10*11',
        'set /a MAXR=BR*3/2',
        'set /a BUF=BR*2',
        'REM Use the graphics chip if ffmpeg can (much faster): NVIDIA, Intel, AMD.',
        'set "ENC="',
        'for %%E in (h264_nvenc h264_qsv h264_amf) do if not defined ENC ffmpeg -hide_banner -loglevel error -f lavfi -i color=black:s=1280x720:d=0.2 -pix_fmt nv12 -c:v %%E -f null - >nul 2>nul && set "ENC=%%E"',
        'if not defined ENC goto software',
        'echo Using hardware encoder: %ENC%',
        'set "F=%FT:__PIX__=nv12%"',
        `ffmpeg ${inputs('"%IN%"')} -filter_complex "%F%" -c:v %ENC% -b:v %BR% -maxrate %MAXR% -bufsize %BUF% ${outputs('"%OUT%"')}`,
        'if not errorlevel 1 goto done',
        'echo Hardware encoding failed - using the standard encoder instead.',
        ':software',
        'set "F=%FT:__PIX__=yuv420p%"',
        `ffmpeg ${inputs('"%IN%"')} -filter_complex "%F%" ${x264} ${outputs('"%OUT%"')}`,
        'if errorlevel 1 (echo Something went wrong - see the messages above. & pause & exit /b 1)',
        ':done',
        'echo Done: %OUT%',
        'pause',
        '',
      ].join('\r\n'),
    });
    const filterManual = filterOld.replace('__PIX__', 'yuv420p');
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
        `  ffmpeg ${inputs(shellQuote(videoName))} -filter_complex "${filterManual}" ${x264} ${outputs(shellQuote(out))}`,
        '(ffmpeg 7.1 and newer can use this filter instead:',
        `  ${filterNew.replace('__PIX__', 'yuv420p')} )`,
        '',
        'project.json can be loaded back into the app to continue editing.',
        '',
      ].join('\n'),
    });

    return window.Zip.create(files);
  }

  return { build, outputName };
});
