"""Deterministic canvas renderer: headless Chrome -> raw RGB -> ffmpeg.

  python pipeline/render.py prepare                 # export browser timeline + cover
  python pipeline/render.py still --t 75            # one PNG frame for review
  python pipeline/render.py sample --scene S3       # 10 s sample + review frames
  python pipeline/render.py full                    # whole film (requires a passed sample)
"""
import argparse
import base64
from concurrent.futures import ProcessPoolExecutor
from contextlib import contextmanager
import io
import json
import math
import socket
import subprocess
import sys
import time

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

from common import ROOT, BUILD, OUT, FFMPEG, load_project, load_timeline, save_json, timeline_digest

CFG = load_project()
W, H, FPS = CFG['width'], CFG['height'], CFG['fps']
SUB, SHUTTER = CFG['render']['subframes'], CFG['render']['shutter']


@contextmanager
def local_server():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    log = (BUILD / 'http.log').open('a')
    # Not `python -m http.server`: its listen backlog of 5 drops connections under 7 parallel browsers.
    server = subprocess.Popen([sys.executable, str(ROOT / 'pipeline/serve.py'), str(port), str(ROOT)],
                              stdout=log, stderr=log)
    try:
        for _ in range(100):
            try:
                socket.create_connection(('127.0.0.1', port), timeout=.1).close()
                break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError('local http server did not start')
        yield f'http://127.0.0.1:{port}/scenes/index.html'
    finally:
        server.terminate()
        server.wait(timeout=5)
        log.close()


def launch(pw):
    # System Chrome; no Chromium download. Fails with SIGABRT inside restrictive sandboxes (see docs/LESSONS.md).
    return pw.chromium.launch(channel='chrome', headless=True)


def open_page(browser, url, attempts=3):
    for attempt in range(1, attempts + 1):
        page = browser.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('response', lambda r: errors.append(f'HTTP {r.status} {r.url}') if r.status >= 400 and not r.url.endswith('favicon.ico') else None)
        try:
            page.goto(url)
            page.wait_for_function('typeof filmReady === "function"', timeout=15000)
            page.evaluate('async () => { await filmReady(); }')
            if errors:
                raise RuntimeError(errors)
            return page
        except Exception as e:  # noqa: BLE001
            page.close()
            if attempt == attempts:
                raise
            print(f'page load failed (attempt {attempt}): {str(e).splitlines()[0]}; retrying', flush=True)
            time.sleep(attempt)


def pick_encoder():
    listing = subprocess.run([FFMPEG, '-hide_banner', '-encoders'], capture_output=True, text=True, check=True).stdout
    chosen = 'libx264'
    if 'h264_videotoolbox' in listing:
        probe = subprocess.run([FFMPEG, '-hide_banner', '-f', 'lavfi', '-i', f'color=c=white:s={W}x{H}:r={FPS}',
                                '-frames:v', '1', '-c:v', 'h264_videotoolbox', '-f', 'null', '-'], capture_output=True, text=True)
        (BUILD / 'encoder_probe.log').write_text(probe.stderr)
        if probe.returncode == 0:
            chosen = 'h264_videotoolbox'
    save_json(BUILD / 'encoder.json', {'ffmpeg': FFMPEG, 'selected': chosen})
    return chosen


def encoder_args(enc):
    if enc == 'h264_videotoolbox':
        return ['-c:v', enc, '-b:v', CFG['render']['videotoolbox_bitrate']]
    return ['-c:v', 'libx264', '-preset', 'medium', '-crf', str(CFG['render']['x264_crf']), '-threads', '2']


CAPTURE = f'''async (t) => {{
  const c = document.querySelector('#c'), out = [];
  for (let k = 0; k < {SUB}; k++) {{
    renderFrame(t + k / ({SUB} * {FPS}) * {SHUTTER});
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    out.push(await new Promise(r => {{ const f = new FileReader(); f.onload = () => r(f.result.split(',')[1]); f.readAsDataURL(blob); }}));
  }}
  return out;
}}'''


def capture(page, t):
    frames = [np.asarray(Image.open(io.BytesIO(base64.b64decode(b))).convert('RGB'), dtype=np.uint16)
              for b in page.evaluate(CAPTURE, t)]
    return ((sum(frames) + len(frames) // 2) // len(frames)).astype(np.uint8)


def prepare(url):
    with sync_playwright() as pw:
        browser = launch(pw)
        try:
            page = open_page(browser, url)
            tl = page.evaluate('() => ({...TIMELINE, SCENES: window.SCENES, SFX_CUES: getSfxCues(), FILM: window.FILM})')
            tl['source'] = 'chrome-filmReady'
            save_json(BUILD / 'timeline.json', tl)
            save_json(BUILD / 'fonts.json', page.evaluate('() => [...document.fonts].map(f => [f.family, f.weight, f.status])'))
            page.evaluate('() => renderCover()')
            png = page.evaluate("() => document.querySelector('#c').toDataURL('image/png').split(',')[1]")
            CFG['outputs']['cover'].parent.mkdir(exist_ok=True)
            CFG['outputs']['cover'].write_bytes(base64.b64decode(png))
        finally:
            browser.close()
    bad = [f for f in json.loads((BUILD / 'fonts.json').read_text()) if f[2] != 'loaded']
    if bad:
        raise SystemExit(f'fonts not loaded: {bad}')
    print(json.dumps({'total': tl['total'], 'refsStart': tl['refsStart'], 'scenes': tl['SCENES'], 'timeline_sha256': timeline_digest(tl)}, ensure_ascii=False))


def still(url, t):
    with sync_playwright() as pw:
        browser = launch(pw)
        try:
            page = open_page(browser, url)
            path = BUILD / 'stills' / f'{t:07.2f}.png'
            path.parent.mkdir(exist_ok=True)
            Image.fromarray(capture(page, t)).save(path)
            print(path)
        finally:
            browser.close()


def worker(job):
    index, first, last, offset, url, enc, folder = job
    begun = time.monotonic()
    part = folder / f'part_{index:02}.mp4'
    cmd = [FFMPEG, '-y', '-hide_banner', '-loglevel', 'warning', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
           '-r', str(FPS), '-i', 'pipe:0', '-an', *encoder_args(enc), '-pix_fmt', 'yuv420p',
           '-vf', 'scale=in_range=full:out_range=tv:out_color_matrix=bt709', '-color_primaries', 'bt709',
           '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-fps_mode', 'cfr', str(part)]
    with sync_playwright() as pw, part.with_suffix('.log').open('w') as log:
        browser = launch(pw)
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=log)
        try:
            page = open_page(browser, url)
            for f in range(first, last):
                proc.stdin.write(capture(page, offset + f / FPS).tobytes())
                if (f - first + 1) % 300 == 0:
                    print(f'worker {index}: {f - first + 1}/{last - first}', flush=True)
            proc.stdin.close()
            if proc.wait():
                raise RuntimeError(part.with_suffix('.log').read_text())
        except BaseException:
            proc.kill()
            raise
        finally:
            browser.close()
    return {'part': part.name, 'frames': last - first, 'seconds': round(time.monotonic() - begun, 1)}


def render(url, offset, count, folder, output):
    enc = pick_encoder()
    workers = CFG['render']['workers']
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob('part_*'):
        old.unlink()
    jobs = [(i, count * i // workers, count * (i + 1) // workers, offset, url, enc, folder) for i in range(workers)]
    begun = time.monotonic()
    with ProcessPoolExecutor(max_workers=workers) as pool:
        parts = list(pool.map(worker, jobs))
    listing = folder / 'concat.txt'
    listing.write_text(''.join(f"file '{folder / f'part_{i:02}.mp4'}'\n" for i in range(workers)))
    subprocess.run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'warning', '-f', 'concat', '-safe', '0', '-i', str(listing),
                    '-c', 'copy', '-movflags', '+faststart', str(output)], check=True)
    elapsed = time.monotonic() - begun
    metrics = {'frames': count, 'encoder': enc, 'workers': workers, 'subframes': SUB, 'elapsed_seconds': round(elapsed, 1),
               'fps_rendered': round(count / elapsed, 1), 'parts': parts}
    print(json.dumps(metrics, ensure_ascii=False))
    return metrics


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['prepare', 'still', 'sample', 'full'])
    ap.add_argument('--t', type=float, default=0, help='still: time in seconds')
    ap.add_argument('--scene', default='S3', help='sample: start at this scene')
    ap.add_argument('--seconds', type=float, default=10)
    a = ap.parse_args()
    BUILD.mkdir(exist_ok=True)
    OUT.mkdir(exist_ok=True)
    with local_server() as url:
        if a.mode == 'prepare':
            return prepare(url)
        tl = load_timeline()
        if a.mode == 'still':
            return still(url, a.t)
        if a.mode == 'sample':
            out = BUILD / 'sample.mp4'
            m = render(url, tl['SCENES'][a.scene], round(a.seconds * FPS), BUILD / 'sample_parts', out)
            check = BUILD / 'sample_check'
            check.mkdir(exist_ok=True)
            for t in [0, a.seconds * .25, a.seconds * .5, a.seconds * .75, a.seconds - .5]:
                subprocess.run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'error', '-ss', f'{t:.2f}', '-i', str(out),
                                '-frames:v', '1', str(check / f'{t:05.2f}.png')], check=True)
            est = math.ceil(tl['total'] * FPS) / m['fps_rendered']
            save_json(BUILD / 'sample_review.json', {'status': 'awaiting-review', 'estimated_full_seconds': round(est)})
            print(f'review build/sample_check/*.png, then set "status": "passed" in build/sample_review.json '
                  f'(full render estimate: {est / 60:.1f} min)')
            return
        review = BUILD / 'sample_review.json'
        if not review.exists() or json.loads(review.read_text()).get('status') != 'passed':
            raise SystemExit('render a sample, review it, and mark build/sample_review.json as passed first')
        m = render(url, 0, math.ceil(tl['total'] * FPS), BUILD / 'film_parts', BUILD / 'video_silent.mp4')
        save_json(BUILD / 'render_metrics.json', m)


if __name__ == '__main__':
    main()
