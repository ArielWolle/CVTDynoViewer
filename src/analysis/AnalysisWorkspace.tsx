import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type Dispatch, type DragEvent, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
import { GripVertical, Pause, Play, RotateCcw, X } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { TimeRangeSlider } from '../TimeRangeSlider'
import { ANALYSIS_WINDOWS_MS, type EfficiencyPoint, type RatioPoint, type RpmObservationMode, type RpmObservationView, type RpmPoint, type ShiftPoint } from './types'
import { findNearestTime } from './uiStore'
import { AnalysisStore, type PowerRow, type WithSeconds } from './store'
import { nearestProjectedPoint, projectToPlot, type PlotRect as RelationshipPlotRect } from './relationshipHover'

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

type RelationshipSnap = { time: number; xPx: number; yPx: number; readout: string }
type HoverEvent = { time: number | null; sourceChartId: ChartId | null; relationshipSnap?: RelationshipSnap }
type HoverListener = (event: HoverEvent) => void

class HoverBus {
  private listeners = new Set<HoverListener>()
  private frame: number | null = null
  private pending: HoverEvent = { time: null, sourceChartId: null }
  private hasPending = false

  subscribe(listener: HoverListener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(event: HoverEvent) {
    this.pending = event
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

function observationDots(values: readonly RpmPoint[], start: number, end: number, origin: number): WithSeconds<RpmPoint>[] {
  return values
    .filter((point) => point.time >= start && point.time <= end)
    .map((point) => ({ ...point, seconds: (point.time - origin) / 1000 }))
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

function niceStep(span: number, targetIntervals = 5): number {
  if (!Number.isFinite(span) || span <= 0) return 1
  const raw = span / Math.max(1, targetIntervals)
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  return multiplier * magnitude
}

function niceDomain(min: number, max: number, targetIntervals = 5): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [0, 1]
  const step = niceStep(max - min, targetIntervals)
  const lower = Math.floor(min / step) * step
  const upper = Math.ceil(max / step) * step
  return [Math.abs(lower) < step * 1e-9 ? 0 : lower, Math.abs(upper) < step * 1e-9 ? 0 : upper]
}

function ticksForDomain(domain: [number, number], targetIntervals = 5): number[] {
  const [min, max] = domain
  const step = niceStep(max - min, targetIntervals)
  const first = Math.ceil((min - step * 1e-9) / step) * step
  const ticks: number[] = []
  for (let value = first, guard = 0; value <= max + step * 1e-9 && guard < 32; value += step, guard += 1) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)))
  }
  return ticks
}

function axisDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0
  if (step >= 1) return Math.abs(step - Math.round(step)) < 1e-9 ? 0 : 1
  if (step >= 0.1) return 1
  if (step >= 0.01) return 2
  return 3
}

function formatAxisTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(axisDecimals(step))
}

function niceRpmCeiling(value: number): number {
  const padded = Math.max(100, value * 1.05)
  const step = niceStep(padded, 8)
  return Math.ceil(padded / step) * step
}

function AnalysisPointCount({ store }: { store: AnalysisStore }) {
  const status = useSyncExternalStore(store.subscribe, store.getStatusSnapshot, store.getStatusSnapshot)
  return <span><span className="status-dot is-live" />{status.totalCount.toLocaleString()} derived points</span>
}

function AnalysisWorkspaceComponent({
  store, chartPlaying, frozenDomainEnd, onToggleChartPlaying, analysisWindowMs, onAnalysisWindowChange,
  observationMode, onObservationModeChange, charts, setCharts, lowRatio, highRatio, onLowRatioChange,
  onHighRatioChange, droppedPackets, lostEdges, sourceLabel, requestObservations,
}: {
  store: AnalysisStore
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
  // Live charts subscribe to every derived-data revision. Frozen charts subscribe only to
  // replace/reset generations, so appends after the frozen end do not wake the chart tree at all.
  const workspaceSnapshot = chartPlaying ? store.getStatusSnapshot : store.getStructuralSnapshot
  const subscribedStatus = useSyncExternalStore(store.subscribe, workspaceSnapshot, workspaceSnapshot)
  const frozenStatusRef = useRef(subscribedStatus)
  if (chartPlaying || subscribedStatus.generation !== frozenStatusRef.current.generation) frozenStatusRef.current = subscribedStatus
  const status = frozenStatusRef.current
  const liveStart = status.firstTime
  const liveEnd = status.latestTime
  const timeOriginRef = useRef<number | null>(null)
  const generationRef = useRef(status.generation)
  if (generationRef.current !== status.generation) {
    generationRef.current = status.generation
    timeOriginRef.current = liveStart > 0 ? liveStart : null
  }
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

  const storedView = useMemo(
    () => store.viewport(windowStartMs, windowEndMs, timeOrigin, MAX_CHART_POINTS),
    [store, status.revision, windowStartMs, windowEndMs, timeOrigin],
  )
  const primaryObs = useMemo(() => observationDots(observationView.primary, windowStartMs, windowEndMs, timeOrigin), [observationView.primary, windowStartMs, windowEndMs, timeOrigin])
  const secondaryObs = useMemo(() => observationDots(observationView.secondary, windowStartMs, windowEndMs, timeOrigin), [observationView.secondary, windowStartMs, windowEndMs, timeOrigin])
  const { primaryRpm, secondaryRpm, shift, ratioDots, ratioTime, efficiencyDots, efficiencyTime, power } = storedView
  const view = useMemo<ViewData>(() => ({ ...storedView, primaryObs, secondaryObs }), [storedView, primaryObs, secondaryObs])

  const scatterMax = useMemo(() => {
    let max = 10
    for (const point of ratioDots) max = Math.max(max, point.rpm1, point.rpm2)
    return niceRpmCeiling(max)
  }, [ratioDots])
  const efficiencyMax = useMemo(() => {
    let max = 0
    for (const point of efficiencyDots) max = Math.max(max, point.efficiencyPct)
    return Math.max(110, Math.ceil((max + 1) / 10) * 10)
  }, [efficiencyDots])
  const powerDomain = useMemo<[number, number]>(() => {
    let min = Infinity
    let max = -Infinity
    for (const point of power) {
      if (Number.isFinite(point.power1)) { min = Math.min(min, point.power1 as number); max = Math.max(max, point.power1 as number) }
      if (Number.isFinite(point.power2)) { min = Math.min(min, point.power2 as number); max = Math.max(max, point.power2 as number) }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1]
    const span = Math.max(0.5, max - min)
    const pad = Math.max(0.25, 0.08 * span)
    const paddedMin = min < 0 ? min - pad : 0
    const paddedMax = max + pad
    return niceDomain(paddedMin, paddedMax, 5)
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

  return <>
    <section className="workspace-heading">
      <div><span className="section-kicker">02 / TELEMETRY</span><h2>Analysis workspace</h2></div>
      <div className="workspace-tools">
        <AnalysisPointCount store={store} />
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

export const AnalysisWorkspace = memo(AnalysisWorkspaceComponent)

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

  const relationshipDomains = useMemo<{ x: [number, number]; y: [number, number] }>(() => (
    config.id === 'scatter'
      ? { x: [0, scatterMax], y: [0, scatterMax] }
      : { x: [0.5, 6], y: [0, efficiencyMax] }
  ), [config.id, scatterMax, efficiencyMax])

  const relationshipX = useCallback((point: WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>) => (
    config.id === 'scatter' ? (point as RatioPoint).rpm2 : (point as EfficiencyPoint).ratio
  ), [config.id])

  const relationshipY = useCallback((point: WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>) => (
    config.id === 'scatter' ? (point as RatioPoint).rpm1 : (point as EfficiencyPoint).efficiencyPct
  ), [config.id])

  const relationshipReadout = useCallback((point: WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>) => (
    config.id === 'scatter'
      ? `Sec ${formatNumber((point as RatioPoint).rpm2)} / Pri ${formatNumber((point as RatioPoint).rpm1)}`
      : `Ratio ${formatNumber((point as EfficiencyPoint).ratio, 2)} / Eff ${formatNumber((point as EfficiencyPoint).efficiencyPct, 2)}%`
  ), [config.id])

  const localRelationshipPlot = useCallback((): RelationshipPlotRect | null => {
    const plotRect = plotRectRef.current
    const measuredBodyRect = bodyRectRef.current
    if (!plotRect || !measuredBodyRect || !(plotRect.width > 0) || !(plotRect.height > 0)) return null
    return {
      left: plotRect.left - measuredBodyRect.left,
      top: plotRect.top - measuredBodyRect.top,
      width: plotRect.width,
      height: plotRect.height,
    }
  }, [])

  const relationshipSnapForPoint = useCallback((point: WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>): RelationshipSnap | undefined => {
    const plot = localRelationshipPlot()
    if (!plot) return undefined
    const projected = projectToPlot(relationshipX(point), relationshipY(point), relationshipDomains.x, relationshipDomains.y, plot)
    if (!projected) return undefined
    return {
      time: point.time,
      xPx: projected.xPx,
      yPx: projected.yPx,
      readout: relationshipReadout(point),
    }
  }, [localRelationshipPlot, relationshipDomains, relationshipReadout, relationshipX, relationshipY])

  const measurePlotRect = useCallback((chartBody: HTMLDivElement) => {
    plotRectRef.current = chartBody.querySelector('.recharts-cartesian-grid-bg')?.getBoundingClientRect() ?? null
    bodyRectRef.current = chartBody.getBoundingClientRect()
  }, [])

  useEffect(() => {
    const body = chartBodyRef.current
    if (!body) return
    measurePlotRect(body)
    const observer = new ResizeObserver(() => measurePlotRect(body))
    observer.observe(body)
    return () => observer.disconnect()
  }, [measurePlotRect])

  const nearestRelationship = useCallback((mouseX: number, mouseY: number): RelationshipSnap | undefined => {
    if (!relationship) return undefined
    const body = chartBodyRef.current
    if ((!plotRectRef.current || !bodyRectRef.current) && body) measurePlotRect(body)

    const plot = localRelationshipPlot()
    if (!plot) return undefined

    // Pure arithmetic over the visible data. No SVG querySelector and no per-dot layout reads.
    const nearest = nearestProjectedPoint(
      relationshipData,
      mouseX,
      mouseY,
      relationshipDomains.x,
      relationshipDomains.y,
      plot,
      relationshipX,
      relationshipY,
    )
    if (!nearest) return undefined

    return {
      time: nearest.point.time,
      xPx: nearest.xPx,
      yPx: nearest.yPx,
      readout: relationshipReadout(nearest.point),
    }
  }, [
    localRelationshipPlot,
    measurePlotRect,
    relationship,
    relationshipData,
    relationshipDomains,
    relationshipReadout,
    relationshipX,
    relationshipY,
  ])

  const hideHover = useCallback(() => {
    if (crosshairRef.current) crosshairRef.current.style.display = 'none'
    if (crosshairHRef.current) crosshairHRef.current.style.display = 'none'
    if (readoutRef.current) readoutRef.current.style.display = 'none'
  }, [])

  const updateHover = useCallback((hoverEvent: HoverEvent) => {
    const hoverTime = hoverEvent.time
    const vertical = crosshairRef.current
    const horizontal = crosshairHRef.current
    const readout = readoutRef.current
    const bodyRect = bodyRectRef.current
    const plotRect = plotRectRef.current
    if (!vertical || !bodyRect || !plotRect || hoverTime === null || windowEnd <= windowStart) { hideHover(); return }

    let relationshipSnap = relationship && hoverEvent.sourceChartId === config.id ? hoverEvent.relationshipSnap : undefined
    if (relationship && !relationshipSnap) {
      const point = findNearestTime(relationshipData, hoverTime)
      if (point) relationshipSnap = relationshipSnapForPoint(point)
    }

    let hovered: RpmPoint | ShiftPoint | RatioPoint | EfficiencyPoint | PowerRow | undefined
    if (!relationship) {
      if (config.id === 'rpm1') hovered = findNearestTime(view.primaryRpm, hoverTime)
      else if (config.id === 'rpm2') hovered = findNearestTime(view.secondaryRpm, hoverTime)
      else if (config.id === 'shift') hovered = findNearestTime(view.shift, hoverTime)
      else if (config.id === 'power') hovered = findNearestTime(view.power, hoverTime)
      else if (config.id === 'efficiency') hovered = findNearestTime(view.efficiencyTime, hoverTime)
      else if (config.id === 'shiftRatio') hovered = findNearestTime(view.ratioTime, hoverTime)
    }

    if (!relationship) {
      const f = clamp01((hoverTime - windowStart) / (windowEnd - windowStart))
      vertical.style.display = 'block'
      vertical.style.transform = `translate3d(${plotRect.left - bodyRect.left + f * plotRect.width}px,0,0)`
      if (horizontal) horizontal.style.display = 'none'
    } else {
      if (!relationshipSnap) { hideHover(); return }
      // The snap is projected into the exact plot rectangle from the chart's linear domains.
      vertical.style.display = 'block'
      vertical.style.transform = `translate3d(${relationshipSnap.xPx}px,0,0)`
      if (horizontal) {
        horizontal.style.display = 'block'
        horizontal.style.transform = `translate3d(0,${relationshipSnap.yPx}px,0)`
      }
    }

    if (!readout) return
    if (relationshipSnap) {
      readout.textContent = relationshipSnap.readout
      readout.style.display = ''
      return
    }
    if (!hovered) { readout.style.display = 'none'; return }
    let text = ''
    if (config.id === 'rpm1' || config.id === 'rpm2') text = `${formatNumber((hovered as RpmPoint).rpm)} RPM`
    else if (config.id === 'shift') text = `${formatNumber((hovered as ShiftPoint).value)}%`
    else if (config.id === 'power') {
      const p = hovered as PowerRow
      text = `Pri ${formatNumber(p.power1 ?? Number.NaN)} kW / Sec ${formatNumber(p.power2 ?? Number.NaN)} kW`
    } else if (config.id === 'shiftRatio') text = formatNumber((hovered as RatioPoint).ratio, 3)
    else if (config.id === 'efficiency') text = `${formatNumber((hovered as EfficiencyPoint).efficiencyPct)}%`
    if (text) { readout.textContent = text; readout.style.display = '' }
    else readout.style.display = 'none'
  }, [config.id, hideHover, relationship, view, windowEnd, windowStart])

  useEffect(() => hoverBus.subscribe(updateHover), [hoverBus, updateHover])

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = plotRectRef.current
    if (!rect || rect.width <= 0) return
    const fx = clamp01((event.clientX - rect.left) / rect.width)
    if (!relationship) {
      hoverBus.publish({ time: windowStart + fx * Math.max(0, windowEnd - windowStart), sourceChartId: config.id })
      return
    }
    const bodyRect = event.currentTarget.getBoundingClientRect()
    const nearest = nearestRelationship(event.clientX - bodyRect.left, event.clientY - bodyRect.top)
    if (nearest) hoverBus.publish({ time: nearest.time, sourceChartId: config.id, relationshipSnap: nearest })
  }

  const headerControls = config.id === 'scatter' ? <div className="chart-ratio-inputs"><label className="ratio-input" style={{ color: '#d8a227' }}><span>Low ratio</span><input type="number" step="0.01" min="0" value={lowRatio} onChange={(event: ChangeEvent<HTMLInputElement>) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onLowRatioChange(value) }} /></label><label className="ratio-input" style={{ color: '#3c8f88' }}><span>High ratio</span><input type="number" step="0.01" min="0" value={highRatio} onChange={(event: ChangeEvent<HTMLInputElement>) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onHighRatioChange(value) }} /></label></div> : null

  return <article className="chart-card" onDragOver={(event: DragEvent<HTMLElement>) => event.preventDefault()} onDrop={onDrop}>
    <header className="chart-header"><div className="drag-handle" title="Drag to reorder" draggable onDragStart={onDragStart}><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div>{headerControls}<button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header>
    <div className="chart-body" ref={chartBodyRef} onMouseMove={handleMouseMove} onMouseLeave={() => hoverBus.publish({ time: null, sourceChartId: null })}>
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
  const powerTicks = useMemo(() => ticksForDomain(powerDomain, 5), [powerDomain])
  const powerStep = powerTicks.length >= 2 ? powerTicks[1] - powerTicks[0] : niceStep(powerDomain[1] - powerDomain[0], 5)
  const hpTicks = useMemo(() => powerTicks.map((value) => value * KW_TO_HP), [powerTicks])
  const hpStep = powerStep * KW_TO_HP
  const scatterTicks = useMemo(() => {
    const step = niceStep(scatterMax, 8)
    const ticks: number[] = []
    for (let value = 0, guard = 0; value <= scatterMax + step * 1e-9 && guard < 24; value += step, guard += 1) ticks.push(Math.round(value))
    if (ticks[ticks.length - 1] !== Math.round(scatterMax)) ticks.push(Math.round(scatterMax))
    return ticks
  }, [scatterMax])
  const ratioTicks = useMemo(() => [0, 1, 2, 3, 4, 5, 6], [])
  const ratioRelationshipTicks = useMemo(() => [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6], [])
  const lowRatioLine = useMemo(() => [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * lowRatio }], [scatterMax, lowRatio])
  const highRatioLine = useMemo(() => [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * highRatio }], [scatterMax, highRatio])
  const powerPadDomain: [number, number] = powerDomain
  const timeAxis = (unit: string, domain?: [number, number], ticks?: number[]) => <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={xDomain} allowDataOverflow tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={xTick} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={46} domain={domain} ticks={ticks} allowDataOverflow={domain !== undefined} label={{ value: unit, angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const powerAxis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={xDomain} allowDataOverflow tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={xTick} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis yAxisId="kw" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => formatAxisTick(value, powerStep)} ticks={powerTicks} width={46} domain={powerPadDomain} allowDataOverflow label={{ value: 'kW', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /><YAxis yAxisId="hp" orientation="right" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => formatAxisTick(value, hpStep)} ticks={hpTicks} width={46} domain={[powerPadDomain[0] * KW_TO_HP, powerPadDomain[1] * KW_TO_HP]} allowDataOverflow label={{ value: 'hp', angle: 90, position: 'insideRight', style: axisLabelStyle }} /></>

  return <ResponsiveContainer width="100%" height="100%"><LineChart data={chartData as never[]} margin={{ top: 8, right: config.id === 'power' ? 4 : 14, left: 4, bottom: 14 }}>
    {config.id === 'power' ? powerAxis : config.id === 'scatter' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="rpm2" domain={[0, scatterMax]} ticks={scatterTicks} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => Math.round(value).toString()} label={{ value: 'Secondary RPM', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="rpm1" domain={[0, scatterMax]} ticks={scatterTicks} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => Math.round(value).toString()} width={50} label={{ value: 'Primary RPM', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : config.id === 'shiftEfficiency' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="ratio" domain={[0.5, 6]} ticks={ratioRelationshipTicks} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} label={{ value: 'Speed ratio', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="efficiencyPct" domain={[0, efficiencyMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: '%', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : config.id === 'rpm1' || config.id === 'rpm2' ? timeAxis('RPM') : config.id === 'shift' ? timeAxis('%') : config.id === 'efficiency' ? timeAxis('%', [0, efficiencyMax]) : timeAxis('Ratio', [0, 6], ratioTicks)}
    {config.id === 'scatter' && <><Line data={lowRatioLine} type="linear" dataKey="rpm1" stroke="#d8a227" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line data={highRatioLine} type="linear" dataKey="rpm1" stroke="#3c8f88" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line type="linear" dataKey="rpm1" stroke="transparent" {...lineProps} dot={{ r: 2.2, fill: config.color, stroke: 'none' }} /></>}
    {config.id === 'shiftEfficiency' && <><ReferenceLine x={1} stroke="#8b8982" strokeDasharray="3 4" strokeWidth={1} /><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="linear" dataKey="efficiencyPct" stroke="transparent" {...lineProps} dot={{ r: 2.5, fill: config.color, fillOpacity: .62, stroke: 'none' }} /></>}
    {config.id === 'rpm1' && <><Line data={primaryObs} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={{ r: 1.5, fill: config.color, fillOpacity: .24, stroke: 'none' }} /><Line type="linear" dataKey="rpm" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} /></>}
    {config.id === 'rpm2' && <><Line data={secondaryObs} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={{ r: 1.5, fill: config.color, fillOpacity: .24, stroke: 'none' }} /><Line type="linear" dataKey="rpm" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} /></>}
    {config.id === 'shift' && <Line type="linear" dataKey="value" stroke={config.color} strokeWidth={2} {...lineProps} />}
    {config.id === 'power' && <><Line type="linear" dataKey="power1" yAxisId="kw" stroke="#f05d3b" strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: '#f05d3b' }} /><Line type="linear" dataKey="power2" yAxisId="kw" stroke="#3c8f88" strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: '#3c8f88' }} /></>}
    {config.id === 'efficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="linear" dataKey="efficiencyPct" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} /></>}
    {config.id === 'shiftRatio' && <><ReferenceLine y={1} stroke="#8b8982" strokeDasharray="3 4" strokeWidth={1} /><Line type="linear" dataKey="ratio" stroke={config.color} strokeWidth={2} {...lineProps} dot={{ ...analysisDot, fill: config.color }} /></>}
  </LineChart></ResponsiveContainer>
})
