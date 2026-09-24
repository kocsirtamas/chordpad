#!/usr/bin/env bash
# Renders the sampled instruments from a General MIDI soundfont.
#
# The soundfont is Debian's fluid-soundfont-gm (FluidR3_GM), which is MIT
# licensed, so the audio it produces can be shipped with the app without an
# attribution notice. One source for every instrument also means they sit
# together: the same room, the same level, the same recording chain.
#
#   sudo apt-get install -y --no-install-recommends ffmpeg fluidsynth fluid-soundfont-gm
#   tools/render-samples.sh
#
# Writes samples/<instrument>-<midi note>.mp3, which is what src/audio/instruments.js
# expects. Existing files are left alone, so a re-run only fills in the gaps.

set -euo pipefail

SF2="${SF2:-/usr/share/sounds/sf2/FluidR3_GM.sf2}"
OUT="${OUT:-samples}"
NOTES=(36 42 48 54 60 66 72 78 84)
# One note held for this long, then left to ring. The app applies its own
# envelope on top, so what is wanted here is the instrument's own attack and
# body, not a shape.
HOLD=3.0
TAIL=1.5
RATE=44100
BITRATE=112k

# id:program. General MIDI program numbers, zero based.
INSTRUMENTS=(
  "piano:0"
  "wurli:4"
  "vibes:11"
  "guitar:24"
  "harp:46"
  "strings:48"
  "choir:52"
  "voices:53"
  "brass:61"
  "clarinet:71"
  "flute:73"
)

command -v fluidsynth >/dev/null || { echo "fluidsynth is not installed" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is not installed" >&2; exit 1; }
[ -f "$SF2" ] || { echo "no soundfont at $SF2" >&2; exit 1; }

mkdir -p "$OUT"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for entry in "${INSTRUMENTS[@]}"; do
  id="${entry%%:*}"
  program="${entry##*:}"
  for note in "${NOTES[@]}"; do
    target="$OUT/$id-$note.mp3"
    [ -f "$target" ] && continue

    # A MIDI file of one note, written by hand: a header, then program change,
    # note on, note off. Cheaper than pulling in a MIDI library for six bytes
    # of music.
    python3 - "$work/note.mid" "$program" "$note" "$HOLD" <<'PY'
import struct, sys
path, program, note, hold = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])

TICKS = 480          # per quarter note
BEAT = 0.5           # seconds, the default MIDI tempo of 120 bpm

# MIDI delta times are seven bits at a time, high bit set on all but the last.
def varlen(value):
    out = bytes([value & 0x7F])
    value >>= 7
    while value:
        out = bytes([(value & 0x7F) | 0x80]) + out
        value >>= 7
    return out

def chunk(tag, body):
    return tag + struct.pack('>I', len(body)) + body

held = max(1, round(hold / BEAT * TICKS))
events = b''
events += b'\x00' + bytes([0xC0, program])              # program change
events += b'\x00' + bytes([0x90, note, 100])            # note on, velocity 100
events += varlen(held) + bytes([0x80, note, 0])         # note off, once it has been held
events += b'\x00' + b'\xff\x2f\x00'                     # end of track
data = chunk(b'MThd', struct.pack('>HHH', 0, 1, TICKS)) + chunk(b'MTrk', events)
open(path, 'wb').write(data)
PY

    fluidsynth -ni -g 0.8 -r "$RATE" -F "$work/note.wav" "$SF2" "$work/note.mid" >/dev/null 2>&1

    # Mono, trimmed to the note itself, faded out so the tail does not click,
    # and normalised so every instrument sits at the same level.
    ffmpeg -hide_banner -loglevel error -y -i "$work/note.wav" \
      -af "atrim=0:$(echo "$HOLD + $TAIL" | bc),areverse,silenceremove=start_periods=1:start_silence=0:start_threshold=-60dB,areverse,afade=t=out:st=$(echo "$HOLD + $TAIL - 0.25" | bc):d=0.25,loudnorm=I=-18:TP=-1.5:LRA=11" \
      -ac 1 -ar "$RATE" -b:a "$BITRATE" "$target"
  done
  echo "$id done"
done

du -sh "$OUT"
