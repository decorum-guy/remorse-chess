# Standalone realtime: host preparation and release contract

This document describes the checked-in source, not an installed VPS change.
The existing forced CI command promotes immutable images; it cannot install a
different handler, create an Ed25519 signing key, change Caddy mounts, or add an
external volume. A source commit does not perform this one-time preparation.

## Observed access boundary

In the isolated development executor used for this implementation, the own SSH
directory/config and `SSH_AUTH_SOCK` were absent. The only matching SSH/deploy/
GitHub environment variable name was `GH_PAGER`; no credential values were
printed. Docker CLI was also absent in that local executor. Host installation
has not been performed or verified through that access. Docker image checks
have since executed in GitHub Actions; their actual results are recorded below.

The GitHub connector reports repository administration/push permission, but has
no exposed Actions-variable operation. The local `gh` client is unauthenticated;
read-only requests to repository/environment variables return HTTP 401. Thus the
actual production `IVA_REALTIME_ENABLED` value is unknown, and an absent local
host credential is not evidence that a particular administrator lacks access.

The initial read-only audit found main at
`357f60049e83b298bb5bbc2f760654fbd02384e3` and the successful existing
[release run 46140795659](https://github.com/decorum-guy/iva-games/actions/runs/46140795659).
Its deployment log confirms that SHA and the District catalogue smoke check.
At that audit, the production workflow/handler used two application images. Direct
requests to the public realtime health paths returned portal HTML, not realtime
health JSON, and the platform catalogue contained no Tyaga entry. These checks
do not inspect private host files or prove that no preliminary host preparation
exists. No realtime deployment has been verified by this audit.

The CI account remains restricted to
`sudo -n /opt/iva-games/deploy/activation.py deploy`. Its authorized-key forced
command, sudoers scope, stdin-only token transport, release lock, provenance
checks, backup thaw traps, and selective replacement are preserved. Do not use
that account to run a shell or install these files.

## Recorded CI image and network results

Commit `b7ab9ed4265b819299d082e21a6a3957ba1d07de` passed all three image jobs in
[release-image run 46169113385](https://github.com/decorum-guy/iva-games/actions/runs/46169113385).
The [realtime job 141053233365](https://github.com/decorum-guy/iva-games/actions/runs/46169113385/job/141053233365)
built `sha256:fa9b971cc71483db2a80dac7c33abbd784c6ed543d49cdf59b95cda60e9dcd5f`.
Both its initial and restored-container checks passed: real Rapier, two sockets,
movement, a durable action receipt, static assets and durable recovery. This
also verifies the corrected disposable public-key permissions. The
[platform image job](https://github.com/decorum-guy/iva-games/actions/runs/46169113385/job/141053233543)
and [chess image job](https://github.com/decorum-guy/iva-games/actions/runs/46169113385/job/141053233603)
passed. Publish and deploy were skipped. No installed-host preparation or
public Tyaga revision follows from these CI successes.

The same commit's [real TCP impairment job 141053233494](https://github.com/decorum-guy/iva-games/actions/runs/46169113462/job/141053233494)
passed 14 matrix profiles, then failed to obtain a controlling connection for
nominal RTT 160 ms, jitter 0 ms, loss 5%. Full-matrix and blackhole acceptance
remain open. Source review found a possible harness race: a replacement socket
can correctly enter as an observer before the previous close reaches the server.
The next source explicitly claims control for that isolated same-player test
client, coalesces ACKs, and records terminal scope/claim evidence. The old failure
lacked that terminal evidence; its exact cause and the new fix's effectiveness
require the next real CI run. No production takeover rule was loosened.

## Changes installed once by an administrator

Use an existing authorized administrative session and a reviewed source checkout.
Do not run `install-host.sh` again on an existing installation: it is the initial
provisioner and deliberately refuses an existing `release.env`.

1. Wait for active release jobs to finish. Acquire the existing lock for the
   preparation session:

   ```bash
   exec 9>/var/lib/iva-games/activation/release.lock
   flock -n 9
   ```

   Save an administrator-only copy of `/etc/iva-games`,
   `/opt/iva-games/deploy`, the current `pins.json`, and the current Caddy
   container identity. Keep secrets and that copy outside Git and CI artifacts.
   Preserve the current `chess`/`platform` image digests and all four existing
   external volumes.

2. Install these reviewed files into `/opt/iva-games/deploy` with root ownership:

   | Mode | Files |
   |---|---|
   | `0755` | `activation.py`, `ci-deploy`, `compose.sh`, `backup.sh`, `restore-check.sh`, `drain-realtime.sh`, `verify-pair.sh` |
   | `0644` | `compose.yaml`, `compose.realtime.yaml`, `Caddyfile`, `Caddyfile.realtime`, `drain-realtime.mjs`, `release-pair.mjs` |

   The forced command still invokes only `activation.py deploy`. Its total
   bounded timeout becomes 1,500 seconds to include three image pulls and
   backups; the individual 20-second filesystem-copy limit is unchanged.
   Do not broaden `/etc/sudoers.d/iva-deploy` or `authorized_keys`.

3. Create one additional external volume:

   ```bash
   docker volume create iva-games-realtime-data
   install -d -o root -g root -m 0700 /etc/iva-games/keys
   ```

   Generate an Ed25519 key pair locally on the host. The private key is
   `/etc/iva-games/keys/platform-private.pem` in PKCS8 PEM format, owned by
   `root:1000`, mode `0640`. The public file is
   `/etc/iva-games/keys/trusted-public-keys.json`, owned by root, mode `0644`,
   with the exact form `{"platform-v1":"<SPKI PEM public key>"}`.
   The `node:24` runtime already present in the pinned platform image can
   generate these with the builtin `generateKeyPairSync('ed25519')`; no package,
   external key service, or outbound mail is required. Refuse to overwrite an
   existing key pair. Verify the public key derives from that private key before
   enabling the bridge. Never print or copy the private key into release logs.

   The reviewed helper performs those checks and prints only the public
   fingerprint. With `reviewed` set to the reviewed source directory:

   ```bash
   platform_image="$(python3 -c 'import json; print(json.load(open("/etc/iva-games/pins.json"))["services"]["platform"]["image"])')"
   docker run --rm --network none --user 0:0 \
     --mount type=bind,src=/etc/iva-games/keys,dst=/keys \
     --entrypoint node "$platform_image" --input-type=module - /keys platform-v1 \
     < "$reviewed/deploy/iva-games/create-realtime-keys.mjs"
   ```

   The Compose overlay mounts the private file only into the platform container
   and the public file only into realtime. The realtime volume stores no signing
   private key. Rotation keeps old public keys during the 30-second ticket
   lifetime and signed-request clock allowance.

4. Add or update these values in `/etc/iva-games/release.env`, keeping existing
   unrelated values and avoiding duplicate names:

   ```dotenv
   IVA_REALTIME_ENABLED=true
   REALTIME_IMAGE=iva-games-unset:realtime
   REALTIME_DATA_VOLUME=iva-games-realtime-data
   REALTIME_PRIVATE_KEY_FILE=/etc/iva-games/keys/platform-private.pem
   REALTIME_TRUSTED_KEYS_FILE=/etc/iva-games/keys/trusted-public-keys.json
   REALTIME_KEY_ID=platform-v1
   REALTIME_MAX_MATCHES=2
   ```

   The placeholder cannot be used to start realtime. The normal, reviewed
   three-image release overrides it with a verified immutable digest.
   `REALTIME_MAX_MATCHES=2` is the source example, not a measured VPS capacity.
   The existing two-room calibrations did not meet all acceptance gates. Choose
   the actual limit only after the corresponding hour and maximum-scene tests
   on the deployment allocation; a smaller declared capacity is valid only when
   it is measured as well.
   No modification of private Telegram or mail credentials is needed.

5. Preserve every existing field of `/etc/iva-games/activation.json` and add
   exactly `"services":["chess","platform","realtime"]`. The handler rejects
   any other order/set and rejects a request with the wrong digest count before
   registry access or application mutation. `pins.json` remains the last actual
   release; do not invent a realtime digest or declare a release active.

6. Validate both Compose configurations and the new Caddyfile with the pinned
   Caddy image. Pass the existing chess/platform images from `pins.json` to the
   command environment; do not replace them with newer tags. Run:

   ```bash
   /opt/iva-games/deploy/compose.sh config --quiet
   ```

   A configuration-only `caddy validate --config … --adapter caddyfile` container
   must use `--network none`, no published ports, and a read-only Caddyfile.
   Then recreate **only Caddy** once with the reviewed overlay so its new bind
   mount takes effect. This is an administrative infrastructure change, outside
   ordinary selective image promotion. Do not recreate chess or platform at
   this step. Confirm both existing domains and their existing health paths
   still work. Realtime routes return unavailable until the accepted first
   three-image release starts that service.

7. Record the installed source SHA, the new handler checksum, configuration
   validation, volume existence, key ID/public fingerprint, and unchanged
   chess/platform container identities. Do not record private key material.
   Release the lock. Only after those checks set the production GitHub
   environment variable **`IVA_REALTIME_ENABLED=true`**. This is a persistent
   infrastructure capability marker, not a per-release or game-rules switch.

Before that marker is present, the new workflow stops **before SSH**. This
prevents a catalogue-only deployment that advertises an unavailable runtime.
After preparation, ordinary accepted `main` updates continue through the same
automatic CI/image/deploy path without further manual activation.

## Ordinary three-image release

The workflow builds and tests `chess`, `platform`, and `realtime` independently,
publishes immutable SHA tags, obtains their digests, and sends the bounded stdin
request `SHA chess-digest platform-digest realtime-digest` to the existing forced
command. The host independently checks current `main`, successful platform CI,
GHCR digest, revision/source labels, and input/compatibility fingerprints.

Only changed application images are replaced. Chess, platform, and Caddy
identity/start/restart counters are captured whenever they are untouched.
Adding the first realtime service skips a nonexistent prior realtime backup,
but refuses to adopt or overwrite an unpinned realtime container. A failed first
addition is retained in `pending.json` for explicit recovery; it does not roll
back or replace existing databases. Later compatible failures may return only
the affected images, using the same live volume and exact retained runtimes.

Replacing an existing realtime image first requires a positive signed drain.
The host executes the reviewed signing helper inside the existing platform
container; its private key never enters the host command arguments or logs.
Only after all active worlds have a durable full snapshot does realtime return
the barrier manifest. The host backs up realtime and then platform, including
platform when its image is unchanged. That bounded backup pause does not recreate
the platform container. The pair verifier reads disposable copies of both
backups and checks room IDs, frozen start commands, owners, roster/settings
hashes, world cursors, exact runtime and browser artifacts, durable admission
reservations and their frozen platform starts, and outcome/outbox agreement.
The barrier and verified pair manifest are kept with the backups before any
application image is replaced.

An unconfirmed drain or inconsistent pair aborts promotion. A successfully
drained process can cancel preparation by reopening the exact archived workers
from their saved worlds; clients reconnect to the same matches. If cancellation
cannot be confirmed, `pending.json` records
`preparation-failed-drain-not-resumed`. No unsaved process is forcibly destroyed.
An image rollback force-recreates only affected services so an already drained
old realtime container cannot be mistaken for a ready rollback.

Successful release requires the existing public health checks plus
`https://iva-games.pro/health/realtime/ready`, with `ok:true`, service
`iva-realtime`, protocol `iva-realtime@1`, and the **selected realtime image's**
actual revision. A reused image can legitimately have an older SHA than the
overall release. Keep both in the release record. Public catalogue, room,
ticket, WebSocket, and gameplay checks remain required after promotion.

## Durable runtime archive, backup, and restore

`/data/realtime.sqlite`, `/data/runtime-artifacts/<sha256>/`, and
`/data/client-artifacts/<sha256>/` live in the same external volume. Before a new match can reference a runtime, the process copies
its own compiled executable JS/chunks to a local archive, fsyncs them and the
directory, and records the hash manifest. The public manifest includes that
actual content hash. No client, ticket, or saved URL can load executable code.
Recovery verifies bytes before starting the archived simulation worker with
protocol `iva-worker@1`; all versions share one fenced SQLite writer.

The independent browser archive includes the complete locally built client:
HTML, scripts, styles, models, sounds, fonts, and their licensing files. Its
hash covers filenames, bytes, and game/rules/content metadata. A match records
that hash and the versioned launch route; tickets retain that route after an
update. The realtime service serves all verified retained routes, including
`/play/tyaga/versions/<sha256>/`, through the existing `/play/tyaga*` proxy rule.
The client uses relative resource paths and verifies a ticket's same-origin
version route before following it. No client-supplied URL is archived or loaded.

Archives are retained without automatic pruning, including beyond the required
24-hour return window. Never remove an archive while any match/checkpoint
references it. An incompatible or absent artifact fails recovery closed; it is
not silently re-simulated using the current solver.

The normal `backup.sh realtime /absolute/new/path` freezes only realtime,
copies the entire data directory including WAL, runtime and browser archives, thaws the
original container before verification, checks SQLite, and verifies hashes for
every referenced archive, including exact file sets and game metadata. Its
`INCOMPLETE` marker remains on failure. Archives currently have no automatic
pruning; monitor volume use rather than deleting a returnable version.

`restore-check.sh /absolute/verified/backup iva-games-restore-<unique-name>`
creates a **new** volume, starts the original immutable image without a network,
and uses a disposable public key. It resets owner leases only in that disposable
copy so recovery cannot contend with the original live server. Health exercises
the actual archived world readers. Restore acceptance additionally requires
zero unavailable matches, failed workers, or recovery failures; a healthy
gateway alone cannot approve a partial restoration. Database integrity and
foreign keys are then checked; production volumes and private signing keys are
not touched.

The CI realtime image check uses actual Rapier, two independent WebSockets,
ordinary movement, a durable appearance action, container replacement, exact
receipt replay, static models, and bounded SIGTERM with a stalled HTTP upload.
That technical check does not stand in for browser completion of the game's
three maps or for a measured long-running VPS capacity test.
