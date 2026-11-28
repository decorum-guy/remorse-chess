#!/usr/bin/env python3
"""First launch and narrowly scoped image promotion for the Iva Games VPS."""

import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import smtplib
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

CONFIG = Path('/etc/iva-games')
STATE = Path('/var/lib/iva-games/activation')
RUNTIME = Path('/opt/iva-games/deploy')
REPOSITORY = 'decorum-guy/iva-games'
DOMAINS = ('iva-games.pro', 'chess.iva-games.pro')
RESOLVERS = ('1.1.1.1', '8.8.8.8')
SERVICES = ('chess', 'platform')
REALTIME_SERVICES = (*SERVICES, 'realtime')
HEALTH = (
    ('iva-games.pro', '/health/ready', 'service', 'iva-platform'),
    ('chess.iva-games.pro', '/api/health', 'protocol', 'remorse-online-v1'),
    ('chess.iva-games.pro', '/api/overdrive/health', 'protocol', 'overdrive-online-v2'),
)
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _fp, _code, _message, _headers, _new_url):
        # Checking response.url after following a redirect is too late for a
        # request carrying the short-lived Actions token.
        raise RuntimeError('GitHub API redirect refused')


GITHUB_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), RefuseRedirects())
SHA = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')


def load(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def save(path, data):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
        tmp = Path(file.name)
        try:
            json.dump(data, file, indent=2, sort_keys=True)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
            os.replace(tmp, path)
            directory = os.open(path.parent, os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            tmp.unlink(missing_ok=True)


class CommandInterrupted(subprocess.SubprocessError):
    """An external cancellation must wait for the backup's bounded cleanup."""


def command(*args, timeout=30, env=None, data=None, cleanup_timeout=0):
    previous_handlers = {}
    interrupted = None
    waiting = False

    def on_interrupt(signum, _frame):
        nonlocal interrupted
        if interrupted is not None:
            return  # Repeated signals neither kill cleanup nor renew its deadline.
        interrupted = signum
        if waiting:
            raise CommandInterrupted()

    try:
        if cleanup_timeout:
            # Install before Popen: a TERM during child creation is remembered
            # and handled immediately after its process group becomes known.
            for signum in (signal.SIGTERM, signal.SIGINT):
                previous_handlers[signum] = signal.signal(signum, on_interrupt)
        with subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, env=env, start_new_session=bool(cleanup_timeout)) as process:
            try:
                waiting = bool(cleanup_timeout)
                if interrupted is not None:
                    raise CommandInterrupted()
                output, _ = process.communicate(data, timeout=timeout)
            except (subprocess.TimeoutExpired, CommandInterrupted):
                waiting = False
                # The backup shell must thaw its container and remove its
                # verifier before exiting. subprocess.run's immediate KILL
                # would bypass those traps and could leave production frozen.
                # Keep this call (and main's release.lock) alive during cleanup,
                # including TERM/INT sent by outer timeout or CI cancellation.
                if cleanup_timeout:
                    try:
                        os.killpg(process.pid, interrupted or signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.communicate(timeout=cleanup_timeout)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.communicate()
                else:
                    process.kill()
                    process.communicate()
                raise
            finally:
                waiting = False
            if interrupted is not None:
                raise CommandInterrupted()
            if process.returncode:
                raise subprocess.CalledProcessError(process.returncode, args)
    except (subprocess.SubprocessError, OSError) as error:
        # Docker output or exception arguments may contain private configuration.
        reason = 'interrupted after cleanup' if isinstance(error, CommandInterrupted) else 'failed'
        raise RuntimeError(f'{Path(args[0]).name} {args[1] if len(args) > 1 else ""} {reason}') from error
    finally:
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    if interrupted is not None:
        raise RuntimeError(f'{Path(args[0]).name} interrupted after cleanup')
    return output.strip()


def get_json(url, timeout=6):
    request = urllib.request.Request(url, headers={
        'User-Agent': 'iva-games-release', 'Accept': 'application/json', 'Cache-Control': 'no-cache',
    })
    with OPENER.open(request, timeout=timeout) as response:
        if response.url != url or not response.headers.get_content_type().endswith('json'):
            raise RuntimeError('Unexpected health or GitHub response')
        return json.load(response)


def github_json(path, token):
    """Authenticated, bounded GETs; never fall back to an anonymous request.

    A 403 alone does not establish whether a rate limit or a permission caused
    it. Keep safe response metadata so the next failure is diagnosable without
    printing credentials, response bodies, or private configuration.
    """
    if not re.fullmatch(r'[A-Za-z0-9_.-]+', token):
        raise RuntimeError('GitHub API token is missing or invalid')
    url = f'https://api.github.com/repos/{REPOSITORY}/{path}'
    request = urllib.request.Request(url, headers={
        'User-Agent': 'iva-games-release', 'Accept': 'application/vnd.github+json',
        'Authorization': f'Bearer {token}', 'X-GitHub-Api-Version': '2022-11-28',
        'Cache-Control': 'no-cache',
    })
    for attempt in range(3):
        try:
            with GITHUB_OPENER.open(request, timeout=10) as response:
                if response.url != url or not response.headers.get_content_type().endswith('json'):
                    raise RuntimeError('Unexpected GitHub API response')
                return json.load(response)
        except urllib.error.HTTPError as error:
            metadata = []
            for header in ('x-github-request-id', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'):
                value = error.headers.get(header, '')
                if value and re.fullmatch(r'[A-Za-z0-9:._-]{1,100}', value):
                    metadata.append(f'{header}={value}')
            reason = f'GitHub API HTTP {error.code}' + (f' ({", ".join(metadata)})' if metadata else '')
            delay = None
            if error.code in (502, 503, 504):
                delay = 2 ** attempt
            elif error.code in (403, 429):
                retry_after = error.headers.get('retry-after', '')
                reset = error.headers.get('x-ratelimit-reset', '')
                if retry_after.isdigit():
                    delay = int(retry_after)
                elif error.headers.get('x-ratelimit-remaining') == '0' and reset.isdigit():
                    delay = max(1, int(reset) - int(time.time()) + 1)
            error.close()
            # Do not retry permission errors, hammer a secondary limit, or wait
            # past the release budget. A later workflow retry can recover.
            if delay is None or delay > 20 or attempt == 2:
                raise RuntimeError(reason) from error
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 2:
                raise RuntimeError('GitHub API network request failed after 3 attempts') from error
            time.sleep(2 ** attempt)
    raise RuntimeError('GitHub API request failed')


def write_state(status, reason, dns=None, release=None):
    path = STATE / 'state.json'
    previous = load(path, {})
    record = {
        'status': status, 'reason': reason, 'dns': dns or previous.get('dns', {}),
        'checked_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    if release:
        record['release'] = release
    save(path, record)
    if (status, reason) != (previous.get('status'), previous.get('reason')):
        print(f'{status} {reason}', flush=True)


def dns_records(resolver, domain, kind):
    result = command('dig', f'@{resolver}', domain, kind, '+time=2', '+tries=1',
                     '+noall', '+comments', '+answer', timeout=3)
    if not re.search(r'\bstatus: NOERROR,', result):
        raise RuntimeError('DNS resolution failed')
    answers = {}
    for line in result.splitlines():
        if line and not line.startswith(';'):
            name, _, scope, type_, value = line.split(maxsplit=4)
            if scope == 'IN':
                answers.setdefault((name.lower(), type_), set()).add(value.lower())
    # Follow only the answer chain from the queried name.
    name = domain + '.'
    visited = set()
    while aliases := answers.get((name, 'CNAME')):
        if name in visited or len(aliases) != 1 or answers.get((name, kind)):
            raise RuntimeError('Ambiguous DNS alias')
        visited.add(name)
        name = next(iter(aliases))
    return {str(ipaddress.ip_address(ip)) for ip in answers.get((name, kind), set())}


def dns_sample(expected_ipv4):
    addresses = json.loads(command('ip', '-j', '-6', 'addr', 'show', 'scope', 'global'))
    ipv6 = {
        str(ipaddress.IPv6Address(address['local']))
        for interface in addresses if 'UP' in interface['flags']
        for address in interface['addr_info']
        if not address.get('tentative') and not address.get('dadfailed')
        and ipaddress.IPv6Address(address['local']).is_global
    }
    if ipv6 and not json.loads(command('ip', '-j', '-6', 'route', 'show', 'default')):
        ipv6.clear()
    report = {}
    signature = {}
    for domain in DOMAINS:
        result = []
        report[domain] = {}
        for resolver in RESOLVERS:
            try:
                a = dns_records(resolver, domain, 'A')
                aaaa = dns_records(resolver, domain, 'AAAA')
                report[domain][resolver] = {'A': sorted(a), 'AAAA': sorted(aaaa)}
                if a == {expected_ipv4} and aaaa.issubset(ipv6):
                    result.append(sorted(aaaa))
            except (RuntimeError, ValueError):
                report[domain][resolver] = {'error': 'incomplete DNS response'}
        if len(result) == len(RESOLVERS) and result[0] == result[1]:
            signature[domain] = result[0]
    return report, signature if len(signature) == len(DOMAINS) else None


def dns_readiness(expected_ipv4):
    path = STATE / 'dns.json'
    previous = load(path, {})
    report, sample = dns_sample(expected_ipv4)
    # A changed CNAME with the same terminal addresses is equivalent for routing.
    count = min(2, 1 + previous.get('consecutive', 0)) if (
        sample and sample == previous.get('signature')
    ) else int(bool(sample))
    save(path, {'signature': sample, 'consecutive': count})
    return {'consecutive': count, 'answers': report}


def platform_environment(path=None):
    values = {}
    for line in (path or CONFIG / 'platform.env').read_text().splitlines():
        if line and not line.startswith('#'):
            key, _, value = line.partition('=')
            if key in values:
                raise ValueError('Duplicate platform setting')
            values[key] = value
    return values


def mail_verification_settings():
    values = platform_environment()
    if values.get('MAIL_MODE') == 'disabled':
        return None
    if values.get('MAIL_MODE', 'smtp') != 'smtp':
        raise ValueError('Invalid production mail mode')
    host = values.get('SMTP_HOST', '')
    sender = values.get('SMTP_FROM', '')
    user = values.get('SMTP_USER', '')
    password = values.get('SMTP_PASSWORD', '')
    secure = values.get('SMTP_SECURE', 'true')
    port = int(values.get('SMTP_PORT') or (465 if secure == 'true' else 587))
    if (
        not host or host.lower().rstrip('.').endswith('.invalid')
        or not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', sender)
        or sender.lower().endswith('.invalid') or bool(user) != bool(password)
        or secure not in ('true', 'false') or not 0 < port < 65536
        or values.get('TELEGRAM_ENABLED') != 'false'
    ):
        raise ValueError('SMTP settings or Telegram flag are incomplete')
    return host, port, secure == 'true', user, password


def verify_smtp(settings):
    host, port, secure, user, password = settings
    context = ssl.create_default_context()
    if secure:
        server = smtplib.SMTP_SSL(host, port, timeout=6, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=6)
    with server:
        if not secure:
            server.starttls(context=context)
        server.ehlo_or_helo_if_needed()
        if user:
            server.login(user, password)


def release_env(release):
    return {**os.environ, **{f'{name.upper()}_IMAGE': info['image']
                              for name, info in release['services'].items()},
            **({'COMPOSE_PROFILES': 'realtime'} if 'realtime' in release['services'] else {})}


def compose(release, *args, timeout=30):
    return command(str(RUNTIME / 'compose.sh'), *args, timeout=timeout, env=release_env(release))


def up(release, *services):
    compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '75',
            *services, timeout=100)


def public_health():
    try:
        checks = HEALTH
        if load(CONFIG / 'activation.json', {}).get('realtime_enabled') is True:
            checks = (*checks, ('iva-games.pro', '/api/realtime/v1/health', 'service', 'iva-realtime'))
        for domain, path, field, expected in checks:
            result = get_json(f'https://{domain}{path}')
            if result.get('ok') is not True or result.get(field) != expected:
                return False
    except (OSError, RuntimeError, ValueError):
        return False
    return True


def running(release, service):
    container = compose(release, 'ps', '--quiet', service)
    return bool(container)


def container_snapshot(release, services):
    """Read identity and restart counters without copying any container env."""
    snapshot = {}
    for service in services:
        containers = compose(release, 'ps', '--all', '--quiet', service).splitlines()
        if len(containers) != 1:
            raise RuntimeError(f'Expected one untouched {service} container')
        fields = json.loads(command('docker', 'inspect', '--format',
            '[{{json .Id}},{{json .Image}},{{json .State.StartedAt}},{{.RestartCount}},{{.State.Running}},{{.State.Paused}}]',
            containers[0]))
        if len(fields) != 6 or fields[4:] != [True, False]:
            raise RuntimeError(f'Untouched {service} container is not running normally')
        snapshot[service] = fields[:4]
    return snapshot


def verify_untouched(release, expected):
    current = container_snapshot(release, expected)
    if current != expected:
        raise RuntimeError('An untouched service changed container identity or restarted')
    return current


def realtime_preflight(candidate, actual_release, allow_empty=False):
    """Check candidate readers/bytes against the actual volume without writes or network.

    An HTTP404 during image preparation never grants allow_empty. Only first
    provisioning does; the CLI still requires that mounted directory to be empty.
    """
    info = candidate['services']['realtime']
    image = info['image']
    if not re.fullmatch(r'ghcr\.io/decorum-guy/iva-games-realtime@sha256:[0-9a-f]{64}', image) or not SHA.fullmatch(info['sha']):
        raise RuntimeError('Realtime preflight requires a pinned repository image')
    labels = json.loads(command('docker', 'image', 'inspect', image, '--format', '{{json .Config.Labels}}'))
    if labels.get('org.opencontainers.image.source') != f'https://github.com/{REPOSITORY}' or labels.get('org.opencontainers.image.revision') != info['sha']:
        raise RuntimeError('Realtime preflight image labels differ')
    configuration = json.loads(compose(actual_release, 'config', '--format', 'json'))
    volume = configuration.get('volumes', {}).get('realtime-data', {})
    name = volume.get('name', '')
    if volume.get('external') is not True or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name):
        raise RuntimeError('Realtime persistent volume is not explicitly configured')
    # docker run would silently create a missing named volume. Refuse first.
    if command('docker', 'volume', 'inspect', name, '--format', '{{.Name}}') != name:
        raise RuntimeError('Realtime persistent volume is missing')
    containers = compose(actual_release, 'ps', '--all', '--quiet', 'realtime').splitlines()
    if len(containers) > 1 or not containers and not allow_empty:
        raise RuntimeError('Cannot identify the existing realtime data mount')
    if containers:
        mounts = json.loads(command('docker', 'inspect', '--format', '{{json .Mounts}}', containers[0]))
        data_mounts = [mount for mount in mounts if mount.get('Destination') == '/data']
        if len(data_mounts) != 1 or data_mounts[0].get('Type') != 'volume' or data_mounts[0].get('Name') != name:
            raise RuntimeError('Configured realtime volume differs from the running service')
    verifier = 'iva-realtime-preflight-' + uuid.uuid4().hex
    try:
        result = command('docker', 'run', '--rm', '--name', verifier, '--network', 'none', '--read-only',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m',
            '--mount', f'type=volume,src={name},dst=/data,readonly,volume-nocopy', '--entrypoint', 'node', image,
            '/app/dist-realtime/retention-cli.js', 'check-store', '--database', '/data/realtime.sqlite',
            '--revision', info['sha'], *(['--allow-empty-store'] if allow_empty else []), timeout=180)
        report = json.loads(result)
        if report.get('ok') is not True or report.get('operation') != 'check-store' or report.get('buildRevision') != info['sha'] or not DIGEST.fullmatch(report.get('bundleSeal', '')):
            raise RuntimeError('Realtime compatibility check was not confirmed')
        return report
    finally:
        # A timeout of the Docker client must not leave our verifier behind.
        # This unique name never addresses a service container or its volume.
        try:
            command('docker', 'rm', '--force', verifier)
        except RuntimeError:
            pass


def activate():
    state = load(STATE / 'state.json', {})
    if state.get('status') == 'ACTIVE':
        command('systemctl', 'disable', '--now', 'iva-games-activate.timer')
        return
    cfg = load(CONFIG / 'activation.json')
    dns = dns_readiness(cfg['ipv4'])
    release = load(CONFIG / 'pins.json', {})
    try:
        settings = mail_verification_settings()
    except (OSError, ValueError):
        write_state('WAITING_CONFIG', 'production SMTP settings are required', dns, release)
        return
    if release.get('sha') != cfg.get('initial_sha') or not release.get('sha'):
        write_state('WAITING_CONFIG', 'pinned initial images are required', dns)
        return
    if dns['consecutive'] < 2:
        write_state('WAITING_DNS', 'both domains must agree twice on both resolvers', dns, release)
        return
    if not running(release, 'caddy'):
        try:
            if settings:
                verify_smtp(settings)
        except (OSError, smtplib.SMTPException):
            write_state('WAITING_CONFIG', 'SMTP TLS connection or authentication failed', dns, release)
            return
        compose(release, 'config', '--quiet')
        already_running = False
        try:
            if 'realtime' in release['services']:
                already_running = running(release, 'realtime')
                if already_running:
                    compose(release, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'drain', timeout=30)
                realtime_preflight(release, release, allow_empty=not already_running)
            up(release, *release['services'])
        except Exception:
            if already_running:
                compose(release, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'resume', timeout=30)
            raise
        if already_running:
            compose(release, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'resume', timeout=30)
        # DNS can change during SMTP, pull-free startup, or database checks.
        report, sample = dns_sample(cfg['ipv4'])
        if sample is None or sample != load(STATE / 'dns.json')['signature']:
            save(STATE / 'dns.json', {'signature': None, 'consecutive': 0})
            write_state('WAITING_DNS', 'DNS changed during readiness check', {'answers': report}, release)
            return
        compose(release, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'caddy', timeout=40)
    write_state('WAITING_TLS', 'Caddy started; waiting for trusted HTTPS on both names', dns, release)
    if public_health():
        write_state('ACTIVE', 'trusted HTTPS and all configured health endpoints verified', dns, release)
        command('systemctl', 'disable', '--now', 'iva-games-activate.timer')


def verify_main(sha, token):
    main = github_json('branches/main', token)
    if main['commit']['sha'] != sha:
        raise RuntimeError('Requested release is no longer the head of main')
    checks = github_json(
        f'actions/workflows/iva-platform.yml/runs?branch=main&event=push&head_sha={sha}&status=success', token,
    )
    if not any(run['head_sha'] == sha and run['conclusion'] == 'success'
               for run in checks['workflow_runs']):
        raise RuntimeError('Successful main CI was not found')


def pull_release(sha, digests, token, previous):
    images = {}
    services = REALTIME_SERVICES if len(digests) == 3 else SERVICES
    if len(digests) != len(services):
        raise RuntimeError('Release must contain every configured image digest')
    with tempfile.TemporaryDirectory(prefix='iva-registry-', dir='/run') as directory:
        env = {**os.environ, 'DOCKER_CONFIG': directory}
        command('docker', 'login', 'ghcr.io', '-u', 'decorum-guy', '--password-stdin',
                env=env, data=token + '\n')
        for service, digest in zip(services, digests):
            repository = f'ghcr.io/{REPOSITORY}-{service}'
            image = f'{repository}@{digest}'
            tag = f'{repository}:{sha}'
            reported = command('docker', 'buildx', 'imagetools', 'inspect', '--format',
                               '{{json .Manifest}}', tag, env=env)
            if json.loads(reported)['digest'] != digest:
                raise RuntimeError('Registry digest does not match the commit tag')
            metadata = json.loads(command('docker', 'buildx', 'imagetools', 'inspect', '--format',
                                          '{{json .Image}}', image, env=env))
            fields = (metadata.get('config') or metadata.get('linux/amd64', {}).get('config', {})).get('Labels', {})
            if fields.get('org.opencontainers.image.revision') != sha or (
                fields.get('org.opencontainers.image.source') != f'https://github.com/{REPOSITORY}'
            ):
                raise RuntimeError('Image revision does not match')
            fingerprint = fields['org.iva-games.inputs']
            compatibility = fields['org.iva-games.compatibility']
            if not re.fullmatch('[0-9a-f]{64}', fingerprint) or not re.fullmatch('[0-9a-f]{64}', compatibility):
                raise RuntimeError('Missing build input or compatibility fingerprint')
            existing = previous.get('services', {}).get(service)
            if existing and existing['inputs'] == fingerprint and existing.get('compatibility') == compatibility:
                try:
                    command('docker', 'image', 'inspect', existing['image'], '--format', '{{.Id}}')
                except RuntimeError:
                    pass  # Redownload by the new digest if the old image was pruned.
                else:
                    images[service] = existing
                    continue
            command('docker', 'pull', image, env=env, timeout=180)
            images[service] = {'image': image, 'sha': sha, 'inputs': fingerprint, 'compatibility': compatibility}
    return {'sha': sha, 'services': images}


def promote(candidate, previous):
    path = CONFIG / 'pins.json'
    services = tuple(candidate['services'])
    changed = [name for name in services
               if candidate['services'][name]['image'] != previous['services'].get(name, {}).get('image')]
    untouched = container_snapshot(previous, [name for name in services if name not in changed] + ['caddy'])
    drained = 'realtime' in previous['services'] and bool(set(changed) & {'platform', 'realtime'})
    # Capture both databases for each changed service before replacing anything.
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    backups = [name for name in changed if name in previous['services']]
    if drained:
        backups = sorted(set(backups) | {'platform', 'realtime'})
    try:
        if drained:
            compose(previous, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'drain', timeout=30)
        if 'realtime' in changed:
            realtime_preflight(candidate, previous if 'realtime' in previous['services'] else candidate,
                               allow_empty='realtime' not in previous['services'])
        for service in backups:
            command(str(RUNTIME / 'backup.sh'), service,
                    f'/srv/iva-games-backups/{stamp}-{candidate["sha"][:12]}-{service}',
                    timeout=180, cleanup_timeout=25, env=release_env(previous))
    except Exception:
        if drained:
            compose(previous, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'resume', timeout=30)
        raise
    pending = STATE / 'pending.json'
    save(pending, {'previous': previous, 'candidate': candidate, 'changed': changed, 'untouched': untouched})
    try:
        if changed:
            up(candidate, *changed)
        if drained and 'realtime' not in changed:
            compose(candidate, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'resume', timeout=30)
        verified = verify_untouched(candidate, untouched)
        if not public_health():
            raise RuntimeError('Updated HTTPS health failed')
        save(path, candidate)
        write_state('ACTIVE', 'updated release passed HTTPS health', release=candidate)
        save(STATE / 'last-deploy.json', {'sha': candidate['sha'], 'changed': changed,
                                        'untouched_before': untouched, 'untouched_after': verified})
    except RuntimeError:
        # Incompatible migrations or protocols must be fixed forward. Never
        # replace a live volume with the pre-update snapshot.
        if changed and all(name in previous['services'] and (name == 'realtime' or candidate['services'][name]['compatibility']
                           == previous['services'][name]['compatibility']) for name in changed):
            rollback_drain = False
            if 'realtime' in changed:
                try:
                    rollback_drain = running(candidate, 'realtime')
                    if rollback_drain:
                        compose(candidate, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'drain', timeout=30)
                    # Check the database as it exists now, after candidate writes.
                    # Do not restore the pre-update backup to make old code fit.
                    realtime_preflight(previous, candidate)
                except Exception:
                    if rollback_drain:
                        compose(candidate, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'resume', timeout=30)
                    raise
            up(previous, *changed)
            if drained and 'realtime' not in changed:
                compose(previous, 'exec', '-T', 'realtime', 'node', '/app/scripts/realtime-control.mjs', 'resume', timeout=30)
            verify_untouched(previous, untouched)
            if public_health():
                pending.unlink()
        raise
    pending.unlink()


def deploy():
    request = sys.stdin.buffer.readline(512)
    token_line = sys.stdin.buffer.readline(4096)
    if not request.endswith(b'\n') or not token_line.endswith(b'\n'):
        raise RuntimeError('Invalid deploy request')
    fields = request.decode('ascii').split()
    token = token_line.decode('ascii').strip()
    if len(fields) not in (3, 4) or not SHA.fullmatch(fields[0]) or not all(
        DIGEST.fullmatch(digest) for digest in fields[1:]
    ) or not re.fullmatch(r'[A-Za-z0-9_.-]+', token):
        raise RuntimeError('Invalid deploy request')
    sha, *digests = fields
    cfg = load(CONFIG / 'activation.json')
    realtime_enabled = cfg.get('realtime_enabled') is True
    if (len(digests) == 3) != realtime_enabled:
        raise RuntimeError('Realtime host integration must be provisioned before this release')
    state = load(STATE / 'state.json', {})
    pins = load(CONFIG / 'pins.json', {})
    active = state.get('status') == 'ACTIVE'
    if not active and cfg.get('initial_sha') != sha:
        print('DEFERRED initial activation is gated')
        return
    if (STATE / 'pending.json').exists():
        raise RuntimeError('Previous deployment requires recovery from pending.json')
    if pins.get('sha') == sha:
        print('UNCHANGED release already current')
        return
    verify_main(sha, token)
    candidate = pull_release(sha, digests, token, pins)
    compose(candidate, 'config', '--quiet')
    verify_main(sha, token)
    if not active:
        save(CONFIG / 'pins.json', candidate)
        print(f'STAGED {sha}')
    else:
        promote(candidate, pins)
        print(f'DEPLOYED {sha}')


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('activate', 'deploy'):
        return 2
    mode = sys.argv[1]
    with (STATE / 'release.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Release lock busy; retry shortly')
            return 75
        try:
            (activate if mode == 'activate' else deploy)()
        except Exception as error:
            reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            if mode == 'activate':
                write_state('ERROR', reason, release=load(CONFIG / 'pins.json', {}))
            else:
                save(STATE / 'deploy-error.json', {'reason': reason})
                print(f'ERROR {reason}', file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
