#!/usr/bin/env python3
"""Rebuild Shift's original GLB, vector artwork and PCM sound assets.

No Blender installation or third-party model is needed. glTF units are metres,
Y is up and a drone's muzzle points along +X. UVs and face normals are exported.
Runtime collisions come exclusively from the authoritative arena definitions.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
import struct
import wave
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'shift-assets'
TAU = math.tau
MATERIALS = {
    'floor': ('#27343c', .5, .83, None),
    'edge': ('#536a73', .7, .45, None),
    'dark': ('#111d24', .65, .65, None),
    'ivory': ('#ece7da', .35, .48, None),
    'mark': ('#a5b6b6', .2, .7, None),
    'teal': ('#3cd8c6', .45, .45, '#217e74'),
    'amber': ('#ffc066', .5, .5, '#875922'),
    'light': ('#c6fff7', .1, .4, '#69d3c0'),
    'charge': ('#f4dc8f', .2, .5, '#a18737'),
    'cover': ('#60767a', .6, .63, None),
    'black': ('#081219', .2, .88, None),
}


def rgb(value: str):
    # glTF baseColorFactor is linear light, unlike CSS/sRGB colours.
    return [((v / 255 + .055) / 1.055) ** 2.4 if v > 10 else v / 3294.6
            for v in (int(value[i:i + 2], 16) for i in (1, 3, 5))]


class Model:
    def __init__(self, name: str):
        self.name = name
        self.faces = defaultdict(list)

    def triangle(self, a, b, c, mat):
        ab = [b[i] - a[i] for i in range(3)]
        ac = [c[i] - a[i] for i in range(3)]
        normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]]
        length = math.sqrt(sum(v * v for v in normal)) or 1
        normal = [v / length for v in normal]
        self.faces[mat].append((a, b, c, normal))

    def quad(self, a, b, c, d, mat):
        self.triangle(a, b, c, mat)
        self.triangle(a, c, d, mat)

    def prism(self, points, bottom, top, mat, side=None):
        """Convex clockwise X/Z polygon extruded up, with flat-shaded edges."""
        count = len(points)
        center = (sum(p[0] for p in points) / count, sum(p[1] for p in points) / count)
        for i in range(count):
            p, q = points[i], points[(i + 1) % count]
            self.triangle((center[0], top, center[1]), (p[0], top, p[1]), (q[0], top, q[1]), mat)
            self.triangle((center[0], bottom, center[1]), (q[0], bottom, q[1]), (p[0], bottom, p[1]), side or mat)
            self.quad((p[0], bottom, p[1]), (q[0], bottom, q[1]), (q[0], top, q[1]), (p[0], top, p[1]), side or mat)

    def bevel(self, x, z, w, d, bottom, top, mat, side=None, cut=.12):
        a, b = w / 2, d / 2
        k = min(cut, a * .7, b * .7)
        self.prism([(x - a + k, z - b), (x - a, z - b + k), (x - a, z + b - k), (x - a + k, z + b),
                    (x + a - k, z + b), (x + a, z + b - k), (x + a, z - b + k), (x + a - k, z - b)], bottom, top, mat, side)

    def box(self, x, y, z, w, h, d, mat):
        self.bevel(x, z, w, d, y - h / 2, y + h / 2, mat, cut=0)

    def cylinder(self, x, z, radius, bottom, top, mat, count=16, side=None):
        self.prism([(x + math.cos(-i * TAU / count) * radius, z + math.sin(-i * TAU / count) * radius) for i in range(count)], bottom, top, mat, side)

    def torus(self, x, y, z, radius, tube, mat, segments=24, tube_segments=6):
        for i in range(segments):
            for j in range(tube_segments):
                def point(u, v):
                    theta, phi = u * TAU / segments, v * TAU / tube_segments
                    return (x + (radius + tube * math.cos(phi)) * math.cos(theta), y + tube * math.sin(phi), z + (radius + tube * math.cos(phi)) * math.sin(theta))
                self.quad(point(i, j), point(i, j + 1), point(i + 1, j + 1), point(i + 1, j), mat)

    def ellipsoid(self, x, y, z, rx, ry, rz, mat, slices=18, rings=8):
        for i in range(slices):
            for j in range(rings):
                def point(u, v):
                    t, p = u * TAU / slices, -math.pi / 2 + v * math.pi / rings
                    return (x + rx * math.cos(p) * math.cos(t), y + ry * math.sin(p), z + rz * math.cos(p) * math.sin(t))
                self.quad(point(i, j), point(i, j + 1), point(i + 1, j + 1), point(i + 1, j), mat)

    def export(self):
        binary = bytearray()
        views, accessors, primitives, materials = [], [], [], []

        def accessor(data, kind, components):
            while len(binary) % 4:
                binary.append(0)
            offset = len(binary)
            flat = [float(v) for item in data for v in item]
            packed = struct.pack('<' + str(len(flat)) + 'f', *flat)
            binary.extend(packed)
            views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(flat) * 4, 'target': 34962})
            result = {'bufferView': len(views) - 1, 'componentType': 5126, 'count': len(data), 'type': kind}
            if kind == 'VEC3':
                # Accessor bounds describe the exported float32 bytes, not Python doubles.
                quantized = struct.unpack('<' + str(len(flat)) + 'f', packed)
                result['min'] = [min(quantized[i::components]) for i in range(components)]
                result['max'] = [max(quantized[i::components]) for i in range(components)]
            accessors.append(result)
            return len(accessors) - 1

        for key, faces in self.faces.items():
            pos, normals, uv = [], [], []
            for a, b, c, normal in faces:
                for p in (a, b, c):
                    pos.append(p)
                    normals.append(normal)
                    # World-scaled planar UVs: custom materials can be added without re-export.
                    uv.append((p[0], p[2]) if abs(normal[1]) > .5 else (p[0] + p[2], p[1]))
            color, metal, rough, emissive = MATERIALS[key]
            material = {'name': key, 'pbrMetallicRoughness': {'baseColorFactor': rgb(color) + [1], 'metallicFactor': metal, 'roughnessFactor': rough}}
            if emissive:
                material['emissiveFactor'] = rgb(emissive)
            materials.append(material)
            primitives.append({'attributes': {'POSITION': accessor(pos, 'VEC3', 3), 'NORMAL': accessor(normals, 'VEC3', 3), 'TEXCOORD_0': accessor(uv, 'VEC2', 2)}, 'material': len(materials) - 1})
        bounds = [p for fs in self.faces.values() for face in fs for p in face[:3]]
        doc = {'asset': {'version': '2.0', 'generator': 'Iva Games Shift procedural workshop v1'}, 'scene': 0,
               'scenes': [{'nodes': [0]}], 'nodes': [{'name': self.name, 'mesh': 0}], 'meshes': [{'name': self.name, 'primitives': primitives}],
               'buffers': [{'byteLength': len(binary)}], 'bufferViews': views, 'accessors': accessors, 'materials': materials,
               'extras': {'metresPerUnit': 1, 'up': '+Y', 'forward': '+X', 'collision': 'authoritative arena cover rectangles; no render mesh collision', 'anchor': [0, 0, 0]}}
        js = json.dumps(doc, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        binary += b'\0' * (-len(binary) % 4)
        data = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binary), 0x004E4942) + binary
        path = OUT / 'models' / (self.name + '.glb')
        path.write_bytes(data)
        return {'triangles': sum(len(fs) for fs in self.faces.values()), 'primitives': len(primitives), 'bounds': {'min': [min(p[i] for p in bounds) for i in range(3)], 'max': [max(p[i] for p in bounds) for i in range(3)]}}


def models():
    results = {}
    m = Model('module-slab')
    m.bevel(0, 0, 7.9, 7.9, -.45, -.12, 'edge', 'dark', .32)
    m.bevel(0, 0, 7.72, 7.72, -.12, 0, 'floor', 'edge', .23)
    # Corners, inset metal ribs and two-panel centre: the slab silhouette is visible during a move.
    for s in (-1, 1):
        for t in (-1, 1):
            m.bevel(s * 3.53, t * 3.53, .45, .45, .012, .075, 'edge', cut=.1)
            m.box(s * 2.43, -.27, t * 3.91, 1.4, .11, .07, 'edge')
            m.box(s * 3.91, -.27, t * 2.43, .07, .11, 1.4, 'edge')
        m.box(s * 1.92, .008, 0, .012, .01, 7.08, 'edge')
        m.box(0, .008, s * 1.92, 7.08, .01, .012, 'edge')
        for t in (-1, 1):
            m.box(s * 3.05, .015, t * 3.37, .46, .014, .035, 'mark')
    results[m.name] = m.export()

    m = Model('wall-profile')
    # One north-edge profile, 2m clear aperture. Clone at four quarter turns.
    for side in (-1, 1):
        m.bevel(side * 2.48, -3.85, 2.84, .25, 0, .53, 'edge', 'dark', .1)
        m.bevel(side * 1.1, -3.84, .18, .34, 0, .75, 'edge', cut=.035)
        m.box(side * 2.48, .54, -3.85, 2.55, .035, .1, 'mark')
        m.box(side * 1.11, .48, -3.65, .085, .3, .065, 'ivory')
    m.box(0, .02, -3.84, 2.05, .04, .35, 'edge')
    results[m.name] = m.export()

    m = Model('door')
    m.bevel(0, 0, 1.96, .18, 0, .65, 'edge', 'dark', .035)
    for x in (-.65, -.22, .22, .65):
        m.box(x, .38, -.105, .04, .4, .025, 'ivory')
    m.box(0, .68, 0, 1.8, .045, .16, 'charge')
    m.box(0, .4, -.125, .32, .18, .04, 'dark')
    results[m.name] = m.export()

    m = Model('shaft')
    m.bevel(0, 0, 7.96, 7.96, -1.6, -1.4, 'black', cut=.22)
    for s in (-1, 1):
        m.box(s * 3.8, -.82, 0, .12, 1.16, 7.6, 'dark')
        m.box(0, -.82, s * 3.8, 7.6, 1.16, .12, 'dark')
        for p in (-2.7, 2.7):
            m.box(p, -.9, 0, .12, .13, 7.6, 'edge')
            m.box(0, -1.03, p, 7.6, .1, .13, 'edge')
        for j in range(-3, 4):
            m.box(j, -1.35, s * 3.55, .36, .06, .11, 'charge')
    results[m.name] = m.export()

    m = Model('airlock')
    m.bevel(0, 0, 3.8, 23.85, -.43, 0, 'floor', 'edge', .28)
    m.box(-1.85, .16, 0, .12, .32, 23.5, 'edge')
    for z, length in [(-10.5, 2.8), (-4, 5.8), (4, 5.8), (10.5, 2.8)]:
        m.box(1.85, .16, z, .12, .32, length, 'edge')
    for side in (-1, 1):
        for z in (-10, -6, -2, 2, 6, 10):
            m.box(side * 1.48, .018, z, .18, .02, 1.4, 'mark')
    results[m.name] = m.export()

    m = Model('cover')
    m.bevel(0, 0, 1, 1, 0, .79, 'cover', 'dark', .13)
    m.bevel(0, 0, .91, .91, .79, .88, 'cover', 'edge', .1)
    for side in (-1, 1):
        m.box(side * .34, .91, 0, .06, .06, .7, 'edge')
        m.box(side * .489, .46, 0, .018, .45, .4, 'edge')
    results[m.name] = m.export()

    m = Model('pillar')
    m.bevel(0, 0, 1, 1, 0, .2, 'edge', 'dark', .22)
    m.bevel(0, 0, .76, .76, .2, 1.3, 'cover', 'dark', .15)
    m.bevel(0, 0, .87, .87, 1.3, 1.4, 'edge', cut=.15)
    m.box(0, 1.42, 0, .35, .025, .12, 'ivory')
    results[m.name] = m.export()

    m = Model('drone-teal')
    m.ellipsoid(0, .25, 0, .245, .15, .215, 'teal')
    m.cylinder(-.035, 0, .19, .13, .20, 'dark', 20)
    m.bevel(.08, 0, .28, .28, .3, .38, 'ivory', 'edge', .08)
    m.box(.222, .3, 0, .095, .085, .09, 'dark')
    m.box(.277, .3, 0, .014, .055, .06, 'light')
    for z in (-.11, .11):
        m.box(-.1, .382, z, .15, .025, .032, 'light')
    m.torus(0, .09, 0, .16, .023, 'teal', 18)
    results[m.name] = m.export()

    m = Model('drone-amber')
    m.prism([(.28, 0), (.06, -.24), (-.21, -.17), (-.18, 0), (-.21, .17), (.06, .24)], .15, .31, 'amber', 'dark')
    m.prism([(.19, 0), (-.02, -.17), (-.16, -.11), (-.16, .11), (-.02, .17)], .31, .4, 'ivory', 'edge')
    m.box(.225, .26, 0, .095, .075, .095, 'dark')
    m.box(.279, .26, 0, .014, .05, .06, 'charge')
    m.box(-.06, .412, 0, .11, .02, .22, 'amber')
    for z in (-.14, .14):
        m.bevel(-.1, z, .19, .12, .08, .14, 'amber', cut=.04)
    results[m.name] = m.export()

    m = Model('battery')
    m.cylinder(0, 0, .18, .04, .13, 'dark', 6)
    m.cylinder(0, 0, .165, .13, .58, 'ivory', 6, 'edge')
    m.cylinder(0, 0, .18, .56, .64, 'ivory', 6)
    for i in range(3):
        a = TAU * i / 3
        m.box(.17 * math.cos(a), .36, .17 * math.sin(a), .055, .3, .055, 'charge')
    m.box(0, .705, 0, .19, .06, .06, 'dark')
    m.box(-.07, .67, 0, .035, .08, .06, 'edge')
    m.box(.07, .67, 0, .035, .08, .06, 'edge')
    results[m.name] = m.export()

    m = Model('pedestal')
    m.cylinder(0, 0, .48, 0, .10, 'edge', 8)
    m.cylinder(0, 0, .39, .10, .16, 'dark', 8)
    m.torus(0, .18, 0, .32, .018, 'charge', 24)
    for x in (-.45, .45):
        m.box(x, .04, 0, .11, .08, .16, 'ivory')
    results[m.name] = m.export()

    m = Model('gate')
    m.cylinder(0, 0, 1.28, .003, .025, 'dark', 32)
    m.torus(0, .04, 0, 1.20, .035, 'ivory', 32)
    m.torus(0, .042, 0, .95, .018, 'edge', 32)
    for x in (-.34, .34):
        m.box(x, .045, 0, .2, .025, .75, 'mark')
    results[m.name] = m.export()
    return results


def sounds():
    rate = 22050
    definitions = {'pulse': .18, 'hit': .13, 'door': .22, 'shift-start': .31, 'shift-move': .55, 'shift-stop': .28,
                   'pickup': .32, 'drop': .22, 'return': .42, 'charge': .65, 'delivered': .85, 'respawn': .45,
                   'ping': .2, 'ready': .2, 'foundry-loop': 4, 'calibration-loop': 4, 'depot-loop': 4}
    measurements = {}
    for index, (name, duration) in enumerate(definitions.items()):
        rng = random.Random(1911 + index)
        samples = []
        filtered = 0.
        for i in range(round(rate * duration)):
            t = i / rate
            u = t / duration
            noise = rng.uniform(-1, 1)
            filtered = filtered * .91 + noise * .09
            envelope = min(t / .008, 1) * min((duration - t) / .025, 1)
            if name == 'pulse':
                value = .50 * math.sin(TAU * (1100 * t - 1800 * t * t)) * math.exp(-t * 25) + .16 * noise * math.exp(-t * 55)
            elif name == 'hit':
                value = .3 * noise * math.exp(-t * 55) + .28 * math.sin(TAU * 360 * t) * math.exp(-t * 35)
            elif name in ('door', 'shift-stop', 'drop'):
                value = .33 * (math.sin(TAU * 115 * t) + .4 * math.sin(TAU * 510 * t)) * math.exp(-t * 24) + .16 * noise * math.exp(-t * 40)
                if t > .065:
                    value += .13 * math.sin(TAU * 820 * t) * math.exp(-(t - .065) * 65)
            elif name in ('shift-start', 'shift-move'):
                value = .25 * filtered * math.sin(math.pi * u) + .16 * math.sin(TAU * (62 * t + 45 * t * t)) * math.sin(math.pi * u)
                value += .07 * math.sin(TAU * 470 * t) * math.sin(math.pi * u)
            elif name.endswith('-loop'):
                base = {'foundry-loop': 55, 'calibration-loop': 72, 'depot-loop': 48}[name]
                # Frequencies are integral over 4s, producing a seamless low-level atmosphere.
                value = .028 * math.sin(TAU * base * t) + .009 * math.sin(TAU * base * 2 * t) * (1 + .5 * math.sin(TAU * .5 * t))
                value += .004 * math.sin(TAU * 217 * t)
                envelope = 1
            else:
                frequencies = {'pickup': [523.25, 783.99], 'return': [783.99, 659.25, 523.25], 'charge': [261.63, 329.63, 392],
                               'delivered': [523.25, 659.25, 783.99, 1046.5], 'respawn': [392, 523.25], 'ping': [880], 'ready': [659.25, 880]}
                notes = frequencies[name]
                n = min(len(notes) - 1, int(u * len(notes)))
                note_t = t - n * duration / len(notes)
                value = .19 * math.sin(TAU * notes[n] * t) * math.exp(-note_t * 7) + .045 * math.sin(TAU * notes[n] * 2 * t) * math.exp(-note_t * 15)
            samples.append(max(-.9, min(.9, value * envelope)))
        path = OUT / 'audio' / (name + '.wav')
        with wave.open(str(path), 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(rate)
            wav.writeframes(struct.pack('<' + str(len(samples)) + 'h', *[int(s * 32767) for s in samples]))
        measurements[name] = {'sampleRate': rate, 'channels': 1, 'durationSeconds': len(samples) / rate, 'peakDbFS': round(20 * math.log10(max(abs(s) for s in samples)), 2)}
    return measurements


def artwork():
    icons = {
        'pilot': '<path d="M10 18 32 6l22 12v25L32 58 10 43Z"/><path d="M20 28h24v14H20zM32 18v10M26 48h12"/>',
        'navigator': '<path d="M6 6h15v15H6zM25 6h15v15H25zM44 6h14v15H44zM6 25h15v15H6zM25 25h15v15H25zM44 25h14v15H44zM6 44h15v14H6zM44 44h14v14H44z"/><path d="M32 44v14m-6-6 6 6 6-6"/>',
        'battery': '<path d="M24 6h16v8h8v44H16V14h8Z"/><path d="m34 23-9 13h9l-5 12 11-17H30z"/>',
        'lock': '<path d="M16 29h32v29H16zM23 29V16a9 9 0 0 1 18 0v13M32 39v9"/>',
        'shield': '<path d="m32 5 22 9v19c0 13-22 25-22 25S10 46 10 33V14Z"/><path d="m21 31 8 8 15-17"/>',
        'shift': '<path d="M5 10h33v33H5zM26 21h33v33H26z"/><path d="M15 32h34m-7-7 7 7-7 7"/>',
        'ping': '<circle cx="32" cy="28" r="18"/><circle cx="32" cy="28" r="6"/><path d="m20 42 12 16 12-16"/>',
        'charge': '<path d="M10 48a25 25 0 1 1 44 0M32 7v8M13 20l7 5m31-5-7 5M8 38h9m39 0h-9"/><path d="m36 23-13 15h10l-5 14 15-20H32z"/>',
    }
    for name, inner in icons.items():
        filename = 'role-' + name if name in ('pilot', 'navigator') else name
        (OUT / 'art' / (filename + '.svg')).write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" stroke="#ece7da" stroke-width="3" stroke-linecap="square" stroke-linejoin="bevel">' + inner + '</svg>')
    boards = {'foundry': ['B', 'C', 'D', 'A', 'O', 'E', 'F', '', 'G'], 'calibration': ['F', '', 'G', 'B', 'O', 'D', 'A', 'C', 'E'], 'depot': ['A', 'C', 'E', 'F', 'O', 'G', 'B', '', 'D']}
    accents = {'foundry': '#c7a25e', 'calibration': '#95bbbd', 'depot': '#7f91a8'}
    for name, board in boards.items():
        shapes = []
        for n, letter in enumerate(board):
            x, y = 72 + (n % 3) * 126, 36 + (n // 3) * 81
            if not letter:
                shapes.append(f'<path d="M{x} {y}h114v70H{x}z" fill="#080f16" stroke="#627077" stroke-dasharray="4 7"/>')
                continue
            shapes.append(f'<path d="M{x+6} {y}h102l6 6v58l-6 6H{x+6}l-6-6V{y+6}Z" fill="#27343c" stroke="#647880" stroke-width="2"/>')
            shapes.append(f'<path d="M{x+10} {y+10}h94M{x+10} {y+60}h94" stroke="{accents[name]}" opacity=".55"/>')
            shapes.append(f'<text x="{x+10}" y="{y+27}" fill="#a7b7ba" font-family="monospace" font-size="15">{letter}</text>')
            shapes.append(f'<rect x="{x+50}" y="{y+24}" width="22" height="21" rx="4" fill="#536a73" stroke="#94a3a5"/>')
        shapes.extend(['<circle cx="244" cy="153" r="10" fill="#3cd8c6"/><path d="m299 142 13 11-13 11-9-11Z" fill="#ffc066"/>', '<path d="M268 133h11v28h-11zM270 130h7" fill="#ece7da" stroke="#f4dc8f" stroke-width="2"/>'])
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 324"><defs><pattern id="g" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0H0V16" fill="none" stroke="#31414b" stroke-width=".6"/></pattern></defs><rect width="520" height="324" fill="#101820"/><rect width="520" height="324" fill="url(#g)"/>' + ''.join(shapes) + '</svg>'
        (OUT / 'art' / ('arena-' + name + '.svg')).write_text(svg)
    # A different composition for the catalogue: one slab in motion, two passengers and its bright cargo.
    (OUT / 'art' / 'cover.svg').write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 600"><defs><linearGradient id="bg" x2="1" y2="1"><stop stop-color="#1d3039"/><stop offset="1" stop-color="#091219"/></linearGradient><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#5d8c94" stroke-opacity=".12"/></pattern><linearGradient id="side" x2="0" y2="1"><stop stop-color="#536d75"/><stop offset="1" stop-color="#1b2c34"/></linearGradient></defs><rect width="960" height="600" fill="url(#bg)"/><rect width="960" height="600" fill="url(#grid)"/><g transform="translate(260 36) rotate(8 250 250)"><path d="M55 83 490 64l170 326-438 47Z" fill="#080e14" stroke="#3b535e" stroke-width="2"/><g fill="#283b43" stroke="#5e7b83" stroke-width="3"><path d="m55 83 132-5 40 85-133 7Z"/><path d="m205 77 135-6 41 83-135 8Z"/><path d="m358 70 132-6 44 82-136 8Z"/><path d="m101 188 132-7 40 84-133 9Z"/><path d="m407 170 136-9 44 83-137 9Z"/><path d="m148 292 132-9 42 89-135 10Z"/><path d="m458 272 137-9 46 91-140 11Z"/></g><path d="m302 283 135-9 45 89-138 10Z" fill="#091218" stroke="#62777b" stroke-width="2" stroke-dasharray="6 7"/><path d="m253 199 134-8 44 86-135 9v20l135-9v-20" fill="url(#side)" stroke="#a8b9b7" stroke-width="3"/><path d="m253 199 134-8 44 86-135 9Z" fill="#394d55" stroke="#3cd8c6" stroke-width="4"/><path d="m320 318 17 28m-32-15 32 15 5-33" fill="none" stroke="#3cd8c6" stroke-width="5"/><g fill="#3cd8c6" stroke="#bdfff3" stroke-width="2"><ellipse cx="295" cy="224" rx="19" ry="13"/><path d="m298 220 26-3 4 8-28 2Z"/></g><path d="m378 242 23 9-18 17-19-14Z" fill="#ffc066" stroke="#fff0cc" stroke-width="2"/><path d="m334 208 18-1 5 38-18 2Z" fill="#ece7da" stroke="#ffc066" stroke-width="3"/><path d="m336 203 13-1 1 5" fill="none" stroke="#ece7da" stroke-width="4"/><g stroke="#bcc7be" stroke-width="3"><path d="m124 112 42-2M274 108l43-2m145-8 43-2M196 326l43-3M511 307l43-3"/></g></g><path d="M55 65h100M55 65v100M905 535H805M905 535V435" fill="none" stroke="#3cd8c6" stroke-width="4"/><text x="55" y="453" fill="#ece7da" font-family="sans-serif" font-weight="900" font-size="86" letter-spacing="6">SHIFT</text><text x="59" y="494" fill="#8ca7ad" font-family="monospace" font-size="15" letter-spacing="7">PILOT · NAVIGATE · DELIVER</text></svg>''')


def manifest(model_info, sound_info):
    assets = []
    metadata = {**{('models/' + name + '.glb', 'model'): info for name, info in model_info.items()},
                **{('audio/' + name + '.wav', 'audio'): info for name, info in sound_info.items()}}
    asset_types = {('models', '.glb'): 'model', ('audio', '.wav'): 'audio', ('art', '.svg'): 'vector',
                   ('fonts', '.ttf'): 'font', ('fonts', '.txt'): 'license'}
    for path in sorted(OUT.rglob('*')):
        if not path.is_file() or path.name.startswith('.'):
            continue
        relative_path = path.relative_to(OUT)
        rel = relative_path.as_posix()
        asset_type = asset_types[(relative_path.parts[0], path.suffix.lower())]
        font = rel.startswith('fonts/')
        source = 'https://github.com/google/fonts/tree/main/ofl/' + ('russoone' if 'Russo' in path.name or 'russo' in path.name else 'onest') if font else 'games/shift/scripts/generate-assets.py'
        item = {'id': ':'.join(relative_path.parts), 'type': asset_type, 'path': '/shift-assets/' + rel, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'author': ('Jovanny Lemonad' if 'Russo' in path.name or 'russo' in path.name else 'The Onest Project Authors') if font else 'Iva Games / Shift procedural workshop',
                'source': source, 'license': 'OFL-1.1' if font else 'LicenseRef-IvaGames-Original',
                'modification': 'Unmodified upstream font or license' if font else 'Original reproducible procedural geometry, vector artwork or synthesized PCM; no external samples',
                'version': 'upstream pinned by SHA-256' if font else 'shift-assets@1'}
        item.update(metadata.get((rel, asset_type), {}))
        assets.append(item)
    doc = {'version': 'shift-assets@1', 'coordinates': {'units': 'metres', 'up': '+Y', 'droneForward': '+X'},
           'originalLicense': 'Created for Iva Games. No third-party model, texture or audio rights are required; reuse is subject to the project owner\'s terms.',
           'candidateReview': [
               {'source': 'https://quaternius.com/packs/modularscifimegakit.html', 'license': 'CC0-1.0', 'used': False, 'decision': 'License and grid-based product were reviewed. Custom 8m slabs, 2m apertures and lower sight-line profiles are generated together for exact fit and identity.'},
               {'source': 'https://kenney.nl/assets/prototype-kit', 'license': 'CC0-1.0', 'used': False, 'decision': 'License reviewed; prototype prop silhouettes replaced by custom beveled mechanical covers with shared authoritative footprints.'}],
           'verification': {'fileFormats': 'GLB 2.0 / PCM16 WAV mono / SVG / TTF', 'auditoryAcceptance': 'Not claimed by generator', 'browserAcceptance': 'Visual fixture evidence: games/shift/QA_ART.md; full match evidence: games/shift/ACCEPTANCE.md'},
           'assets': assets}
    (ROOT / 'assets-manifest.json').write_text(json.dumps(doc, ensure_ascii=False, indent=2) + '\n')


def main():
    for folder in ('models', 'audio', 'art', 'fonts'):
        (OUT / folder).mkdir(parents=True, exist_ok=True)
    model_info = models()
    sound_info = sounds()
    artwork()
    manifest(model_info, sound_info)
    print(json.dumps({'models': len(model_info), 'sounds': len(sound_info), 'bytes': sum(p.stat().st_size for p in OUT.rglob('*') if p.is_file()), 'triangles': sum(m['triangles'] for m in model_info.values())}))


if __name__ == '__main__':
    main()
