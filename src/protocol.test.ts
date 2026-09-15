import { describe, expect, it } from 'vitest'
import { csvEscape, decodePacket, deriveSample, encodeCommand, samplesToCsv } from './protocol'

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
})