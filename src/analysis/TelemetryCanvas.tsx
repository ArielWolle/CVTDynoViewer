import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { EfficiencyPoint, RatioPoint, RpmPoint, ShiftPoint } from './types'
import type { PowerRow, WithSeconds } from './store'
import { projectX, projectY, type NumericDomain, type PlotGeometry } from './plotGeometry'
import type { ChartId } from './chartTypes'

type TimeDatum = WithSeconds<RpmPoint> | WithSeconds<ShiftPoint> | WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint> | PowerRow
type RelationshipDatum = WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>

type Props = {
  chartId: ChartId
  color: string
  plot: PlotGeometry | null
  xDomain: NumericDomain
  yDomain: NumericDomain
  timeData: readonly TimeDatum[]
  relationshipData: readonly RelationshipDatum[]
  primaryObs: readonly WithSeconds<RpmPoint>[]
  secondaryObs: readonly WithSeconds<RpmPoint>[]
  lowRatio: number
  highRatio: number
}

function drawLine<T>(
  ctx: CanvasRenderingContext2D,
  values: readonly T[],
  getX: (point: T) => number,
  getY: (point: T) => number,
  xDomain: NumericDomain,
  yDomain: NumericDomain,
  plot: PlotGeometry,
  color: string,
  width = 2,
) {
  ctx.beginPath()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  let drawing = false

  for (const point of values) {
    const x = projectX(getX(point), xDomain, plot)
    const y = projectY(getY(point), yDomain, plot)
    if (x === null || y === null) {
      drawing = false
      continue
    }
    if (!drawing) {
      ctx.moveTo(x, y)
      drawing = true
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()
}

function drawDots<T>(
  ctx: CanvasRenderingContext2D,
  values: readonly T[],
  getX: (point: T) => number,
  getY: (point: T) => number,
  xDomain: NumericDomain,
  yDomain: NumericDomain,
  plot: PlotGeometry,
  color: string,
  radius: number,
  alpha = 1,
) {
  ctx.save()
  ctx.fillStyle = color
  ctx.globalAlpha = alpha
  ctx.beginPath()
  for (const point of values) {
    const x = projectX(getX(point), xDomain, plot)
    const y = projectY(getY(point), yDomain, plot)
    if (x === null || y === null) continue
    ctx.moveTo(x + radius, y)
    ctx.arc(x, y, radius, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.restore()
}

function drawRatioGuide(
  ctx: CanvasRenderingContext2D,
  ratio: number,
  color: string,
  xDomain: NumericDomain,
  yDomain: NumericDomain,
  plot: PlotGeometry,
) {
  const xMax = xDomain[1]
  const yMax = yDomain[1]
  if (!(ratio > 0) || !(xMax > 0) || !(yMax > 0)) return
  const endX = Math.min(xMax, yMax / ratio)
  const startX = projectX(0, xDomain, plot)
  const startY = projectY(0, yDomain, plot)
  const endXPx = projectX(endX, xDomain, plot)
  const endYPx = projectY(endX * ratio, yDomain, plot)
  if (startX === null || startY === null || endXPx === null || endYPx === null) return

  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.setLineDash([1, 5])
  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.lineTo(endXPx, endYPx)
  ctx.stroke()
  ctx.restore()
}

function drawTelemetry(ctx: CanvasRenderingContext2D, props: Props) {
  const { chartId, color, plot, xDomain, yDomain, timeData, relationshipData, primaryObs, secondaryObs, lowRatio, highRatio } = props
  if (!plot) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(plot.left, plot.top, plot.width, plot.height)
  ctx.clip()

  if (chartId === 'scatter') {
    drawRatioGuide(ctx, lowRatio, '#d8a227', xDomain, yDomain, plot)
    drawRatioGuide(ctx, highRatio, '#3c8f88', xDomain, yDomain, plot)
    drawDots(ctx, relationshipData as readonly WithSeconds<RatioPoint>[], (p) => p.rpm2, (p) => p.rpm1, xDomain, yDomain, plot, color, 2.2)
  } else if (chartId === 'shiftEfficiency') {
    drawDots(ctx, relationshipData as readonly WithSeconds<EfficiencyPoint>[], (p) => p.ratio, (p) => p.efficiencyPct, xDomain, yDomain, plot, color, 2.5, 0.62)
  } else if (chartId === 'rpm1' || chartId === 'rpm2') {
    const observations = chartId === 'rpm1' ? primaryObs : secondaryObs
    drawDots(ctx, observations, (p) => p.seconds, (p) => p.rpm, xDomain, yDomain, plot, color, 1.5, 0.24)
    const rpm = timeData as readonly WithSeconds<RpmPoint>[]
    drawLine(ctx, rpm, (p) => p.seconds, (p) => p.rpm, xDomain, yDomain, plot, color)
    drawDots(ctx, rpm, (p) => p.seconds, (p) => p.rpm, xDomain, yDomain, plot, color, 1.8)
  } else if (chartId === 'shift') {
    const shift = timeData as readonly WithSeconds<ShiftPoint>[]
    drawLine(ctx, shift, (p) => p.seconds, (p) => p.value, xDomain, yDomain, plot, color)
  } else if (chartId === 'power') {
    const power = timeData as readonly PowerRow[]
    drawLine(ctx, power, (p) => p.seconds, (p) => p.power1 ?? Number.NaN, xDomain, yDomain, plot, '#f05d3b')
    drawDots(ctx, power, (p) => p.seconds, (p) => p.power1 ?? Number.NaN, xDomain, yDomain, plot, '#f05d3b', 1.8)
    drawLine(ctx, power, (p) => p.seconds, (p) => p.power2 ?? Number.NaN, xDomain, yDomain, plot, '#3c8f88')
    drawDots(ctx, power, (p) => p.seconds, (p) => p.power2 ?? Number.NaN, xDomain, yDomain, plot, '#3c8f88', 1.8)
  } else if (chartId === 'efficiency') {
    const efficiency = timeData as readonly WithSeconds<EfficiencyPoint>[]
    drawLine(ctx, efficiency, (p) => p.seconds, (p) => p.efficiencyPct, xDomain, yDomain, plot, color)
    drawDots(ctx, efficiency, (p) => p.seconds, (p) => p.efficiencyPct, xDomain, yDomain, plot, color, 1.8)
  } else if (chartId === 'shiftRatio') {
    const ratio = timeData as readonly WithSeconds<RatioPoint>[]
    drawLine(ctx, ratio, (p) => p.seconds, (p) => p.ratio, xDomain, yDomain, plot, color)
    drawDots(ctx, ratio, (p) => p.seconds, (p) => p.ratio, xDomain, yDomain, plot, color, 1.8)
  }

  ctx.restore()
}

export function TelemetryCanvas(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const cssWidth = canvas.clientWidth
    const cssHeight = canvas.clientHeight
    if (!(cssWidth > 0) || !(cssHeight > 0)) return

    const pixelRatio = window.devicePixelRatio || 1
    const pixelWidth = Math.max(1, Math.round(cssWidth * pixelRatio))
    const pixelHeight = Math.max(1, Math.round(cssHeight * pixelRatio))
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    ctx.clearRect(0, 0, cssWidth, cssHeight)
    drawTelemetry(ctx, propsRef.current)
  }, [])

  useLayoutEffect(draw, [draw, props])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resizeObserver = new ResizeObserver(draw)
    resizeObserver.observe(canvas)
    window.addEventListener('resize', draw)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', draw)
    }
  }, [draw])

  return <canvas ref={canvasRef} className="chart-canvas-layer" aria-hidden="true" />
}
