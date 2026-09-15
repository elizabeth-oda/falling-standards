import type { Position } from './player-controller';
export const distance = (a: Position, b: Position) => Math.hypot(...a.map((value, axis) => value-b[axis]));
export function creationSpawnPosition(player: Position, speed: number): Position {
  return [player[0], player[1]-Math.max(18, Math.abs(speed)*3), player[2]];
}
// Swept point/sphere collision accounts for lateral and vertical movement.
export function sweptPickup(from: Position, to: Position, center: Position, radius: number): boolean {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const cx = center[0] - from[0], cy = center[1] - from[1], cz = center[2] - from[2];
  const lengthSquared = dx * dx + dy * dy + dz * dz;
  const projection = lengthSquared === 0 ? 0 : (cx * dx + cy * dy + cz * dz) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  const x = dx * t - cx, y = dy * t - cy, z = dz * t - cz;
  return radius >= 0 && x * x + y * y + z * z <= radius * radius;
}
