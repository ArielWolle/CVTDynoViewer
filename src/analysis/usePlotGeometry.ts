import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'
import { localPlotGeometry, samePlotGeometry, type PlotGeometry } from './plotGeometry'

/**
 * Measures the actual Recharts Cartesian plot rectangle once layout is available, then stores it
 * in chart-body-local coordinates. Local coordinates are deliberate: moving the card because the
 * window/grid reflows does not invalidate hover or Canvas projection.
 */
export function usePlotGeometry(chartBodyRef: RefObject<HTMLDivElement | null>): PlotGeometry | null {
  const [geometry, setGeometry] = useState<PlotGeometry | null>(null)

  const measure = useCallback(() => {
    const body = chartBodyRef.current
    if (!body) return false
    const grid = body.querySelector<SVGElement>('.recharts-cartesian-grid-bg')
    if (!grid) return false
    const next = localPlotGeometry(body.getBoundingClientRect(), grid.getBoundingClientRect())
    setGeometry((previous) => samePlotGeometry(previous, next) ? previous : next)
    return true
  }, [chartBodyRef])

  useLayoutEffect(() => {
    const body = chartBodyRef.current
    if (!body) return

    let frame: number | null = null
    let disposed = false
    let mutationObserver: MutationObserver | null = null
    const scheduleMeasure = () => {
      if (disposed) return
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = null
        if (measure() && mutationObserver) {
          mutationObserver?.disconnect()
          mutationObserver = null
        }
      })
    }

    scheduleMeasure()

    const resizeObserver = new ResizeObserver(scheduleMeasure)
    resizeObserver.observe(body)

    // ResponsiveContainer creates its SVG asynchronously from the first layout measurement. Watch
    // only structure changes so streaming attribute updates cannot turn measurement into hot-path work.
    mutationObserver = new MutationObserver(scheduleMeasure)
    mutationObserver.observe(body, { childList: true, subtree: true })

    window.addEventListener('resize', scheduleMeasure)
    void document.fonts?.ready.then(scheduleMeasure)

    return () => {
      disposed = true
      if (frame !== null) cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
    }
  }, [chartBodyRef, measure])

  return geometry
}
