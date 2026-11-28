import { afterEach, expect, it, vi } from 'vitest';

// Unit harness for the real input handlers. React mounting and the browser's
// event loop are replaced, so these checks are not browser interaction evidence.
const hooks = vi.hoisted(() => ({ cleanups: [] as (() => void)[] }));
vi.mock('react', () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(value: T) => [value, () => {}],
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) hooks.cleanups.push(cleanup);
  },
}));
import { useDrivingControls } from '../src/controls';
import type { BenchPreferences } from '../src/preferences';

afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(active = true, restoreKey = 'KeyR') {
  const windowTarget = new EventTarget(), documentTarget = new EventTarget();
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('Element', class Element {});
  let now = 0;
  let sample!: () => void;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    sample = callback;
    return 1;
  }) as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const restore = vi.fn();
  const preferences = { keys: { throttle: 'KeyW', reverse: 'KeyS', left: 'KeyA', right: 'KeyD', brake: 'Space', interact: 'KeyE', restore: restoreKey } } as BenchPreferences;
  const input = { current: { throttle: 0, steering: 0, brake: false } };
  const controls = useDrivingControls(active, preferences, input, vi.fn(), restore);
  return {
    controls, restore, input, windowTarget, documentTarget,
    at(value: number) { now = value; },
    sample(value: number) { now = value; sample(); },
    key(type: 'keydown' | 'keyup', code = restoreKey, repeat = false) {
      const event = new Event(type, { cancelable: true });
      Object.defineProperties(event, { code: { value: code }, repeat: { value: repeat } });
      windowTarget.dispatchEvent(event);
    },
  };
}

it('completes one 740 ms keyboard hold despite delayed interval samples', () => {
  const ui = mount();
  ui.key('keydown');
  ui.sample(90);
  ui.sample(590);
  ui.at(740); ui.key('keyup');
  ui.sample(800);
  expect(ui.restore).toHaveBeenCalledTimes(1);
});

it('does not turn a short tap into a reset when the next sample arrives late', () => {
  const ui = mount();
  ui.key('keydown');
  ui.at(599); ui.key('keyup');
  ui.sample(1000);
  expect(ui.restore).not.toHaveBeenCalled();
  ui.key('keydown');
  ui.at(1600); ui.key('keyup');
  expect(ui.restore).toHaveBeenCalledTimes(1);
});

it('fires once while held, including key repeat and the eventual release', () => {
  const ui = mount();
  ui.key('keydown');
  ui.sample(620);
  ui.at(650); ui.key('keydown', 'KeyR', true);
  ui.sample(1000);
  ui.at(1200); ui.key('keyup');
  ui.sample(1400);
  expect(ui.restore).toHaveBeenCalledTimes(1);
});

it.each(['blur', 'visibilitychange'] as const)('cancels a held action on %s and applies the safety brake', event => {
  const ui = mount();
  ui.key('keydown');
  ui.sample(40);
  ui.at(740);
  (event === 'blur' ? ui.windowTarget : ui.documentTarget).dispatchEvent(new Event(event));
  ui.key('keyup'); ui.sample(1000);
  expect(ui.restore).not.toHaveBeenCalled();
  expect(ui.input.current).toEqual({ throttle: 0, steering: 0, brake: true });
});

it('counts button/touch holds from their press and cancels interrupted gestures', () => {
  const ui = mount();
  ui.controls.restorePress();
  ui.at(740); ui.controls.restoreRelease();
  ui.sample(800);
  expect(ui.restore).toHaveBeenCalledTimes(1);
  ui.controls.restorePress();
  ui.at(1540); ui.controls.restoreCancel();
  ui.controls.restoreRelease(); ui.sample(1600);
  expect(ui.restore).toHaveBeenCalledTimes(1);
});

it('treats overlapping keyboard and button holds as one continuous action', () => {
  const ui = mount();
  ui.key('keydown');
  ui.at(300); ui.controls.restorePress();
  ui.at(400); ui.key('keyup');
  expect(ui.restore).not.toHaveBeenCalled();
  ui.sample(650);
  ui.at(800); ui.controls.restoreRelease();
  expect(ui.restore).toHaveBeenCalledTimes(1);
});

it.each([false, true])('keeps a keyboard hold when the button releases first; already fired=%s', alreadyFired => {
  const ui = mount();
  ui.key('keydown');
  ui.at(300); ui.controls.restorePress();
  if (alreadyFired) ui.sample(620);
  ui.at(alreadyFired ? 650 : 450);
  ui.controls.restoreRelease();
  ui.controls.restoreCancel(); // Native lostpointercapture follows pointerup.
  ui.at(690); ui.key('keydown', 'KeyR', true);
  ui.at(740); ui.key('keyup');
  ui.sample(1600);
  expect(ui.restore).toHaveBeenCalledTimes(1);
});

it('uses the configured restore key and ignores the old default', () => {
  const ui = mount(true, 'KeyZ');
  ui.key('keydown', 'KeyR'); ui.sample(700); ui.key('keyup', 'KeyR');
  expect(ui.restore).not.toHaveBeenCalled();
  ui.key('keydown', 'KeyZ'); ui.sample(1300); ui.key('keyup', 'KeyZ');
  expect(ui.restore).toHaveBeenCalledTimes(1);
});

it('does not arm a reset while controls are inactive', () => {
  const ui = mount(false);
  ui.key('keydown'); ui.controls.restorePress();
  ui.sample(800); ui.key('keyup'); ui.controls.restoreRelease();
  expect(ui.restore).not.toHaveBeenCalled();
});
