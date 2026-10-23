import { describe, expect, it } from 'vitest'
import { RelationshipSpatialIndex } from './relationshipIndex'
import { nearestProjectedPoint } from './relationshipHover'

const plot = { left: 40, top: 20, width: 800, height: 200 }
const xDomain: [number, number] = [0, 100]
const yDomain: [number, number] = [0, 100]

describe('RelationshipSpatialIndex', () => {
  it('matches brute-force pixel nearest-point selection', () => {
    const points = Array.from({ length: 2000 }, (_, index) => ({
      id: index,
      x: (index * 37) % 101,
      y: (index * 61) % 101,
    }))
    const index = new RelationshipSpatialIndex(points, xDomain, yDomain, plot, (point) => point.x, (point) => point.y)

    for (const [mouseX, mouseY] of [[55, 31], [440, 110], [830, 211], [271, 88]] as const) {
      const expected = nearestProjectedPoint(points, mouseX, mouseY, xDomain, yDomain, plot, (point) => point.x, (point) => point.y)
      const actual = index.nearest(mouseX, mouseY)
      expect(actual?.distanceSquared).toBeCloseTo(expected?.distanceSquared ?? 0, 8)
    }
  })

  it('does not return a point when the cursor is outside the actual plot rectangle', () => {
    const index = new RelationshipSpatialIndex([{ x: 50, y: 50 }], xDomain, yDomain, plot, (point) => point.x, (point) => point.y)
    expect(index.nearest(10, 10)).toBeUndefined()
  })
})
