import { distance, length, localPoint } from '../core/math';
import type { TutorialView } from '../core/types';
import type { TyagaWorld } from '../server-world/world';
import type { LinkRecord } from '../server-world/state';
const LESSONS:Omit<TutorialView,'step'|'total'|'completed'>[]=[
  {title:{ru:'Сначала — своими ногами',en:'Start on your own two feet'},instruction:{ru:'Пройдите несколько шагов и прыгните. На клавиатуре — WASD и пробел.',en:'Walk a few steps and jump. Use WASD and Space on a keyboard.'}},
  {title:{ru:'Почувствуйте вес',en:'Feel the weight'},instruction:{ru:'Возьмите лёгкую балку за ручку. Поднимите её клавишей X или экранной стрелкой ↑, затем перенесите на метр. Z или ↓ опускают груз.',en:'Grab the light beam by its handle. Raise it with X or the on-screen ↑ button, then carry it one metre. Z or ↓ lowers the load.'},targetId:'training-light'},
  {title:{ru:'Вдвоём легче',en:'Two pairs of hands'},instruction:{ru:'Возьмите тяжёлый настил и попросите бота «Помоги нести». Дождитесь второго захвата, поднимите настил клавишей X или экранной стрелкой ↑ и пройдите вместе. Z или ↓ опускают груз.',en:'Grab the heavy deck and ask your bot to help carry. Wait for the second grip, raise the deck with X or the on-screen ↑ button, then walk together. Z or ↓ lowers the load.'},targetId:'training-heavy'},
  {title:{ru:'Два ремня',en:'Two straps'},instruction:{ru:'Снимите и снова закрепите два ремня на малом грузе. Выберите две проушины.',en:'Remove and reattach two straps on a small cargo. Select two attachment rings.'},targetId:'cargo-2'},
  {title:{ru:'В горку',en:'Up the slope'},instruction:{ru:'Сядьте за руль и поднимитесь на учебный склон. Затем остановитесь.',en:'Enter the cab and drive up the training slope, then stop.'},targetId:'truck'},
  {title:{ru:'Тянем с опоры',en:'Pull from a secure anchor'},instruction:{ru:'Установите якорь в грунт и закрепите на нём основание лебёдки ремнём. Разверните барабан к грузу, подсоедините трос и потяните. Отпустите тягу или управление, сохранив крепление.',en:'Install a ground anchor and strap the portable winch base to it. Face the drum toward the load, connect the cable and pull. Release the pull input or controls while the base stays secure.'},targetId:'training-anchor'},
  {title:{ru:'Настил на опорах',en:'A supported deck'},instruction:{ru:'Подведите раскрытый настил к двум опорам и закрепите его проушины.',en:'Bring an unfolded deck onto the two supports and fasten its rings.'},targetId:'training-heavy'},
  {title:{ru:'Стоянка и возврат',en:'Save camp and return'},instruction:{ru:'Соберите машину, грузы и команду в учебной стоянке. Сохраните её и предложите возврат.',en:'Gather the truck, cargo and crew in the training camp. Save it, then request a return.'}},
];
export function tutorialView(w:TyagaWorld):TutorialView{const t=w.state.tutorial;return{step:t.step,total:8,completed:t.completed,...(LESSONS[t.step]??{title:{ru:'Можно в экспедицию',en:'Ready for an expedition'},instruction:{ru:'Выберите любую карту. Помощник отправится вместе с вами.',en:'Choose any map. Your helper will join you.'}})};}

function securedPortableRope(w:TyagaWorld,rope:LinkRecord):boolean{
  if(rope.kind!=='rope'||rope.broken||rope.detached||w.state.entities[rope.fromId]?.kind!=='winch')return false;
  const target=w.state.entities[rope.toId];if(!target?.active||target.fixed||['character','hook','rope-segment','winch'].includes(target.kind))return false;
  return Object.values(w.state.links).some(base=>{
    if(base.kind!=='strap'||base.broken||base.overload>0)return false;
    const anchorId=base.fromId===rope.fromId&&base.fromSocket==='base'?base.toId:base.toId===rope.fromId&&base.toSocket==='base'?base.fromId:null;
    const anchor=anchorId?w.state.entities[anchorId]:null;
    return Boolean(anchor?.active&&anchor.kind==='anchor'&&anchor.anchored);
  });
}

/** Only the explicit player action calls this. Rescue, control-distance loss,
 * disconnect and takeover call releaseCharacter directly and cannot mark a stop. */
export function rememberTutorialWinchRelease(w:TyagaWorld,participantId:string):void{
  const t=w.state.tutorial,c=w.state.characters[participantId],rope=c?.controlling?w.state.links[c.controlling]:undefined;
  if(w.map.id!=='tutorial'||t.step!==5||!c||c.controller.kind!=='human'||!c.controller.connected||!rope||!securedPortableRope(w,rope))return;
  const key=`winch:${rope.id}:${participantId}`;
  if(t.flags[`${key}:pulled`]&&t.flags[`${key}:generation`]===c.controller.controllerGeneration)t.flags[`${key}:released`]=1;
}

function winchLessonComplete(w:TyagaWorld):boolean{
  const flags=w.state.tutorial.flags;
  for(const rope of Object.values(w.state.links)){
    if(rope.kind!=='rope')continue;
    for(const c of Object.values(w.state.characters)){
      const key=`winch:${rope.id}:${c.participant.participantId}`;
      if(!securedPortableRope(w,rope)||c.rescueAt!==null||c.controller.kind!=='human'||!c.controller.connected||flags[`${key}:generation`]!==undefined&&flags[`${key}:generation`]!==c.controller.controllerGeneration){
        for(const suffix of ['length','pulled','stopped','released','generation'])delete flags[`${key}:${suffix}`];continue;
      }
      if(flags[`${key}:released`]){flags[`${key}:stopped`]=(flags[`${key}:stopped`]??0)+1;if(flags[`${key}:stopped`]>=30)return true;continue;}
      if(c.controlling!==rope.id){delete flags[`${key}:pulled`];delete flags[`${key}:length`];delete flags[`${key}:stopped`];continue;}
      flags[`${key}:generation`]=c.controller.controllerGeneration;
      flags[`${key}:length`]??=rope.length;
      const input=w.inputs[c.participant.participantId];
      if((input?.tool??0)>.05){
        flags[`${key}:stopped`]=0;
        if(flags[`${key}:length`]-rope.length>.3&&rope.tension>25)flags[`${key}:pulled`]=1;
      }else if(input?.tool===0&&flags[`${key}:pulled`]){
        flags[`${key}:stopped`]=(flags[`${key}:stopped`]??0)+1;if(flags[`${key}:stopped`]>=30)return true;
      }else flags[`${key}:stopped`]=0;
    }
  }
  return false;
}

function deckSupportedAtBothEnds(w:TyagaWorld,id:string):boolean{
  const e=w.state.entities[id],body=w.maybeBody(id);if(!e?.active||!body||e.folded)return false;
  let left=false,right=false;
  for(const handle of e.colliders){const collider=w.physics.getCollider(handle);
    w.physics.contactPairsWith(collider,other=>{
      if(w.state.entities[w.state.colliderBodies[other.handle]]?.kind==='character')return;
      w.physics.contactPair(collider,other,(manifold,flipped)=>{
        if(manifold.normal().y*(flipped?1:-1)<.5)return;
        for(let i=0;i<manifold.numSolverContacts();i++){
          const point=manifold.solverContactPoint(i);if(!point||manifold.solverContactDist(i)>.035)continue;
          const local=localPoint(body.translation(),body.rotation(),point);if(local.y>.1)continue;
          if(local.x<-1.2)left=true;if(local.x>1.2)right=true;
        }
      });
    });
  }
  return left&&right;
}
export function advanceTutorial(w:TyagaWorld):void{
  if(w.map.id!=='tutorial'||w.state.tutorial.completed)return;const t=w.state.tutorial;const human=Object.values(w.state.characters).find(c=>!c.participant.bot);if(!human)return;
  const actor=w.body(human.bodyId);const events=w.state.events.filter(e=>e.tick>=t.stepStartedAt);
  let complete=false;
  if(t.step===0)complete=human.grounded&&distance(actor.translation(),t.stepStartPosition)>=2&&events.some(e=>e.type==='jump'&&e.participantId===human.participant.participantId);
  else if(t.step===1){const item=w.maybeBody('training-light');if(item&&human.holding?.itemId==='training-light'){if(t.flags['light-x']===undefined){t.flags['light-x']=item.translation().x;t.flags['light-z']=item.translation().z;}complete=Math.hypot(item.translation().x-t.flags['light-x'],item.translation().z-t.flags['light-z'])>=1;}}
  else if(t.step===2){const holders=Object.values(w.state.characters).filter(c=>c.holding?.itemId==='training-heavy');const deck=w.maybeBody('training-heavy');if(holders.length>=2&&deck){if(t.flags['heavy-x']===undefined){t.flags['heavy-x']=deck.translation().x;t.flags['heavy-z']=deck.translation().z;}if(holders.some(c=>c.controller.kind==='human'&&Math.hypot(w.inputs[c.participant.participantId]?.moveX??0,w.inputs[c.participant.participantId]?.moveZ??0)>.2))t.flags['heavy-walking']=1;complete=Boolean(t.flags['heavy-walking'])&&Math.hypot(deck.translation().x-t.flags['heavy-x'],deck.translation().z-t.flags['heavy-z'])>.6;}}
  else if(t.step===3)complete=Object.values(w.state.links).filter(l=>!l.broken&&l.kind==='strap'&&l.itemId&&t.flags[`secured:${l.itemId}`]&&((l.fromId==='cargo-2'&&l.toId==='truck')||(l.toId==='cargo-2'&&l.fromId==='truck'))).length>=2;
  else if(t.step===4){
    const truck=w.body('truck');t.flags['climb-start-y']??=truck.translation().y;
    if(human.controlling==='truck'&&human.controller.kind==='human'&&(w.inputs[human.participant.participantId]?.throttle??0)>.05)t.flags['climb-driven']=1;
    complete=Boolean(t.flags['climb-driven'])&&truck.translation().y>2&&truck.translation().y-t.flags['climb-start-y']>.8&&length(truck.linvel())<.4&&length(truck.angvel())<.2;
  }
  else if(t.step===5)complete=winchLessonComplete(w);
  else if(t.step===6){
    const links=Object.values(w.state.links).filter(l=>l.kind==='deck'&&!l.broken&&l.fromId==='training-heavy'&&w.state.entities[l.toId]?.customModel==='bridge-mount');
    const ends=new Set(links.map(l=>Math.sign(w.socket(l.fromId,l.fromSocket)?.local.x??0)));
    complete=ends.has(-1)&&ends.has(1)&&deckSupportedAtBothEnds(w,'training-heavy');
  }
  else if(t.step===7)complete=t.checkpointDone&&w.state.rewinds>0;
  if(complete){t.step++;t.stepStartedAt=w.state.tick;t.stepStartPosition={...actor.translation()};t.flags={};t.completed=t.step>=8;if(!t.completed){w.state.checkpointId=`tutorial-lesson-${t.step}`;w.state.pendingCheckpointId=w.state.checkpointId;}w.emit(t.completed?'tutorial-complete':'tutorial-step',undefined,human.participant.participantId,t.step);}
}
