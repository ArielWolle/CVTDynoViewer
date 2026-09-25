import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
import { GripVertical, Pause, Play, RotateCcw, X } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { downsampleForChart } from '../downsample'
import { TimeRangeSlider } from '../TimeRangeSlider'
import { ANALYSIS_WINDOWS_MS, type AnalysisSnapshot, type EfficiencyPoint, type PowerPoint, type RatioPoint, type RpmObservationMode, type RpmPoint, type ShiftPoint } from './types'
import { findNearestTime, firstAnalysisTime, latestAnalysisTime } from './uiStore'

export type ChartId = 'scatter' | 'rpm1' | 'rpm2' | 'shift' | 'power' | 'efficiency' | 'shiftRatio' | 'shiftEfficiency'
export type ChartConfig = { id: ChartId; title: string; subtitle: string; color: string; visible: boolean }

export const defaultCharts: ChartConfig[] = [
  { id: 'scatter', title: 'Primary vs secondary RPM', subtitle: 'Speed relationship', color: '#f05d3b', visible: true },
  { id: 'shiftEfficiency', title: 'Ratio vs. efficiency', subtitle: 'Interval efficiency by speed ratio', color: '#2f6f9e', visible: true },
  { id: 'rpm1', title: 'Primary RPM', subtitle: 'Engine speed / time', color: '#d8a227', visible: true },
  { id: 'rpm2', title: 'Secondary RPM', subtitle: 'Output speed / time', color: '#3c8f88', visible: true },
  { id: 'shift', title: 'Shift position', subtitle: 'Actuator travel / time', color: '#b86b3a', visible: true },
  { id: 'power', title: 'Power', subtitle: 'Primary and secondary / same interval', color: '#f05d3b', visible: true },
  { id: 'efficiency', title: 'Efficiency', subtitle: 'Secondary / primary interval power', color: '#668b48', visible: true },
  { id: 'shiftRatio', title: 'Speed ratio', subtitle: 'Primary RPM / secondary RPM', color: '#7d5ba6', visible: true },
]

const MAX_CHART_POINTS = 1500
const DEFAULT_LIVE_WINDOW_MS = 10_000
const KW_TO_HP = 1.341022
const axisLabelStyle = { fill: '#8b8982', fontSize: 10 }
const lineProps = { isAnimationActive: false, animationDuration: 0, dot: false, activeDot: false, connectNulls: false }

function clamp01(value: number) { return Math.min(1, Math.max(0, value)) }
function formatNumber(value: number, digits = 2) { return Number.isFinite(value) ? value.toFixed(digits) : '—' }

type WithSeconds<T> = T & { seconds: number }

function windowed<T extends { time: number }>(values: readonly T[], start: number, end: number, origin: number): WithSeconds<T>[] {
  return downsampleForChart(
    values.filter((point) => point.time >= start && point.time <= end).map((point) => ({ ...point, seconds: (point.time - origin) / 1000 })),
    MAX_CHART_POINTS,
  )
}

function mergePower(primary: readonly PowerPoint[], secondary: readonly PowerPoint[], start: number, end: number, origin: number) {
  const rows = new Map<number, { time: number; seconds: number; power1?: number; power2?: number }>()
  for (const point of primary) {
    if (point.time < start || point.time > end) continue
    rows.set(point.time, { time: point.time, seconds: (point.time - origin) / 1000, power1: point.powerKw })
  }
  for (const point of secondary) {
    if (point.time < start || point.time > end) continue
    const row = rows.get(point.time) ?? { time: point.time, seconds: (point.time - origin) / 1000 }
    row.power2 = point.powerKw
    rows.set(point.time, row)
  }
  return downsampleForChart([...rows.values()].sort((a, b) => a.time - b.time), MAX_CHART_POINTS)
}

function median(values: number[]) {
  if (!values.length) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle])
}

export function AnalysisWorkspace({
  series, chartPlaying, frozenDomainEnd, onToggleChartPlaying, analysisWindowMs, onAnalysisWindowChange,
  observationMode, onObservationModeChange, charts, setCharts, lowRatio, highRatio, onLowRatioChange,
  onHighRatioChange, droppedPackets, lostEdges, sourceLabel,
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
}) {
  const [manualRange, setManualRange] = useState<{ start: number; end: number } | null>(null)
  const liveStart = firstAnalysisTime(series)
  const liveEnd = latestAnalysisTime(series)
  const domainEnd = chartPlaying || frozenDomainEnd === null ? liveEnd : Math.min(liveEnd, frozenDomainEnd)
  const domainStart = Math.min(liveStart, domainEnd)
  const domainSpan = Math.max(0, domainEnd - domainStart)
  const autoRangeStart = domainSpan <= DEFAULT_LIVE_WINDOW_MS ? 0 : 1 - DEFAULT_LIVE_WINDOW_MS / domainSpan
  const rangeStart = manualRange ? manualRange.start : autoRangeStart
  const rangeEnd = manualRange ? manualRange.end : 1
  const windowStartMs = domainStart + rangeStart * domainSpan
  const windowEndMs = domainStart + rangeEnd * domainSpan
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const hoverFrameRef = useRef<number | null>(null)
  const pendingHoverRef = useRef<number | null>(null)
  const hasPendingHoverRef = useRef(false)
  const [dragged, setDragged] = useState<ChartId | null>(null)

  useEffect(() => () => { if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current) }, [])
  const scheduleHover = useCallback((time: number | null) => {
    pendingHoverRef.current = time
    hasPendingHoverRef.current = true
    if (hoverFrameRef.current !== null) return
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null
      if (hasPendingHoverRef.current) { setHoverTime(pendingHoverRef.current); hasPendingHoverRef.current = false }
    })
  }, [])

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
        <label className="analysis-select"><span>Analysis interval</span><select value={analysisWindowMs} onChange={(event) => onAnalysisWindowChange(Number(event.target.value))}>{ANALYSIS_WINDOWS_MS.map((value) => <option value={value} key={value}>{value} ms</option>)}</select></label>
        <label className="analysis-select"><span>RPM observations</span><select value={observationMode} onChange={(event) => onObservationModeChange(event.target.value as RpmObservationMode)}><option value="revolution">1 revolution</option><option value="tooth">Per tooth</option></select></label>
        <button className="button button-quiet" onClick={() => setCharts(defaultCharts)}><RotateCcw size={15} />Reset layout</button>
      </div>
    </section>
    {domainSpan > 0 && <section className="chart-range-bar"><TimeRangeSlider startFraction={rangeStart} endFraction={rangeEnd} onChange={(next) => setManualRange(next)} formatValue={(fraction) => `${((fraction * domainSpan) / 1000).toFixed(1)}s`} /><button className="button button-quiet chart-range-reset" onClick={() => setManualRange({ start: 0, end: 1 })}>Full range</button></section>}
    <section className="chart-grid">{charts.filter((chart) => chart.visible).map((chart) => <AnalysisChartCard
      key={chart.id} config={chart} series={series} domainStart={domainStart} windowStart={windowStartMs} windowEnd={windowEndMs}
      hoverTime={hoverTime} onHover={scheduleHover} lowRatio={lowRatio} highRatio={highRatio}
      onLowRatioChange={onLowRatioChange} onHighRatioChange={onHighRatioChange} analysisWindowMs={analysisWindowMs}
      sourceLabel={sourceLabel} onDragStart={() => setDragged(chart.id)} onDrop={() => reorder(chart.id)}
      onHide={() => setCharts((items) => items.map((item) => item.id === chart.id ? { ...item, visible: false } : item))}
    />)}</section>
  </>
}

function AnalysisChartCard({ config, series, domainStart, windowStart, windowEnd, hoverTime, onHover, lowRatio, highRatio, onLowRatioChange, onHighRatioChange, analysisWindowMs, sourceLabel, onDragStart, onDrop, onHide }: {
  config: ChartConfig
  series: AnalysisSnapshot
  domainStart: number
  windowStart: number
  windowEnd: number
  hoverTime: number | null
  onHover: (time: number | null) => void
  lowRatio: number
  highRatio: number
  onLowRatioChange: (value: number) => void
  onHighRatioChange: (value: number) => void
  analysisWindowMs: number
  sourceLabel: string
  onDragStart: () => void
  onDrop: () => void
  onHide: () => void
}) {
  const primaryRpm = useMemo(() => windowed(series.primaryRpm, windowStart, windowEnd, domainStart), [series.primaryRpm, windowStart, windowEnd, domainStart])
  const secondaryRpm = useMemo(() => windowed(series.secondaryRpm, windowStart, windowEnd, domainStart), [series.secondaryRpm, windowStart, windowEnd, domainStart])
  const primaryObs = useMemo(() => windowed(series.primaryObservations, windowStart, windowEnd, domainStart), [series.primaryObservations, windowStart, windowEnd, domainStart])
  const secondaryObs = useMemo(() => windowed(series.secondaryObservations, windowStart, windowEnd, domainStart), [series.secondaryObservations, windowStart, windowEnd, domainStart])
  const shift = useMemo(() => windowed(series.shift, windowStart, windowEnd, domainStart), [series.shift, windowStart, windowEnd, domainStart])
  const ratio = useMemo(() => windowed(series.ratio, windowStart, windowEnd, domainStart), [series.ratio, windowStart, windowEnd, domainStart])
  const efficiency = useMemo(() => windowed(series.efficiency, windowStart, windowEnd, domainStart), [series.efficiency, windowStart, windowEnd, domainStart])
  const power = useMemo(() => mergePower(series.primaryPower, series.secondaryPower, windowStart, windowEnd, domainStart), [series.primaryPower, series.secondaryPower, windowStart, windowEnd, domainStart])

  const chartBodyRef = useRef<HTMLDivElement | null>(null)
  const crosshairRef = useRef<HTMLDivElement | null>(null)
  const crosshairHRef = useRef<HTMLDivElement | null>(null)
  const plotRectRef = useRef<DOMRect | null>(null)
  const bodyRectRef = useRef<DOMRect | null>(null)
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  const relationship = config.id === 'scatter' || config.id === 'shiftEfficiency'

  const timeData: readonly { time: number; seconds: number }[] = config.id === 'rpm1' ? primaryRpm
    : config.id === 'rpm2' ? secondaryRpm
    : config.id === 'shift' ? shift
    : config.id === 'power' ? power
    : config.id === 'efficiency' ? efficiency
    : config.id === 'shiftRatio' ? ratio
    : []
  const relationshipData: readonly { time: number }[] = config.id === 'scatter' ? ratio : config.id === 'shiftEfficiency' ? efficiency : []

  const finiteRpms = ratio.flatMap((point) => [point.rpm1, point.rpm2]).filter(Number.isFinite)
  const scatterMax = Math.max(10, ...finiteRpms) * 1.05
  const powerValues = power.flatMap((point) => [point.power1, point.power2]).filter((value): value is number => Number.isFinite(value))
  const powerMin = Math.min(0, ...powerValues)
  const powerMax = Math.max(1, ...powerValues)
  const powerPad = Math.max(0.25, 0.08 * (powerMax - powerMin || 1))
  const efficiencyMax = Math.max(110, Math.ceil((Math.max(0, ...efficiency.map((point) => point.efficiencyPct)) + 1) / 10) * 10)

  const lowRatioLine = [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * lowRatio }]
  const highRatioLine = [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * highRatio }]
  const efficiencyTrend = useMemo(() => {
    if (config.id !== 'shiftEfficiency') return []
    const values = efficiency.filter((point) => point.ratio >= 0.5 && point.ratio <= 6)
    const bins = 16
    const width = 5.5 / bins
    const result: { ratio: number; efficiencyPct: number }[] = []
    for (let bin = 0; bin < bins; bin += 1) {
      const low = 0.5 + bin * width
      const high = low + width
      const y = values.filter((point) => point.ratio >= low && point.ratio < high).map((point) => point.efficiencyPct)
      if (y.length >= 2) result.push({ ratio: 0.5 * (low + high), efficiencyPct: median(y) })
    }
    return result
  }, [config.id, efficiency])

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
      for (const point of ratio) {
        const dx = (point.rpm2 - targetX) / Math.max(scatterMax, 1)
        const dy = (point.rpm1 - targetY) / Math.max(scatterMax, 1)
        const distance = dx * dx + dy * dy
        if (distance < bestDistance) { best = point; bestDistance = distance }
      }
      return best
    }
    let best: WithSeconds<EfficiencyPoint> | undefined
    let bestDistance = Infinity
    for (const point of efficiency) {
      const dx = (point.ratio - targetX) / 5.5
      const dy = (point.efficiencyPct - targetY) / Math.max(efficiencyMax, 1)
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) { best = point; bestDistance = distance }
    }
    return best
  }, [config.id, ratio, efficiency, scatterMax, efficiencyMax])

  function handleMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = plotRectRef.current
    if (!rect || rect.width <= 0) return
    const fx = clamp01((event.clientX - rect.left) / rect.width)
    if (!relationship) {
      onHoverRef.current(windowStart + fx * Math.max(0, windowEnd - windowStart))
      return
    }
    if (rect.height <= 0) return
    const fy = clamp01((event.clientY - rect.top) / rect.height)
    const targetX = config.id === 'scatter' ? fx * scatterMax : 0.5 + fx * 5.5
    const targetY = (1 - fy) * (config.id === 'scatter' ? scatterMax : efficiencyMax)
    const nearest = nearestRelationship(targetX, targetY)
    if (nearest) onHoverRef.current(nearest.time)
  }

  const hoveredRatio = useMemo(() => hoverTime === null ? undefined : findNearestTime(ratio, hoverTime), [hoverTime, ratio])
  const hoveredEfficiency = useMemo(() => hoverTime === null ? undefined : findNearestTime(efficiency, hoverTime), [hoverTime, efficiency])

  useLayoutEffect(() => {
    const vertical = crosshairRef.current
    const horizontal = crosshairHRef.current
    const bodyRect = bodyRectRef.current
    const plotRect = plotRectRef.current
    const hide = () => { if (vertical) vertical.style.display = 'none'; if (horizontal) horizontal.style.display = 'none' }
    if (!vertical || !bodyRect || !plotRect || hoverTime === null || windowEnd <= windowStart) { hide(); return }
    if (!relationship) {
      const f = clamp01((hoverTime - windowStart) / (windowEnd - windowStart))
      vertical.style.display = 'block'
      vertical.style.left = `${plotRect.left - bodyRect.left + f * plotRect.width}px`
      if (horizontal) horizontal.style.display = 'none'
      return
    }
    if (plotRect.height <= 0) { hide(); return }
    const point = config.id === 'scatter' ? hoveredRatio : hoveredEfficiency
    if (!point) { hide(); return }
    let x = 0
    let y = 0
    if (config.id === 'scatter') {
      if (!('rpm1' in point) || !('rpm2' in point)) { hide(); return }
      x = point.rpm2 / scatterMax
      y = 1 - point.rpm1 / scatterMax
    } else {
      if (!('efficiencyPct' in point) || !('ratio' in point)) { hide(); return }
      x = (point.ratio - 0.5) / 5.5
      y = 1 - point.efficiencyPct / efficiencyMax
    }
    vertical.style.display = 'block'
    vertical.style.left = `${plotRect.left - bodyRect.left + clamp01(x) * plotRect.width}px`
    if (horizontal) { horizontal.style.display = 'block'; horizontal.style.top = `${plotRect.top - bodyRect.top + clamp01(y) * plotRect.height}px` }
  }, [hoverTime, hoveredRatio, hoveredEfficiency, relationship, config.id, windowStart, windowEnd, scatterMax, efficiencyMax])

  const timeAxis = (unit: string, domain?: [number, number]) => <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={46} domain={domain} allowDataOverflow={domain !== undefined} label={{ value: unit, angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const powerAxis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis yAxisId="kw" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={42} domain={[powerMin - powerPad, powerMax + powerPad]} label={{ value: 'kW', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /><YAxis yAxisId="hp" orientation="right" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={42} domain={[(powerMin - powerPad) * KW_TO_HP, (powerMax + powerPad) * KW_TO_HP]} label={{ value: 'hp', angle: 90, position: 'insideRight', style: axisLabelStyle }} /></>

  const chartData = relationship ? (config.id === 'scatter' ? ratio : efficiency) : timeData
  const chart = useMemo(() => <ResponsiveContainer width="100%" height="100%"><LineChart data={chartData as never[]} margin={{ top: 8, right: config.id === 'power' ? 4 : 14, left: 4, bottom: 14 }}>
    {config.id === 'power' ? powerAxis : config.id === 'scatter' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="rpm2" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Secondary RPM', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="rpm1" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: 'Primary RPM', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : config.id === 'shiftEfficiency' ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="ratio" domain={[0.5, 6]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Speed ratio', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="efficiencyPct" domain={[0, efficiencyMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: '%', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></> : config.id === 'rpm1' || config.id === 'rpm2' ? timeAxis('RPM') : config.id === 'shift' ? timeAxis('%') : config.id === 'efficiency' ? timeAxis('%', [0, efficiencyMax]) : timeAxis('Ratio', [0, 6])}
    {config.id === 'scatter' && <><Line data={lowRatioLine} type="linear" dataKey="rpm1" stroke="#d8a227" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line data={highRatioLine} type="linear" dataKey="rpm1" stroke="#3c8f88" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line type="linear" dataKey="rpm1" stroke="transparent" {...lineProps} dot={{ r: 2.2, fill: config.color, stroke: 'none' }} /></>}
    {config.id === 'shiftEfficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="linear" dataKey="efficiencyPct" stroke="transparent" {...lineProps} dot={{ r: 2.2, fill: config.color, fillOpacity: .55, stroke: 'none' }} /><Line data={efficiencyTrend} type="linear" dataKey="efficiencyPct" stroke={config.color} strokeWidth={2.3} {...lineProps} /></>}
    {config.id === 'rpm1' && <><Line data={primaryObs} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={{ r: 1.6, fill: config.color, fillOpacity: .28, stroke: 'none' }} /><Line type="linear" dataKey="rpm" stroke={config.color} strokeWidth={2} {...lineProps} /></>}
    {config.id === 'rpm2' && <><Line data={secondaryObs} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={{ r: 1.6, fill: config.color, fillOpacity: .28, stroke: 'none' }} /><Line type="linear" dataKey="rpm" stroke={config.color} strokeWidth={2} {...lineProps} /></>}
    {config.id === 'shift' && <Line type="linear" dataKey="value" stroke={config.color} strokeWidth={2} {...lineProps} />}
    {config.id === 'power' && <><Line type="linear" dataKey="power1" yAxisId="kw" stroke="#f05d3b" strokeWidth={2} {...lineProps} /><Line type="linear" dataKey="power2" yAxisId="kw" stroke="#3c8f88" strokeWidth={2} {...lineProps} /></>}
    {config.id === 'efficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="linear" dataKey="efficiencyPct" stroke={config.color} strokeWidth={2} {...lineProps} /></>}
    {config.id === 'shiftRatio' && <Line type="linear" dataKey="ratio" stroke={config.color} strokeWidth={2} {...lineProps} />}
  </LineChart></ResponsiveContainer>, [chartData, config, powerAxis, scatterMax, efficiencyMax, lowRatioLine, highRatioLine, efficiencyTrend, primaryObs, secondaryObs])

  const readout = (() => {
    if (hoverTime === null) return null
    if (config.id === 'rpm1') { const point = findNearestTime(primaryRpm, hoverTime); return point ? `${formatNumber(point.rpm)} RPM` : null }
    if (config.id === 'rpm2') { const point = findNearestTime(secondaryRpm, hoverTime); return point ? `${formatNumber(point.rpm)} RPM` : null }
    if (config.id === 'shift') { const point = findNearestTime(shift, hoverTime); return point ? `${formatNumber(point.value)}%` : null }
    if (config.id === 'shiftRatio') return hoveredRatio ? formatNumber(hoveredRatio.ratio, 3) : null
    if (config.id === 'scatter') return hoveredRatio ? `Sec ${formatNumber(hoveredRatio.rpm2)} / Pri ${formatNumber(hoveredRatio.rpm1)}` : null
    if (config.id === 'efficiency') return hoveredEfficiency ? `${formatNumber(hoveredEfficiency.efficiencyPct)}%` : null
    if (config.id === 'shiftEfficiency') return hoveredEfficiency ? `Ratio ${formatNumber(hoveredEfficiency.ratio, 2)} / Eff ${formatNumber(hoveredEfficiency.efficiencyPct, 2)}%` : null
    if (config.id === 'power') {
      const p1 = findNearestTime(series.primaryPower, hoverTime)?.powerKw
      const p2 = findNearestTime(series.secondaryPower, hoverTime)?.powerKw
      return `Pri ${formatNumber(p1 ?? Number.NaN)} kW / Sec ${formatNumber(p2 ?? Number.NaN)} kW`
    }
    return null
  })()

  const headerControls = config.id === 'scatter' ? <div className="chart-ratio-inputs"><label className="ratio-input" style={{ color: '#d8a227' }}><span>Low ratio</span><input type="number" step="0.01" min="0" value={lowRatio} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onLowRatioChange(value) }} /></label><label className="ratio-input" style={{ color: '#3c8f88' }}><span>High ratio</span><input type="number" step="0.01" min="0" value={highRatio} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value > 0) onHighRatioChange(value) }} /></label></div> : null

  return <article className="chart-card" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
    <header className="chart-header"><div className="drag-handle" title="Drag to reorder" draggable onDragStart={onDragStart}><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div>{headerControls}<button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header>
    <div className="chart-body" ref={chartBodyRef} onMouseMove={handleMouseMove} onMouseLeave={() => onHoverRef.current(null)}>{chart}<div ref={crosshairRef} className="chart-crosshair-line" style={{ display: 'none' }} />{relationship && <div ref={crosshairHRef} className="chart-crosshair-line-h" style={{ display: 'none' }} />}</div>
    <div className="chart-footer"><span style={{ color: config.color }}>● {sourceLabel}</span>{readout && <span className="hover-readout">{readout}</span>}<span>{config.id === 'power' ? `${analysisWindowMs} ms · kW / hp` : config.id === 'efficiency' || config.id === 'shiftEfficiency' ? `${analysisWindowMs} ms · %` : config.id === 'shiftRatio' ? 'Ratio' : `Visible: ${(Math.max(0, windowEnd - windowStart) / 1000).toFixed(1)} s`}</span></div>
  </article>
}
