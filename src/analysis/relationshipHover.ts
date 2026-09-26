import { projectX, projectY, type NumericDomain, type PlotGeometry } from './plotGeometry'

export type { NumericDomain } from './plotGeometry'
export type PlotRect = PlotGeometry

export type ProjectedPoint<T> = {
  point: T
  xPx: number
  yPx: number
  distanceSquared: number
}

export function projectToPlot(
  x: number,
  y: number,
  xDomain: NumericDomain,
  yDomain: NumericDomain,
  plot: PlotRect,
): { xPx: number; yPx: number } | null {
  const xPx = projectX(x, xDomain, plot)
  const yPx = projectY(y, yDomain, plot)
  return xPx === null || yPx === null ? null : { xPx, yPx }
}

export function nearestProjectedPoint<T>(
  points: readonly T[],
  mouseX: number,
  mouseY: number,
  xDomain: NumericDomain,
  yDomain: NumericDomain,
  plot: PlotRect,
  getX: (point: T) => number,
  getY: (point: T) => number,
): ProjectedPoint<T> | undefined {
  let best: ProjectedPoint<T> | undefined
  let bestDistanceSquared = Infinity

  for (const point of points) {
    const projected = projectToPlot(getX(point), getY(point), xDomain, yDomain, plot)
    if (!projected) continue
    const dx = projected.xPx - mouseX
    const dy = projected.yPx - mouseY
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared
      best = { point, xPx: projected.xPx, yPx: projected.yPx, distanceSquared }
    }
  }

  return best
}
