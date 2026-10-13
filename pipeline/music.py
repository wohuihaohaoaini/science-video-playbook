"""Procedural score + SFX, driven by the browser timeline. No samples; deterministic seed.

Writes build/music.wav, build/sfx.wav (48 kHz stereo, no ducking) and build/audio_metrics.json.
Scene behaviour comes from project.json -> music.
"""
import time

import numpy as np
from scipy import signal
from scipy.io import wavfile

from common import BUILD, SR, load_project, load_timeline, save_json, timeline_digest

CFG = load_project()
M = CFG['music']
BEAT = 60 / M['bpm']


def edge(a, seconds=.003):
    n = min(len(a) // 2, round(seconds * SR))
    if n:
        ramp = np.sin(np.linspace(0, np.pi / 2, n)) ** 2
        a[:n] *= ramp
        a[-n:] *= ramp[::-1]
    return a


def lowpass(a, hz, axis=-1):
    return signal.sosfilt(signal.butter(2, hz, fs=SR, output='sos'), a, axis=axis)


def sfx(name, rng):
    dur = {'tick': .015, 'sweep': .5, 'thud': .6, 'branch': .4, 'warm': 3, 'pop': .025}[name]
    t = np.arange(round(dur * SR)) / SR
    if name == 'tick':
        a = np.sin(2 * np.pi * 2000 * t) * np.exp(-t / .004)
    elif name == 'thud':
        a = np.tanh(1.4 * np.sin(2 * np.pi * 55 * t)) * np.exp(-t / .12)
    elif name == 'branch':
        a = signal.chirp(t, 293.665, dur, 440) * np.sin(np.pi * t / dur) ** 2
    elif name == 'sweep':
        noise, a = rng.normal(size=len(t)), np.zeros_like(t)
        for i, f in enumerate(np.geomspace(400, 3000, 16)):
            band = signal.sosfilt(signal.butter(2, [f * .7, f * 1.3], btype='bandpass', fs=SR, output='sos'), noise)
            a += band * np.maximum(0, 1 - np.abs(t / dur * 15 - i))
        a *= np.sin(np.pi * t / dur) ** 2
    elif name == 'warm':
        noise = rng.normal(size=len(t))
        freq = np.fft.rfftfreq(len(t), 1 / SR)
        pink = np.fft.irfft(np.fft.rfft(noise) / np.sqrt(np.maximum(freq, 20)), n=len(t))
        a = lowpass(pink, 650) * np.sin(np.minimum(t / 1.5, 1) * np.pi / 2) ** 2 * np.minimum((dur - t) / .6, 1)
    else:  # pop
        hp = signal.butter(2, 3500, btype='highpass', fs=SR, output='sos')
        a = signal.sosfilt(hp, rng.normal(size=len(t))) * np.exp(-t / .004) * 10 ** (rng.uniform(-6, 0) / 20)
    a = edge(a)
    return (a / (np.max(np.abs(a)) or 1)).astype(np.float32)


def generate():
    begun = time.monotonic()
    tl = load_timeline()
    sc, total = tl['SCENES'], tl['total']
    order = [k for k in sc if k != 'END']
    nxt = {s: (sc[order[i + 1]] if i + 1 < len(order) else total) for i, s in enumerate(order)}
    refs = order[-1]
    n = round(total * SR)
    music, fx = np.zeros((n, 2), np.float32), np.zeros((n, 2), np.float32)

    def place(dst, a, start, gain=1., pan=0.):
        pos = round(start * SR)
        lo, hi = max(0, pos), min(n, pos + len(a))
        if hi > lo:
            dst[lo:hi] += a[lo - pos:hi - pos, None] * np.array([1 - pan, 1 + pan], np.float32) * gain

    def hz(m):
        return 440 * 2 ** ((m - 69) / 12)

    def inside(t, scenes):
        return any(sc[s] <= t < nxt[s] for s in scenes)

    # Pad: Dm9 - Bbmaj7 - Fmaj7 - C6, 4 bars each, detuned sines, long envelopes
    chords = [[50, 57, 60, 64, 69], [46, 53, 57, 62], [53, 60, 64, 69], [48, 55, 57, 64]]
    bar4 = 16 * BEAT
    for j, start in enumerate(np.arange(-bar4, total, bar4)):
        length = bar4 + 2
        t = np.arange(round(length * SR)) / SR
        chord = chords[j % 4]
        a = sum(np.sin(2 * np.pi * hz(m) * 2 ** (c / 1200) * t) for m in chord for c in (-3, 0, 3)) / (len(chord) * 3)
        a = lowpass(a, 2500) * np.minimum(t / 2, 1) * np.minimum((length - t) / 2, 1)
        place(music, a.astype(np.float32), start, .2)
    # Darker pad in dark scenes
    for s in M.get('dark_scenes', []):
        i0, i1 = round(sc[s] * SR), round(nxt[s] * SR)
        blend = np.minimum(np.arange(i1 - i0) / (.15 * SR), 1) * np.minimum(np.arange(i1 - i0)[::-1] / (.15 * SR), 1)
        music[i0:i1] = music[i0:i1] * (1 - blend[:, None]) + lowpass(music[i0:i1], 1200, axis=0) * blend[:, None]

    # Pulse (electron flow) and bass
    brk = M.get('pulse_break')
    b0 = next(l['start'] for l in tl['lines'] if l['id'] == brk['line']) + brk['offset'] if brk else -1
    b1 = b0 + brk['beats'] * BEAT if brk else -1
    quiet = M.get('dark_scenes', []) + [refs]
    for k, start in enumerate(np.arange(0, total, BEAT / 2)):
        if start < sc[M['pulse_from_scene']] or inside(start, quiet) or b0 <= start < b1:
            continue
        t = np.arange(round(.32 * SR)) / SR
        a = edge(np.sin(2 * np.pi * hz(74 if k % 2 == 0 else 81) * t) * np.exp(-t / .08)).astype(np.float32)
        place(music, a, start, .012, -.15 if k % 2 == 0 else .15)
    for start in np.arange(0, total, 4 * BEAT):
        if start < sc[M['bass_from_scene']] or inside(start, quiet):
            continue
        t = np.arange(round(1.8 * SR)) / SR
        root = chords[int(start // bar4) % 4][0] - 12
        place(music, edge(np.sin(2 * np.pi * hz(root) * t) * np.exp(-t / .65), .025).astype(np.float32), start, .032)

    rng = np.random.default_rng(M['seed'])
    if M.get('title_hit_scene'):
        place(music, sfx('thud', rng), sc[M['title_hit_scene']], .055)
    # Fade: 4 s after the last spoken line, then only a fading pad under the references
    last = tl['lines'][-1]['end']
    for lo, hi, secs in [(last, sc[refs], 4), (sc[refs], total, 12)]:
        i0, i1 = round(lo * SR), round(hi * SR)
        env = np.clip(1 - np.arange(i1 - i0) / SR / secs, 0, 1)
        if lo == sc[refs]:
            env *= max(0, 1 - (sc[refs] - last) / 4)
        music[i0:i1] *= env[:, None]
    music[:round(.05 * SR)] *= np.linspace(0, 1, round(.05 * SR))[:, None]
    for cue in tl['SFX_CUES']:
        place(fx, sfx(cue['name'], rng), cue['t'], .1 * cue['gain'])

    metrics = {}
    for name, a in [('music', music), ('sfx', fx)]:
        assert np.isfinite(a).all() and np.max(np.abs(a)) < 1, f'{name} clips'
        wavfile.write(BUILD / f'{name}.wav', SR, np.round(a * 32767).astype(np.int16))
        metrics[name] = {'peak_dbfs': round(float(20 * np.log10(np.max(np.abs(a)) + 1e-12)), 2)}
    metrics.update(timeline_sha256=timeline_digest(tl), seconds=total, elapsed=round(time.monotonic() - begun, 2))
    save_json(BUILD / 'audio_metrics.json', metrics)
    print(metrics)


if __name__ == '__main__':
    generate()
