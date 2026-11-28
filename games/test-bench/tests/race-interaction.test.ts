import { afterEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// Unit integration of the real Race callback and keyboard handlers. React
// mounting, rendering and browser scheduling are replaced; this is not a
// browser playtest or a replay of the three HTTP400 responses from RTT11.
const hooks = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
vi.mock('react', () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(value: T) => [value, () => {}],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));
vi.mock('../src/Scene', () => ({ TestBenchScene: () => null }));
import { Race } from '../src/components';
import { PRESETS } from '../src/catalog';
import { readPreferences } from '../src/preferences';
import { getTrack } from '../src/tracks';
import type { LaneSnapshot } from '../src/types';

afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function interactionButton(node: ReactNode): ReactElement<{ disabled: boolean; onClick: () => void }> | undefined {
  if (Array.isArray(node)) return node.map(interactionButton).find(Boolean);
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as ReactElement<{ className?: string; children?: ReactNode }>;
  if (element.type === 'button' && element.props.className?.split(' ').includes('tb-interact')) return element as ReactElement<{ disabled: boolean; onClick: () => void }>;
  return interactionButton(element.props.children);
}

function mount(interaction: LaneSnapshot['interaction'], options: { active?: boolean; paused?: boolean; finished?: boolean; spectator?: boolean; interactKey?: string } = {}) {
  const windowTarget = new EventTarget(), documentTarget = new EventTarget();
  vi.stubGlobal('window', windowTarget); vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('Element', class Element {});
  vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 1) as unknown as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const lane = {
    tick: 100, blueprint: PRESETS.universal, car: { speed: 0, charge: 20, tilt: 0 },
    cargo: [], events: [], gatesPassed: 0, resets: 0, finished: options.finished ?? false, interaction,
  } as unknown as LaneSnapshot;
  const onInteract = vi.fn();
  const defaults = readPreferences();
  const preferences = { ...defaults, keys: { ...defaults.keys, interact: options.interactKey ?? 'KeyE' } };
  const tree = Race({ lane, track: getTrack('fragile'), locale: 'en', preferences, input: { current: { throttle: 0, steering: 0, brake: true } }, seconds: 60, onInteract, onRestore: vi.fn(), active: options.active, paused: options.paused, spectator: options.spectator });
  return {
    onInteract, button: interactionButton(tree),
    press(code = options.interactKey ?? 'KeyE', repeat = false) {
      const event = new Event('keydown', { cancelable: true });
      Object.defineProperties(event, { code: { value: code }, repeat: { value: repeat } });
      windowTarget.dispatchEvent(event);
    },
  };
}

it.each(['load', 'pickup'] as const)('allows the same %s action from a normal key press and the enabled button', interaction => {
  const ui = mount(interaction);
  expect(ui.button?.props.disabled).toBe(false);
  ui.press(); ui.press('KeyE', true);
  expect(ui.onInteract).toHaveBeenCalledTimes(1);
  ui.button?.props.onClick();
  expect(ui.onInteract).toHaveBeenCalledTimes(2);
});

it.each(['none', 'slow-down', 'face-dock', 'full', 'empty'] as const)('blocks the keyboard and button callback when interaction is %s', interaction => {
  const ui = mount(interaction);
  expect(ui.button?.props.disabled).toBe(true);
  ui.press(); ui.button?.props.onClick();
  expect(ui.onInteract).not.toHaveBeenCalled();
});

it.each([
  ['inactive', { active: false }],
  ['paused', { paused: true }],
  ['finished', { finished: true }],
  ['spectator', { spectator: true }],
] as const)('blocks an otherwise available load action for %s controls', (_name, options) => {
  const ui = mount('load', options);
  if ('spectator' in options) expect(ui.button).toBeUndefined();
  else expect(ui.button?.props.disabled).toBe(true);
  ui.press(); ui.button?.props.onClick();
  expect(ui.onInteract).not.toHaveBeenCalled();
});

it('keeps the configured interaction key while guarding unavailable actions', () => {
  const ui = mount('pickup', { interactKey: 'KeyQ' });
  ui.press('KeyE');
  expect(ui.onInteract).not.toHaveBeenCalled();
  ui.press('KeyQ');
  expect(ui.onInteract).toHaveBeenCalledTimes(1);
});
