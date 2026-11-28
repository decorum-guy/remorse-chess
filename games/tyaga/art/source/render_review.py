"""Render authored asset reviews, never gameplay acceptance evidence.

blender -b --python games/tyaga/art/source/render_review.py -- /tmp/tyaga-art-review.png
"""
import bpy
import math
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT/'public/assets/tyaga/models'


def p(v):
    return Vector((v[0],-v[2],v[1]))


def load(name, at=(0,0,0), angle=0):
    before=set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(MODELS/(name+'.glb')))
    objects=set(bpy.data.objects)-before
    roots=[o for o in objects if o.parent not in objects]
    parent=bpy.data.objects.new('review-'+name,None)
    bpy.context.collection.objects.link(parent)
    for obj in roots:
        obj.parent=parent
    for obj in objects:
        if obj.name.startswith('cargo-support-high'):
            obj.hide_render = True
            for child in obj.children_recursive:
                child.hide_render = True
        if obj.type=='ARMATURE':
            if obj.animation_data:
                obj.animation_data.action=None
                for track in obj.animation_data.nla_tracks:
                    track.mute=True
            for bone in obj.pose.bones:
                bone.rotation_mode='QUATERNION'
                bone.rotation_quaternion=(1,0,0,0)
                bone.location=(0,0,0)
    parent.location=p(at)
    parent.rotation_euler.z=-angle
    return parent


bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
load('truck',(0,.95,0))
load('crate',(-.3,.9,0))
load('generator-large',(-.65,2.57,0))
load('optics',(1.7,1.77,.6))
load('pump',(1.7,1.82,-.6))
load('character',(3.65,.875,2.35),-.7)
load('deck',(-1.5,.09,3.6),.18)
load('winch',(2.4,.27,3.5))
load('jack',(2.1,.36,4.35))
load('anchor',(3.1,.42,4.25))
load('tree-pine',(-4.9,0,-2.5))
load('tree-birch',(4.1,0,-3.5))
load('rock-a',(-4.8,0,1.8))
load('shrub',(-4.5,0,.2))
load('grass',(4.4,0,2.1))
load('route-sign',(4.2,0,.2),-.8)
load('camp',(-2.9,0,-3.6),-.5)
bpy.ops.mesh.primitive_plane_add(size=200, location=(0,0,-.03))
mat=bpy.data.materials.new('review-ground')
mat.diffuse_color=(.58,.68,.59,1)
mat.use_nodes=True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.58,.68,.59,1)
mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.9
bpy.context.object.data.materials.append(mat)

scene=bpy.context.scene
scene.render.engine='CYCLES'
scene.cycles.samples=64
scene.cycles.use_denoising=False
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.70,.81,.83,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.6
for at,power,size in [((-4,10,5),1800,7),((8,7,-6),900,5)]:
    data=bpy.data.lights.new('review-softbox','AREA');data.energy=power;data.shape='DISK';data.size=size
    obj=bpy.data.objects.new('review-softbox',data);bpy.context.collection.objects.link(obj)
    obj.location=p(at);obj.rotation_euler=(p((0,1,0))-obj.location).to_track_quat('-Z','Y').to_euler()
camera_data=bpy.data.cameras.new('review-camera')
camera=bpy.data.objects.new('review-camera',camera_data);bpy.context.collection.objects.link(camera)
target=p((0,1,0));distance=20;pitch=math.radians(55)
camera.location=target+p((distance*math.cos(pitch)/math.sqrt(2),distance*math.sin(pitch),distance*math.cos(pitch)/math.sqrt(2)))
camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler()
camera_data.type='ORTHO';camera_data.ortho_scale=14
scene.camera=camera
scene.render.resolution_x=1400;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
scene.view_settings.look='AgX - Medium High Contrast'
scene.render.image_settings.file_format='PNG'
output=Path(sys.argv[sys.argv.index('--')+1]) if '--' in sys.argv else Path('/tmp/tyaga-art-review.png')
scene.render.filepath=str(output)
bpy.ops.wm.save_as_mainfile(filepath='/tmp/tyaga-art-review.blend')
bpy.ops.render.render(write_still=True)
print('ART_REVIEW_ONLY '+str(output),flush=True)
