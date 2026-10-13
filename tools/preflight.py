"""Environment preflight. Run it in the SAME environment that will render (e.g. inside the Codex session).

Catches the failures that cost the most time last project:
  - Chrome aborts (SIGABRT in TransformProcessType)  -> you are inside a sandbox; use the bypass flag
  - h264_videotoolbox -12903                          -> sandbox again, or no HW session; libx264 fallback
  - fonts / photos / voice files missing              -> placeholders or fallback fonts in the final film
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ok = True


def report(name, passed, hint=''):
    global ok
    ok &= passed
    print(f"{'PASS' if passed else 'FAIL'}  {name}" + (f'\n      -> {hint}' if hint and not passed else ''))


try:
    import imageio_ffmpeg, numpy, scipy, PIL, mutagen, playwright  # noqa: F401,E401
    report('python deps', True)
except ImportError as e:
    report('python deps', False, f'{e}; run: .venv/bin/pip install -r requirements.txt')
    sys.exit(1)

ff = imageio_ffmpeg.get_ffmpeg_exe()
report('ffmpeg', Path(ff).exists())
vt = subprocess.run([ff, '-hide_banner', '-f', 'lavfi', '-i', 'color=c=white:s=1920x1080:r=30', '-frames:v', '1',
                     '-c:v', 'h264_videotoolbox', '-f', 'null', '-'], capture_output=True, text=True)
report('h264_videotoolbox session', vt.returncode == 0,
       'hardware encoder unavailable (-12903 = sandboxed). Rendering still works with libx264, ~2-3x slower.')

from playwright.sync_api import sync_playwright  # noqa: E402
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel='chrome', headless=True)
        b.close()
    report('headless Google Chrome', True)
except Exception as e:  # noqa: BLE001
    report('headless Google Chrome', False,
           'Chrome could not start. SIGABRT/TargetClosedError = process sandbox (e.g. codex -s workspace-write). '
           'Run outside it: codex exec --dangerously-bypass-approvals-and-sandbox ..., or run `make` yourself. '
           f'Detail: {str(e).splitlines()[0]}')

html = (ROOT / 'scenes/index.html').read_text()
fonts = [l.split('url("../')[1].split('"')[0] for l in html.splitlines() if 'url("../assets/fonts' in l]
missing = [f for f in fonts if not (ROOT / f).exists()]
report(f'fonts ({len(fonts)})', not missing, f'missing {missing}; run: make assets')

film = (ROOT / 'scenes/film.js').read_text()
photos = sorted(set(p for p in __import__('re').findall(r"'([\w\-]+\.jpg)'", film)))
missing = [p for p in photos if not (ROOT / 'assets/photos' / p).exists()]
report(f'photos ({len(photos)})', not missing, f'missing {missing}; see assets/photos/CREDITS.md')

lines = json.loads((ROOT / 'script/narration.json').read_text())['lines']
missing = [l['id'] for l in lines if not list((ROOT / 'audio/vo').glob(l['id'] + '.*'))]
report(f'voice files ({len(lines)})', not missing, f'missing {missing}; run: make voice')
sys.exit(0 if ok else 1)
