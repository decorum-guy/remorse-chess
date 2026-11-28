"""Reproducible original FORPOST assets. Run: blender -b -t 2 --python games/forpost/scripts/generate-assets.py
Mesh design authored for Iva Games. No external model geometry is incorporated.
Coordinates supplied to helpers are metres X,Y,Z (Y up); Blender export converts to glTF Y up.
"""
import bpy, math, json, hashlib, sys
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public/assets/forpost/models'; OUT.mkdir(parents=True,exist_ok=True)
QA=ROOT.parents[1]/'.qa/forpost-art';QA.mkdir(parents=True,exist_ok=True)
TAU=math.tau
MAT={}
ASSETS=[]
LOW=False
CURRENT=None

def loc(p): return (p[0],-p[2],p[1])
def mat(name,color,metal=.0,rough=.65,emission=0):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 b=m.node_tree.nodes.get('Principled BSDF');b.inputs['Base Color'].default_value=(*color,1);b.inputs['Metallic'].default_value=metal;b.inputs['Roughness'].default_value=rough
 if emission:b.inputs['Emission Color'].default_value=(*color,1);b.inputs['Emission Strength'].default_value=emission
 MAT[name]=m;return m

def hexrgb(s):return tuple(int(s[i:i+2],16)/255 for i in (0,2,4))

def materials():
 for n,c,m,r,e in [('FP_Armour','29404A',.5,.62,0),('FP_Steel','748B91',.72,.42,0),('FP_Dark','101C24',.36,.75,0),('FP_Concrete','9BAAA8',.03,.92,0),('FP_Team','47C9E5',.3,.51,0),('FP_Signal','47C9E5',.15,.3,1.5),('FP_Ivory','DFE1CF',.1,.68,0),('FP_Hazard','D6A649',.25,.55,0),('FP_Rubber','121A1C',.0,.95,0),('FP_Damage','693D34',.35,.88,0),('FP_Glass','254D60',.4,.19,0),('FP_Sand','D5BA83',0,.97,0),('FP_Water','205660',.3,.26,0),('FP_Red','F06B66',.05,.7,0)]:mat(n,hexrgb(c),m,r,e)

def group(name,p=(0,0,0),parent=None):
 o=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(o);o.location=loc(p);o.parent=parent or CURRENT;return o

def finish(o,name,material,parent=None,bevel=0,smooth=False):
 o.name=name;o.data.materials.append(MAT[material]);o.parent=parent or CURRENT
 if bevel and not LOW:
  mod=o.modifiers.new('Machined edge','BEVEL');mod.width=bevel;mod.segments=1
  bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
  no=o.modifiers.new('Weighted face normals','WEIGHTED_NORMAL');no.keep_sharp=True;bpy.ops.object.modifier_apply(modifier=no.name)
 for f in o.data.polygons:f.use_smooth=smooth
 return o

def cube(name,p,size,material='FP_Armour',bevel=.035,parent=None,angle=0):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc(p));o=bpy.context.object;o.dimensions=(size[0],size[2],size[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 o.rotation_euler[2]=-angle
 return finish(o,name,material,parent,bevel)

def cyl(name,p,r,h,material='FP_Steel',axis='y',vertices=12,parent=None,bevel=.0):
 bpy.ops.mesh.primitive_cylinder_add(vertices=8 if LOW else vertices,radius=r,depth=h,location=loc(p));o=bpy.context.object
 if axis=='x':o.rotation_euler[1]=math.pi/2
 if axis=='z':o.rotation_euler[0]=math.pi/2
 return finish(o,name,material,parent,bevel)

def beam(name,a,b,w,material='FP_Steel',parent=None):
 av=Vector(loc(a));bv=Vector(loc(b));mid=(av+bv)*.5
 bpy.ops.mesh.primitive_cube_add(size=1,location=mid);o=bpy.context.object;o.dimensions=(w,w,(bv-av).length);o.rotation_euler=(bv-av).to_track_quat('Z','Y').to_euler();bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 return finish(o,name,material,parent,.015)

def ring(name,p,r,t,material='FP_Steel',axis='y',parent=None):
 bpy.ops.mesh.primitive_torus_add(major_segments=12 if LOW else 20,minor_segments=4,location=loc(p),major_radius=r,minor_radius=t);o=bpy.context.object
 if axis=='x':o.rotation_euler[1]=math.pi/2
 if axis=='z':o.rotation_euler[0]=math.pi/2
 return finish(o,name,material,parent)

def prism(name,p,w,h,d,material='FP_Armour',cut=.18,parent=None):
 # A machined eight-sided footprint; single watertight mesh with deliberate chamfers.
 q=[(-w/2+cut,-d/2),(w/2-cut,-d/2),(w/2,-d/2+cut),(w/2,d/2-cut),(w/2-cut,d/2),(-w/2+cut,d/2),(-w/2,d/2-cut),(-w/2,-d/2+cut)]
 vv=[loc((x+p[0],y+p[1],z+p[2])) for y in [-h/2,h/2] for x,z in q]
 ff=[tuple(range(8)),tuple(reversed(range(8,16)))]+[(i,i+8,(i+1)%8+8,(i+1)%8) for i in range(8)]
 me=bpy.data.meshes.new(name);me.from_pydata(vv,[],ff);me.update();o=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(o);return finish(o,name,material,parent,.012)

def plate_shape(name,p,r,sides,material='FP_Team',parent=None):
 bpy.ops.mesh.primitive_cylinder_add(vertices=sides,radius=r,depth=.012,location=loc(p));return finish(bpy.context.object,name,material,parent)

def bolts(p,w,d,y):
 if LOW:return
 for x in [-w/2+.12,w/2-.12]:
  for z in [-d/2+.12,d/2-.12]:cyl('detail_bolt',(p[0]+x,y,p[2]+z),.028,.025,'FP_Steel',vertices=6)

def markings(w=1.5,d=1.5,y=.18):
 for x in [-1,1]:
  cube('team_corner',(x*(w/2-.1),y,0),(.09,.025,d*.65),'FP_Team',.0)
 a=group('Team_A_Insignia');plate_shape('Triangle',(0,y+.018,d/2-.22),.13,3,parent=a)
 b=group('Team_B_Insignia');plate_shape('Hexagon',(0,y+.02,d/2-.22),.13,6,parent=b);b.hide_render=True
 b['initiallyHidden']=True

def foundation():
 prism('foundation',(0,.07,0),1.8,.14,1.8,'FP_Concrete',.15)
 prism('mount',(0,.17,0),1.5,.12,1.5,'FP_Dark',.18)
 markings(1.5,1.5,.24);bolts((0,0,0),1.5,1.5,.24)

def vent(p,w=.36,d=.26,axis='z'):
 if LOW:return
 for i in range(5):
  if axis=='z':cube('detail_vent',(p[0]-w/2+i*w/4,p[1],p[2]),(.025,.018,d),'FP_Dark',0)
  else:cube('detail_vent',(p[0],p[1]-w/2+i*w/4,p[2]),(d,.018,.025),'FP_Dark',0)

def wheel(p,r=.1,width=.09,parent=None,name='wheel'):
 g=group(name,p,parent);cyl('tire',(0,0,0),r,width,'FP_Rubber','x',12,g);cyl('hub',(width*.53,0,0),r*.54,.018,'FP_Steel','x',8,g)
 if not LOW:cyl('hub_pin',(width*.65,0,0),r*.2,.02,'FP_Dark','x',6,g)
 return g

def socket(name,p,parent=None):
 o=group('socket_'+name,p,parent);o['socket']=name;return o

def fighter(weapon='carbine'):
 # A short armoured operator with segmented boots, gloves, visor and functional long gun.
 for s in [-1,1]:
  leg=group('leg_left' if s<0 else 'leg_right',(s*.145,.52,0))
  cube('boot',(0,-.42,-.065),(.23,.19,.34),'FP_Dark',.035,leg)
  cube('shin',(0,-.245,0),(.145,.28,.15),'FP_Armour',.025,leg)
  cube('knee',(0,-.10,-.075),(.17,.17,.07),'FP_Team',.02,leg)
  cube('thigh',(0,.015,0),(.16,.22,.17),'FP_Ivory',.025,leg)
 cube('hips',(0,.59,0),(.38,.19,.26),'FP_Dark',.045)
 prism('vest',(0,.88,0),.43,.43,.31,'FP_Armour',.07)
 cube('chest_plate',(0,.96,-.16),(.32,.25,.065),'FP_Team',.025)
 cube('chest_light',(0,1.045,-.199),(.18,.028,.015),'FP_Signal',0)
 cube('belt',(0,.67,-.01),(.4,.07,.29),'FP_Dark',.01)
 for s in [-1,1]:
  cube('shoulder',(s*.285,1.005,0),(.17,.19,.24),'FP_Team',.035)
  beam('forearm',(s*.30,.87,-.02),(s*.19,.78,-.25),.12,'FP_Ivory')
  cube('glove',(s*.16,.79,-.27),(.13,.1,.14),'FP_Dark',.02)
 prism('helmet',(0,1.23,-.015),.36,.3,.32,'FP_Ivory',.07)
 cube('visor',(0,1.26,-.182),(.29,.085,.035),'FP_Glass',.012)
 cube('helmet_brow',(0,1.32,-.16),(.33,.04,.07),'FP_Armour',.01)
 cube('helmet_band',(0,1.395,0),(.09,.02,.2),'FP_Team',0)
 cube('pack',(0,.91,.21),(.27,.32,.15),'FP_Dark',.02)
 cyl('antenna',(.14,1.2,.23),.012,.38,'FP_Steel',vertices=6)
 gun=group('weapon',(0,.81,-.28));weapon_mesh(weapon,gun)
 socket('muzzle',(0,.04,-({'carbine':.62,'shotgun':.55,'rifle':.9}[weapon])),gun)
 socket('nameplate',(0,1.62,0));socket('ground',(0,.01,0))
 a=group('Team_A_Insignia');plate_shape('Triangle',(0,.028,.05),.31,3,parent=a)
 b=group('Team_B_Insignia');plate_shape('Hexagon',(0,.026,.05),.31,6,parent=b);b['initiallyHidden']=True;b.hide_render=True

def weapon_mesh(kind,parent=None):
 lengths={'carbine':.52,'shotgun':.43,'rifle':.78};le=lengths[kind]
 cube('receiver',(0,.015,-.12),(.16,.14,.34),'FP_Armour',.024,parent)
 cube('grip',(0,-.10,0),(.08,.18,.09),'FP_Dark',.015,parent)
 cube('stock',(0,.015,.16),(.11,.11,.24),'FP_Steel',.018,parent)
 cube('barrel_shroud',(0,.04,-le*.7),(.12 if kind!='shotgun' else .2,.11,le*.58),'FP_Dark',.015,parent)
 cyl('barrel',(0,.04,-le),.028 if kind!='shotgun' else .055,.21,'FP_Steel','z',8,parent)
 cyl('bore',(0,.04,-le-.11),.017 if kind!='shotgun' else .038,.012,'FP_Dark','z',8,parent)
 cube('accent',(0,.095,-.1),(.1,.016,.22),'FP_Team',0,parent)
 if kind=='rifle':
  cyl('optic',(0,.145,-.10),.047,.24,'FP_Armour','z',12,parent);cyl('optic_glass',(0,.145,-.225),.033,.012,'FP_Signal','z',12,parent)
 elif kind=='shotgun':cube('pump',(0,-.025,-.28),(.18,.08,.22),'FP_Hazard',.018,parent)
 else:cube('magazine',(0,-.10,-.11),(.08,.2,.1),'FP_Steel',.012,parent)

def builder():
 prism('chassis',(0,.24,0),.49,.22,.5,'FP_Team',.065)
 cube('undercarriage',(0,.14,0),(.4,.1,.41),'FP_Dark',.025)
 for s in [-1,1]:
  for z in [-.16,.16]:wheel((s*.255,.105,z),.105,.075,name='wheel_'+str(s)+'_'+str(z))
 cube('battery',(0,.42,.12),(.28,.15,.18),'FP_Dark',.02)
 cube('battery_signal',(0,.5,.12),(.19,.02,.08),'FP_Signal',0)
 arm=group('arm',(0,.38,-.09));cyl('arm_base',(0,0,0),.11,.1,'FP_Steel',vertices=10,parent=arm)
 beam('boom',(0,.02,0),(0,.35,-.18),.1,'FP_Hazard',arm);cyl('joint',(0,.35,-.18),.08,.17,'FP_Dark','x',10,arm)
 beam('forearm',(0,.35,-.18),(0,.2,-.39),.075,'FP_Steel',arm)
 for x in [-.07,.07]:beam('claw',(x,.20,-.39),(x*.6,.10,-.43),.035,'FP_Dark',arm)
 socket('tool',(0,.12,-.43),arm);socket('nameplate',(0,.95,0))

def drone():
 prism('chassis',(0,.24,0),.52,.23,.52,'FP_Armour',.07)
 for s in [-1,1]:
  for z in [-.17,.17]:wheel((s*.255,.11,z),.11,.09,name='wheel_'+str(s)+'_'+str(z))
 cube('front_plate',(0,.23,-.275),(.39,.13,.04),'FP_Team',.014)
 cyl('turret_ring',(0,.40,0),.18,.1,'FP_Steel',vertices=12)
 g=group('turret',(0,.46,0));prism('head',(0,.035,0),.30,.19,.27,'FP_Team',.05,g)
 cube('barrel',(0,.03,-.25),(.075,.075,.28),'FP_Dark',.01,g)
 cyl('muzzle',(0,.03,-.4),.036,.05,'FP_Steel','z',8,g)
 cube('optic',(.09,.11,-.1),(.06,.04,.05),'FP_Signal',.004,g)
 socket('muzzle',(0,.03,-.435),g);socket('nameplate',(0,.9,0))

def transport():
 prism('chassis',(0,.46,0),1.44,.28,2.72,'FP_Dark',.22)
 for s in [-1,1]:
  for i,z in enumerate([-.9,0,.9]):wheel((s*.69,.29,z),.29,.16,name='wheel_'+str(s)+'_'+str(i))
 prism('cab',(0,.92,-.82),1.25,.62,.83,'FP_Team',.18)
 cube('windscreen',(0,1.09,-1.23),(.85,.22,.04),'FP_Glass',.035)
 cube('cab_roof',(0,1.27,-.82),(1.18,.1,.69),'FP_Armour',.05)
 for s in [-1,1]:
  cube('headlight',(s*.48,.78,-1.34),(.16,.08,.045),'FP_Ivory',.012)
  cube('side_rail',(s*.6,.77,.46),(.1,.45,1.55),'FP_Armour',.03)
  cube('side_signal',(s*.66,.88,.46),(.035,.07,1.13),'FP_Signal',.005)
 crate=group('energy_container',(0,.83,.38));prism('core',(0,.12,0),.98,.56,1.37,'FP_Steel',.12,crate)
 for z in [-.45,0,.45]:
  cube('core_cell',(0,.16,z),(.74,.38,.22),'FP_Signal',.035,crate)
  cube('cage_rib',(0,.43,z),(.98,.06,.08),'FP_Dark',.01,crate)
 cube('cargo_lock',(0,.59,1.31),(1.18,.21,.1),'FP_Hazard',.025)
 for x in [-.36,0,.36]:cube('detail_lock_slash',(x,.6,1.37),(.10,.14,.015),'FP_Dark',0,angle=-.6)
 socket('nameplate',(0,1.85,0));socket('unload',(0,1.6,.38));socket('engine',(0,.5,-.75))

def relay():
 foundation();prism('foot',(0,.45,0),.65,.4,.65,'FP_Armour',.12)
 cyl('mast',(0,1.15,0),.10,1.2,'FP_Steel',vertices=8)
 for s in [-1,1]:beam('brace',(s*.55,.25,.4),(0,1.4,0),.055,'FP_Dark')
 ring('aerial_ring',(0,1.86,0),.4,.045,'FP_Team',axis='z')
 cyl('aerial_hub',(0,1.86,0),.105,.16,'FP_Dark','z',12)
 cube('signal',(0,2.13,0),(.1,.14,.09),'FP_Signal',.018)
 for y in [.65,.8,.95]:cube('detail_mast_band',(0,y,-.11),(.16,.035,.03),'FP_Hazard',0)
 socket('nameplate',(0,2.4,0));socket('network',(0,1.86,0))

def generator():
 foundation();cube('housing',(0,.52,0),(1.12,.56,1.08),'FP_Armour',.07)
 for s in [-1,1]:
  rot=group('rotor_'+str(s),(s*.35,.9,0));cyl('rotor_body',(0,0,0),.26,.65,'FP_Steel','z',12,rot)
  ring('coil',(0,0,-.33),.2,.035,'FP_Team','z',rot)
  for a in range(6):
   t=a*TAU/6;beam('rotor_blade',(0,0,-.35),(math.cos(t)*.18,math.sin(t)*.18,-.35),.055,'FP_Dark',rot)
  cube('rotor_terminal',(0,.0,.37),(.16,.2,.1),'FP_Signal',.012,rot)
 cube('panel',(0,.65,.57),(.4,.26,.035),'FP_Ivory',.018);cube('readout',(0,.69,.596),(.21,.075,.015),'FP_Signal',0)
 socket('nameplate',(0,1.5,0))

def extractor():
 foundation();cube('pump_block',(0,.53,0),(.9,.55,.84),'FP_Armour',.07)
 cyl('well',(0,.4,0),.34,.3,'FP_Steel',vertices=12)
 for x in [-.46,.46]:beam('gantry',(x,.3,.2),(x,1.5,.05),.10,'FP_Hazard')
 beam('crossbeam',(-.53,1.5,.05),(.53,1.5,.05),.12,'FP_Armour')
 piston=group('piston',(0,1.1,0));cyl('shaft',(0,0,0),.055,.9,'FP_Steel',vertices=10,parent=piston);cube('crosshead',(0,.2,0),(.75,.13,.21),'FP_Team',.025,piston)
 for s in [-1,1]:cube('side_tank',(s*.62,.65,0),(.25,.72,.46),'FP_Steel',.035)
 cube('lamp',(0,.71,.45),(.25,.08,.025),'FP_Signal',.01);vent((0,.82,.23),.36,.3)
 socket('nameplate',(0,1.95,0))

def turret():
 foundation();prism('pedestal',(0,.58,0),.75,.7,.75,'FP_Armour',.13);cyl('bearing',(0,.98,0),.41,.14,'FP_Steel',vertices=16)
 head=group('turret',(0,1.12,0));prism('turret_armour',(0,.1,.06),.85,.40,.72,'FP_Team',.12,head)
 cube('barrel_cover',(0,.12,-.46),(.26,.21,.65),'FP_Armour',.03,head)
 cyl('barrel',(0,.12,-.86),.075,.3,'FP_Steel','z',10,head);cyl('bore',(0,.12,-1.02),.047,.015,'FP_Dark','z',10,head)
 cube('sensor',(.27,.32,-.24),(.16,.1,.07),'FP_Signal',.014,head)
 socket('muzzle',(0,.12,-1.04),head);socket('nameplate',(0,1.85,0))

def dock():
 foundation()
 for x in [-.5,.5]:
  cube('bay',(x,.26,0),(.73,.06,1.1),'FP_Steel',.02)
  for z in [-.46,.46]:cube('charging_contact',(x,.35,z),(.46,.1,.09),'FP_Hazard',.015)
  cube('bay_signal',(x,.31,0),(.09,.025,.5),'FP_Signal',0)
 for x in [-.72,.72]:cube('upright',(x,.76,.45),(.16,1.12,.18),'FP_Armour',.035)
 cube('gantry',(0,1.32,.45),(1.55,.19,.32),'FP_Team',.045)
 cube('gantry_lamp',(0,1.29,.265),(1.1,.06,.02),'FP_Signal',0)
 cube('cabinet',(0,.7,.65),(.48,.85,.24),'FP_Armour',.035)
 socket('spawn_left',(-.5,.1,-1.3));socket('spawn_right',(.5,.1,-1.3));socket('nameplate',(0,1.8,0))

def battery():
 foundation();prism('pedestal',(0,.52,0),.9,.55,.84,'FP_Dark',.12);cyl('bearing',(0,.86,0),.42,.12,'FP_Steel',vertices=16)
 g=group('turret',(0,1.0,0));prism('breech',(0,.1,.3),.72,.42,.63,'FP_Armour',.12,g)
 for x in [-.25,.25]:
  cube('rail',(x,.1,-.48),(.16,.17,1.3),'FP_Steel',.03,g)
  cube('light_guide',(x,.2,-.48),(.08,.04,1.2),'FP_Signal',.007,g)
 cube('muzzle_bridge',(0,.1,-1.12),(.71,.27,.16),'FP_Armour',.02,g)
 cube('bore',(0,.1,-1.21),(.22,.08,.015),'FP_Dark',0,g)
 for z in [-.8,-.45,-.1]:cube('coil',(0,.035,z),(.53,.08,.08),'FP_Team',.008,g)
 socket('muzzle',(0,.1,-1.24),g);socket('nameplate',(0,1.8,0))

def respawn():
 foundation()
 for x in [-.65,.65]:
  for z in [-.5,.5]:beam('strut',(x,.25,z),(x*.85,1.55,z),.11,'FP_Steel')
 # Open roof frame makes the exit and occupants visible from the game camera.
 for x in [-.62,.62]:cube('canopy',(x,1.59,0),(.22,.15,1.48),'FP_Team',.035)
 for z in [-.65,.65]:cube('canopy_cross',(0,1.59,z),(1.4,.15,.2),'FP_Armour',.03)
 cube('floor_emitter',(0,.255,0),(.72,.035,.72),'FP_Dark',.025)
 for x in [-.28,.28]:cube('floor_strip',(x,.28,0),(.055,.015,.58),'FP_Signal',0)
 cube('rear_console',(0,.75,.63),(.55,.8,.22),'FP_Armour',.04);cube('console',(0,.98,.5),(.36,.23,.025),'FP_Signal',.01)
 socket('exit',(0,.02,-1.5));socket('nameplate',(0,2,0))

def bridge():
 for x in [-1.8,1.8]:cube('bank_support',(x,-.08,0),(.4,.35,4),'FP_Concrete',.06)
 cube('deck',(0,.03,0),(4,.12,4),'FP_Armour',.035)
 for x in [-1.7,-1.2,-.7,-.2,.3,.8,1.3,1.8]:
  cube('deck_rib',(x,.105,0),(.06,.018,3.84),'FP_Steel',0)
 for z in [-1.91,1.91]:
  cube('edge_stripe',(0,.12,z),(3.8,.025,.09),'FP_Hazard',0)
  for x in [-1.7,-.6,.6,1.7]:cube('rail_post',(x,.28,z),(.09,.36,.09),'FP_Steel',.012)
  beam('rail',(-1.85,.46,z),(1.85,.46,z),.055,'FP_Armour')
 socket('nameplate',(0,.8,0))

def wall(destructible=False):
 cube('foot',(0,.08,0),(1,.16,1),'FP_Concrete',.025)
 prism('wall',(0,.62,0),.91,1.12,.9,'FP_Armour' if not destructible else 'FP_Damage',.08)
 cube('cap',(0,1.16,0),(.97,.08,.96),'FP_Steel',.025)
 for x in [-.32,.32]:cube('rib',(x,.61,-.46),(.07,.96,.035),'FP_Steel',.01)
 if destructible:
  for a,b in [((-.18,1.14,-.484),(.08,.75,-.484)),((.08,.75,-.484),(-.11,.52,-.484)),((-.11,.52,-.484),(.14,.12,-.484))]:beam('fracture',a,b,.035,'FP_Dark')
 else:cube('caution',(0,.87,-.49),(.27,.13,.02),'FP_Hazard',.005)

def station():
 cyl('floor',(0,.015,0),2.5,.03,'FP_Armour',vertices=32)
 ring('perimeter',(0,.05,0),2.36,.045,'FP_Steel')
 for i in range(8):
  a=i*TAU/8;x=2.25*math.sin(a);z=2.25*math.cos(a);cube('signal_segment',(x,.07,z),(.22,.025,.12),'FP_Signal',.008,angle=a)
 cyl('capture_ring',(0,.045,0),.78,.035,'FP_Dark',vertices=20)
 plate_shape('center_mark',(0,.08,0),.36,6,'FP_Ivory')
 socket('nameplate',(0,.2,0));socket('capture',(0,.1,0))

def complex_model():
 cyl('pad',(0,.015,0),3,.03,'FP_Concrete',vertices=32)
 ring('landing_circle',(0,.055,0),2.86,.045,'FP_Hazard')
 for x in [-2.5,2.5]:
  for z in [-1.4,1.4]:
   # These short guides are decorative, below the transport's visual bed.
   cube('floor_beacon',(x,.10,z),(.16,.14,.34),'FP_Armour',.025);cube('beacon_light',(x,.185,z),(.10,.025,.27),'FP_Signal',.005)
 for z in [-2.0,-1,0,1,2]:cube('floor_guide',(0,.055,z),(1.3,.016,.08),'FP_Ivory',0)
 socket('unload',(0,.1,0))

def ground(kind):
 m={'concrete':'FP_Concrete','sand':'FP_Sand','industrial':'FP_Armour','water':'FP_Water'}[kind]
 cube('surface',(0,-.035,0),(4,.06,4),m,.015)
 if kind!='water':
  for z in [-1.97,1.97]:cube('seam',(0,-.001,z),(3.95,.008,.025),'FP_Dark',0)
  for x in [-1.97,1.97]:cube('seam',(x,-.001,0),(.025,.008,3.95),'FP_Dark',0)
  if kind=='industrial':
   for x in [-1.65,1.65]:cube('service_line',(x,.008,0),(.045,.014,3.7),'FP_Hazard',0)
  if kind=='sand' and not LOW:
   for x,z in [(-1.2,.6),(.8,-1.1),(.3,1.5),(-.4,-.6)]:prism('stone',(x,.03,z),.18,.065,.14,'FP_Concrete',.025)
 else:
  for x,z in [(-.8,.5),(.7,-.6)]:cube('ripple',(x,.002,z),(.7,.008,.018),'FP_Steel',0)

def target():
 cube('foot',(0,.05,0),(.6,.1,.5),'FP_Dark',.04);beam('post',(0,.1,0),(0,1.1,0),.08,'FP_Steel')
 cube('target_board',(0,1.05,0),(.66,.8,.09),'FP_Ivory',.06)
 ring('bullseye',(0,1.08,-.06),.2,.025,'FP_Red','z');cube('cross_x',(0,1.08,-.071),(.25,.02,.01),'FP_Dark',0);cube('cross_y',(0,1.08,-.071),(.02,.25,.01),'FP_Dark',0)

def depot():
 # Decorative open service bay; authoritative depot itself is a point.
 for x in [-1.4,1.4]:cube('post',(x,1.15,.4),(.22,2.3,.25),'FP_Armour',.05)
 cube('top',(0,2.28,.4),(3,.25,.5),'FP_Steel',.05);cube('sign',(0,2.13,.1),(1.8,.3,.04),'FP_Team',.025)
 for x in [-1.2,1.2]:cube('bumper',(x,.25,-.2),(.25,.5,.6),'FP_Hazard',.035)
 cube('bay_floor',(0,.01,0),(2.8,.02,3),'FP_Dark',0)
 for z in [-1.3,0,1.3]:cube('floor_mark',(0,.03,z),(1.6,.015,.06),'FP_Ivory',0)

def crane():
 for x in [-1.5,1.5]:
  for z in [-1,1]:beam('leg',(x,0,z),(x*.7,5,z*.7),.22,'FP_Armour')
 beam('gantry',(-2,5,0),(2,5,0),.4,'FP_Hazard')
 for z in [-.7,.7]:beam('bracing',(-1.3,3,z),(1.3,4.8,z),.1,'FP_Steel')
 beam('cable',(0,4.9,0),(0,2.8,0),.035,'FP_Dark');ring('hook',(0,2.65,0),.16,.035,'FP_Steel','z')

def consolidate():
 if LOW:
  # Freeze ornamental wheel/fan spin at low quality, keeping their detailed silhouettes.
  # Turret, weapon, builder arm and pump remain separate moving assemblies.
  bpy.context.view_layer.update()
  for ob in list(bpy.context.scene.objects):
   if ob.type=='MESH' and ob.parent and ob.parent.name.startswith(('wheel_','rotor_')):
    matrix=ob.matrix_world.copy();ob.parent=CURRENT;ob.matrix_world=matrix
  for ob in list(bpy.context.scene.objects):
   if ob.type=='EMPTY' and ob.name.startswith(('wheel_','rotor_')) and not ob.children:bpy.data.objects.remove(ob,do_unlink=True)
  if 'FP_Baked' not in MAT:
   m=mat('FP_Baked',(1,1,1),.3,.72);nodes=m.node_tree.nodes;vc=nodes.new('ShaderNodeVertexColor');vc.layer_name='Col';m.node_tree.links.new(vc.outputs['Color'],nodes.get('Principled BSDF').inputs['Base Color'])
  for ob in list(bpy.context.scene.objects):
   if ob.type!='MESH' or ob.data.materials[0].name in ['FP_Team','FP_Signal']:continue
   color=tuple(ob.data.materials[0].diffuse_color);attr=ob.data.color_attributes.new(name='Col',type='FLOAT_COLOR',domain='CORNER')
   for c in attr.data:c.color=color
   ob.data.color_attributes.active_color=attr;ob.data.materials.clear();ob.data.materials.append(MAT['FP_Baked'])
 # Merge only immutable pieces by material and parent, keeping named moving assemblies and sockets.
 groups={}
 for ob in list(bpy.context.scene.objects):
  if ob.type!='MESH':continue
  key=(ob.parent.name if ob.parent else '',ob.data.materials[0].name)
  groups.setdefault(key,[]).append(ob)
 for (par,m),obs in groups.items():
  if len(obs)<2:continue
  bpy.ops.object.select_all(action='DESELECT')
  for ob in obs:ob.select_set(True)
  bpy.context.view_layer.objects.active=obs[0];bpy.ops.object.join();obs[0].name=par+'__'+m

def make_one(name,fn,meta):
 global CURRENT
 bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
 CURRENT=None
 CURRENT=group('asset_'+name,parent=None);CURRENT.parent=None;CURRENT['assetId']=name;CURRENT['authoredFor']='Iva Games / Forpost';CURRENT['coordinateUnits']='metres';CURRENT['forward']='-Z';CURRENT['collision']=json.dumps(meta['collider'])
 fn();consolidate()
 bpy.ops.object.select_all(action='SELECT')
 suffix='-low' if LOW else ''
 path=OUT/(name+suffix+'.glb')
 bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_extras=True,export_animations=False,export_cameras=False,export_lights=False,export_materials='EXPORT')
 tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
 nodes=len(bpy.context.scene.objects)
 meshgroups=sum(1 for o in bpy.context.scene.objects if o.type=='MESH')
 b=path.read_bytes()
 data={'assetId':name,'quality':'low' if LOW else 'standard','path':'models/'+path.name,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'triangles':tris,'meshNodes':meshgroups,'nodes':nodes,**meta}
 return data

def setup_render():
 scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=False;scene.render.resolution_x=1500;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
 scene.world.color=(.20,.25,.28)
 scene.view_settings.view_transform='AgX'
 for name,p,energy,size in [('Key',(2,12,4),1800,9),('Fill',(-8,6,2),700,8),('Rim',(0,8,-8),1200,6)]:
  d=bpy.data.lights.new(name,'AREA');d.energy=energy;d.shape='DISK';d.size=size;o=bpy.data.objects.new(name,d);bpy.context.collection.objects.link(o);o.location=loc(p);o.rotation_euler=(Vector((0,0,0))-o.location).to_track_quat('-Z','Y').to_euler()
 d=bpy.data.cameras.new('ArtCamera');d.type='ORTHO';d.ortho_scale=13.5;o=bpy.data.objects.new('ArtCamera',d);bpy.context.collection.objects.link(o);o.location=loc((7,10,12));o.rotation_euler=(Vector(loc((0,.3,0)))-o.location).to_track_quat('-Z','Y').to_euler();scene.camera=o
 scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False

def preview():
 global CURRENT,LOW
 LOW=False;bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);CURRENT=None
 cube('Stage',(0,-.15,0),(16,.25,12),'FP_Dark',.06)
 things=[('transport',transport,(-3,0,-2)),('relay',relay,(0,0,-2)),('battery',battery,(2.8,0,-2)),('generator',generator,(-3,0,.6)),('extractor',extractor,(0,0,.6)),('dock',dock,(2.8,0,.6)),('respawn',respawn,(-3,0,3.3)),('turret',turret,(0,0,3.3)),('fighters',lambda:fighter('rifle'),(2.2,0,3.6)),('drone',drone,(3.2,0,3.5)),('builder',builder,(4.2,0,3.5))]
 CURRENT=None
 for n,fn,p in things:
  CURRENT=None
  CURRENT=group(n,p,parent=None);CURRENT.parent=None;fn()
  if n in ['battery','dock','fighters']:
   for ob in CURRENT.children_recursive:
    if ob.type=='MESH':
     for i,m in enumerate(ob.data.materials):
      if m.name in ['FP_Team','FP_Signal']:
       cp=m.copy();cp.name=m.name+'_B';cp.diffuse_color=(*hexrgb('FFB25B'),1);bs=cp.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=cp.diffuse_color
       if m.name=='FP_Signal':bs.inputs['Emission Color'].default_value=cp.diffuse_color
       ob.data.materials[i]=cp
 CURRENT=None;setup_render();bpy.context.scene.render.filepath=str(QA/'contact-sheet.png');bpy.ops.render.render(write_still=True)

materials()
D=lambda radius:{'shape':'circleXZ','radius':radius}
F={'shape':'rectangleXZ','width':1.8,'depth':1.8}
entries=[('fighter-carbine',lambda:fighter('carbine'),{'collider':D(.32),'animations':['walk','fire','reload','death']}),('fighter-shotgun',lambda:fighter('shotgun'),{'collider':D(.32),'animations':['walk','fire','reload','death']}),('fighter-rifle',lambda:fighter('rifle'),{'collider':D(.32),'animations':['walk','fire','reload','death']}),('builder',builder,{'collider':D(.28),'animations':['drive','work','destroy']}),('drone',drone,{'collider':D(.30),'animations':['drive','aim','fire','destroy']}),('transport',transport,{'collider':{'shape':'capsuleXZ','radius':.8,'segmentLength':1.2},'animations':['drive','unload','destroy']}),('relay',relay,{'collider':F,'animations':['powered','destroy']}),('generator',generator,{'collider':F,'animations':['work','powered','destroy']}),('extractor',extractor,{'collider':F,'animations':['work','powered','destroy']}),('turret',turret,{'collider':F,'animations':['aim','fire','powered','destroy']}),('dock',dock,{'collider':F,'animations':['work','powered','destroy']}),('battery',battery,{'collider':F,'animations':['aim','fire','powered','destroy']}),('respawn',respawn,{'collider':F,'animations':['powered','suppressed','destroy']}),('bridge',bridge,{'collider':{'shape':'rectangleXZ','width':4,'depth':4,'walkable':True},'animations':['construct','destroy']}),('foundation',foundation,{'collider':F,'animations':['construct','destroy']}),('wall',wall,{'collider':{'shape':'rectangleXZ','width':1,'depth':1},'animations':[]}),('wall-destructible',lambda:wall(True),{'collider':{'shape':'rectangleXZ','width':1,'depth':1},'animations':['destroy']}),('station',station,{'collider':{'shape':'none','captureRadius':2.5},'animations':['capture']}),('complex',complex_model,{'collider':{'shape':'none','unloadRadius':3},'animations':['unload']}),('ground-concrete',lambda:ground('concrete'),{'collider':{'shape':'none'},'animations':[]}),('ground-sand',lambda:ground('sand'),{'collider':{'shape':'none'},'animations':[]}),('ground-industrial',lambda:ground('industrial'),{'collider':{'shape':'none'},'animations':[]}),('water',lambda:ground('water'),{'collider':{'shape':'mapDefined'},'animations':[]}),('target',target,{'collider':D(.32),'animations':['hit']}),('depot',depot,{'collider':{'shape':'none'},'animations':[]}),('crane',crane,{'collider':{'shape':'none','placement':'outsideMap'},'animations':[]})]
if '--preview-only' not in sys.argv:
 for LOW in [False,True]:
  for name,fn,meta in entries:ASSETS.append(make_one(name,fn,meta))
manifest={'version':1,'generator':'games/forpost/scripts/generate-assets.py','tool':'Blender '+bpy.app.version_string,'units':'metres','up':'Y','forward':'-Z','materials':{'team':'FP_Team','signal':'FP_Signal','armour':'FP_Armour','damage':'FP_Damage'},'animationsSource':'games/forpost/src/art/models.ts','assets':ASSETS}
if ASSETS:(ROOT/'art/models-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if '--no-render' not in sys.argv:preview()
print('FORPOST_ART_COMPLETE',len(ASSETS),sum(x['bytes'] for x in ASSETS))
