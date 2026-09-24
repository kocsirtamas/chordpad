// A sampled voice: a recording of a real instrument, pitched by playback rate
// and then put through the same filter and envelope as every other voice, so a
// sampled sound and a synthesised one are interchangeable everywhere else.

import { releaseFrom, connectPan } from './analog.js';

const ATTACK = 0.004;

// Twelve semitones is a doubling, which is all the pitching a sample needs to
// know. Cents go to detune, where the shared vibrato LFO also lands.
export function rateFor(semitone, baseSemitone) {
  return Math.pow(2, (semitone - baseSemitone) / 12);
}

export function createSampleVoice(ctx, destination, {
  buffer, semitone, baseSemitone = 60, cutoff, gain, time, attack = ATTACK,
  decay = 0, sustain = 1, pan = 0, vibrato = null, loop = false,
}) {
  // A looped sample runs until the key is let go of, which is what makes a few
  // seconds of recording into an instrument rather than a one shot.
  const source = ctx.createBufferSource();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();

  source.buffer = buffer;
  source.playbackRate.value = rateFor(semitone, baseSemitone);
  source.loop = loop;
  // detune is in cents on a buffer source too, so the vibrato LFO needs no
  // special case for sampled voices.
  if (vibrato && source.detune) vibrato.connect(source.detune);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(cutoff, time);

  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(gain, time + attack);
  if (decay > 0 && sustain < 1) amp.gain.linearRampToValueAtTime(gain * sustain, time + attack + decay);

  source.connect(filter);
  filter.connect(amp);
  const panner = connectPan(ctx, amp, destination, pan);
  source.start(time);

  return {
    nodes: { osc: source, source, filter, gain: amp, panner },
    stop(at, release) {
      const end = releaseFrom(amp.gain, at, time, attack, gain, release, { decay, sustain });
      try { source.stop(end + 0.05); } catch { /* already stopped */ }
    },
  };
}
