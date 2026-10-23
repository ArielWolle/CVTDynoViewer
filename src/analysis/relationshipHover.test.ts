import { describe, expect, it } from 'vitest'
import { nearestProjectedPoint, projectToPlot } from './relationshipHover'

const plot = { left: 40, top: 20, width: 800, height: 200 }

describe('relationship hover projection', () => {
  it('projects linear chart values to exact screen coordinates', () => {
    expect(projectToPlot(50, 25, [0, 100], [0, 100], plot)).toEqual({ xPx: 440, yPx: 170 })
    expect(projectToPlot(0, 0, [0, 100], [0, 100], plot)).toEqual({ xPx: 40, yPx: 220 })
    expect(projectToPlot(100, 100, [0, 100], [0, 100], plot)).toEqual({ xPx: 840, yPx: 20 })
  })

  it('does not make clipped relationship points hoverable', () => {
    expect(projectToPlot(101, 50, [0, 100], [0, 100], plot)).toBeNull()
    expect(projectToPlot(50, -1, [0, 100], [0, 100], plot)).toBeNull()
  })

  it('chooses nearest by screen-pixel distance', () => {
    const points = [
      { id: 'a', x: 10, y: 90 },
      { id: 'b', x: 50, y: 50 },
      { id: 'c', x: 90, y: 10 },
    ]
    const nearest = nearestProjectedPoint(points, 445, 118, [0, 100], [0, 100], plot, (point) => point.x, (point) => point.y)
    expect(nearest?.point.id).toBe('b')
    expect(nearest?.distanceSquared).toBeLessThan(100)
  })

  it('respects plot aspect ratio rather than normalized data distance', () => {
    const points = [
      { id: 'x-offset', x: 52, y: 70 },
      { id: 'pixel-close', x: 50, y: 55 },
    ]
    const nearest = nearestProjectedPoint(points, 440, 110, [0, 100], [0, 100], plot, (point) => point.x, (point) => point.y)
    expect(nearest?.point.id).toBe('pixel-close')
  })

  it('ignores a clipped point even when its mathematical coordinate is near the cursor', () => {
    const points = [
      { id: 'visible', x: 6, y: 50 },
      { id: 'clipped', x: 6.2, y: 50 },
    ]
    const nearest = nearestProjectedPoint(points, 838, 120, [0.5, 6], [0, 100], plot, (point) => point.x, (point) => point.y)
    expect(nearest?.point.id).toBe('visible')
  })
})
