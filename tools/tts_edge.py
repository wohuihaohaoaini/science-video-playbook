"""Synthesize narration lines with edge-tts (Microsoft neural voices, needs network).

  python tools/tts_edge.py                 # all lines that have no audio yet
  python tools/tts_edge.py L22 L24         # re-record specific lines

This is the command the voice agent (Antigravity) runs; see docs/briefs/06_配音任务书_Antigravity.md.
Engine/voice/rate come from project.json -> voice. Text is read verbatim; never edit it here.
"""
import asyncio
import json
import sys
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]
cfg = json.loads((ROOT / 'project.json').read_text())['voice']
lines = json.loads((ROOT / 'script/narration.json').read_text())['lines']
wanted = set(sys.argv[1:])
out = ROOT / 'audio/vo'
out.mkdir(parents=True, exist_ok=True)


async def main():
    for line in lines:
        target = out / f"{line['id']}.mp3"
        if (wanted and line['id'] not in wanted) or (not wanted and target.exists()):
            continue
        await edge_tts.Communicate(line['text'], cfg['voice'], rate=cfg['rate']).save(str(target))
        print('wrote', target.name)

asyncio.run(main())
