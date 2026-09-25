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
    observationMode: 'revolution',
    ...overrides,
  }
}

function constantRpmPackets(channel: 0 | 1, teeth: number, rpm: number, seconds: number, edgeStart = 1): AnalysisPacket[] {
  const periodUs = 60_000_000 / (rpm * teeth)
  const count = Math.floor(seconds * rpm * teeth / 60)
  const packets: AnalysisPacket[] = []
  for (let i = 0; i < count; i += 1) {
    packets.push({ channel, value: Math.round(periodUs), tUs: Math.round((i + 1) * periodUs), seq: i & 0xff, edgeCount: edgeStart + i })
  }
  return packets
}

describe('AnalysisEngine', () => {
  it('reconstructs same-tooth-phase one-revolution RPM without crossing missing edges', () => {
    const engine = new AnalysisEngine(config())
    const packets = constantRpmPackets(0, 16, 3000, 0.4)
    engine.ingestMany(packets)
    const observations = engine.snapshot().primaryObservations
    expect(observations.length).toBeGreaterThan(100)
    expect(observations.at(-1)?.rpm).toBeCloseTo(3000, 0)

    const broken = new AnalysisEngine(config())
    const withGap = packets.map((packet) => ({ ...packet }))
    for (let i = 80; i < withGap.length; i += 1) withGap[i].edgeCount += 1
    broken.ingestMany(withGap)
    expect(broken.snapshot().primaryObservations.length).toBeLessThan(observations.length)
  })

  it('emits primary analysis frames when the secondary sensor is absent', () => {
    const engine = new AnalysisEngine(config())
    engine.ingestMany(constantRpmPackets(0, 16, 3000, 0.8))
    const snapshot = engine.snapshot()
    expect(snapshot.frames.length).toBeGreaterThan(3)
    expect(snapshot.frames.at(-1)?.rpm1).toBeCloseTo(3000, 0)
    expect(Number.isFinite(snapshot.frames.at(-1)?.rpm2 ?? Number.NaN)).toBe(false)
    expect(Number.isFinite(snapshot.frames.at(-1)?.shiftRatio ?? Number.NaN)).toBe(false)
    expect(Number.isFinite(snapshot.frames.at(-1)?.efficiency ?? Number.NaN)).toBe(false)
  })

  it('uses one common interval for primary power, secondary energy rate, and efficiency', () => {
    const engine = new AnalysisEngine(config())
    const primary = constantRpmPackets(0, 16, 3000, 1.2)
    const secondary = constantRpmPackets(1, 12, 2000, 1.2)
    const startUs = Math.min(primary[0].tUs, secondary[0].tUs)
    engine.ingest({ channel: 5, value: 1, tUs: Math.max(1, startUs - 1), seq: 0, edgeCount: 0 })
    engine.ingestMany([...primary, ...secondary].sort((a, b) => a.tUs - b.tUs))
    const frames = engine.snapshot().frames
    expect(frames.length).toBeGreaterThan(5)
    expect(frames.at(-1)?.rpm1).toBeCloseTo(3000, 0)
    expect(frames.at(-1)?.rpm2).toBeCloseTo(2000, 0)
    expect(frames.at(-1)?.power2).toBeCloseTo(0, 6)
    expect(Number.isFinite(frames.at(-1)?.efficiency ?? Number.NaN)).toBe(false)
  })

  it('invalidates curve-based efficiency whenever the entire interval is not WOT', () => {
    const engine = new AnalysisEngine(config())
    const primary = constantRpmPackets(0, 16, 3000, 0.6)
    const secondary = constantRpmPackets(1, 12, 2000, 0.6)
    engine.ingestMany([...primary, ...secondary].sort((a, b) => a.tUs - b.tUs))
    expect(engine.snapshot().frames.every((frame) => !Number.isFinite(frame.efficiency))).toBe(true)
  })

  it('switches observation display between one-revolution and per-tooth without changing analysis frames', () => {
    const engine = new AnalysisEngine(config())
    const packets = constantRpmPackets(0, 16, 3000, 0.3)
    engine.ingestMany(packets)
    const rev = engine.snapshot()
    engine.setConfig(config({ observationMode: 'tooth' }))
    const tooth = engine.snapshot()
    expect(tooth.primaryObservations.length).toBe(packets.length)
    expect(tooth.frames).toEqual(rev.frames)
  })
})
