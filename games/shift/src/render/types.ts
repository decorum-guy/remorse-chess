import type { RoomId, ShiftView, Vec2, VisibleActor } from '../core/types';

export interface ShiftRendererProps {
  view: ShiftView;
  mode: '3d' | '2d';
  quality?: 'low' | 'high';
  reducedMotion?: boolean;
  effects?: boolean;
  selectedRoomId?: RoomId | null;
  lang?: 'ru' | 'en';
  className?: string;
  onRoomSelect?: (roomId: RoomId) => void;
  onWorldAim?: (point: Vec2) => void;
  onFireChange?: (held: boolean) => void;
  getPredictedSelf?: () => VisibleActor | null;
  onModeFallback?: () => void;
  onViewportReady?: () => void;
}

export interface ScreenPoint { x: number; y: number }
export type Project = (x: number, z: number, height?: number) => ScreenPoint;

export const TEAM_COLORS = { teal: '#3cd8c6', amber: '#ffc066' };
export const ARENA_COLORS = {
  foundry: { floor: '#27343c', cover: '#69776f', accent: '#c7a25e', pale: '#bdbaa2' },
  calibration: { floor: '#33484e', cover: '#a7bcba', accent: '#b9dfd5', pale: '#e3ebe1' },
  depot: { floor: '#283841', cover: '#6f8693', accent: '#81a6bb', pale: '#bfced0' },
};
