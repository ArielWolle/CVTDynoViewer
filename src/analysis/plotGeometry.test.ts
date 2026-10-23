import { describe, expect, it } from 'vitest'
import { localPlotGeometry, projectX, projectY, samePlotGeometry } from './plotGeometry'

describe('plot geometry', () => {
  it('converts viewport rectangles into chart-local coordinates', () => {
    expect(localPlotGeometry(
      { left: 100, top: 80, width: 900, height: 230 },
      { left: 152, top: 88, width: 820, height: 188 },
    )).toEqual({ left: 52, top: 8, width: 820, height: 188 })
  })

  it('is invariant when the whole chart moves on screen', () => {
    const before = localPlotGeometry(
      { left: 100, top: 80, width: 900, height: 230 },
      { left: 152, top: 88, width: 820, height: 188 },
    )
    const after = localPlotGeometry(
      { left: 460, top: 310, width: 900, height: 230 },
      { left: 512, top: 318, width: 820, height: 188 },
    )
    expect(after).toEqual(before)
  })

  it('projects axes and tolerates sub-pixel measurement noise', () => {
    const plot = { left: 52, top: 8, width: 820, height: 188 }
    expect(projectX(5, [0, 10], plot)).toBe(462)
    expect(projectY(25, [0, 100], plot)).toBe(149)
    expect(samePlotGeometry(plot, { ...plot, left: 52.1, width: 820.2 })).toBe(true)
  })
})
