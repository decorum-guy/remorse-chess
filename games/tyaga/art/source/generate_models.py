"""Original TYAGA expedition models; Blender 4.3+, deterministic, no imported meshes.

Run from the repository: blender -b --python games/tyaga/art/source/generate_models.py
Canonical coordinates are metres, X forward, Y up, Z right. Blender stores Z up;
the p() conversion and glTF's standard axis conversion cancel exactly. Dynamic
models use the same centre origins as the authoritative physics. Static scenery
uses the ground or attachment origin declared per asset in manifest.json.
"""
import bpy
import hashlib
import json
import math
import random
from pathlib import Path
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/assets/tyaga/models'
OUT.mkdir(parents=True, exist_ok=True)
TAU = 2 * math.pi
MANIFEST = []
M = {}


def p(v):
    return Vector((v[0], -v[2], v[1]))


def material(name, color, roughness=.65, metallic=0):
    color = color.lstrip('#')
    rgb = [int(color[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    # RGB hex is sRGB. glTF PBR factors are linear.
    linear = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb]
    bsdf.inputs['Base Color'].default_value = (*linear, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return mat


def reset():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for collection in [bpy.data.meshes, bpy.data.curves, bpy.data.armatures, bpy.data.actions]:
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def group(name, parent=None, at=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.parent = parent
    obj.location = p(at)
    obj.empty_display_size = .12
    return obj


def socket(root, name, at, role='attachment'):
    obj = group(name, root, at)
    obj['tyagaRole'] = role
    obj['positionMeters'] = list(at)
    return obj


def finish(obj, name, mat, parent=None, smooth=True):
    obj.name = name
    obj.parent = parent
    if mat:
        obj.data.materials.append(M[mat] if isinstance(mat, str) else mat)
    if smooth and obj.type == 'MESH':
        for face in obj.data.polygons:
            face.use_smooth = True
    return obj


def box(root, name, at, size, mat, bevel=.035):
    bpy.ops.mesh.primitive_cube_add(size=1, location=p(at))
    obj = bpy.context.object
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(obj, name, mat, root, False)
    if bevel > 0:
        modifier = obj.modifiers.new('Crafted rounded edges', 'BEVEL')
        modifier.width = min(bevel, min(size) * .33)
        modifier.segments = 2
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        modifier = obj.modifiers.new('Corner weighted normals', 'WEIGHTED_NORMAL')
        modifier.keep_sharp = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj


def ellipsoid(root, name, at, size, mat, segments=16, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1, location=p(at))
    obj = bpy.context.object
    obj.scale = (size[0] / 2, size[2] / 2, size[1] / 2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, root)


def cyl(root, name, at, radius, length, mat, axis='y', vertices=16, top=None):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius,
        radius2=radius if top is None else top, depth=length, location=p(at))
    obj = bpy.context.object
    axisvec = {'x': (1, 0, 0), 'y': (0, 1, 0), 'z': (0, 0, 1)}[axis]
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(p(axisvec))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, root)


def line(root, name, a, b, radius, mat, vertices=10):
    av, bv = p(a), p(b)
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius,
        depth=(bv - av).length, location=(av + bv) / 2)
    obj = bpy.context.object
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = Vector((0, 0, 1)).rotation_difference((bv - av).normalized())
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, root)


def ring(root, name, at, radius, thickness, mat, axis='y', segments=20):
    verts, faces = [], []
    for i in range(segments):
        a = TAU * i / segments
        for j in range(6):
            b = TAU * j / 6
            r = radius + math.cos(b) * thickness
            v = (math.cos(a) * r, math.sin(b) * thickness, math.sin(a) * r)
            if axis == 'x':
                v = (v[1], v[0], v[2])
            elif axis == 'z':
                v = (v[0], v[2], v[1])
            verts.append(tuple(p(tuple(v[k] + at[k] for k in range(3)))))
    for i in range(segments):
        for j in range(6):
            faces.append((i * 6 + j, ((i + 1) % segments) * 6 + j,
                ((i + 1) % segments) * 6 + (j + 1) % 6, i * 6 + (j + 1) % 6))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return finish(obj, name, mat, root)


def pipe(root, name, points, radius, mat):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 2
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    curve.resolution_u = 3
    spline = curve.splines.new('BEZIER')
    spline.bezier_points.add(len(points) - 1)
    for co, bezier in zip(points, spline.bezier_points):
        bezier.co = p(co)
        bezier.handle_left_type = bezier.handle_right_type = 'AUTO'
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    curve.materials.append(M[mat])
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target='MESH')
    return obj


def rivets(root, a, b, count=5, axis='z', radius=.025):
    for i in range(count):
        t = i / max(1, count - 1)
        pos = tuple(a[k] + t * (b[k] - a[k]) for k in range(3))
        cyl(root, 'recessed-bolt', pos, radius, .015, 'alloy', axis, 6)


def eye(root, name, at, axis='z', radius=.10):
    ring(root, name + '-eye', at, radius, .032, 'ochre', axis, 16)
    socket(root, name, at)


def handle(root, name, a, b, offset=(0, .12, 0)):
    points = [a, tuple(a[i] + offset[i] for i in range(3)),
              tuple(b[i] + offset[i] for i in range(3)), b]
    pipe(root, name + '-steel', points, .024, 'steel')
    socket(root, name, tuple((a[i] + b[i]) / 2 + offset[i] for i in range(3)), 'handle')


def emblem(root, at, scale=1, axis='z'):
    # An original stamped paired-chevron expedition mark. Geometry, no logo font.
    x, y, z = at
    for dx in [-.07, .07]:
        line(root, 'expedition-mark', (x + dx - .045 * scale, y - .055 * scale, z),
             (x + dx, y + .055 * scale, z), .012 * scale, 'ivory', 6)
        line(root, 'expedition-mark', (x + dx, y + .055 * scale, z),
             (x + dx + .045 * scale, y - .055 * scale, z), .012 * scale, 'ivory', 6)


def truck():
    root = group('tyaga-truck')
    box(root, 'underframe', (-.30, -.37, 0), (5.0, .14, 2.20), 'steel', .045)
    for z in [-1.2, 1.2]:
        box(root, 'longitudinal-frame', (-.20, -.32, z), (5.8, .16, .20), 'steel', .025)
    box(root, 'load-platform', (-.4, .275, 0), (5.2, .15, 2.4), 'orange', .045)
    for z in [-1.12, 1.12]:
        box(root, 'bed-rubrail', (-.4, .38, z), (5.2, .11, .14), 'steel', .035)
        for x in [-2.2, -.8, .8, 1.8]:
            eye(root, 'socket-bed-' + str(x) + '-' + str(z), (x, .42, 1.18 if z > 0 else -1.18), 'z', .075)
    for i in range(12):
        box(root, 'bed-wearstrip', (-2.77 + i * .43, .359, 0), (.055, .015, 2.1), 'alloy', .006)
    # The equipment drawer is a separate, strapped 50kg physical body (crate.glb).
    # It must disappear from the vehicle if the real drawer is removed.
    for variant, height, xs in [('low', .15, [-1.9, .5]), ('high', 1.15, [-1.6, 1.6])]:
        support = group('cargo-support-' + variant, root)
        support['supportVariant'] = variant
        for x in xs:
            box(support, 'reinforced-cradle', (x, .35 + height / 2, 0), (.30, height, 1.8), 'steel', .025)
            box(support, 'cradle-cushion', (x, .35 + height - .018, 0), (.30, .036, 1.8), 'rubber', .015)
            for z in [-.72, .72]:
                cyl(support, 'cradle-fastener', (x + .154, .35 + height / 2, z), .055, .012, 'alloy', 'x', 6)
    # Cab-over silhouette, glass behind a thick rounded safety frame.
    box(root, 'cabin-floor', (2.64, .35, 0), (1.12, .24, 1.9), 'orange', .10)
    box(root, 'cabin-shell', (2.65, .90, 0), (1.05, 1.05, 1.85), 'orange', .18)
    box(root, 'windscreen', (3.184, 1.08, 0), (.035, .50, 1.49), 'glass', .045)
    for z in [-.935, .935]:
        box(root, 'side-window', (2.67, 1.11, z), (.66, .48, .03), 'glass', .065)
        box(root, 'door-lower', (2.69, .63, z), (.76, .36, .03), 'orange-light', .055)
        handle(root, 'cabin-handle-' + str(z), (2.39, .84, z), (2.58, .84, z), (0, 0, .065 if z > 0 else -.065))
        box(root, 'side-step', (2.53, .05, z * 1.1), (.70, .11, .32), 'steel', .03)
        emblem(root, (2.7, .61, z * 1.025), .8)
    box(root, 'cab-roof', (2.62, 1.48, 0), (1.16, .17, 2.0), 'ivory', .10)
    for z in [-.74, .74]:
        line(root, 'mirror-stalk', (2.96, 1.17, z), (2.88, 1.28, z * 1.50), .025, 'steel')
        box(root, 'mirror', (2.88, 1.30, z * 1.53), (.12, .22, .09), 'steel', .04)
        box(root, 'mirror-reflector', (2.813, 1.30, z * 1.53), (.01, .17, .055), 'alloy', .005)
    box(root, 'front-bumper', (3.13, -.04, 0), (.14, .25, 2.36), 'steel', .045)
    box(root, 'back-bumper', (-3.10, -.04, 0), (.18, .22, 2.36), 'steel', .04)
    for z in [-.76, .76]:
        cyl(root, 'lamp-bezel', (3.193, .57, z), .145, .05, 'steel', 'x', 20)
        cyl(root, 'headlamp', (3.221, .57, z), .115, .012, 'lamp', 'x', 20)
        box(root, 'tail-lamp', (-3.20, .11, z), (.025, .12, .22), 'red', .02)
    for i in range(5):
        box(root, 'front-grille', (3.20, .31, -.40 + i * .2), (.015, .18, .12), 'steel', .015)
    # Four independent steering/rotation groups around the exact physical wheels.
    for x, fore in [(-1.8, 'r'), (1.8, 'f')]:
        for z, side in [(-1.05, 'l'), (1.05, 'r')]:
            pivot = group('steer-' + fore + side, root, (x, -.45, z))
            wheel = group('wheel-' + fore + side, pivot)
            ring(wheel, 'rounded-tire', (0, 0, 0), .365, .135, 'rubber', 'z', 24)
            cyl(wheel, 'tire-core', (0, 0, 0), .38, .39, 'rubber', 'z', 24)
            for sign in [-1, 1]:
                cyl(wheel, 'inset-wheel-rim', (0, 0, .205 * sign), .265, .035, 'ivory', 'z', 20)
                cyl(wheel, 'wheel-hub', (0, 0, .23 * sign), .095, .055, 'steel', 'z', 12)
                for j in range(6):
                    a = TAU * j / 6
                    cyl(wheel, 'wheel-lug', (.16 * math.cos(a), .16 * math.sin(a), .23 * sign), .025, .015, 'alloy', 'z', 6)
            for j in range(20):
                a = TAU * j / 20
                tread = box(wheel, 'tire-chevron', (.477 * math.cos(a), .477 * math.sin(a), 0), (.07, .06, .43), 'rubber-edge', .02)
                tread.rotation_mode = 'XYZ'
                tread.rotation_euler.y = -a
            spring = pipe(root, 'suspension-coil', [(x + .07 * math.cos(i * TAU / 8), -.15 + i * .018, z * .72 + .07 * math.sin(i * TAU / 8)) for i in range(24)], .017, 'alloy')
            box(root, 'mudguard', (x, .13, z), (1.25, .16, .52), 'orange', .07)
    front = group('front-winch', root, (2.99, -.11, 0))
    winch_parts(front, .8)
    socket(root, 'socket-front-winch', (3.20, -.08, 0), 'winch')
    eye(root, 'socket-rear-tow', (-3.18, -.08, 0), 'x', .11)
    socket(root, 'socket-driver', (2.52, .65, 0), 'seat')
    socket(root, 'socket-emergency-brake', (-3.10, .22, .70), 'control')
    steering = group('steering-wheel', root, (2.89, .92, 0))
    ring(steering, 'steering-rim', (0, 0, 0), .18, .025, 'steel', 'x')
    for a in [0, TAU / 3, TAU * 2 / 3]:
        line(steering, 'steering-spoke', (0, 0, 0), (0, .17 * math.cos(a), .17 * math.sin(a)), .015, 'steel')
    return root


def winch_parts(root, scale=1):
    s = scale
    box(root, 'winch-base', (0, -.12 * s, 0), (.62 * s, .12 * s, .56 * s), 'steel', .03)
    for z in [-.24 * s, .24 * s]:
        box(root, 'winch-cheek', (0, .04 * s, z), (.40 * s, .36 * s, .055 * s), 'orange', .04)
    drum = group('drum', root)
    cyl(drum, 'rope-on-drum', (0, .04 * s, 0), .14 * s, .40 * s, 'rope', 'z', 20)
    for z in [-.21 * s, .21 * s]:
        cyl(drum, 'drum-flange', (0, .04 * s, z), .18 * s, .03 * s, 'steel', 'z')
    for z in [-.16 + .064 * i for i in range(6)]:
        ring(drum, 'wound-cable', (0, .04 * s, z * s), .141 * s, .019 * s, 'rope-light', 'z', 10)
    cyl(root, 'gearbox', (0, .04 * s, .35 * s), .12 * s, .17 * s, 'steel', 'z')
    lever = group('winch-handle', root, (0, .06 * s, .46 * s))
    line(lever, 'crank', (0, 0, 0), (.19 * s, .17 * s, 0), .025 * s, 'steel')
    cyl(lever, 'rubber-grip', (.19 * s, .17 * s, .05 * s), .04 * s, .12 * s, 'rubber', 'z')
    socket(root, 'socket-drum', (.18 * s, .05 * s, 0), 'winch')
    socket(root, 'handle-crank', (.19 * s, .23 * s, .51 * s), 'control')


def winch():
    root = group('tyaga-winch')
    winch_parts(root)
    handle(root, 'handle-carry', (-.2, .22, 0), (.2, .22, 0), (0, .13, 0))
    base_eye = group('base-eye', root)
    base_eye['canonicalPosition'] = [0, -.155, 0]
    eye(base_eye, 'socket-base', (0, 0, 0), 'x', .08)
    return root


def cargo_eyes(root, sx, sy, sz):
    for x, idx in [(-sx / 2 + .15, 0), (sx / 2 - .15, 1)]:
        for z, side in [(-sz / 2 + .08, 0), (sz / 2 - .08, 1)]:
            eye(root, f'socket-cargo-{idx * 2 + side}', (x, -sy / 2 + .18, z), 'z', .075)
    handle(root, 'handle-left', (-.25, -sy / 2 + .20, -sz / 2 + .06), (.25, -sy / 2 + .20, -sz / 2 + .06), (0, 0, -.06))
    handle(root, 'handle-right', (-.25, -sy / 2 + .20, sz / 2 - .06), (.25, -sy / 2 + .20, sz / 2 - .06), (0, 0, .06))


def generator(large=True):
    root = group('tyaga-generator-' + ('large' if large else 'small'))
    sx, sy, sz = (3.4, 2.2, 2.1) if large else (1.1, 1.0, .9)
    box(root, 'generator-skid', (0, -sy / 2 + .08, 0), (sx, .16, sz), 'steel', .07)
    box(root, 'acoustic-hood', (0, .03, 0), (sx * .92, sy * .86, sz * .87), 'ivory', .15 if large else .08)
    for z in [-sz * .444, sz * .444]:
        box(root, 'orange-service-panel', (.28 * sx, -.02, z), (sx * .28, sy * .68, .055), 'orange', .06)
        box(root, 'ventilation-recess', (-.15 * sx, 0, z), (sx * .47, sy * .56, .035), 'steel', .04)
        for i in range(8 if large else 5):
            box(root, 'cooling-louvre', (-sx * .15, -sy * .23 + i * sy * .065, z * 1.01), (sx * .43, .04 if large else .025, .055), 'steel-light', .01)
        emblem(root, (.28 * sx, .03, z * 1.09), 1.5 if large else .65)
        rivets(root, (-sx * .4, sy * .36, z), (sx * .4, sy * .36, z), 7 if large else 4)
    for z in [-sz * .20, sz * .20]:
        cyl(root, 'power-socket', (sx * .465, -.05, z), .12 if large else .06, .05, 'ochre', 'x')
        cyl(root, 'socket-centre', (sx * .495, -.05, z), .075 if large else .035, .02, 'steel', 'x', 8)
    pipe(root, 'exhaust-neck', [(-sx * .32, sy * .37, 0), (-sx * .32, sy * .46, 0), (-sx * .25, sy * .47, 0)], .06 if large else .025, 'steel')
    handle(root, 'service-lid', (-sx * .18, sy * .445, -.1), (sx * .18, sy * .445, -.1), (0, .035, 0))
    cargo_eyes(root, sx, sy, sz)
    damaged = box(root, 'damage-panel', (sx * .25, -sy * .18, sz * .45), (sx * .16, sy * .12, .014), 'rust', .02)
    damaged['damageOnly'] = True
    return root


def optics():
    root = group('tyaga-optics-small')
    sx, sy, sz = .9, .9, .8
    box(root, 'optics-base', (0, -.37, 0), (.9, .16, .8), 'steel', .055)
    box(root, 'instrument-inner', (0, 0, 0), (.62, .64, .52), 'ivory', .09)
    cyl(root, 'optical-body', (.17, .07, 0), .225, .45, 'steel', 'x', 24)
    cyl(root, 'optical-lens', (.415, .07, 0), .174, .025, 'lens', 'x', 24)
    ring(root, 'lens-protector', (.421, .07, 0), .193, .028, 'ochre', 'x')
    for x in [-.34, .34]:
        for z in [-.32, .32]:
            line(root, 'soft-protective-cage', (x, -.29, z), (x, .31, z), .055, 'olive-light')
        line(root, 'cage-roof', (x, .31, -.32), (x, .31, .32), .055, 'olive-light')
    box(root, 'control-screen', (0, .12, -.285), (.23, .15, .02), 'lens', .025)
    cargo_eyes(root, sx, sy, sz)
    return root


def mast():
    root = group('tyaga-mast')
    for y in [-.28, .28]:
        for z in [-.25, .25]:
            line(root, 'mast-longeron', (-3.38, y, z), (3.38, y, z), .045, 'ivory')
    for i in range(10):
        x = -3.3 + i * .66
        for z in [-.25, .25]:
            line(root, 'mast-lattice', (x, -.28, z), (x + .63, .28, z), .025, 'alloy', 8)
            line(root, 'mast-lattice', (x, .28, z), (x + .63, -.28, z), .025, 'alloy', 8)
        line(root, 'mast-rung', (x, -.28, -.25), (x, -.28, .25), .025, 'alloy', 8)
    for x in [-3.525, -1.6, 1.6, 3.525]:
        box(root, 'mast-transport-collar', (x, 0, 0), (.15, 1.0, .9), 'orange', .045)
        box(root, 'mast-collar-inset', (x + .085, 0, 0), (.025, .58, .56), 'steel', .02)
    cyl(root, 'optic-head', (3.44, .05, 0), .34, .29, 'steel', 'x', 20)
    cyl(root, 'lens', (3.5925, .05, 0), .25, .015, 'lens', 'x', 20)
    for x in [-3.45, 3.45]:
        for z in [-.37, .37]:
            eye(root, 'socket-mast-' + str(x) + '-' + str(z), (x, -.32, z), 'z', .07)
    for z in [-.39, .39]:
        handle(root, 'handle-mast-' + str(z), (-.25, -.30, z), (.25, -.30, z), (0, 0, .06 if z > 0 else -.06))
    return root


def pump(large=True):
    root = group('tyaga-pump-' + ('large' if large else 'small'))
    sx, sy, sz = (3.2, 2.7, 2.8) if large else (1.0, 1.0, .9)
    box(root, 'pump-skid', (0, -sy / 2 + .09, 0), (sx, .18, sz), 'steel', .065)
    housing = ellipsoid(root, 'cast-pump-volute', (-.22 * sx, -.03 * sy, 0), (sx * .46, sy * .70, sz * .62), 'teal')
    cyl(root, 'motor-body', (.19 * sx, -.05 * sy, 0), sy * .26, sx * .50, 'orange', 'x', 24)
    for i in range(8):
        ring(root, 'motor-cooling-fin', (.02 * sx + i * sx * .05, -.05 * sy, 0), sy * .26, sy * .014, 'orange-light', 'x', 20)
    cyl(root, 'fan-housing', (sx * .455, -.05 * sy, 0), sy * .27, .08 * sx, 'steel', 'x', 20)
    for sign in [-1, 1]:
        z = sign * sz * .40
        cyl(root, 'pump-pipe', (-sx * .22, sy * .06, z), sy * .18, sz * .24, 'teal', 'z', 20)
        cyl(root, 'flange', (-sx * .22, sy * .06, sign * sz * .485), sy * .225, .045 * sx, 'alloy', 'z', 20)
        cyl(root, 'pipe-opening', (-sx * .22, sy * .06, sign * sz * .504), sy * .155, .012, 'steel', 'z', 20)
        for a in [TAU * i / 8 for i in range(8)]:
            cyl(root, 'flange-bolt', (-sx * .22 + sy * .19 * math.cos(a), sy * .06 + sy * .19 * math.sin(a), sign * sz * .511), sy * .018, .018, 'ochre', 'z', 6)
    pipe(root, 'pressure-pipe', [(-sx * .22, sy * .25, 0), (-sx * .22, sy * .42, 0), (sx * .03, sy * .42, 0)], .055 if large else .025, 'alloy')
    cyl(root, 'pressure-gauge', (sx * .03, sy * .42, .035), sy * .08, .04, 'steel', 'z')
    cyl(root, 'gauge-face', (sx * .03, sy * .42, .06), sy * .065, .012, 'ivory', 'z')
    line(root, 'gauge-needle', (sx * .03, sy * .42, .07), (sx * .055, sy * .46, .07), .008, 'red', 6)
    cargo_eyes(root, sx, sy, sz)
    return root


def recessed_end_board(root, start, end, near, far, mat):
    # A 25mm deep, 30mm wide real rebate seats each metal guide. Its top
    # replaces the wood surface; no coplanar painted-on box remains.
    if near < -1.3:
        top = [(far, .065), (far - .03, .065), (far - .03, .09), (near, .09)]
    elif near > 1.3:
        top = [(far, .09), (near + .03, .09), (near + .03, .065), (near, .065)]
    else:
        top = [(far, .065), (far - .03, .065), (far - .03, .09), (near + .03, .09), (near + .03, .065), (near, .065)]
    profile = [(near, -.02), (far, -.02)] + top
    count = len(profile)
    vertices = [tuple(p((x, y, z))) for x in [start, end] for z, y in profile]
    faces = [tuple(range(count)), tuple(reversed(range(count, 2 * count)))]
    faces += [(i, i + count, (i + 1) % count + count, (i + 1) % count) for i in range(count)]
    mesh = bpy.data.meshes.new('rebated-board')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('rebated-board', mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, 'rebated-board', mat, root, False)
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new('Rebate edge rounding', 'BEVEL')
    modifier.width = .004
    modifier.segments = 2
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    modifier = obj.modifiers.new('Rebate weighted normals', 'WEIGHTED_NORMAL')
    modifier.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj


def deck(folded=False):
    root = group('tyaga-deck-' + ('folded' if folded else 'open'))
    if folded:
        for i in range(4):
            box(root, 'folded-leaf', (0, -.15 + i * .10, 0), (1.5, .08, 1.5), 'wood' if i % 2 else 'wood-light', .018)
            for z in [-.68, .68]:
                box(root, 'folded-frame', (0, -.15 + i * .10, z), (1.5, .075, .09), 'steel', .012)
        for z in [-.51, .51]:
            box(root, 'transport-band', (0, 0, z), (1.51, .405, .035), 'ochre', .012)
        handle(root, 'handle-left', (-.3, .2, -.5), (.3, .2, -.5), (0, .08, 0))
        handle(root, 'handle-right', (-.3, .2, .5), (.3, .2, .5), (0, .08, 0))
    else:
        grips = group('deck-interaction-hardware', root)
        grips['interactionHardware'] = True
        box(root, 'bridge-girder', (0, -.04, 0), (4, .1, .12), 'steel', .015)
        for side in [-1, 1]:
            box(root, 'bridge-girder-middle', (0, -.04, side * 1.40), (3.2, .1, .12), 'steel', .015)
            for x in [-1.8, 1.8]:
                # The widened slot cuts 30mm into the original girder too.
                box(root, 'bridge-girder-notched-end', (x, -.04, side * 1.415), (.4, .1, .09), 'steel', .012)
        for i in range(16):
            x = -1.87 + i * .249
            cuts = sorted([x - .1195, x + .1195] +
                [boundary for boundary in [-1.60, 1.60] if x - .1195 < boundary < x + .1195])
            for start, end in zip(cuts, cuts[1:]):
                # Four real open-ended slots. The wood and the compound body
                # use the same X +/-1.60 boundary and Z +/-1.13, +/-1.37 cuts.
                z_ranges = [(-1.5, -1.37), (-1.13, 1.13), (1.37, 1.5)] if abs((start + end) / 2) > 1.60 else [(-1.5, 1.5)]
                for near, far in z_ranges:
                    mat = 'wood-light' if i % 3 else 'wood'
                    if len(z_ranges) > 1:
                        recessed_end_board(root, start, end, near, far, mat)
                    else:
                        box(root, 'individual-board', ((start + end) / 2, .035, (near + far) / 2),
                            (end - start, .11, far - near), mat, .012)
            for z in [-1.40, 1.40]:
                cyl(grips, 'board-pin', (x, .091, z), .022, .008, 'steel', 'y', 6)
        for sx in [-1, 1]:
            for sz in [-1, 1]:
                for offset in [-.135, .135]:
                    box(root, 'mount-slot-guide', (sx * 1.8, .0775, sz * 1.25 + offset),
                        (.4, .025, .03), 'ochre', .004)
                socket(root, f'socket-ring-{sx}-{sz}', (sx * 1.8, .09, sz * 1.25))
        # These small grips are interaction hardware, not load-bearing timber.
        # Keep their centres at the authoritative carry points, including Y=.10.
        for index, sz in enumerate([-1, 1]):
            for x in [-.28, .28]:
                line(grips, 'carry-handle-foot', (x, .04, sz * 1.40), (x, .10, sz * 1.50), .018, 'steel')
            line(grips, 'carry-handle-grip', (-.28, .10, sz * 1.50), (.28, .10, sz * 1.50), .020, 'steel', 12)
            socket(grips, f'socket-handle-{index}', (0, .10, sz * 1.50), 'handle')
    return root


def beam():
    root = group('tyaga-beam')
    box(root, 'laminated-timber', (0, 0, 0), (3, .30, .30), 'wood', .025)
    for x in [-1.34, 1.34]:
        box(root, 'steel-end-cap', (x, 0, 0), (.16, .315, .315), 'steel', .02)
        eye(root, 'socket-beam-' + str(x), (x, .18, 0), 'z', .06)
    for y in [-.06, .06]:
        line(root, 'timber-grain', (-1.15, y, .151), (1.15, y + .012, .151), .006, 'wood-light', 5)
    handle(root, 'handle-beam', (-.16, .15, 0), (.16, .15, 0), (0, .06, 0))
    return root


def anchor():
    root = group('tyaga-anchor')
    cyl(root, 'ground-screw', (0, -.10, 0), .045, .64, 'steel', 'y', 12, .02)
    for y in [-.26, -.13, 0]:
        ring(root, 'screw-flange', (0, y, 0), .13, .027, 'alloy', 'y', 14)
    box(root, 'shoulder', (0, .22, 0), (.42, .10, .16), 'orange', .03)
    handle(root, 'handle-anchor', (-.18, .27, 0), (.18, .27, 0), (0, .10, 0))
    eye(root, 'socket-anchor', (0, .23, .11), 'z', .09)
    return root


def hook():
    root = group('tyaga-hook')
    pipe(root, 'forged-hook', [(0, .2, 0), (0, .07, 0), (-.1, -.03, 0), (-.08, -.17, 0), (.07, -.17, 0), (.12, -.05, 0)], .036, 'ochre')
    line(root, 'spring-gate', (.01, .055, 0), (.11, -.055, 0), .012, 'alloy')
    ring(root, 'rope-eye', (0, .23, 0), .065, .023, 'steel', 'z', 16)
    socket(root, 'socket-hook', (0, .23, 0))
    return root


def strap():
    root = group('tyaga-strap')
    for r in [.07, .09, .11, .13]:
        ring(root, 'rolled-webbing', (0, 0, 0), r, .012, 'ochre', 'z', 20)
    box(root, 'ratchet-frame', (.17, 0, 0), (.16, .15, .10), 'steel', .022)
    box(root, 'ratchet-paddle', (.18, .10, 0), (.20, .04, .14), 'orange', .015)
    socket(root, 'handle-strap', (.18, .10, 0), 'handle')
    return root


def jack():
    root = group('tyaga-jack')
    box(root, 'jack-foot', (0, -.31, 0), (.42, .10, .36), 'steel', .035)
    cyl(root, 'hydraulic-body', (0, -.11, 0), .125, .38, 'orange', 'y', 20)
    piston = group('jack-piston', root, (0, .11, 0))
    cyl(piston, 'chrome-piston', (0, .09, 0), .065, .28, 'alloy', 'y', 16)
    box(piston, 'saddle', (0, .25, 0), (.25, .05, .22), 'steel', .02)
    line(root, 'pump-lever', (.15, -.23, 0), (.42, .14, 0), .022, 'alloy')
    line(root, 'grip', (.42, .14, 0), (.49, .24, 0), .038, 'rubber')
    socket(root, 'socket-jack-top', (0, .36, 0), 'support')
    socket(root, 'handle-jack', (.49, .24, 0), 'control')
    return root


def repair():
    root = group('tyaga-repair')
    box(root, 'tool-case', (0, 0, 0), (.48, .28, .30), 'teal', .045)
    box(root, 'tool-case-lid', (0, .13, 0), (.49, .06, .31), 'teal-light', .03)
    for x in [-.15, .15]:
        box(root, 'case-catch', (x, .08, .16), (.05, .09, .025), 'ochre', .01)
    handle(root, 'handle-repair', (-.1, .17, 0), (.1, .17, 0), (0, .05, 0))
    line(root, 'wrench-mark', (-.07, -.06, .156), (.07, .07, .156), .018, 'ivory', 8)
    ring(root, 'wrench-ring', (-.075, -.066, .156), .035, .013, 'ivory', 'z', 10)
    return root


def crate():
    root = group('tyaga-crate')
    box(root, 'equipment-chest', (0, -.025, 0), (4.6, .45, 2.2), 'olive', .055)
    box(root, 'equipment-lid', (0, .215, 0), (4.6, .07, 2.2), 'olive-light', .035)
    for x in [-2.1, 2.1]:
        box(root, 'chest-rim', (x, 0, 0), (.10, .5, 2.2), 'steel', .02)
    for z in [-1.10, 1.10]:
        handle(root, 'handle-crate-' + str(z), (-.25, .04, z), (.25, .04, z), (0, 0, .06 if z > 0 else -.06))
    for x, z in [(-2.22, -.8), (2.22, .8)]:
        eye(root, 'socket-crate-' + str(x), (x, 0, z), 'x', .055)
    return root


def pontoon():
    root = group('tyaga-pontoon')
    # Six-metre sealed hull with rounded bow/corners, pronounced waterline band.
    box(root, 'sealed-hull', (0, 0, 0), (6, .65, .8), 'teal', .18)
    box(root, 'deck-cap', (0, .29, 0), (5.75, .08, .74), 'teal-light', .035)
    for x in [-1.8, 0, 1.8]:
        box(root, 'reinforcement-band', (x, 0, 0), (.12, .663, .813), 'steel', .04)
    for x in [-2.5, 2.5]:
        eye(root, 'socket-pontoon-' + str(x), (x, .325, 0), 'x', .08)
    for z in [-.39, .39]:
        box(root, 'waterline-stripe', (0, .10, z), (5.56, .09, .022), 'ivory', .018)
    return root


def platform(lift=False):
    root = group('tyaga-' + ('lift-platform' if lift else 'ferry-deck'))
    box(root, 'platform-chassis', (0, -.04, 0), (8.4, .12, 4.2), 'steel', .04)
    for i in range(24):
        box(root, 'platform-board', (-4.03 + i * .35, .045, 0), (.33, .11, 4.06), 'wood-light' if i % 4 else 'wood', .015)
    for z in [-2.04, 2.04]:
        box(root, 'edge-rail', (0, .14, z), (8.4, .19, .10), 'ochre', .025)
        for x in [-3.2, 0, 3.2]:
            line(root, 'rail-stanchion', (x, .2, z), (x, .95, z), .038, 'steel')
        line(root, 'handrail', (-3.25, .95, z), (3.25, .95, z), .040, 'steel')
    for x in ([-2.25, 2.25] if lift else [-2.5, 2.5]):
        for z in [-1.7, 1.7]:
            box(root, 'pontoon-lock-housing', (x, -.15 if lift else -.05, z), (.35, .12 if lift else .10, .36), 'orange', .035)
            socket(root, 'socket-platform-' + str(x) + '-' + str(z), (x, -.20 if lift else -.10, z))
    if lift:
        for x, tag in [(-4.1, 'back'), (4.1, 'front')]:
            barrier = group('barrier-' + tag, root, (x, .20, -1.7))
            line(barrier, 'barrier-arm', (0, .45, 0), (0, .45, 3.4), .06, 'ochre')
            for z in [.45, 1.25, 2.05, 2.85]:
                line(barrier, 'barrier-band', (0, .45, z), (0, .45, z + .15), .063, 'steel')
        for z in [-1.7, 1.7]:
            eye(root, 'socket-lift-cable-' + str(z), (0, .14, z), 'x', .10)
        socket(root, 'control-lift', (3.6, 1.0, 1.9), 'control')
    else:
        box(root, 'drive-clamp-receiver', (-4.15, -.05, 2.0), (.10, .10, .18), 'orange', .018)
        cyl(root, 'drive-clamp-seat', (-4.18, -.05, 2.0), .045, .04, 'steel', 'x')
        socket(root, 'socket-drive', (-4.2, -.05, 2.0), 'drive')
        for x in [-4.1, 4.1]:
            eye(root, 'socket-mooring-' + str(x), (x, .15, 0), 'y', .065)
    return root


def drive():
    root = group('tyaga-drive')
    box(root, 'drive-housing', (0, .12, 0), (.63, .48, .48), 'orange', .10)
    box(root, 'drive-cowl', (0, .38, 0), (.58, .11, .43), 'ivory', .055)
    for i in range(5):
        box(root, 'drive-vent', (-.323, .04 + i * .057, 0), (.015, .025, .30), 'steel', .008)
    cyl(root, 'drive-shaft', (0, -.26, 0), .07, .55, 'alloy', 'y')
    gear = group('propeller', root, (0, -.54, 0))
    cyl(gear, 'propeller-hub', (0, 0, 0), .075, .14, 'ochre', 'x')
    for a in [0, TAU / 3, 2 * TAU / 3]:
        blade = ellipsoid(gear, 'propeller-blade', (0, .17 * math.cos(a), .17 * math.sin(a)), (.065, .34, .12), 'alloy', 10, 6)
        blade.rotation_euler.x = a
    tiller = group('tiller', root, (.10, .24, 0))
    line(tiller, 'tiller-arm', (0, 0, 0), (.56, .02, 0), .03, 'steel')
    line(tiller, 'tiller-grip', (.56, .02, 0), (.72, .02, 0), .045, 'rubber')
    pipe(root, 'service-lid-loop', [(-.16, .44, 0), (-.16, .52, 0), (.16, .52, 0), (.16, .44, 0)], .024, 'steel')
    carry = group('balanced-carry-handle', root)
    carry['canonicalGeometry'] = True
    carry['canonicalPosition'] = [0, 0, 0]
    for x in [-.21, .11]:
        line(carry, 'carry-handle-upright', (x, .40, 0), (x, .58, 0), .018, 'steel')
    line(carry, 'carry-handle-crossbar', (-.21, .58, 0), (.11, .58, 0), .02, 'steel')
    line(carry, 'carry-handle-grip', (-.15, .58, 0), (.05, .58, 0), .02, 'rubber')
    socket(carry, 'handle-drive', (-.05, .60, 0), 'handle')
    # The clamp is in the final body frame, so the installed engine sits outside
    # the stern while its propeller stays under water through a complete turn.
    clamp = group('mount-clamp', root)
    clamp['canonicalGeometry'] = True
    clamp['canonicalPosition'] = [0, 0, 0]
    for z in [-.12, .12]:
        line(clamp, 'clamp-arm', (-.20, .31, z), (.50, .51, z), .025, 'steel')
    box(clamp, 'clamp-crosshead', (.51, .52, 0), (.12, .09, .29), 'orange', .02)
    cyl(clamp, 'clamp-pivot', (.55, .55, 0), .035, .31, 'alloy', 'z', 12)
    for z in [-.165, .165]:
        cyl(clamp, 'clamp-bolt', (.55, .55, z), .042, .025, 'steel', 'z', 6)
    socket(clamp, 'socket-drive-mount', (.55, .55, 0), 'drive')
    socket(root, 'handle-tiller', (.82, .26, 0), 'control')
    return root


def lift_frame():
    root = group('tyaga-lift-frame')
    for x in [-4.6, 4.6]:
        for z in [-2.5, 2.5]:
            box(root, 'lift-guide', (x, 5.9, z), (.3, 11.8, .3), 'steel', .03)
            box(root, 'guide-foot', (x, .15, z), (.8, .3, .8), 'concrete', .06)
        box(root, 'top-crossbeam', (x, 11.65, 0), (.40, .30, 5.3), 'orange', .03)
    for z in [-2.5, 2.5]:
        box(root, 'top-runner', (0, 11.65, z), (9.5, .3, .3), 'orange', .03)
    # External staircase is a separate physical component, never decorative travel.
    for y in [i * .22 for i in range(28)]:
        box(root, 'service-step', (-5.4, y, -2.8 + y * .45), (1.2, .10, .33), 'steel-light', .012)
    for z in [-1.7, 1.7]:
        cyl(root, 'top-sheave', (0, 11.2, z), .27, .16, 'ochre', 'z', 20)
        socket(root, 'socket-top-cable-' + str(z), (0, 11.0, z), 'support')
    socket(root, 'socket-lift-drive', (-4.45, 6.5, -2.7), 'drive')
    return root


def lift_gear():
    root = group('tyaga-lift-gear')
    box(root, 'gearbox-foundation', (0, 0, 0), (.9, .22, .65), 'steel', .04)
    cyl(root, 'gearcase', (0, .24, 0), .29, .50, 'orange', 'z', 24)
    pulley = group('lift-drum', root, (0, .24, 0))
    cyl(pulley, 'drum-core', (0, 0, 0), .23, .60, 'steel', 'z', 20)
    for z in [-.32, .32]:
        cyl(pulley, 'drum-flange', (0, 0, z), .32, .05, 'ochre', 'z', 20)
    socket(root, 'socket-gear-drive', (.44, .15, 0), 'drive')
    return root


def ramp():
    root = group('tyaga-ramp')
    box(root, 'ramp-frame', (0, -.04, 0), (3.0, .12, 3.4), 'steel', .04)
    for i in range(13):
        box(root, 'traction-strip', (-1.38 + i * .23, .035, 0), (.20, .08, 3.2), 'wood-light', .015)
    for z in [-1.63, 1.63]:
        box(root, 'ramp-edge', (0, .06, z), (3, .15, .10), 'ochre', .02)
    socket(root, 'socket-ramp-hinge', (-1.5, 0, 0), 'hinge')
    return root


def rock(seed=1):
    root = group('tyaga-rock-' + str(seed))
    rng = random.Random(seed * 317)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1)
    obj = bpy.context.object
    for v in obj.data.vertices:
        v.co.x *= (1.45 if seed == 1 else 1.1) * rng.uniform(.85, 1.15)
        v.co.y *= 1.0 * rng.uniform(.85, 1.15)
        v.co.z = max(0, (v.co.z + .65) * (1.35 if seed == 3 else .85) * rng.uniform(.85, 1.15))
    finish(obj, 'weathered-rock', 'stone', root, False)
    obj.data.materials.append(M['stone-light'])
    obj.data.materials.append(M['stone-dark'])
    for poly in obj.data.polygons:
        poly.material_index = 1 if poly.normal.z > .6 else (2 if poly.normal.z < -.1 else 0)
    return root


def pine():
    root = group('tyaga-tree-pine')
    cyl(root, 'pine-trunk', (0, 1.25, 0), .16, 2.5, 'bark', 'y', 10, .09)
    for i, (y, radius, height) in enumerate([(1.5, 1.1, 1.4), (2.1, .9, 1.5), (2.8, .65, 1.35)]):
        cyl(root, 'pine-crown', (0, y, 0), radius, height, 'pine' if i != 1 else 'pine-light', 'y', 9, .06)
        for j in range(5):
            a = j * TAU / 5 + i
            line(root, 'pine-branch', (0, y - .25, 0), (.8 * radius * math.cos(a), y - .38, .8 * radius * math.sin(a)), .035, 'bark', 6)
    return root


def birch():
    root = group('tyaga-tree-birch')
    cyl(root, 'birch-trunk', (0, 1.5, 0), .12, 3, 'ivory', 'y', 10, .065)
    for i in range(7):
        ring(root, 'birch-bark-mark', (0, .4 + i * .32, 0), .11 - i * .006, .015, 'steel', 'y', 10)
    for i in range(6):
        a = i * 2.4
        endpoint = (.7 * math.cos(a), 2.8 + i * .11, .7 * math.sin(a))
        line(root, 'branch', (0, 1.9 + i * .12, 0), endpoint, .04, 'ivory', 8)
        ellipsoid(root, 'leaf-cluster', endpoint, (1.2, 1.1, 1.1), 'leaf' if i % 2 else 'leaf-light', 10, 6)
    return root


def shrub():
    root = group('tyaga-shrub')
    for i in range(5):
        a = i * 2.4
        ellipsoid(root, 'shrub-foliage', (.27 * math.cos(a), .30 + i * .025, .27 * math.sin(a)), (.60, .55, .60), 'pine-light' if i % 2 else 'pine', 10, 6)
    return root


def grass():
    root = group('tyaga-grass')
    for i in range(9):
        a = i * 2.4
        start = (.10 * math.cos(a), 0, .10 * math.sin(a))
        end = (.19 * math.cos(a), .32 + (i % 3) * .07, .19 * math.sin(a))
        line(root, 'grass-blade', start, end, .014, 'grass' if i % 2 else 'grass-light', 5)
    return root


def sign():
    root = group('tyaga-route-sign')
    box(root, 'sign-post', (0, .60, 0), (.10, 1.20, .12), 'wood', .02)
    box(root, 'trail-sign', (0, 1.05, 0), (.80, .34, .07), 'ivory', .045)
    for a, b in [((-.25, 1.05, .045), (.24, 1.05, .045)), ((.07, 1.18, .045), (.24, 1.05, .045)), ((.07, .92, .045), (.24, 1.05, .045))]:
        line(root, 'direction-chevron', a, b, .025, 'pine', 6)
    return root


def camp():
    root = group('tyaga-camp')
    # The camp marker is scenery; the full 14m zone is drawn by the renderer.
    for x in [-.6, .6]:
        box(root, 'camp-post', (x, .65, 0), (.12, 1.3, .12), 'wood', .02)
    box(root, 'camp-board', (0, 1.13, 0), (1.5, .65, .12), 'pine', .08)
    for a, b in [((-.32, 1.05, .075), (0, 1.35, .075)), ((0, 1.35, .075), (.32, 1.05, .075)), ((-.32, 1.05, .075), (.32, 1.05, .075))]:
        line(root, 'camp-symbol', a, b, .025, 'ivory', 6)
    for x in [-.9, .9]:
        box(root, 'supply-crate', (x, .22, -.45), (.55, .44, .55), 'wood-light', .04)
    return root


def station():
    root = group('tyaga-station')
    box(root, 'station-shed', (0, 1.15, 0), (3.6, 2.3, 2.5), 'ivory', .08)
    for z in [-1.3, 1.3]:
        roof = box(root, 'station-roof', (0, 2.45, z * .48), (4.0, .18, 1.6), 'pine', .035)
        roof.rotation_euler.x = .27 if z > 0 else -.27
    box(root, 'station-door', (.65, .85, 1.266), (.85, 1.7, .05), 'orange', .045)
    box(root, 'station-window', (-.7, 1.35, 1.269), (1.0, .75, .05), 'glass', .035)
    box(root, 'window-divider', (-.7, 1.35, 1.30), (.05, .78, .04), 'ivory', .008)
    cyl(root, 'station-beacon', (1.2, 2.73, 0), .11, .22, 'ochre', 'y', 16)
    box(root, 'station-plinth', (0, .07, 0), (4.0, .14, 2.8), 'stone', .06)
    return root


def rock_ring():
    root = group('tyaga-rock-ring')
    box(root, 'anchor-plate', (0, 0, 0), (.36, .12, .36), 'steel', .025)
    for x in [-.12, .12]:
        for z in [-.12, .12]:
            cyl(root, 'anchor-bolt', (x, .07, z), .035, .025, 'alloy', 'y', 6)
    eye(root, 'socket-ring', (0, .16, 0), 'z', .12)
    return root


def bridge_mount():
    # Origin is the canonical eye centre. Only bridge mounts have a buried base;
    # ordinary hill/ferry rock rings keep their own existing model and origin.
    root = group('tyaga-bridge-mount')
    box(root, 'embedded-mount-plate', (0, -.25, 0), (.36, .06, .36), 'steel', .010)
    for x in [-.12, .12]:
        for z in [-.12, .12]:
            cyl(root, 'embedded-mount-bolt', (x, -.202, z), .035, .04, 'alloy', 'y', 6)
    for x in [-.10, .10]:
        box(root, 'mount-eye-stand', (x, -.14, 0), (.04, .18, .05), 'steel', .006)
    arc = ring(root, 'bridge-mount-eye', (0, 0, 0), .12, .032, 'ochre', 'z', 16)
    # Preserve the actual ellipse of the original exported ring, not a guessed
    # bounding cube. Blender Z is canonical Y.
    arc.scale.z = 80 / 93
    socket(root, 'socket-ring', (0, 0, 0))
    return root


def bridge_mount_collider():
    parts = [{'name': 'plate', 'shape': 'box', 'center': [0, -.25, 0], 'halfExtents': [.18, .03, .18]}]
    parts += [{'name': f'bolt-{x}-{z}', 'shape': 'cylinder', 'center': [x, -.202, z],
        'radius': .035, 'halfHeight': .02, 'axis': 'Y'} for x in [-.12, .12] for z in [-.12, .12]]
    parts += [{'name': f'stand-{x}', 'shape': 'box', 'center': [x, -.14, 0],
        'halfExtents': [.02, .09, .025]} for x in [-.10, .10]]
    for i in range(16):
        vertices = []
        for section in [i, (i + 1) % 16]:
            a = TAU * section / 16
            for j in range(6):
                b = TAU * j / 6
                radius = .12 + math.cos(b) * .032
                vertices += [radius * math.cos(a), radius * math.sin(a) * 80 / 93, math.sin(b) * .032]
        parts.append({'name': f'eye-{i:02d}', 'shape': 'convexHull', 'vertices': vertices})
    return {'shape': 'compound', 'parts': parts,
        'physicsSource': 'games/tyaga/src/server-world/compound.ts:bridgeMountParts',
        'mountDomain': 'AnchorDefinition.mount=deck only; socket-origin at bridge mounting point'}


def hazard_edge():
    root = group('tyaga-hazard-edge')
    for z in [-.5, .5]:
        box(root, 'edge-stake', (0, .35, z), (.12, .7, .12), 'wood', .02)
    box(root, 'warning-board', (0, .55, 0), (.08, .22, 1.2), 'ochre', .025)
    for z in [-.4, -.1, .2, .5]:
        box(root, 'warning-stripe', (.046, .55, z), (.012, .22, .1), 'steel', .008)
    return root


def concrete_block():
    root = group('tyaga-concrete-block')
    box(root, 'reinforced-road-block', (0, 0, 0), (3.6, 1.2, 2.8), 'concrete', .16)
    for x in [-1.2, 1.2]:
        eye(root, 'socket-block-' + str(x), (x, .60, 0), 'z', .12)
    for z in [-1.405, 1.405]:
        box(root, 'block-warning-strip', (0, .1, z), (3.0, .18, .015), 'ochre', .01)
        for x in [-1.2, -.6, 0, .6, 1.2]:
            box(root, 'block-dark-stripe', (x, .1, z * 1.01), (.18, .18, .01), 'steel', .008)
    return root


def barrier():
    root = group('tyaga-barrier')
    for z in [-1.6, 1.6]:
        box(root, 'barrier-post', (0, 0, z), (.12, .75, .12), 'steel', .018)
    box(root, 'barrier-beam', (0, .22, 0), (.12, .18, 3.4), 'ochre', .025)
    for z in [-1.35, -.75, -.15, .45, 1.05]:
        box(root, 'barrier-stripe', (.063, .22, z), (.009, .18, .15), 'steel', .006)
    socket(root, 'socket-barrier-hinge', (0, 0, -1.6), 'hinge')
    return root


def merge_static(root):
    # Keep sockets, functional pivots, skinned meshes and damage states independent.
    for parent in [root] + [o for o in root.children_recursive if o.type == 'EMPTY']:
        meshes = [o for o in parent.children if o.type == 'MESH' and not o.get('damageOnly')]
        if len(meshes) < 2:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        meshes[0].name = parent.name + '-surface'


def export_asset(asset_id, builder, dimensions, mass=None, origin='center', collider=None):
    reset()
    root = builder()
    merge_static(root)
    bpy.context.view_layer.update()
    if asset_id in {'winch', 'anchor', 'strap', 'jack', 'repair', 'drive', 'ring', 'crate', 'hook', 'beam', 'deck-folded',
                     'generator-large', 'generator', 'optics', 'pump-large', 'pump', 'mast'}:
        # Tool dimensions are art/physics agreed. Bake the production normalization
        # into the exported hierarchy; the game never compensates with a guess scale.
        def normalized_body_mesh(obj):
            if obj.type != 'MESH':
                return False
            parent = obj.parent
            while parent:
                if parent.get('canonicalGeometry'):
                    return False
                parent = parent.parent
            return True
        points = [obj.matrix_world @ v.co for obj in root.children_recursive
                  if normalized_body_mesh(obj) for v in obj.data.vertices]
        low = Vector(tuple(min(v[i] for v in points) for i in range(3)))
        high = Vector(tuple(max(v[i] for v in points) for i in range(3)))
        center = (low + high) / 2
        target = Vector((dimensions[0], dimensions[2], dimensions[1]))
        factor = Vector(tuple(target[i] / (high[i] - low[i]) for i in range(3)))
        root.scale = factor
        root.location = Vector(tuple(-center[i] * factor[i] for i in range(3)))
        bpy.context.view_layer.update()
    # Functional attachment coordinates are authored in the final body frame.
    # Keep their visible eye and socket together after bounds normalization.
    for obj in root.children_recursive:
        if obj.get('canonicalPosition') is not None:
            if obj.get('canonicalGeometry'):
                obj.matrix_world = Matrix.Translation(p(obj['canonicalPosition']))
            else:
                obj.location = obj.parent.matrix_world.inverted() @ p(obj['canonicalPosition'])
    bpy.context.view_layer.update()
    sockets = {}
    for obj in root.children_recursive:
        if obj.get('tyagaRole'):
            at = obj.matrix_world.translation
            sockets[obj.name] = [round(at.x, 6), round(at.z, 6), round(-at.y, 6)]
    nodes = [obj.name for obj in root.children_recursive if obj.type == 'EMPTY' and not obj.get('tyagaRole')]
    triangles = sum(len(obj.data.polygons) for obj in root.children_recursive if obj.type == 'MESH')
    # Evaluate actual triangle count, independent of n-gon topology.
    triangles = 0
    for obj in root.children_recursive:
        if obj.type == 'MESH':
            obj.data.calc_loop_triangles()
            triangles += len(obj.data.loop_triangles)
    filename = asset_id + '.glb'
    path = OUT / filename
    root['assetId'] = asset_id
    root['metersPerUnit'] = 1
    root['origin'] = origin
    root['nominalDimensionsXYZ'] = dimensions
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB',
        export_yup=True, export_animations=True, export_extras=True,
        export_apply=True, export_cameras=False, export_lights=False,
        export_skins=True, export_materials='EXPORT')
    if asset_id == 'truck':
        collider = {'shape': 'compound', 'parts': [
            {'center': [-.4, .275, 0], 'halfExtents': [2.65, .075, 1.2]},
            {'center': [2.7, .62, 0], 'halfExtents': [.48, .64, 1.1]},
            {'center': [-.2, -.32, -1.2], 'halfExtents': [2.9, .08, .1]},
            {'center': [-.2, -.32, 1.2], 'halfExtents': [2.9, .08, .1]},
            {'center': [-.3, -.37, 0], 'halfExtents': [2.5, .07, 1.1]}],
            'supportVariants': {
                'low': [{'center': [x, .425, 0], 'halfExtents': [.15, .075, .9]} for x in [-1.9, .5]],
                'high': [{'center': [x, .925, 0], 'halfExtents': [.15, .575, .9]} for x in [-1.6, 1.6]]},
            'raycastWheels': {'centers': [[x, -.45, z] for x, z in [(1.8,-1.05),(1.8,1.05),(-1.8,-1.05),(-1.8,1.05)]], 'radius': .5},
            'separateCrate': {'model': 'crate', 'center': [-.3,-.05,0], 'massKg': 50}, 'emptyAssemblyMassKg': 1050}
    if asset_id in {'ferry-deck', 'lift'}:
        collider = {'shape': 'compound', 'parts': [
            {'center': [0, 0, 0], 'halfExtents': [4.2, .1, 2.1]}] +
            [{'center': [0, .95, z], 'halfExtents': [4, .04, .04]} for z in [-2.04,2.04]] +
            [{'center': [x, .575, z], 'halfExtents': [.04, .375, .04]} for x in [-3.2,0,3.2] for z in [-2.04,2.04]]}
    if asset_id == 'drive':
        collider = {'shape': 'compound', 'parts': [
            {'center': [0, .32, 0], 'halfExtents': [.425, .275, .25], 'massFraction': .65},
            {'center': [-.255, -.22, 0], 'halfExtents': [.065, .325, .065], 'massFraction': .20},
            {'center': [-.255, -.433, 0], 'halfExtents': [.075, .167, .3], 'massFraction': .10},
            {'center': [.55, .55, 0], 'halfExtents': [.05, .05, .075], 'massFraction': .05}],
            'physicsSource': 'games/tyaga/src/server-world/world.ts:createBody'}
    if asset_id == 'deck':
        collider = {'shape': 'compound', 'parts': [
            {'center': [0, 0, 0], 'halfExtents': [1.6, .09, 1.5]}] +
            [{'center': [x, 0, z], 'halfExtents': [.2, .09, half_z]}
                for x in [-1.8, 1.8] for z, half_z in [(0, 1.13), (-1.435, .065), (1.435, .065)]],
            'openSlots': [{'x': sorted([1.6 * sx, 2 * sx]), 'z': [1.25 * sz - .12, 1.25 * sz + .12], 'throughY': True}
                for sx in [-1, 1] for sz in [-1, 1]],
            'interactionHardware': {'node': 'deck-interaction-hardware', 'role': 'carrying grips and small fastener heads; not a load-bearing surface',
                'socketCenters': [[0, .10, -1.50], [0, .10, 1.50]]},
            'physicsSource': 'games/tyaga/src/server-world/compound.ts:deckParts'}
    entry = dict(assetId=asset_id, runtimePath='/assets/tyaga/models/' + filename,
        source='games/tyaga/art/source/generate_models.py', author='Iva Games / original procedural production',
        license='project-original', version='tyaga-art@1', origin=origin, units='metres',
        axes={'forward': '+X', 'up': '+Y'}, dimensionsXYZ=dimensions, massKg=mass,
        collider=collider or {'shape': 'box', 'halfExtents': [d / 2 for d in dimensions]},
        sockets=sockets, animatedNodes=nodes, triangles=triangles,
        bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        validation={'export': 'verified', 'gameplayVisual': 'pending', 'collisionAlignment': 'pending'})
    MANIFEST.append(entry)
    print('TYAGA_ASSET ' + json.dumps({k: entry[k] for k in ['assetId', 'triangles', 'bytes']}), flush=True)


PALETTE = {
    'orange': ('D97736', .45, .20), 'orange-light': ('E69755', .50, .10),
    'steel': ('344955', .48, .65), 'steel-light': ('57717B', .50, .55),
    'alloy': ('B5C5C5', .34, .75), 'rubber': ('26363B', .92, 0), 'rubber-edge': ('344247', .87, 0),
    'ivory': ('F5F7F2', .57, .05), 'ochre': ('EBC75A', .55, .15),
    'teal': ('37BCD0', .47, .18), 'teal-light': ('83D7DB', .55, .08),
    'glass': ('44666E', .18, .4), 'lens': ('75CED2', .15, .45), 'lamp': ('FFF0BB', .25, .1),
    'red': ('D64A43', .55, .1), 'rust': ('9A5B46', .92, 0),
    'wood': ('A78A61', .88, 0), 'wood-light': ('C9AD80', .83, 0),
    'rope': ('8F8A72', .95, 0), 'rope-light': ('BBB599', .93, 0),
    'pine': ('397D68', .93, 0), 'pine-light': ('55927A', .90, 0),
    'leaf': ('73A375', .93, 0), 'leaf-light': ('A0BB7C', .91, 0),
    'olive': ('738C70', .71, .1), 'olive-light': ('A0AD81', .76, .03),
    'stone': ('AFBEB8', .94, 0), 'stone-light': ('DCE8E4', .94, 0), 'stone-dark': ('7A948D', .97, 0),
    'concrete': ('A7B7B3', .95, 0), 'bark': ('776E55', .95, 0),
    'grass': ('91A077', .95, 0), 'grass-light': ('B7B68B', .95, 0),
    'skin': ('CFA889', .8, 0), 'hair': ('514A40', .92, 0),
    'cloth-blue': ('4D83A3', .91, 0), 'cloth-red': ('C96557', .91, 0),
    'cloth-green': ('579B78', .91, 0), 'cloth-violet': ('8C79AA', .91, 0),
    'cloth-gold': ('D2AB4B', .91, 0), 'cloth-sky': ('68ACB4', .91, 0),
}
for name, (color, rough, metal) in PALETTE.items():
    M[name] = material(name, color, rough, metal)

ASSETS = [
    ('truck', truck, [6.4, 2.43, 2.6], 1000),
    ('generator-large', lambda: generator(True), [3.4, 2.2, 2.1], 750),
    ('generator', lambda: generator(False), [1.1, 1, .9], 180),
    ('optics', optics, [.9, .9, .8], 80), ('mast', mast, [7.2, 1, .9], 520),
    ('pump-large', lambda: pump(True), [3.2, 2.7, 2.8], 900),
    ('pump', lambda: pump(False), [1, 1, .9], 140),
    ('deck', lambda: deck(False), [4, .18, 3], 110),
    ('deck-folded', lambda: deck(True), [1.5, .4, 1.5], 110),
    ('beam', beam, [3, .3, .3], 24), ('winch', winch, [.62, .55, .98], 35),
    ('anchor', anchor, [.42, .85, .26], 12), ('hook', hook, [.18, .22, .12], .08),
    ('strap', strap, [.42, .3, .14], 2), ('jack', jack, [.70, .72, .36], 18),
    ('repair', repair, [.49, .42, .31], 6), ('crate', crate, [4.6, .5, 2.2], 50),
    ('pontoon', pontoon, [6, .65, .8], 200),
    ('ferry-deck', lambda: platform(False), [8.4, .2, 4.2], 280),
    ('drive', drive, [1.2, 1.2, .6], 40),
    ('lift', lambda: platform(True), [8.4, .2, 4.2], 520),
    ('lift-frame', lift_frame, [10.6, 11.8, 6.2], None, 'ground'),
    ('lift-gear', lift_gear, [.9, .8, .7], None), ('ramp', ramp, [3, .18, 3.4], None),
    ('block', concrete_block, [3.6, 1.2, 2.8], 280),
    ('rock-a', lambda: rock(1), [3, 1.5, 2], None, 'ground'),
    ('rock-b', lambda: rock(2), [2.2, 1.5, 2], None, 'ground'),
    ('rock-c', lambda: rock(3), [2.2, 2.3, 2], None, 'ground'),
    ('tree-pine', pine, [2.2, 3.5, 2.2], None, 'ground'),
    ('tree-birch', birch, [2.8, 4, 2.8], None, 'ground'),
    ('shrub', shrub, [1.2, .8, 1.2], None, 'ground'),
    ('grass', grass, [.5, .5, .5], None, 'ground'),
    ('route-sign', sign, [.8, 1.3, .12], None, 'ground'),
    ('camp', camp, [2.4, 1.5, 1], None, 'ground'),
    ('station', station, [4, 2.9, 2.8], None, 'ground'),
    ('ring', rock_ring, [.36, .32, .36], None),
    ('bridge-mount', bridge_mount, [.36, .28 + .152 * 80 / 93, .36], None, 'socket', bridge_mount_collider()),
    ('hazard-edge', hazard_edge, [.12, .7, 1.2], None, 'ground'),
    ('barrier', barrier, [.12, .75, 3.4], 35),
]


def main():
    import sys
    requested = set(sys.argv[sys.argv.index('--') + 1:]) if '--' in sys.argv else set()
    for data in ASSETS:
        if requested and data[0] not in requested:
            continue
        export_asset(*data)
    path = OUT / 'manifest.json'
    previous = json.loads(path.read_text())['assets'] if path.exists() else []
    changed = {entry['assetId'] for entry in MANIFEST}
    entries = [entry for entry in previous if entry['assetId'] not in changed] + MANIFEST
    path.write_text(json.dumps({'version': 'tyaga-art@1', 'assets': entries}, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
