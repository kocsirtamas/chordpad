// Records the whole session: everything that reaches the output, including
// loops playing, drums and effects. It is a tap on the master rather than a
// re-render, so what is saved is what was heard.
//
// Two ways of tapping, because AudioWorklet only exists in a secure context and
// this is served over plain HTTP on a LAN. With a worklet the samples are
// copied off the audio thread and written as WAV: lossless, no dependency,
// roughly 5 MB a minute in mono at 48 kHz. Without one, the master is also fed
// to a MediaStream and MediaRecorder writes whatever the browser can encode,
// usually webm/opus. That is lossy but it runs off the main thread, which a
// ScriptProcessor tap would not: recording a live take must never be the thing
// that makes the audio stutter.

// Shared with the sampler, which taps the microphone the same way.
export const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input) return true;
    if (output) output.set(input);
    // Copied, because the buffer handed in is reused for the next block.
    this.port.postMessage(Float32Array.from(input));
    return true;
  }
}
registerProcessor('session-tap', Tap);
`;

// A WAV file is a 44 byte header and then the samples as 16 bit integers.
export function encodeWav(chunks, sampleRate) {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;

  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };

  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header size
  view.setUint16(20, 1, true);           // PCM, uncompressed
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);  // bytes per second
  view.setUint16(32, 2, true);           // bytes per frame
  view.setUint16(34, 16, true);          // bits per sample
  text(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      // Clamped, so a sample over full scale wraps to a click rather than
      // round-tripping into noise.
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7FFF), true);
      offset += 2;
    }
  }

  return buffer;
}

// What the browser will encode to, best first. An empty string lets
// MediaRecorder pick for itself, which every browser that has it will do.
const STREAM_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', ''];

function streamType() {
  const Ctor = globalThis.MediaRecorder;
  if (!Ctor) return null;
  for (const type of STREAM_TYPES) {
    if (!type || !Ctor.isTypeSupported || Ctor.isTypeSupported(type)) return type;
  }
  return null;
}

function extensionFor(type) {
  if (!type) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4')) return 'm4a';
  return 'webm';
}

export function createRecorder({ engine }) {
  // The worklet tap, when the page is allowed one.
  let node = null;
  let chunks = [];
  // The MediaStream fallback.
  let stream = null;
  let media = null;
  let blobs = [];
  let startedAt = 0;

  function running() { return node !== null || media !== null; }

  async function startWorklet(ctx, master) {
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    chunks = [];
    node = new AudioWorkletNode(ctx, 'session-tap');
    node.port.onmessage = event => chunks.push(event.data);

    // Spliced between the master and the output, so it hears the finished mix.
    master.disconnect();
    master.connect(node);
    node.connect(ctx.destination);
    return true;
  }

  function startStream(ctx, master) {
    const type = streamType();
    if (type === null || typeof ctx.createMediaStreamDestination !== 'function') return false;

    // A stream destination is a second sink rather than a splice, so the output
    // keeps playing exactly as it did.
    stream = ctx.createMediaStreamDestination();
    master.connect(stream);
    blobs = [];
    media = new MediaRecorder(stream.stream, type ? { mimeType: type } : undefined);
    media.ondataavailable = event => { if (event.data && event.data.size) blobs.push(event.data); };
    media.start(1000);
    return true;
  }

  return {
    isRecording() { return running(); },
    // Says how the session will be saved, so the interface can be honest about
    // it before anything is recorded.
    format() {
      const ctx = engine.context();
      if (ctx && ctx.audioWorklet) return 'wav';
      return streamType() === null ? null : extensionFor(streamType());
    },
    seconds() {
      const ctx = engine.context();
      return running() && ctx ? ctx.currentTime - startedAt : 0;
    },

    async start() {
      if (running()) return false;
      const ctx = engine.context();
      const master = engine.masterGain();
      if (!ctx || !master) return false;

      startedAt = ctx.currentTime;
      // AudioWorklet exists only in a secure context, so on a plain HTTP LAN
      // address this is the path that runs.
      if (ctx.audioWorklet) return startWorklet(ctx, master);
      return startStream(ctx, master);
    },

    async stop() {
      const ctx = engine.context();
      if (!ctx || !running()) return null;

      if (node) {
        node.port.onmessage = null;
        const master = engine.masterGain();
        master.disconnect();
        node.disconnect();
        master.connect(ctx.destination);
        node = null;

        const recorded = chunks;
        chunks = [];
        if (recorded.length === 0) return null;
        return {
          blob: new Blob([encodeWav(recorded, ctx.sampleRate)], { type: 'audio/wav' }),
          extension: 'wav',
          seconds: recorded.reduce((total, chunk) => total + chunk.length, 0) / ctx.sampleRate,
        };
      }

      const recorder = media;
      const type = recorder.mimeType || '';
      media = null;
      const seconds = ctx.currentTime - startedAt;

      // The last block only arrives after stop, so the file is not complete
      // until the recorder says so.
      await new Promise((resolve) => {
        recorder.onstop = resolve;
        try { recorder.stop(); } catch { resolve(); }
      });
      engine.masterGain().disconnect(stream);
      stream = null;

      const parts = blobs;
      blobs = [];
      if (parts.length === 0) return null;
      return { blob: new Blob(parts, { type: type || 'audio/webm' }), extension: extensionFor(type), seconds };
    },
  };
}
