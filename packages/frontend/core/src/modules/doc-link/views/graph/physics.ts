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
      // Short labels need more horizontal room than the node circles.
      if (Math.abs(dx) < 190 && Math.abs(dy) < 36) {
        const separation = (36 - Math.abs(dy)) * 0.035 * (dy < 0 ? -1 : 1);
        a.vy -= separation;
        b.vy += separation;
      }
    }
  }
  for (const edge of links) {
    const a = points.get(edge.source),
      b = points.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x,
      dy = b.y - a.y,
      d = Math.max(1, Math.hypot(dx, dy));
    const f = (d - 165) * 0.004;
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
    p.vx = (p.vx + (p.homeX - p.x) * 0.001) * 0.84;
    p.vy = (p.vy + (p.homeY - p.y) * 0.001) * 0.84;
    p.x = Math.max(105, Math.min(795, p.x + Math.max(-8, Math.min(8, p.vx))));
    p.y = Math.max(65, Math.min(535, p.y + Math.max(-8, Math.min(8, p.vy))));
    energy += Math.abs(p.vx) + Math.abs(p.vy);
  }
  return energy;
}
