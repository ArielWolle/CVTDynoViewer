import { useEffect, useRef, useState } from 'react'

type Range = { start: number; end: number }

type Props = {
  startFraction: number
  endFraction: number
  onChange: (next: Range) => void
  formatValue: (fraction: number) => string
}

const MIN_GAP = 0.01
// Committing on every animation frame (~60/sec) still means ~60 full chart/data recomputes per
// second in the parent while dragging. That recompute work runs on the same main thread as this
// component's own local drag rendering, so once it takes longer than a frame it blocks the local
// drag from updating too -- the whole thing looks laggy even though the drag state itself is
// local and cheap. Throttling the commit by wall-clock time (not just "once per frame") bounds
// how often the expensive part runs, independent of how fast rAF fires.
const COMMIT_INTERVAL_MS = 100

/**
 * Dual-handle scrubber that selects the [start, end] time window shown across every chart.
 * Dragging updates local, component-only state every pointer move (cheap: this component only)
 * for a smooth 1:1 feel, while the `onChange` commit -- which can trigger a full chart/data
 * recompute in the parent -- is throttled and finalized on pointer-up, so a fast mouse doesn't
 * flood the app with dozens of redundant recomputes per second.
 */
export function TimeRangeSlider({ startFraction, endFraction, onChange, formatValue }: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null)
  const [localRange, setLocalRange] = useState<Range | null>(null)
  const pendingCommitRef = useRef<Range | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const lastCommitAtRef = useRef(0)
  const display = localRange ?? { start: startFraction, end: endFraction }

  useEffect(() => () => { if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current) }, [])

  function scheduleCommit(next: Range) {
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
    if (timeoutRef.current !== null) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null }
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
