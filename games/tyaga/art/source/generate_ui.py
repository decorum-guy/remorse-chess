"""Original Tyaga icon family and schematic route-cover illustrations."""
from pathlib import Path
import hashlib
import json
import shutil

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'public/assets/tyaga'
(OUT/'icons').mkdir(parents=True,exist_ok=True)
(OUT/'covers').mkdir(parents=True,exist_ok=True)

ICONS={
 'truck': '<path d="M3 7h12v10H3zM15 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M3 4h9M18 10v4h4"/>',
 'hand': '<path d="M7 12V6a1.4 1.4 0 0 1 2.8 0v5-7a1.4 1.4 0 0 1 2.8 0v7-5a1.4 1.4 0 0 1 2.8 0v6-3a1.4 1.4 0 0 1 2.8 0v7c0 4-2.5 6-6 6-3 0-4.2-1.7-6-4l-2-3a1.7 1.7 0 0 1 2.8-2l1 1"/>',
 'release': '<path d="M7 12V6a1.4 1.4 0 0 1 2.8 0v5-7a1.4 1.4 0 0 1 2.8 0v7-5a1.4 1.4 0 0 1 2.8 0v6M18 12v4c0 4-2.5 6-6 6-3 0-4.2-1.7-6-4l-2-3"/><path d="m18 3 4 4m0-4-4 4"/>',
 'anchor': '<circle cx="12" cy="5" r="3"/><path d="M12 8v14M7 11h10M3 15c0 9 18 9 18 0m-18 0 4 3m14-3-4 3"/>',
 'winch': '<path d="M3 19h18M6 8v11M18 8v11M6 10h12v6H6M9 10v6M12 10v6M15 10v6M18 12h3V6h-3"/><path d="M12 16v5"/>',
 'rope': '<path d="M4 4c6 0 0 16 7 16 7 0 7-10 2-10s-5 7 0 7M4 4v4M2 8h4"/><circle cx="19" cy="5" r="3"/><path d="M19 8v5"/>',
 'strap': '<path d="M8 4H4v16h4M16 4h4v16h-4M8 8h8v8H8zM12 8v8M4 11h4M16 11h4"/>',
 'deck': '<path d="M3 7h18v10H3zM6 7v10M10 7v10M14 7v10M18 7v10M3 5v14M21 5v14"/>',
 'beam': '<path d="m3 8 4-4 15 12-4 4L3 8ZM7 4v5M3 8l4 1 15 7"/>',
 'jack': '<path d="M4 21h16M7 21V9h10v12M10 9V4h4v5M7 4h10M17 15l4-9"/><path d="M8 12h8"/>',
 'repair': '<path d="M4 8h16v13H4zM9 8V4h6v4M4 12h16"/><path d="m9 18 6-6m-6 0 6 6"/>',
 'crate': '<path d="M3 7h18v14H3zM3 7l3-4h12l3 4M7 7v14M17 7v14M10 12h4"/>',
 'drive': '<path d="M7 3h10v8H7zM12 11v10M4 19h16M12 16l-5 5m5-5 5 5M17 7h4"/><path d="M9 6h6"/>',
 'ferry': '<path d="M3 15h18l-3 6H6l-3-6ZM4 11h16v4M7 11V8h10v3M12 8V3M12 3l6 3h-6"/>',
 'lift': '<path d="M3 22V3h18v19M3 6h18M8 6v8M16 6v8M5 14h14v4H5zM10 11l2-3 2 3"/>',
 'camp': '<path d="m2 21 10-18 10 18H2Zm7 0 3-7 3 7M12 3v11"/>',
 'map': '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16"/><path d="m5 12 2-2 4 3 4-3 4 2"/>',
 'goal': '<path d="M5 22V3M5 3h15l-4 4 4 4H5"/><path d="m8 7 2 2 4-4"/>',
 'rewind': '<path d="M5 8h8a7 7 0 1 1-7 7M5 8V3M5 8h5M8 5 5 8l3 3"/>',
 'bot': '<path d="M5 7h14v13H5zM12 7V3M9 3h6M2 11h3m14 0h3M8 20v2m8-2v2"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M9 16h6"/>',
 'brake': '<circle cx="12" cy="12" r="7"/><path d="M3 5a11 11 0 0 0 0 14M21 5a11 11 0 0 1 0 14M10 8v8M14 8v8"/>',
 'jump': '<path d="M5 21h14M12 18V3m-5 5 5-5 5 5M6 16l6 3 6-3"/>',
 'generator': '<path d="M4 5h16v15H4zM7 8v9m3-9v9m3-9v9M16 8h1m-1 4h1M7 20v2m10-2v2"/>',
 'optics': '<path d="M3 7h18v13H3zM8 7V4h8v3"/><circle cx="12" cy="13" r="4"/><circle cx="12" cy="13" r="1"/>',
 'pump': '<circle cx="11" cy="12" r="7"/><path d="M18 10h4v4h-4M4 10H1v4h3M7 19v3h8v-3"/><path d="M11 8v4l3 2"/>',
 'sound': '<path d="m3 9 5 0 5-5v16l-5-5H3V9ZM17 8c3 2 3 6 0 8M20 5c5 4 5 10 0 14"/>',
 'settings': '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
 'warning': '<path d="m12 3 10 18H2L12 3ZM12 9v5"/><circle cx="12" cy="17.5" r=".8"/>',
}

manifest=[]
for name,path in ICONS.items():
    svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#344955" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><title>'+name+'</title>'+path+'</svg>\n'
    file=OUT/'icons'/(name+'.svg');file.write_text(svg)
    manifest.append({'assetId':name,'runtimePath':'/assets/tyaga/icons/'+name+'.svg','source':'games/tyaga/art/source/generate_ui.py','license':'project-original','sha256':hashlib.sha256(file.read_bytes()).hexdigest()})


def cover(name,theme,road,river,details):
    bg,land,water,rock=theme
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360">
<title>{name} — authored route illustration</title>
<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="{bg}"/><stop offset="1" stop-color="#F5F7F2"/></linearGradient></defs>
<rect width="640" height="360" rx="28" fill="url(#sky)"/>
<path d="M30 235 190 145 383 178 600 84v190L386 347 196 312 30 329Z" fill="{rock}"/>
<path d="M30 218 190 128 383 161 600 67v190L386 330 196 295 30 312Z" fill="{land}"/>
<path d="{river}" fill="none" stroke="{water}" stroke-width="42"/>
<path d="{road}" fill="none" stroke="#B6AA8D" stroke-width="28" stroke-linejoin="round"/>
<path d="{road}" fill="none" stroke="#E7D8B5" stroke-width="20" stroke-linejoin="round"/>
{details}
<g transform="translate(120 228)"><ellipse cy="24" rx="36" ry="12" fill="#344955" opacity=".12"/><path d="m-25 3 34-15 26 13v22L0 36-25 22Z" fill="#D97736"/><path d="m9-12 16-7 22 11v23L35 23V1Z" fill="#E69755"/><path d="m26-15 16 8v11L26-3Z" fill="#44666E"/><path d="m-25 3 34-15 26 13L0 18Z" fill="#F5F7F2"/><ellipse cx="-12" cy="25" rx="8" ry="10" fill="#344955"/><ellipse cx="27" cy="25" rx="8" ry="10" fill="#344955"/><ellipse cx="-12" cy="25" rx="3" ry="4" fill="#B5C5C5"/><ellipse cx="27" cy="25" rx="3" ry="4" fill="#B5C5C5"/></g>
<g transform="translate(550 100)"><path d="M0 40V-15" stroke="#344955" stroke-width="5"/><path d="M0-15h30L20-3 30 9H0Z" fill="#D97736"/></g>
</svg>\n'''
    file=OUT/'covers'/(name+'.svg');file.write_text(svg)
    return {'assetId':'cover-'+name,'runtimePath':'/assets/tyaga/covers/'+name+'.svg','source':'games/tyaga/art/source/generate_ui.py','license':'project-original','type':'schematic route illustration, not gameplay screenshot','sha256':hashlib.sha256(file.read_bytes()).hexdigest()}

manifest.extend([
 cover('valley',('#DBEDE6','#A9C8AB','#70C8D0','#779A8D'),'M64 272 201 198 304 226 423 161 568 143','M267 161 238 308','<g stroke="#344955" stroke-width="5"><path d="m217 201 76 21m-80-10 76 21"/></g><g fill="#397D68"><path d="m72 206 22-49 22 49Z"/><path d="m438 150 22-50 22 50Z"/><path d="m489 132 17-39 17 39Z"/></g>'),
 cover('quarry',('#DCE8E8','#93AAA1','#37BCD0','#718D89'),'M65 273 182 215 321 251 438 173 565 144','M275 178 230 285 359 289 406 216','<path d="m295 251 36-16 50 16-37 17Z" fill="#C9AD80" stroke="#344955" stroke-width="4"/><path d="M326 234v-20" stroke="#D97736" stroke-width="7"/><g fill="#DCE8E4"><path d="m437 200 22-38 26 26-14 28Z"/><path d="m77 231 17-27 22 17-5 25Z"/></g>'),
 cover('ridge',('#DCE7EB','#B7C0B0','#B6D4D7','#8A9D9C'),'M65 272 194 216 261 235 356 192 440 207 572 143','M340 178 313 299','<path d="m300 217 83-30m-80 40 83-30" fill="none" stroke="#344955" stroke-width="5"/><path d="m44 277 20-33 34 8-14 14Z M430 185l21-32 29 18-18 13Z" fill="#F5F7F2"/><g stroke="#F5F7F2" stroke-width="3" fill="none"><path d="M366 90h60m-36 15h73m-45 15h50"/></g><path d="M507 198v-61h34v46" fill="none" stroke="#D97736" stroke-width="5"/>'),
])
(OUT/'icons/manifest.json').write_text(json.dumps({'version':'tyaga-ui-art@1','assets':manifest},ensure_ascii=False,indent=2)+'\n')

fonts=[]
for filename,family,source in [('golos-text-variable.ttf','Golos Text','golostext'),('rubik-variable.ttf','Rubik','rubik')]:
    file=OUT/'fonts'/filename
    license_name=source+'-OFL.txt'
    shutil.copyfile(ROOT/'art/licenses'/license_name,OUT/'fonts'/license_name)
    fonts.append({'assetId':family,'runtimePath':'/assets/tyaga/fonts/'+filename,'sourceURL':'https://github.com/google/fonts/tree/main/ofl/'+source,'license':'SIL Open Font License 1.1','licensePath':'games/tyaga/art/licenses/'+license_name,'runtimeLicensePath':'/assets/tyaga/fonts/'+license_name,'modifications':'none','sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'bytes':file.stat().st_size,'glyphValidation':'RU/EN alphabet, Ё/ё and digits verified with fontTools cmap'})
(OUT/'fonts/manifest.json').write_text(json.dumps({'assets':fonts},ensure_ascii=False,indent=2)+'\n')
(OUT/'fonts/fonts.css').write_text('@font-face{font-family:"Golos Text";font-style:normal;font-weight:400 900;font-display:swap;src:url("./golos-text-variable.ttf") format("truetype")}\n@font-face{font-family:"Rubik";font-style:normal;font-weight:300 900;font-display:swap;src:url("./rubik-variable.ttf") format("truetype")}\n')
print('TYAGA_UI',len(ICONS),'icons, 3 schematic covers, 2 local fonts')
