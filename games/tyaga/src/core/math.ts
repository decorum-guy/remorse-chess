import type { Quat, Vec3 } from './types';
export const V = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const Q = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });
export const add = (a: Vec3, b: Vec3): Vec3 => V(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => V(a.x - b.x, a.y - b.y, a.z - b.z);
export const mul = (a: Vec3, k: number): Vec3 => V(a.x * k, a.y * k, a.z * k);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const norm = (a: Vec3): Vec3 => mul(a, 1 / (length(a) || 1));
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
export const mix = (a: Vec3, b: Vec3, t: number): Vec3 => add(mul(a, 1 - t), mul(b, t));
export const rotate = (q: Quat, v: Vec3): Vec3 => {
  const u = V(q.x, q.y, q.z);
  return add(add(mul(u, 2 * dot(u, v)), mul(v, q.w * q.w - dot(u, u))), mul(cross(u, v), 2 * q.w));
};
export const conjugate = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
export const quatAxis = (axis: Vec3, angle: number): Quat => { const s = Math.sin(angle / 2); return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) }; };
export const quatMul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
export const yawQuat = (angle: number): Quat => quatAxis(V(0, 1, 0), angle);
export const yaw = (q: Quat): number => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
export const angleDifference = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));
export const localPoint = (position: Vec3, rotation: Quat, world: Vec3): Vec3 => rotate(conjugate(rotation), sub(world, position));
export const worldPoint = (position: Vec3, rotation: Quat, local: Vec3): Vec3 => add(position, rotate(rotation, local));
