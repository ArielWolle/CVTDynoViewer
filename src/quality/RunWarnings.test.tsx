import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseRawLog } from '../analysis/rawCsv'
import { RawReplayController } from '../replay/rawReplay'
import { RAW_LOG_HEADER, RAW_METADATA_PREFIX } from '../session/rawFormat'
import { DataQualityMonitor, EMPTY_QUALITY_SNAPSHOT } from './dataQuality'
import { buildRunWarnings, compactWarningSummary, hasNewWarningInformation, RunWarnings } from './RunWarnings'

describe('visible run warnings', () => {
  it('shows independently keyed warnings alongside the three separate loss types', () => {
    const warnings = buildRunWarnings({
      usb: 'Simulated RP2040 disconnected after the unplug test',
      'replay-metadata': 'Older raw run has no embedded setup',
    }, {
      ...EMPTY_QUALITY_SNAPSHOT,
      transmissionPacketsLost: 2,
      deviceEdgesLost: [1, 0],
      suspectedSensorPulses: [0, 1],
    })
    expect(warnings.map((item) => item.label)).toEqual([
      'USB connection', 'Replay setup', 'Telemetry loss', 'RPM edge loss', 'Suspected sensor misses',
    ])
    const html = renderToStaticMarkup(<RunWarnings warnings={warnings} />)
    for (const warning of warnings) {
      expect(html).toContain(warning.label)
      expect(html).toContain(warning.message)
    }
    expect(html).not.toContain('<details')
    expect(html).not.toContain('other warning(s)')
    expect(html).toContain('warning-issues')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Minimize run warnings')
    expect(html).toContain('5 issues')
  })

  it('keeps minimized warnings specific, even when there is only one issue', () => {
    const usbWarning = buildRunWarnings({ usb: 'Virtual RP2040 disconnected as configured' }, EMPTY_QUALITY_SNAPSHOT)
    expect(compactWarningSummary(usbWarning)).toBe(
      'USB connection: Virtual RP2040 disconnected as configured',
    )
    const multiple = buildRunWarnings(
      { 'replay-metadata': 'Missing file metadata' },
      { ...EMPTY_QUALITY_SNAPSHOT, transmissionPacketsLost: 1, deviceEdgesLost: [2, 0], suspectedSensorPulses: [1, 0] },
    )
    expect(compactWarningSummary(multiple)).toBe(
      'Replay setup · Telemetry loss · RPM edge loss · +1 more',
    )
    expect(compactWarningSummary([])).toBe('')
  })

  it('notices new warning categories and updated loss counts without requiring an automatic reopen', () => {
    const first = buildRunWarnings({}, { ...EMPTY_QUALITY_SNAPSHOT, transmissionPacketsLost: 1 })
    const updated = buildRunWarnings({}, { ...EMPTY_QUALITY_SNAPSHOT, transmissionPacketsLost: 2 })
    const more = buildRunWarnings({ 'replay-metadata': 'No recorded setup' },
      { ...EMPTY_QUALITY_SNAPSHOT, transmissionPacketsLost: 2 })
    expect(hasNewWarningInformation(first, first)).toBe(false)
    expect(hasNewWarningInformation(first, updated)).toBe(true)
    expect(hasNewWarningInformation(updated, more)).toBe(true)
    expect(hasNewWarningInformation(more, more)).toBe(false)
  })

  it('replays a metadata-free and a metadata-equipped raw run, identifying all three gap categories', async () => {
    const lines = [RAW_LOG_HEADER]
    const push = (time: number, seq: number, period: number, edgeCount: number) => {
      lines.push([time, 1, 0, 'Primary RPM', seq, period, edgeCount].join(','))
    }
    // Contiguous normal teeth provide a local timing baseline.
    for (let n = 1; n <= 8; n++) push(1_000_000 + n * 1000, n, 1000, n)
    // A skipped physical pulse produces a 2x period but NO missing counter values.
    push(1_010_000, 9, 2000, 9)
    push(1_011_000, 10, 1000, 10)
    // A dropped transmitted packet creates a seq and edgeCount gap of one.
    push(1_013_000, 12, 1000, 12)
    // Firmware ring-buffer loss: edgeCount skips while transmit seq remains contiguous.
    push(1_014_000, 13, 1000, 14)

    for (const embedded of [false, true]) {
      const metadata = embedded
        ? RAW_METADATA_PREFIX + JSON.stringify({ schemaVersion: 1, startedAt: '2026-10-16T00:00:00Z' }) + '\n'
        : ''
      const parsed = parseRawLog(metadata + lines.join('\n'))
      expect(parsed.metadata !== null).toBe(embedded)
      const monitor = new DataQualityMonitor()
      // Exactly the callbacks wired by App.tsx for bulk raw-file analysis and replay.
      const controller = new RawReplayController({
        onBatch: (packets) => packets.forEach((packet) => monitor.ingest(packet)),
        onBulkBatch: async (packets) => { packets.forEach((packet) => monitor.ingest(packet)) },
        onReset: () => monitor.reset(),
        onState: () => undefined,
      })
      controller.load(parsed.packets)
      expect(await controller.showAll()).toBe(true)
      const result = monitor.snapshot()
      expect(result.transmissionPacketsLost).toBe(1)
      expect(result.deviceEdgesLost).toEqual([1, 0])
      expect(result.suspectedSensorPulses).toEqual([1, 0])
      expect(result.events.map((event) => event.kind)).toEqual([
        'suspected-missed-pulse', 'transmission-loss', 'device-edge-loss',
      ])
      const warnings = buildRunWarnings(
        embedded ? {} : { 'replay-metadata': 'No embedded setup; using current settings' },
        result,
      )
      expect(warnings).toHaveLength(embedded ? 3 : 4)
      expect(warnings.map((item) => item.label)).toContain('Suspected sensor misses')
      expect(warnings.map((item) => item.label)).toContain('RPM edge loss')
      expect(warnings.map((item) => item.label)).toContain('Telemetry loss')
    }
  })

  it('renders no warning banner for a clean dataset', () => {
    const warnings = buildRunWarnings({}, EMPTY_QUALITY_SNAPSHOT)
    expect(warnings).toEqual([])
    expect(renderToStaticMarkup(<RunWarnings warnings={warnings} />)).toBe('')
  })
})
