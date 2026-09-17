import { useEffect, useRef, useState } from 'react'

type Range = { start: number; end: number }

type Props = {
  startFraction: number
  endFraction: number
  onChange: (next: Range) => void
  formatValue: (fraction: number) => string
}

const MIN_GAP = 0.01

/**
 * Dual-handle scrubber that selects the [start, end] time window shown across every chart.
 * Dragging updates local, component-only state every pointer move (cheap: this component only)
 * for a smooth 1:1 feel, while the `onChange` commit -- which can trigger a full chart/data
 * recompute in the parent -- is throttled to at most once per animation frame and finalized on
 * pointer-up, so a fast mouse doesn't flood the app with dozens of redundant recomputes.
 */
export function TimeRangeSlider({ startFraction, endFraction, onChange, formatValue }: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)
  const [localRange, setLocalRange] = useState<Range | null>(null)
  const pendingCommitRef = useRef<Range | null>(null)
  const frameRef = useRef<number | null>(null)
  const display = localRange ?? { start: startFraction, end: endFraction }

  useEffect(() => () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current) }, [])

  function scheduleCommit(next: Range) {
    pendingCommitRef.current = next
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (pendingCommitRef.current) onChange(pendingCommitRef.current)
    })
  }
  function fractionFromClientX(clientX: number) {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    if (rect.width === 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }
  function handlePointerDown(which: 'start' | 'end', event: React.PointerEvent<HTMLButtonElement>) {
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(which)
  }
  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return
    const fraction = fractionFromClientX(event.clientX)
    const next = dragging === 'start'
      ? { start: Math.min(fraction, display.end - MIN_GAP), end: display.end }
      : { start: display.start, end: Math.max(fraction, display.start + MIN_GAP) }
    setLocalRange(next)
    scheduleCommit(next)
  }
  function handlePointerUp() {
    setDragging(null)
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null }
    if (localRange) { onChange(localRange); setLocalRange(null) }
    pendingCommitRef.current = null
  }

  return (
    <div className="time-range-slider">
      <div
        className="time-range-track"
        ref={trackRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <div className="time-range-fill" style={{ left: `${display.start * 100}%`, width: `${Math.max(0, display.end - display.start) * 100}%` }} />
        <button
          type="button"
          className="time-range-thumb"
          style={{ left: `${display.start * 100}%` }}
          onPointerDown={(event) => handlePointerDown('start', event)}
          aria-label="Chart window start time"
        >
          <span>{formatValue(display.start)}</span>
        </button>
        <button
          type="button"
          className="time-range-thumb"
          style={{ left: `${display.end * 100}%` }}
          onPointerDown={(event) => handlePointerDown('end', event)}
          aria-label="Chart window end time"
        >
          <span>{formatValue(display.end)}</span>
        </button>
      </div>
    </div>
  )
}
