import { BUILDINGS, RULES, TICK_RATE } from '../core/constants'
import type { TutorialProgress } from '../core/types'
import type { Language } from './copy'
import { text } from './copy'

const steps: [string, string][][] = [
  [
    ['Подойдите к первой светлой отметке. Движение — WASD или левый стик.', 'Walk to the first bright marker. Move with WASD or the left stick.'],
    ['Теперь подойдите ко второй отметке ниже. Боец не движется быстрее по диагонали.', 'Now walk to the second marker below. Diagonal movement does not increase speed.'],
    ['Наведитесь на учебного противника справа и выстрелите. Мышь или правый стик задают направление.', 'Aim at the training opponent on the right and fire. Aim with the mouse or right stick.'],
    ['Нажмите R или кнопку патронов и дождитесь полной перезарядки.', 'Press R or the ammo button and wait until reloading finishes.'],
  ],
  [
    ['Выстрелите вправо в отмеченную стену. Она остановит пулю; противник за ней не будет поражён.', 'Fire right into the marked wall. It stops the bullet and protects the opponent behind it.'],
    ['Обойдите стену сверху и подойдите к светлой отметке. Сквозь стену пройти нельзя.', 'Go around the top of the wall to the bright marker. You cannot walk through walls.'],
    ['Примените барьер: Space или кнопка инструмента. Он остановит выстрелы, но пропустит бойцов.', 'Use your barrier: Space or the tool button. It blocks bullets and lets units pass.'],
  ],
  [
    ['Подойдите к отмеченному транспорту и идите рядом с ним. В пределах 4 м ваш боец ускоряет машину.', 'Walk to the marked transport and stay alongside it. Your fighter speeds it up within 4 m.'],
    ['Сопроводите машину к комплексу. Подойдите в круг: учебный противник пока блокирует разгрузку.', 'Escort the vehicle to the complex. Enter the circle: the training opponent is blocking unloading.'],
    ['Устраните учебного противника в круге комплекса. Его присутствие сбрасывает разгрузку.', 'Eliminate the training opponent in the complex circle. Its presence resets unloading.'],
    ['Оставайтесь в круге до доставки. Публичная отметка машины не раскрывает скрытое сопровождение.', 'Stay in the circle until delivery. A vehicle’s public radar marker does not expose hidden escorts.'],
  ],
  [
    [`Откройте тактику. Закажите ретранслятор на L-03 и экстрактор на L-01. Цена: ${BUILDINGS.relay.cost + BUILDINGS.extractor.cost} ¤.`, `Open tactics. Order a relay on L-03 and an extractor on L-01. Cost: ${BUILDINGS.relay.cost + BUILDINGS.extractor.cost} ¤.`],
    ['Дождитесь строителя: он должен дойти и завершить оба заказа. В очереди можно менять порядок.', 'Wait for your builder to reach and finish both orders. You can change their queue order.'],
    ['Экстрактор включён. Наблюдайте за личными кредитами: к базовому доходу добавился доход модуля.', 'The extractor is powered. Watch your credits: its income now adds to your base income.'],
  ],
  [
    ['В приоритете питания поднимите батарею выше других потребителей, чтобы она включилась.', 'Move the battery ahead of other consumers in power priority to turn it on.'],
    ['Продайте экстрактор на L-04, чтобы освободить лимит построек. Подтвердите показанный возврат.', 'Sell the extractor on L-04 to free a building slot. Confirm the displayed refund.'],
    [`Постройте генератор на L-04. Цена: ${BUILDINGS.generator.cost} ¤. Дождитесь включения всех модулей.`, `Build a generator on L-04. Cost: ${BUILDINGS.generator.cost} ¤. Wait for all modules to become powered.`],
  ],
  [
    [`Выберите док на L-03 и закажите боевой дрон за ${RULES.droneCost} ¤.`, `Select the dock on L-03 and order a combat drone for ${RULES.droneCost} ¤.`],
    [`Дождитесь производства дрона: ${RULES.droneWorkTicks / TICK_RATE} секунд работающего дока.`, `Wait for the drone: production takes ${RULES.droneWorkTicks / TICK_RATE} seconds at a powered dock.`],
    ['Перейдите в тактику кнопкой внизу или Tab.', 'Enter tactics using the bottom button or Tab.'],
    ['Выберите свой дрон и прикажите «Сопровождать». Дождитесь, пока он приблизится к транспорту.', 'Select your drone and choose “Escort”. Wait for it to reach your transport.'],
    ['Вернитесь к бойцу. Дрон сохранит приказ сопровождения.', 'Switch back to your fighter. The drone will keep escorting.'],
  ],
  [[
    'Завершите учебную операцию: доставьте близкую к комплексу машину и удерживайте круг. Правила доставки и боя обычные.',
    'Finish the training operation: deliver the vehicle near the complex and hold the circle. Normal delivery and combat rules apply.',
  ]],
]
export function tutorialInstruction(progress: TutorialProgress, lang: Language): string {
  if (progress.completed) return text(lang, 'Задача выполнена игровыми действиями. Можно перейти дальше или повторить урок.', 'Objective completed through your actions. Continue to the next lesson or repeat this one.')
  return text(lang, ...(steps[progress.lesson]?.[progress.stage] ?? steps[progress.lesson]?.[0] ?? ['', '']))
}
