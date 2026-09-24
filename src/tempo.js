// Tap tempo. Given the times of a few taps, work out what tempo they mean.

export const MIN_BPM = 40;
export const MAX_BPM = 300;

// Taps further apart than this are a new attempt rather than part of the same one.
export const TAP_TIMEOUT_MS = 2500;

export function usableTaps(times, now = times[times.length - 1]) {
  const recent = [];
  for (let i = times.length - 1; i >= 0; i--) {
    const previous = i === times.length - 1 ? now : times[i + 1];
    if (previous - times[i] > TAP_TIMEOUT_MS) break;
    recent.unshift(times[i]);
  }
  return recent;
}

// The median gap rather than the average: one hesitant tap should not drag the
// whole tempo with it.
export function tempoFromTaps(times) {
  const taps = usableTaps(times);
  if (taps.length < 3) return null;

  const gaps = [];
  for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
  gaps.sort((a, b) => a - b);
  const middle = gaps.length % 2
    ? gaps[(gaps.length - 1) / 2]
    : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;

  if (middle <= 0) return null;
  const bpm = Math.round(60000 / middle);
  return Math.min(MAX_BPM, Math.max(MIN_BPM, bpm));
}
