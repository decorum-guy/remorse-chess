# Совместимость с draft PR №42

Непосредственно проверены metadata PR и полный код общего gateway на вершине [`6a9337df076c9542c8c8a705bb0accc331cea304`](https://github.com/decorum-guy/iva-games/pull/42). На проверенной странице PR имеет состояние **open, draft, merged=false**, основание `357f60049e83b298bb5bbc2f760654fbd02384e3`. В его описании отдельно указано ожидание интеграции Test Bench координатором; промежуточный foundation не поручено выпускать независимо. Это наблюдение текущей проверки, а не обещание, что PR останется открытым.

Прочитаны все изменённые контракты и integration hunks: `packages/session-kit/REALTIME.md`, `packages/session-kit/src/realtime.ts`, `apps/platform/src/realtime.ts`, изменения HTTP/service и exports. Тестовые файлы перечислены в diff; заявленные в PR 102 теста являются отчётом его автора, а не новым самостоятельным прогоном в ветке Форпоста.

## Разница контрактов

| Область | PR №42, iva-live@1 | Форпост, обязательный REALTIME_PLATFORM |
|---|---|---|
| Вход | Cookie session на `/api/platform/v1/rooms/:id/live` | Platform membership выдаёт одноразовый Ed25519 ticket; `/ws/realtime/v1` обслуживает отдельный runtime |
| Управление | Новое соединение автоматически вытесняет прежнее, случайный string epoch | Повторный сокет сначала view-only, явный CAS `claimControl`, отдельные game epoch и controllerGeneration |
| Снимки | Персональный полный `snapshot`, около 15 Hz | Персональный full/delta, ACK baseline, обязательный full каждые две секунды, 15 Hz |
| Действия | Existing durable `runtime.applyAction`, действие `command` | Tick-bound action, атомарные journal/state/receipt, повтор по actionId, сообщение `actionAck` |
| Симуляция и данные | Контракт явно оставляет game-owned clocks, physics, persistence и recovery | Выделенные simulation workers, fenced SQLite writer, pause/resume, result outbox, retained code/client artifacts |
| Гости | Требуется platform session с аккаунтом | Отдельное cookie-owned обучение без сайта-аккаунта; нормальная сетевая комната требует аккаунт |

Форпост уже использует общие аккаунты, участников, комнаты, readiness и `GameRuntime` из session-kit. Замена его wire protocol на iva-live@1 удалит обязательную семантику билетов, наблюдающего второго окна и подтверждённых delta. Поэтому draft gateway не был выдан за готовую реализацию полного контракта Форпоста и не был молча принят вместо неё.

## Как сохранить обе реализации при принятии PR №42

Пути и optional interfaces не конфликтуют. После появления принятого слоя выполняется обычный merge свежего main с сохранением обеих сторон:

- В `apps/platform/src/http.ts` сохраняются `attachPlatformRealtime`, его upgrade handler и обёртка shutdown из №42, а также маршруты `forpost-setup` и `realtime-ticket` этой ветки. Gateway №42 остаётся единственным обработчиком upgrade в platform; собственный WebSocket Форпоста живёт на другом HTTP server/process.
- В `apps/platform/src/service.ts` сохраняются `getSession(token, touch)`, `realtimeAccess` и импорты №42 вместе с setup, ticket admission, проверкой sessionHash и долговечными result receipts Форпоста. Они используют одни platform identities и memberships.
- В session-kit сохраняются exports, `RealtimeGameRuntime`, `LiveRateWindow` и валидатор №42, а optional `validateStart`, `issueRealtimeTicket` и `acknowledgeResult` добавляются к прежнему контракту. Existing HTTP runtimes продолжают работать.
- В package manifests, lockfile и image-input closure учитывается реальная `ws` dependency platform из принятого №42. Она не удаляется из-за отдельного realtime image. Все тесты обеих веток выполняются совместно.
- Forpost platform adapter намеренно не объявляет `liveConnect/liveInput/liveSnapshot/liveDisconnect`. Generic gateway вернёт `LIVE_UNAVAILABLE` для такого runtime; это предотвращает создание второго пути управления той же партией. Portal открывает выданный Forpost admission route.
- Каталожные записи и адаптеры Test Bench, Тяги и других игр сохраняются. В этой ветке нет переименования их протокола или замены общего файла через ours/theirs.

До принятия №42 не выполняется merge чужого draft только ради отметки «общий слой использован». Перед реальной интеграцией и выпуском снова проверяются свежий main, статус и вершина PR. Если layer уже принят, описанные совместимые изменения интегрируются с его актуальным кодом, а не с сохранённой копией этого анализа.
