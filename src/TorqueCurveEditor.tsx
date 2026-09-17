import { useEffect, useMemo, useRef, useState } from 'react'
import type { EngineTorquePoint } from './protocol'

const WIDTH = 560
const HEIGHT = 220
const PAD_LEFT = 40
const PAD_RIGHT = 14
const PAD_TOP = 12
const PAD_BOTTOM = 26
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM

type Props = {
  points: EngineTorquePoint[]
  onChange: (points: EngineTorquePoint[]) => void
}

function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return ''
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[index - 1] ?? points[index]
    const p1 = points[index]
    const p2 = points[index + 1]
    const p3 = points[index + 2] ?? p2
    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6
    path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
  }
  return path
}

function niceStep(max: number, targetTicks: number): number {
  if (max <= 0) return 1
  const raw = max / targetTicks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1
  return step * magnitude
}

// Committing on every animation frame (~60/sec) still means ~60 full app recomputes per second
// in the parent (recalculating power for every logged sample, then every chart's moving averages,
// then re-rendering all eight charts) while dragging. That work runs on the same main thread as
// this component's own local drag rendering, so once it takes longer than a frame it blocks the
// local drag from updating too -- the curve itself looks laggy even though its own state is local
// and cheap. Throttling the commit by wall-clock time (not just "once per frame") bounds how often
// the expensive part runs, independent of how fast rAF/pointer events fire.
const COMMIT_INTERVAL_MS = 100

/** Draggable RPM-vs-torque spline used to shape the inertia-mode engine power curve. */
export function TorqueCurveEditor({ points, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  // Dragging updates this local, component-only state on every pointer move so the marker and
  // spline redraw at full frame rate, decoupled from how often the expensive commit below runs.
  const [localPoints, setLocalPoints] = useState<EngineTorquePoint[] | null>(null)
  const pendingCommitRef = useRef<EngineTorquePoint[] | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const lastCommitAtRef = useRef(0)
  const displayPoints = localPoints ?? points

  useEffect(() => () => { if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current) }, [])

  function scheduleCommit(next: EngineTorquePoint[]) {
    pendingCommitRef.current = next
    const elapsed = performance.now() - lastCommitAtRef.current
    if (elapsed >= COMMIT_INTERVAL_MS) {
      lastCommitAtRef.current = performance.now()
      onChange(next)
      return
    }
    if (timeoutRef.current !== null) return
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null
      lastCommitAtRef.current = performance.now()
      if (pendingCommitRef.current) onChange(pendingCommitRef.current)
    }, COMMIT_INTERVAL_MS - elapsed)
  }

  const rpmMax = useMemo(() => Math.max(4500, ...displayPoints.map((point) => point.rpm)) + 500, [displayPoints])
  const torqueMax = useMemo(() => Math.max(10, ...displayPoints.map((point) => point.torque)) + 5, [displayPoints])

  function toSvg(point: EngineTorquePoint) {
    return {
      x: PAD_LEFT + (point.rpm / rpmMax) * PLOT_WIDTH,
      y: PAD_TOP + PLOT_HEIGHT - (point.torque / torqueMax) * PLOT_HEIGHT,
    }
  }
  function fromSvg(x: number, y: number): EngineTorquePoint {
    const rpm = ((x - PAD_LEFT) / PLOT_WIDTH) * rpmMax
    const torque = ((PAD_TOP + PLOT_HEIGHT - y) / PLOT_HEIGHT) * torqueMax
    return { rpm, torque }
  }
  function clientToSvgPoint(clientX: number, clientY: number) {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    return { x: (clientX - rect.left) * (WIDTH / rect.width), y: (clientY - rect.top) * (HEIGHT / rect.height) }
  }

  const svgPoints = displayPoints.map(toSvg)
  const pathD = buildSmoothPath(svgPoints)
  const rpmStep = niceStep(rpmMax, 6)
  const torqueStep = niceStep(torqueMax, 5)
  const rpmTicks: number[] = []
  for (let value = 0; value <= rpmMax; value += rpmStep) rpmTicks.push(Math.round(value))
  const torqueTicks: number[] = []
  for (let value = 0; value <= torqueMax; value += torqueStep) torqueTicks.push(Math.round(value * 10) / 10)

  function handlePointerDown(index: number, event: React.PointerEvent<SVGCircleElement>) {
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingIndex(index)
  }
  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (draggingIndex === null) return
    const { x, y } = clientToSvgPoint(event.clientX, event.clientY)
    const raw = fromSvg(x, y)
    const prev = displayPoints[draggingIndex - 1]
    const next = displayPoints[draggingIndex + 1]
    const minRpm = prev ? prev.rpm + 1 : 0
    const maxRpm = next ? next.rpm - 1 : rpmMax
    const rpm = Math.round(Math.min(maxRpm, Math.max(minRpm, raw.rpm)))
    const torque = Math.round(Math.min(torqueMax, Math.max(0, raw.torque)) * 10) / 10
    const nextPoints = displayPoints.map((point, index) => (index === draggingIndex ? { rpm, torque } : point))
    setLocalPoints(nextPoints)
    scheduleCommit(nextPoints)
  }
  function handlePointerUp() {
    setDraggingIndex(null)
    if (timeoutRef.current !== null) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null }
    if (localPoints) { onChange(localPoints); setLocalPoints(null) }
    pendingCommitRef.current = null
  }
  function handleDoubleClickPoint(index: number, event: React.MouseEvent) {
    event.stopPropagation()
    if (points.length <= 2) return
    onChange(points.filter((_, pointIndex) => pointIndex !== index))
  }
  function handleDoubleClickCanvas(event: React.MouseEvent<SVGSVGElement>) {
    const { x, y } = clientToSvgPoint(event.clientX, event.clientY)
    if (x < PAD_LEFT || x > WIDTH - PAD_RIGHT || y < PAD_TOP || y > HEIGHT - PAD_BOTTOM) return
    const point = fromSvg(x, y)
    point.rpm = Math.round(point.rpm)
    point.torque = Math.round(point.torque * 10) / 10
    const insertIndex = points.findIndex((existing) => existing.rpm > point.rpm)
    const nextPoints = [...points]
    if (insertIndex === -1) nextPoints.push(point)
    else nextPoints.splice(insertIndex, 0, point)
    onChange(nextPoints)
  }

  return (
    <div className="torque-curve-editor">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="torque-curve-svg"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClickCanvas}
      >
        {rpmTicks.map((value) => {
          const x = PAD_LEFT + (value / rpmMax) * PLOT_WIDTH
          return (
            <g key={`rpm-${value}`}>
              <line x1={x} x2={x} y1={PAD_TOP} y2={PAD_TOP + PLOT_HEIGHT} stroke="#e4dfd5" />
              <text x={x} y={HEIGHT - 8} fontSize="9" textAnchor="middle" fill="#8b8982">{value}</text>
            </g>
          )
        })}
        {torqueTicks.map((value) => {
          const y = PAD_TOP + PLOT_HEIGHT - (value / torqueMax) * PLOT_HEIGHT
          return (
            <g key={`torque-${value}`}>
              <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y} y2={y} stroke="#e4dfd5" />
              <text x={PAD_LEFT - 6} y={y + 3} fontSize="9" textAnchor="end" fill="#8b8982">{value}</text>
            </g>
          )
        })}
        <text x={(WIDTH) / 2} y={HEIGHT - 1} fontSize="9" textAnchor="middle" fill="#8b8982">RPM</text>
        <text x={10} y={PAD_TOP + 6} fontSize="9" textAnchor="start" fill="#8b8982">ft·lb</text>
        <path d={pathD} fill="none" stroke="#f05d3b" strokeWidth={2} />
        {svgPoints.map((point, index) => (
          <circle
            key={index}
            cx={point.x}
            cy={point.y}
            r={6}
            fill="#fffdf8"
            stroke="#f05d3b"
            strokeWidth={2}
            onPointerDown={(event) => handlePointerDown(index, event)}
            onDoubleClick={(event) => handleDoubleClickPoint(index, event)}
            style={{ cursor: 'grab' }}
          />
        ))}
      </svg>
      <p className="torque-curve-hint">Drag a point to reshape the curve. Double-click empty space to add a point, double-click a point to remove it.</p>
    </div>
  )
}
