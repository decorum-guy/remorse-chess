import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { PRESETS, blueprintCost, validateBlueprint } from './catalog';
import { createPhysicsLane } from './physics';
import type { LanePhysics } from './physics';
import { getTrack, TRACK_ORDER, CARGO_PROFILES } from './tracks';
import type { BenchView, Blueprint, DriveInput, LaneSnapshot, Locale, TrackDefinition, TrackId } from './types';
import { BenchHeader, Builder, CupResults, Race, TrackCards, TrackMap, copy, errorText } from './components';
import { BenchSettings, keyLabel, useBenchPreferences } from './preferences';
import type { BenchPreferences } from './preferences';
import { useBenchLive } from './live-client';
import type { Request } from './live-client';
import { TestBenchScene } from './Scene';
import { useBenchAudio, updateSound } from './sound';
import type { BenchAudio } from './Audio';
import '@fontsource/golos-text/400.css';
import '@fontsource/golos-text/600.css';
import '@fontsource/roboto-condensed/700.css';
import './test-bench.css';

const ALL_TRACKS=TRACK_ORDER.map(id=>getTrack(id));
function rootStyle(preferences:BenchPreferences){return {'--tb-scale':preferences.textScale/100} as CSSProperties;}
function readBuild():Blueprint{try{const value=JSON.parse(localStorage.getItem('iva.test-bench.practice.build.v1')||'null');return value?validateBlueprint(value):{...PRESETS.universal};}catch{return {...PRESETS.universal};}}
function useClock(){const [now,setNow]=useState(Date.now);useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),100);return()=>clearInterval(timer);},[]);return now;}

export function TestBenchHome({onCreateRoom,onExit,initialMode}:{onCreateRoom:()=>void;onExit:()=>void;initialMode?:'practice'|'tutorial'}) {
  const [preferences,setPreferences]=useBenchPreferences();const locale=preferences.locale;const sound=useBenchAudio(preferences);
  const [settings,setSettings]=useState(false);const [mode,setMode]=useState<'home'|'practice'|'tutorial'>(initialMode??'home');
  const [blueprint,setBlueprint]=useState<Blueprint>(()=>initialMode==='tutorial'?{...PRESETS.universal}:readBuild());const [track,setTrack]=useState<TrackId>('fragile');
  const [driving,setDriving]=useState(false);const [tutorialStep,setTutorialStep]=useState(0);const [trialSerial,setTrialSerial]=useState(0);
  const [tutorialFastHealth,setTutorialFastHealth]=useState(100);const [tutorialAxle,setTutorialAxle]=useState(false);
  const t=(ru:string,en:string)=>copy(locale,ru,en);
  const leave=()=>{if(mode==='home')onExit();else {setDriving(false);setMode('home');}};
  const updateBuild=(value:Blueprint)=>{sound.current?.event(crypto.randomUUID(),'attach');setBlueprint(value);if(mode==='practice'){try{localStorage.setItem('iva.test-bench.practice.build.v1',JSON.stringify(value));}catch{/* The current build remains usable without storage. */}}if(mode==='tutorial'&&value['front-axle']!==PRESETS.universal['front-axle'])setTutorialAxle(true);};
  const beginPractice=()=>{setBlueprint(readBuild());setMode('practice');setDriving(false);};
  const beginTutorial=()=>{setMode('tutorial');setDriving(false);setTutorialStep(0);setTutorialAxle(false);setBlueprint({...PRESETS.universal});setTrack('fragile');};
  const nextLesson=(lane?:LaneSnapshot)=>{
    if(tutorialStep===3&&lane)setTutorialFastHealth(lane.cargo[0]?.health??0);
    if(tutorialStep===1||tutorialStep===3)setTrialSerial(value=>value+1);
    setTutorialStep(value=>value+1);
  };
  const tutorialTrack:TrackDefinition={...getTrack('fragile'),length:28,orderedGates:[{id:'lesson-gate',x:0,z:18,width:7.2}],unload:{minX:-1.8,maxX:1.8,minZ:21,maxZ:25},ribs:[{z:10,height:0.10,smoothSide:-1},{z:11,height:0.10,smoothSide:-1},{z:12,height:0.10,smoothSide:-1}],ramp:undefined,restorePads:[{x:0,z:0,yaw:0},{x:0,z:19,yaw:0}]};
  const activeTrack=mode==='tutorial'?tutorialTrack:getTrack(track);
  return <main className={'tb-app '+(preferences.reducedMotion?'tb-reduced':'')} style={rootStyle(preferences)} lang={locale}>
    <BenchHeader locale={locale} onExit={leave} onSettings={()=>setSettings(true)} status={mode==='home'?t('Мастерская открыта','Workshop open'):mode==='tutorial'?t('Учебный стенд','Learning bench'):t('Тренировка','Practice')}/>
    {mode==='home'?<div className="tb-home"><section className="tb-hero"><div className="tb-hero-copy"><span className="tb-eyebrow">IVA GAMES / {t('МАЛЫЕ МАШИНЫ. БОЛЬШИЕ ПЛАНЫ.','SMALL MACHINES. BIG IDEAS.')}</span><h1>{t('Собери.','Build.')}<br/>{t('Испытай.','Test.')}<br/><em>{t('Переделай.','Improve.')}</em></h1><p>{t('Одинаковый ящик деталей. Три испытания. И машина, за которую отвечаешь ты.','The same box of parts. Three trials. A machine that’s entirely your responsibility.')}</p><div className="tb-home-actions"><button className="tb-primary" onClick={onCreateRoom}>{t('Создать комнату','Create room')} ↗</button><button onClick={beginPractice}>{t('Тренировка','Practice')}</button><button className="tb-text-button" onClick={beginTutorial}>{t('Как играть','How to play')} →</button></div><div className="tb-home-facts"><span><b>2–6</b>{t('участников','players')}</span><span><b>16</b>{t('жетонов на машину','tokens per machine')}</span><span><b>3</b>{t('испытания','trials')}</span></div></div><div className="tb-hero-scene"><TestBenchScene blueprint={PRESETS.gentle} track={getTrack('fragile')} mode="workshop" renderer={preferences.renderer} quality={preferences.quality} effects={preferences.effects} reducedMotion={preferences.reducedMotion} locale={locale}/><div className="tb-quality-label"><span>№ 001</span><strong>{t('ГОТОВА К ИСПЫТАНИЯМ','READY FOR TESTING')}</strong><small>{t('Пружинная люлька / 15 жетонов','Spring cradle / 15 tokens')}</small></div></div></section><section className="tb-home-tracks"><div className="tb-section-heading"><span className="tb-eyebrow">{t('Программа кубка','Cup programme')}</span><h2>{t('Каждая полоса задаёт свой вопрос.','Every lane asks a different question.')}</h2><p>{t('После каждого заезда — всего две переделки.','Just two changes between trials.')}</p></div><TrackCards tracks={ALL_TRACKS} locale={locale}/></section><footer className="tb-home-footer"><span>{t('Явные боты · Общие комнаты Iva Games','Labelled bots · Iva Games shared rooms')}</span><button onClick={()=>setSettings(true)}>{t('Звук, управление и язык','Sound, controls and language')}</button></footer></div>:
      driving?<LocalDrive key={mode+'-'+track+'-'+trialSerial} blueprint={blueprint} track={activeTrack} preferences={preferences} audio={sound.current} externalPause={settings} tutorialStep={mode==='tutorial'?tutorialStep:undefined} tutorialFastHealth={tutorialFastHealth} onNextLesson={nextLesson} onBack={()=>setDriving(false)} onCompleteTutorial={beginPractice}/>:
      <><div className="tb-practice-selection">{mode==='practice'?<><div className="tb-section-heading"><h2>{t('Выбери испытание','Choose a trial')}</h2><p>{t('Можно повторять, ставить на паузу и менять всё.','Repeat, pause and rebuild as much as you like.')}</p></div><TrackCards tracks={ALL_TRACKS} locale={locale} selected={track} onSelect={value=>setTrack(value.id)}/></>:<div className="tb-lesson-card"><span className="tb-eyebrow">{t('Урок 1 / 6','Lesson 1 / 6')}</span><h2>{t('Начни с передней оси','Start with the front axle')}</h2><p>{t('Поставь грунтовую или высокую ось. Посмотри, как изменились цена и просвет.','Fit an all-terrain or high axle. Notice how the price and clearance change.')}</p><button className="tb-text-button" onClick={beginPractice}>{t('Пропустить урок','Skip lesson')}</button></div>}</div><Builder blueprint={blueprint} previous={null} editableSlot={mode==='tutorial'?'front-axle':undefined} locale={locale} preferences={preferences} onChange={updateBuild} onTest={()=>{setDriving(true);if(mode==='tutorial')setTutorialStep(1);}} onReady={()=>{setDriving(true);if(mode==='tutorial')setTutorialStep(1);}} testDisabled={mode==='tutorial'&&!tutorialAxle} lesson={mode==='tutorial'&&tutorialAxle?<p className="tb-success" role="status">{t('Цена изменилась:','Price changed:')} {blueprintCost(blueprint)}/16. {t('Жми «Проверить» — выезжаем.','Press Test drive — let’s roll.')}</p>:undefined} onExitTest={leave}/></>}
    {settings&&<BenchSettings preferences={preferences} onChange={setPreferences} onClose={()=>setSettings(false)}/>}
  </main>;
}

export function LocalDrive({blueprint,track,preferences,onBack,externalPause=false,tutorialStep,tutorialFastHealth=100,onNextLesson,onCompleteTutorial,workshop=false,audio,seatIndex=0}:{blueprint:Blueprint;track:TrackDefinition;preferences:BenchPreferences;onBack:()=>void;externalPause?:boolean;tutorialStep?:number;tutorialFastHealth?:number;onNextLesson?:(lane?:LaneSnapshot)=>void;onCompleteTutorial?:()=>void;workshop?:boolean;audio?:BenchAudio|null;seatIndex?:number}) {
  const [lane,setLane]=useState<LaneSnapshot|null>(null);const [error,setError]=useState(false);const [paused,setPaused]=useState(false);const [serial,setSerial]=useState(0);
  const [lessonStopped,setLessonStopped]=useState(false);const lessonHold=useRef<number|undefined>(undefined);const settledSteps=useRef(0);
  const lesson=useRef({step:tutorialStep,fastHealth:tutorialFastHealth});lesson.current={step:tutorialStep,fastHealth:tutorialFastHealth};
  const physics=useRef<LanePhysics|null>(null);const input=useRef<DriveInput>({throttle:0,steering:0,brake:false});
  const pause=useRef(false);pause.current=paused||externalPause||lessonStopped;const locale=preferences.locale;
  const t=(ru:string,en:string)=>copy(locale,ru,en);
  useEffect(()=>{lessonHold.current=undefined;settledSteps.current=0;setLessonStopped(false);},[tutorialStep]);
  const trackKey=JSON.stringify(track);const buildKey=JSON.stringify(blueprint);
  useEffect(()=>{
    let cancelled=false;let frame=0;let previous=0;let accumulator=0;setLane(null);setError(false);setLessonStopped(false);lessonHold.current=undefined;settledSteps.current=0;audio?.resetEvents('practice-'+crypto.randomUUID());
    void createPhysicsLane({blueprint:JSON.parse(buildKey),track:JSON.parse(trackKey),participantId:'practice',cargoCount:tutorialStep!==undefined||workshop?1:3,raceLimitTicks:tutorialStep!==undefined?60*240:60*65}).then(world=>{
      if(cancelled){world.dispose();return;}physics.current=world;setLane(world.snapshot());
      const animate=(now:number)=>{
        if(cancelled)return;
        const elapsed=previous?Math.min(0.1,(now-previous)/1000):0;previous=now;
        if(!pause.current&&lessonHold.current===undefined){
          accumulator+=elapsed;
          while(accumulator>=1/60){
            const step=lesson.current.step;const before=world.observe();
            const driving=step===3&&before.car.position.z>=13.5?{throttle:0,steering:0,brake:true}:input.current;
            world.advance(driving);accumulator-=1/60;
            const current=world.observe();
            // Integrity cannot be repaired within an attempt. Once the one
            // loaded capsule can no longer beat the recorded fast run, let
            // the learner restart instead of driving an impossible comparison
            // to the end. This is a failure pause, never successful progress.
            const failedSlowComparison=step===4&&current.cargo.some(cargo=>cargo.status!=='at-dock'&&cargo.health<=lesson.current.fastHealth);
            if(failedSlowComparison){lessonHold.current=step;setLessonStopped(true);accumulator=0;break;}
            const stopped=current.car.position.z>=13.5&&Math.abs(current.car.speed)<.25&&Math.abs(current.car.velocity.y)<.2;
            // Freeze both comparison attempts after settling. A no-impact fast
            // run or an unsuccessful slow run explains its retry; neither can
            // improve its comparison once the obstacle is already behind it.
            const comparison=step===3||step===4;
            settledSteps.current=stopped&&comparison?settledSteps.current+1:0;
            if(settledSteps.current>=30){lessonHold.current=step;setLessonStopped(true);accumulator=0;break;}
          }
          setLane(world.snapshot());
        }
        frame=requestAnimationFrame(animate);
      };
      frame=requestAnimationFrame(animate);
    }).catch(failure=>{if(!cancelled){console.error('Test Bench physics initialization failed',failure);setError(true);}});
    return()=>{cancelled=true;cancelAnimationFrame(frame);physics.current?.dispose();physics.current=null;};
  },[trackKey,buildKey,serial,workshop]);
  useEffect(()=>{updateSound(audio??null,lane,track,input.current,!paused&&!externalPause&&!lessonStopped);},[audio,lane,track,paused,externalPause,lessonStopped]);
  if(error)return <div className="tb-empty"><h2>{t('Не удалось открыть полигон','Could not open the test lane')}</h2><button onClick={()=>setSerial(value=>value+1)}>{t('Повторить','Retry')}</button><button onClick={onBack}>{t('В мастерскую','Workshop')}</button></div>;
  if(!lane)return <div className="tb-empty"><span className="tb-loader"/><p>{t('Готовим полигон…','Preparing the test lane…')}</p><button onClick={onBack}>{t('В мастерскую','Workshop')}</button></div>;
  const titles=[['',''],['Проедь через рёбра','Drive over the ribs'],['Остановись у стойки и загрузи капсулу','Stop at the dock and load a capsule'],['Почувствуй удар','Feel the impact'],['Теперь пройди медленнее','Now take it slowly'],['Доставь уцелевший груз','Deliver the surviving cargo'],['Теперь ты готов к кубку','Ready for the cup']];
  const descriptions=[['',''],[`${keyLabel(preferences.keys.throttle)} — газ, ${keyLabel(preferences.keys.reverse)} — тормоз и задний ход. Проедь до отметки 13 м.`,`${keyLabel(preferences.keys.throttle)} to accelerate, ${keyLabel(preferences.keys.reverse)} to brake and reverse. Reach the 13 m mark.`],[`Подъедь к отметке загрузки и нажми ${keyLabel(preferences.keys.interact)}, когда машина остановится.`,`Approach the loading mark and press ${keyLabel(preferences.keys.interact)} when the car stops.`],['Разгонись через рёбра. За ними машина остановится для разбора удара.','Accelerate over the ribs. The vehicle will stop afterwards to review the impact.'],['Загрузи капсулу. Переедь рёбра медленнее и остановись за отметкой 13,5 м. Сохрани больше целостности.','Load a capsule. Cross the ribs slowly and stop beyond 13.5 m. Keep more integrity.'],['Пройди ворота и остановись в зелёной зоне на полсекунды.','Pass the gate and stop in the green zone for half a second.'],['Груз важнее скорости. Между этапами кубка можно менять только два крепления.','Cargo matters more than speed. Change only two mounts between cup stages.']];
  const goal=tutorialStep===1?lane.car.position.z>=13:tutorialStep===2?lane.cargo.some(c=>c.status==='secured'):tutorialStep===3?lessonStopped&&lessonHold.current===3&&lane.events.some(event=>event.kind==='damaged'):tutorialStep===4?lessonStopped&&lessonHold.current===4&&lane.cargo.some(cargo=>cargo.status==='secured'&&cargo.health>tutorialFastHealth):tutorialStep===5?lane.finished&&!!lane.result?.delivered:tutorialStep===6;
  const retryFast=tutorialStep===3&&lessonStopped&&lessonHold.current===3&&!goal;
  const retryComparison=tutorialStep===4&&lessonStopped&&lessonHold.current===4&&!goal;
  return <Race lane={lane} seatIndex={seatIndex} track={track} locale={locale} preferences={preferences} input={input} seconds={(tutorialStep!==undefined?240:65)-lane.tick/60} onInteract={()=>{physics.current?.interact();setLane(physics.current?.snapshot()??null);}} onRestore={()=>{physics.current?.restore();setLane(physics.current?.snapshot()??null);}} onPause={lessonStopped?undefined:()=>setPaused(value=>!value)} paused={paused||externalPause||lessonStopped} footer={<div className="tb-local-footer"><button onClick={onBack}>‹ {t('В мастерскую','Workshop')}</button><button onClick={()=>setSerial(value=>value+1)}>{t('Начать заново','Restart')} ↻</button>{tutorialStep!==undefined&&<button onClick={onCompleteTutorial}>{t('Пропустить урок','Skip lesson')}</button>}</div>}>
    {tutorialStep!==undefined&&<div className="tb-lesson-card tb-race-lesson" data-attempt-status={retryFast?'retry-fast':retryComparison?'retry-slow':goal?'complete':'running'}><span className="tb-eyebrow">{t('Урок','Lesson')} {Math.min(6,tutorialStep+1)}/6</span><h2>{titles[tutorialStep]?.[locale==='ru'?0:1]}</h2><p>{descriptions[tutorialStep]?.[locale==='ru'?0:1]}</p>{tutorialStep===4&&<p>{t('В первый раз осталось','First run integrity')}: <b>{tutorialFastHealth}</b></p>}{retryFast?<p role="status">{t('В этом проезде груз не получил повреждений. Нажми «Начать заново», загрузи капсулу и удерживай газ до остановки за рёбрами.','This run did not damage the cargo. Press Restart, load a capsule and hold the accelerator until the stop beyond the ribs.')}</p>:retryComparison?<p role="status">{t('Больше целостности сохранить не удалось. Нажми «Начать заново», загрузи капсулу и попробуй короткие нажатия газа с торможением перед рёбрами.','This attempt did not preserve more integrity. Press Restart, load a capsule and try short accelerator presses with braking before the ribs.')}</p>:lessonStopped&&<p role="status">{t('Сравнение зафиксировано. Нажми «Дальше».','Comparison paused. Press Continue.')}</p>}{goal&&<button className="tb-primary" onClick={()=>tutorialStep===6?onCompleteTutorial?.():onNextLesson?.(lane)}>{tutorialStep===6?t('В тренировку','Practice'):t('Получилось. Дальше','Done. Continue')} →</button>}</div>}
    {lane.finished&&tutorialStep===undefined&&<div className="tb-run-result"><span className="tb-stamp">{lane.result?.finished?'✓':'—'}</span><h2>{lane.result?.finished?t('Груз доставлен','Cargo delivered'):t('Заезд не завершён','Trial not finished')}</h2><div><b>{lane.result?.delivered??0}/3</b><span>{t('доставлено','delivered')}</span><b>{lane.result?.integrity??0}</b><span>{t('целостность','integrity')}</span><b>{((lane.result?.elapsedTicks??lane.tick)/60).toFixed(2)}</b><span>{t('секунд','seconds')}</span></div><button className="tb-primary" onClick={onBack}>{t('Улучшить машину','Improve the machine')} →</button></div>}
  </Race>;
}

export function TestBenchMatch({roomId,matchId,request,onExit,onRematch}:{roomId:string;matchId:string;request:Request;onExit:()=>void;onRematch:()=>Promise<void>}) {
  const [preferences,setPreferences]=useBenchPreferences();const locale=preferences.locale;const sound=useBenchAudio(preferences);const [settings,setSettings]=useState(false);const [test,setTest]=useState(false);const [watch,setWatch]=useState<string|null>(null);const [rematching,setRematching]=useState(false);
  const live=useBenchLive(roomId,matchId,request);const now=useClock();const view=live.view;
  live.watch.current=watch;
  useEffect(()=>{sound.current?.resetEvents(matchId);},[matchId,sound]);
  useEffect(()=>{updateSound(sound.current,view?.you.lane,view?.track,live.input.current,view?.phase==='racing',live.connection!=='online');},[sound,view,live.connection,live.input]);
  const t=(ru:string,en:string)=>copy(locale,ru,en);
  const remaining=view?Math.max(0,view.phaseEndsAt-now-live.offset.current):0;
  const act=(payload:Parameters<typeof live.act>[0])=>{void live.act(payload);};
  useEffect(()=>{setTest(false);setWatch(null);},[view?.phaseId]);
  const render=()=>{
    if(!view)return <div className="tb-empty"><span className="tb-loader"/><h1>{t('Открываем мастерскую','Opening the workshop')}</h1>{live.error&&<button onClick={()=>void live.retry()}>{t('Повторить','Retry')}</button>}</div>;
    const lane=view.spectatingId?view.players.find(p=>p.participantId===view.spectatingId)?.lane:view.you.lane;
    if(view.phase==='recovering'&&!lane)return <section className="tb-empty" role="status"><span className="tb-eyebrow">{t('Восстановление кубка','Cup recovery')}</span><h1>{t('Возвращаемся в мастерскую','Returning to the workshop')}</h1><strong className="tb-recovery-seconds">{Math.max(1,Math.ceil(remaining/1000))}</strong><p>{t('Сборка и принятые действия сохранены. Пауза не отнимает время этапа.','Your build and accepted actions are saved. The pause does not use stage time.')}</p></section>;
    if(view.phase==='briefing')return <section className="tb-briefing"><div className="tb-briefing-map"><TrackMap track={view.track} locale={locale}/><span>{view.track.mirrored?t('Зеркальная полоса','Mirrored lane'):t('Обычная полоса','Standard lane')}</span></div><div className="tb-briefing-copy"><span className="tb-eyebrow">{t('Испытание','Trial')} 0{view.stage+1} / 03</span><h1>{view.track.name[locale]}</h1><p>{view.track.description[locale]}</p><div className="tb-cargo-profile"><img src={'/test-bench/icons/'+view.track.cargoKind+'.svg'} alt=""/><div><strong>{CARGO_PROFILES[view.track.cargoKind].name[locale]} × 3</strong><p>{t('Больше груза → выше целостность → лучше время.','More cargo → better integrity → faster time.')}</p></div></div><ul>{view.track.hazards.map((hazard,i)=><li key={i}>{hazard[locale]}</li>)}</ul><p>{t('Остановись на загрузке. Пройди ворота по порядку. Остановись на разгрузке.','Stop to load. Pass the gates in order. Stop in the unloading area.')}</p><button className="tb-primary" disabled={live.busy||view.players.find(p=>p.participantId===view.you.participantId)?.confirmed} onClick={()=>act({type:'confirm',phaseId:view.phaseId})}>{t('К сборке','To the workshop')} → <small>{Math.ceil(remaining/1000)}</small></button><div className="tb-next-trials">{view.tracks.map((track,i)=><span className={i===view.stage?'active':''} key={track.id}>0{i+1} {track.name[locale]}</span>)}</div></div></section>;
    if(view.phase==='building')return test?<><div className="tb-test-deadline" role="status">{t('До фиксации сборки','Build locks in')}: {Math.ceil(remaining/1000)} {t('сек','sec')}</div><LocalDrive seatIndex={view.players.find(p=>p.participantId===view.you.participantId)?.seatIndex??0} blueprint={view.you.build.blueprint} track={{...getTrack('fragile'),length:22,ramp:undefined,ribs:[{z:8,height:.1,smoothSide:-1}],orderedGates:[{id:'workshop-turn',x:1.2,z:13,width:2.1}],unload:{minX:-1.8,maxX:1.8,minZ:17,maxZ:20},restorePads:[{x:0,z:0,yaw:0},{x:1.2,z:14,yaw:0}]}} preferences={preferences} audio={sound.current} externalPause={settings} onBack={()=>setTest(false)} workshop/></>:<Builder seatIndex={view.players.find(p=>p.participantId===view.you.participantId)?.seatIndex??0} blueprint={view.you.build.blueprint} previous={view.you.build.previous} locale={locale} preferences={preferences} locked={view.you.build.ready} ready={view.you.build.ready} busy={live.busy||!!live.pending} deadline={remaining} onChange={blueprint=>act({type:'blueprint',phaseId:view.phaseId,blueprint,buildRevision:view.you.build.revision})} onTest={()=>setTest(true)} onReady={()=>act({type:'ready',phaseId:view.phaseId,ready:true})} onUnready={()=>act({type:'ready',phaseId:view.phaseId,ready:false})} lesson={<div className="tb-build-players">{view.players.map(player=><span key={player.participantId} className={player.ready?'ready':''}>{player.controller.kind==='bot'?t('Бот · ','Bot · '):''}{player.displayName} <b>{player.ready?'✓':'…'}</b></span>)}</div>}/>;
    if(view.phase==='debrief'||view.phase==='finished')return <CupResults view={view} locale={locale} busy={live.busy||rematching||view.phase!=='finished'&&!!view.players.find(p=>p.participantId===view.you.participantId)?.confirmed} onContinue={()=>act({type:'confirm',phaseId:view.phaseId})} onRematch={()=>{setRematching(true);void onRematch().catch(()=>live.setError('NETWORK')).finally(()=>setRematching(false));}}/>;
    if(!lane)return <div className="tb-empty"><span className="tb-loader"/>{t('Выставляем машины на старт…','Lining up the vehicles…')}</div>;
    return <Race lane={lane} seatIndex={view.players.find(p=>p.participantId===(view.spectatingId??view.you.participantId))?.seatIndex??0} track={view.track} locale={locale} preferences={preferences} input={live.input} seconds={view.phase==='racing'?remaining/1000:65} active={view.phase==='racing'&&live.connection==='online'&&!settings} spectator={!!watch} onInteract={()=>act({type:'interact',phaseId:view.phaseId})} onRestore={()=>act({type:'restore',phaseId:view.phaseId})}>
      {(view.phase==='countdown'||view.phase==='recovering')&&<div className="tb-countdown"><span>{view.phase==='recovering'?t('Возвращаемся на трассу','Returning to the track'):t('На старт','Get ready')}</span><strong>{Math.max(1,Math.ceil(remaining/1000))}</strong><p>{view.phase==='recovering'?t('Пауза не отнимает время заезда.','The pause does not use trial time.'):t('Сначала загрузка. Потом ворота.','Load first. Then the gates.')}</p></div>}
      {view.you.lane?.finished&&view.phase==='racing'&&<div className="tb-spectator"><strong>{view.you.lane.result?.finished?t('Твой груз принят','Your cargo is in'):t('Твой заезд завершён','Your trial is over')}</strong><span>{t('Посмотри, как едут остальные','Watch the other drivers')}</span><select aria-label={t('Наблюдать за участником','Watch a driver')} value={watch??view.you.participantId} onChange={e=>setWatch(e.target.value===view.you.participantId?null:e.target.value)}>{view.players.map(p=><option key={p.participantId} value={p.participantId}>{p.controller.kind==='bot'?t('Бот · ','Bot · '):''}{p.displayName}</option>)}</select></div>}
    </Race>;
  };
  return <main className={'tb-app tb-online '+(preferences.reducedMotion?'tb-reduced':'')} style={rootStyle(preferences)} lang={locale}>
    <BenchHeader locale={locale} onExit={onExit} onSettings={()=>setSettings(true)} status={live.connection==='online'?t('В комнате','Connected'):live.connection==='superseded'?t('Другое окно','Another window'):t('Подключение…','Connecting…')}><div className="tb-stage-indicator">{view?.tracks.map((track,i)=><span key={track.id} className={view.stage===i?'active':view.stage>i?'done':''}>0{i+1}<small>{track.name[locale]}</small></span>)}</div></BenchHeader>
    {(live.error||live.pending||live.connection==='superseded')&&<div className="tb-connection-banner" role="alert"><span>{errorText(live.connection==='superseded'?'CONTROL_SUPERSEDED':live.error||'NETWORK',locale)}</span>{live.connection==='superseded'?<button onClick={()=>location.reload()}>{t('Продолжить здесь','Continue here')}</button>:<button disabled={live.busy} onClick={()=>void live.retry()}>{t('Повторить','Retry')}</button>}</div>}
    {render()}
    {settings&&<BenchSettings preferences={preferences} onChange={setPreferences} onClose={()=>setSettings(false)}/>}
  </main>;
}
export type { BenchView, Locale };

export { BenchHeader, TrackCards, copy } from './components';
export { BenchSettings, useBenchPreferences } from './preferences';
