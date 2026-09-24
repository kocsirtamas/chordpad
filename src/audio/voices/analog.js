// One oscillator, one lowpass, one gain envelope. Every engine implements this
// same voice interface so instruments are interchangeable.

export const SHAPES = {
  warm:  { type: 'sine',     detune: 6 },
  piano: { type: 'triangle', detune: 3 },
  pluck: { type: 'sawtooth', detune: 2 },
  organ: { type: 'square',   detune: 0 },
};

export function shapeFor(instrument) {
  return SHAPES[instrument] || SHAPES.warm;
}

const ATTACK = 0.012;

// Stereo is one panner per voice, and only when it is asked for: an extra node
// on every note of every chord for a pan of zero is a cost with no sound.
export function connectPan(ctx, source, destination, pan) {
  if (!pan || typeof ctx.createStereoPanner !== 'function') {
    source.connect(destination);
    return null;
  }
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  source.connect(panner);
  panner.connect(destination);
  return panner;
}

// Releasing a note that is still in its attack used to jump the gain to full
// first, which on a slow pad is a step of most of the way and is heard as a
// click. cancelAndHoldAtTime releases from wherever the envelope actually got
// to. The old behaviour is kept for the one case that needs it: a context whose
// clock has not started, where the press and the release share a timestamp and
// holding the current value would hold silence.
export function releaseFrom(param, at, startedAt, attack, peak, release, { decay = 0, sustain = 1 } = {}) {
  // Released before it was due to start. A strummed chord schedules its later
  // notes in the future, so a quick tap lands here: the note never sounded, and
  // pinning it to its peak first would be a step out of nowhere, heard as a
  // click. It is simply silenced.
  if (at < startedAt) {
    param.cancelScheduledValues(startedAt);
    param.setValueAtTime(0, startedAt);
    return startedAt;
  }

  // A stalled clock cannot be asked where the envelope got to: press and release
  // share a timestamp and the current value reads as silence, so the note has to
  // be released from its peak or it is never heard at all.
  const clockStalled = at === startedAt;
  const from = clockStalled ? Math.max(at, startedAt + attack + decay) : at;

  // param.value is the value NOW, which says nothing about a note scheduled in
  // the future: for one of those it reads as the node's untouched default of 1,
  // and pinning that releases the note at full scale. Every arpeggiator and
  // repeat note is scheduled ahead, which is why those modes were loud and
  // constantly crackling. Whenever the envelope has settled by the time of the
  // release, its value is known without asking: it is the sustain level.
  const settled = at >= startedAt + attack + decay;
  const current = (clockStalled || settled) ? peak * sustain : param.value;

  // Deliberately not cancelAndHoldAtTime. Measured on a live context, holding
  // and then ramping produces a step forty times the waveform's own wobble two
  // render quanta later, while either operation alone is clean. Reading the
  // value, pinning it, and ramping from there is the older idiom and does not.
  param.cancelScheduledValues(from);
  param.setValueAtTime(current, from);
  param.linearRampToValueAtTime(0, from + release);
  return from + release;
}

export function createAnalogVoice(ctx, destination, {
  frequency, shape, layers, cutoff, gain, time, attack = ATTACK,
  decay = 0, sustain = 1, pan = 0, vibrato = null,
}) {
  // One shape or several stacked: a layered voice is how a pad or a detuned
  // poly synth gets its width without a second engine.
  const stack = layers || [shape || SHAPES.warm];
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();

  const oscillators = stack.map(layer => {
    const osc = ctx.createOscillator();
    osc.type = layer.type;
    osc.frequency.setValueAtTime(frequency, time);
    osc.detune.setValueAtTime(layer.detune || 0, time);
    if (layer.gain !== undefined && layer.gain !== 1) {
      const trim = ctx.createGain();
      trim.gain.value = layer.gain;
      osc.connect(trim);
      trim.connect(filter);
    } else {
      osc.connect(filter);
    }
    // The vibrato LFO is shared, so every voice wobbles in step rather than each
    // drifting on its own phase.
    if (vibrato) vibrato.connect(osc.detune);
    osc.start(time);
    return osc;
  });
  const osc = oscillators[0];

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, time);

  // Ramp rather than jump: stepping straight to full gain clicks.
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(gain, time + attack);
  if (decay > 0 && sustain < 1) amp.gain.linearRampToValueAtTime(gain * sustain, time + attack + decay);

  filter.connect(amp);
  const panner = connectPan(ctx, amp, destination, pan);

  return {
    nodes: { osc, oscillators, filter, gain: amp, panner },
    stop(at, release) {
      const end = releaseFrom(amp.gain, at, time, attack, gain, release, { decay, sustain });
      for (const each of oscillators) each.stop(end + 0.05);
    },
  };
}
