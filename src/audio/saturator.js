// The last thing before the output: a ceiling that does not move.
//
// A compressor protects the output by turning things down, which means the
// level of a note already sounding depends on what else is playing. That is
// heard as pumping, and it was heard here: a note held through the tail of the
// one before it swelled as the tail died. Scaling each chord at its start
// instead fixes the swell but makes a chord quieter for its whole life because
// of something that has since stopped.
//
// Neither is necessary. A curve has no memory: the same input always gives the
// same output, so a key always sounds the same. Below the threshold it is
// exactly a straight line and does nothing at all; above it, it rounds the
// peaks off towards a ceiling they cannot pass. Several chords stacked are then
// gently saturated rather than ducked, which is what a mixing desk has always
// done with the same problem.

export const LINEAR_TO = 0.7;
export const CEILING = 0.98;

// How far past full scale the curve still describes. A wave shaper reads its
// curve between minus one and plus one and holds the endpoints for anything
// outside that, so a curve drawn over exactly that range stops being a ceiling
// and becomes a hard clip the moment the signal passes one. Measured with the
// seven keys held at once, which is the worst anybody can do by hand: 1.25 went
// in, so a fifth of every wave was flattened against the end of the curve, and
// flattening is the crackle. The signal is driven down into the curve by this
// much first and the curve drawn over the whole of it, so what arrives is
// rounded off rather than cut off.
export const RANGE = 4;

// The shape, as a function, so it can be checked without a browser.
export function saturate(x, linearTo = LINEAR_TO, ceiling = CEILING) {
  const magnitude = Math.abs(x);
  if (magnitude <= linearTo) return x;
  const room = ceiling - linearTo;
  const over = (magnitude - linearTo) / room;
  return Math.sign(x) * (linearTo + room * Math.tanh(over));
}

export function saturationCurve(points = 4097, linearTo = LINEAR_TO, ceiling = CEILING,
  range = RANGE) {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    // Read between minus one and plus one, standing for minus range to plus
    // range of signal. Below the threshold the answer is a straight line, and a
    // straight line read by interpolation is exact however few points it gets.
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = saturate(x * range, linearTo, ceiling);
  }
  return curve;
}

export function createSaturator(ctx, { linearTo = LINEAR_TO, ceiling = CEILING,
  range = RANGE } = {}) {
  // Driven down into the curve, which is drawn to match: what comes out is
  // already at the right level, so nothing has to be put back afterwards.
  const input = ctx.createGain();
  input.gain.value = 1 / range;
  const shaper = ctx.createWaveShaper();
  shaper.curve = saturationCurve(4097, linearTo, ceiling, range);
  // Distortion makes harmonics, and harmonics above half the sample rate fold
  // back down as something that was never played. Oversampling is the cost of
  // not hearing that.
  shaper.oversample = '4x';
  input.connect(shaper);
  return { input, output: shaper, shaper };
}
