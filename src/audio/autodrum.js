// Auto-drum: a held drum key repeats at a chosen rate instead of being hit by
// hand. The rates are the device's, straight and swung; the table that says
// where a hit lands is shared with the arpeggiator and repeat.

import { offsetsAt } from '../rates.js';

export const AUTO_DRUM_RATES = ['off', '1/4', '1/8', '1/16', '1/32', 'swing8', 'swing16', '1/16T'];

export function autoDrumOffsets(rate, step, stepDuration) {
  return rate === 'off' ? [] : offsetsAt(rate, step, stepDuration);
}
