"""Reproducible TYAGA material Foley and expedition machine bank.

Original synthesis, no third-party recordings. Engine/winch loops, modal metal
and timber, granular surface steps, water and wind all have different sources.
Technical waveform checks are recorded; actual listening remains a separate QA.
"""
from pathlib import Path
import hashlib
import json
import math
import wave
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/assets/tyaga/audio'
OUT.mkdir(parents=True, exist_ok=True)
SR = 32000
TAU = math.tau
MANIFEST = []


def rng(name):
    seed = int.from_bytes(hashlib.sha256(('tyaga-original-v1/' + name).encode()).digest()[:8], 'little')
    return np.random.default_rng(seed)


def noise(n, name, low=40, high=8000, slope=.2):
    random = rng(name)
    freqs = np.fft.rfftfreq(n, 1 / SR)
    amplitudes = 1 / np.maximum(freqs, 30) ** slope
    amplitudes *= np.minimum(1, (freqs / max(low, 1)) ** 3)
    amplitudes *= 1 / np.sqrt(1 + (freqs / high) ** 8)
    phases = random.uniform(0, TAU, len(freqs))
    signal = np.fft.irfft(amplitudes * np.exp(1j * phases), n)
    return signal / max(1e-8, np.std(signal))


def tone(t, freq, decay, amount=1, start=0):
    ts = np.maximum(0, t - start)
    return amount * np.sin(TAU * freq * ts) * np.exp(-ts / decay) * (t >= start)


def modal(t, base, decay=.18, metal=False, start=0):
    ratios = [1, 2.76, 5.4, 8.93] if metal else [1, 1.51, 2.18, 3.06]
    amounts = [.62, .22, .10, .045]
    return sum(tone(t, base * ratio, decay / (1 + .40 * i), amounts[i], start) for i, ratio in enumerate(ratios))


def notes(t, semitones, spacing=.16, base=294):
    return sum(modal(t, base * 2 ** (note / 12), .30, False, i * spacing) * .38 for i, note in enumerate(semitones))


def render(name, seconds, loop=False):
    n = round(SR * seconds)
    t = np.arange(n) / SR
    seed = rng(name)
    grit = noise(n, name + '-grit', 150, 6000, .12)
    low = noise(n, name + '-low', 30, 550, .65)
    if name.startswith('step-'):
        surface = name[5:]
        if surface == 'stone':
            y = modal(t, 155, .045) * .65 + grit * .13 * np.exp(-t / .045)
        elif surface == 'wood':
            y = modal(t, 110, .10) * .65 + modal(t, 245, .06, start=.035) * .18 + grit * .04 * np.exp(-t / .04)
        elif surface == 'soil':
            y = low * .22 * np.exp(-t / .07) + grit * .16 * np.exp(-t / .035)
            for shift in [.055, .085, .115]:
                y += grit * .05 * np.exp(-np.maximum(0, t - shift) / .018) * (t >= shift)
        elif surface == 'mud':
            y = low * .22 * np.exp(-t / .12) + tone(t, 83, .06, .35)
            y += noise(n, name + '-suck', 300, 1800, 0) * .09 * np.sin(np.clip(t / .25, 0, 1) * math.pi) ** 2
        else:  # ice: short bright chips over a soft shoe impact.
            y = modal(t, 370, .065, True) * .15 + low * .11 * np.exp(-t / .045)
            y += grit * .12 * np.exp(-t / .085)
    elif name == 'jump':
        y = low * .15 * np.exp(-t / .10) + grit * .09 * np.sin(np.clip(t / .22, 0, 1) * math.pi) ** 2
    elif name == 'land':
        y = modal(t, 73, .12) * .7 + low * .20 * np.exp(-t / .10) + grit * .08 * np.exp(-t / .045)
    elif name in ['engine', 'engine-load']:
        load = name == 'engine-load'
        pulse = 23 if load else 19
        y = sum(np.sin(TAU * pulse * h * t + .13 * np.sin(TAU * 3 * t)) / (h ** 1.25) for h in range(1, 13)) * .22
        y = np.tanh(y * (2.3 if load else 1.7)) * .35
        y += low * (.08 if load else .04) + grit * .012 * (1 + .6 * np.sin(TAU * pulse * t))
        y += np.sin(TAU * (pulse * 4) * t) * .05
    elif name == 'brake':
        y = noise(n, name, 400, 5000, .3) * .14 * np.exp(-t / .18)
        y += tone(t, 740, .16, .04) + modal(t, 95, .06, start=.18) * .18
    elif name in ['winch', 'winch-idle']:
        active = name == 'winch'
        y = (np.sin(TAU * 96 * t) + .3 * np.sin(TAU * 192 * t)) * (.07 if active else .035)
        clicks = np.maximum(0, np.cos(TAU * 17 * t)) ** 20
        y += (grit * .05 + np.sin(TAU * 510 * t) * .09) * clicks
        y += low * (.025 if active else .01)
    elif name == 'rope-strain':
        y = tone(t, 147, .45, .23) + tone(t, 204, .27, .15, .12)
        y += grit * .08 * np.exp(-t / .35) * (1 + .6 * np.sin(TAU * 37 * t))
    elif name == 'rope-break':
        y = grit * .3 * np.exp(-t / .025) + modal(t, 215, .20, True) * .34
        y += low * .10 * np.exp(-t / .15) + modal(t, 350, .12, True, .13) * .12
    elif name == 'impact-metal':
        y = modal(t, 170, .28, True) * .65 + grit * .14 * np.exp(-t / .022)
    elif name == 'impact-wood':
        y = modal(t, 95, .16) * .70 + modal(t, 205, .10, start=.016) * .20 + grit * .07 * np.exp(-t / .035)
    elif name in ['strap', 'attach', 'detach']:
        y = modal(t, 490, .042, True) * .26 + grit * .05 * np.exp(-t / .025)
        y += modal(t, 230, .055, True, .08 if name != 'detach' else .05) * .25
        if name == 'strap':
            for d in [.15, .20, .25]:
                y += modal(t, 620, .02, True, d) * .10
    elif name == 'jack':
        y = modal(t, 195, .065, True) * .20 + grit * .03 * np.exp(-t / .07)
        y += modal(t, 320, .04, True, .17) * .20
        y += noise(n, name + '-oil', 300, 3000, .3) * .04 * np.sin(np.clip(t / .33, 0, 1) * math.pi) ** 2
    elif name == 'repair':
        y = sum(modal(t, f, .035, True, d) * a for f, d, a in [(390,0,.18),(450,.12,.14),(390,.23,.17),(660,.48,.12),(440,.58,.11)])
        y += grit * .035 * np.exp(-t / .4)
    elif name == 'cargo-damage':
        y = modal(t, 82, .19) * .50 + modal(t, 320, .17, True, .025) * .26 + grit * .12 * np.exp(-t / .055)
    elif name == 'water':
        y = noise(n, name + '-wash', 140, 2500, .5) * .07
        for _ in range(50):
            d = seed.uniform(.05, seconds - .5)
            ts = np.maximum(0, t - d)
            freq = seed.uniform(160, 550)
            y += np.sin(TAU * freq * (ts - .8 * ts * ts)) * np.exp(-ts / .07) * (t >= d) * seed.uniform(.02, .07)
        y += low * .03 * (1 + .4 * np.sin(TAU * t / seconds * 3))
    elif name == 'wind':
        y = noise(n, name + '-air', 80, 1600, .7) * .10 * (1 + .35 * np.sin(TAU * t / seconds))
        y += np.sin(TAU * 117 * t + .8 * np.sin(TAU * t / seconds)) * .012
    elif name == 'wind-gust':
        env = np.sin(np.clip(t / seconds, 0, 1) * math.pi) ** 1.4
        y = (noise(n, name, 60, 2200, .65) * .18 + tone(t, 150, 2, .015)) * env
    elif name == 'checkpoint':
        y = notes(t, [0, 4, 7], .13, 294) + modal(t, 125, .10, start=.03) * .08
    elif name == 'vote':
        y = notes(t, [0, 5], .13, 392) * .75
    elif name == 'success':
        y = notes(t, [0, 4, 7, 12], .20, 294)
        y += notes(t - .5, [0, 7], .22, 147) * (t >= .5) * .5
    elif name == 'cargo-lost':
        y = notes(t, [0, -3, -7], .22, 247) * .7 + low * .025 * np.exp(-t / .5)
    elif name == 'ui-open':
        y = modal(t, 390, .07) * .28 + grit * .01 * np.exp(-t / .025)
    elif name == 'ui-error':
        y = notes(t, [0, -2], .11, 196) * .42
    elif name == 'deck-unfold':
        y = modal(t, 110, .14) * .27 + modal(t, 135, .18, start=.21) * .40
        y += modal(t, 420, .04, True, .32) * .13 + grit * .025 * np.exp(-t / .26)
    elif name == 'splash':
        y = noise(n, name, 120, 6500, .2) * .24 * np.exp(-t / .22) + low * .17 * np.exp(-t / .12)
    else:
        raise ValueError(name)
    y = np.nan_to_num(y)
    y -= np.mean(y)
    if loop:
        # Keep one crossfaded overlap, then the untouched middle. The new loop
        # boundary follows adjacent original samples; duplicating the overlap at
        # both ends would introduce a spurious sample discontinuity.
        k = round(.06 * SR)
        a = np.linspace(0, 1, k)
        blend = y[-k:] * (1 - a) + y[:k] * a
        y = np.concatenate((blend, y[k:-k]))
        seconds = len(y) / SR
    else:
        fade_in = min(round(.006 * SR), n // 4)
        fade_out = min(round(.075 * SR), n // 4)
        y[:fade_in] *= np.linspace(0, 1, fade_in) ** 1.5
        y[-fade_out:] *= np.linspace(1, 0, fade_out) ** 1.5
    peak = np.max(np.abs(y))
    if peak > .78:
        y *= .78 / peak
    pcm = (y * 32767).astype('<i2')
    path = OUT / (name + '.wav')
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(pcm.tobytes())
    entry = dict(assetId=name, runtimePath='/assets/tyaga/audio/' + name + '.wav',
        source='games/tyaga/art/source/generate_audio.py', creation='original deterministic material/machine synthesis; no sampled recordings',
        license='project-original', seconds=seconds, loop=loop, sampleRate=SR, channels=1,
        peakDbFS=round(20 * math.log10(max(1e-10, np.max(np.abs(y)))), 2),
        rmsDbFS=round(20 * math.log10(max(1e-10, np.sqrt(np.mean(y * y)))), 2),
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(), bytes=path.stat().st_size,
        validation={'waveform':'verified','listening':'pending','inGameMix':'pending'})
    MANIFEST.append(entry)
    print(name,entry['peakDbFS'],entry['rmsDbFS'],path.stat().st_size)


def main():
    specs = [('step-stone',.28),('step-wood',.38),('step-soil',.32),('step-mud',.4),('step-ice',.3),
        ('jump',.3),('land',.5),('engine',2,True),('engine-load',2,True),('brake',.5),
        ('winch',2,True),('winch-idle',2,True),('rope-strain',.8),('rope-break',.7),
        ('impact-metal',.8),('impact-wood',.65),('strap',.5),('attach',.3),('detach',.3),
        ('jack',.5),('repair',.9),('cargo-damage',.8),('water',6,True),('wind',6,True),
        ('wind-gust',2.4),('checkpoint',1.1),('vote',.65),('success',2.2),('cargo-lost',1.6),
        ('ui-open',.22),('ui-error',.5),('deck-unfold',.7),('splash',.8)]
    for spec in specs:
        render(*spec)
    (OUT/'manifest.json').write_text(json.dumps({'version':'tyaga-audio@1','assets':MANIFEST},ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':
    main()
