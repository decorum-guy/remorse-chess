import { connectSeat, createMatch, viewForSeat } from '../core/index';
import { pilotWaypoint } from '../bots/index';
import type { Difficulty, QueuedCommand, Role, Seat, ShiftState } from '../core/types';
import type { Language } from './copy';
import { text } from './copy';
export interface Lesson { role: Role; step: number; startedTick: number; stepTick: number; shifted: boolean; selected: boolean; rejected: boolean; }
export function practiceRoster(role: Role, teamSize: 2 | 3, difficulty: Difficulty = 'normal'): Seat[] {
  return (['teal', 'amber'] as const).flatMap(team => Array.from({ length: teamSize }, (_, i): Seat => ({
    seatId: team === 'teal' && i === 0 ? 'self' : `${team}-${i}`, displayName: team === 'teal' && i === 0 ? 'Вы / You' : `${team === 'teal' ? 'T' : 'A'}-${i + 1}`,
    team, teamIndex: i, initialRole: i === (team === 'teal' && role === 'pilot' ? 1 : 0) ? 'navigator' : 'pilot', bot: !(team === 'teal' && i === 0), difficulty,
  })));
}
export function createLesson(role: Role): { state: ShiftState; lesson: Lesson } {
  const state = createMatch({ arena: 'foundry', teamSize: 2, rotateRoles: false, difficulty: 'easy' }, practiceRoster(role, 2), 14);
  // Lessons use the production core with explicit, isolated teaching positions.
  state.phase = 'active'; state.phaseEndsAtTick = 54_000; state.roundStartedAtTick = 0;
  for (const seat of state.seats) { seat.bot = false; connectSeat(state, seat.seatId); }
  if (role === 'pilot') {
    Object.assign(state.actors.self, { spaceId: 'A', x: 2.8, z: 0, shieldUntilTick: 0 });
    Object.assign(state.actors['amber-1'], { spaceId: 'O', x: 0, z: 2.5, shieldUntilTick: 0 });
  } else {
    Object.assign(state.actors['teal-1'], { spaceId: 'O', x: 0, z: 0, shieldUntilTick: 0 });
    Object.assign(state.actors['amber-1'], { spaceId: 'east', x: 0, z: 0 });
  }
  return { state, lesson: { role, step: 0, startedTick: 0, stepTick: 0, shifted: false, selected: false, rejected: false } };
}
export function lessonCommands(state: ShiftState, lesson: Lesson): QueuedCommand[] {
  const commands: QueuedCommand[] = [];
  if (lesson.role === 'pilot' && lesson.step === 3 && !lesson.shifted && state.tick - lesson.stepTick >= 20) {
    const navigator = state.actors['teal-1'];
    commands.push({ seatId: navigator.seatId, command: { type: 'shift', actionId: 'lesson-ride', roomId: 'O', expectedBoardRevision: state.boardRevision, controllerEpoch: navigator.controllerEpoch, roundId: state.round } });
    lesson.shifted = true;
  }
  if (lesson.role === 'navigator' && lesson.step === 2 && !state.motion) {
    const pilot = state.actors['teal-1'];
    // Follow the shared cover geometry to the west exit with ordinary pilot input.
    const waypoint = pilotWaypoint(viewForSeat(state, pilot.seatId), pilot, { spaceId: 'F', x: 0, z: 0 });
    const dx = waypoint.x - pilot.x, dz = waypoint.z - pilot.z, length = Math.hypot(dx, dz);
    commands.push({ seatId: pilot.seatId, command: { type: 'input', seq: pilot.lastAcceptedSeq + 1, controllerEpoch: pilot.controllerEpoch, roundId: state.round, moveX: length > 0.05 ? dx / length : 0, moveZ: length > 0.05 ? dz / length : 0, aim: Math.atan2(dz, dx), fireHeld: false } });
  }
  return commands;
}
export function advanceLesson(state: ShiftState, lesson: Lesson): void {
  const actor = state.actors.self;
  let next = false;
  if (lesson.role === 'pilot') {
    if (lesson.step === 0 && actor.spaceId === 'O') next = true;
    if (lesson.step === 1 && state.stats.self.hits >= 3) next = true;
    if (lesson.step === 2 && state.battery.carrierId === 'self') next = true;
    if (lesson.step === 3 && lesson.shifted && !state.motion && state.board[7] === 'O') next = true;
    if (lesson.step === 4 && state.stats.self.deliveries > 0) next = true;
  } else {
    if (lesson.step === 0 && lesson.selected) next = true;
    if (lesson.step === 1 && state.stats.self.shifts >= 1 && !state.motion) next = true;
    if (lesson.step === 2 && state.actors['teal-1'].spaceId !== 'O') next = true;
    if (lesson.step === 3 && state.stats.self.shifts >= 2 && !state.motion) next = true;
    if (lesson.step === 4 && lesson.rejected) next = true;
  }
  if (next) {
    lesson.step++; lesson.stepTick = state.tick;
    // Keep the target safely down after the shooting exercise. It is a lesson target.
    if (lesson.role === 'pilot' && lesson.step === 2) state.actors['amber-1'].respawnAtTick = 54_000;
  }
}
export function lessonCopy(lang: Language, lesson: Lesson): { title: string; body: string } {
  const pilot = [
    ['Пройдите в комнату O', 'Enter room O', 'Идите направо через светлый проём. WASD или стрелки двигают дрон.', 'Move right through the lit doorway. Use WASD or the arrow keys.'],
    ['Попадите по мишени', 'Hit the target', 'Наведите прицел на янтарный дрон в комнате O и удерживайте выстрел. Три попадания выбивают дрон.', 'Aim at the amber drone in room O and hold fire. Three hits disable a drone.'],
    ['Заберите батарею', 'Pick up the battery', 'Подойдите к светлой батарее в центре O и нажмите E или кнопку действия.', 'Approach the ivory battery in the centre of O and press E or the action button.'],
    ['Поезжайте вместе с комнатой', 'Ride with the room', 'Штурман перевозит комнату O. Двери закрыты, но внутри можно двигаться и стрелять.', 'Your navigator is moving room O. Doors seal, but you can still move and fire inside.'],
    ['Зарядите свои ворота', 'Charge your gate', 'Через западную дверь O выйдите в F, затем в западный шлюз. Обойдите тумбы и удержитесь на бирюзовой площадке.', 'Leave O through its west door into F, then the west airlock. Go around the covers and hold on the teal pad.'],
    ['Вы готовы к вылету', 'Ready to fly', 'Вы прошли дверь, стреляли, взяли батарею, проехали с комнатой и выполнили доставку.', 'You crossed a door, fired, picked up the battery, rode a room and made a delivery.'],
  ];
  const navigator = [
    ['Выберите комнату O', 'Select room O', 'Нажмите O на плане. Стрелка покажет переезд, метки дверей — новые стыки.', 'Select O on the plan. The arrow previews its move; door marks preview the new connections.'],
    ['Перевезите пилота', 'Carry your pilot', 'В комнате O находится ваш пилот. Нажмите «Сдвинуть» или Enter.', 'Your pilot is inside O. Press Shift room or Enter.'],
    ['Дайте пилоту выйти', 'Let the pilot leave', 'Дождитесь, пока пилот выйдет из O через открывшуюся западную дверь.', 'Wait for the pilot to leave O through the new west door.'],
    ['Откройте второй маршрут', 'Open a second route', 'Выберите соседнюю с шахтой комнату и сдвиньте её. Следите за готовностью привода.', 'Choose a room beside the shaft and shift it. Watch the drive recharge.'],
    ['Проверьте недоступный ход', 'Inspect an unavailable move', 'Дождитесь готовности привода и нажмите комнату, которая не касается шахты. Панель объяснит, почему сдвиг невозможен.', 'Wait for the drive to recharge, then select a room that does not border the shaft. The panel explains why it cannot move.'],
    ['Этаж под вашим управлением', 'The floor is yours', 'Вы перевезли пилота, открыли путь и проверили ограничение хода. Помечайте комнаты для команды.', 'You carried a pilot, opened a route and checked a move restriction. Mark rooms for your team.'],
  ];
  const row = (lesson.role === 'pilot' ? pilot : navigator)[Math.min(5, lesson.step)];
  return { title: text(lang, row[0], row[1]), body: text(lang, row[2], row[3]) };
}
export const lessonView = (state: ShiftState) => viewForSeat(state, 'self');
