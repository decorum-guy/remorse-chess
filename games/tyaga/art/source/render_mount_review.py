"""Blender-only review of the exact authored deck/bridge-mount interface.

This is an art/geometry inspection, not a gameplay or delivery acceptance run.
blender -b -t 2 --python games/tyaga/art/source/render_mount_review.py -- output-dir
"""
import bpy
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / 'public/assets/tyaga/models'
OUTPUT = Path(sys.argv[sys.argv.index('--') + 1]) if '--' in sys.argv else Path('/tmp/tyaga-mount-review')
OUTPUT.mkdir(parents=True, exist_ok=True)


def p(v):
    return Vector((v[0], -v[2], v[1]))


def load(name, at):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(MODELS / (name + '.glb')))
    objects = set(bpy.data.objects) - before
    root = bpy.data.objects.new('review-' + name, None)
    bpy.context.collection.objects.link(root)
    for obj in objects:
        if obj.parent not in objects:
            obj.parent = root
    root.location = p(at)


bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
load('deck', (0, .09, 0))
for x in [-1.8, 1.8]:
    for z in [-1.25, 1.25]:
        load('bridge-mount', (x, .18, z))
bpy.ops.mesh.primitive_plane_add(size=20)
ground = bpy.context.object
ground.name = 'review-road-plane-Y0'
mat = bpy.data.materials.new('review-road')
mat.use_nodes = True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (.30, .36, .32, 1)
mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = .94
ground.data.materials.append(mat)

scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = False
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (.70, .81, .83, 1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .65
for position, power, size in [((-3, 7, 4), 1100, 5), ((5, 4, -3), 600, 4)]:
    data = bpy.data.lights.new('review-softbox', 'AREA')
    data.energy = power
    data.shape = 'DISK'
    data.size = size
    lamp = bpy.data.objects.new('review-softbox', data)
    bpy.context.collection.objects.link(lamp)
    lamp.location = p(position)
    lamp.rotation_euler = (p((0, .2, 0)) - lamp.location).to_track_quat('-Z', 'Y').to_euler()
camera_data = bpy.data.cameras.new('review-camera')
camera_data.type = 'ORTHO'
camera = bpy.data.objects.new('review-camera', camera_data)
bpy.context.collection.objects.link(camera)
scene.camera = camera
scene.render.resolution_x = 1200
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.image_settings.file_format = 'PNG'

for filename, target, position, scale in [
        ('deck-installed.png', (0, .1, 0), (5, 8, 5), 5.7),
        ('mount-slot-close.png', (1.77, .15, 1.25), (3.6, 2.0, 2.9), 1.15)]:
    camera.location = p(position)
    camera.rotation_euler = (p(target) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_data.ortho_scale = scale
    scene.render.filepath = str(OUTPUT / filename)
    bpy.ops.render.render(write_still=True)
    print('ART_GEOMETRY_REVIEW_ONLY ' + scene.render.filepath, flush=True)
