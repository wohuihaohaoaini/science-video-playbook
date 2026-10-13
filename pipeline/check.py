"""Final QA: container/stream specs, exact frame count, loudness, per-scene review frames + contact sheet.

Exits non-zero on any failed assertion. Visual review of build/check/contact.jpg is still a human (or Claude) step.
"""
import json
import math
import re
import subprocess

from PIL import Image

from common import BUILD, FFMPEG, load_project, load_timeline, save_json

CFG = load_project()


def main():
    tl = load_timeline()
    W, H, FPS = CFG['width'], CFG['height'], CFG['fps']
    movie = CFG['outputs']['video']
    meta = subprocess.run([FFMPEG, '-hide_banner', '-i', str(movie)], capture_output=True, text=True).stderr
    v = next(l for l in meta.splitlines() if 'Video:' in l)
    a = next(l for l in meta.splitlines() if 'Audio:' in l)
    assert f'{W}x{H}' in v and re.search(rf'\b{FPS} fps\b', v), v
    assert 'h264' in v and 'yuv420p' in v and 'bt709' in v, v
    assert 'aac' in a and '48000 Hz' in a and 'stereo' in a, a

    dec = subprocess.run([FFMPEG, '-hide_banner', '-v', 'error', '-xerror', '-i', str(movie), '-map', '0:v:0',
                          '-progress', 'pipe:1', '-f', 'null', '-'], capture_output=True, text=True, check=True).stdout
    frames = int(re.findall(r'^frame=(\d+)', dec, re.M)[-1])
    assert frames == math.ceil(tl['total'] * FPS), f'frame count {frames}'
    assert tl['total'] >= CFG['min_total_seconds'] - 1e-6, 'film shorter than min_total_seconds'

    loud = subprocess.run([FFMPEG, '-hide_banner', '-i', str(movie), '-map', '0:a:0', '-af', 'ebur128=peak=true',
                           '-f', 'null', '-'], capture_output=True, text=True, check=True).stderr.rsplit('Summary:', 1)[1]
    lufs = float(re.search(r'I:\s*(-?\d+\.\d+) LUFS', loud)[1])
    peak = float(re.search(r'Peak:\s*(-?\d+\.\d+) dBFS', loud)[1])
    assert abs(lufs - CFG['mix']['target_lufs']) <= .5, f'loudness {lufs}'
    assert peak <= -1.0, f'true peak {peak}'

    sc = tl['SCENES']
    order = [k for k in sc if k != 'END']
    refs = order[-1]
    assert abs(sc['END'] - sc[refs] - CFG['refs_seconds']) < 1e-3, 'reference section length'
    points = {s: (sc[s] + (sc[order[i + 1]] if i + 1 < len(order) else sc['END'])) / 2 for i, s in enumerate(order)}
    half = CFG['refs_seconds'] / 2
    points.update(refs_1=sc[refs] + half / 2, refs_2=sc[refs] + half * 1.5)
    out = BUILD / 'check'
    out.mkdir(exist_ok=True)
    thumbs = []
    for name, t in points.items():
        png = out / f'{name}.png'
        subprocess.run([FFMPEG, '-y', '-hide_banner', '-loglevel', 'error', '-ss', f'{round(t * FPS) / FPS:.3f}',
                        '-i', str(movie), '-frames:v', '1', str(png)], check=True)
        thumbs.append(Image.open(png).convert('RGB').resize((640, 360)))
    cols = 3
    sheet = Image.new('RGB', (640 * cols, 360 * math.ceil(len(thumbs) / cols)), 'white')
    for i, im in enumerate(thumbs):
        sheet.paste(im, (i % cols * 640, i // cols * 360))
    sheet.save(out / 'contact.jpg', quality=88)

    result = {'video': v.strip(), 'audio': a.strip(), 'frames': frames, 'seconds': tl['total'], 'lufs': lufs,
              'true_peak_db': peak, 'review': 'open build/check/contact.jpg and the full-size PNGs'}
    save_json(BUILD / 'check.json', result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
