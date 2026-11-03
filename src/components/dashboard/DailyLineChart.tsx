'use client';

import { useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface DailyLinePoint {
  date: string;
  label: string;
  reads: number;
  writes: number;
  meta: number;
}

const SERIES = [
  { key: 'reads', name: 'read', color: '#0ca5bd' },
  { key: 'writes', name: 'write', color: '#8b5cf6' },
  { key: 'meta', name: 'meta', color: '#ec4899' },
] as const;

const WIDTH = 720;
const HEIGHT = 240;
const PAD = { top: 14, right: 56, bottom: 26, left: 40 };
const PLOT_W = WIDTH - PAD.left - PAD.right;
const PLOT_H = HEIGHT - PAD.top - PAD.bottom;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude * 4 >= value) ?? 10;
  return step * magnitude * 4;
}

/** 系列末尾の直接ラベルが重ならないよう、y座標を最小間隔で押し広げる。 */
function spreadLabels(ys: number[], gap: number): number[] {
  const order = ys.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < order.length; i += 1) {
    if (order[i].y - order[i - 1].y < gap) order[i].y = order[i - 1].y + gap;
  }
  const result = [...ys];
  for (const item of order) result[item.index] = item.y;
  return result;
}

export function DailyLineChart({ points }: { points: DailyLinePoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const yMax = niceMax(Math.max(0, ...points.flatMap((point) => [point.reads, point.writes, point.meta])));
  const ticks = [0, 1, 2, 3, 4].map((step) => (yMax / 4) * step);
  const x = (index: number) => PAD.left + (points.length <= 1 ? PLOT_W / 2 : (index / (points.length - 1)) * PLOT_W);
  const y = (value: number) => PAD.top + PLOT_H - (value / yMax) * PLOT_H;
  const last = points.length - 1;
  const labelYs = last >= 0 ? spreadLabels(SERIES.map((series) => y(points[last][series.key])), 13) : [];
  const xLabelIndexes = [...new Set([0, Math.floor(last / 2), last])].filter((index) => index >= 0);

  function indexFromPointer(event: PointerEvent<SVGRectElement>): number {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    return Math.min(last, Math.max(0, Math.round(ratio * last)));
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      setActive((current) => Math.min(last, Math.max(0, (current ?? (delta > 0 ? -1 : last + 1)) + delta)));
    } else if (event.key === 'Escape') {
      setActive(null);
    }
  }

  const activePoint = active === null ? null : points[active];
  const tooltipLeft = active === null ? 0 : (x(active) / WIDTH) * 100;

  return (
    <div className="daily-chart">
      <ul className="daily-chart-legend" aria-label="凡例">
        {SERIES.map((series) => (
          <li key={series.key}><span className="daily-chart-swatch" style={{ background: series.color }} />{series.name}</li>
        ))}
      </ul>
      <div className="daily-chart-plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label="日次推移の折れ線グラフ（read・write・meta）。左右キーで日付ごとの値を表示"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="daily-chart-grid" x1={PAD.left} x2={PAD.left + PLOT_W} y1={y(tick)} y2={y(tick)} />
              <text className="daily-chart-axis" x={PAD.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">{tick}</text>
            </g>
          ))}
          {xLabelIndexes.map((index) => (
            <text
              key={index}
              className="daily-chart-axis"
              x={x(index)}
              y={HEIGHT - 6}
              textAnchor={index === 0 && last > 0 ? 'start' : index === last && last > 0 ? 'end' : 'middle'}
            >
              {points[index].label}
            </text>
          ))}
          {SERIES.map((series) => (
            <polyline
              key={series.key}
              fill="none"
              stroke={series.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={points.map((point, index) => `${x(index)},${y(point[series.key])}`).join(' ')}
            />
          ))}
          {last >= 0 ? SERIES.map((series, index) => (
            <text key={series.key} className="daily-chart-end-label" x={x(last) + 8} y={labelYs[index]} dominantBaseline="middle">
              {series.name}
            </text>
          )) : null}
          {activePoint && active !== null ? (
            <g pointerEvents="none">
              <line className="daily-chart-crosshair" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + PLOT_H} />
              {SERIES.map((series) => (
                <circle key={series.key} cx={x(active)} cy={y(activePoint[series.key])} r={4.5} fill={series.color} stroke="#0f131f" strokeWidth={2} />
              ))}
            </g>
          ) : null}
          <rect
            x={PAD.left}
            y={PAD.top}
            width={PLOT_W}
            height={PLOT_H}
            fill="transparent"
            onPointerMove={(event) => setActive(indexFromPointer(event))}
            onPointerDown={(event) => setActive(indexFromPointer(event))}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {activePoint ? (
          <div
            className="daily-chart-tooltip"
            role="status"
            style={{ left: `${tooltipLeft}%`, transform: tooltipLeft > 60 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}
          >
            <strong>{activePoint.label}</strong>
            {SERIES.map((series) => (
              <span key={series.key}><i style={{ background: series.color }} />{series.name}<b>{activePoint[series.key]}</b></span>
            ))}
            <span className="daily-chart-total">合計<b>{activePoint.reads + activePoint.writes + activePoint.meta}</b></span>
          </div>
        ) : null}
      </div>
      <details className="daily-chart-table">
        <summary>表で表示</summary>
        <div className="table-scroll"><table>
          <thead><tr><th>日付</th><th>read</th><th>write</th><th>meta</th><th>合計</th></tr></thead>
          <tbody>{points.map((point) => (
            <tr key={point.date}>
              <td><time dateTime={point.date}>{point.label}</time></td>
              <td>{point.reads}</td><td>{point.writes}</td><td>{point.meta}</td>
              <td>{point.reads + point.writes + point.meta}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </details>
    </div>
  );
}
