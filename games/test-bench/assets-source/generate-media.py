#!/usr/bin/env python3
"""Original Test Bench procedural atlas, vectors and sample-free synthesis.

Deterministic standard-library generator. Sources/exports are kept together and
the manifest records bytes from disk, never estimates or claimed listening.
"""
from pathlib import Path
import hashlib
import json
import math
import random
import shutil
import struct
import wave
import zlib

GAME = Path(__file__).resolve().parent.parent
ROOT = GAME.parent.parent
OUT = GAME / 'public' / 'test-bench'
for directory in ('textures', 'audio', 'icons', 'fonts'):
    (OUT / directory).mkdir(parents=True, exist_ok=True)

def png(path, width, height, pixels):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    scanlines = b''.join(b'\0' + bytes(pixels[y * width * 3:(y + 1) * width * 3]) for y in range(height))
    path.write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(scanlines, 9)) + chunk(b'IEND', b''))

palette = ['ffbd49', 'f4f1e9', '263944', '283238', '33b99e', 'd95b50', 'a9bac1', '638a91', 'd9d5c8', '9ea69f', 'be9c6f', '14212a', 'ffffff', '668c73', 'bc7751', 'b4d2cf']
pixels=[]
rng=random.Random(71832)
for y in range(128):
    for x in range(128):
        # glTF texture coordinates start at the upper left (GLTFLoader sets flipY=false).
        color=palette[(y//32)*4+x//32]
        noise=rng.randrange(-3,4)
        pixels += [max(0,min(255,int(color[n:n+2],16)+noise)) for n in (0,2,4)]
png(OUT/'textures/workshop-palette.png',128,128,pixels)

def svg(body, width=128, height=128, extra=''):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" {extra}>{body}</svg>\n'

def icon(path):
    return svg('<rect x="4" y="4" width="120" height="120" rx="24" fill="#ece8dc"/>' + path)

def wheel(radius, tread=False):
    body=f'<ellipse cx="64" cy="103" rx="{radius+5}" ry="7" fill="#18252e" opacity=".12"/><circle cx="64" cy="62" r="{radius}" fill="#263944"/><circle cx="64" cy="62" r="{radius-7}" fill="none" stroke="#52616a" stroke-width="3"/><circle cx="64" cy="62" r="{radius*.53}" fill="#f4f1e9"/>'
    for i in range(6):
        a=i*math.pi/3
        body+=f'<path d="M64 62l{math.cos(a)*radius*.5:.2f} {math.sin(a)*radius*.5:.2f}" stroke="#9da9ad" stroke-width="5"/>'
    body+='<circle cx="64" cy="62" r="8" fill="#ffbd49"/><circle cx="64" cy="62" r="3" fill="#263944"/>'
    if tread:
        for i in range(14):
            body+=f'<rect x="60" y="{62-radius-2}" width="8" height="7" rx="2" fill="#14212a" transform="rotate({i*360/14} 64 62)"/>'
    return body

icons={
    'road':wheel(37), 'terrain':wheel(41,True),'high':wheel(45,True),
    'speed':'<path d="M29 82V49l20-12h43v44z" fill="#d95b50"/><path d="M29 49h63v32H29z" fill="#f09a7f"/><path d="M39 45v35m10-36v36m10-36v36m10-36v36m10-36v36" stroke="#e9e5d9" stroke-width="4"/><path d="M21 64h13m56 0h18" stroke="#263944" stroke-width="10"/><path d="m51 21-4 13h11l-3 13 18-21H62l4-5" fill="#ffbd49"/>',
    'torque':'<rect x="27" y="44" width="73" height="45" rx="12" fill="#638a91"/><path d="M39 41v51m10-51v51m10-51v51m10-51v51m10-51v51m10-51v51" stroke="#dbe2df" stroke-width="4"/><path d="M17 66h17m61 0h16" stroke="#263944" stroke-width="10"/><path d="M53 31h23v9H53" fill="#ffbd49"/>',
    'economy':'<rect x="29" y="47" width="68" height="40" rx="16" fill="#33b99e"/><path d="M43 43v48m11-48v48m11-48v48m11-48v48m11-48v48" stroke="#e9e5d9" stroke-width="4"/><path d="M18 66h18m58 0h16" stroke="#263944" stroke-width="8"/><path d="M56 29c2-12 15-9 22-15-1 13-5 24-22 15" fill="#668c73"/>',
    'small':'<rect x="32" y="39" width="65" height="51" rx="8" fill="#263944"/><path d="M42 33h11v10H42m34-10h11v10H76" fill="#bc7751"/><rect x="42" y="50" width="44" height="26" rx="4" fill="#33b99e"/><path d="M53 56v14m12-14v14m12-14v14" stroke="#f4f1e9" stroke-width="6"/>',
    'large':'<rect x="23" y="36" width="83" height="60" rx="10" fill="#263944"/><path d="M37 29h13v13H37m41-13h13v13H78" fill="#bc7751"/><rect x="36" y="49" width="57" height="29" rx="4" fill="#33b99e"/><path d="M47 55v17m14-17v17m14-17v17m9-17v17" stroke="#f4f1e9" stroke-width="6"/>',
    'platform':'<path d="m18 68 37-22 55 20-37 26z" fill="#ffbd49"/><path d="M18 68v13l55 22V92m37-26v13l-37 24V92" fill="#be9c6f"/><path d="m21 58 53 21 34-23" fill="none" stroke="#f4f1e9" stroke-width="7"/><ellipse cx="45" cy="66" rx="10" ry="5" fill="#263944"/><ellipse cx="65" cy="72" rx="10" ry="5" fill="#263944"/><ellipse cx="83" cy="64" rx="10" ry="5" fill="#263944"/>',
    'cradle':'<path d="m31 75-5 6 10 5-10 6 10 6m49-23-5 6 10 5-10 6 10 6" fill="none" stroke="#638a91" stroke-width="5"/><path d="m18 54 37-22 55 20-37 26z" fill="#f4f1e9" stroke="#a9bac1" stroke-width="2"/><path d="M18 54v16l55 22V78m37-26v16L73 92V78" fill="#33b99e"/><ellipse cx="45" cy="51" rx="10" ry="5" fill="#263944"/><ellipse cx="65" cy="58" rx="10" ry="5" fill="#263944"/><ellipse cx="83" cy="50" rx="10" ry="5" fill="#263944"/>',
    'clamp':'<path d="m18 68 37-22 55 20-37 26z" fill="#ffbd49"/><path d="M27 64V36l34 12v34m37-21V32L65 46v35" fill="none" stroke="#638a91" stroke-width="7" stroke-linejoin="round"/><path d="m27 36 34 12m37-16L65 46" stroke="#263944" stroke-width="10" stroke-linecap="round"/><path d="M18 78l55 22 37-22" stroke="#a9bac1" stroke-width="6"/>',
    'damper-front':'<path d="M64 22v84" stroke="#a9bac1" stroke-width="8"/><path d="m47 33 34 9-34 9 34 9-34 9 34 9-34 9 34 9" stroke="#638a91" stroke-width="5" fill="none" stroke-linejoin="round"/><path d="M44 28h40M44 103h40" stroke="#d95b50" stroke-width="10" stroke-linecap="round"/>',
    'ballast':'<path d="m22 46 42-17 43 19-42 18z" fill="#a9bac1"/><path d="M22 46v40l43 17V66" fill="#638a91"/><path d="M107 48v37l-42 18V66" fill="#263944"/><path d="m48 36 39 17-22 10-41-17" fill="#52616a"/><circle cx="39" cy="47" r="4" fill="#f4f1e9"/><circle cx="89" cy="48" r="4" fill="#f4f1e9"/>',
    'rollbar':'<path d="M27 100V40q0-12 12-12h50q12 0 12 12v60M28 69l28 30m45-30L73 99" stroke="#263944" stroke-width="9" fill="none" stroke-linejoin="round"/><path d="M39 28h50" stroke="#ffbd49" stroke-width="10"/><path d="M21 103h18m56 0h18" stroke="#a9bac1" stroke-width="7"/>',
    'egg':'<path d="M64 24c-17 0-32 30-32 47a32 32 0 0 0 64 0c0-17-15-47-32-47" fill="#f4f1e9" stroke="#be9c6f" stroke-width="3"/><ellipse cx="64" cy="76" rx="34" ry="14" fill="none" stroke="#638a91" stroke-width="5"/><path d="M38 67V91m52-24V91" stroke="#33b99e" stroke-width="7"/>',
    'instrument':'<rect x="28" y="30" width="73" height="68" rx="13" fill="#638a91"/><rect x="40" y="43" width="48" height="33" rx="5" fill="#f4f1e9"/><path d="M50 65V53m12 12V49m12 16V56" stroke="#263944" stroke-width="5"/><circle cx="78" cy="87" r="4" fill="#33b99e"/>',
    'power-cell':'<rect x="43" y="20" width="42" height="11" rx="3" fill="#bc7751"/><rect x="33" y="30" width="62" height="73" rx="13" fill="#33b99e"/><path d="M33 42h62m-62 49h62" stroke="#263944" stroke-width="9"/><path d="m67 50-16 19h12l-5 15 20-22H66l5-12" fill="#f4f1e9"/>',
    'impact':'<path d="m62 20-6 25-26-5 19 18-22 24 29-5 9 28 8-29 28 4-20-23 16-23-28 8z" fill="#d95b50"/><path d="m65 39-9 25h13l-7 22" stroke="#f4f1e9" stroke-width="6" fill="none"/>',
    'keyboard':'<rect x="14" y="35" width="100" height="60" rx="9" fill="#263944"/><path d="M25 47h10m8 0h10m8 0h10m8 0h10m8 0h8M25 62h10m8 0h10m8 0h10m8 0h10m8 0h8M34 80h60" stroke="#f4f1e9" stroke-width="8"/>',
    'touch':'<circle cx="37" cy="77" r="21" fill="none" stroke="#638a91" stroke-width="4"/><circle cx="37" cy="77" r="9" fill="#33b99e"/><rect x="82" y="29" width="25" height="67" rx="10" fill="#ffbd49"/><path d="m87 50 8-8 8 8m-16 27 8 8 8-8" stroke="#263944" stroke-width="4" fill="none"/>',
}
icons['damper-rear']=icons['damper-front']
for name,body in icons.items():
    (OUT/'icons'/f'{name}.svg').write_text(icon(body))

# Original cover: the finished mechanical silhouette, not text baked into an image.
cover='''<defs><linearGradient id="wall" x2="0" y2="1"><stop stop-color="#efebdf"/><stop offset="1" stop-color="#d9d5c8"/></linearGradient><linearGradient id="deck" x2="0" y2="1"><stop stop-color="#ffd379"/><stop offset="1" stop-color="#ffbd49"/></linearGradient><filter id="blur"><feGaussianBlur stdDeviation="11"/></filter></defs>
<rect width="960" height="600" rx="28" fill="url(#wall)"/>
<path d="M0 470 490 188 960 459v141H0" fill="#e4dfd1"/>
<g opacity=".3" stroke="#a9a99b" fill="none"><path d="m0 504 520-298m-390 394L657 295m-258 305 398-225M0 382l377 218M120 268l575 332M365 198l595 343"/></g>
<ellipse cx="522" cy="417" rx="233" ry="65" fill="#263944" opacity=".18" filter="url(#blur)"/>
<path d="m260 375 326-186 214 125-327 190z" fill="#c1c5bc"/><path d="m260 375 213 129v20L260 394" fill="#9da79f"/>
<path d="m288 369 326-187 26 16-327 186m53 29 326-187 24 14-326 187m51 31 326-187 25 15-326 187" stroke="#e8e5d8" stroke-width="12"/>
<g fill="#263944" stroke="#14212a" stroke-width="7"><ellipse cx="352" cy="337" rx="42" ry="59" transform="rotate(-29 352 337)"/><ellipse cx="622" cy="186" rx="42" ry="59" transform="rotate(-29 622 186)"/><ellipse cx="555" cy="425" rx="42" ry="59" transform="rotate(-29 555 425)"/><ellipse cx="780" cy="294" rx="42" ry="59" transform="rotate(-29 780 294)"/></g>
<g fill="#f4f1e9" stroke="#71818a" stroke-width="6"><ellipse cx="555" cy="425" rx="24" ry="36" transform="rotate(-29 555 425)"/><ellipse cx="780" cy="294" rx="24" ry="36" transform="rotate(-29 780 294)"/></g>
<g fill="#ffbd49"><ellipse cx="555" cy="425" rx="9" ry="14" transform="rotate(-29 555 425)"/><ellipse cx="780" cy="294" rx="9" ry="14" transform="rotate(-29 780 294)"/></g>
<path d="m331 280 267-151 201 116-268 155z" fill="url(#deck)"/><path d="M331 280v34l200 117v-31" fill="#d99c38"/><path d="m531 400 268-155v34L531 431" fill="#eda939"/>
<path d="m347 275 254-141 181 107" stroke="#f4f1e9" stroke-width="12" fill="none" stroke-linejoin="round"/>
<path d="m518 366 245-139" stroke="#f4f1e9" stroke-width="12" fill="none"/>
<path d="m485 323-11 18 31 4-12 17 29 5m137-136-11 18 31 4-12 17 29 5" stroke="#638a91" stroke-width="7" fill="none"/>
<path d="m420 251 169-96 134 78-169 98z" fill="#f4f1e9" stroke="#a9bac1" stroke-width="3"/><path d="M420 251v35l134 78v-33m169-98v34l-169 97v-33" fill="#33b99e"/>
<g fill="#f4f1e9" stroke="#c7b89d" stroke-width="3"><path d="M492 158c-18-4-40 16-42 39-2 21 22 37 39 28 19-10 22-34 16-49-3-9-6-15-13-18"/><path d="M561 193c-18-4-40 16-42 39-2 21 22 37 39 28 19-10 22-34 16-49-3-9-6-15-13-18"/><path d="M628 153c-18-4-40 16-42 39-2 21 22 37 39 28 19-10 22-34 16-49-3-9-6-15-13-18"/></g>
<g fill="none" stroke="#638a91" stroke-width="7"><path d="M450 205q23 31 53 2m18 33q23 31 53 2m14-41q23 31 53 2"/></g>
<path d="m420 244 134 77 169-98" fill="none" stroke="#f4f1e9" stroke-width="9"/>
<path d="m372 295 43-24 37 21-44 26z" fill="#263944"/><path d="m382 291 29-16 24 14-29 16z" fill="#33b99e"/>
<path d="m717 271 36-19 31 18-36 20z" fill="#638a91"/><path d="m729 263 24 14m-14-20 24 14m-14-20 24 14" stroke="#e9e5d9" stroke-width="4"/>
<path d="m127 361 75-44 92 54-76 44z" fill="#f4f1e9"/><path d="m154 360 47-27 23 13-47 28z" fill="#33b99e"/><path d="m170 389 49-27" stroke="#638a91" stroke-width="4"/>
<g transform="translate(139 124)"><circle r="43" fill="#ffbd49"/><path d="m-20 0 14 15 28-30" stroke="#263944" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>
<path d="M94 487h71m-71 16h43" stroke="#a4aaa1" stroke-width="5" stroke-linecap="round"/>
<g transform="translate(837 107) rotate(30)"><rect x="-9" y="-28" width="18" height="56" rx="7" fill="#a9bac1"/><path d="M-16-39v17h32v-17m-32 78V22h32v17" fill="none" stroke="#a9bac1" stroke-width="12"/></g>'''
(OUT/'cover.svg').write_text(svg(cover,960,600))

SR=22050
def save_wav(name,duration,fun,loop=False):
    count=round(duration*SR);data=[]
    for i in range(count):
        t=i/SR
        envelope=1 if loop else min(1,t/.008)*min(1,max(0,duration-t)/.04)
        value=max(-.92,min(.92,fun(t,i)*envelope))
        data.append(round(value*32767))
    with wave.open(str(OUT/'audio'/f'{name}.wav'),'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(SR);w.writeframes(struct.pack('<'+'h'*len(data),*data))

for name,freq,gain in [('economy',66,.14),('torque',48,.18),('speed',88,.13)]:
    save_wav('motor-'+name,1,lambda t,i,f=freq,g=gain:g*(math.sin(2*math.pi*f*t)+.35*math.sin(2*math.pi*2*f*t)+.14*math.sin(2*math.pi*5*f*t))*(.8+.2*math.sin(2*math.pi*8*t)),True)
for name,gain,smooth in [('concrete',.040,12),('wet',.065,27),('ribs',.05,7)]:
    coefficients=[(rng.uniform(30,1800),rng.uniform(0,math.tau)) for _ in range(smooth)]
    save_wav('surface-'+name,1,lambda t,i,c=coefficients,g=gain: g*sum(math.sin(2*math.pi*round(f)*t+p) for f,p in c)/math.sqrt(len(c)),True)

def impact(t,level=1):
    return (.11+.05*level)*(math.sin(2*math.pi*(130-25*level)*t)+.40*math.sin(2*math.pi*571*t))*math.exp(-t*(16-2*level))+.05*math.sin(2*math.pi*1321*t)*math.exp(-t*60)
for level in range(1,4):save_wav(f'impact-{level}',.18+level*.055,lambda t,i,l=level:impact(t,l))
save_wav('attach',.18,lambda t,i:.20*math.sin(2*math.pi*(720-850*t)*t)*math.exp(-t*35)+.14*math.sin(2*math.pi*180*t)*math.exp(-t*25))
save_wav('cancel',.17,lambda t,i:.12*math.sin(2*math.pi*(470-550*t)*t)*math.exp(-t*22))
save_wav('crack',.24,lambda t,i:.22*(math.sin(2*math.pi*1933*t)+.4*math.sin(2*math.pi*2691*t))*math.exp(-t*37)+.07*math.sin(2*math.pi*203*t)*math.exp(-t*20))
save_wav('load',.30,lambda t,i:.10*math.sin(2*math.pi*(440 if t<.11 else 660)*t)*math.exp(-((t%.11)*10))+.06*math.sin(2*math.pi*220*t)*math.exp(-t*18))
save_wav('deliver',.65,lambda t,i:.13*sum(math.sin(2*math.pi*f*t)*math.exp(-max(0,t-j*.12)*5) if t>=j*.12 else 0 for j,f in enumerate((523.25,659.25,783.99))))
save_wav('start',.40,lambda t,i:.16*(math.sin(2*math.pi*880*t)+.3*math.sin(2*math.pi*1760*t))*min(1,t/.02)*math.exp(-t*6))
save_wav('finish',.80,lambda t,i:.11*sum(math.sin(2*math.pi*f*t)*math.exp(-max(0,t-j*.12)*4) if t>=j*.12 else 0 for j,f in enumerate((392,523.25,659.25,783.99))))
save_wav('reset',.44,lambda t,i:.12*math.sin(2*math.pi*(320+500*t)*t)*math.sin(math.pi*t/.44)**2)
save_wav('gate',.20,lambda t,i:.13*math.sin(2*math.pi*1046.5*t)*math.exp(-t*22))
save_wav('depleted',.42,lambda t,i:.10*math.sin(2*math.pi*(330 if t<.15 else 220)*t)*math.exp(-t*5))
save_wav('workshop',4,lambda t,i:.022*math.sin(2*math.pi*50*t)+.007*math.sin(2*math.pi*148*t)+.008*math.sin(2*math.pi*211*t)*(1+math.sin(2*math.pi*.5*t)),True)
notes=[261.6256,329.6276,391.9954,329.6276,293.6648,349.2282,440,349.2282,329.6276,391.9954,493.8833,391.9954,293.6648,349.2282,391.9954,349.2282]
def music(t,i):
    step=int(t/.5)%len(notes);p=t%.5
    note=.045*(math.sin(2*math.pi*notes[step]*p)+.17*math.sin(4*math.pi*notes[step]*p))*math.exp(-p*6)*min(1,p/.006)
    bass=[130.8128,146.8324,164.8138,146.8324][int(t/2)%4]
    return note+.025*math.sin(2*math.pi*bass*(t%2))*min(1,(t%2)/.03)*max(0,1-(t%2)/2)
save_wav('music',8,music,True)

font_css=[]
font_entries={}
for name,weights in [('golos-text',[400,600]),('roboto-condensed',[700])]:
    package=ROOT/'node_modules'/'@fontsource'/name
    metadata=json.loads((package/'metadata.json').read_text())
    for subset in ('latin','cyrillic'):
        for weight in weights:
            filename=f'{name}-{subset}-{weight}-normal.woff2'
            shutil.copyfile(package/'files'/filename,OUT/'fonts'/filename)
            cssfile=package/f'{subset}-{weight}.css'
            css=cssfile.read_text().replace('./files/','./fonts/')
            # Only ship the woff2 source; the package CSS also mentions woff.
            import re
            css=re.sub(r",\s*url\([^)]*\.woff\) format\('woff'\)", '', css)
            unicode_range = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' if subset == 'latin' else 'U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'
            css=css.replace('}',f'  unicode-range: {unicode_range};\n}}')
            font_css.append(css)
            font_entries[f'fonts/{filename}']={
                'sourceUrl':f'https://www.npmjs.com/package/@fontsource/{name}',
                'author':metadata['license']['attribution'],'license':'OFL-1.1',
                'licenseUrl':f'https://fontsource.org/fonts/{name}/about',
                'source':f'node_modules/@fontsource/{name}/files/{filename}',
                'changes':'Unmodified WOFF2 subset copied from the pinned npm package.'}
    shutil.copyfile(package/'LICENSE',OUT/'fonts'/f'{name}-LICENSE.txt')
    font_entries[f'fonts/{name}-LICENSE.txt']={
        'sourceUrl':f'https://www.npmjs.com/package/@fontsource/{name}',
        'author':metadata['license']['attribution'],'license':'OFL-1.1',
        'licenseUrl':f'https://fontsource.org/fonts/{name}/about',
        'source':f'node_modules/@fontsource/{name}/LICENSE',
        'changes':'Unmodified license copied from the pinned npm package.'}
(OUT/'fonts.css').write_text('\n'.join(font_css))

inventory=json.loads((OUT/'model-inventory.json').read_text()) if (OUT/'model-inventory.json').exists() else []
models={m['id']:m for m in inventory}
manifest={
    'schemaVersion':1,'gameId':'test-bench','artVersion':'test-bench-art@1',
    'units':'metres','up':'Y','forward':'+Z',
    'sourceGenerator':['assets-source/generate-models.mjs','assets-source/generate-media.py'],
    'sourceLicense':'assets-source/LICENSE.txt',
    'candidateReview':[
        {'url':'https://kenney.nl/assets/prototype-kit','license':'CC0-1.0','licenseUrl':'https://kenney.nl/assets/prototype-kit','checkedOn':'2026-11-28','decision':'Suitable licensed blockout candidate. Not incorporated: final vehicle needs original seven-slot silhouette and visible suspension.'},
        {'url':'https://kenney.nl/assets/racing-kit','license':'CC0-1.0','licenseUrl':'https://kenney.nl/assets/racing-kit','checkedOn':'2026-11-28','decision':'Suitable licensed racing props candidate. Not incorporated: workshop scale, sockets and single shared palette are made as original geometry.'},
        {'url':'https://docs.ambientcg.com/license/','license':'CC0-1.0','checkedOn':'2026-11-28','decision':'License checked. Photographic material set not used; original small enamel atlas preserves the stylized toy workshop and transfer budget.'},
        {'url':'https://polyhaven.com/license','license':'CC0-1.0','checkedOn':'2026-11-28','decision':'License checked. No downloaded textures, HDRIs or model files incorporated.'}],
    'assets':[]
}
for path in sorted(OUT.rglob('*')):
    if not path.is_file():continue
    rel=path.relative_to(OUT).as_posix()
    if rel=='assets-manifest.json':continue
    entry={'id':rel.rsplit('.',1)[0],'path':'public/test-bench/'+rel,'servedUrl':'/test-bench/'+rel,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':path.stat().st_size,
        'sourceUrl':None,'author':'Iva Games — original procedural production','license':'MIT','licenseUrl':'assets-source/LICENSE.txt','checkedOn':'2026-11-28',
        'source':'assets-source/generate-models.mjs' if path.suffix=='.glb' or path.name=='model-inventory.json' else 'assets-source/generate-media.py',
        'changes':'Generated from original source; no external mesh, texture pixels or audio recording.'}
    if rel in font_entries:entry.update(font_entries[rel])
    if path.suffix=='.glb' and path.stem in models:entry.update({k:v for k,v in models[path.stem].items() if k!='id'})
    if path.suffix=='.wav':
        with wave.open(str(path),'rb') as w:entry.update({'sampleRate':w.getframerate(),'channels':w.getnchannels(),'durationSeconds':w.getnframes()/w.getframerate(),'auditoryAcceptance':'Not claimed by generation.'})
    manifest['assets'].append(entry)
(GAME/'assets-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
(OUT/'assets-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(f'Generated original media and manifest: {len(manifest["assets"])} files, {sum(x["bytes"] for x in manifest["assets"])} bytes.')
