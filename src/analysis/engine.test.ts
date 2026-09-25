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
})
