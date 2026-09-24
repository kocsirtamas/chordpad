// Two operator FM: one oscillator modulates another's frequency. Cheap to run
// and the only way to get bell and electric piano tones out of plain oscillators.

import { releaseFrom, connectPan } from './analog.js';

export function createFmVoice(ctx, destination, {
  frequency, ratio, index, cutoff, gain, time, attack = 0.008, curve = 3,
  decay = 0, sustain = 1, pan = 0, vibrato = null,
}) {
  const carrier = ctx.createOscillator();
  const modulator = ctx.createOscillator();
  const modDepth = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();

  carrier.type = 'sine';
  modulator.type = 'sine';
  carrier.frequency.setValueAtTime(frequency, time);
  modulator.frequency.setValueAtTime(frequency * ratio, time);

  // Modulation depth in Hz, decaying so the tone starts bright and settles,
  // which is what makes an FM piano sound struck rather than blown.
  modDepth.gain.setValueAtTime(frequency * index, time);
  modDepth.gain.setTargetAtTime(frequency * index * 0.1, time, curve * 0.15);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, time);

  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(gain, time + attack);
  if (decay > 0 && sustain < 1) amp.gain.linearRampToValueAtTime(gain * sustain, time + attack + decay);

  modulator.connect(modDepth);
  modDepth.connect(carrier.frequency);
  carrier.connect(filter);
  filter.connect(amp);
  const panner = connectPan(ctx, amp, destination, pan);
  if (vibrato) vibrato.connect(carrier.detune);
  modulator.start(time);
  carrier.start(time);

  return {
    nodes: { osc: carrier, modulator, filter, gain: amp, panner },
    stop(at, release) {
      const end = releaseFrom(amp.gain, at, time, attack, gain, release, { decay, sustain });
      carrier.stop(end + 0.05);
      modulator.stop(end + 0.05);
    },
  };
}
