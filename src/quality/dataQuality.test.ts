import { describe, expect, it } from 'vitest'
import type { AnalysisPacket, AnalysisChannelId } from '../analysis/types'
import { affectsChart, DataQualityMonitor, qualityEventLabel } from './dataQuality'

function edge(channel: 0 | 1, seq: number, count: number, timeUs: number, periodUs: number): AnalysisPacket {
  return { channel, seq, edgeCount: count, tUs: timeUs, value: periodUs }
}

function regular(monitor: DataQualityMonitor, count = 8, periodUs = 1000, channel: 0 | 1 = 0) {
  for (let n = 1; n <= count; n++) monitor.ingest(edge(channel, n, n, 1_000_000 + n * periodUs, periodUs))
}

describe('data quality event detection', () => {
  it('does not flag normal per-tooth timing on either shaft', () => {
    const monitor = new DataQualityMonitor()
    regular(monitor, 16, 1000, 0)
    regular(monitor, 16, 2200, 1)
    expect(monitor.snapshot().events).toEqual([])
  })

  it('suspects one missed sensor pulse after an isolated approximately doubled period', () => {
    const monitor = new DataQualityMonitor()
    regular(monitor)
    monitor.ingest(edge(0, 9, 9, 1_010_000, 2000))
    // Do not conclude a missing pulse until observing a return to the previous cadence.
    expect(monitor.snapshot().suspectedSensorPulses).toEqual([0, 0])
    monitor.ingest(edge(0, 10, 10, 1_011_000, 1000))
    const snapshot = monitor.snapshot()
    expect(snapshot.suspectedSensorPulses).toEqual([1, 0])
    expect(snapshot.transmissionPacketsLost).toBe(0)
    expect(snapshot.deviceEdgesLost).toEqual([0, 0])
    expect(snapshot.events).toMatchObject([
      { kind: 'suspected-missed-pulse', channel: 0, startMs: 1008, endMs: 1010, count: 1 },
    ])
    expect(qualityEventLabel(snapshot.events[0])).toContain('suspected missed sensor pulse')
  })

  it('does not mistake a sustained halving of RPM for a missing tooth', () => {
    const monitor = new DataQualityMonitor()
    regular(monitor)
    monitor.ingest(edge(0, 9, 9, 1_010_000, 2000))
    monitor.ingest(edge(0, 10, 10, 1_012_000, 2000))
    monitor.ingest(edge(0, 11, 11, 1_014_000, 2000))
    expect(monitor.snapshot().suspectedSensorPulses).toEqual([0, 0])
  })

  it('distinguishes packet loss from earlier firmware ring-buffer loss', () => {
    const monitor = new DataQualityMonitor()
    monitor.ingest(edge(0, 10, 100, 1_000_000, 1000))
    monitor.ingest(edge(0, 12, 102, 1_002_000, 1000))
    monitor.ingest(edge(0, 13, 104, 1_004_000, 1000))
    const snapshot = monitor.snapshot()
    expect(snapshot.transmissionPacketsLost).toBe(1)
    expect(snapshot.deviceEdgesLost).toEqual([1, 0])
    expect(snapshot.events.map((ev) => ev.kind)).toEqual(['transmission-loss', 'device-edge-loss'])
  })

  it('does not infer sensor misses when there is known telemetry loss', () => {
    const monitor = new DataQualityMonitor()
    regular(monitor)
    monitor.ingest(edge(0, 10, 10, 1_010_000, 2000))
    monitor.ingest(edge(0, 11, 11, 1_011_000, 1000))
    expect(monitor.snapshot().suspectedSensorPulses).toEqual([0, 0])
  })

  it('resets counter baselines on stopped reports and deliberate channel toggles', () => {
    const monitor = new DataQualityMonitor()
    regular(monitor)
    monitor.ingest(edge(0, 9, 8, 1_600_000, 0))
    monitor.ingest(edge(0, 10, 200, 1_601_000, 1000))
    monitor.resetChannel(0)
    monitor.ingest(edge(0, 90, 5000, 1_800_000, 1000))
    expect(monitor.snapshot().transmissionPacketsLost).toBe(0)
    expect(monitor.snapshot().deviceEdgesLost).toEqual([0, 0])
    monitor.reset()
    expect(monitor.snapshot().events).toEqual([])
  })

  it('handles rolling uint8 sequence and uint32 edge-counter wrap', () => {
    const monitor = new DataQualityMonitor()
    monitor.ingest(edge(1, 255, 0xffff_ffff, 1_000_000, 1000))
    monitor.ingest(edge(1, 0, 0, 1_001_000, 1000))
    expect(monitor.snapshot().events).toHaveLength(0)
  })

  it('routes timing-related quality markers only to meaningful charts', () => {
    const event = { id: 1, kind: 'device-edge-loss' as const, channel: 0 as AnalysisChannelId, startMs: 1000, endMs: 1001, count: 1 }
    expect(affectsChart(event, 'rpm1', 'inertia')).toBe(true)
    expect(affectsChart(event, 'rpm2', 'inertia')).toBe(false)
    expect(affectsChart(event, 'power', 'inertia')).toBe(true)
    expect(affectsChart(event, 'scatter', 'inertia')).toBe(false)
    expect(affectsChart({ ...event, channel: 3 }, 'power', 'torque')).toBe(true)
    expect(affectsChart({ ...event, channel: 3 }, 'power', 'inertia')).toBe(false)
  })
})
