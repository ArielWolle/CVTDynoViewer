import { describe, expect, it } from 'vitest'
import fixtureCsv from '../../tests/fixtures/real/reference-run-raw.csv?raw'
import manifest from '../../tests/fixtures/real/reference-run.manifest.json'
import { parseRawLog } from '../analysis/rawCsv'
import { AnalysisEngine } from '../analysis/engine'
import type { AnalysisConfig } from '../analysis/types'
import { DataQualityMonitor } from './dataQuality'

/**
 * Historical 23CVT measurements, not synthetic sensor data. The embedded metadata
 * was ADDED for reproducible replay from contemporary viewer defaults; the original
 * 2026-10-16 hardware CSV had none. In particular, 16/12 tooth counts and the
 * engine curve are unverified defaults, not independently measured rig settings.
 */
describe('real recorded RPM anomaly regression', () => {
  const parsed = parseRawLog(fixtureCsv)

  it('retains the exact committed fixture bytes and unmodified original packet fields', async () => {
    const bytes = new TextEncoder().encode(fixtureCsv)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    expect(hash).toBe(manifest.fixture.sha256)
    expect(parsed.packets).toHaveLength(manifest.selection.packetCount)
    expect(parsed.packets[0].tUs).toBe(manifest.selection.firmwareUsStart)
    expect(parsed.packets.at(-1)?.tUs).toBe(manifest.selection.firmwareUsEnd)

    for (const [channel, expected] of Object.entries(manifest.selection.channelPacketCounts)) {
      expect(parsed.packets.filter((packet) => packet.channel === Number(channel))).toHaveLength(expected)
    }
    expect(parsed.packets.every((packet) => packet.channel === 0 || packet.channel === 1)).toBe(true)
    expect(parsed.packets.every((packet) => Number.isInteger(packet.tUs) && packet.value > 0)).toBe(true)

    // Global packet arrival order is intentionally NOT resorted: captures from
    // different shaft channels may carry slightly out-of-order firmware timestamps.
    expect(parsed.packets.some((packet, index) =>
      index > 0 && packet.tUs < parsed.packets[index - 1].tUs)).toBe(true)
  })

  it('loads declared reconstructed metadata without falsely claiming original setup provenance', () => {
    expect(parsed.metadata).toEqual(manifest.fixture.reconstructedMetadata)
    expect(manifest.source.hasEmbeddedMetadata).toBe(false)
    expect(manifest.fixture.metadataAdded).toBe(true)
    expect(manifest.fixture.noCleanStopFooterBecauseExcerpt).toBe(true)
    expect(parsed.metadata?.stoppedAt).toBeUndefined()
    expect(parsed.metadata?.primaryTeeth).toBe(16)
    expect(parsed.metadata?.secondaryTeeth).toBe(12)
  })

  it('reproduces the real sensor timing irregularities, not imaginary USB or firmware packet losses', () => {
    const monitor = new DataQualityMonitor()
    for (const packet of parsed.packets) monitor.ingest(packet)
    const quality = monitor.snapshot()
    const expected = manifest.expectedObservedDataQuality

    expect(quality.transmissionPacketsLost).toBe(expected.transmissionPacketsLost)
    expect(quality.deviceEdgesLost).toEqual(expected.deviceEdgesLost)
    expect(quality.suspectedSensorPulses).toEqual(expected.suspectedSensorPulses)
    expect(quality.events).toHaveLength(expected.eventCount)
    expect(quality.events[0]).toMatchObject(expected.firstEvent)
    expect(quality.events.at(-1)).toMatchObject(expected.lastEvent)

    for (const anchor of expected.sampleEventAnchors) {
      expect(quality.events.some((event) =>
        event.kind === anchor.kind && event.channel === anchor.channel
        && event.startMs === anchor.startMs && event.endMs === anchor.endMs)).toBe(true)
    }
    expect(quality.events.every((event) => event.kind === 'suspected-missed-pulse' && event.channel === 0)).toBe(true)
  })

  it('produces usable shaft RPM and ratio from the original per-tooth measurements', () => {
    const m = parsed.metadata
    expect(m).not.toBeNull()
    const config: AnalysisConfig = {
      windowMs: m!.analysisWindowMs!,
      primaryTeeth: m!.primaryTeeth!,
      secondaryTeeth: m!.secondaryTeeth!,
      secondaryInertiaKgM2: m!.secondaryInertiaKgM2!,
      powerMode: m!.powerMode!,
      torqueCurve: m!.torqueCurve!,
      torqueScale: m!.torqueScale!,
      torqueOffset: m!.torqueOffset!,
    }
    const engine = new AnalysisEngine(config)
    engine.ingestMany(parsed.packets)
    const snapshot = engine.snapshot()

    expect(snapshot.primaryRpm.length).toBeGreaterThan(30)
    expect(snapshot.secondaryRpm.length).toBeGreaterThan(30)
    expect(snapshot.ratio.length).toBeGreaterThan(30)
    expect(snapshot.primaryRpm.every((p) => Number.isFinite(p.rpm) && p.rpm > 0)).toBe(true)
    expect(snapshot.secondaryRpm.every((p) => Number.isFinite(p.rpm) && p.rpm > 0)).toBe(true)
    expect(snapshot.shift).toHaveLength(0)

    // Per-tooth observations used for analysis must not retain the suspect
    // period itself: its reciprocal RPM is not a defensible shaft-speed estimate.
    const monitor = new DataQualityMonitor()
    for (const packet of parsed.packets) monitor.ingest(packet)
    const suspectEvents = monitor.snapshot().events
    const allToothTimes = new Set(engine.observationView('tooth', 0, 1_000_000, 10_000).primary.map((p) => p.time))
    for (const event of suspectEvents) {
      expect(allToothTimes.has(event.endMs)).toBe(false)
    }

    const firstPrimary = parsed.packets.find((packet) => packet.channel === 0)!
    const firstMs = firstPrimary.tUs / 1000
    const tooth = engine.observationView('tooth', firstMs, firstMs + 20, 100).primary[0]
    expect(tooth.time).toBe(firstMs)
    expect(tooth.rpm).toBeCloseTo(60_000_000 / (firstPrimary.value * config.primaryTeeth), 8)

    // A stable config recalculation should reproduce the same derived results
    // rather than depend on a previous replay or measurement session.
    const before = engine.snapshot()
    engine.setConfig(config)
    expect(engine.snapshot()).toEqual(before)
  })
  it('does not compute 250 ms power across a detected bad-sensor interval', () => {
    const m = parsed.metadata!
    const engine = new AnalysisEngine({
      windowMs: 250,
      primaryTeeth: m.primaryTeeth!, secondaryTeeth: m.secondaryTeeth!,
      secondaryInertiaKgM2: m.secondaryInertiaKgM2!,
      powerMode: m.powerMode!, torqueCurve: m.torqueCurve!,
      torqueScale: m.torqueScale!, torqueOffset: m.torqueOffset!,
    })
    const quality = new DataQualityMonitor()
    for (const packet of parsed.packets) {
      quality.ingest(packet)
      engine.ingest(packet)
    }
    const suspectIntervals = quality.snapshot().events
    const computed = engine.snapshot().primaryPower
    expect(suspectIntervals).toHaveLength(89)
    expect(computed.length).toBeGreaterThan(0)
    for (const point of computed) {
      // Every genuine numerical power window must have valid RPM information
      // for its FULL 250 ms support, not just plausible-looking endpoints.
      const crossesSuspect = suspectIntervals.some((event) =>
        event.endMs >= point.time - 250 && event.startMs <= point.time)
      expect(crossesSuspect).toBe(false)
    }
  })

})
