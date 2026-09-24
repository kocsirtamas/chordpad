// Synthesised drums. No samples to ship, no assets to load, and the kits are
// parameter sets rather than folders of audio.

// tune moves the pitched drums, decay their length, noise the brightness of the
// hats and cymbals, click the snap of the snare. noiseDecay is how long the
// unpitched drums ring when that has to differ from the drums: a trap kit is a
// long kick under short hats, and one number cannot say both.
export const KITS = {
  tight: { label: 'tight', tune: 1,    decay: 1,    noise: 1,    click: 1 },
  x0x:   { label: '808',   tune: 0.82, decay: 1.75, noise: 0.75, click: 0.6 },
  x9x:   { label: '909',   tune: 1.05, decay: 0.85, noise: 1.3,  click: 1.4 },
  lynn:  { label: 'lynn',  tune: 1.02, decay: 0.8,  noise: 1.25, click: 1.55 },
  lofi:  { label: 'lo-fi', tune: 0.9,  decay: 0.7,  noise: 1.1,  click: 0.8 },
  trap:  { label: 'trap',  tune: 0.62, decay: 2.6,  noise: 1.5,  click: 0.75, noiseDecay: 0.5 },
};

export const KIT_IDS = Object.keys(KITS);

// The device puts one drum on each of the seven keys, in this order.
export const DRUM_MAP = ['kick', 'kickAlt', 'snare', 'hatClosed', 'tom', 'ride', 'hatOpen'];

const VOICES = {
  kick:      { kind: 'tone',  from: 120, to: 45,  decay: 0.45, gain: 1 },
  kickAlt:   { kind: 'tone',  from: 90,  to: 38,  decay: 0.6,  gain: 0.95 },
  tom:       { kind: 'tone',  from: 260, to: 110, decay: 0.35, gain: 0.8 },
  snare:     { kind: 'noise', cutoff: 2200, decay: 0.22, gain: 0.7, body: 190 },
  hatClosed: { kind: 'noise', cutoff: 8000, decay: 0.05, gain: 0.4, highpass: true },
  hatOpen:   { kind: 'noise', cutoff: 7000, decay: 0.38, gain: 0.35, highpass: true },
  ride:      { kind: 'noise', cutoff: 6000, decay: 0.9,  gain: 0.28, highpass: true },
};

export function drumNames() {
  return DRUM_MAP.slice();
}

function noiseBuffer(ctx, seconds = 1) {
  const rate = ctx.sampleRate || 48000;
  const length = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(1, length, rate);
  const data = buffer.getChannelData ? buffer.getChannelData(0) : null;
  if (data) for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export function createDrumVoice(ctx, destination, { drum, kit, time, gain = 1 }) {
  const spec = VOICES[drum] || VOICES.kick;
  const settings = KITS[kit] || KITS.tight;
  const amp = ctx.createGain();
  const stretch = spec.kind === 'noise' && settings.noiseDecay !== undefined
    ? settings.noiseDecay
    : settings.decay;
  const decay = spec.decay * stretch;
  const level = gain * spec.gain;

  amp.gain.setValueAtTime(level, time);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  amp.connect(destination);

  const sources = [];

  if (spec.kind === 'tone') {
    // A pitch sweep from high to low is what makes a sine sound like a drum
    // being hit rather than a note being played.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(spec.from * settings.tune, time);
    osc.frequency.exponentialRampToValueAtTime(spec.to * settings.tune, time + decay * 0.8);
    osc.connect(amp);
    osc.start(time);
    osc.stop(time + decay + 0.05);
    sources.push(osc);
  } else {
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx, Math.max(0.1, decay + 0.1));
    const filter = ctx.createBiquadFilter();
    filter.type = spec.highpass ? 'highpass' : 'lowpass';
    filter.frequency.setValueAtTime(spec.cutoff * settings.noise, time);
    noise.connect(filter);
    filter.connect(amp);
    noise.start(time);
    if (typeof noise.stop === 'function') noise.stop(time + decay + 0.05);
    sources.push(noise);

    if (spec.body) {
      // A snare is noise plus a short tuned thump, or it sounds like a hiss.
      const body = ctx.createOscillator();
      body.type = 'triangle';
      body.frequency.setValueAtTime(spec.body * settings.tune, time);
      const bodyGain = ctx.createGain();
      bodyGain.gain.setValueAtTime(level * 0.5 * settings.click, time);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + decay * 0.5);
      body.connect(bodyGain);
      bodyGain.connect(destination);
      body.start(time);
      body.stop(time + decay + 0.05);
      sources.push(body);
    }
  }

  return {
    nodes: { gain: amp, sources },
    stop() { /* drums ring out on their own */ },
  };
}
