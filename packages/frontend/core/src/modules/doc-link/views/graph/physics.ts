import type { GraphEdge } from './model';
export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  homeX: number;
  homeY: number;
  color: string;
};
/** A bounded deterministic simulation. No timers, randomness or server work. */
export function stepParticles(
  points: Map<string, Particle>,
  links: GraphEdge[],
  held?: string
) {
  const entries = [...points.entries()];
  for (let i = 0; i < entries.length; i++) {
    const [, a] = entries[i];
    for (let j = i + 1; j < entries.length; j++) {
      const [, b] = entries[j];
      let dx = b.x - a.x,
        dy = b.y - a.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.01) {
        dx = 0.1;
        dy = 0.1;
      }
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force =
        Math.min(2.5, 1800 / (distance * distance)) +
        Math.max(0, 65 - distance) * 0.025;
      a.vx -= (dx / distance) * force;
      a.vy -= (dy / distance) * force;
      b.vx += (dx / distance) * force;
      b.vy += (dy / distance) * force;
    }
  }
  for (const edge of links) {
    const a = points.get(edge.source),
      b = points.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x,
      dy = b.y - a.y,
      d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - 115) * 0.009;
    a.vx += (dx / d) * f;
    a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f;
    b.vy -= (dy / d) * f;
  }
  let energy = 0;
  for (const [id, p] of entries) {
    if (id === held) {
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    p.vx = (p.vx + (p.homeX - p.x) * 0.003) * 0.77;
    p.vy = (p.vy + (p.homeY - p.y) * 0.003) * 0.77;
    p.x = Math.max(45, Math.min(855, p.x + Math.max(-8, Math.min(8, p.vx))));
    p.y = Math.max(65, Math.min(535, p.y + Math.max(-8, Math.min(8, p.vy))));
    energy += Math.abs(p.vx) + Math.abs(p.vy);
  }
  return energy;
}
