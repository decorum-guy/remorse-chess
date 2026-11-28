import RAPIER from '@dimforge/rapier3d-compat';

/** These seven wooden/steel regions have four real open end slots. Their
 * geometry is also authored in deck.glb; a solid box would fill the receivers. */
export function deckParts(): { descriptor: RAPIER.ColliderDesc; volume: number }[] {
  const box = (x: number, z: number, hx: number, hz: number) => ({ descriptor: RAPIER.ColliderDesc.cuboid(hx, .09, hz).setTranslation(x, 0, z), volume: hx * hz * .72 });
  return [box(0, 0, 1.6, 1.5), ...[-1.8, 1.8].flatMap(x => [box(x, 0, .2, 1.13), box(x, -1.435, .2, .065), box(x, 1.435, .2, .065)])];
}

/** Static bridge receiver. Its origin is the canonical eye point, not its
 * bounding-box centre. Plate/bolt tops are below the supporting road plane;
 * the narrow posts and hollow eye fit through the matching deck end slots. */
export function bridgeMountParts(): RAPIER.ColliderDesc[] {
  const parts = [RAPIER.ColliderDesc.cuboid(.18, .03, .18).setTranslation(0, -.25, 0)];
  for (const x of [-.12, .12]) for (const z of [-.12, .12]) parts.push(RAPIER.ColliderDesc.cylinder(.02, .035).setTranslation(x, -.202, z));
  for (const x of [-.10, .10]) parts.push(RAPIER.ColliderDesc.cuboid(.02, .09, .025).setTranslation(x, -.14, 0));
  // The same 16 x 6 authored torus sections as bridge-mount.glb. Separate
  // convex wedges retain the actual central hole for ropes and receivers.
  for (let i = 0; i < 16; i++) {
    const vertices: number[] = [];
    for (const section of [i, (i + 1) % 16]) {
      const a = 2 * Math.PI * section / 16;
      for (let j = 0; j < 6; j++) {
        const b = 2 * Math.PI * j / 6, radius = .12 + Math.cos(b) * .032;
        vertices.push(radius * Math.cos(a), radius * Math.sin(a) * 80 / 93, Math.sin(b) * .032);
      }
    }
    const shape = RAPIER.ColliderDesc.convexHull(new Float32Array(vertices));
    if (!shape) throw new Error('INVALID_BRIDGE_RECEIVER');
    parts.push(shape);
  }
  return parts;
}
