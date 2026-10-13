"""Download the open-source fonts (SIL OFL) and the example's Wikimedia Commons photos.

  python tools/fetch_assets.py fonts
  python tools/fetch_assets.py photos     # reads assets/photos/sources.json
"""
import io
import json
import ssl
import sys
import urllib.request
import zipfile
from pathlib import Path

import certifi
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
UA = {'User-Agent': 'sci-video-pipeline/1.0 (educational video; contact via GitHub)'}
INTER = 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip'
NOTO = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/SubsetOTF/SC/NotoSansSC-{w}.otf'
NOTO_LICENSE = 'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE'
WEIGHTS = ['Regular', 'Medium', 'Bold', 'Black']


def get(url):
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120, context=ctx) as r:
        return r.read()


def fonts():
    out = ROOT / 'assets/fonts'
    (out / 'LICENSES').mkdir(parents=True, exist_ok=True)
    z = zipfile.ZipFile(io.BytesIO(get(INTER)))
    for w in WEIGHTS:
        (out / f'Inter-{w}.ttf').write_bytes(z.read(f'extras/ttf/Inter-{w}.ttf'))
    (out / 'LICENSES/Inter-OFL.txt').write_bytes(z.read('LICENSE.txt'))
    for w in WEIGHTS:
        (out / f'NotoSansSC-{w}.otf').write_bytes(get(NOTO.format(w=w)))
    (out / 'LICENSES/NotoSansSC-OFL.txt').write_bytes(get(NOTO_LICENSE))
    print('fonts ok:', sorted(p.name for p in out.glob('*.*')))


def photos():
    out = ROOT / 'assets/photos'
    for name, url in json.loads((out / 'sources.json').read_text()).items():
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(get(url)))).convert('RGB')
        im.thumbnail((2400, 2400))
        im.save(out / name, quality=90)
        print('photo ok:', name, im.size)


if __name__ == '__main__':
    {'fonts': fonts, 'photos': photos}[sys.argv[1]]()
