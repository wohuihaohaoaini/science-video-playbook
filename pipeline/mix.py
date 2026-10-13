"""Place each VO line at its timeline start, duck the music, two-pass loudnorm, mux with the silent video.

Also writes the SRT next to the video.
"""
import json
import re
import subprocess
import time

import numpy as np
from scipy.io import wavfile

from common import BUILD, FFMPEG, ROOT, SR, load_project, load_timeline, save_json, timeline_digest

CFG = load_project()
X = CFG['mix']


def duck_envelope(n, lines):
    gain = np.ones(n, np.float32)
    low = 10 ** (X['duck_db'] / 20)
    att, rel = round(X['duck_attack_s'] * SR), round(X['duck_release_s'] * SR)
    for line in lines:
        s, e = round(line['start'] * SR), round(line['end'] * SR)
        stop = min(n, e + rel)
        v = np.full(stop - s, low, np.float32)
        a = min(att, e - s, len(v))
        v[:a] = np.linspace(1, low, att + 1)[:a]
        if stop > e:
            v[e - s:] = np.linspace(low, 1, rel + 1)[:stop - e]
        gain[s:stop] = np.minimum(gain[s:stop], v)
    return gain


def srt(lines):
    def ts(x):
        ms = round(x * 1000)
        return f'{ms // 3600000:02}:{ms // 60000 % 60:02}:{ms // 1000 % 60:02},{ms % 1000:03}'
    return '\n\n'.join(f"{i}\n{ts(l['start'])} --> {ts(l['end'])}\n{l['text']}" for i, l in enumerate(lines, 1)) + '\n'


def decode(path):
    out = subprocess.run([FFMPEG, '-hide_banner', '-loglevel', 'error', '-i', str(path), '-f', 'f32le', '-ar', str(SR),
                          '-ac', '2', 'pipe:1'], capture_output=True, check=True).stdout
    return np.frombuffer(out, '<f4').reshape(-1, 2)


def find_vo(line_id):
    for ext in ('mp3', 'wav', 'm4a'):
        p = ROOT / 'audio/vo' / f'{line_id}.{ext}'
        if p.exists():
            return p
    raise SystemExit(f'missing voice file for {line_id}')


def main():
    begun = time.monotonic()
    tl = load_timeline()
    metrics = json.loads((BUILD / 'audio_metrics.json').read_text())
    if metrics.get('timeline_sha256') != timeline_digest(tl):
        raise SystemExit('music/sfx were generated for a different timeline: run `make music`')
    video = BUILD / 'video_silent.mp4'
    if not video.exists():
        raise SystemExit('build/video_silent.mp4 missing: run `make full`')
    n = round(tl['total'] * SR)
    voice = np.zeros((n, 2), np.float32)
    for line in tl['lines']:
        clip = decode(find_vo(line['id']))
        pos = round(line['start'] * SR)
        # Guard: a VO file longer than its slot means durations changed after `prepare`.
        if pos + len(clip) > round(line['end'] * SR) + SR // 20:
            raise SystemExit(f"{line['id']} is longer than its timeline slot: rerun `make durations prepare`")
        voice[pos:pos + len(clip)] += clip[:n - pos]
    active = np.abs(voice) > 1e-3
    v_rms = float(np.sqrt(np.mean(voice[active] ** 2)))
    music = wavfile.read(BUILD / 'music.wav')[1].astype(np.float32) / 32768
    fx = wavfile.read(BUILD / 'sfx.wav')[1].astype(np.float32) / 32768
    fx_active = np.abs(fx) > 1e-3
    fx_gain = v_rms * 10 ** (-X['sfx_below_voice_db'] / 20) / float(np.sqrt(np.mean(fx[fx_active] ** 2))) if fx_active.any() else 0
    mixed = voice + music * duck_envelope(n, tl['lines'])[:, None] + fx * fx_gain
    mixed *= min(1., .9 / float(np.max(np.abs(mixed))))
    pre = BUILD / 'mix_pre.wav'
    wavfile.write(pre, SR, mixed)

    target = f"loudnorm=I={X['target_lufs']}:TP={X['true_peak_db']}:LRA=11"
    p1 = subprocess.run([FFMPEG, '-hide_banner', '-i', str(pre), '-af', target + ':print_format=json', '-f', 'null', '-'],
                        capture_output=True, text=True, check=True).stderr
    m = json.loads(re.findall(r'\{[^{}]+\}', p1)[-1])
    filt = (target + ':linear=true:print_format=json:' +
            f"measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
            f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
    out = CFG['outputs']['video']
    p2 = subprocess.run([FFMPEG, '-y', '-hide_banner', '-i', str(video), '-i', str(pre), '-map', '0:v:0', '-map', '1:a:0',
                         '-c:v', 'copy', '-af', filt, '-c:a', 'aac', '-b:a', '320k', '-ar', str(SR), '-ac', '2',
                         '-t', str(tl['total']), '-movflags', '+faststart', str(out)], capture_output=True, text=True)
    (BUILD / 'mix_pass2.log').write_text(p2.stderr)
    p2.check_returncode()
    CFG['outputs']['srt'].write_text(srt(tl['lines']), encoding='utf-8')
    result = {'video': str(out.relative_to(ROOT)), 'pass1': m, 'sfx_gain': fx_gain, 'elapsed': round(time.monotonic() - begun, 1)}
    save_json(BUILD / 'mix_metrics.json', result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
