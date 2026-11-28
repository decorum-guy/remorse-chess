import { safeInteger } from '@iva-games/realtime-kit';
import type { BotLevel, MapId, Team, Tool, Weapon } from '@iva-games/forpost/core';

export interface ForpostLoadout { team: Team; weapon: Weapon; tool: Tool; botLevel: BotLevel }
export interface ForpostSettings { mapId: MapId; teamSize: 1 | 2 | 3; mapVersion: string; loadouts: Record<string, ForpostLoadout> }
export function normalizeForpostSettings(input: unknown): ForpostSettings {
  const v = input === undefined ? {} : input;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['mapId', 'teamSize', 'mapVersion', 'loadouts'].includes(k))) throw new Error('INVALID_SETTINGS');
  const value = v as Record<string, unknown>, mapId = value.mapId ?? 'FP01', teamSize = value.teamSize ?? 1;
  if (!['FP01', 'FP02', 'FP03'].includes(String(mapId)) || typeof teamSize !== 'number' || ![1, 2, 3].includes(teamSize) || value.mapVersion !== undefined && value.mapVersion !== 'forpost-maps-0.1') throw new Error('INVALID_SETTINGS');
  const loadouts = value.loadouts ?? {};
  if (!loadouts || typeof loadouts !== 'object' || Array.isArray(loadouts) || Object.keys(loadouts).length > 64) throw new Error('INVALID_SETTINGS');
  for (const [id, entry] of Object.entries(loadouts)) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).some(k => !['team', 'weapon', 'tool', 'botLevel'].includes(k)) ||
      !['A', 'B'].includes(entry.team) || !['carbine', 'shotgun', 'rifle'].includes(entry.weapon) || !['barrier', 'smoke', 'repair'].includes(entry.tool) ||
      !['novice', 'normal', 'strong'].includes(entry.botLevel)) throw new Error('INVALID_SETTINGS');
  }
  return { mapId: mapId as MapId, teamSize: teamSize as 1 | 2 | 3, mapVersion: 'forpost-maps-0.1', loadouts: loadouts as Record<string, ForpostLoadout> };
}

export interface PracticeSettings {
  mapId: 'FP01' | 'FP02' | 'FP03'; teamSize: 1 | 2 | 3; mode: 'training' | 'tutorial';
  displayName: string; botLevel: 'novice' | 'normal' | 'strong'; weapon?: 'carbine' | 'shotgun' | 'rifle';
  tool?: 'barrier' | 'smoke' | 'repair'; seed?: number;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function validatePractice(input: unknown): PracticeSettings {
  if (!object(input) || Object.keys(input).some(k => !['mapId', 'teamSize', 'mode', 'displayName', 'botLevel', 'weapon', 'tool', 'seed'].includes(k))) throw new Error('INVALID_SETTINGS');
  const value: Record<string, unknown> = { mapId: 'FP01', teamSize: 1, mode: 'training', displayName: 'Игрок', botLevel: 'normal', ...input };
  if (!['FP01', 'FP02', 'FP03'].includes(String(value.mapId)) || ![1, 2, 3].includes(Number(value.teamSize)) || typeof value.teamSize !== 'number' ||
    !['training', 'tutorial'].includes(String(value.mode)) || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 32 ||
    !['novice', 'normal', 'strong'].includes(String(value.botLevel)) ||
    (value.weapon !== undefined && !['carbine', 'shotgun', 'rifle'].includes(String(value.weapon))) ||
    (value.tool !== undefined && !['barrier', 'smoke', 'repair'].includes(String(value.tool))) ||
    (value.seed !== undefined && (!safeInteger(value.seed) || Number(value.seed) > 0xffffffff))) throw new Error('INVALID_SETTINGS');
  return value as unknown as PracticeSettings;
}
