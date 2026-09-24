// Playing a recording at a pitch that is not its speed.
//
// A buffer source can only do the two together, the way tape does: read it
// faster and it is both quicker and higher. Separating them means reading the
// recording faster than the loop advances through it, and then repeatedly
// jumping back so the average keeps up. The jumps are the whole problem, and
// the answer is to have two of them overlapping at all times, each fading in as
// the other fades out, so there is never a moment when a jump is the only thing
// being heard.
//
// Two pointers, then. One walks through the recording at the speed the loop
// should take. The other reads from wherever that one is, at the speed the
// pitch should be, for the length of a grain, and then a new grain starts from
// wherever the first pointer has got to by then.
//
// At the same pitch and speed this is exactly transparent, not merely close:
// both grains read the same sample as the walking pointer, and two raised
// cosine windows half a grain apart sum to exactly one. So there is no reason
// to have a second way of playing a loop for the ordinary case.

export const DSP = `
class GrainPlayer {
  constructor(rate, options) {
    this.rate = rate;
    this.data = null;
    this.position = 0;
    // Two grains, each with where it started reading and how far in it is.
    // Each grain remembers the pitch and the length it was started with. A
    // grain reads from where it began plus its age times its pitch, so changing
    // the pitch under one that is already running moves its read position by
    // its whole age at once: measured, nudging the pitch a semitone mid grain
    // jumped the output by 0.94 where a 220 Hz tone moves at most 0.014 between
    // samples, and that jump is the crackle heard on every step of the slider.
    this.grains = [
      { at: 0, age: 0, live: false, pitch: 1, length: 1 },
      { at: 0, age: 0, live: false, pitch: 1, length: 1 },
    ];
    this.since = 0;
    this.set(options || {});
  }

  set(next) {
    const s = Object.assign({}, this.settings, next);
    this.settings = s;
    // How fast the loop walks through the recording: one is its own length.
    this.speed = Math.max(0.05, Math.min(8, s.speed === undefined ? 1 : s.speed));
    // And how fast a grain reads, against that: one is its own pitch.
    this.pitch = Math.max(0.125, Math.min(8, s.pitch === undefined ? 1 : s.pitch));
    // Long enough that the lowest note anybody records has a few cycles inside
    // a grain, short enough that a jump is not heard as an echo of itself.
    this.grainSeconds = s.grain === undefined ? 0.08 : s.grain;
    this.fit();
  }

  // Grains are launched at a fixed spacing, and unless that spacing divides the
  // loop the pattern of them lands differently on each pass: measured, a loop
  // of half a second came round sounding the same only every second, because
  // twelve and a half grains fitted in it. So the spacing is nudged to the
  // nearest one that does divide it, and every pass is then the same pass.
  fit() {
    const wanted = Math.max(64, Math.round(this.grainSeconds * this.rate));
    let hop = Math.max(32, Math.round(wanted / 2));
    if (this.data && this.data.length >= hop * 2) {
      const hops = Math.max(2, Math.round(this.data.length / hop));
      hop = Math.round(this.data.length / hops);
    }
    this.hop = Math.max(32, hop);
    this.grainLength = this.hop * 2;
  }

  load(data) {
    this.data = data;
    this.fit();
    this.position = 0;
    for (const grain of this.grains) grain.live = false;
    // Started already half way through a grain rather than from nothing, or the
    // first half grain of every loop is a fade in. The one that is already
    // running reads from before the beginning, which for a loop is the end of
    // it, which is exactly what comes before the beginning.
    this.grains[0].at = -this.hop;
    this.grains[0].age = this.hop;
    this.grains[0].live = true;
    this.grains[0].pitch = this.pitch;
    this.grains[0].length = this.grainLength;
    this.since = 0;
  }

  // Reading between samples, since neither pointer lands on one.
  sample(at) {
    const data = this.data;
    const length = data.length;
    if (length === 0) return 0;
    let where = at % length;
    if (where < 0) where += length;
    const first = Math.floor(where);
    const second = first + 1 >= length ? 0 : first + 1;
    const between = where - first;
    return data[first] * (1 - between) + data[second] * between;
  }

  run(out, frames) {
    const data = this.data;
    if (!data || data.length === 0) {
      for (let i = 0; i < frames; i++) out[i] = 0;
      return;
    }
    const length = this.grainLength;
    for (let i = 0; i < frames; i++) {
      // A new grain every half a grain, from wherever the loop has walked to.
      if (this.since <= 0) {
        const grain = this.grains[0].live && !this.grains[1].live ? this.grains[1]
          : (!this.grains[0].live ? this.grains[0]
            : (this.grains[0].age > this.grains[1].age ? this.grains[0] : this.grains[1]));
        grain.at = this.position;
        grain.age = 0;
        grain.live = true;
        // Taken now and held for the life of the grain, so a change lands on
        // the grains that follow rather than on the ones already sounding.
        grain.pitch = this.pitch;
        grain.length = length;
        this.since = this.hop;
      }
      this.since -= 1;

      let value = 0;
      for (const grain of this.grains) {
        if (!grain.live) continue;
        // A raised cosine, so that two of them half a grain apart sum to one.
        const through = grain.age / grain.length;
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * through);
        value += this.sample(grain.at + grain.age * grain.pitch) * window;
        grain.age += 1;
        if (grain.age >= grain.length) grain.live = false;
      }
      out[i] = value;
      this.position += this.speed;
      if (this.position >= data.length) this.position -= data.length;
    }
  }
}
`;

export const WORKLET = `${DSP}
class GrainVoice extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.player = new GrainPlayer(sampleRate, o.settings || {});
    if (o.channel) this.player.load(o.channel);
    this.port.onmessage = event => {
      const message = event.data || {};
      if (message.channel) this.player.load(message.channel);
      if (message.settings) this.player.set(message.settings);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (out) this.player.run(out, out.length);
    return true;
  }
}
registerProcessor('grain-voice', GrainVoice);
`;

// The same class, for tests and for measuring without a browser.
export function createGrainPlayer(rate, options) {
  const Player = new Function(`${DSP}\nreturn GrainPlayer;`)();
  return new Player(rate, options);
}
