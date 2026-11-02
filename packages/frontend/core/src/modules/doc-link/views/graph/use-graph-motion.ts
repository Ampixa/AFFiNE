import { useCallback, useEffect, useRef, useState } from 'react';

import type { GraphEdge } from './model';
import { type Particle, stepParticles } from './physics';
type Point = { x: number; y: number; color: string };
export function useGraphMotion(seed: Map<string, Point>, links: GraphEdge[]) {
  const particles = useRef(new Map<string, Particle>());
  const frame = useRef(0),
    remaining = useRef(0),
    held = useRef<string | undefined>(undefined);
  const [positions, setPositions] = useState(seed);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const settings = useRef({ paused, reduced, links });
  settings.current = { paused, reduced, links };
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const publish = useCallback(
    () =>
      setPositions(
        new Map(
          [...particles.current].map(([id, p]) => [
            id,
            { x: p.x, y: p.y, color: p.color },
          ])
        )
      ),
    []
  );
  const wake = useCallback(() => {
    remaining.current = 180;
    if (frame.current) return;
    const tick = () => {
      frame.current = 0;
      const { paused, reduced, links } = settings.current;
      const energy =
        paused || reduced
          ? 0
          : stepParticles(particles.current, links, held.current);
      publish();
      remaining.current--;
      if (
        !paused &&
        !reduced &&
        remaining.current > 0 &&
        (energy > 0.08 || held.current)
      )
        frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [publish]);
  useEffect(() => {
    particles.current = new Map(
      [...seed].map(([id, p]) => [
        id,
        {
          ...p,
          vx: 0,
          vy: 0,
          homeX: p.x,
          homeY: p.y,
          ...particles.current.get(id),
        },
      ])
    );
    wake();
  }, [seed, links, wake]);
  useEffect(() => {
    wake();
  }, [paused, reduced, wake]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    []
  );
  const move = useCallback(
    (id: string, x: number, y: number) => {
      const p = particles.current.get(id);
      if (!p) return;
      held.current = id;
      p.x = Math.max(35, Math.min(865, x));
      p.y = Math.max(45, Math.min(545, y));
      p.vx = p.vy = 0;
      wake();
    },
    [wake]
  );
  const release = useCallback(() => {
    held.current = undefined;
    wake();
  }, [wake]);
  const reset = useCallback(() => {
    held.current = undefined;
    for (const p of particles.current.values()) {
      p.x = p.homeX;
      p.y = p.homeY;
      p.vx = p.vy = 0;
    }
    wake();
  }, [wake]);
  // New nodes use their seed until the next animation frame; removed nodes never render.
  return {
    positions: new Map(
      [...seed].map(([id, p]) => [id, positions.get(id) ?? p])
    ),
    move,
    release,
    reset,
    paused,
    setPaused,
    reduced,
  };
}
