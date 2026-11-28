"""Validate delivered asset bytes independently of Blender authoring helpers."""
import hashlib,json,struct,wave,math
from pathlib import Path
import numpy as np
from fontTools.ttLib import TTFont
ROOT=Path(__file__).resolve().parents[1];BASE=ROOT/'public/assets/forpost'
models=json.loads((ROOT/'art/models-manifest.json').read_text());audio=json.loads((ROOT/'art/audio-manifest.json').read_text());fonts=json.loads((ROOT/'art/fonts-manifest.json').read_text())
negative=[];checks=0
for item in models['assets']:
 p=BASE/item['path'];b=p.read_bytes();assert hashlib.sha256(b).hexdigest()==item['sha256'];magic,version,total=struct.unpack_from('<4sII',b);assert magic==b'glTF' and version==2 and total==len(b)
 size,kind=struct.unpack_from('<II',b,12);assert kind==0x4e4f534a;j=json.loads(b[20:20+size]);off=20+size;blen,btype=struct.unpack_from('<II',b,off);assert btype==0x004e4942;binary=b[off+8:off+8+blen]
 assert not j.get('textures') and not any('uri' in x for x in j.get('buffers',[]))
 def read(index):
  a=j['accessors'][index];v=j['bufferViews'][a['bufferView']];components={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']];dtype={5126:'<f4',5125:'<u4',5123:'<u2'}[a['componentType']]
  return np.frombuffer(binary,dtype=dtype,count=a['count']*components,offset=v.get('byteOffset',0)+a.get('byteOffset',0)).reshape(a['count'],components)
 for mesh in j['meshes']:
  for prim in mesh['primitives']:
   vertices=read(prim['attributes']['POSITION']).astype(float);indices=read(prim['indices']).ravel().reshape(-1,3);assert np.isfinite(vertices).all();assert indices.max()<len(vertices)
   tri=vertices[indices];signed_volume=float(np.sum(np.einsum('ij,ij->i',tri[:,0],np.cross(tri[:,1],tri[:,2])))/6)
   if signed_volume < -1e-8:negative.append((p.name,mesh['name'],signed_volume))
   normals=read(prim['attributes']['NORMAL']);assert np.isfinite(normals).all();assert np.max(np.abs(np.linalg.norm(normals,axis=1)-1))<.01
   checks+=1
 assert all(isinstance(n.get('name',''),str) for n in j['nodes'])
 names=[n.get('name','') for n in j['nodes']]
 assert names.count('asset_'+item['assetId'])==1
 if item['assetId'] in ['turret','battery','drone']:assert names.count('turret')==1
 if item['assetId'].startswith('fighter-') or item['assetId'] in ['turret','battery','drone']:assert 'socket_muzzle' in names
 if item['assetId']=='builder':assert 'arm' in names and 'socket_tool' in names
assert not negative,negative
for a in audio:
 p=BASE/a['path'];assert hashlib.sha256(p.read_bytes()).hexdigest()==a['sha256']
 with wave.open(str(p),'rb') as w:
  assert w.getnchannels()==1 and w.getsampwidth()==2 and w.getframerate()==44100;data=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2');assert len(data)==round(a['duration']*44100);assert np.max(np.abs(data.astype(int)))<32767;assert np.any(data)
for f in fonts:
 p=BASE/f['path'];assert hashlib.sha256(p.read_bytes()).hexdigest()==f['sha256'];font=TTFont(p);cmap=font.getBestCmap();assert all(ord(c) in cmap for c in 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюяABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
scene={'fighter-carbine':6,'builder':6,'drone':12,'transport':2,'turret':12,'generator':6,'battery':6,'dock':6}
estimates={}
for quality in ['standard','low']:
 byid={m['assetId']:m for m in models['assets'] if m['quality']==quality}
 estimates[quality]={'triangles':sum(byid[k]['triangles']*n for k,n in scene.items()),'meshDrawCallsWithoutShadows':sum(byid[k]['meshNodes']*n for k,n in scene.items()),'entities':sum(scene.values()),'composition':scene}
report={'models':len(models['assets']),'meshPrimitivesChecked':checks,'negativeClosedMeshVolumes':len(negative),'audio':len(audio),'fonts':len(fonts),'modelBytes':sum(x['bytes'] for x in models['assets']),'audioBytes':sum(x['bytes'] for x in audio),'fontBytes':sum(x['bytes'] for x in fonts),'maxStandardTris':max(x['triangles'] for x in models['assets'] if x['quality']=='standard'),'sceneEstimates':estimates,'measurementsNote':'Static geometry/accounting estimates. They exclude terrain, shadows, effects, UI and renderer batching, and are not measured FPS.'}
(ROOT/'art/validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
