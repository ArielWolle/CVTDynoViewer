import { describe, expect, it } from 'vitest'
import { downsampleForChart } from './downsample'

function points(count: number): { seconds: number; value: number }[] {
  return Array.from({ length: count }, (_, index) => ({ seconds: index, value: index }))
}

describe('downsampleForChart', () => {
  it('returns the input unchanged (as a copy) when already at or under the cap', () => {
    const data = points(10)
    const result = downsampleForChart(data, 20)
    expect(result).toEqual(data)
    expect(result).not.toBe(data) // a copy, not the same array reference
  })

  it('reduces a large dataset to at most maxPoints entries', () => {
    const data = points(10_000)
    const result = downsampleForChart(data, 500)
    expect(result.length).toBeLessThanOrEqual(500)
    expect(result.length).toBeGreaterThan(0)
  })

  it('always keeps the very first and very last point', () => {
    const data = points(10_000)
    const result = downsampleForChart(data, 200)
    expect(result[0]).toEqual(data[0])
    expect(result[result.length - 1]).toEqual(data[data.length - 1])
  })

  it('preserves ascending order (never reorders points)', () => {
    const data = points(5_000)
    const result = downsampleForChart(data, 300)
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i].seconds).toBeGreaterThan(result[i - 1].seconds)
    }
  })

  it('never fabricates a point that was not in the original data', () => {
    const data = points(3_000)
    const result = downsampleForChart(data, 400)
    const originalValues = new Set(data.map((point) => point.value))
    for (const point of result) {
      expect(originalValues.has(point.value)).toBe(true)
    }
  })

  it('does not drop a sharp spike that lands exactly on a bucket boundary', () => {
    const data = points(1000)
    data[500] = { seconds: 500, value: 99999 } // an isolated spike at a point index likely to land on a bucket edge
    const result = downsampleForChart(data, 100)
    expect(result.some((point) => point.value === 99999)).toBe(true)
  })

  it('handles maxPoints smaller than 2 by returning a copy of the full input (declines to downsample)', () => {
    const data = points(50)
    expect(downsampleForChart(data, 1)).toEqual(data)
    expect(downsampleForChart(data, 0)).toEqual(data)
  })

  it('handles an empty input', () => {
    expect(downsampleForChart([], 100)).toEqual([])
  })
})
