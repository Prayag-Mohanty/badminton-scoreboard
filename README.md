# 🏸 Badminton Scoreboard

Add a **BWF-style live scoreboard** (top-left corner) to your badminton match recordings, so viewers always know the score.

- Choose your match video. Files over 1 GB are fine, because **the video never leaves your computer**. Everything runs in the browser.
- Answer a few questions: singles / doubles / 3 vs 3, men's / women's / mixed, 21, 15 or 11 points, best of 1/3/5, deuce and cap, who serves first, player names, and an optional event title.
- Watch the video and press **A** (or ←) / **L** (or →) when each rally ends. The app applies the scoring rules for you: deuce, 30-point cap, game and match points, serve indicator, games won, and ends of games.
- Export the same video with the scoreboard burned in, plus a ready-made **YouTube description with the result and chapters** for each game.

## What the scoreboard shows

```
┌───────────────────────────────────────────┐
│ HYDERABAD OPEN · FINAL · MEN'S SINGLES · GAME 3
├───┬────────────────────┬────┬────┬────┐
│ 🏸│ MOHANTY            │ 21 │ 19 │ 20 │  [MATCH POINT]
│   │ REDDY              │ 18 │ 21 │ 17 │
└───┴────────────────────┴────┴────┴────┘
```

- The shuttle icon marks the side serving (in rally scoring, the side that won the last rally).
- Columns show finished games; the white box is the current game.
- GAME POINT and MATCH POINT tags appear automatically. When a game ends, its final score stays up for 20 s (adjustable), then the board resets to 0–0.
- Three colour themes, adjustable size, top-left or top-right.

## How to use it

1. Open the app (see *Running it* below) in **Chrome or Edge** on a laptop/desktop.
2. **Setup**: choose the video and fill in the match details. Use *"Recording started mid-match?"* if you began filming after game 1.
3. **Score the match**: play the video. Press the button or key for the side that won each rally **when the rally ends**. The score changes at that moment in the video.
   - `A`/`←` point to side 1 · `L`/`→` point to side 2 · `Z`/`Backspace` undo
   - `Space` play/pause · `J`/`K` −5 s / +5 s (`Shift` = 30 s) · `,`/`.` frame step · `[`/`]` speed
   - Play at 2× between rallies; a 20-minute match takes about 10 minutes to score.
   - Click any rally in the list to jump to it. ✕ deletes a wrong point. Your work **auto-saves** in the browser, so you can close the tab and continue later. You can also save a project file.
4. **Export**:
   - **Create video** in the browser. Uses hardware video encoding where available, keeps the original resolution and frame rate, copies the audio unchanged and writes straight to disk. A 15-min 1080p video usually takes 5–15 minutes.
   - **ffmpeg kit**: a small ZIP with the scoreboard graphics and a double-click script (`.bat` for Windows, `.sh` for Mac/Linux) that burns them in with [ffmpeg](https://ffmpeg.org). This is the fastest option and works in any browser and with any video format.
   - Copy the generated **YouTube description** (result + chapters).

## Running it

It's a static website with no build step and no server-side code.

- **GitHub Pages** (easiest, works from any device): in the repository go to *Settings → Pages*, choose *Deploy from a branch*, select the branch and `/ (root)`. The app will be at `https://<user>.github.io/badminton-scoreboard/`.
- **Locally**: `npm start` and open http://localhost:8080. (Opening `index.html` directly from disk also works for scoring and the ffmpeg kit.)

## Browser support

| | Scoring | Create video in browser | ffmpeg kit |
|---|---|---|---|
| Chrome / Edge (desktop) | ✅ | ✅ H.264 MP4, saved straight to disk | ✅ |
| Safari (Mac) | ✅ | ✅ (memory-hungry for very large files) | ✅ |
| Firefox | ✅ | ⚠️ only if the browser can decode the video's codec | ✅ |

iPhone videos recorded in HEVC ("High Efficiency") need a browser that can play HEVC: Safari, or Chrome/Edge on most recent computers. If yours can't, use the ffmpeg kit, or set *Settings → Camera → Formats → Most Compatible* on the phone.

## Development

```
npm test        # scoring engine tests (node --test)
npm start       # serve locally
```

- `js/scoring.js`: rally-point scoring engine (pure, unit-tested)
- `js/overlay.js`: draws the scoreboard on a canvas (used by the preview and both exports)
- `js/exporter.js`: WebCodecs pipeline: mp4box.js demux → decode → draw → encode → mp4-muxer
- `js/ffmpegkit.js`, `js/zip.js`: ffmpeg kit export
- `js/app.js`, `index.html`, `css/style.css`: the UI
- `vendor/`: [mp4box.js](https://github.com/gpac/mp4box.js) 0.5.2 (BSD-3) and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2 (MIT)
