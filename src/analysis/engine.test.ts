import { describe, expect, it } from 'vitest'
import { AnalysisEngine } from './engine'
import { defaultEngineTorqueCurve } from './engineCurve'
import type { AnalysisConfig, AnalysisPacket } from './types'

function config(overrides: Partial<AnalysisConfig> = {}): AnalysisConfig {
  return {
    windowMs: 100,
    primaryTeeth: 16,
    secondaryTeeth: 12,
    secondaryInertiaKgM2: 0.3134,
    torqueCurve: [...defaultEngineTorqueCurve],
    powerMode: 'inertia',
    torqueScale: 0.01,
    torqueOffset: 0,
    ...overrides,
  }
}

function constantRpmPackets(channel: 0 | 1, teeth: number, rpm: number, seconds: number, offsetUs = 0): AnalysisPacket[] {
  const periodUs = 60_000_000 / (rpm * teeth)
  const result: AnalysisPacket[] = []
  for (let edge = 1, tUs = offsetUs + periodUs; tUs <= offsetUs + seconds * 1_000_000; edge += 1, tUs += periodUs) {
    result.push({ channel, value: Math.round(periodUs), tUs: Math.round(tUs), seq: edge & 0xff, edgeCount: edge })
  }
  return result
}

describe('AnalysisEngine independent streaming series', () => {
  it('keeps primary usable when secondary is absent', () => {
    const engine = new AnalysisEngine(config())
    engine.ingestMany(constantRpmPackets(0, 16, 3000, 1.2))
    const snapshot = engine.snapshot()
    expect(snapshot.primaryRpm.length).toBeGreaterThan(5)
    expect(snapshot.primaryPower.length).toBeGreaterThan(4)
    expect(snapshot.secondaryRpm).toEqual([])
    expect(snapshot.ratio).toEqual([])
    expect(snapshot.efficiency).toEqual([])
  })

  it('late secondary data creates joins without rewriting primary history', () => {
    const engine = new AnalysisEngine(config())
    const primary = constantRpmPackets(0, 16, 3000, 1.5)
    const secondary = constantRpmPackets(1, 12, 2000, 1.5, 5_000)
    engine.ingestMany(primary)
    const before = engine.snapshot()
    const counts = engine.counts()
    engine.ingestMany(secondary)
    const after = engine.snapshot()
    const delta = engine.snapshotFrom(counts)
    expect(after.primaryRpm).toEqual(before.primaryRpm)
    expect(after.primaryPower).toEqual(before.primaryPower)
    expect(delta.primaryRpm).toEqual([])
    expect(delta.primaryPower).toEqual([])
    expect(delta.ratio.length).toBeGreaterThan(5)
  })

  it('is invariant to cross-channel arrival order', () => {
    const primary = constantRpmPackets(0, 16, 3000, 1.5)
    const secondary = constantRpmPackets(1, 12, 2000, 1.5, 5_000)
    const orders = [
      [...primary, ...secondary],
      [...secondary, ...primary],
      [...primary, ...secondary].sort((a, b) => a.tUs - b.tUs),
    ]
    const snapshots = orders.map((packets) => { const engine = new AnalysisEngine(config()); engine.ingestMany(packets); return engine.snapshot() })
    for (const snapshot of snapshots.slice(1)) {
      expect(snapshot.primaryRpm).toEqual(snapshots[0].primaryRpm)
      expect(snapshot.secondaryRpm).toEqual(snapshots[0].secondaryRpm)
      expect(snapshot.primaryPower).toEqual(snapshots[0].primaryPower)
      expect(snapshot.secondaryPower).toEqual(snapshots[0].secondaryPower)
      expect(snapshot.ratio).toEqual(snapshots[0].ratio)
      expect(snapshot.efficiency).toEqual(snapshots[0].efficiency)
    }
  })

  it('uses the same physical interval for primary and secondary power', () => {
    const engine = new AnalysisEngine(config())
    engine.ingestMany([...constantRpmPackets(0, 16, 3000, 1.5), ...constantRpmPackets(1, 12, 2000, 1.5)].sort((a, b) => a.tUs - b.tUs))
    const snapshot = engine.snapshot()
    const primaryTimes = new Set(snapshot.primaryPower.map((point) => point.time))
    const joined = snapshot.secondaryPower.filter((point) => primaryTimes.has(point.time))
    expect(joined.length).toBeGreaterThan(5)
    expect(snapshot.efficiency.every((point) => primaryTimes.has(point.time))).toBe(true)
  })

  it('does not bridge a missing physical edge', () => {
    const packets = constantRpmPackets(0, 16, 3000, 1.2)
    packets.splice(30, 1)
    for (let i = 30; i < packets.length; i += 1) packets[i] = { ...packets[i], seq: (packets[i].seq + 1) & 0xff }
    const engine = new AnalysisEngine(config({ windowMs: 20 }))
    engine.ingestMany(packets)
    const observations = engine.observationView('revolution', 0, 2_000, 10_000).primary
    expect(observations.length).toBeLessThan(packets.length - 16)
  })

  it('serves either observation family as a viewer-only window query', () => {
    const engine = new AnalysisEngine(config())
    engine.ingestMany(constantRpmPackets(0, 16, 3000, 1.2))
    const before = engine.snapshot()
    const revolution = engine.observationView('revolution', 200, 1_000, 10_000).primary
    const tooth = engine.observationView('tooth', 200, 1_000, 10_000).primary
    const none = engine.observationView('none', 200, 1_000, 10_000).primary
    const after = engine.snapshot()
    expect(after.primaryRpm).toEqual(before.primaryRpm)
    expect(after.primaryPower).toEqual(before.primaryPower)
    expect(revolution.length).toBeGreaterThan(0)
    expect(tooth.length).toBeGreaterThan(0)
    expect(tooth[0].sigmaRpm).toBeGreaterThan(revolution[0].sigmaRpm)
    expect(tooth[0].sigmaRpm / revolution[0].sigmaRpm).toBeCloseTo(16, 6)
    expect(none).toEqual([])
  })

  it('caps observation queries without changing the stored analysis', () => {
    const engine = new AnalysisEngine(config())
    engine.ingestMany(constantRpmPackets(0, 16, 3000, 2.0))
    const before = engine.snapshot()
    const view = engine.observationView('tooth', 0, 2_000, 100)
    expect(view.primary).toHaveLength(100)
    expect(engine.snapshot()).toEqual(before)
  })
  it('preserves an explicit stopped RPM endpoint and restarts in a fresh epoch', () => {
    const engine = new AnalysisEngine(config({ windowMs: 5 }))
    const beforeStop = constantRpmPackets(0, 16, 3000, 0.6)
    engine.ingestMany(beforeStop)

    const last = beforeStop[beforeStop.length - 1]
    engine.ingest({ channel: 0, value: 0, tUs: 1_100_000, seq: (last.seq + 1) & 0xff, edgeCount: last.edgeCount })

    let snapshot = engine.snapshot()
    expect(snapshot.primaryRpm.at(-1)?.rpm).toBe(0)
    expect(snapshot.primaryPower.at(-1)?.powerKw).toBe(0)

    const restarted = constantRpmPackets(0, 16, 2500, 0.6, 61_000_000).map((packet, index) => ({
      ...packet,
      seq: (last.seq + 2 + index) & 0xff,
      edgeCount: last.edgeCount + 1 + index,
    }))
    engine.ingestMany(restarted)

    snapshot = engine.snapshot()
    const zeroIndex = snapshot.primaryRpm.findIndex((point) => point.rpm === 0)
    const firstRestart = snapshot.primaryRpm.slice(zeroIndex + 1).find((point) => point.rpm > 0)
    expect(firstRestart?.time).toBeGreaterThan(61_000)
    expect(firstRestart?.epoch).not.toBe(snapshot.primaryRpm[zeroIndex].epoch)
  })

  it('starts a new shift segment when a shift telemetry packet is known to be missing', () => {
    const engine = new AnalysisEngine(config())
    engine.ingest({ channel: 2, value: 10, tUs: 100_000, seq: 1, edgeCount: 0 })
    engine.ingest({ channel: 2, value: 20, tUs: 200_000, seq: 3, edgeCount: 0 })
    const shift = engine.snapshot().shift
    expect(shift).toHaveLength(2)
    expect(shift[0].epoch).not.toBe(shift[1].epoch)
  })

  it('rejects an isolated undetected tooth BEFORE it poisons sliding revolutions', () => {
    const periodUs = 1_250
    const all = Array.from({ length: 1_800 }, (_, index) => ({
      channel: 0 as const,
      tUs: 1_000_000 + (index + 1) * periodUs,
      value: periodUs,
      seq: (index + 1) & 0xff,
      edgeCount: index + 1,
    }))
    // A sensor missed tooth 201: timestamp of tooth 202 shows the 2x period,
    // but neither physical accepted-edge nor USB seq counters have a gap.
    const lostIndex = 200
    const gapPacketTime = all[lostIndex + 1].tUs
    const packets = all.filter((_, index) => index !== lostIndex).map((packet, index) => ({
      ...packet, seq: (index + 1) & 0xff, edgeCount: index + 1,
      value: packet.tUs === gapPacketTime ? 2 * periodUs : packet.value,
    }))

    const engine = new AnalysisEngine(config({ windowMs: 250 }))
    engine.ingestMany(packets)
    const snapshot = engine.snapshot()
    const tooth = engine.observationView('tooth', 0, 4_000, 5_000).primary
    const revolution = engine.observationView('revolution', 0, 4_000, 5_000).primary
    expect(tooth.some((item) => Math.abs(item.rpm - 1_500) < 0.01)).toBe(false)
    expect(revolution.length).toBeGreaterThan(500)
    expect(revolution.every((item) => Math.abs(item.rpm - 3_000) < 0.001)).toBe(true)
    expect(snapshot.primaryRpm.length).toBeGreaterThan(5)
    expect(snapshot.primaryRpm.every((item) => Math.abs(item.rpm - 3_000) < 0.001)).toBe(true)

    // The 250 ms window spanning the invalid epoch is OMITTED, not filled with
    // an artificial numerical value. Later valid windows resume.
    const invalidWindowEndMs = Math.ceil(gapPacketTime / 250_000) * 250
    expect(snapshot.primaryPower.some((point) => point.time === invalidWindowEndMs)).toBe(false)
    expect(snapshot.primaryPower.some((point) => point.time === invalidWindowEndMs + 250)).toBe(true)
    expect(snapshot.primaryPower.some((point) => point.time === invalidWindowEndMs - 250)).toBe(true)

    // Recomputing from source packets must preserve the same exclusions.
    const frozen = engine.snapshot()
    engine.setConfig(config({ windowMs: 250 }))
    expect(engine.snapshot()).toEqual(frozen)
  })

  it('keeps a genuine sustained 2x tooth period transition, rather than hiding valid deceleration', () => {
    const packets: AnalysisPacket[] = []
    let tUs = 1_000_000
    for (let index = 1; index <= 240; index += 1) {
      const periodUs = index <= 80 ? 1_250 : 2_500
      tUs += periodUs
      packets.push({ channel: 0, tUs, value: periodUs, seq: index & 0xff, edgeCount: index })
    }
    const engine = new AnalysisEngine(config({ windowMs: 20 }))
    engine.ingestMany(packets)
    const observations = engine.observationView('revolution', 0, 2_000, 1_000).primary
    expect(observations.some((point) => point.rpm > 2_900)).toBe(true)
    expect(observations.some((point) => point.rpm < 1_600 && point.rpm > 1_400)).toBe(true)
    expect(observations.some((point) => point.rpm > 1_600 && point.rpm < 2_900)).toBe(true)
  })

  it('still publishes a true terminal stop event without waiting for another tooth', () => {
    const packets = constantRpmPackets(0, 16, 3_000, 0.5, 1_000_000)
    const engine = new AnalysisEngine(config())
    engine.ingestMany(packets)
    const last = packets.at(-1)!
    const stopUs = last.tUs + 500_001
    engine.ingest({ channel: 0, tUs: stopUs, value: 0, seq: (last.seq + 1) & 0xff, edgeCount: last.edgeCount })
    expect(engine.snapshot().primaryRpm.at(-1)?.time).toBe(stopUs / 1_000)
    expect(engine.snapshot().primaryRpm.at(-1)?.rpm).toBe(0)
  })

})
