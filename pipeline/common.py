"""Shared paths, project config and timeline helpers."""
import hashlib
import json
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build'
OUT = ROOT / 'out'
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
SR = 48000


def load_project():
    cfg = json.loads((ROOT / 'project.json').read_text())
    cfg['outputs'] = {k: ROOT / v.format(slug=cfg['slug']) for k, v in cfg['outputs'].items()}
    return cfg


def save_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def narration():
    return json.loads((ROOT / 'script/narration.json').read_text())


def load_timeline():
    """The only valid timeline is the one exported from the browser by `render.py prepare`."""
    path = BUILD / 'timeline.json'
    if not path.exists():
        raise SystemExit('build/timeline.json missing: run `make prepare` first')
    tl = json.loads(path.read_text())
    if tl.get('source') != 'chrome-filmReady':
        raise SystemExit('timeline.json was not exported from the browser; run `make prepare`')
    n = len(narration()['lines'])
    if len(tl['lines']) != n:
        raise SystemExit(f'timeline has {len(tl["lines"])} lines but narration.json has {n}; run `make prepare`')
    if abs(tl['total'] - tl['FILM']['duration']) > 1e-6:
        raise SystemExit('timeline total and FILM.duration disagree')
    return tl


def timeline_digest(tl):
    keys = ['total', 'refsStart', 'lines', 'SCENES', 'SFX_CUES']
    blob = json.dumps({k: tl[k] for k in keys}, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(blob.encode()).hexdigest()
