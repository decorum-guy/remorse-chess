"""Validate delivered GLB/WAV/font/SVG bytes, transforms and production budgets.

This checks asset integrity and authoring contracts. It does not claim gameplay,
frame-rate, mobile hardware, human preference or auditory acceptance.
"""
from pathlib import Path
import hashlib
import json
import math
import struct
import wave
import xml.etree.ElementTree as ET
import numpy as np
from fontTools.ttLib import TTFont

ROOT=Path(__file__).resolve().parents[2]
ASSETS=ROOT/'public/assets/tyaga'
ISSUES=[]


def check(condition,message):
    if not condition:
        ISSUES.append(message)


def glb(path):
    raw=path.read_bytes()
    magic,version,size=struct.unpack_from('<III',raw,0)
    check(magic==0x46546c67 and version==2 and size==len(raw),f'{path.name}: invalid GLB header')
    length,kind=struct.unpack_from('<II',raw,12)
    check(kind==0x4e4f534a,f'{path.name}: invalid JSON chunk')
    doc=json.loads(raw[20:20+length])
    binary=b''
    at=20+length
    while at<len(raw):
        chunk_len,chunk_kind=struct.unpack_from('<II',raw,at)
        if chunk_kind==0x004e4942:
            binary=raw[at+8:at+8+chunk_len]
        at+=8+chunk_len
    return doc,binary


def accessor(doc,binary,index):
    a=doc['accessors'][index]
    v=doc['bufferViews'][a['bufferView']]
    types={5120:'i1',5121:'u1',5122:'<i2',5123:'<u2',5125:'<u4',5126:'<f4'}
    widths={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
    dtype=np.dtype(types[a['componentType']]);width=widths[a['type']]
    offset=v.get('byteOffset',0)+a.get('byteOffset',0)
    stride=v.get('byteStride',dtype.itemsize*width)
    return np.ndarray((a['count'],width),dtype=dtype,buffer=binary,offset=offset,strides=(stride,dtype.itemsize))


def matrix(node):
    if 'matrix' in node:
        return np.array(node['matrix']).reshape((4,4),order='F')
    x,y,z,w=node.get('rotation',[0,0,0,1])
    r=np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w,0],
        [2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w,0],
        [2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y,0],[0,0,0,1]],dtype=float)
    r[:3,:3]=r[:3,:3]@np.diag(node.get('scale',[1,1,1]))
    r[:3,3]=node.get('translation',[0,0,0])
    return r


def transforms(doc):
    result={}
    def walk(i,parent):
        result[i]=parent@matrix(doc['nodes'][i])
        for child in doc['nodes'][i].get('children',[]):
            walk(child,result[i])
    for root in doc['scenes'][doc.get('scene',0)]['nodes']:
        walk(root,np.eye(4))
    return result


def models():
    manifest=json.loads((ASSETS/'models/manifest.json').read_text())
    expected={'truck','character','generator-large','mast','pump-large','generator','optics','pump','deck','beam','winch','anchor','strap','jack','repair','drive','crate','pontoon','ferry-deck','lift','block','ramp','ring','bridge-mount','barrier'}
    found={a['assetId'] for a in manifest['assets']}
    check(expected<=found,f'Missing runtime models: {sorted(expected-found)}')
    check(len(found)==len(manifest['assets']),'Duplicate model assetId')
    result=[]
    for asset in manifest['assets']:
        name=asset['assetId'];path=ASSETS/'models'/(name+'.glb')
        check(path.exists(),f'{name}: missing GLB')
        if not path.exists(): continue
        check(hashlib.sha256(path.read_bytes()).hexdigest()==asset['sha256'],f'{name}: hash differs')
        doc,binary=glb(path);world=transforms(doc)
        check(all('uri' not in item for item in doc.get('images',[])),f'{name}: external texture')
        check(all('uri' not in item for item in doc.get('buffers',[])),f'{name}: external buffer')
        names={node.get('name') for node in doc['nodes']}
        check(set(asset.get('sockets',{}))<=names,f'{name}: missing named socket')
        parents={child:i for i,node in enumerate(doc['nodes']) for child in node.get('children',[])}
        def interaction_hardware(index):
            while index is not None:
                if doc['nodes'][index].get('extras',{}).get('interactionHardware'):
                    return True
                index=parents.get(index)
            return False
        tri=0;points=[];structure=[];triangles=[];material_points={}
        for i,node in enumerate(doc['nodes']):
            if 'mesh' not in node: continue
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                positions=accessor(doc,binary,primitive['attributes']['POSITION'])
                check(np.isfinite(positions).all(),f'{name}: non-finite vertex')
                check(primitive.get('mode',4)==4,f'{name}: unexpected non-triangle primitive')
                count=doc['accessors'][primitive['indices']]['count'] if 'indices' in primitive else len(positions)
                tri+=count//3
                homogeneous=np.column_stack([positions,np.ones(len(positions))])
                transformed=(world[i]@homogeneous.T).T[:,:3]
                points.append(transformed)
                material_name=doc.get('materials',[])[primitive['material']].get('name','') if 'material' in primitive else ''
                material_points.setdefault(material_name,[]).append(transformed)
                if not interaction_hardware(i):
                    structure.append(transformed)
                indices=accessor(doc,binary,primitive['indices']).ravel() if 'indices' in primitive else np.arange(len(positions))
                triangles.append(transformed[indices].reshape((-1,3,3)))
                if 'WEIGHTS_0' in primitive['attributes']:
                    weights=accessor(doc,binary,primitive['attributes']['WEIGHTS_0'])
                    check(np.max(np.abs(weights.sum(axis=1)-1))<1e-4,f'{name}: skin weight sum')
        check(tri==asset['triangles'],f'{name}: triangle manifest differs ({tri}/{asset["triangles"]})')
        if name=='truck': check(tri<=30000,'truck: exceeds 30k triangles')
        if name=='character':
            check(tri<=8000,'character: exceeds 8k triangles')
            check(len(doc.get('skins',[]))==1,'character: common skeleton missing/duplicated')
            check(len(doc['skins'][0]['joints'])==17,'character: skeleton needs 17 joints')
            check({'head-a','backpack-a','field-worker-skin'}<=names,'character: variant nodes missing')
            required={'idle','walk','run','jump','fall','land','carry','push','hold','crank','repair','driver','stumble'}
            check({a.get('name') for a in doc.get('animations',[])}==required,'character: clips differ')
        if name in {'generator-large','generator','mast','pump-large','pump','optics'}:
            check(tri<=5000,f'{name}: exceeds 5k cargo triangles')
        if name in {'winch','anchor','strap','jack','repair','drive','hook','beam'}:
            check(tri<=2000,f'{name}: exceeds 2k tool triangles')
        if points:
            xyz=np.concatenate(points);low=xyz.min(axis=0);high=xyz.max(axis=0)
            size=high-low;center=(high+low)/2
            if name in {'winch','anchor','strap','jack','repair','drive','ring','crate','hook','beam','deck-folded','generator-large','generator','optics','pump-large','pump','mast'}:
                check(np.max(np.abs(size-np.array(asset['dimensionsXYZ'])))<.001,f'{name}: dimensions differ from physics')
                check(np.max(np.abs(center))<.001,f'{name}: origin is not bounds-centre')
            extra={}
            if name=='deck':
                body=np.concatenate(structure);struct_low=body.min(axis=0);struct_high=body.max(axis=0)
                check(np.max(np.abs(struct_high-struct_low-np.array(asset['dimensionsXYZ'])))<.001,'deck: structural dimensions differ')
                check(np.max(np.abs((struct_high+struct_low)/2))<.001,'deck: structural origin is not centred')
                check(len(asset['collider']['parts'])==7,'deck: expected seven open-slot collider parts')
                expected_parts=[{'center':[0,0,0],'halfExtents':[1.6,.09,1.5]}]+[
                    {'center':[x,0,z],'halfExtents':[.2,.09,hz]}
                    for x in [-1.8,1.8] for z,hz in [(0,1.13),(-1.435,.065),(1.435,.065)]]
                check(asset['collider']['parts']==expected_parts,'deck: collider must retain the confirmed .24m slots')
                check(asset['sockets'].get('socket-handle-0')==[0,.1,-1.5] and asset['sockets'].get('socket-handle-1')==[0,.1,1.5],'deck: canonical handles differ')
                faces=np.concatenate(triangles)
                # Orthogonal rays across the real arc envelope must pass through
                # the authored slot, not merely through an empty bounding box.
                hits=0;samples=0
                direction=np.array([0.,-1.,0.])
                for sx in [-1,1]:
                    for sz in [-1,1]:
                        check(asset['sockets'].get(f'socket-ring-{sx}-{sz}')==[sx*1.8,.09,sz*1.25],'deck: canonical mount socket differs')
                        for x in np.linspace(1.62,1.98,7)*sx:
                            for z in [sz*1.25+offset for offset in [-.105,-.08,-.04,0,.04,.08,.105]]:
                                origin=np.array([x,.5,z]);samples+=1
                                edge1=faces[:,1]-faces[:,0];edge2=faces[:,2]-faces[:,0]
                                h=np.cross(direction,edge2);a=np.einsum('ij,ij->i',edge1,h)
                                valid=np.abs(a)>1e-10;inv=np.divide(1,a,out=np.zeros_like(a),where=valid)
                                s=origin-faces[:,0];u=inv*np.einsum('ij,ij->i',s,h)
                                q=np.cross(s,edge1);v=inv*np.einsum('j,ij->i',direction,q)
                                distance=inv*np.einsum('ij,ij->i',edge2,q)
                                if np.any(valid & (u>=0) & (v>=0) & (u+v<=1) & (distance>=0) & (distance<=1)):
                                    hits+=1
                check(hits==0,f'deck: authored geometry closes {hits} of {samples} slot rays')
                extra={'structuralBoundsXYZ':[round(float(v),4) for v in struct_high-struct_low],
                    'clearSlotRays':samples-hits,'slotRaySamples':samples,'interactionHardwareExcludedFromStructuralBounds':True}
            if name=='bridge-mount':
                check(asset['origin']=='socket' and asset['sockets'].get('socket-ring')==[0,0,0],'bridge-mount: socket-origin differs')
                check(np.max(np.abs(size-np.array(asset['dimensionsXYZ'])))<.001,'bridge-mount: dimensions differ')
                check(abs(low[1]+.28)<.001 and abs(high[1]-.152*80/93)<.001,'bridge-mount: embedded plate/arc bounds differ')
                check(len(asset['collider']['parts'])==23,'bridge-mount: expected plate, four bolts, two stands and sixteen arc hulls')
                eye=np.concatenate(material_points['ochre'])
                hull=np.concatenate([np.array(part['vertices']).reshape((-1,3)) for part in asset['collider']['parts'] if part['shape']=='convexHull'])
                distances=np.linalg.norm(eye[:,None,:]-hull[None,:,:],axis=2)
                mismatch=max(float(distances.min(axis=0).max()),float(distances.min(axis=1).max()))
                check(mismatch<1e-5,'bridge-mount: arc collider vertices do not match rendered mesh')
                check(np.concatenate(material_points['alloy'])[:,1].max()<=-.18+1e-6,'bridge-mount: bolt projects above road datum')
                extra={'arcColliderVertexDeviationMeters':mismatch,'embeddedBoltTopY':round(float(np.concatenate(material_points['alloy'])[:,1].max()),6)}
            result.append({'assetId':name,'triangles':tri,'bytes':path.stat().st_size,'visualBoundsXYZ':[round(float(v),4) for v in size],'visualCentreXYZ':[round(float(v),4) for v in center],**extra})
        for i,node in enumerate(doc['nodes']):
            socket=asset.get('sockets',{}).get(node.get('name'))
            if socket:
                check(np.max(np.abs(world[i][:3,3]-np.array(socket)))<.005,f'{name}: socket transform mismatch {node.get("name")}')
    return result


def audio():
    manifest=json.loads((ASSETS/'audio/manifest.json').read_text())
    hashes=set();result=[]
    for asset in manifest['assets']:
        name=asset['assetId'];path=ASSETS/'audio'/(name+'.wav')
        h=hashlib.sha256(path.read_bytes()).hexdigest()
        check(h==asset['sha256'],f'{name}: WAV hash differs');check(h not in hashes,f'{name}: duplicate audio bytes');hashes.add(h)
        with wave.open(str(path),'rb') as f:
            check(f.getnchannels()==1 and f.getsampwidth()==2 and f.getframerate()==32000,f'{name}: WAV format differs')
            frames=f.getnframes();pcm=np.frombuffer(f.readframes(frames),dtype='<i2').astype(float)/32767
        check(np.max(np.abs(pcm))<.80,f'{name}: excessive peak')
        check(abs(np.mean(pcm))<.015,f'{name}: excessive DC offset')
        check(abs(frames/32000-asset['seconds'])<1/32000,f'{name}: duration differs')
        wrap=float(abs(pcm[-1]-pcm[0]))
        normal=float(np.percentile(np.abs(np.diff(pcm)),99))
        if asset['loop']:
            check(wrap<max(.02,normal*1.5),f'{name}: loop boundary discontinuity')
        result.append({'assetId':name,'frames':frames,'peakDbFS':asset['peakDbFS'],'loop':asset['loop'],'loopWrapDelta':round(wrap,6) if asset['loop'] else None})
    return result


def fonts_and_svg():
    fonts=json.loads((ASSETS/'fonts/manifest.json').read_text())['assets']
    for entry in fonts:
        path=ASSETS/'fonts'/Path(entry['runtimePath']).name
        check(hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256'],f'{path.name}: font hash differs')
        cmap=TTFont(path).getBestCmap()
        check(all(ord(c) in cmap for c in 'АБВЯЁабвяёABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'),f'{path.name}: RU/EN glyphs absent')
    for path in [*(ASSETS/'icons').glob('*.svg'),*(ASSETS/'covers').glob('*.svg')]:
        doc=ET.parse(path).getroot()
        check(doc.tag.endswith('svg') and doc.get('viewBox'),f'{path.name}: invalid SVG')
        check('http' not in path.read_text().replace('http://www.w3.org/2000/svg',''),f'{path.name}: external SVG resource')
    return {'fonts':len(fonts),'icons':len(list((ASSETS/'icons').glob('*.svg'))),'covers':len(list((ASSETS/'covers').glob('*.svg')))}


if __name__=='__main__':
    result={'scope':'asset byte/geometry contracts; not gameplay or listening acceptance','models':models(),'audio':audio(),'ui':fonts_and_svg(),'issues':ISSUES}
    output=ROOT/'art/VALIDATION.json'
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'models':len(result['models']),'audio':len(result['audio']),'ui':result['ui'],'issues':ISSUES},ensure_ascii=False,indent=2))
    raise SystemExit(1 if ISSUES else 0)
