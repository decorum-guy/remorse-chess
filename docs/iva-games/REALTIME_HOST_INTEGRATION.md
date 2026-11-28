# Realtime: первая интеграция хоста

Этот документ описывает подготовленный код, а не выполненную публикацию. Источники: текущие `deploy/iva-games/activation.py`, `compose.yaml`, `Caddyfile`, `ci-deploy`, новая `.github/workflows/iva-release-check.yml` и непосредственная проверка возможностей среды разработки. Правила обычного выпуска, резервирование, lock и проверка происхождения образов сохраняются.

## Подтверждённое ограничение доступа

В среде разработки 28 ноября 2026 года проверены только признаки доступа, без чтения или вывода секретов: SSH CLI доступен; пользовательского SSH config и known_hosts нет; SSH agent не настроен; Docker CLI отсутствует. Разрешённого административного соединения с VPS в этой среде нет. Фактические установленные файлы VPS отсюда не прочитаны. Это не утверждение об отсутствии ранее настроенного доступа на Mac владельца.

По зафиксированной в репозитории прежней схеме CI вызывает единственный root-owned обработчик `activation.py deploy` через `iva-deploy` и ForceCommand. CI не имеет права устанавливать новые host files, менять Caddy, создавать произвольные volumes или получать приватный ключ платформы. Новый клиент и image в GitHub сами по себе не создают третий сервис на таком хосте.

Если другой принятый исполнитель уже установил совместимую realtime-основу, сначала сверяются её фактические конфигурация и контракт; её не заменяют этой схемой целиком. Ни один из шагов ниже не был выполнен в production в рамках описанной проверки.

## Что подготовлено

| Часть | Контракт |
|---|---|
| Runtime image | `ghcr.io/decorum-guy/iva-games-realtime@sha256:…`, Node, отдельные simulation workers и SQLite writer |
| Внутренняя сеть | Только Compose service `realtime:4331`; наружу порт не публикуется |
| Данные | Отдельный external volume, `realtime.sqlite` с WAL, ключ гостевого обучения, maintenance token, проверяемые архивы исполняемого кода в `artifacts/` и клиентских ресурсов в `content/` |
| Account bridge | Платформа подписывает Ed25519; realtime хранит только разрешённые публичные ключи платформы |
| Публичные пути | `/play/forpost/`, `/api/realtime/v1/*`, `/ws/realtime/v1`, закреплённые клиентские файлы `/realtime-assets/<content-hash>/*` |
| Закрытые пути | `/internal/realtime/*` и `/maintenance/realtime/*` возвращают 404 через Caddy |
| Проверка живости | `/api/realtime/v1/health`, service `iva-realtime`; `artifactId` и `buildRevision` дают фактическую идентичность запущенного кода |
| Выпуск | Три проверенных digest, selective update, совместный backup platform/realtime после durable drain, обычный `DEPLOYED <sha>` |

## Единовременное действие существующего администратора

Эти действия требуют уже разрешённого административного доступа. Не меняются SSH alias, DNS, sudoers или перечень исполняемых ForceCommand команд. `install-host.sh` повторно на живом хосте не запускается.

1. Из проверенного checkout получить свежие `main`, актуальные `pins.json`, `state.json` и отсутствие незавершённого `pending.json`. Сравнить, не появился ли уже совместимый realtime сервис. На время host integration удерживать существующий `/var/lib/iva-games/activation/release.lock`, не конкурируя с CI.
2. Сохранить текущие root-owned deployment files и конфигурацию в административный backup. Установить проверенные `activation.py`, `backup.sh`, `restore-check.sh`, `compose.sh`, `compose.yaml` и `ci-deploy` в `/opt/iva-games/deploy/`. Команда ForceCommand остаётся `activation.py deploy`; увеличен только ограниченный timeout до 1500 секунд, достаточный для трёх образов и резервных копий. Новый обработчик принимает исключительно SHA и три image digest, проверяет main, CI, GHCR provenance и явную готовность host integration.
3. Создать отдельный внешний volume для realtime, имя записать как `REALTIME_DATA_VOLUME` в `/etc/iva-games/release.env`. Не удалять и не переименовывать existing chess/platform/Caddy volumes. Подтвердить, что UID runtime из проверенного образа может писать в собственный `/data`; не менять владельца чужих volumes.
4. В существующем platform volume создать Ed25519 private key `/data/realtime-platform-key.pem` от имени пользователя platform container, с режимом 0600 и запретом перезаписи существующего ключа. Проверить тип уже существующего ключа. Только публичную PEM-часть записать в `/etc/iva-games/realtime-trusted-keys.json` как JSON `{ "platform-v1": "-----BEGIN PUBLIC KEY-----\n…" }`. Этот файл содержит публичный материал и должен быть читаем UID realtime через read-only bind mount; приватный ключ туда не копируется.
5. Дополнить приватный `/etc/iva-games/platform.env` тремя строками: `REALTIME_INTERNAL_ORIGIN=http://realtime:4331`, `REALTIME_SIGNING_KEY_PATH=/data/realtime-platform-key.pem`, `REALTIME_SIGNING_KEY_ID=platform-v1`. Сохранить все существующие Telegram/account настройки. В `release.env` указать `COMPOSE_PROFILES=realtime`, `REALTIME_TRUSTED_KEYS_FILE=/etc/iva-games/realtime-trusted-keys.json` и проверенное имя realtime volume. Начальный лимит комнат — консервативный; он не является результатом часового нагрузочного испытания.
6. Проверить candidate Compose и Caddy через текущий pinned Caddy image, без получения сертификатов и изменения DNS. Для существующего single-file bind mount Caddy сохранить inode файла конфигурации при обновлении, затем выполнить штатный `caddy reload`; простая замена inode на хосте может оставить контейнер со старым файлом. Сохранить прежние шахматные и платформенные маршруты. Не пересоздавать Caddy и chess ради добавления путей.
7. После проверки файлов, volumes и public-key trust добавить `realtime_enabled: true` в существующий `/etc/iva-games/activation.json`, сохранив остальные поля. Это запись о выполненной инфраструктурной интеграции, не флаг выбора версии игры при каждом выпуске. Обработчик отказывает четырёхпольному запросу до этой записи; CI не меняет её сам.
8. Освободить lock. Единственный плановый публичный выпуск выполнить через существующий CI на принятом `main`. Текущие pins остаются источником реально принятых образов; их не заменяют фиктивным подтверждением. До фактического запуска третьего image новые пути ещё не подтверждают игру.

Для административных Compose команд использовать image environment из актуального `pins.json`, как делает `activation.release_env()`. `release.env` сам по себе может содержать первоначальные значения; подстановка произвольного latest image недопустима.

## Проверки после штатного выпуска

Нужны точная строка `DEPLOYED <sha>`, отсутствие pending recovery, фактические health и catalogue, опубликованный `/play/forpost/`, все три карты, создание гостевого обучения и account комнаты, однократный билет и игровые действия. Для незатронутых сервисов сверяются container ID, image ID, StartedAt и restart count. Смена digest без проверки текущего поведения не принимается за доставку.

При изменении platform или realtime обработчик сначала ставит realtime на долговечную паузу, затем сохраняет обе базы и весь соответствующий `/data`. В архив входят WAL, admissions, outbox, guest ownership и точные simulation artifacts. При неудачном backup сервис возобновляется без замены контейнера. Неудачный совместимый platform update также возобновляет прежний realtime после отката кода. Базы не заменяются старой копией для отката приложения.

Локальный `apps/realtime-server/scripts/network-smoke.mjs` проверяет реальный HTTP/WebSocket, потерянные/повторные действия, новый контроллер, нейтральный ввод, graceful restart, SIGKILL, lease/epoch и сохранение прежнего simulation artifact при обновлении. `verify-realtime-image.sh` добавляет проверку production container и volume в CI с Docker. Эти проверки не означают, что публичный сайт уже прошёл приёмку, и не заменяют браузерный игровой проход.
