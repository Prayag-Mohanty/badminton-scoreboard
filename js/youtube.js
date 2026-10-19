/*
 * YouTube support: score a match while watching it on YouTube (embedded),
 * without having the original file on this device.
 *
 * Wraps the YouTube IFrame Player API in the same small interface the app uses
 * for local files: getTime / seek / play / pause / isPaused / setRate / duration.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.YouTube = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Video id from any common YouTube link (watch, youtu.be, shorts, live, embed) or a bare id. */
  function parseId(input) {
    const s = String(input || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch (e) {
      return null;
    }
    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else {
        const m = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
        if (m) id = m[1];
      }
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }

  let apiPromise = null;
  function loadApi() {
    if (typeof window !== 'undefined' && window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => {
        apiPromise = null;
        reject(new Error("Couldn't reach YouTube. Check your internet connection."));
      };
      document.head.appendChild(s);
    });
    return apiPromise;
  }

  const ERRORS = {
    2: 'That link does not point to a valid YouTube video.',
    5: "This video can't be played in an embedded player.",
    100: 'Video not found. It may be private or deleted. Unlisted videos work; private ones do not.',
    101: "The video's owner doesn't allow it to be played on other websites. In YouTube Studio, turn on 'Allow embedding' for this video.",
    150: "The video's owner doesn't allow it to be played on other websites. In YouTube Studio, turn on 'Allow embedding' for this video.",
    153: "YouTube refused to play the video here. Open the app over http(s) (e.g. GitHub Pages), not as a local file.",
  };

  /**
   * Creates a player inside `container` (an element that will be replaced by
   * the iframe). Resolves once the video is ready and its duration is known.
   */
  async function createPlayer(container, videoId) {
    const YT = await loadApi();
    return new Promise((resolve, reject) => {
      let settled = false;
      // getCurrentTime() only updates a few times a second while playing, so
      // interpolate between updates to keep taps and the preview frame-accurate.
      let lastRaw = 0;
      let lastAt = 0;
      let rate = 1;
      let state = -1;

      const yt = new YT.Player(container, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0, // the app has its own transport controls
          disablekb: 1, // keys belong to the app (A / L / J / K …)
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          fs: 0,
          iv_load_policy: 3,
        },
        events: {
          onReady: () => {
            const wrapper = {
              kind: 'youtube',
              id: videoId,
              yt,
              get title() {
                const d = yt.getVideoData ? yt.getVideoData() : null;
                return (d && d.title) || 'YouTube video';
              },
              duration: () => yt.getDuration() || 0,
              getTime() {
                const raw = yt.getCurrentTime() || 0;
                const now = performance.now();
                if (raw !== lastRaw) {
                  lastRaw = raw;
                  lastAt = now;
                }
                if (state !== YT.PlayerState.PLAYING) return raw;
                // Never run more than half a second ahead of the last report.
                return raw + Math.min(0.5, ((now - lastAt) / 1000) * rate);
              },
              seek(t) {
                const d = wrapper.duration();
                const tt = Math.max(0, d ? Math.min(d, t) : t);
                yt.seekTo(tt, true);
                lastRaw = tt;
                lastAt = performance.now();
              },
              play: () => yt.playVideo(),
              pause: () => yt.pauseVideo(),
              isPaused: () => state !== YT.PlayerState.PLAYING && state !== YT.PlayerState.BUFFERING,
              setRate(r) {
                yt.setPlaybackRate(r);
                rate = yt.getPlaybackRate ? yt.getPlaybackRate() || r : r;
              },
              maxRate() {
                const rates = yt.getAvailablePlaybackRates ? yt.getAvailablePlaybackRates() : [1, 2];
                return Math.max.apply(null, rates.length ? rates : [2]);
              },
              destroy: () => yt.destroy(),
            };
            // Duration can be 0 until the video starts loading; cue it briefly.
            const waitForDuration = (tries) => {
              if (yt.getDuration() > 0 || tries <= 0) {
                settled = true;
                resolve(wrapper);
              } else setTimeout(() => waitForDuration(tries - 1), 200);
            };
            waitForDuration(25);
          },
          onStateChange: (e) => {
            state = e.data;
            lastRaw = yt.getCurrentTime() || 0;
            lastAt = performance.now();
          },
          onPlaybackRateChange: (e) => (rate = e.data),
          onError: (e) => {
            const err = new Error(ERRORS[e.data] || `YouTube error ${e.data}.`);
            if (!settled) {
              settled = true;
              reject(err);
            }
          },
        },
      });
    });
  }

  return { parseId, loadApi, createPlayer };
});
