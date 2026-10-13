"""Measure every voice file and write build/vo_durations.json; fail if a line has no audio.

film.js reads this file to lay out the timeline, so rerun it (and `make prepare`) after any re-recording.
"""
import json
import sys
from pathlib import Path

from mutagen import File as MutagenFile

ROOT = Path(__file__).resolve().parents[1]
lines = json.loads((ROOT / 'script/narration.json').read_text())['lines']
out, missing = {}, []
for line in lines:
    files = [p for p in (ROOT / 'audio/vo').glob(f"{line['id']}.*") if p.suffix in ('.mp3', '.wav', '.m4a')]
    if not files:
        missing.append(line['id'])
        continue
    out[line['id']] = round(MutagenFile(files[0]).info.length, 3)
if missing:
    sys.exit(f'missing voice files: {missing}')
(ROOT / 'build').mkdir(exist_ok=True)
(ROOT / 'build/vo_durations.json').write_text(json.dumps(out, indent=1))
total = sum(out.values())
print(f'{len(out)} lines, {total:.1f} s of speech ({sum(len(l["text"]) for l in lines) / total:.2f} chars/s)')
