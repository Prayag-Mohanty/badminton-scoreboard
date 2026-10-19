# 🏸 Badminton Scoreboard for YouTube (browser extension)

Shows a BWF-style live scoreboard **next to** a badminton match on YouTube, and optionally **on top of the video** (it works in full screen too). You score the match while you watch; the scoreboard then follows the video wherever you seek.

Works in Chrome, Edge, Brave and other Chromium browsers on a computer.

## Install (developer mode, about 1 minute)

1. Download this branch: on GitHub, switch to the `claude/youtube-scoreboard-extension` branch → **Code → Download ZIP**, and unzip it.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder (the one containing `manifest.json`).
4. Pin the 🏸 icon to the toolbar.

## Use it

1. Open a match on YouTube and click the toolbar icon. The panel appears above the recommended videos (below the video in theatre mode).
2. **Setup (⚙):** singles/doubles/3 vs 3, category, names, 21/15/11 points, best of 1/3/5, who serves first, title, colours, and the score at the start of the video if you joined mid-match.
3. **Scoring mode:** press **↑** when the far player (facing the camera) wins a rally and **↓** when the near player (back to the camera) wins it, or click the buttons. **U** undoes; **Q** / **P** score side 1 / side 2 by name. Press when the rally ends; the score changes at that moment of the video.
   - Setup asks who is near the camera when the video starts. The buttons follow the players when they change ends (after each game, and at 11 in the deciding game).
   - In scoring mode ↑/↓ score points instead of changing YouTube's volume. YouTube's other shortcuts (J/K/L, ←/→, space) still work, and typing in YouTube's search box is ignored.
4. Click a rally in the list to jump to it; ✕ deletes a wrong point.
5. Turn off scoring mode to just watch with the scoreboard. **Show on the video** puts it in the top-left corner of the player.

Everything is saved per video in your browser. When you open a video you've scored before, its scoreboard appears automatically; other videos are left alone until you click the icon.

**⋯ menu:**
- **Copy YouTube description:** the result plus chapter timestamps for each game, to paste into the video's description.
- **Save / load project file:** the same format as the Badminton Scoreboard web app (main project branch). Load it there to burn the scoreboard into the original video file.
- **Reset** this video's score.

## Notes

- **Only people with the extension see the scoreboard.** Viewers of your channel need the burned-in version from the web app, or the chapters in the description.
- While an ad plays, the scoreboard hides and the point buttons are disabled.
- YouTube changes its page layout from time to time. If the panel stops appearing, the selectors in `content.js` (`#secondary`, `#movie_player`, `video.html5-main-video`) are the place to look.

## Files

- `manifest.json`: Manifest V3
- `content.js`, `content.css`: the panel, keys, overlay and storage
- `background.js`: toolbar button
- `lib/scoring.js`, `lib/overlay.js`: scoring engine and scoreboard drawing, shared with the web app
- `fonts/`: Barlow Condensed (SIL Open Font License, see `fonts/OFL.txt`)
