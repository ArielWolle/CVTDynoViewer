export type NumericDomain = readonly [number, number]

export type PlotRect = {
  left: number
  top: number
  width: number
  height: number
}

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
  const [xMin, xMax] = xDomain
  const [yMin, yMax] = yDomain
  const xSpan = xMax - xMin
  const ySpan = yMax - yMin
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(xSpan > 0) || !(ySpan > 0) || !(plot.width > 0) || !(plot.height > 0)) return null

  const fx = (x - xMin) / xSpan
  const fy = (y - yMin) / ySpan

  // Relationship charts use explicit numeric domains with allowDataOverflow, so Recharts clips
  // samples outside the plot. Do not allow hover to snap to a point the user cannot see.
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null

  return {
    xPx: plot.left + fx * plot.width,
    yPx: plot.top + (1 - fy) * plot.height,
  }
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
