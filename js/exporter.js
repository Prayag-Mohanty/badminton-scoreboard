/*
 * In-browser export: burns the scoreboard into the video using WebCodecs.
 *
 *   File ──mp4box.js──► H.264/HEVC samples ──VideoDecoder──► frames
 *        frames + scoreboard ──canvas──► VideoEncoder (H.264) ──mp4-muxer──► MP4
 *   Audio (AAC) is copied through untouched, so there is no quality loss there.
 *
 * The input file is read in slices and the output is streamed to disk (or to a
 * Blob the browser keeps on disk), so 1–2 GB phone recordings work without
 * loading the whole thing into memory.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Exporter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const READ_CHUNK = 8 * 1024 * 1024;

  function isSupported() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof MP4Box !== 'undefined';
  }

  function dataStreamClass() {
    if (typeof DataStream !== 'undefined') return DataStream; // eslint-disable-line no-undef
    return MP4Box.DataStream;
  }

  /** avcC / hvcC / vpcC / av1C box payload → VideoDecoderConfig.description */
  function videoDescription(mp4, trackId) {
    const trak = mp4.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const DS = dataStreamClass();
        const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8); // skip the box header
      }
    }
    return undefined;
  }

  /** AAC AudioSpecificConfig from the esds box. */
  function audioDescription(mp4, trackId) {
    const trak = mp4.getTrackById(trackId);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const esd = entry && entry.esds && entry.esds.esd;
    if (!esd) return undefined;
    const dcd = (esd.descs || []).find((d) => d.tag === 4);
    const dsi = dcd && (dcd.descs || []).find((d) => d.tag === 5);
    return dsi ? new Uint8Array(dsi.data) : undefined;
  }

  /** Clockwise display rotation (0/90/180/270) from the track matrix. */
  function rotationOf(track) {
    const m = track.matrix;
    if (!m) return 0;
    const a = m[0] / 65536;
    const b = m[1] / 65536;
    let deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
    deg = ((deg % 360) + 360) % 360;
    return [0, 90, 180, 270].reduce((best, r) => (Math.abs(r - deg) < Math.abs(best - deg) ? r : best), 0);
  }

  /**
   * Reads a Blob/File through mp4box. Call open() to get track info, then
   * pull() repeatedly to get more samples. Samples arrive in the arrays
   * `video` and `audio`; consumers shift them off and call release().
   */
  class Demuxer {
    constructor(blob) {
      this.blob = blob;
      this.mp4 = MP4Box.createFile();
      this.offset = 0;
      this.eof = false;
      this.video = [];
      this.audio = [];
      this.info = null;
      this.videoTrack = null;
      this.audioTrack = null;
      this.nextSample = {};
    }

    async open() {
      let error = null;
      this.mp4.onError = (e) => (error = e);
      this.mp4.onReady = (info) => {
        this.info = info;
        this.videoTrack = info.videoTracks[0] || null;
        this.audioTrack = info.audioTracks[0] || null;
      };
      this.mp4.onSamples = (id, user, samples) => {
        const arr = this.videoTrack && id === this.videoTrack.id ? this.video : this.audio;
        // Accept samples strictly in order. After the seek in open(), mp4box
        // may still hand out a few samples from its earlier position.
        for (const s of samples) {
          const expected = this.nextSample[id] || 0;
          if (s.number !== expected) continue;
          this.nextSample[id] = expected + 1;
          arr.push(s);
        }
      };
      while (!this.info && !this.eof && !error) await this._read();
      if (error) throw new Error('Could not read this video file: ' + error);
      if (!this.info) throw new Error('This file does not look like an MP4/MOV video.');
      if (!this.videoTrack) throw new Error('No video track found in this file.');
      this.mp4.setExtractionOptions(this.videoTrack.id, null, { nbSamples: 120 });
      if (this.audioTrack) this.mp4.setExtractionOptions(this.audioTrack.id, null, { nbSamples: 240 });
      this.mp4.start();
      // Restart reading from the first media sample. Needed when the 'moov'
      // index sits at the end of the file (common for phone recordings).
      const seek = this.mp4.seek(0, true);
      if (seek && typeof seek.offset === 'number') {
        this.offset = seek.offset;
        this.eof = false;
      }
      // Anything extracted before the seek will be delivered again from there.
      this.video.length = 0;
      this.audio.length = 0;
      this.nextSample = {};
      return this.info;
    }

    async _read() {
      if (this.offset >= this.blob.size) {
        this.mp4.flush();
        this.eof = true;
        return;
      }
      const end = Math.min(this.offset + READ_CHUNK, this.blob.size);
      const buf = await this.blob.slice(this.offset, end).arrayBuffer();
      buf.fileStart = this.offset;
      // mp4box tells us where it wants to continue reading (it may jump, e.g.
      // back to the media data after finding the 'moov' box at the end).
      const next = this.mp4.appendBuffer(buf);
      this.offset = typeof next === 'number' && next > 0 ? next : end;
    }

    /** Read more of the file. Returns false once everything has been read. */
    async pull() {
      if (this.eof) return false;
      await this._read();
      return true;
    }

    release(trackId, sampleNumber) {
      this.mp4.releaseUsedSamples(trackId, sampleNumber);
    }
  }

  async function pickEncoderConfig(width, height, fps, bitrate) {
    const candidates = [
      'avc1.640033', // High 5.1
      'avc1.640034', // High 5.2
      'avc1.64002A', // High 4.2
      'avc1.640028', // High 4.0
      'avc1.4D0033', // Main 5.1
      'avc1.42003E', // Baseline 6.2
    ];
    // VP9 in MP4 as a fallback for browsers without an H.264 encoder (YouTube accepts it).
    candidates.push('vp09.00.41.08', 'vp09.00.50.08');
    for (const codec of candidates) {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        const cfg = {
          codec,
          width,
          height,
          bitrate,
          framerate: fps,
          hardwareAcceleration,
          bitrateMode: 'variable',
          latencyMode: 'quality',
        };
        if (codec.startsWith('avc1')) cfg.avc = { format: 'avc' };
        try {
          const res = await VideoEncoder.isConfigSupported(cfg);
          if (res.supported) return Object.assign({}, cfg, res.config);
        } catch (e) {
          /* try next */
        }
      }
    }
    return null;
  }

  /**
   * options:
   *   file          File/Blob of the source video
   *   drawOverlay   (ctx, timeSeconds, width, height) => void
   *   writable      optional FileSystemWritableFileStream (output goes straight to disk)
   *   bitrate       optional target bits per second (default ≈ source bitrate)
   *   onProgress    ({ fraction, framesDone, fps, etaSeconds }) => void
   *   signal        optional AbortSignal
   * Returns { blob?: Blob, warnings: string[] }
   */
  async function exportVideo(options) {
    const { file, drawOverlay, writable, onProgress, signal } = options;
    const warnings = [];
    const demux = new Demuxer(file);
    const info = await demux.open();
    const vt = demux.videoTrack;
    const at = demux.audioTrack;

    const durationSec = info.duration / info.timescale || vt.duration / vt.timescale;
    const totalFrames = vt.nb_samples;
    const fps = totalFrames / (vt.duration / vt.timescale || durationSec) || 30;
    const rotation = rotationOf(vt);
    const codedW = vt.video ? vt.video.width : vt.track_width;
    const codedH = vt.video ? vt.video.height : vt.track_height;
    let outW = rotation % 180 ? codedH : codedW;
    let outH = rotation % 180 ? codedW : codedH;
    outW -= outW % 2;
    outH -= outH % 2;

    const decoderConfig = {
      codec: vt.codec.startsWith('vp08') ? 'vp8' : vt.codec,
      codedWidth: codedW,
      codedHeight: codedH,
      description: videoDescription(demux.mp4, vt.id),
    };
    const decSupport = await VideoDecoder.isConfigSupported(decoderConfig).catch(() => ({ supported: false }));
    if (!decSupport.supported) {
      throw new Error(
        `This browser cannot decode the video codec (${vt.codec}). ` +
          'Try Google Chrome or Microsoft Edge, or use the "ffmpeg kit" export instead.'
      );
    }

    const srcBitrate = (file.size * 8) / Math.max(1, durationSec);
    const bitrate = options.bitrate || Math.round(Math.min(40e6, Math.max(6e6, srcBitrate * 0.9)));
    const encoderConfig = await pickEncoderConfig(outW, outH, Math.round(fps), bitrate);
    if (!encoderConfig) throw new Error('This browser has no suitable video encoder. Use the "ffmpeg kit" export instead.');

    // Audio: copy AAC as-is. Anything else is dropped with a warning.
    let audioOut = null;
    if (at) {
      if (/^mp4a\.40/.test(at.codec)) {
        audioOut = {
          codec: 'aac',
          numberOfChannels: at.audio.channel_count,
          sampleRate: at.audio.sample_rate,
          description: audioDescription(demux.mp4, at.id),
        };
      } else {
        warnings.push(`Audio codec ${at.codec} can't be copied in the browser, so the export has no sound. Use the ffmpeg kit to keep it.`);
      }
    }

    // ---- output target ----
    let target;
    const sink = writable ? null : new BlobSink();
    if (writable) {
      target = new Mp4Muxer.FileSystemWritableFileStreamTarget(writable);
    } else {
      target = new Mp4Muxer.StreamTarget({ chunked: true, onData: (data, position) => sink.write(data, position) });
    }
    const muxer = new Mp4Muxer.Muxer({
      target,
      video: { codec: encoderConfig.codec.startsWith('vp09') ? 'vp9' : 'avc', width: outW, height: outH, frameRate: Math.round(fps) },
      audio: audioOut ? { codec: 'aac', numberOfChannels: audioOut.numberOfChannels, sampleRate: audioOut.sampleRate } : undefined,
      fastStart: false,
      firstTimestampBehavior: 'cross-track-offset',
    });

    // ---- canvas for compositing ----
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(outW, outH) : Object.assign(document.createElement('canvas'), { width: outW, height: outH });
    const ctx = canvas.getContext('2d', { alpha: false });

    let fatal = null;
    let wake = null;
    const fail = (e) => {
      if (!fatal) fatal = e instanceof Error ? e : new Error(String(e));
      if (wake) wake();
    };

    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (e) {
          fail(e);
        }
      },
      error: fail,
    });
    encoder.configure(encoderConfig);

    let firstTs = null;
    let framesDone = 0;
    let lastKeyTs = -Infinity;
    const keyInterval = 2e6; // keyframe every 2 s (good for YouTube and seeking)
    const startedAt = performance.now();

    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (fatal) return;
          if (firstTs === null) firstTs = frame.timestamp;
          ctx.save();
          if (rotation) {
            ctx.translate(outW / 2, outH / 2);
            ctx.rotate((rotation * Math.PI) / 180);
            ctx.drawImage(frame, -codedW / 2, -codedH / 2, codedW, codedH);
          } else {
            ctx.drawImage(frame, 0, 0, outW, outH);
          }
          ctx.restore();
          const t = (frame.timestamp - firstTs) / 1e6;
          drawOverlay(ctx, t, outW, outH);
          const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration || undefined });
          const keyFrame = frame.timestamp - lastKeyTs >= keyInterval;
          if (keyFrame) lastKeyTs = frame.timestamp;
          encoder.encode(out, { keyFrame });
          out.close();
        } catch (e) {
          fail(e);
        } finally {
          frame.close();
        }
        framesDone++;
        if (onProgress && framesDone % 15 === 0) {
          const elapsed = (performance.now() - startedAt) / 1000;
          const rate = framesDone / Math.max(0.001, elapsed);
          onProgress({
            fraction: Math.min(1, framesDone / totalFrames),
            framesDone,
            totalFrames,
            fps: rate,
            etaSeconds: (totalFrames - framesDone) / Math.max(0.001, rate),
          });
        }
      },
      error: fail,
    });
    decoder.configure(decoderConfig);

    // Wait until the decoder or encoder makes room. Uses 'dequeue' events (not
    // timers) so the export keeps full speed when the tab is in the background.
    const channel = new MessageChannel();
    const waitTick = () =>
      new Promise((resolve) => {
        wake = resolve;
        if (signal) signal.addEventListener('abort', resolve, { once: true });
        if ('ondequeue' in decoder) {
          decoder.ondequeue = encoder.ondequeue = () => {
            decoder.ondequeue = encoder.ondequeue = null;
            resolve();
          };
        } else {
          channel.port1.onmessage = () => resolve();
          channel.port2.postMessage(0);
        }
      });
    let audioConfigSent = false;

    try {
      for (;;) {
        if (fatal) throw fatal;
        if (signal && signal.aborted) throw new DOMException('Export cancelled', 'AbortError');

        // Audio: straight into the muxer.
        let lastAudio = null;
        while (demux.audio.length) {
          const s = demux.audio.shift();
          lastAudio = s;
          if (!audioOut) continue;
          const meta = audioConfigSent ? undefined : { decoderConfig: { codec: at.codec, numberOfChannels: audioOut.numberOfChannels, sampleRate: audioOut.sampleRate, description: audioOut.description } };
          audioConfigSent = true;
          muxer.addAudioChunkRaw(new Uint8Array(s.data), 'key', (1e6 * s.cts) / s.timescale, (1e6 * s.duration) / s.timescale, meta);
        }
        if (lastAudio) demux.release(at.id, lastAudio.number);

        // Video: feed the decoder while the pipeline has room.
        let lastVideo = null;
        while (demux.video.length && decoder.decodeQueueSize < 16 && encoder.encodeQueueSize < 16) {
          const s = demux.video.shift();
          lastVideo = s;
          decoder.decode(
            new EncodedVideoChunk({
              type: s.is_sync ? 'key' : 'delta',
              timestamp: (1e6 * s.cts) / s.timescale,
              duration: (1e6 * s.duration) / s.timescale,
              data: s.data,
            })
          );
        }
        if (lastVideo) demux.release(vt.id, lastVideo.number);

        if (demux.video.length < 240 && !demux.eof) {
          await demux.pull();
          continue;
        }
        if (demux.eof && !demux.video.length && !demux.audio.length) break;
        await waitTick();
      }

      await decoder.flush();
      await encoder.flush();
      if (fatal) throw fatal;
      muxer.finalize();
    } finally {
      if (decoder.state !== 'closed') decoder.close();
      if (encoder.state !== 'closed') encoder.close();
    }

    if (onProgress) onProgress({ fraction: 1, framesDone, totalFrames, fps: 0, etaSeconds: 0 });

    if (writable) {
      await writable.close();
      return { warnings };
    }
    return { blob: sink.toBlob(), warnings };
  }

  /**
   * Collects StreamTarget output into a Blob. Output is sequential except the
   * muxer patching the 'mdat' size near the start of the file when it
   * finalizes, so the first few MB stay patchable in memory and everything
   * after is handed to the browser as Blobs (which it can keep on disk).
   */
  class BlobSink {
    constructor() {
      this.headLimit = 32 * 1024 * 1024;
      this.head = []; // { position, data: Uint8Array }
      this.tail = []; // Blob
      this.written = 0;
    }

    write(data, position) {
      if (position === this.written) {
        this.written += data.byteLength;
        if (position < this.headLimit) this.head.push({ position, data: new Uint8Array(data) });
        else this.tail.push(new Blob([data]));
        return;
      }
      const end = position + data.byteLength;
      let patched = 0;
      for (const q of this.head) {
        const qEnd = q.position + q.data.byteLength;
        const from = Math.max(position, q.position);
        const to = Math.min(end, qEnd);
        if (from >= to) continue;
        q.data.set(data.subarray(from - position, to - position), from - q.position);
        patched += to - from;
      }
      if (patched !== data.byteLength) throw new Error('Unexpected write position in output file.');
    }

    toBlob() {
      return new Blob(this.head.map((p) => p.data).concat(this.tail), { type: 'video/mp4' });
    }
  }

  return { isSupported, exportVideo, Demuxer, rotationOf };
});
