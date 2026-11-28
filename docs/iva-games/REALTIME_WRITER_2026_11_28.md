# Realtime: диагностика задержек SQLite после R3

## Что подтверждено

Документ основан на непосредственно прочитанных исходниках и завершённых локальных процессах. Числа сохранены в [evidence/forpost-writer-2026-11-28.json](evidence/forpost-writer-2026-11-28.json); в файл не включены worlds, tickets, cookies или записи аккаунтов.

R3 HTTP/WebSocket smoke **14/14 PASS**, process exit 0. Это настоящий сервер, worker threads, SQLite/WAL, сетевые соединения, покупка с потерянным ACK и SIGKILL. Он не является браузерным прохождением. После него изменён механизм SQLite checkpoint; успешный R3 smoke не переносится на этот новый код автоматически.

Для последующего writer-кандидата выполнено короткое сравнение прежнего SQLite autocheckpoint и отдельного PASSIVE worker в обоих порядках. p99 commit у кандидата оказался ниже в обоих измерениях. Максимальные задержки смешанные, а обнаруженные checkpoint commits не совпали с худшими задержками. **Причина пауз `SERVER_BUSY` в удалённом браузерном CI этим сравнением не доказана.** Повтор исходного браузерного сценария на собранном кандидате обязателен.

## Точный R3 smoke

| Поле | Фактическое значение |
| --- | --- |
| Local commit | `e88be1a203142a40801195cbfad1eafe8ea47574`, working tree clean |
| Tree | `f3ff57573fb9ce7f3399e6cc0312aee56160943e` |
| Source aggregate, 55 файлов | `10c00422b42c1dc2ba0caab0f5fb36b616e12cccf2cb60569919be45302c4687` |
| Core aggregate, 18 файлов | `14d49d29954d0f7f427feea026beb23113699ff8ecb36ec4480f61f339a61e68` |
| Runtime | `sha256:f9190c52e5085d217299aec0957894aed6694028b639618f382b8903a7956826` |
| Client | `sha256:0b5313c7c6ef1456ba7c9dd554a81860bd2535c7add5f33bcd389aa93a48f48c` |
| Лог и private QA directory | `.qa/network-smoke-r6.log`, `.qa/realtime-network-jJiLf1/` |
| Результат | 14/14 групп, exit 0; собственные серверные процессы остановлены |

Два одновременных слота в smoke явно помечены `source: test-fixture`. Они нужны для проверки сохранённых версий, а не доказательства ёмкости. Worker work p99 — 6,7 мс, thread CPU p99 — 6,9 мс, worker RPC p99 — 17,8 мс, commit p99 — 34,2 мс, journal age p99 — 52,7 мс. Storage failures — 0, выходная очередь — 0; наибольший наблюдённый batch — 1, поэтому этот прогон не измеряет выигрыш группирования нескольких комнат.

## Гипотеза и проверяемая область изменения

В прежнем коде каждый такт обновлял полный `rt_matches.record_json` и ждал `synchronous=FULL` commit. Отдельный игровой checkpoint дополнительно сохранялся каждые 60 тиков. SQLite autocheckpoint оставался штатным: фактический встроенный SQLite — **3.54.1**, default `wal_autocheckpoint` — **1000 страниц**. После R6 в его собственной базе измерены page size 4096, максимальный текущий record 23 455 байт и максимальная строка игрового журнала 427 байт. Это измерение локальной базы после штатной остановки, не файловой системы браузерного CI.

[Документация SQLite WAL](https://www.sqlite.org/wal.html) описывает autocheckpoint в том же потоке, который выполняет соответствующий commit, и отдельный поток как способ убрать эту работу из его критического пути. Режим FULL продолжает синхронизировать WAL при каждой транзакции. [PASSIVE checkpoint](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint) не ждёт завершения чужих readers/writers и может оставить часть страниц на следующий проход.

Новый код не меняет период такта, формат сохранения, `synchronous=FULL`, fencing, правила долговечной публикации, допустимое отставание или причину `SERVER_BUSY`. SQLite checkpoint выполняется отдельным worker с собственным соединением; это не игровой checkpoint и не выдача неподтверждённого состояния клиенту.

Текущая зависимость использует SQLite 3.54.1. Worker дополнительно отвергает версии ниже 3.51.3 из-за описанного upstream исправления WAL-reset при параллельной записи/checkpoint; зависимости не обновлялись в этой правке. Этот консервативный минимум не является утверждением, что все более старые ветки SQLite лишены backport-исправлений.

## Два коротких диагностических прогона

Оба прогона используют настоящий `RealtimeStore.commitBatch`, SQLite и детерминированный легальный мир 3×3 на FP01. Перед записью мир продвинут обычными шагами core до боевой фазы. Один human-seat явно переведён под временного бота; другие участники — явные боты. На вариант выполнены 30 warmup и 600 измеренных тиков с целевым интервалом 33,333 мс. Это диагностическая запись одной комнаты, не сетевой runtime целиком и не принятая нагрузка.

| Порядок | Вариант | Commit median, мс | Commit p99, мс | Max, мс | Измеренных commit >50 мс |
| --- | --- | ---: | ---: | ---: | ---: |
| AB, первым | Штатный auto 1000 pages | 3,126 | 33,801 | 105,499 | 3 |
| AB, вторым | Отдельный PASSIVE worker | 2,958 | 10,726 | 45,574 | 0 |
| BA, первым | Отдельный PASSIVE worker | 3,365 | 19,814 | 64,980 | 3 |
| BA, вторым | Штатный auto 1000 pages | 2,811 | 25,160 | 37,494 | 0 |

Во всех вариантах максимальный world — 155 964 байта, record — 183 270 байт, а `synchronous=2`. Каждый вариант длился примерно 21 секунду. Кандидат выполнил 24 и 29 checkpoint; их максимальные длительности — 14,108 и 18,413 мс, ошибок — 0. Размер WAL в последних samples — 5,37 и 7,48 МБ. В обоих baseline найдено 18 commit с прогрессом autocheckpoint; они занимали приблизительно 4–13 и 4–8 мс. Это существенно для интерпретации: длиннейшие задержки этих локальных прогонов имеют другую либо неустановленную причину.

Среда: Node v24.22.3, SQLite 3.54.1, сообщённый CPU model AMD EPYC 7763, Linux 6.18.57. Реальная CPU quota и cgroup memory allocation недоступны; показанные probe 1 CPU/1 GiB — **консервативный fallback admission**, не измеренная выделенная машина. Другие агенты на время двух прогонов отложили свои CPU-heavy команды; конкуренция с остальными процессами хоста не измерена.

Оба прогона сделаны до следующего слияния main, на local HEAD `e88be1a…`, `dirty=true`. Source aggregate — `40a692e47857ccd41dab3c21ce6c685f3702648fe36a310ad385af29eb2bb39b`, core — `14d49d2995…`. Исполняемый диагностический bundle независимо сохранён и хэширован:

- AB: `.qa/writer-checkpoint-V1ySWW/report.json`, executable aggregate `3be7bc334547c0d166fae6960efbd39eaaaa87de45604630db740ee4e176a462`;
- BA: `.qa/writer-checkpoint-i7KPBW/report.json`, executable aggregate `5c68bc6e8cf0fe24e3e29f0500cb38e53e3ebafafc6d9409efb22e94690a158a`.

Разные executable hashes отражают добавленный выбор обратного порядка. Исходники store/checkpointer и core между этими двумя прогонами не менялись. Скрипт `writer-probe.mjs` собирает только собственный bundle в отдельный QA-каталог, не меняет `dist-realtime` и сохраняет исходные данные.

## Ограничение роста WAL и диагностика

Worker проверяет состояние каждые 250 мс; незавершённые frames вызывают PASSIVE при 1000 страницах или после одной секунды. На worker нет параллельных checkpoint-операций. При закрытии writer сначала закрывает этот worker, затем выполняет прежний финальный checkpoint и закрытие базы. Асинхронное закрытие остаётся FIFO-барьером для последующих запросов.

Состояние checkpointer старше 5 секунд, его ошибка/выход или WAL не меньше 64 MiB запрещают следующую изменяющую операцию. Это fail-closed защита: неподтверждённый мир не выдаётся как сохранённый, а отказ требует восстановления. Порог проверяется перед операцией; уже выполняющаяся ограниченная транзакция может превысить его своим размером. `journal_size_limit=16 MiB` уменьшает оставшуюся allocation при последующем штатном сбросе WAL. Долгий внешний reader не обходится принудительным изменением правил матча.

Новые инфраструктурные metrics:

- `writer.transactionP99Ms` и `maxTransactionMs` — весь `commitBatch`;
- `bodyP99Ms` — нормальные тела SQL-переходов;
- `finalizeP99Ms` — transaction minus body: включает begin/savepoint/commit overhead, это **не точное измерение fsync**;
- `queueP99Ms` — ожидание RPC внутри writer перед выполнением;
- `maxWorldBytes`, `maxRecordBytes`, `maxJournalBytes` — размеры сериализуемых записей;
- `checkpoint` — SQLite version, page size, frames, прогресс, WAL bytes, число операций и длительности.

Эти значения не включают private game fields. Они предназначены для сопоставления следующего `SERVER_BUSY` с реальной очередью и операцией хранения, а не для автоматического объявления исправленной производительности.

## Проверки и остаток

Финальный focused suite: **18/18 PASS** (`.qa/writer-checkpoint-tests-r2.log`), общий TypeScript и focused ESLint exit 0 (`.qa/writer-checkpoint-types-r2.log`, `.qa/writer-checkpoint-eslint-r2.log`). Проверены настоящий второй SQLite connection, FULL=2, отсутствие autocheckpoint у выделенного writer, блокирующий прогресс reader с последующим возобновлением checkpoint, отказ при stale/failure/размере WAL, FIFO async-барьер закрытия, а также прежние durable-publication/FIFO tests. Физическое отключение диска не имитировалось; size guard проверен отдельным sparse-файлом.

Следующие доказательства ещё нужны: окончательный общий build, настоящий network/recovery smoke на новом artifact, повтор исходных браузерных FP01/FP02 сценариев, допустимая нагрузка и public host delivery. Старые два четырёхкомнатных FAIL остаются действительными результатами своих сборок. Здесь не заявлены исправление всех перегрузок, принятая четырёхкомнатная ёмкость или публичный выпуск.

## R4 remote evidence and bounded local storage diagnosis

The actual R4 build `51748ae944081b5a33a08a630b42b31310b09546` still paused all six 2D/3D map passages with SERVER_BUSY. On FP01/FP02 2D, worker work p99 was 0.8 ms; commit RPC p99 138.9/176.4 ms; writer body p99 0.4 ms; transaction-minus-body p99 119.5/173.7 ms. Their approximately 16.7 ms median frame intervals and zero observed long tasks show that the server failure also occurs without slow 3D frames. The independent real HTTP/WS smoke passed its 14 correctness cases but recorded commit p99 121 ms. Neither correctness PASS nor the final FP03 latency after twenty minutes of paused activity closes the performance defect. [Exact completed R4 data](../../games/forpost/qa/ci-round-4.json).

The new [bounded diagnostic](../../apps/realtime-server/scripts/STORAGE_DIAGNOSTIC.md) measures the actual checkout mount, a 16 KiB append/fsync fixture and the existing RealtimeStore.commitBatch with FULL/WAL/PASSIVE unchanged. Its first local invocation stopped during native-addon identification, after 0.990 s and **before any measured case**. The harness now hashes the actual loaded addon, including the prebuilt dependency layout.

One complete local diagnostic then recorded 14.686 s, 64 measured file syncs after 8 warmup and 300 SQLite commits after 30 warmup. [Sanitized summary](evidence/realtime-storage-local-2026-11-28.json):

| Observation | Actual value / scope |
|---|---|
| Source | Dirty checkpoint `0513dad…`, 251-file aggregate `501fd67a34ddb1d5de62207bd75971d092a6d36256819d0ac7bde724d2721aff`; exact bytes verified before/after |
| Diagnostic executable | `9deb4d721edf1ab7aa946aa2ad56ff364960bb9e47228b9adae2f43566cabfbd`, three compiled files; not the production runtime identity |
| Actual mount | ext4, /dev/vdb, major:minor 254:16; no alternate disk selected |
| File fsync p99 / max | 3.334038 / 3.334038 ms, 64 measured samples |
| SQLite commit p99 / max | 2.397083 / 2.733913 ms, 300 measured samples; no sample above 50 ms |
| Writer timing | FULL=2, WAL, autocheckpoint=0; total 330 batches including warmup; cumulative transaction p99 2.7 ms |
| Case | FP01 1×1 preparation, ordinary core ticks 0→330, one inactive human seat and one explicit bot; final stored hash/journal verified |
| Checkpoint | 11 runs, max 2.610984 ms, zero failures |
| Trace | Own-child ptrace unavailable; no syscall trace and no privilege workaround |
| Environment limits | CPU/I/O pressure, cgroup allocation and block-device listing unavailable; not invented |
| Cleanup / completion evidence | Summary complete=true, failures empty, raw directory removed. The separate shell exit-code receipt was not retained; exit 0 is inferred from the successful code path, not independently asserted |

The local result did not reproduce the CI delay and is not production storage/capacity acceptance. Finalize still includes locking/transaction/scheduling and is **not fsync**. CI will run this same diagnostic with an outer timeout and optional own-child tracing; only sanitized stdout enters its logs, never the private report/source/raw files.
