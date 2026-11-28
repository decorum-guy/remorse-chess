import { resolve } from 'node:path';

/** Each acceptance process owns a separate directory, port set and browser profile. */
export function tyagaQaConfig(root, environment = process.env) {
  const profile = environment.TYAGA_QA_PROFILE ?? 'tyaga';
  if (!/^tyaga(?:-[a-z0-9-]{1,40})?$/.test(profile)) throw new Error('Invalid Tyaga QA profile');
  const port = (key, fallback) => {
    const value = Number(environment[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`Invalid ${key}`);
    return value;
  };
  const ports = { realtime: port('TYAGA_RT_PORT', 4284), platform: port('TYAGA_PLATFORM_PORT', 4285), browser: port('TYAGA_BROWSER_PORT', 5284) };
  if (new Set(Object.values(ports)).size !== 3) throw new Error('Tyaga QA ports must be distinct');
  return { profile, qa: resolve(root, '.qa', profile), ports, origin: `http://127.0.0.1:${ports.browser}` };
}
