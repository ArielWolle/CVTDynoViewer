import { describe, expect, it } from 'vitest'
import { csvEscape, decodePacket, deriveSample, encodeCommand, parseSamplesCsv, samplesToCsv } from './protocol'

describe('firmware protocol', () => {
  it('decodes little-endian telemetry packets', () => {
    expect(decodePacket(new Uint8Array([0xaa, 0xbb, 3, 0, 0x2e, 0x16, 0, 0]))).toEqual({ channel: 3, value: 5678 })
    expect(decodePacket(new Uint8Array([0xbb, 0xaa, 3, 0, 0x2e, 0x16, 0, 0]))).toEqual({ channel: 3, value: 5678 })
  })

  it('encodes big-endian configuration commands', () => {
    expect([...encodeCommand(2, 4, 500)]).toEqual([2, 4, 1, 244])
  })

  it('derives power and efficiency from torque and rpm', () => {
    const sample = deriveSample({ time: 0, rpm1: 9549, rpm2: 4774.5, shift: 0, torq1: 100, torq2: 50 }, 1, 0)
    expect(sample.power1).toBeCloseTo(100)
    expect(sample.efficiency).toBeCloseTo(25)
  })

  it('escapes CSV values and emits a stable header', () => {
    expect(csvEscape('pull, A')).toBe('"pull, A"')
    expect(samplesToCsv([]).split('\n')[0]).toContain('primary_rpm')
  })

  it('derives inertia-mode power from shaft acceleration and an engine torque curve', () => {
    const sample = deriveSample({ time: 1000, rpm1: 1800, rpm2: 1800, shift: 0, torq1: 0, torq2: 0 }, 1, 0, 'inertia', { time: 0, rpm1: 1000, rpm2: 0 })
    expect(sample.power1).toBeGreaterThan(4)
    expect(sample.power2).toBeGreaterThan(0)
    expect(sample.efficiency).toBeGreaterThan(0)
  })

  it('honors a custom RPM vs torque curve in inertia mode', () => {
    const flatCurve = [{ rpm: 0, torque: 0 }, { rpm: 5000, torque: 40 }]
    const sample = deriveSample({ time: 0, rpm1: 5000, rpm2: 0, shift: 0, torq1: 0, torq2: 0 }, 1, 0, 'inertia', undefined, 0.3, flatCurve)
    const defaultSample = deriveSample({ time: 0, rpm1: 5000, rpm2: 0, shift: 0, torq1: 0, torq2: 0 }, 1, 0, 'inertia')
    expect(sample.power1).toBeGreaterThan(defaultSample.power1)
  })

  it('parses a logged CSV back into telemetry samples for playback', () => {
    const csv = samplesToCsv([
      { time: 0, rpm1: 1000, rpm2: 900, shift: 10, torq1: 50, torq2: 40, power1: 5, power2: 4, efficiency: 80 },
      { time: 100, rpm1: 1100, rpm2: 950, shift: 12, torq1: 55, torq2: 42, power1: 6, power2: 4.5, efficiency: 75 },
    ])
    const parsed = parseSamplesCsv(csv)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ time: 0, rpm1: 1000, rpm2: 900 })
    expect(parsed[1]).toMatchObject({ time: 100, rpm1: 1100, rpm2: 950 })
  })

  it('returns an empty array for CSV text missing required columns', () => {
    expect(parseSamplesCsv('a,b\n1,2')).toEqual([])
    expect(parseSamplesCsv('')).toEqual([])
  })

  it('tolerates a stray character prefixed onto the header row', () => {
    const csv = 'Ctimestamp_ms,primary_rpm,secondary_rpm,shift_position,primary_torque,secondary_torque,primary_power_kw,secondary_power_kw,efficiency_percent\n1000,2000,1800,10,50,40,5.000,4.000,80.00'
    const parsed = parseSamplesCsv(csv)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ time: 1000, rpm1: 2000, rpm2: 1800 })
  })
})