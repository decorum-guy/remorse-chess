import { describe, expect, it } from 'vitest';
import { normalizeForpostSettings, validatePractice } from '../src/settings';
describe('Forpost room settings', () => {
  it('practice cannot create account games or set arbitrary world state', () => {
    expect(validatePractice({ mapId: 'FP03', teamSize: 3 })).toMatchObject({ mapId: 'FP03', teamSize: 3, mode: 'training' });
    expect(() => validatePractice({ mode: 'match' })).toThrow();
    expect(() => validatePractice({ world: {} })).toThrow();
    expect(() => validatePractice({ teamSize: '3' })).toThrow();
    expect(() => validatePractice({ mapId: '../' })).toThrow();
  });
  it('preserves resolved teams, loadouts and per-bot levels', () => {
    const settings = { mapId: 'FP02', teamSize: 2, loadouts: { 'seat-1': { team: 'B', weapon: 'rifle', tool: 'repair', botLevel: 'strong' } } };
    expect(normalizeForpostSettings(settings)).toMatchObject(settings);
    expect(() => normalizeForpostSettings({ ...settings, mapId: 'random' })).toThrow();
    expect(() => normalizeForpostSettings({ ...settings, loadouts: { bad: { team: 'A', health: 1000 } } })).toThrow();
  });
});
