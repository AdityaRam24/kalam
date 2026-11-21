// Small chart kit for Trinetra pages. Plain HTML/SVG, no library.
// Rules followed (dataviz skill): thin marks, 2px gaps between segments, 4px
// rounded data ends, one y-axis, a legend whenever there are two or more
// series, text in text colours (never the series colour), status colours only
// with an icon + label, and a hover tooltip on every mark. The tables under
// each chart stay as the exact-number view.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { niceMax, SERIES_OTHER } from '../lib/charts';

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

export const ChartsToggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
    title={on ? 'Hide the charts (tables stay)' : 'Show charts above the tables'}
    className="btn secondary"
    style={{ padding: '5px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
    <BarChart3 size={13} /> Charts
    <span aria-hidden style={{
      width: 26, height: 14, borderRadius: 7, position: 'relative', flexShrink: 0,
      background: on ? 'var(--hpe-green)' : 'var(--border-strong)', transition: 'background var(--transition-fast)',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 14 : 2, width: 10, height: 10, borderRadius: '50%',
        background: '#fff', transition: 'left var(--transition-fast)',
      }} />
    </span>
  </button>
);

// ---------------------------------------------------------------------------
// Frame, legend, tooltip
// ---------------------------------------------------------------------------

export const ChartGrid: React.FC<{ children: React.ReactNode; min?: number }> = ({ children, min = 420 }) => (
  <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))`, gap: 16 }}>{children}</div>
);

export const ChartCard: React.FC<{ title: string; icon?: React.ReactNode; note?: string; legend?: LegendItem[]; children: React.ReactNode }> = ({ title, icon, note, legend, children }) => (
  <div className="panel-card" style={{ minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 650, color: 'var(--text-heading)' }}>{icon}{title}</div>
      {note && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{note}</span>}
    </div>
    {legend && legend.length > 0 && <Legend items={legend} />}
    {children}
  </div>
);

export interface LegendItem { label: string; color: string; icon?: React.ReactNode; marker?: 'square' | 'line' | 'dot' | 'ring' }

export const Legend: React.FC<{ items: LegendItem[] }> = ({ items }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
    {items.map((it) => (
      <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {it.icon ?? <Swatch color={it.color} marker={it.marker} />}
        {it.label}
      </span>
    ))}
  </div>
);

const Swatch: React.FC<{ color: string; marker?: LegendItem['marker'] }> = ({ color, marker = 'square' }) => {
  if (marker === 'line') return <span style={{ width: 14, height: 2, borderRadius: 1, background: color, display: 'inline-block' }} />;
  if (marker === 'dot') return <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />;
  if (marker === 'ring') return <span style={{ width: 8, height: 8, borderRadius: '50%', border: `2px solid ${color}`, background: 'var(--bg-card)', display: 'inline-block', boxSizing: 'border-box' }} />;
  return <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />;
};

interface Tip { x: number; y: number; content: React.ReactNode }

/** Positions a tooltip inside a relative container, flipped so it never leaves it. */
const Tooltip: React.FC<{ tip: Tip | null; width: number }> = ({ tip, width }) => {
  if (!tip) return null;
  const left = tip.x > width - 200 ? undefined : tip.x + 12;
  const right = tip.x > width - 200 ? Math.max(0, width - tip.x + 12) : undefined;
  return (
    <div role="tooltip" style={{
      position: 'absolute', top: Math.max(0, tip.y - 8), left, right, zIndex: 5, pointerEvents: 'none',
      background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, boxShadow: 'var(--shadow-md)',
      padding: '7px 9px', fontSize: 11.5, color: 'var(--text-primary)', minWidth: 140, maxWidth: 280,
    }}>{tip.content}</div>
  );
};

export const TipRow: React.FC<{ color?: string; marker?: LegendItem['marker']; label: React.ReactNode; value: React.ReactNode }> = ({ color, marker, label, value }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-secondary)', minWidth: 0 }}>
      {color && <Swatch color={color} marker={marker} />}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </span>
    <strong style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{value}</strong>
  </div>
);

export const TipTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontWeight: 650, color: 'var(--text-heading)', marginBottom: 4, overflowWrap: 'anywhere' }}>{children}</div>
);

/** A callback ref plus the element's live width — works when the element mounts later (after data loads). */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, React.MutableRefObject<T | null>, number] {
  const node = useRef<T | null>(null);
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  const ref = useCallback((e: T | null) => { node.current = e; setEl(e); }, []);
  useLayoutEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [ref, node, w];
}

/** Hover tooltip state relative to a container. */
function useTip<T extends HTMLElement>() {
  const [ref, node, width] = useWidth<T>();
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: React.MouseEvent, content: React.ReactNode) => {
    const r = node.current?.getBoundingClientRect();
    if (!r) return;
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, content });
  };
  return { ref, width, tip, show, hide: () => setTip(null) };
}

// ---------------------------------------------------------------------------
// Horizontal bars (optionally stacked)
// ---------------------------------------------------------------------------

export interface BarSeg { value: number; color: string; label: string; text?: string }
export interface BarRow { key: string; label: string; sub?: string; segs: BarSeg[]; valueText?: string; icon?: React.ReactNode; title?: string; onClick?: () => void }

export const BarList: React.FC<{ rows: BarRow[]; max?: number; empty?: string; labelWidth?: string }> = ({ rows, max, empty = 'Nothing to show yet.', labelWidth = 'minmax(90px, 32%)' }) => {
  const { ref, width, tip, show, hide } = useTip<HTMLDivElement>();
  const top = max ?? Math.max(0, ...rows.map((r) => r.segs.reduce((a, s) => a + Math.max(0, s.value), 0)));
  if (!rows.length || !(top > 0)) return <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{empty}</p>;
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseLeave={hide}>
      <div role="list" style={{ display: 'grid', gridTemplateColumns: `${labelWidth} minmax(60px, 1fr) auto`, columnGap: 10, rowGap: 2, alignItems: 'center' }}>
        {rows.map((r) => {
          const segs = r.segs.filter((s) => s.value > 0);
          const total = r.segs.reduce((a, s) => a + Math.max(0, s.value), 0);
          const content = (
            <>
              <TipTitle>{r.title || r.label}</TipTitle>
              {r.segs.map((s) => <TipRow key={s.label} color={s.color} label={s.label} value={s.text ?? s.value.toLocaleString()} />)}
            </>
          );
          return (
            <div key={r.key} role="listitem" style={{ display: 'contents' }}>
              <div onMouseMove={(e) => show(e, content)} onClick={r.onClick}
                style={{ fontSize: 12, color: 'var(--text-primary)', minWidth: 0, padding: '4px 0', cursor: r.onClick ? 'pointer' : 'default' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {r.icon}<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.title || r.label}>{r.label}</span>
                </div>
                {r.sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sub}</div>}
              </div>
              <div onMouseMove={(e) => show(e, content)} onClick={r.onClick}
                style={{ height: 24, display: 'flex', alignItems: 'center', cursor: r.onClick ? 'pointer' : 'default' }}>
                <div style={{ display: 'flex', gap: 2, width: `${Math.min(100, (total / top) * 100)}%`, minWidth: segs.length ? 3 : 0, height: 12 }}>
                  {segs.map((s, i) => (
                    <div key={s.label} style={{
                      flex: `${s.value} 1 0`, minWidth: 2, background: s.color,
                      borderRadius: i === segs.length - 1 ? '0 4px 4px 0' : 0,
                    }} />
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {r.valueText ?? total.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// One 100% bar split by status (Ready / Needs prep / Blocked …)
// ---------------------------------------------------------------------------

export interface PartItem { key: string; label: string; value: number; color: string; icon: React.ReactNode; detail?: string }

export const PartBar: React.FC<{ items: PartItem[]; unit?: string }> = ({ items, unit = '' }) => {
  const { ref, width, tip, show, hide } = useTip<HTMLDivElement>();
  const total = items.reduce((a, i) => a + i.value, 0);
  if (!total) return <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>Nothing to show yet.</p>;
  const parts = items.filter((i) => i.value > 0);
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseLeave={hide}>
      <div style={{ display: 'flex', gap: 2, height: 22 }}>
        {parts.map((p, i) => (
          <div key={p.key} onMouseMove={(e) => show(e, <><TipTitle>{p.label}</TipTitle><TipRow label={p.detail || 'count'} value={`${p.value}${unit} · ${pct(p.value)}`} /></>)}
            style={{
              flex: `${p.value} 1 0`, minWidth: 4, background: p.color,
              borderRadius: parts.length === 1 ? 4 : i === 0 ? '4px 0 0 4px' : i === parts.length - 1 ? '0 4px 4px 0' : 0,
            }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
        {items.map((p) => (
          <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
            {p.icon}<span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{p.value}{unit}</span> {p.label}
            <span style={{ color: 'var(--text-muted)' }}>({pct(p.value)})</span>
          </span>
        ))}
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Typical → worst range per row (e.g. latency p50 → p95)
// ---------------------------------------------------------------------------

export interface RangeRow { key: string; label: string; lo?: number; hi?: number; sub?: string }

export const RangeList: React.FC<{ rows: RangeRow[]; fmt: (v: number) => string; loLabel: string; hiLabel: string; color: string }> = ({ rows, fmt, loLabel, hiLabel, color }) => {
  const { ref, width, tip, show, hide } = useTip<HTMLDivElement>();
  const usable = rows.filter((r) => r.lo !== undefined || r.hi !== undefined);
  const top = niceMax(Math.max(0, ...usable.map((r) => Math.max(r.lo ?? 0, r.hi ?? 0))));
  if (!usable.length) return <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>No latency reported yet.</p>;
  const x = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseLeave={hide}>
      <Legend items={[{ label: loLabel, color, marker: 'dot' }, { label: hiLabel, color, marker: 'ring' }]} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 32%) minmax(60px, 1fr)', columnGap: 10, alignItems: 'center' }}>
        {usable.map((r) => {
          const content = <><TipTitle>{r.label}</TipTitle>
            {r.lo !== undefined && <TipRow color={color} marker="dot" label={loLabel} value={fmt(r.lo)} />}
            {r.hi !== undefined && <TipRow color={color} marker="ring" label={hiLabel} value={fmt(r.hi)} />}</>;
          return (
            <React.Fragment key={r.key}>
              <div onMouseMove={(e) => show(e, content)} style={{ fontSize: 12, minWidth: 0, padding: '4px 0' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>{r.label}</div>
                {r.sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{r.sub}</div>}
              </div>
              <div onMouseMove={(e) => show(e, content)} style={{ position: 'relative', height: 24 }}>
                <div style={{ position: 'absolute', left: 0, right: 0, top: 11.5, height: 1, background: 'var(--viz-grid)' }} />
                {r.lo !== undefined && r.hi !== undefined && (
                  <div style={{ position: 'absolute', left: x(r.lo), width: `calc(${x(r.hi)} - ${x(r.lo)})`, top: 11, height: 2, background: color }} />
                )}
                {r.lo !== undefined && <span style={{ position: 'absolute', left: x(r.lo), top: 8, width: 8, height: 8, marginLeft: -4, borderRadius: '50%', background: color, boxShadow: '0 0 0 2px var(--bg-card)' }} />}
                {r.hi !== undefined && <span style={{ position: 'absolute', left: x(r.hi), top: 7, width: 10, height: 10, marginLeft: -5, borderRadius: '50%', border: `2px solid ${color}`, background: 'var(--bg-card)', boxSizing: 'border-box' }} />}
              </div>
            </React.Fragment>
          );
        })}
        <div />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--viz-axis)', paddingTop: 3, fontVariantNumeric: 'tabular-nums' }}>
          <span>0</span><span>{fmt(top / 2)}</span><span>{fmt(top)}</span>
        </div>
      </div>
      <Tooltip tip={tip} width={width} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Lines over time, one y-axis, crosshair + tooltip
// ---------------------------------------------------------------------------

export interface LineSeries { key: string; label: string; color: string; points: Array<{ t: number; v: number | null }> }

/** Keeps the first `keep` series and folds the rest into one summed "Other" line. */
export function foldSeries(series: LineSeries[], keep = 7): LineSeries[] {
  if (series.length <= keep + 1) return series;
  const head = series.slice(0, keep), rest = series.slice(keep);
  const grid = rest[0].points.map((p) => p.t);
  const points = grid.map((t, i) => {
    const vals = rest.map((s) => s.points[i]?.v).filter((v): v is number => v !== null && v !== undefined);
    return { t, v: vals.length ? vals.reduce((a, v) => a + v, 0) : null };
  });
  return [...head, { key: '__other', label: `${rest.length} others`, color: SERIES_OTHER, points }];
}

export const LineChart: React.FC<{ series: LineSeries[]; height?: number; fmt: (v: number) => string; empty?: string }> = ({ series, height = 180, fmt, empty = 'Not enough samples yet.' }) => {
  const { ref, width, tip, show, hide } = useTip<HTMLDivElement>();
  const [hoverI, setHoverI] = useState<number | null>(null);
  useEffect(() => { if (!tip) setHoverI(null); }, [tip]);
  const grid = series[0]?.points.map((p) => p.t) || [];
  const all = series.flatMap((s) => s.points.map((p) => p.v)).filter((v): v is number => v !== null);
  if (!series.length || all.filter((v) => v !== undefined).length < 2) return <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>{empty}</p>;

  const direct = series.length > 1 && series.length <= 4;
  const padL = 44, padR = direct ? 104 : 10, padT = 8, padB = 22;
  const W = Math.max(200, width), H = height;
  const iw = W - padL - padR, ih = H - padT - padB;
  const top = niceMax(Math.max(...all));
  const t0 = grid[0], t1 = grid[grid.length - 1] || t0 + 1;
  const x = (t: number) => padL + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => padT + ih - (v / top) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const xTicks = [0, 1, 2, 3].map((k) => t0 + ((t1 - t0) * k) / 3);
  const path = (pts: LineSeries['points']) => pts.map((p, i) => (p.v === null ? '' : `${i && pts[i - 1].v !== null ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)).join('');

  // Direct labels at each line's last value, nudged apart so they don't collide.
  const ends = direct ? series.map((s) => {
    const last = [...s.points].reverse().find((p) => p.v !== null);
    return last ? { s, y: y(last.v!) } : null;
  }).filter(Boolean) as Array<{ s: LineSeries; y: number }> : [];
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = t0 + ((px - padL) / iw) * (t1 - t0);
    let i = 0;
    for (let k = 1; k < grid.length; k++) if (Math.abs(grid[k] - t) < Math.abs(grid[i] - t)) i = k;
    setHoverI(i);
    const rows = series.map((s) => ({ s, v: s.points[i]?.v ?? null })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1));
    show(e, <><TipTitle>{hhmm(grid[i])}</TipTitle>{rows.map(({ s, v }) => <TipRow key={s.key} color={s.color} marker="line" label={s.label} value={v === null ? 'no sample' : fmt(v)} />)}</>);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color, marker: 'line' as const }))} />}
      <svg width={W} height={H} role="img" aria-label={`${series.length} series over time, peak ${fmt(Math.max(...all))}`}
        onMouseMove={onMove} onMouseLeave={hide} style={{ display: 'block', overflow: 'visible' }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={padL + iw} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--viz-axis)' : 'var(--viz-grid)'} strokeWidth={1} />
            <text x={padL - 6} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--text-muted)" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(v)}</text>
          </g>
        ))}
        {xTicks.map((t, k) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor={k === 0 ? 'start' : k === 3 ? 'end' : 'middle'} fontSize={10} fill="var(--text-muted)">{hhmm(t)}</text>
        ))}
        {hoverI !== null && grid[hoverI] !== undefined && (
          <line x1={x(grid[hoverI])} x2={x(grid[hoverI])} y1={padT} y2={padT + ih} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" />
        )}
        {series.map((s) => (
          <path key={s.key} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hoverI !== null && series.map((s) => {
          const v = s.points[hoverI]?.v;
          return v === null || v === undefined ? null
            : <circle key={s.key} cx={x(s.points[hoverI].t)} cy={y(v)} r={4} fill={s.color} stroke="var(--bg-card)" strokeWidth={2} />;
        })}
        {ends.map(({ s, y: ly }) => (
          <g key={s.key}>
            <circle cx={padL + iw + 8} cy={ly} r={3} fill={s.color} />
            <text x={padL + iw + 14} y={ly + 3.5} fontSize={10.5} fill="var(--text-secondary)">
              {(() => { const t = s.label.split('/').pop() || s.label; return t.length > 15 ? `${t.slice(0, 14)}…` : t; })()}
            </text>
          </g>
        ))}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
};
