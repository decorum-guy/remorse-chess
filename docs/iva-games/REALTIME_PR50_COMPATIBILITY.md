# Realtime: совместимость draft PR50 и Forpost

## Статус и источники — 28 ноября 2026

Основной исполнитель проверил через GitHub metadata: [PR50](https://github.com/decorum-guy/iva-games/pull/50) — **draft, не принят и не опубликован**. Совпадение имени протокола не является подтверждением совместимости. `games/tyaga/STATUS.md` в проверенной вершине сообщает о трёх браузерных раундах, нуле полных доставок и незавершённой R04; это отчёт исполнителя Tyaga, а не независимое прохождение в данном аудите.

Аудит выполнен чтением `git show`/`git diff`, без переключения ветки, изменения production-кода, запуска тестов или браузера.

Повторная проверка перед R4: PR50 остаётся draft, новая вершина `b7ab9ed4265b819299d082e21a6a3957ba1d07de`, tree `14c2e7b9b4992c096fd5d6530aec683294ec8b08`, получена в отдельный ref `refs/remotes/qa/pr50-audit-b7ab9ed`. Единственный новый commit меняет девять CI/fixture/dev-browser scripts. Сравнение `apps/realtime-server/src`, `packages/realtime-kit/src`, `packages/session-kit`, `apps/platform/src` и `packages/game-registry` с указанным ниже `6ab92545` дало нулевую дельту. Выводы о wire/crypto/storage/runtime/catalog остаются применимы; старые результаты исполнения не объявляются результатами новой вершины. Изменённый `deploy/iva-games/verify-realtime-image.sh` требует отдельного согласования с нашей retention-проверкой при будущем объединении. Непринятый PR53 `a148aff7aaccef9820504755e24d849c35980484` содержит только предложенные документы полного цикла; он не включён в ветку и не создаёт новых доступов.

| Источник | Commit | Tree |
|---|---|---|
| PR50 / `refs/remotes/origin/qa-pr50-head` | `6ab9254523c7359bbd174f0304be19d0f68bf40b` | `209a8db27a9df66a7a1c4c832841ffa866947d48` |
| Forpost HEAD | `e88be1a203142a40801195cbfad1eafe8ea47574` | `f3ff57573fb9ce7f3399e6cc0312aee56160943e` |

Дополнительно прочитаны текущие рабочие версии Forpost, ещё не составляющие новую опубликованную ревизию. Git blob identities на момент чтения: `apps/realtime-server/src/store.ts` — `a80d83d8d33214b684268e90294b1f535e8d22f7`; `artifacts.ts` — `ff4d1a5e97134633bd8b717b421d3faa3836c228`; `content.ts` — `323b720897b703ae03b0882494e4797beb38a227`; `runtime.ts` — `31b69091e9a601622ce36aa987e4574c8df8a291`. Их изменения не устраняют следующие различия контрактов.

## Подтверждённые границы

Обновление после повторного аудита: PR53 затем принят в main `7c2be21db5743b15b4a42d708ac959039c6b725e` и включён обычным merge. Его документация теперь действует; production-контракты PR50 от этого не изменились.

| Область | PR50 | Forpost и следствие |
|---|---|---|
| Wire | JSON `protocolVersion: 'iva-realtime@1'`; claim требует `expectedGeneration`, heartbeat — `nonce`; delta содержит `changes[]` с путями; `hasControl`. | JSON `protocolVersion: 1`; claim/heartbeat без этих дополнительных полей; delta содержит верхнеуровневый `patch`; `controlling`. Одинаковые `/ws/realtime/v1` и subprotocol `iva-realtime-v1` не делают клиентов взаимозаменяемыми. |
| Ticket и service bridge | Подписываемый ticket-префикс `iva-ticket-v1\n`; claims `sessionId`, permission `play`, issuer платформы. Bridge передаёт подписанный envelope. | Префикс `iva-ticket-v1.`; claims `admissionId`, permission `control`, включая гостевую practice. Bridge использует подпись тела и отдельные headers. Односторонняя замена ломает проверку подписи и admission. |
| Platform API | `realtimeTicket`, `syncAdmissions`, `confirmResult`; маршруты `participant`, `ack-result`, GET status. | `issueRealtimeTicket`, `acknowledgeResult`, `validateStart`; `view`, `admission`, `result-ack`, POST status. В PR50 отсутствует Forpost hook проверки равных команд `validateStart`; его требуется сохранить. |
| SQLite | `rt_matches`: `id/start/meta/fence`; `rt_admissions` хранит очередь запуска; отдельные `rt_snapshots` и `rt_receipts`. | `rt_matches`: `match_id/record_json/owner_epoch`; `rt_admissions` хранит действующие admission, очередь — `rt_start_queue`. Совпадают также имена несовместимых `rt_journal`/`rt_checkpoints`. `CREATE TABLE IF NOT EXISTS` не мигрирует эти схемы; существующий файл базы нельзя просто открыть другим store. |
| Runtime и client archives | Worker manifest `protocol: 'iva-worker@1'`, `sha256`, per-file hashes; runtime ID адаптера дополняется fingerprint. Client manifest `.iva-client-manifest.json`, route `/play/<game>/versions/<hex>/`. | Manifest `format: 1`, `artifactId: 'sha256:…'`, другой hash и worker RPC; client `_content-manifest.json`, route `/realtime-assets/<hex>/`. Существующий Forpost route whitelist не принимает маршрут PR50. Нужны сохранённые readers и маршруты для старых партий, а не переименование hash. |
| Регистрация и доставка | Generic engine существует, но `simulation-worker.ts`, `main.ts`, platform registration и каталог включают только Tyaga. Registry требует строковую версию, `launch: 'platform-room'` и game-specific health. Caddy overlay направляет Tyaga на4320. | Forpost имеет числовую версию, `roomLaunch`, `developmentUrl`, собственные registration и guest practice. Текущий Caddy направляет обе игровые группы путей на4331. Требуется согласование каталога, build/deploy, admission и маршрутов с сохранением обеих игр. |

Исходники PR50, закреплённые указанным SHA: [wire и GameAdapter](https://github.com/decorum-guy/iva-games/blob/6ab9254523c7359bbd174f0304be19d0f68bf40b/packages/realtime-kit/src/index.ts), [crypto](https://github.com/decorum-guy/iva-games/blob/6ab9254523c7359bbd174f0304be19d0f68bf40b/apps/realtime-server/src/crypto.ts), [storage](https://github.com/decorum-guy/iva-games/blob/6ab9254523c7359bbd174f0304be19d0f68bf40b/apps/realtime-server/src/storage.ts), [artifacts](https://github.com/decorum-guy/iva-games/blob/6ab9254523c7359bbd174f0304be19d0f68bf40b/apps/realtime-server/src/artifacts.ts), [client content](https://github.com/decorum-guy/iva-games/blob/6ab9254523c7359bbd174f0304be19d0f68bf40b/apps/realtime-server/src/client-content.ts). Дополнительные сравниваемые пути в обоих деревьях: `packages/session-kit/src/types.ts`, `packages/game-registry/{games.json,src/index.ts}`, `apps/realtime-server/src/{server,simulation-worker,main}.ts`; Forpost bridge — `apps/platform/src/realtime-adapter.ts`, PR50 bridge — `apps/realtime-server/src/adapter.ts`.

## Реальная граница повторного использования

`GameAdapter<W>` и registry в PR50 `apps/realtime-server/src/engine.ts` действительно обобщают create/restore/serialize/input/step/action/view/outcome и выбор по game/rules/content versions. Это подходящая точка последующего объединения. Фактический entrypoint пока создаёт только `createTyagaAdapter()`.

Forpost-адаптер должен сохранить сброс input stream при смене controller generation, ограниченный RTT rewind, разрешённый `viewForPlayer`, подтверждённые action receipts и согласованную идентичность матча в core/view/envelope. `StepContext` PR50 сейчас не передаёт RTT, поэтому одной обёртки методов недостаточно.

Небольшой изолированный кандидат — `packages/realtime-kit/src/view-projection.mjs` с `tests/projection.test.ts`: detached baseline и защита от prototype paths. Его blob: `2c41f204511a19909155e898074d83234476a922`. Текущий Forpost использует другой формат delta, поэтому перенос требует явного согласования codec. `src/snapshot-transfer.ts` предлагает отдельное negotiated расширение trusted worker transport с кешем по observer/epoch/generation; необходимость этого расширения для текущих Forpost views не установлена.

**Принятая общая основа пока не установлена этим аудитом.** При дальнейшем объединении сохраняются оба игровых адаптера, обе записи каталога, проверка состава команд, guest/account сценарии, старые protocol/storage/artifact readers и pinned client routes. Совместимость должна подтверждаться соответствующими сетевыми и recovery проверками объединённой сборки. Этот документ не предлагает слияние общих файлов целиком и не засчитывает игровую, нагрузочную или публичную приёмку.
