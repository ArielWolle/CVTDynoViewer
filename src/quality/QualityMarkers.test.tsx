import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { QualityEvent } from './dataQuality'
import { QualityChartOverlay, QualityTimeline } from './QualityMarkers'
import { canConnectAcrossQuality } from '../analysis/TelemetryCanvas'

const events: QualityEvent[] = [
  { id: 1, kind: 'device-edge-loss', channel: 0, startMs: 1100, endMs: 1110, count: 2 },
  { id: 2, kind: 'suspected-missed-pulse', channel: 1, startMs: 1250, endMs: 1252, count: 1 },
]

describe('visual annotation of data quality', () => {
  it('does not connect curves through observed or suspected data-quality intervals', () => {
    expect(canConnectAcrossQuality(1090, 1099, events)).toBe(true)
    expect(canConnectAcrossQuality(1090, 1115, events)).toBe(false)
    expect(canConnectAcrossQuality(1240, 1255, events)).toBe(false)
    expect(canConnectAcrossQuality(1150, 1200, events)).toBe(true)
  })

  it('shows full-run event locations in a persistent, described quality strip', () => {
    const markup = renderToStaticMarkup(
      <QualityTimeline events={events} startMs={1000} endMs={1400} originMs={1000} />,
    )
    expect(markup).toContain('Data quality')
    expect(markup).toContain('2 events')
    expect(markup).toContain('quality-timeline-marker confirmed')
    expect(markup).toContain('quality-timeline-marker suspected')
    expect(markup).toContain('Primary RPM')
    expect(markup).toContain('Secondary RPM')
  })

  it('draws plot markers using the exact geometry of the chart viewport', () => {
    const markup = renderToStaticMarkup(
      <QualityChartOverlay events={events} plot={{ left: 20, top: 10, width: 400, height: 200 }}
        startMs={1000} endMs={1400} originMs={1000} />,
    )
    expect(markup).toContain('quality-chart-marker confirmed')
    expect(markup).toContain('quality-chart-marker suspected')
    expect(markup).toContain('left:120px')
    expect(markup).toContain('height:200px')
  })

  it('suppresses marker surfaces when no events are within view', () => {
    const markup = renderToStaticMarkup(
      <QualityChartOverlay events={events} plot={{ left: 0, top: 0, width: 400, height: 200 }}
        startMs={2000} endMs={2500} originMs={1000} />,
    )
    expect(markup).toBe('')
  })
})
