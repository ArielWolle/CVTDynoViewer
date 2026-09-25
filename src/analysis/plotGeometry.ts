export type NumericDomain = readonly [number, number]

export type PlotGeometry = {
  left: number
  top: number
  width: number
  height: number
}

export type RectLike = {
  left: number
  top: number
  width: number
  height: number
}

export function localPlotGeometry(body: RectLike, plot: RectLike): PlotGeometry | null {
  if (!(body.width > 0) || !(body.height > 0) || !(plot.width > 0) || !(plot.height > 0)) return null
  return {
    left: plot.left - body.left,
    top: plot.top - body.top,
    width: plot.width,
    height: plot.height,
  }
}

export function samePlotGeometry(a: PlotGeometry | null, b: PlotGeometry | null, epsilon = 0.25): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return Math.abs(a.left - b.left) <= epsilon
    && Math.abs(a.top - b.top) <= epsilon
    && Math.abs(a.width - b.width) <= epsilon
    && Math.abs(a.height - b.height) <= epsilon
}

export function projectX(value: number, domain: NumericDomain, plot: PlotGeometry): number | null {
  const [min, max] = domain
  const span = max - min
  if (!Number.isFinite(value) || !(span > 0) || !(plot.width > 0)) return null
  const fraction = (value - min) / span
  if (fraction < 0 || fraction > 1) return null
  return plot.left + fraction * plot.width
}

export function projectY(value: number, domain: NumericDomain, plot: PlotGeometry): number | null {
  const [min, max] = domain
  const span = max - min
  if (!Number.isFinite(value) || !(span > 0) || !(plot.height > 0)) return null
  const fraction = (value - min) / span
  if (fraction < 0 || fraction > 1) return null
  return plot.top + (1 - fraction) * plot.height
}
