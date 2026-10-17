import { describe, expect, it } from 'vitest'
import type { QualityEvent } from '../quality/dataQuality'
import { selectShortRpmQualityBridges } from './rpmGapBridges'

const sensorEvent: QualityEvent = {
  id: 1, kind: 'suspected-missed-pulse', channel: 0,
  startMs: 1049, endMs: 1051, count: 1,
}
const edgeEvent: QualityEvent = {
  id: 2, kind: 'device-edge-loss', channel: 0,
  startMs: 2049, endMs: 2051, count: 2,
}

describe('display-only RPM gap bridging', () => {
  it('selects valid measured endpoints around a known short suspect interval', () => {
    const left = { time: 1000, rpm: 3000, epoch: 0 }
    const right = { time: 1100, rpm: 3100, epoch: 1 }
    expect(selectShortRpmQualityBridges([left, right], [sensorEvent], 250)).toEqual([
      { before: left, after: right },
    ])
  })

  it('never connects clean data, stopped-shaft epoch boundaries or long outages', () => {
    const before = { time: 1000, rpm: 3000, epoch: 0 }
    const after = { time: 1100, rpm: 3100, epoch: 1 }
    expect(selectShortRpmQualityBridges([before, after], [], 250)).toEqual([])
    expect(selectShortRpmQualityBridges([before, { ...after, epoch: 0 }], [sensorEvent], 250)).toEqual([])
    expect(selectShortRpmQualityBridges([before, { time: 3000, rpm: 1000, epoch: 1 }], [sensorEvent], 250)).toEqual([])
    expect(selectShortRpmQualityBridges([before, { time: 3000, rpm: 0, epoch: 1 }], [], 250)).toEqual([])
  })

  it('scales limited bridge lengths with the display interval, without affecting analysis values', () => {
    const points = [
      { time: 2000, rpm: 3500, epoch: 0 },
      { time: 2600, rpm: 3450, epoch: 1 },
    ]
    expect(selectShortRpmQualityBridges(points, [edgeEvent], 250)).toHaveLength(1)
    expect(selectShortRpmQualityBridges(points, [edgeEvent], 5)).toHaveLength(0)
    expect(points[0].rpm).toBe(3500)
    expect(points[1].rpm).toBe(3450)
  })
})
