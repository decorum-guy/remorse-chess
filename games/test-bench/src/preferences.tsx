import { useEffect, useRef, useState } from 'react';
import type { Locale } from './types';

export type Control = 'throttle' | 'reverse' | 'left' | 'right' | 'brake' | 'interact' | 'restore';
export interface BenchPreferences {
  locale: Locale; renderer: '3d' | '2d'; quality: 'high' | 'low'; volume: number; music: number;
  reducedMotion: boolean; effects: boolean; textScale: number; keys: Record<Control, string>;
}
const defaultKeys = { throttle:'KeyW', reverse:'KeyS', left:'KeyA', right:'KeyD', brake:'Space', interact:'KeyE', restore:'KeyR' };
const arrows:Record<string,Control>={ArrowUp:'throttle',ArrowDown:'reverse',ArrowLeft:'left',ArrowRight:'right'};
function validKey(control:Control,code:unknown):code is string{return typeof code==='string'&&/^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space)$/.test(code)&&(!arrows[code]||arrows[code]===control);}
function savedKeys(input:Partial<Record<Control,string>>|undefined):Record<Control,string>{const keys={...defaultKeys};for(const key of Object.keys(keys) as Control[])if(validKey(key,input?.[key]))keys[key]=input[key]!;return new Set(Object.values(keys)).size===Object.keys(keys).length?keys:{...defaultKeys};}
const base: BenchPreferences = {locale:'ru',renderer:'3d',quality:'high',volume:0.6,music:0.15,reducedMotion:false,effects:true,textScale:100,keys:defaultKeys};
const level=(value:unknown,fallback:number)=>Number.isFinite(Number(value))?Math.max(0,Math.min(1,Number(value))):fallback;
export function readPreferences(): BenchPreferences {
  try {
    const raw = JSON.parse(localStorage.getItem('iva.test-bench.preferences.v1') || '{}') as Partial<BenchPreferences>;
    return {...base, ...raw, locale:raw.locale === 'en' ? 'en':'ru',renderer:raw.renderer === '2d'?'2d':'3d',
      quality:raw.quality === 'low'?'low':'high',volume:level(raw.volume??base.volume,base.volume),
      music:level(raw.music??base.music,base.music),textScale:raw.textScale===130?130:100,
      reducedMotion:raw.reducedMotion===true,effects:raw.effects!==false,
      keys:savedKeys(raw.keys)};
  } catch { return {...base,keys:{...defaultKeys}}; }
}
export function useBenchPreferences() {
  const [preferences,setPreferences] = useState<BenchPreferences>(readPreferences);
  useEffect(()=>{try{localStorage.setItem('iva.test-bench.preferences.v1',JSON.stringify(preferences));window.dispatchEvent(new Event('iva-test-bench-preferences'));}catch{/* Keep current settings usable when storage is unavailable. */}},[preferences]);
  useEffect(()=>{const sync=()=>{const next=readPreferences();setPreferences(current=>JSON.stringify(current)===JSON.stringify(next)?current:next);};window.addEventListener('iva-test-bench-preferences',sync);return()=>window.removeEventListener('iva-test-bench-preferences',sync);},[]);
  return [preferences,setPreferences] as const;
}
export function keyLabel(code: string) {return code.replace(/^Key/,'').replace('Arrow','').replace('Space','␣');}
export function BenchSettings({preferences,onChange,onClose}:{preferences:BenchPreferences;onChange:(p:BenchPreferences)=>void;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [binding,setBinding]=useState<Control|null>(null);
  const [error,setError]=useState('');
  const t=(ru:string,en:string)=>preferences.locale==='ru'?ru:en;
  const labels:Record<Control,[string,string]>={throttle:['Газ','Accelerate'],reverse:['Тормоз / назад','Brake / reverse'],left:['Влево','Left'],right:['Вправо','Right'],brake:['Ручник','Handbrake'],interact:['Погрузка / подбор','Load / collect'],restore:['Возврат','Reset']};
  useEffect(()=>{dialog.current?.showModal();return ()=>dialog.current?.close();},[]);
  return <dialog ref={dialog} className="tb-dialog" aria-label={t('Настройки стенда','Test Bench settings')} onCancel={onClose}>
    <form method="dialog" onSubmit={event=>{event.preventDefault();onClose();}}>
      <header><div><span className="tb-eyebrow">{t('Пульт мастерской','Workshop controls')}</span><h2>{t('Настройки','Settings')}</h2></div><button className="tb-icon" aria-label={t('Закрыть настройки','Close settings')} onClick={onClose} type="button">×</button></header>
      <div className="tb-settings-grid">
        <label>{t('Язык','Language')}<select aria-label={t('Язык','Language')} value={preferences.locale} onChange={e=>onChange({...preferences,locale:e.target.value as Locale})}><option value="ru">Русский</option><option value="en">English</option></select></label>
        <label>{t('Вид','View')}<select aria-label={t('Вид','View')} value={preferences.renderer} onChange={e=>onChange({...preferences,renderer:e.target.value as '3d'|'2d'})}><option value="3d">2.5D</option><option value="2d">2D</option></select></label>
        <label>{t('Качество','Quality')}<select aria-label={t('Качество','Quality')} value={preferences.quality} onChange={e=>onChange({...preferences,quality:e.target.value as 'high'|'low'})}><option value="high">{t('Высокое','High')}</option><option value="low">{t('Экономичное','Low')}</option></select></label>
        <label>{t('Размер текста','Text size')}<select aria-label={t('Размер текста','Text size')} value={preferences.textScale} onChange={e=>onChange({...preferences,textScale:Number(e.target.value)})}><option value="100">100%</option><option value="130">130%</option></select></label>
        <label>{t('Звук','Sound')} <output>{Math.round(preferences.volume*100)}%</output><input aria-label={t('Звук','Sound')} type="range" min="0" max="1" step="0.05" value={preferences.volume} onChange={e=>onChange({...preferences,volume:Number(e.target.value)})}/></label>
        <label>{t('Музыка','Music')} <output>{Math.round(preferences.music*100)}%</output><input aria-label={t('Музыка','Music')} type="range" min="0" max="1" step="0.05" value={preferences.music} onChange={e=>onChange({...preferences,music:Number(e.target.value)})}/></label>
        <label className="tb-check"><input type="checkbox" checked={preferences.reducedMotion} onChange={e=>onChange({...preferences,reducedMotion:e.target.checked})}/>{t('Уменьшить движение','Reduce motion')}</label>
        <label className="tb-check"><input type="checkbox" checked={preferences.effects} onChange={e=>onChange({...preferences,effects:e.target.checked})}/>{t('Пыль и брызги','Dust and spray')}</label>
      </div>
      <h3>{t('Управление','Controls')}</h3><p>{t('Выбери действие и нажми новую клавишу. Стрелки тоже работают.','Choose an action, then press a new key. Arrow keys also work.')}</p>
      <div className="tb-bindings">{(Object.keys(labels) as Control[]).map(control=><button type="button" key={control} aria-pressed={binding===control} onClick={()=>{setBinding(control);setError('');}} onKeyDown={e=>{if(binding!==control)return;e.preventDefault();e.stopPropagation();if(e.code==='Escape'){setBinding(null);return;}if(!validKey(control,e.code)){setError(t('Выбери букву, цифру или пробел. Стрелки закреплены за движением.','Choose a letter, number or space. Arrow keys keep their driving directions.'));return;}if(Object.entries(preferences.keys).some(([key,code])=>key!==control&&code===e.code)){setError(t('Эта клавиша уже занята.','This key is already assigned.'));return;}onChange({...preferences,keys:{...preferences.keys,[control]:e.code}});setBinding(null);setError('');}}><span>{labels[control][preferences.locale==='ru'?0:1]}</span><kbd>{binding===control?'…':keyLabel(preferences.keys[control])}</kbd></button>)}</div>
      {error&&<p role="alert" className="tb-error">{error}</p>}
      <footer><button type="button" onClick={()=>onChange({...preferences,keys:{...defaultKeys}})}>{t('Сбросить клавиши','Reset keys')}</button><button className="tb-primary" type="submit">{t('Готово','Done')}</button></footer>
    </form>
  </dialog>;
}
