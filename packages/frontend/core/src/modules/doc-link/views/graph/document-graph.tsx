import { useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  type GraphDoc,
  type GraphEdge,
  neighborhood,
  normalizeGraph,
} from './model';
import { useGraphMotion } from './use-graph-motion';

const palette = ['#7772d9', '#b88c51', '#4a9a89', '#bc7286', '#648eb8'];
export function DocumentGraph({
  docs,
  edges,
  initialId,
  onOpen,
  caption = 'Explicit document links · arrows point to the referenced document',
}: {
  docs: GraphDoc[];
  edges: GraphEdge[];
  initialId?: string;
  onOpen?: (id: string) => void;
  caption?: string;
}) {
  const markerId = useId().replace(/:/g, '');
  const [selected, select] = useState(initialId ?? docs[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('all');
  const [camera, setCamera] = useState({ zoom: 1, x: 0, y: 0 });
  const zoom = camera.zoom;
  const svg = useRef<SVGSVGElement>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const gesture = useRef<{
    id?: string;
    pointer: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const toCanvas = (clientX: number, clientY: number) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return { x: 450, y: 310 };
    return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  };
  const setZoom = (update: number | ((z: number) => number)) =>
    setCamera(c => ({
      ...c,
      zoom: Math.min(
        2.5,
        Math.max(0.5, typeof update === 'number' ? update : update(c.zoom))
      ),
    }));
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const point = toCanvas(e.clientX, e.clientY);
      setCamera(c => {
        const next = Math.max(
          0.5,
          Math.min(
            2.5,
            c.zoom * Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.002)
          )
        );
        const ratio = next / c.zoom;
        return {
          zoom: next,
          x: point.x - 450 - (point.x - 450 - c.x) * ratio,
          y: point.y - 310 - (point.y - 310 - c.y) * ratio,
        };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const [group, setGroup] = useState('All groups');
  const { nodes, links, truncated } = useMemo(
    () => normalizeGraph(docs, edges),
    [docs, edges]
  );
  const current = nodes.find(node => node.id === selected);
  const connected = neighborhood(selected, links);
  const groups = useMemo(
    () => [...new Set(nodes.map(node => node.group ?? 'Documents'))],
    [nodes]
  );
  const degree = (id: string) =>
    links.filter(link => link.source === id || link.target === id).length;
  const visible = nodes.filter(
    node =>
      (!query || node.title.toLowerCase().includes(query.toLowerCase())) &&
      (group === 'All groups' || (node.group ?? 'Documents') === group) &&
      (mode === 'all' ||
        (mode === 'local' ? connected.has(node.id) : degree(node.id) === 0))
  );
  const ids = new Set(visible.map(node => node.id));
  const shownLinks = links.filter(
    link => ids.has(link.source) && ids.has(link.target)
  );
  const seed = useMemo(
    () =>
      new Map(
        nodes.map(node => {
          const gi = groups.indexOf(node.group ?? 'Documents');
          const siblings = nodes.filter(
            n => (n.group ?? 'Documents') === (node.group ?? 'Documents')
          );
          const ni = siblings.findIndex(n => n.id === node.id);
          const angle = ni * 2.39996 + gi;
          const radius = ni === 0 ? 0 : 65 + 16 * Math.sqrt(ni);
          const ga =
            (gi / Math.max(groups.length, 1)) * Math.PI * 2 - Math.PI / 2;
          const spread = groups.length === 1 ? 0 : 175;
          return [
            node.id,
            {
              x: 450 + Math.cos(ga) * spread + Math.cos(angle) * radius,
              y: 310 + Math.sin(ga) * spread * 0.82 + Math.sin(angle) * radius,
              color: palette[gi % palette.length],
            },
          ] as const;
        })
      ),
    [nodes, groups]
  );
  const motion = useGraphMotion(seed, links);
  const positions = motion.positions;
  const incoming = links.filter(edge => edge.target === selected);
  const outgoing = links.filter(edge => edge.source === selected);
  return (
    <section className="dg-root" aria-label="Document connections">
      <style>{css}</style>
      <div className="dg-toolbar">
        <label className="dg-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Find a document"
            placeholder="Find a document…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </label>
        <select
          aria-label="Filter by group"
          value={group}
          onChange={e => setGroup(e.target.value)}
        >
          <option>All groups</option>
          {groups.map(g => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <div className="dg-segments">
          {[
            ['all', 'All connections'],
            ['local', 'Around selection'],
            ['unlinked', 'No links in view'],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="dg-body">
        <div className="dg-canvas">
          <div className="dg-count" aria-live="polite">
            {visible.length} documents <span>·</span> {shownLinks.length} links
            {truncated && ' · limited to 200 documents'}
          </div>
          <svg
            viewBox="0 0 900 620"
            role="group"
            aria-label="Interactive document graph"
            ref={svg}
            tabIndex={0}
            onPointerDown={e => {
              if (e.button !== 0 || gesture.current) return;
              const p = toCanvas(e.clientX, e.clientY);
              gesture.current = {
                pointer: e.pointerId,
                x: p.x,
                y: p.y,
                panX: camera.x,
                panY: camera.y,
                offsetX: 0,
                offsetY: 0,
              };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={e => {
              const g = gesture.current;
              if (!g || g.pointer !== e.pointerId) return;
              const p = toCanvas(e.clientX, e.clientY);
              if (g.id) {
                const c = cameraRef.current;
                motion.move(
                  g.id,
                  (p.x - 450 - c.x) / c.zoom + 450 - g.offsetX,
                  (p.y - 310 - c.y) / c.zoom + 310 - g.offsetY
                );
              } else {
                setCamera(c => ({
                  ...c,
                  x: g.panX + p.x - g.x,
                  y: g.panY + p.y - g.y,
                }));
              }
            }}
            onPointerUp={e => {
              if (gesture.current?.pointer !== e.pointerId) return;
              gesture.current = null;
              motion.release();
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              gesture.current = null;
              motion.release();
            }}
            onLostPointerCapture={() => {
              gesture.current = null;
              motion.release();
            }}
            onKeyDown={e => {
              if (e.target !== e.currentTarget) return;
              if (e.key === '0') {
                setCamera({ zoom: 1, x: 0, y: 0 });
              } else if (e.key === '+' || e.key === '=') {
                e.preventDefault();
                setZoom(z => z + 0.15);
              } else if (e.key === '-') {
                e.preventDefault();
                setZoom(z => z - 0.15);
              }
            }}
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="26"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            <g
              transform={`translate(${450 + camera.x} ${310 + camera.y}) scale(${zoom}) translate(-450 -310)`}
            >
              {shownLinks.map(edge => {
                const a = positions.get(edge.source);
                const b = positions.get(edge.target);
                if (!a || !b) return null;
                const active =
                  edge.source === selected || edge.target === selected;
                return (
                  <line
                    key={JSON.stringify(edge)}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={
                      active ? '#a59de1' : 'var(--affine-border-color, #e3e2e4)'
                    }
                    strokeWidth={active ? 1.7 : 1}
                    markerEnd={`url(#${markerId})`}
                    style={{
                      color: active
                        ? '#a59de1'
                        : 'var(--affine-border-color, #e3e2e4)',
                    }}
                  />
                );
              })}
              {visible.map(node => {
                const p = positions.get(node.id);
                if (!p) return null;
                const active = node.id === selected;
                const size = Math.min(15, 7 + degree(node.id));
                return (
                  <g
                    key={node.id}
                    tabIndex={0}
                    role="button"
                    aria-label={`Select ${node.title}`}
                    aria-pressed={active}
                    onClick={() => select(node.id)}
                    onDoubleClick={() =>
                      node.kind !== 'folder' && onOpen?.(node.id)
                    }
                    onPointerDown={e => {
                      if (e.button !== 0 || gesture.current) return;
                      e.stopPropagation();
                      select(node.id);
                      const point = toCanvas(e.clientX, e.clientY);
                      gesture.current = {
                        id: node.id,
                        pointer: e.pointerId,
                        x: point.x,
                        y: point.y,
                        panX: camera.x,
                        panY: camera.y,
                        offsetX: (point.x - 450 - camera.x) / zoom + 450 - p.x,
                        offsetY: (point.y - 310 - camera.y) / zoom + 310 - p.y,
                      };
                      svg.current?.setPointerCapture(e.pointerId);
                      motion.move(node.id, p.x, p.y);
                    }}
                    onKeyDown={e => {
                      if (
                        [
                          'ArrowUp',
                          'ArrowDown',
                          'ArrowLeft',
                          'ArrowRight',
                        ].includes(e.key)
                      ) {
                        e.preventDefault();
                        e.stopPropagation();
                        const delta = e.shiftKey ? 20 : 8;
                        motion.move(
                          node.id,
                          p.x +
                            (e.key === 'ArrowRight'
                              ? delta
                              : e.key === 'ArrowLeft'
                                ? -delta
                                : 0),
                          p.y +
                            (e.key === 'ArrowDown'
                              ? delta
                              : e.key === 'ArrowUp'
                                ? -delta
                                : 0)
                        );
                        motion.release();
                      }
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        select(node.id);
                      }
                    }}
                    className="dg-node"
                  >
                    <title>{node.title}</title>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={size + 9}
                      fill={active ? p.color + '22' : 'transparent'}
                      stroke={active ? p.color + '55' : 'none'}
                    />
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={size}
                      fill={p.color}
                      stroke="var(--affine-background-primary-color, #fff)"
                      strokeWidth="2.5"
                    />
                    <text
                      x={p.x}
                      y={p.y + size + 21}
                      textAnchor="middle"
                      fontSize={active ? 13 : 11.5}
                      fontWeight={active ? 650 : 450}
                      fill={
                        active
                          ? 'var(--affine-text-primary-color, #121212)'
                          : 'var(--affine-text-secondary-color, #77757d)'
                      }
                    >
                      {node.title.length > 26
                        ? node.title.slice(0, 24) + '…'
                        : node.title}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          {!visible.length && (
            <div className="dg-empty">
              No documents match this view.
              <button
                onClick={() => {
                  setQuery('');
                  setMode('all');
                  setGroup('All groups');
                }}
              >
                Clear filters
              </button>
            </div>
          )}
          <div className="dg-bottom">
            <div className="dg-legend">
              {groups.map((g, i) => (
                <span key={g}>
                  <i style={{ background: palette[i % palette.length] }} />
                  {g}
                </span>
              ))}
            </div>
            <div className="dg-zoom">
              <button
                aria-label="Reset layout"
                onClick={() => {
                  motion.reset();
                  setCamera({ zoom: 1, x: 0, y: 0 });
                }}
              >
                Reset
              </button>
              <button
                aria-pressed={motion.paused}
                disabled={motion.reduced}
                onClick={() => motion.setPaused(!motion.paused)}
              >
                {motion.reduced
                  ? 'Reduced motion'
                  : motion.paused
                    ? 'Resume'
                    : 'Pause'}
              </button>
              <button
                aria-label="Zoom out"
                disabled={zoom <= 0.5}
                onClick={() => setZoom(z => Math.max(0.5, z - 0.15))}
              >
                −
              </button>
              <button
                aria-label="Reset view"
                onClick={() => setCamera({ zoom: 1, x: 0, y: 0 })}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                aria-label="Zoom in"
                disabled={zoom >= 2.5}
                onClick={() => setZoom(z => Math.min(2.5, z + 0.15))}
              >
                +
              </button>
            </div>
          </div>
        </div>
        <aside className="dg-details">
          <div className="dg-eyebrow">DOCUMENT DETAILS</div>
          {current ? (
            <>
              <div className="dg-doc-icon">▤</div>
              <h2>{current.title}</h2>
              {current.summary && <p>{current.summary}</p>}
              <div className="dg-properties">
                {current.group && (
                  <div>
                    <span>Project</span>
                    <strong>{current.group}</strong>
                  </div>
                )}
                {current.status && (
                  <div>
                    <span>Status</span>
                    <strong className="dg-status">{current.status}</strong>
                  </div>
                )}
                {current.updated && (
                  <div>
                    <span>Updated</span>
                    <strong>{current.updated}</strong>
                  </div>
                )}
              </div>
              {onOpen && current.kind !== 'folder' && (
                <button className="dg-open" onClick={() => onOpen(current.id)}>
                  Open document <span>↗</span>
                </button>
              )}
              <h3>
                Links to <span>{outgoing.length}</span>
              </h3>
              {outgoing.map(edge => (
                <button
                  className="dg-related"
                  key={edge.target}
                  onClick={() => select(edge.target)}
                >
                  <span>↗</span>
                  {nodes.find(n => n.id === edge.target)?.title}
                </button>
              ))}
              {!outgoing.length && (
                <p className="dg-muted">No outgoing links in this view.</p>
              )}
              <h3>
                Referenced by <span>{incoming.length}</span>
              </h3>
              {incoming.map(edge => (
                <button
                  className="dg-related"
                  key={edge.source}
                  onClick={() => select(edge.source)}
                >
                  <span>↙</span>
                  {nodes.find(n => n.id === edge.source)?.title}
                </button>
              ))}
              {!incoming.length && (
                <p className="dg-muted">No backlinks in this view.</p>
              )}
            </>
          ) : (
            <p>Select a document to explore its connections.</p>
          )}
        </aside>
      </div>
      <footer className="dg-footer">
        {caption} · Drag nodes to arrange · Drag background to pan · Scroll to
        zoom · Double-click to open
      </footer>
    </section>
  );
}
const css = `
.dg-root{font:14px/1.5 var(--affine-font-family, Inter, sans-serif);color:var(--affine-text-primary-color, #121212);background:var(--affine-background-primary-color, #fff);border:1px solid var(--affine-border-color, #e3e2e4);border-radius:8px;overflow:hidden;min-width:0}.dg-root *{box-sizing:border-box}.dg-root button,.dg-root input,.dg-root select{font:inherit}.dg-root button{cursor:pointer}.dg-root button:focus-visible,.dg-node:focus-visible{outline:3px solid var(--affine-primary-color, #1e96eb);outline-offset:3px}.dg-toolbar{padding:15px 20px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--affine-border-color, #e3e2e4);flex-wrap:wrap}.dg-search{display:flex;align-items:center;gap:10px;flex:1;min-width:170px;color:var(--affine-text-secondary-color, #77757d)}.dg-search input{border:0;outline:none;width:100%;background:transparent;color:inherit}.dg-toolbar select{border:1px solid var(--affine-border-color, #e3e2e4);border-radius:7px;background:var(--affine-background-primary-color, #fff);padding:7px;color:var(--affine-text-secondary-color, #77757d)}.dg-segments{display:flex;background:var(--affine-background-secondary-color, #f4f4f5);padding:3px;border-radius:8px}.dg-segments button{border:0;background:none;padding:6px 10px;color:var(--affine-text-secondary-color, #77757d);font-size:12px;border-radius:6px}.dg-segments button[aria-pressed=true]{background:var(--affine-background-primary-color, #fff);color:var(--affine-text-secondary-color, #77757d);box-shadow:0 1px 4px #00000010}.dg-body{display:grid;grid-template-columns:minmax(0,1fr) 270px}.dg-canvas{position:relative;background:radial-gradient(var(--affine-edgeless-grid-color, #e6e6e6) .65px,transparent .65px) 0 0/22px 22px;min-width:0;min-height:470px;display:flex;align-items:center}.dg-canvas svg{width:100%;max-height:650px;min-height:440px}.dg-count{position:absolute;top:19px;left:22px;color:var(--affine-text-secondary-color, #77757d);font-size:12px}.dg-count span{margin:0 8px}.dg-node{cursor:grab}.dg-node:active{cursor:grabbing}.dg-canvas svg{touch-action:none;user-select:none;cursor:grab}.dg-canvas svg:active{cursor:grabbing}.dg-node:hover circle{filter:brightness(.93)}.dg-node text{paint-order:stroke;stroke:var(--affine-background-primary-color, #fff);stroke-width:4px;stroke-linejoin:round}.dg-details{border-left:1px solid var(--affine-border-color, #e3e2e4);padding:25px 23px;background:var(--affine-background-primary-color, #fff);overflow:auto;max-height:680px}.dg-eyebrow{font-size:10px;letter-spacing:1.5px;color:var(--affine-text-secondary-color, #77757d);font-weight:600}.dg-doc-icon{color:var(--affine-text-secondary-color, #77757d);margin-top:24px;font-size:27px}.dg-details h2{font-size:21px;line-height:1.3;font-weight:600;letter-spacing:-.6px;margin:12px 0}.dg-details p{font-size:12px;color:var(--affine-text-secondary-color, #77757d);line-height:1.7}.dg-properties{margin:24px 0}.dg-properties>div{display:flex;justify-content:space-between;gap:10px;margin:12px 0;font-size:11px}.dg-properties span{color:var(--affine-text-secondary-color, #77757d)}.dg-properties strong{font-weight:500}.dg-status{color:var(--affine-text-secondary-color, #77757d);background:var(--affine-background-secondary-color, #f4f4f5);border-radius:4px;padding:1px 6px}.dg-open{width:100%;background:var(--affine-background-secondary-color, #f4f4f5);color:var(--affine-text-secondary-color, #77757d);border:1px solid var(--affine-border-color, #e3e2e4);border-radius:7px;padding:9px;display:flex;justify-content:space-between;font-size:12px!important}.dg-details h3{font-size:12px;font-weight:600;margin:26px 0 8px}.dg-details h3 span{color:var(--affine-text-secondary-color, #77757d);margin-left:6px;font-weight:400}.dg-related{display:flex;align-items:center;gap:10px;text-align:left;background:none;border:0;width:100%;padding:8px 0;font-size:12px!important;color:var(--affine-text-secondary-color, #77757d)}.dg-related:hover{color:var(--affine-text-secondary-color, #77757d)}.dg-related>span{color:var(--affine-text-secondary-color, #77757d)}.dg-muted{font-size:11px!important}.dg-bottom{position:absolute;bottom:18px;left:20px;right:20px;display:flex;align-items:end;justify-content:space-between;gap:15px}.dg-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--affine-text-secondary-color, #77757d);font-size:10px}.dg-legend span{display:flex;align-items:center;gap:5px}.dg-legend i{width:6px;height:6px;border-radius:100%}.dg-zoom{display:flex;border:1px solid var(--affine-border-color, #e3e2e4);background:var(--affine-background-primary-color, #fff);border-radius:7px;flex-shrink:0}.dg-zoom button{border:0;background:none;padding:5px 9px;color:var(--affine-text-secondary-color, #77757d);font-size:11px}.dg-zoom button:disabled{opacity:.3}.dg-footer{font-size:10px;color:var(--affine-text-secondary-color, #77757d);padding:11px 20px;border-top:1px solid var(--affine-border-color, #e3e2e4)}.dg-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:15px;pointer-events:none}.dg-empty button{pointer-events:auto;border:0;background:var(--affine-background-secondary-color, #f4f4f5);border-radius:8px;padding:8px 16px;color:var(--affine-text-secondary-color, #77757d)}@media(max-width:900px){.dg-body{grid-template-columns:1fr}.dg-details{border-left:0;border-top:1px solid var(--affine-border-color, #e3e2e4);max-height:350px}.dg-canvas{min-height:420px}.dg-toolbar{padding:12px}.dg-segments{overflow:auto;max-width:100%}}
`;
