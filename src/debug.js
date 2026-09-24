// Diagnostic overlay, loaded only when the page is opened with ?debug=1.
// Reports what the audio clock is actually doing, since the interesting
// failures happen on a phone where no console is at hand.

// Runs on the audio thread, so unlike a ScriptProcessor it cannot glitch the
// thing it is measuring. Reports any step between consecutive samples that a
// waveform cannot explain, and any block that arrives all-zero after audible
// output, which is what an underrun looks like from inside.
const GLITCH_WORKLET = `
class GlitchDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.previous = 0;
    this.wasAudible = false;
  }
  process(inputs, outputs) {
    const input = inputs[0][0];
    const output = outputs[0][0];
    if (!input) return true;
    output.set(input);

    let worst = 0;
    let peak = 0;
    for (let i = 0; i < input.length; i++) {
      const step = Math.abs(input[i] - this.previous);
      if (step > worst) worst = step;
      const level = Math.abs(input[i]);
      if (level > peak) peak = level;
      this.previous = input[i];
    }

    if (worst > 0.15) {
      this.port.postMessage({ kind: 'step', size: +worst.toFixed(3), at: +currentTime.toFixed(2) });
    }
    if (this.wasAudible && peak === 0) {
      this.port.postMessage({ kind: 'silence', at: +currentTime.toFixed(2) });
    }
    this.wasAudible = peak > 0.001;
    return true;
  }
}
registerProcessor('glitch-detector', GlitchDetector);
`;

async function installGlitchDetector(engine, log) {
  const ctx = engine.context();
  const master = engine.masterGain();
  if (!ctx || !master || !ctx.audioWorklet) return log('no audio worklet available');
  try {
    const url = URL.createObjectURL(new Blob([GLITCH_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const node = new AudioWorkletNode(ctx, 'glitch-detector');
    master.disconnect();
    master.connect(node);
    node.connect(ctx.destination);

    let steps = 0;
    let silences = 0;
    node.port.onmessage = event => {
      const { kind, size, at } = event.data;
      if (kind === 'step') {
        steps += 1;
        log(`STEP ${size} at ${at}s (${steps} so far)`);
      } else {
        silences += 1;
        log(`DROPOUT at ${at}s (${silences} so far)`);
      }
    };

    log(`listening: rate ${ctx.sampleRate}, base latency ${(ctx.baseLatency || 0).toFixed(4)}s`);
  } catch (err) {
    log(`glitch detector failed: ${err.message}`);
  }
}

export function attachDebug(engine, clock = null) {
  const box = document.createElement('div');
  box.className = 'debugbox';
  document.body.appendChild(box);

  const lines = [];
  const log = (text) => {
    lines.push(text);
    box.textContent = lines.slice(-14).join('\n');
  };

  // The transport's own account of itself, once a second: how it is being
  // ticked, the longest it has gone unpumped, and how many steps that cost. A
  // gap here is what a hiccup sounds like.
  if (clock) {
    setInterval(() => {
      const stats = clock.stats();
      log(`clock: ${stats.ticker} worst=${stats.worstGap}ms dropped=${stats.dropped}`
        + ` ahead=${clock.getLookahead()}s voices=${engine.activeVoiceCount()}`
        + ` rev=${engine.effects() && engine.effects().reverbEngaged() ? 'on' : 'off'}`);
    }, 1000);
  }

  const snapshot = (label) => {
    const ctx = engine.context();
    if (!ctx) return log(`${label}: no context yet`);
    const latency = ctx.baseLatency === undefined ? '?' : `${Math.round(ctx.baseLatency * 1000)}ms`;
    log(`${label}: state=${ctx.state} t=${ctx.currentTime.toFixed(3)} voices=${engine.activeVoiceCount()}`
      + ` buffer=${latency}`);
  };

  log(`ua=${navigator.userAgent.includes('Android') ? 'Android' : navigator.userAgent.includes('iPhone') ? 'iOS' : 'desktop'}`);
  document.addEventListener('pointerdown', () => {
    const ctx = engine.context();
    if (ctx && typeof ctx.resume === 'function') {
      Promise.resolve(ctx.resume())
        .then(() => log(`resume resolved, state=${ctx.state} t=${ctx.currentTime.toFixed(3)}`))
        .catch(err => log(`resume rejected: ${err.name}`));
    }
  }, { capture: true });
  snapshot('load');

  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) {
    document.addEventListener(type, () => snapshot(type), { capture: true });
  }

  // Sliding across the pad depends on pointermove surviving the whole gesture.
  // If the browser cancels the pointer instead, it shows up here.
  let moves = 0;
  document.addEventListener('pointermove', e => {
    moves += 1;
    if (moves % 10 === 1) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const key = el && el.closest ? el.closest('.k') : null;
      log(`move ${moves} over=${key ? 'key' + (Number(key.dataset.degree) + 1) : 'none'}`);
    }
  }, { capture: true, passive: true });
  document.addEventListener('pointercancel', () => log(`POINTERCANCEL after ${moves} moves`), { capture: true });

  // The detector can only be spliced in once audio is actually running.
  let installed = false;
  const watchForContext = setInterval(() => {
    if (installed) return;
    const ctx = engine.context();
    if (ctx && ctx.state === 'running') {
      installed = true;
      clearInterval(watchForContext);
      installGlitchDetector(engine, log);
    }
  }, 200);

  // Watch the context switching to running, whenever that actually happens.
  let last = null;
  setInterval(() => {
    const ctx = engine.context();
    if (!ctx) return;
    if (ctx.state !== last) {
      last = ctx.state;
      log(`state changed -> ${ctx.state} at t=${ctx.currentTime.toFixed(3)}`);
    }
  }, 100);

  return { log, snapshot };
}
