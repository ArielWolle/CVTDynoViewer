import { useMemo } from 'react'
import type { PlotGeometry } from '../analysis/plotGeometry'
import type { QualityEvent } from './dataQuality'
import { qualityEventLabel } from './dataQuality'

type Group = {
  key: number
  left: number
  right: number
  kind: 'confirmed' | 'suspected'
  events: QualityEvent[]
}

function groupEvents(events: readonly QualityEvent[], startMs: number, endMs: number, widthPx: number): Group[] {
  const span = endMs - startMs
  if (!(span > 0) || !(widthPx > 0)) return []
  // Group events within ~5 pixels, preventing thousands of overlapping DOM nodes on
  // damaged runs. A long loss window still spans its full recorded interval.
  const binCount = Math.max(1, Math.floor(widthPx / 5))
  const groups = new Map<number, Group>()
  for (const event of events) {
    if (event.endMs < startMs || event.startMs > endMs) continue
    const mid = Math.max(startMs, Math.min(endMs, (event.startMs + event.endMs) / 2))
    const fraction = (mid - startMs) / span
    const bin = Math.max(0, Math.min(binCount - 1, Math.floor(fraction * binCount)))
    const left = Math.max(0, (event.startMs - startMs) / span)
    const right = Math.min(1, (event.endMs - startMs) / span)
    const kind = event.kind === 'suspected-missed-pulse' ? 'suspected' : 'confirmed'
    const group = groups.get(bin)
    if (group) {
      group.left = Math.min(group.left, left)
      group.right = Math.max(group.right, right)
      if (kind === 'confirmed') group.kind = kind
      group.events.push(event)
    } else {
      groups.set(bin, { key: bin, left, right, kind, events: [event] })
    }
  }
  return [...groups.values()].sort((a, b) => a.key - b.key)
}

function markerTitle(group: Group, originMs: number): string {
  const preview = group.events.slice(0, 6).map((event) => (
    ((event.startMs - originMs) / 1000).toFixed(3) + '–' +
    ((event.endMs - originMs) / 1000).toFixed(3) + ' s: ' +
    qualityEventLabel(event)
  )).join('\n')
  return group.events.length > 6 ? preview + '\n+' + (group.events.length - 6) + ' more nearby events' : preview
}

/** A persistent overview of affected times, aligned to the full-run time range. */
export function QualityTimeline({ events, startMs, endMs, originMs }: {
  events: readonly QualityEvent[]
  startMs: number
  endMs: number
  originMs: number
}) {
  const grouped = useMemo(() => groupEvents(events, startMs, endMs, 650), [events, startMs, endMs])
  if (!(endMs > startMs) || events.length === 0) return null
  return <div className="quality-timeline">
    <span className="quality-timeline-label">Data quality</span>
    <div className="quality-timeline-track" aria-label="Detected data-quality events across the run">
      {grouped.map((group) => (
        <span
          key={group.key}
          className={'quality-timeline-marker ' + group.kind}
          title={markerTitle(group, originMs)}
          aria-label={markerTitle(group, originMs)}
          tabIndex={0}
          style={{ left: group.left * 100 + '%', width: Math.max(0.5, (group.right - group.left) * 100) + '%' }}
        />
      ))}
    </div>
    <span className="quality-timeline-count">{events.length.toLocaleString()} event{events.length === 1 ? '' : 's'}</span>
  </div>
}

/** Shaded data gaps; displayed under the interactive crosshair and above the plot canvas. */
export function QualityChartOverlay({ events, plot, startMs, endMs, originMs }: {
  events: readonly QualityEvent[]
  plot: PlotGeometry | null
  startMs: number
  endMs: number
  originMs: number
}) {
  const groups = useMemo(() => groupEvents(events, startMs, endMs, plot?.width ?? 0), [events, startMs, endMs, plot?.width])
  if (!plot || groups.length === 0) return null
  return <div className="quality-chart-overlay" aria-hidden="true">
    {groups.map((group) => (
      <div
        key={group.key}
        className={'quality-chart-marker ' + group.kind}
        title={markerTitle(group, originMs)}
        style={{
          left: plot.left + group.left * plot.width + 'px',
          top: plot.top + 'px',
          height: plot.height + 'px',
          width: Math.max(3, (group.right - group.left) * plot.width) + 'px',
        }}
      />
    ))}
  </div>
}
