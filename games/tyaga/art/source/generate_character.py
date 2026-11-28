"""Original rigged TYAGA field worker, two heads/packs and thirteen motion clips.

Uses the same authored surface helpers as generate_models.py. Every limb is bound
to one common armature; the segmented rainwear and gloves deliberately keep a
readable small-scale silhouette. No character mesh or animation was imported.
"""
import bpy
import hashlib
import importlib.util
import json
import math
from pathlib import Path
from mathutils import Vector, Quaternion

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('tyaga_models', HERE / 'generate_models.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
OUT = g.OUT

BONES = {
    'root': ((0, -.87, 0), (0, -.67, 0), None),
    'pelvis': ((0, -.12, 0), (0, .05, 0), 'root'),
    'spine': ((0, .05, 0), (0, .34, 0), 'pelvis'),
    'neck': ((0, .34, 0), (0, .49, 0), 'spine'),
    'head': ((0, .49, 0), (0, .78, 0), 'neck'),
    'thigh-L': ((0, -.13, -.14), (0, -.43, -.14), 'pelvis'),
    'calf-L': ((0, -.43, -.14), (0, -.74, -.14), 'thigh-L'),
    'foot-L': ((0, -.74, -.14), (.14, -.81, -.14), 'calf-L'),
    'thigh-R': ((0, -.13, .14), (0, -.43, .14), 'pelvis'),
    'calf-R': ((0, -.43, .14), (0, -.74, .14), 'thigh-R'),
    'foot-R': ((0, -.74, .14), (.14, -.81, .14), 'calf-R'),
    'upperarm-L': ((0, .31, -.27), (0, .08, -.34), 'spine'),
    'forearm-L': ((0, .08, -.34), (0, -.13, -.34), 'upperarm-L'),
    'hand-L': ((0, -.13, -.34), (0, -.22, -.34), 'forearm-L'),
    'upperarm-R': ((0, .31, .27), (0, .08, .34), 'spine'),
    'forearm-R': ((0, .08, .34), (0, -.13, .34), 'upperarm-R'),
    'hand-R': ((0, -.13, .34), (0, -.22, .34), 'forearm-R'),
}
MESHES = []


def bind(obj, bone):
    group = obj.vertex_groups.new(name=bone)
    group.add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
    MESHES.append(obj)
    return obj


def body(root):
    box = lambda n, at, size, mat, bone, bevel=.035: bind(g.box(root, n, at, size, mat, bevel), bone)
    ell = lambda n, at, size, mat, bone: bind(g.ellipsoid(root, n, at, size, mat, 12, 8), bone)
    line = lambda n, a, b, r, mat, bone: bind(g.line(root, n, a, b, r, mat, 12), bone)
    # Rounded two-tone waterproof field jacket, articulated trousers and boots.
    ell('rain-jacket', (0, .15, 0), (.38, .52, .49), 'cloth-blue', 'spine')
    box('jacket-front-bib', (.16, .15, 0), (.065, .35, .35), 'orange', 'spine', .025)
    box('reflective-chest-band', (.197, .20, 0), (.015, .035, .34), 'ivory', 'spine', .006)
    box('chest-pocket', (.204, .10, -.075), (.018, .10, .13), 'orange-light', 'spine', .01)
    box('jacket-zip', (.205, .23, 0), (.016, .27, .012), 'steel', 'spine', .004)
    ell('hips', (0, -.12, 0), (.33, .23, .42), 'steel', 'pelvis')
    box('belt', (.02, -.02, 0), (.35, .065, .43), 'steel', 'pelvis', .015)
    box('belt-buckle', (.20, -.02, 0), (.025, .048, .07), 'ochre', 'pelvis', .008)
    for sign, side in [(-1, 'L'), (1, 'R')]:
        z = sign * .14
        line('trouser-upper-' + side, (0, -.12, z), (0, -.43, z), .105, 'steel-light', 'thigh-' + side)
        ell('knee-pad-' + side, (.075, -.40, z), (.10, .15, .14), 'steel', 'thigh-' + side)
        line('trouser-lower-' + side, (0, -.43, z), (0, -.72, z), .085, 'steel-light', 'calf-' + side)
        box('boot-' + side, (.07, -.77, z), (.31, .20, .21), 'rubber', 'foot-' + side, .05)
        box('boot-sole-' + side, (.07, -.858, z), (.32, .034, .215), 'rubber-edge', 'foot-' + side, .014)
        box('boot-toecap-' + side, (.19, -.75, z), (.07, .12, .21), 'steel', 'foot-' + side, .025)
        for x in [-.02, .04, .1]:
            line('boot-lacing-' + side, (x, -.674, z - .06), (x + .025, -.674, z + .06), .006, 'ochre', 'foot-' + side)
        arm_z = sign * .27
        line('jacket-upper-sleeve-' + side, (0, .31, arm_z), (0, .08, sign * .34), .095, 'cloth-blue', 'upperarm-' + side)
        line('jacket-lower-sleeve-' + side, (0, .08, sign * .34), (0, -.10, sign * .34), .078, 'cloth-blue', 'forearm-' + side)
        ell('work-glove-' + side, (.025, -.16, sign * .34), (.16, .18, .13), 'ochre', 'hand-' + side)
        ell('glove-thumb-' + side, (.09, -.13, sign * .30), (.09, .10, .065), 'ochre', 'hand-' + side)
    line('neck', (0, .36, 0), (0, .51, 0), .085, 'skin', 'neck')
    # Default head has helmet and radio earmuff. Variant replaces this named mesh.
    before = len(MESHES)
    ell('head', (.035, .61, 0), (.34, .39, .32), 'skin', 'head')
    for z in [-.083, .083]:
        ell('eye', (.199, .635, z), (.025, .036, .027), 'steel', 'head')
        ell('ear', (.01, .61, z / abs(z) * .17), (.08, .11, .06), 'skin', 'head')
    ell('nose', (.213, .594, 0), (.075, .08, .068), 'skin', 'head')
    line('smile', (.199, .538, -.045), (.199, .538, .045), .008, 'hair', 'head')
    ell('helmet-shell', (.015, .79, 0), (.41, .17, .39), 'ivory', 'head')
    box('helmet-brim', (.055, .758, 0), (.47, .035, .41), 'ivory', 'head', .016)
    box('helmet-stripe', (.03, .858, 0), (.31, .018, .06), 'orange', 'head', .006)
    ell('ear-radio', (-.012, .64, .20), (.09, .14, .045), 'steel', 'head')
    line('radio-aerial', (-.03, .71, .22), (-.08, .82, .22), .009, 'steel', 'head')
    for obj in MESHES[before:]:
        obj['variantGroup'] = 'head'
        obj['variantIndex'] = 0
    # Shared rig; backpack default geometry weighted to spine.
    before = len(MESHES)
    box('backpack', (-.255, .15, 0), (.24, .42, .35), 'olive', 'spine', .06)
    box('backpack-flap', (-.38, .24, 0), (.025, .18, .32), 'olive-light', 'spine', .025)
    for z in [-.10, .10]:
        box('pack-webbing', (-.396, .13, z), (.018, .34, .035), 'ochre', 'spine', .006)
        line('shoulder-webbing', (-.14, .36, z), (.16, .31, z), .025, 'olive-light', 'spine')
    for z in [-.13, .13]:
        box('pack-clasp', (-.412, .08, z), (.022, .05, .05), 'steel', 'spine', .008)
    for obj in MESHES[before:]:
        obj['variantGroup'] = 'backpack'
        obj['variantIndex'] = 0


def armature(root):
    data = bpy.data.armatures.new('TyagaFieldWorkerRig')
    rig = bpy.data.objects.new('TyagaFieldWorkerRig', data)
    bpy.context.collection.objects.link(rig)
    rig.parent = root
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    for name, (head, tail, parent) in BONES.items():
        bone = data.edit_bones.new(name)
        bone.head = g.p(head)
        bone.tail = g.p(tail)
        if parent:
            bone.parent = data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    # Keep alternate-head/backpack replacement possible on the common skeleton.
    skins = []
    parts = {part: [obj for obj in MESHES if obj.get('variantGroup', 'body') == part]
             for part in ['body', 'head', 'backpack']}
    for part in ['body', 'head', 'backpack']:
        meshes = parts[part]
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        skin = bpy.context.object
        skin.name = 'field-worker-skin' if part == 'body' else part + '-a'
        modifier = skin.modifiers.new('Tyaga common skeleton', 'ARMATURE')
        modifier.object = rig
        skin.parent = rig
        skins.append(skin)
    # Child attachment transforms are exported with the same skeleton.
    for side in ['L', 'R']:
        node = g.socket(root, 'socket-hand-' + side.lower(), (0, -.18, -.34 if side == 'L' else .34), 'hand')
        node.parent = rig
        node.parent_type = 'BONE'
        node.parent_bone = 'hand-' + side
        # Bone-parent coordinates start at the tail; -0.04 along its local Y
        # puts the socket in the mitten rather than below the fingertips.
        node.location = (0, -.04, 0)
    return rig, skins


def rotate(rig, bone_name, angle, axis=(0, 0, 1)):
    bone = rig.pose.bones[bone_name]
    rest = rig.data.bones[bone_name].matrix_local.to_quaternion()
    bone.rotation_mode = 'QUATERNION'
    bone.rotation_quaternion = rest.inverted() @ Quaternion(g.p(axis), angle) @ rest


def animations(rig):
    scene = bpy.context.scene
    scene.render.fps = 30
    specs = [('idle', 60), ('walk', 30), ('run', 22), ('jump', 24), ('fall', 30),
             ('land', 16), ('carry', 40), ('push', 30), ('hold', 40),
             ('crank', 30), ('repair', 40), ('driver', 40), ('stumble', 20)]
    for name, frames in specs:
        rig.animation_data_create()
        action = bpy.data.actions.new(name)
        rig.animation_data.action = action
        for f in range(0, frames + 1, 2):
            phase = f / frames * math.tau
            for bone in rig.pose.bones:
                bone.rotation_mode = 'QUATERNION'
                bone.rotation_quaternion = Quaternion()
                bone.location = (0, 0, 0)
            if name == 'idle':
                rotate(rig, 'spine', math.sin(phase) * .018)
                rotate(rig, 'head', math.sin(phase + .4) * .035, (0, 1, 0))
            elif name in ['walk', 'run', 'carry']:
                amp = .42 if name == 'walk' else (.67 if name == 'run' else .25)
                for side, sign in [('L', 1), ('R', -1)]:
                    v = math.sin(phase) * sign
                    rotate(rig, 'thigh-' + side, amp * v)
                    rotate(rig, 'calf-' + side, -max(0, -v) * amp * 1.2)
                    rotate(rig, 'upperarm-' + side, -amp * .8 * v if name != 'carry' else 1.05)
                    rotate(rig, 'forearm-' + side, .2 if name == 'walk' else (.5 if name == 'run' else .4))
                rig.pose.bones['root'].location.z = .018 * (1 - math.cos(phase * 2))
                if name == 'run':
                    rotate(rig, 'spine', -.10)
            elif name == 'jump':
                t = f / frames
                rotate(rig, 'thigh-L', -.25 + .30 * math.sin(t * math.pi))
                rotate(rig, 'thigh-R', .2 - .30 * math.sin(t * math.pi))
                rotate(rig, 'calf-L', -.6 * math.sin(t * math.pi))
                rotate(rig, 'calf-R', -.6 * math.sin(t * math.pi))
                for side in ['L', 'R']:
                    rotate(rig, 'upperarm-' + side, 1.3 * math.sin(t * math.pi))
            elif name == 'fall':
                for side, sign in [('L', 1), ('R', -1)]:
                    rotate(rig, 'upperarm-' + side, sign * .65, (1, 0, 0))
                    rotate(rig, 'forearm-' + side, .4)
                    rotate(rig, 'calf-' + side, -.35)
            elif name in ['land', 'stumble']:
                t = math.sin(f / frames * math.pi)
                rotate(rig, 'spine', -.28 * t)
                for side in ['L', 'R']:
                    rotate(rig, 'thigh-' + side, .3 * t)
                    rotate(rig, 'calf-' + side, -.55 * t)
                rig.pose.bones['root'].location.z = -.08 * t
            elif name in ['push', 'hold', 'crank', 'repair', 'driver']:
                rotate(rig, 'spine', -.12 if name in ['push', 'repair'] else -.02)
                for side in ['L', 'R']:
                    angle = 1.20 if name != 'repair' else .65
                    if name == 'crank':
                        angle += .30 * math.cos(phase + (0 if side == 'R' else .8))
                    if name == 'repair' and side == 'R':
                        angle += .20 * math.sin(phase * 2)
                    rotate(rig, 'upperarm-' + side, angle)
                    rotate(rig, 'forearm-' + side, .35 + (.22 * math.sin(phase) if name == 'crank' else 0))
                if name == 'driver':
                    for side in ['L', 'R']:
                        rotate(rig, 'thigh-' + side, 1.45)
                        rotate(rig, 'calf-' + side, -1.3)
            for bone in rig.pose.bones:
                bone.keyframe_insert(data_path='rotation_quaternion', frame=f)
                bone.keyframe_insert(data_path='location', frame=f)
        rig.animation_data.action = None
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, action)
        track.mute = True
    for track in rig.animation_data.nla_tracks:
        track.mute = False
    scene.frame_set(0)
    return [name for name, _ in specs]


def accessory_head():
    root = g.group('tyaga-head-b')
    # Same bone attachment centre as head-A; knitted cap and goggles.
    g.ellipsoid(root, 'head-b', (.035, .12, 0), (.33, .37, .31), 'skin')
    g.ellipsoid(root, 'knitted-cap', (.015, .27, 0), (.37, .18, .36), 'orange')
    g.box(root, 'cap-brim', (.035, .235, 0), (.38, .05, .35), 'orange-light', .02)
    for z in [-.08, .08]:
        g.ellipsoid(root, 'goggle-frame', (.192, .155, z), (.055, .09, .12), 'steel')
        g.ellipsoid(root, 'goggle-lens', (.219, .155, z), (.018, .065, .09), 'lens')
    g.ellipsoid(root, 'nose-b', (.216, .10, 0), (.07, .07, .07), 'skin')
    g.line(root, 'smile-b', (.195, .05, -.04), (.195, .05, .04), .008, 'hair')
    return root


def accessory_pack():
    root = g.group('tyaga-backpack-b')
    g.box(root, 'technical-pack', (-.255, .10, 0), (.23, .44, .34), 'orange', .06)
    g.cyl(root, 'bedroll', (-.27, .35, 0), .10, .40, 'ivory', 'z', 16)
    for z in [-.12, .12]:
        g.box(root, 'roll-strap', (-.37, .30, z), (.035, .30, .04), 'steel', .01)
    g.box(root, 'pack-pocket', (-.39, .05, 0), (.07, .16, .22), 'orange-light', .025)
    return root


def main():
    g.reset()
    root = g.group('tyaga-character')
    body(root)
    rig, skins = armature(root)
    clips = animations(rig)
    path = OUT / 'character.glb'
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', export_yup=True,
        export_animations=True, export_animation_mode='NLA_TRACKS', export_extras=True,
        export_skins=True, export_apply=False, export_cameras=False, export_lights=False)
    for skin in skins:
        skin.data.calc_loop_triangles()
    entry = dict(assetId='character', runtimePath='/assets/tyaga/models/character.glb',
        source='games/tyaga/art/source/generate_character.py', author='Iva Games / original procedural production',
        license='project-original', version='tyaga-art@1', origin='capsule-center', units='metres',
        axes={'forward': '+X', 'up': '+Y'}, dimensionsXYZ=[.6, 1.75, .6], massKg=80,
        collider={'shape':'capsule','radius':.3,'halfHeight':.575},
        sockets={'socket-hand-l':[0,-.18,-.34],'socket-hand-r':[0,-.18,.34]},
        skeleton=list(BONES), animations=clips,
        clothingMaterials=['cloth-blue','cloth-red','cloth-green','cloth-violet','cloth-gold','cloth-sky'],
        triangles=sum(len(skin.data.loop_triangles) for skin in skins), bytes=path.stat().st_size,
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        validation={'export':'verified','gameplayVisual':'pending','collisionAlignment':'pending'})
    entries=[entry]
    g.export_asset('character-head-b',accessory_head,[.4,.46,.36],origin='head-bone')
    g.export_asset('character-backpack-b',accessory_pack,[.3,.55,.4],origin='spine-bone')
    entries.extend(g.MANIFEST)
    manifest_path=OUT/'manifest.json'
    manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {'version':'tyaga-art@1','assets':[]}
    ids={e['assetId'] for e in entries}
    manifest['assets']=[a for a in manifest['assets'] if a['assetId'] not in ids]+entries
    manifest_path.write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    print('TYAGA_CHARACTER '+json.dumps({'triangles':entry['triangles'],'clips':clips,'bytes':entry['bytes']}),flush=True)


if __name__=='__main__':
    main()
