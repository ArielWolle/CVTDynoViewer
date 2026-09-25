import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type Dispatch, type DragEvent, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
import { GripVertical, Pause, Play, RotateCcw, X } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { downsampleForChart } from '../downsample'
import { TimeRangeSlider } from '../TimeRangeSlider'
import { ANALYSIS_WINDOWS_MS, type AnalysisSnapshot, type EfficiencyPoint, type PowerPoint, type RatioPoint, type RpmObservationMode, type RpmObservationView, type RpmPoint, type ShiftPoint } from './types'
import { findNearestTime, firstAnalysisTime, latestAnalysisTime } from './uiStore'

export type ChartId = 'scatter' | 'rpm1' | 'rpm2' | 'shift' | 'power' | 'efficiency' | 'shiftRatio' | 'shiftEfficiency'
export type ChartConfig = { id: ChartId; title: string; subtitle: string; color: string; visible: boolean }

export const defaultCharts: ChartConfig[] = [
  { id: 'scatter', title: 'Primary vs secondary RPM', subtitle: 'Speed relationship', color: '#f05d3b', visible: true },
  { id: 'shiftEfficiency', title: 'Ratio vs. efficiency', subtitle: 'Interval samples; no connecting trend', color: '#2f6f9e', visible: true },
  { id: 'rpm1', title: 'Primary RPM', subtitle: 'Analysed RPM / time', color: '#d8a227', visible: true },
  { id: 'rpm2', title: 'Secondary RPM', subtitle: 'Analysed RPM / time', color: '#3c8f88', visible: true },
  { id: 'shift', title: 'Shift position', subtitle: 'Actuator travel / time', color: '#b86b3a', visible: true },
  { id: 'power', title: 'Power', subtitle: 'Primary and secondary / same interval', color: '#f05d3b', visible: true },
  { id: 'efficiency', title: 'Efficiency', subtitle: 'Secondary / primary interval power', color: '#668b48', visible: true },
  { id: 'shiftRatio', title: 'Speed ratio', subtitle: 'Primary RPM / secondary RPM', color: '#7d5ba6', visible: true },
]

const MAX_CHART_POINTS = 1500
const MAX_OBSERVATION_POINTS = 1200
const OBSERVATION_QUERY_GRANULARITY_MS = 100
const DEFAULT_LIVE_WINDOW_MS = 10_000
const KW_TO_HP = 1.341022
const axisLabelStyle = { fill: '#8b8982', fontSize: 10 }
const lineProps = { isAnimationActive: false, animationDuration: 0, dot: false, activeDot: false, connectNulls: false }
const analysisDot = { r: 1.8, strokeWidth: 0 }

function clamp01(value: number) { return Math.min(1, Math.max(0, value)) }
function formatNumber(value: number, digits = 2) { return Number.isFinite(value) ? value.toFixed(digits) : '—' }

type WithSeconds<T> = T & { seconds: number }
type PowerRow = { time: number; seconds: number; power1?: number; power2?: number }
const EMPTY_TIME_DATA: readonly { time: number; seconds: number }[] = []
const EMPTY_RELATIONSHIP_DATA: readonly (WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>)[] = []
const EMPTY_RPM_OBSERVATIONS: WithSeconds<RpmPoint>[] = []
const DEFAULT_POWER_DOMAIN: [number, number] = [0, 1]
type ViewData = {
  primaryRpm: WithSeconds<RpmPoint>[]
  secondaryRpm: WithSeconds<RpmPoint>[]
  primaryObs: WithSeconds<RpmPoint>[]
  secondaryObs: WithSeconds<RpmPoint>[]
  shift: WithSeconds<ShiftPoint>[]
  ratioDots: WithSeconds<RatioPoint>[]
  ratioTime: WithSeconds<RatioPoint>[]
  efficiencyDots: WithSeconds<EfficiencyPoint>[]
  efficiencyTime: WithSeconds<EfficiencyPoint>[]
  power: PowerRow[]
}

type HoverListener = (time: number | null) => void

class HoverBus {
  private listeners = new Set<HoverListener>()
  private frame: number | null = null
  private pending: number | null = null
  private hasPending = false

  subscribe(listener: HoverListener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(time: number | null) {
    this.pending = time
    this.hasPending = true
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      if (!this.hasPending) return
      const next = this.pending
      this.hasPending = false
      for (const listener of this.listeners) listener(next)
    })
  }

  destroy() {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.listeners.clear()
  }
}

function lowerBoundTime<T extends { time: number }>(values: readonly T[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].time < target) low = mid + 1
    else high = mid
  }
  return low
}

function upperBoundTime<T extends { time: number }>(values: readonly T[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (values[mid].time <= target) low = mid + 1
    else high = mid
  }
  return low
}

function sliceTimeRange<T extends { time: number }>(values: readonly T[], start: number, end: number): readonly T[] {
  if (!values.length || end < start) return []
  return values.slice(lowerBoundTime(values, start), upperBoundTime(values, end))
}

function windowed<T extends { time: number }>(values: readonly T[], start: number, end: number, origin: number): WithSeconds<T>[] {
  const visible = sliceTimeRange(values, start, end)
  return downsampleForChart(visible, MAX_CHART_POINTS).map((point) => ({ ...point, seconds: (point.time - origin) / 1000 }))
}

function windowedDots<T extends { time: number }>(values: readonly T[], start: number, end: number, origin: number): WithSeconds<T>[] {
  return sliceTimeRange(values, start, end).map((point) => ({ ...point, seconds: (point.time - origin) / 1000 }))
}

function mergePower(primary: readonly PowerPoint[], secondary: readonly PowerPoint[], start: number, end: number, origin: number): PowerRow[] {
  const rows = new Map<number, PowerRow>()
  for (const point of sliceTimeRange(primary, start, end)) {
    rows.set(point.time, { time: point.time, seconds: (point.time - origin) / 1000, power1: point.powerKw })
  }
  for (const point of sliceTimeRange(secondary, start, end)) {
    const row = rows.get(point.time) ?? { time: point.time, seconds: (point.time - origin) / 1000 }
    row.power2 = point.powerKw
    rows.set(point.time, row)
  }
  return downsampleForChart([...rows.values()].sort((a, b) => a.time - b.time), MAX_CHART_POINTS)
}

function timeDecimals(visibleSpanMs: number): number {
  if (visibleSpanMs <= 1_000) return 3
  if (visibleSpanMs <= 10_000) return 2
  if (visibleSpanMs <= 120_000) return 1
  return 0
}

function formatTimeSeconds(valueSeconds: number, visibleSpanMs: number): string {
  if (!Number.isFinite(valueSeconds)) return '—'
  return valueSeconds.toFixed(timeDecimals(visibleSpanMs))
}

export function AnalysisWorkspace({
  series, chartPlaying, frozenDomainEnd, onToggleChartPlaying, analysisWindowMs, onAnalysisWindowChange,
  observationMode, onObservationModeChange, charts, setCharts, lowRatio, highRatio, onLowRatioChange,
  onHighRatioChange, droppedPackets, lostEdges, sourceLabel, requestObservations,
}: {
  series: AnalysisSnapshot
  chartPlaying: boolean
  frozenDomainEnd: number | null
  onToggleChartPlaying: () => void
  analysisWindowMs: number
  onAnalysisWindowChange: (value: number) => void
  observationMode: RpmObservationMode
  onObservationModeChange: (value: RpmObservationMode) => void
  charts: ChartConfig[]
  setCharts: Dispatch<SetStateAction<ChartConfig[]>>
  lowRatio: number
  highRatio: number
  onLowRatioChange: (value: number) => void
  onHighRatioChange: (value: number) => void
  droppedPackets: number
  lostEdges: [number, number]
  sourceLabel: string
  requestObservations: (mode: RpmObservationMode, startMs: number, endMs: number, maxPoints: number) => Promise<RpmObservationView>
}) {
  const [manualRange, setManualRange] = useState<{ start: number; end: number } | null>(null)
  const liveStart = firstAnalysisTime(series)
  const liveEnd = latestAnalysisTime(series)
  const timeOriginRef = useRef<number | null>(null)
  if (timeOriginRef.current === null && liveStart > 0) timeOriginRef.current = liveStart
  const timeOrigin = timeOriginRef.current ?? liveStart
  const domainEnd = chartPlaying || frozenDomainEnd === null ? liveEnd : Math.min(liveEnd, frozenDomainEnd)
  const domainStart = Math.min(liveStart, domainEnd)
  const domainSpan = Math.max(0, domainEnd - domainStart)
  const autoRangeStart = domainSpan <= DEFAULT_LIVE_WINDOW_MS ? 0 : 1 - DEFAULT_LIVE_WINDOW_MS / domainSpan
  const rangeStart = manualRange ? manualRange.start : autoRangeStart
  const rangeEnd = manualRange ? manualRange.end : 1
  const windowStartMs = domainStart + rangeStart * domainSpan
  const windowEndMs = domainStart + rangeEnd * domainSpan
  const [dragged, setDragged] = useState<ChartId | null>(null)
  const [observationView, setObservationView] = useState<RpmObservationView>({ primary: [], secondary: [] })
  const observationRequestRef = useRef(0)
  const observationQueryStart = Math.floor(windowStartMs / OBSERVATION_QUERY_GRANULARITY_MS) * OBSERVATION_QUERY_GRANULARITY_MS
  const observationQueryEnd = Math.ceil(windowEndMs / OBSERVATION_QUERY_GRANULARITY_MS) * OBSERVATION_QUERY_GRANULARITY_MS
  const hoverBusRef = useRef<HoverBus | null>(null)
  if (hoverBusRef.current === null) hoverBusRef.current = new HoverBus()
  const hoverBus = hoverBusRef.current

  useEffect(() => () => hoverBus.destroy(), [hoverBus])

  useEffect(() => {
    const requestId = ++observationRequestRef.current
    if (observationMode === 'none' || !(observationQueryEnd >= observationQueryStart)) {
      setObservationView({ primary: [], secondary: [] })
      return
    }
    void requestObservations(observationMode, observationQueryStart, observationQueryEnd, MAX_OBSERVATION_POINTS).then((view) => {
      if (observationRequestRef.current === requestId) setObservationView(view)
    })
  }, [observationMode, observationQueryStart, observationQueryEnd, requestObservations])

  const primaryRpm = useMemo(() => windowed(series.primaryRpm, windowStartMs, windowEndMs, timeOrigin), [series.primaryRpm, windowStartMs, windowEndMs, timeOrigin])
  const secondaryRpm = useMemo(() => windowed(series.secondaryRpm, windowStartMs, windowEndMs, timeOrigin), [series.secondaryRpm, windowStartMs, windowEndMs, timeOrigin])
  const primaryObs = useMemo(() => windowedDots(observationView.primary, windowStartMs, windowEndMs, timeOrigin), [observationView.primary, windowStartMs, windowEndMs, timeOrigin])
  const secondaryObs = useMemo(() => windowedDots(observationView.secondary, windowStartMs, windowEndMs, timeOrigin), [observationView.secondary, windowStartMs, windowEndMs, timeOrigin])
  const shift = useMemo(() => windowed(series.shift, windowStartMs, windowEndMs, timeOrigin), [series.shift, windowStartMs, windowEndMs, timeOrigin])
  const ratioDots = useMemo(() => windowedDots(series.ratio, windowStartMs, windowEndMs, timeOrigin), [series.ratio, windowStartMs, windowEndMs, timeOrigin])
  const ratioTime = useMemo(() => windowed(series.ratio, windowStartMs, windowEndMs, timeOrigin), [series.ratio, windowStartMs, windowEndMs, timeOrigin])
  const efficiencyDots = useMemo(() => windowedDots(series.efficiency, windowStartMs, windowEndMs, timeOrigin), [series.efficiency, windowStartMs, windowEndMs, timeOrigin])
  const efficiencyTime = useMemo(() => windowed(series.efficiency, windowStartMs, windowEndMs, timeOrigin), [series.efficiency, windowStartMs, windowEndMs, timeOrigin])
  const power = useMemo(() => mergePower(series.primaryPower, series.secondaryPower, windowStartMs, windowEndMs, timeOrigin), [series.primaryPower, series.secondaryPower, windowStartMs, windowEndMs, timeOrigin])
  const view = useMemo<ViewData>(() => ({ primaryRpm, secondaryRpm, primaryObs, secondaryObs, shift, ratioDots, ratioTime, efficiencyDots, efficiencyTime, power }), [primaryRpm, secondaryRpm, primaryObs, secondaryObs, shift, ratioDots, ratioTime, efficiencyDots, efficiencyTime, power])

  const scatterMax = useMemo(() => {
    let max = 10
    for (const point of ratioDots) max = Math.max(max, point.rpm1, point.rpm2)
    return max * 1.05
  }, [ratioDots])
  const efficiencyMax = useMemo(() => {
    let max = 0
    for (const point of efficiencyDots) max = Math.max(max, point.efficiencyPct)
    return Math.max(110, Math.ceil((max + 1) / 10) * 10)
  }, [efficiencyDots])
  const powerDomain = useMemo<[number, number]>(() => {
    let min = 0
    let max = 1
    for (const point of power) {
      if (Number.isFinite(point.power1)) { min = Math.min(min, point.power1 as number); max = Math.max(max, point.power1 as number) }
      if (Number.isFinite(point.power2)) { min = Math.min(min, point.power2 as number); max = Math.max(max, point.power2 as number) }
    }
    const pad = Math.max(0.25, 0.08 * (max - min || 1))
    return [min - pad, max + pad]
  }, [power])

  function reorder(target: ChartId) {
    if (!dragged || dragged === target) return
    const from = charts.findIndex((chart) => chart.id === dragged)
    const to = charts.findIndex((chart) => chart.id === target)
    const next = [...charts]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    setCharts(next)
    setDragged(null)
  }

  const pointCount = series.primaryRpm.length + series.secondaryRpm.length + series.primaryPower.length + series.secondaryPower.length + series.ratio.length + series.efficiency.length + series.shift.length

  return <>
    <section className="workspace-heading">
      <div><span className="section-kicker">02 / TELEMETRY</span><h2>Analysis workspace</h2></div>
      <div className="workspace-tools">
        <span><span className="status-dot is-live" />{pointCount.toLocaleString()} derived points</span>
        {droppedPackets > 0 && <span className="workspace-dropped" title="Packets lost after device queueing, detected via sequence numbers"><X size={13} />{droppedPackets.toLocaleString()} dropped</span>}
        {(lostEdges[0] + lostEdges[1]) > 0 && <span className="workspace-dropped" title={`Primary RPM: ${lostEdges[0].toLocaleString()} lost | Secondary RPM: ${lostEdges[1].toLocaleString()} lost`}><X size={13} />{(lostEdges[0] + lostEdges[1]).toLocaleString()} lost (device)</span>}
        <button className={`button ${chartPlaying ? 'button-quiet' : 'button-accent'}`} onClick={onToggleChartPlaying} title={chartPlaying ? 'Freeze the displayed view; capture and analysis continue' : 'Resume following the latest analysis'}>{chartPlaying ? <Pause size={15} /> : <Play size={15} />}{chartPlaying ? 'Freeze view' : 'View frozen'}</button>
        <label className="analysis-select"><span>Analysis interval</span><select value={analysisWindowMs} onChange={(event: ChangeEvent<HTMLSelectElement>) => onAnalysisWindowChange(Number(event.target.value))}>{ANALYSIS_WINDOWS_MS.map((value) => <option value={value} key={value}>{value} ms</option>)}</select></label>
        <label className="analysis-select"><span>RPM observations</span><select value={observationMode} onChange={(event: ChangeEvent<HTMLSelectElement>) => onObservationModeChange(event.target.value as RpmObservationMode)}><option value="none">None</option><option value="revolution">1-rev estimate</option><option value="tooth">Per tooth</option></select></label>
        <button className="button button-quiet" onClick={() => setCharts(defaultCharts)}><RotateCcw size={15} />Reset layout</button>
      </div>
    </section>
    {domainSpan > 0 && <section className="chart-range-bar"><TimeRangeSlider startFraction={rangeStart} endFraction={rangeEnd} onChange={(next: { start: number; end: number }) => setManualRange(next)} formatValue={(fraction: number) => `${formatTimeSeconds((domainStart + fraction * domainSpan - timeOrigin) / 1000, domainSpan)}s`} /><button className="button button-quiet chart-range-reset" onClick={() => setManualRange({ start: 0, end: 1 })}>Full range</button></section>}
    <section className="chart-grid">{charts.filter((chart) => chart.visible).map((chart) => <AnalysisChartCard
      key={chart.id} config={chart} view={view} hoverBus={hoverBus} timeOrigin={timeOrigin} windowStart={windowStartMs} windowEnd={windowEndMs}
      lowRatio={lowRatio} highRatio={highRatio} onLowRatioChange={onLowRatioChange} onHighRatioChange={onHighRatioChange}
      analysisWindowMs={analysisWindowMs} scatterMax={scatterMax} efficiencyMax={efficiencyMax} powerDomain={powerDomain}
      sourceLabel={sourceLabel} onDragStart={() => setDragged(chart.id)} onDrop={() => reorder(chart.id)}
      onHide={() => setCharts((items) => items.map((item) => item.id === chart.id ? { ...item, visible: false } : item))}
    />)}</section>
  </>
}

function AnalysisChartCard({ config, view, hoverBus, timeOrigin, windowStart, windowEnd, lowRatio, highRatio, onLowRatioChange, onHighRatioChange, analysisWindowMs, scatterMax, efficiencyMax, powerDomain, sourceLabel, onDragStart, onDrop, onHide }: {
  config: ChartConfig
  view: ViewData
  hoverBus: HoverBus
  timeOrigin: number
  windowStart: number
  windowEnd: number
  lowRatio: number
  highRatio: number
  onLowRatioChange: (value: number) => void
  onHighRatioChange: (value: number) => void
  analysisWindowMs: number
  scatterMax: number
  efficiencyMax: number
  powerDomain: [number, number]
  sourceLabel: string
  onDragStart: () => void
  onDrop: () => void
  onHide: () => void
}) {
  const chartBodyRef = useRef<HTMLDivElement | null>(null)
  const crosshairRef = useRef<HTMLDivElement | null>(null)
  const crosshairHRef = useRef<HTMLDivElement | null>(null)
  const readoutRef = useRef<HTMLSpanElement | null>(null)
  const plotRectRef = useRef<DOMRect | null>(null)
  const bodyRectRef = useRef<DOMRect | null>(null)
  const relationship = config.id === 'scatter' || config.id === 'shiftEfficiency'
  const visibleSpanMs = Math.max(0, windowEnd - windowStart)
  const visibleStartSeconds = (windowStart - timeOrigin) / 1000
  const visibleEndSeconds = (windowEnd - timeOrigin) / 1000
  const xDomain = useMemo<[number, number]>(() => visibleEndSeconds > visibleStartSeconds ? [visibleStartSeconds, visibleEndSeconds] : [visibleStartSeconds, visibleStartSeconds + 1], [visibleStartSeconds, visibleEndSeconds])

  const relationshipData = config.id === 'scatter' ? view.ratioDots
    : config.id === 'shiftEfficiency' ? view.efficiencyDots
    : EMPTY_RELATIONSHIP_DATA
  const timeData = config.id === 'rpm1' ? view.primaryRpm
    : config.id === 'rpm2' ? view.secondaryRpm
    : config.id === 'shift' ? view.shift
    : config.id === 'power' ? view.power
    : config.id === 'efficiency' ? view.efficiencyTime
    : config.id === 'shiftRatio' ? view.ratioTime
    : EMPTY_TIME_DATA
  const plotPrimaryObs = config.id === 'rpm1' ? view.primaryObs : EMPTY_RPM_OBSERVATIONS
  const plotSecondaryObs = config.id === 'rpm2' ? view.secondaryObs : EMPTY_RPM_OBSERVATIONS
  const plotScatterMax = config.id === 'scatter' ? scatterMax : 0
  const plotEfficiencyMax = config.id === 'efficiency' || config.id === 'shiftEfficiency' ? efficiencyMax : 110
  const plotPowerDomain = config.id === 'power' ? powerDomain : DEFAULT_POWER_DOMAIN
  const plotLowRatio = config.id === 'scatter' ? lowRatio : 0
  const plotHighRatio = config.id === 'scatter' ? highRatio : 0

  function measurePlotRect(chartBody: HTMLDivElement) {
    plotRectRef.current = chartBody.querySelector('.recharts-cartesian-grid-bg')?.getBoundingClientRect() ?? null
    bodyRectRef.current = chartBody.getBoundingClientRect()
  }

  useEffect(() => {
    const body = chartBodyRef.current
    if (!body) return
    measurePlotRect(body)
    const observer = new ResizeObserver(() => measurePlotRect(body))
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  const nearestRelationship = useCallback((targetX: number, targetY: number) => {
    if (config.id === 'scatter') {
      let best: WithSeconds<RatioPoint> | undefined
      let bestDistance = Infinity
      for (const point of view.ratioDots) {
        const dx = (point.rpm2 - targetX) / Math.max(scatterMax, 1)
        const dy = (point.rpm1 - targetY) / Math.max(scatterMax, 1)
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { best = point; bestDistance = distance }
      }
      return best
    }
    let best: WithSeconds<EfficiencyPoint> | undefined
    let bestDistance = Infinity
    for (const point of view.efficiencyDots) {
      const dx = (point.ratio - targetX) / 5.5
      const dy = (point.efficiencyPct - targetY) / Math.max(efficiencyMax, 1)
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) { best = point; bestDistance = distance }
    }
    return best
  }, [config.id, view.ratioDots, view.efficiencyDots, scatterMax, efficiencyMax])

  const hideHover = useCallback(() => {
    if (crosshairRef.current) crosshairRef.current.style.display = 'none'
    if (crosshairHRef.current) crosshairHRef.current.style.display = 'none'
    if (readoutRef.current) readoutRef.current.style.display = 'none'
  }, [])

  const updateHover = useCallback((hoverTime: number | null) => {
    const vertical = crosshairRef.current
    const horizontal = crosshairHRef.current
    const readout = readoutRef.current
    const bodyRect = bodyRectRef.current
    const plotRect = plotRectRef.current
    if (!vertical || !bodyRect || !plotRect || hoverTime === null || windowEnd <= windowStart) { hideHover(); return }

    let hovered: RpmPoint | ShiftPoint | RatioPoint | EfficiencyPoint | PowerRow | undefined
    if (config.id === 'rpm1') hovered = findNearestTime(view.primaryRpm, hoverTime)
    else if (config.id === 'rpm2') hovered = findNearestTime(view.secondaryRpm, hoverTime)
    else if (config.id === 'shift') hovered = findNearestTime(view.shift, hoverTime)
    else if (config.id === 'power') hovered = findNearestTime(view.power, hoverTime)
    else if (config.id === 'efficiency') hovered = findNearestTime(view.efficiencyTime, hoverTime)
    else if (config.id === 'shiftRatio') hovered = findNearestTime(view.ratioTime, hoverTime)
    else if (config.id === 'scatter') hovered = findNearestTime(view.ratioDots, hoverTime)
    else if (config.id === 'shiftEfficiency') hovered = findNearestTime(view.efficiencyDots, hoverTime)

    if (!relationship) {
      const f = clamp01((hoverTime - windowStart) / (windowEnd - windowStart))
      vertical.style.display = 'block'
      vertical.style.transform = `translate3d(${plotRect.left - bodyRect.left + f * plotRect.width}px,0,0)`
      if (horizontal) horizontal.style.display = 'none'
    } else {
      if (!hovered || plotRect.height <= 0) { hideHover(); return }
      let x = 0
      let y = 0
      if (config.id === 'scatter') {
        const point = hovered as RatioPoint
        x = point.rpm2 / scatterMax
        y = 1 - point.rpm1 / scatterMax
      } else {
        const point = hovered as EfficiencyPoint
        x = (point.ratio - 0.5) / 5.5
        y = 1 - point.efficiencyPct / efficiencyMax
      }
      vertical.style.display = 'block'
      vertical.style.transform = `translate3d(${plotRect.left - bodyRect.left + clamp01(x) * plotRect.width}px,0,0)`
      if (horizontal) {
        horizontal.style.display = 'block'
        horizontal.style.transform = `translate3d(0,${plotRect.top - bodyRect.top + clamp01(y) * plotRect.height}px,0)`
      }
    }

    if (!readout || !hovered) { if (readout) readout.style.display = 'none'; return }
    let text = ''
    if (config.id === 'rpm1' || config.id === 'rpm2') text = `${formatNumber((hovered as RpmPoint).rpm)} RPM`
    else if (config.id === 'shift') text = `${formatNumber((hovered as ShiftPoint).value)}%`
    else if (config.id === 'power') {
      const point = hovered as PowerRow
      text = `Pri ${formatNumber(point.power1 ?? Number.NaN)} kW / Sec ${formatNumber(point.power2 ?? Number.NaN)} kW`
    } else if (config.id === 'shiftRatio') text = formatNumber((hovered as RatioPoint).ratio, 3)
    else if (config.id === 'scatter') { const point = hovered as RatioPoint; text = `Sec ${formatNumber(point.rpm2)} / Pri ${formatNumber(point.rpm1)}` }
    else if (config.id === 'efficiency') text = `${formatNumber((hovered as EfficiencyPoint).efficiencyPct)}%`
    else if (config.id === 'shiftEfficiency') { const point = hovered as EfficiencyPoint; text = `Ratio ${formatNumber(point.ratio, 2)} / Eff ${formatNumber(point.efficiencyPct, 2)}%` }
    if (text) { readout.textContent = text; readout.style.display = '' }
    else readout.style.display = 'none'
  }, [config.id, efficiencyMax, hideHover, relationship, scatterMax, view, windowEnd, windowStart])

  useEffect(() => hoverBus.subscribe(updateHover), [hoverBus, updateHover])

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = plotRectRef.current
    if (!rect || rect.width <= 0) return
    const fx = clamp01((event.clientX - rect.left) / rect.width)
    if (!relationship) {
      hoverBus.publish(windowStart + fx * Math.max(0, windowEnd - windowStart))
      return
    }
    if (rect.height <= 0) return
    const fy = clamp01((event.clientY - rect.top) / rect.height)
    const targetX = config.id === 'scatter' ? fx * scatterMax : 0.5 + fx * 5.5
    const targetY = (1 - fy) * (config.id === 'scatter' ? scatterMax : efficiencyMax)
    const nearest = nearestRelationship(targetX, targetY)
    if (nearest) hoverBus.publish(nearest.time)
  }

  const headerControls = config.id === 'scatter' ? <div className="chart-ratio-inputs"><label className="ratio-input" style={{ color: '#d8a227' }}><span>Low ratio</span><input type="number" step="0.01" min="0" value={lowRatio} onChange={(event: ChangeEvent<HTMLInputElement>) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onLowRatioChange(value) }} /></label><label className="ratio-input" style={{ color: '#3c8f88' }}><span>High ratio</span><input type="number" step="0.01" min="0" value={highRatio} onChange={(event: ChangeEvent<HTMLInputElement>) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onHighRatioChange(value) }} /></label></div> : null

  return <article className="chart-card" onDragOver={(event: DragEvent<HTMLElement>) => event.preventDefault()} onDrop={onDrop}>
    <header className="chart-header"><div className="drag-handle" title="Drag to reorder" draggable onDragStart={onDragStart}><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div>{headerControls}<button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header>
    <div className="chart-body" ref={chartBodyRef} onMouseMove={handleMouseMove} onMouseLeave={() => hoverBus.publish(null)}>
      <AnalysisPlot config={config} timeData={timeData} relationshipData={relationshipData} primaryObs={plotPrimaryObs} secondaryObs={plotSecondaryObs} xDomain={xDomain} visibleSpanMs={visibleSpanMs} scatterMax={plotScatterMax} efficiencyMax={plotEfficiencyMax} powerDomain={plotPowerDomain} lowRatio={plotLowRatio} highRatio={plotHighRatio} />
      <div ref={crosshairRef} className="chart-crosshair-line" style={{ display: 'none' }} />
      {relationship && <div ref={crosshairHRef} className="chart-crosshair-line-h" style={{ display: 'none' }} />}
    </div>
    <div className="chart-footer"><span style={{ color: config.color }}>● {sourceLabel}</span><span ref={readoutRef} className="hover-readout" style={{ display: 'none' }} /><span>{config.id === 'power' ? `${analysisWindowMs} ms · kW / hp` : config.id === 'efficiency' || config.id === 'shiftEfficiency' ? `${analysisWindowMs} ms · %` : config.id === 'shiftRatio' ? 'Ratio' : `Visible: ${(visibleSpanMs / 1000).toFixed(1)} s`}</span></div>
  </article>
}

const AnalysisPlot = memo(function AnalysisPlot({ config, timeData, relationshipData, primaryObs, secondaryObs, xDomain, visibleSpanMs, scatterMax, efficiencyMax, powerDomain, lowRatio, highRatio }: {
  config: ChartConfig
  timeData: readonly { time: number; seconds: number }[]
  relationshipData: readonly (WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>)[]
  primaryObs: WithSeconds<RpmPoint>[]
  secondaryObs: WithSeconds<RpmPoint>[]
  xDomain: [number, number]
  visibleSpanMs: number
  scatterMax: number
  efficiencyMax: number
  powerDomain: [number, number]
  lowRatio: number
  highRatio: number
}) {
  const xTick = useCallback((value: number) => `${formatTimeSeconds(value, visibleSpanMs)}s`, [visibleSpanMs])
  const chartData = (config.id === 'scatter' || config.id === 'shiftEfficiency') ? relationshipData : timeData
  const lowRatioLine = useMemo(() => [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * lowRatio }], [scatterMax, lowRatio])
  const highRatioLine = useMemo(() => [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * highRatio }], [scatterMax, highRatio])
  const powerPadDomain: [number, number] = powerDomain
  const timeAxis = (unit: string, domain?: [number, number]) => <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={xDomain} allowDataOverflow tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={xTick} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={46} domain={domain} allowDataOverflow={domain !== undefined} label={{ value: unit, angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const powerAxis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={xDomain} allowDataOverflow tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={xTick} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis yAxisId="kw" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={42} domain={powerPadDomain} label={{ value: 'kW', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /><YAxis yAxisId="hp" orientation="right" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={42} domain={[powerPadDomain[0] * KW_TO_HP, powerPadDomain[1] * KW_TO_HP]} label={{ value: 'hp', angle: 90, position: 'insideRight', style: axisLabelStyle }} /></>

  return <ResponsiveContainer width="100%" height="100%"><LineChart data={chartData as never[]} margin={{ top: 8, right: config.id === 'power' ? 4 : 14, left: 4, bottom: 14 }}>
    {config.id === 'power' ? powerAxis : config.id === 'scatter' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="rpm2" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Secondary RPM', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="rpm1" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: 'Primary RPM', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : config.id === 'shiftEfficiency' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="ratio" domain={[0.5, 6]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Speed ratio', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="efficiencyPct" domain={[0, efficiencyMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: '%', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : config.id === 'rpm1' || config.id === 'rpm2' ? timeAxis('RPM') : config.id === 'shift' ? timeAxis('%') : config.id === 'efficiency' ? timeAxis('%', [0, efficiencyMax]) : timeAxis('Ratio', [0, 6])}
    {config.id === 'scatter' && <><Line data={lowRatioLine} type="linear" dataKey="rpm1" stroke="#d8a227" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line data={highRatioLine} type="linear" dataKey="rpm1" stroke="#3c8f88" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line type="linear" dataKey="rpm1" stroke="transparent" {...lineProps} dot={{ r: 2.2, fill: config.color, stroke: 'none' }} /></>}
    {config.id === 'shiftEfficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="linear" dataKey="efficiencyPct" stroke="transparent" {...lineProps} dot={{ r: 2.5, fill: config.color, fillOpacity: .62, stroke: 'none' }} /></>}
    {config.id === 'rpm1' && <><Line data={primaryObs} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={{ r: 1.5, fill: config.color, fillOpacity: .24, stroke: 'none' }} /><Line type="linear" dataKey="rpm" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} /></>}
    {config.id === 'rpm2' && <><Line data={secondaryObs} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={{ r: 1.5, fill: config.color, fillOpacity: .24, stroke: 'none' }} /><Line type="linear" dataKey="rpm" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} /></>}
    {config.id === 'shift' && <Line type="linear" dataKey="value" stroke={config.color} strokeWidth={2} {...lineProps} />}
    {config.id === 'power' && <><Line type="linear" dataKey="power1" yAxisId="kw" stroke="#f05d3b" strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: '#f05d3b' }} /><Line type="linear" dataKey="power2" yAxisId="kw" stroke="#3c8f88" strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: '#3c8f88' }} /></>}
    {config.id === 'efficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="linear" dataKey="efficiencyPct" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} /></>}
    {config.id === 'shiftRatio' && <Line type="linear" dataKey="ratio" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} />}
  </LineChart></ResponsiveContainer>
})
