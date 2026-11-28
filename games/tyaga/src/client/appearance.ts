export interface AppearanceChoice { head: 0 | 1; backpack: 0 | 1 }
const defaultKey = (playerId: string) => `iva.tyaga.appearance.v1:${playerId}`;
const pendingKey = (roomId: string, playerId: string) => `iva.tyaga.appearance.pending.v1:${roomId}:${playerId}`;
function read(key: string): AppearanceChoice | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return value && [0, 1].includes(value.head) && [0, 1].includes(value.backpack)
      ? { head: value.head, backpack: value.backpack } : null;
  } catch { return null; }
}
export function defaultAppearance(playerId: string): AppearanceChoice { return read(defaultKey(playerId)) ?? { head: 0, backpack: 0 }; }
export function pendingAppearance(roomId: string, playerId: string): AppearanceChoice | null { return read(pendingKey(roomId, playerId)); }
export function rememberAppearance(roomId: string, playerId: string, value: AppearanceChoice): void {
  try { localStorage.setItem(defaultKey(playerId), JSON.stringify(value)); localStorage.setItem(pendingKey(roomId, playerId), JSON.stringify(value)); } catch { /* Choice can still be changed in the expedition. */ }
}
export function clearPendingAppearance(roomId: string, playerId: string): void { try { localStorage.removeItem(pendingKey(roomId, playerId)); } catch { /* Storage may be unavailable. */ } }
