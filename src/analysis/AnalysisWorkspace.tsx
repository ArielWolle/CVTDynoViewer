import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type Dispatch, type DragEvent, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
import { GripVertical, Pause, Play, RotateCcw, X } from 'lucide-react'
import { CartesianGrid, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { TimeRangeSlider } from '../TimeRangeSlider'
import { ANALYSIS_WINDOWS_MS, type EfficiencyPoint, type RatioPoint, type RpmObservationMode, type RpmObservationView, type RpmPoint, type ShiftPoint } from './types'
import { findNearestTime } from './uiStore'
import { AnalysisStore, type PowerRow, type WithSeconds } from './store'
import { nearestProjectedPoint, projectToPlot } from './relationshipHover'
import { TelemetryCanvas } from './TelemetryCanvas'
import { usePlotGeometry } from './usePlotGeometry'
import type { NumericDomain, PlotGeometry } from './plotGeometry'
import type { ChartConfig, ChartId } from './chartTypes'

export type { ChartConfig, ChartId } from './chartTypes'

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

function clamp01(value: number) { return Math.min(1, Math.max(0, value)) }
function formatNumber(value: number, digits = 2) { return Number.isFinite(value) ? value.toFixed(digits) : '—' }

type TimeChartDatum = WithSeconds<RpmPoint> | WithSeconds<ShiftPoint> | WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint> | PowerRow
type RelationshipDatum = WithSeconds<RatioPoint> | WithSeconds<EfficiencyPoint>
const EMPTY_TIME_DATA: readonly TimeChartDatum[] = []
const EMPTY_RELATIONSHIP_DATA: readonly RelationshipDatum[] = []
const EMPTY_RPM_OBSERVATIONS: readonly WithSeconds<RpmPoint>[] = []
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

function useStableDomain(domain: [number, number]): [number, number] {
  const stable = useRef<[number, number]>(domain)
  if (stable.current[0] !== domain[0] || stable.current[1] !== domain[1]) stable.current = domain
  return stable.current
}

function AnalysisPointCount({ store }: { store: AnalysisStore }) {
  const status = useSyncExternalStore(store.subscribe, store.getStatusSnapshot, store.getStatusSnapshot)
  return <span><span className="status-dot is-live" />{status.totalCount.toLocaleString()} derived points</span>
}

function AnalysisWorkspaceComponent({
  store, chartPlaying, frozenDomainEnd, onToggleChartPlaying, analysisWindowMs, onAnalysisWindowChange,
  observationMode, onObservationModeChange, charts, setCharts, lowRatio, highRatio, onLowRatioChange,
  onHighRatioChange, sourceLabel, requestObservations, initialFullRange = false,
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
  sourceLabel: string
  requestObservations: (mode: RpmObservationMode, startMs: number, endMs: number, maxPoints: number) => Promise<RpmObservationView>
  initialFullRange?: boolean
}) {
  const [manualRange, setManualRange] = useState<{ start: number; end: number } | null>(
    () => initialFullRange ? { start: 0, end: 1 } : null,
  )
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
    void requestObservations(observationMode, observationQueryStart, observationQueryEnd, MAX_OBSERVATION_POINTS).then((nextView) => {
      if (observationRequestRef.current === requestId) setObservationView(nextView)
    })
  }, [observationMode, observationQueryStart, observationQueryEnd, requestObservations])

  const storedView = useMemo(
    () => store.viewport(windowStartMs, windowEndMs, timeOrigin, MAX_CHART_POINTS),
    [store, status.revision, windowStartMs, windowEndMs, timeOrigin],
  )
  const primaryObs = useMemo(() => observationDots(observationView.primary, windowStartMs, windowEndMs, timeOrigin), [observationView.primary, windowStartMs, windowEndMs, timeOrigin])
  const secondaryObs = useMemo(() => observationDots(observationView.secondary, windowStartMs, windowEndMs, timeOrigin), [observationView.secondary, windowStartMs, windowEndMs, timeOrigin])
  const { ratioDots, efficiencyDots, power } = storedView
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
    return niceDomain(paddedMin, max + pad, 5)
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
        <button className={`button ${chartPlaying ? 'button-quiet' : 'button-accent'}`} onClick={onToggleChartPlaying} title={chartPlaying ? 'Freeze the displayed view; capture and analysis continue' : 'Resume following the latest analysis'}>{chartPlaying ? <Pause size={15} /> : <Play size={15} />}{chartPlaying ? 'Freeze view' : 'View frozen'}</button>
        <label className="analysis-select"><span>Analysis interval</span><select value={analysisWindowMs} onChange={(event: ChangeEvent<HTMLSelectElement>) => onAnalysisWindowChange(Number(event.target.value))}>{ANALYSIS_WINDOWS_MS.map((value) => <option value={value} key={value}>{value} ms</option>)}</select></label>
        <label className="analysis-select"><span>RPM observations</span><select value={observationMode} onChange={(event: ChangeEvent<HTMLSelectElement>) => onObservationModeChange(event.target.value as RpmObservationMode)}><option value="none">None</option><option value="revolution">1-rev estimate</option><option value="tooth">Per tooth</option></select></label>
        <button className="button button-quiet" onClick={() => setCharts(defaultCharts)}><RotateCcw size={15} />Reset layout</button>
      </div>
    </section>
    {domainSpan > 0 && <section className="chart-range-bar"><TimeRangeSlider startFraction={rangeStart} endFraction={rangeEnd} onChange={(next: { start: number; end: number }) => setManualRange(next)} formatValue={(fraction: number) => `${formatTimeSeconds((domainStart + fraction * domainSpan - timeOrigin) / 1000, domainSpan)}s`} /><button className="button button-quiet chart-range-reset" onClick={() => setManualRange({ start: 0, end: 1 })}>Full range</button></section>}
    <section className="chart-grid">{charts.filter((chart) => chart.visible).map((chart) => <AnalysisChartCard
      key={chart.id} config={chart} view={view} store={store} hoverBus={hoverBus} timeOrigin={timeOrigin} windowStart={windowStartMs} windowEnd={windowEndMs}
      lowRatio={lowRatio} highRatio={highRatio} onLowRatioChange={onLowRatioChange} onHighRatioChange={onHighRatioChange}
      analysisWindowMs={analysisWindowMs} scatterMax={scatterMax} efficiencyMax={efficiencyMax} powerDomain={powerDomain}
      sourceLabel={sourceLabel} onDragStart={() => setDragged(chart.id)} onDrop={() => reorder(chart.id)}
      onHide={() => setCharts((items) => items.map((item) => item.id === chart.id ? { ...item, visible: false } : item))}
    />)}</section>
  </>
}

export const AnalysisWorkspace = memo(AnalysisWorkspaceComponent)

function AnalysisChartCard({ config, view, store, hoverBus, timeOrigin, windowStart, windowEnd, lowRatio, highRatio, onLowRatioChange, onHighRatioChange, analysisWindowMs, scatterMax, efficiencyMax, powerDomain, sourceLabel, onDragStart, onDrop, onHide }: {
  config: ChartConfig
  view: ViewData
  store: AnalysisStore
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
  const plotGeometry = usePlotGeometry(chartBodyRef)
  const relationship = config.id === 'scatter' || config.id === 'shiftEfficiency'
  const visibleSpanMs = Math.max(0, windowEnd - windowStart)
  const visibleStartSeconds = (windowStart - timeOrigin) / 1000
  const visibleEndSeconds = (windowEnd - timeOrigin) / 1000
  const xDomain = useMemo<[number, number]>(() => visibleEndSeconds > visibleStartSeconds ? [visibleStartSeconds, visibleEndSeconds] : [visibleStartSeconds, visibleStartSeconds + 1], [visibleStartSeconds, visibleEndSeconds])

  const relationshipData: readonly RelationshipDatum[] = config.id === 'scatter' ? view.ratioDots
    : config.id === 'shiftEfficiency' ? view.efficiencyDots
    : EMPTY_RELATIONSHIP_DATA
  const timeData: readonly TimeChartDatum[] = config.id === 'rpm1' ? view.primaryRpm
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

  const relationshipX = useCallback((point: RelationshipDatum) => (
    config.id === 'scatter' ? (point as RatioPoint).rpm2 : (point as EfficiencyPoint).ratio
  ), [config.id])

  const relationshipY = useCallback((point: RelationshipDatum) => (
    config.id === 'scatter' ? (point as RatioPoint).rpm1 : (point as EfficiencyPoint).efficiencyPct
  ), [config.id])

  const relationshipReadout = useCallback((point: RelationshipDatum) => (
    config.id === 'scatter'
      ? `Sec ${formatNumber((point as RatioPoint).rpm2)} / Pri ${formatNumber((point as RatioPoint).rpm1)}`
      : `Ratio ${formatNumber((point as EfficiencyPoint).ratio, 2)} / Eff ${formatNumber((point as EfficiencyPoint).efficiencyPct, 2)}%`
  ), [config.id])

  const relationshipSnapForPoint = useCallback((point: RelationshipDatum): RelationshipSnap | undefined => {
    if (!plotGeometry) return undefined
    const projectedPoint = projectToPlot(relationshipX(point), relationshipY(point), relationshipDomains.x, relationshipDomains.y, plotGeometry)
    if (!projectedPoint) return undefined
    return {
      time: point.time,
      xPx: projectedPoint.xPx,
      yPx: projectedPoint.yPx,
      readout: relationshipReadout(point),
    }
  }, [plotGeometry, relationshipDomains, relationshipReadout, relationshipX, relationshipY])

  const nearestRelationship = useCallback((mouseX: number, mouseY: number): RelationshipSnap | undefined => {
    if (!relationship || !plotGeometry) return undefined
    const nearest = nearestProjectedPoint(
      relationshipData,
      mouseX,
      mouseY,
      relationshipDomains.x,
      relationshipDomains.y,
      plotGeometry,
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
  }, [plotGeometry, relationship, relationshipData, relationshipDomains, relationshipReadout, relationshipX, relationshipY])

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
    if (!vertical || !plotGeometry || hoverTime === null || windowEnd <= windowStart) { hideHover(); return }

    let relationshipSnap = relationship && hoverEvent.sourceChartId === config.id ? hoverEvent.relationshipSnap : undefined
    if (relationship && !relationshipSnap) {
      const point = findNearestTime(relationshipData, hoverTime)
      if (point) relationshipSnap = relationshipSnapForPoint(point)
    }

    if (!relationship) {
      const f = clamp01((hoverTime - windowStart) / (windowEnd - windowStart))
      vertical.style.display = 'block'
      vertical.style.height = `${plotGeometry.height}px`
      vertical.style.transform = `translate3d(${plotGeometry.left + f * plotGeometry.width}px,${plotGeometry.top}px,0)`
      if (horizontal) horizontal.style.display = 'none'
    } else {
      if (!relationshipSnap) { hideHover(); return }
      vertical.style.display = 'block'
      vertical.style.height = `${plotGeometry.height}px`
      vertical.style.transform = `translate3d(${relationshipSnap.xPx}px,${plotGeometry.top}px,0)`
      if (horizontal) {
        horizontal.style.display = 'block'
        horizontal.style.width = `${plotGeometry.width}px`
        horizontal.style.transform = `translate3d(${plotGeometry.left}px,${relationshipSnap.yPx}px,0)`
      }
    }

    if (!readout) return
    if (relationshipSnap) {
      readout.textContent = relationshipSnap.readout
      readout.style.display = ''
      return
    }

    // Hover interrogates the full-resolution derived store, never the decimated Canvas view.
    let text = ''
    if (config.id === 'rpm1') text = `${formatNumber(store.nearest('primaryRpm', hoverTime)?.rpm ?? Number.NaN)} RPM`
    else if (config.id === 'rpm2') text = `${formatNumber(store.nearest('secondaryRpm', hoverTime)?.rpm ?? Number.NaN)} RPM`
    else if (config.id === 'shift') text = `${formatNumber(store.nearest('shift', hoverTime)?.value ?? Number.NaN)}%`
    else if (config.id === 'shiftRatio') text = formatNumber(store.nearest('ratio', hoverTime)?.ratio ?? Number.NaN, 3)
    else if (config.id === 'efficiency') text = `${formatNumber(store.nearest('efficiency', hoverTime)?.efficiencyPct ?? Number.NaN)}%`
    else if (config.id === 'power') {
      const primary = store.nearest('primaryPower', hoverTime)?.powerKw ?? Number.NaN
      const secondary = store.nearest('secondaryPower', hoverTime)?.powerKw ?? Number.NaN
      text = `Pri ${formatNumber(primary)} kW / Sec ${formatNumber(secondary)} kW`
    }
    if (text) { readout.textContent = text; readout.style.display = '' }
    else readout.style.display = 'none'
  }, [config.id, hideHover, plotGeometry, relationship, relationshipData, relationshipSnapForPoint, store, windowEnd, windowStart])

  useEffect(() => hoverBus.subscribe(updateHover), [hoverBus, updateHover])

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    if (!plotGeometry || plotGeometry.width <= 0) return
    const bodyRect = event.currentTarget.getBoundingClientRect()
    const mouseX = event.clientX - bodyRect.left
    const mouseY = event.clientY - bodyRect.top
    if (!relationship) {
      const fx = clamp01((mouseX - plotGeometry.left) / plotGeometry.width)
      hoverBus.publish({ time: windowStart + fx * Math.max(0, windowEnd - windowStart), sourceChartId: config.id })
      return
    }
    const nearest = nearestRelationship(mouseX, mouseY)
    if (nearest) hoverBus.publish({ time: nearest.time, sourceChartId: config.id, relationshipSnap: nearest })
  }

  const headerControls = config.id === 'scatter' ? <div className="chart-ratio-inputs"><label className="ratio-input" style={{ color: '#d8a227' }}><span>Low ratio</span><input type="number" step="0.01" min="0" value={lowRatio} onChange={(event: ChangeEvent<HTMLInputElement>) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onLowRatioChange(value) }} /></label><label className="ratio-input" style={{ color: '#3c8f88' }}><span>High ratio</span><input type="number" step="0.01" min="0" value={highRatio} onChange={(event: ChangeEvent<HTMLInputElement>) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onHighRatioChange(value) }} /></label></div> : null

  return <article className="chart-card" onDragOver={(event: DragEvent<HTMLElement>) => event.preventDefault()} onDrop={onDrop}>
    <header className="chart-header"><div className="drag-handle" title="Drag to reorder" draggable onDragStart={onDragStart}><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div>{headerControls}<button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header>
    <div className="chart-body" ref={chartBodyRef} onMouseMove={handleMouseMove} onMouseLeave={() => hoverBus.publish({ time: null, sourceChartId: null })}>
      <AnalysisPlot config={config} timeData={timeData} relationshipData={relationshipData} primaryObs={plotPrimaryObs} secondaryObs={plotSecondaryObs} plotGeometry={plotGeometry} xDomain={xDomain} visibleSpanMs={visibleSpanMs} scatterMax={plotScatterMax} efficiencyMax={plotEfficiencyMax} powerDomain={plotPowerDomain} lowRatio={plotLowRatio} highRatio={plotHighRatio} />
      <div ref={crosshairRef} className="chart-crosshair-line" style={{ display: 'none' }} />
      {relationship && <div ref={crosshairHRef} className="chart-crosshair-line-h" style={{ display: 'none' }} />}
    </div>
    <div className="chart-footer"><span style={{ color: config.color }}>● {sourceLabel}</span><span ref={readoutRef} className="hover-readout" style={{ display: 'none' }} /><span>{config.id === 'power' ? `${analysisWindowMs} ms · kW / hp` : config.id === 'efficiency' || config.id === 'shiftEfficiency' ? `${analysisWindowMs} ms · %` : config.id === 'shiftRatio' ? 'Ratio' : `Visible: ${(visibleSpanMs / 1000).toFixed(1)} s`}</span></div>
  </article>
}

function maxFinite<T>(values: readonly T[], getValue: (point: T) => number, minimum = 0): number {
  let max = minimum
  for (const point of values) {
    const value = getValue(point)
    if (Number.isFinite(value)) max = Math.max(max, value)
  }
  return max
}

function timeSeriesYDomain(config: ChartConfig, timeData: readonly TimeChartDatum[], primaryObs: readonly WithSeconds<RpmPoint>[], secondaryObs: readonly WithSeconds<RpmPoint>[], efficiencyMax: number, powerDomain: [number, number]): [number, number] {
  if (config.id === 'rpm1' || config.id === 'rpm2') {
    const rpm = timeData as readonly WithSeconds<RpmPoint>[]
    const observations = config.id === 'rpm1' ? primaryObs : secondaryObs
    const maxRpm = Math.max(
      maxFinite(rpm, (point) => point.rpm, 100),
      maxFinite(observations, (point) => point.rpm, 100),
    )
    return [0, niceRpmCeiling(maxRpm)]
  }
  if (config.id === 'shift') {
    const shift = timeData as readonly WithSeconds<ShiftPoint>[]
    const upper = maxFinite(shift, (point) => point.value, 100)
    return [0, Math.max(100, niceStep(upper, 5) * Math.ceil(upper / niceStep(upper, 5)))]
  }
  if (config.id === 'power') return powerDomain
  if (config.id === 'efficiency') return [0, efficiencyMax]
  if (config.id === 'shiftRatio') return [0, 6]
  return [0, 1]
}

const AnalysisPlot = memo(function AnalysisPlot({ config, timeData, relationshipData, primaryObs, secondaryObs, plotGeometry, xDomain, visibleSpanMs, scatterMax, efficiencyMax, powerDomain, lowRatio, highRatio }: {
  config: ChartConfig
  timeData: readonly TimeChartDatum[]
  relationshipData: readonly RelationshipDatum[]
  primaryObs: readonly WithSeconds<RpmPoint>[]
  secondaryObs: readonly WithSeconds<RpmPoint>[]
  plotGeometry: PlotGeometry | null
  xDomain: [number, number]
  visibleSpanMs: number
  scatterMax: number
  efficiencyMax: number
  powerDomain: [number, number]
  lowRatio: number
  highRatio: number
}) {
  const rawYDomain = useMemo<[number, number]>(() => (
    config.id === 'scatter' ? [0, scatterMax]
      : config.id === 'shiftEfficiency' ? [0, efficiencyMax]
      : timeSeriesYDomain(config, timeData, primaryObs, secondaryObs, efficiencyMax, powerDomain)
  ), [config, efficiencyMax, powerDomain, primaryObs, scatterMax, secondaryObs, timeData])
  const yDomain = useStableDomain(rawYDomain)
  const rawCanvasXDomain: [number, number] = config.id === 'scatter' ? [0, scatterMax] : config.id === 'shiftEfficiency' ? [0.5, 6] : xDomain
  const canvasXDomain = useStableDomain(rawCanvasXDomain)

  return <>
    <AxisScaffold chartId={config.id} xDomain={xDomain} yDomain={yDomain} visibleSpanMs={visibleSpanMs} scatterMax={scatterMax} efficiencyMax={efficiencyMax} powerDomain={powerDomain} />
    <TelemetryCanvas chartId={config.id} color={config.color} plot={plotGeometry} xDomain={canvasXDomain} yDomain={yDomain} timeData={timeData} relationshipData={relationshipData} primaryObs={primaryObs} secondaryObs={secondaryObs} lowRatio={lowRatio} highRatio={highRatio} />
  </>
})

const AxisScaffold = memo(function AxisScaffold({ chartId, xDomain, yDomain, visibleSpanMs, scatterMax, efficiencyMax, powerDomain }: {
  chartId: ChartId
  xDomain: [number, number]
  yDomain: [number, number]
  visibleSpanMs: number
  scatterMax: number
  efficiencyMax: number
  powerDomain: [number, number]
}) {
  const xTick = useCallback((value: number) => `${formatTimeSeconds(value, visibleSpanMs)}s`, [visibleSpanMs])
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
  const powerPadDomain: [number, number] = powerDomain
  const timeAxis = (unit: string, domain: [number, number], ticks?: number[]) => <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={xDomain} allowDataOverflow tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={xTick} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={46} domain={domain} ticks={ticks} allowDataOverflow label={{ value: unit, angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const powerAxis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={xDomain} allowDataOverflow tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={xTick} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis yAxisId="kw" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => formatAxisTick(value, powerStep)} ticks={powerTicks} width={46} domain={powerPadDomain} allowDataOverflow label={{ value: 'kW', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /><YAxis yAxisId="hp" orientation="right" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => formatAxisTick(value, hpStep)} ticks={hpTicks} width={46} domain={[powerPadDomain[0] * KW_TO_HP, powerPadDomain[1] * KW_TO_HP]} allowDataOverflow label={{ value: 'hp', angle: 90, position: 'insideRight', style: axisLabelStyle }} /></>
  const axisData = useMemo(() => [
    { seconds: xDomain[0], rpm2: 0, rpm1: 0, ratio: 0.5, efficiencyPct: 0 },
    { seconds: xDomain[1], rpm2: scatterMax, rpm1: scatterMax, ratio: 6, efficiencyPct: efficiencyMax },
  ], [efficiencyMax, scatterMax, xDomain])

  return <div className="chart-axis-layer"><ResponsiveContainer width="100%" height="100%"><LineChart data={axisData} margin={{ top: 8, right: chartId === 'power' ? 4 : 14, left: 4, bottom: 14 }}>
    {chartId === 'power' ? powerAxis : chartId === 'scatter' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="rpm2" domain={[0, scatterMax]} ticks={scatterTicks} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => Math.round(value).toString()} label={{ value: 'Secondary RPM', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="rpm1" domain={[0, scatterMax]} ticks={scatterTicks} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => Math.round(value).toString()} width={50} label={{ value: 'Primary RPM', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : chartId === 'shiftEfficiency' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="ratio" domain={[0.5, 6]} ticks={ratioRelationshipTicks} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value: number) => Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} label={{ value: 'Speed ratio', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="efficiencyPct" domain={[0, efficiencyMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: '%', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : chartId === 'rpm1' || chartId === 'rpm2' ? timeAxis('RPM', yDomain) : chartId === 'shift' ? timeAxis('%', yDomain) : chartId === 'efficiency' ? timeAxis('%', yDomain) : timeAxis('Ratio', yDomain, ratioTicks)}
    {chartId === 'shiftEfficiency' && <><ReferenceLine x={1} stroke="#8b8982" strokeDasharray="3 4" strokeWidth={1} /><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /></>}
    {chartId === 'efficiency' && <ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} />}
    {chartId === 'shiftRatio' && <ReferenceLine y={1} stroke="#8b8982" strokeDasharray="3 4" strokeWidth={1} />}
  </LineChart></ResponsiveContainer></div>
})
