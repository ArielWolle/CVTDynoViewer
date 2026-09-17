import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactElement, type SetStateAction } from 'react'
import { Activity, Cable, ChevronDown, CircleHelp, Download, Gauge, GripVertical, Pause, Play, Send, Settings2, SlidersHorizontal, Square, Terminal, Trash2, Upload, Usb, Wifi, X, RotateCcw } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { channelNames, csvHeader, defaultEngineTorqueCurve, deriveSample, encodeCommand, parseSamplesCsv, sampleToCsvRow, samplesToCsv, type ChannelId, type EngineTorquePoint, type PowerMode, type TelemetrySample } from './protocol'
import { SerialTransport } from './serialTransport'
import { TorqueCurveEditor } from './TorqueCurveEditor'
import { TimeRangeSlider } from './TimeRangeSlider'

type ChartId = 'scatter' | 'rpm1' | 'rpm2' | 'shift' | 'power' | 'efficiency' | 'shiftRatio' | 'shiftEfficiency'
type ChartConfig = { id: ChartId; title: string; subtitle: string; color: string; visible: boolean }
type MaField = 'rpm1' | 'rpm2' | 'power1' | 'power2' | 'efficiency' | 'shiftRatio'
type MaEnabled = Record<MaField, boolean>
const defaultMaEnabled: MaEnabled = { rpm1: true, rpm2: false, power1: false, power2: true, efficiency: false, shiftRatio: false }
const maFieldLabels: Record<MaField, string> = { rpm1: 'Primary RPM', rpm2: 'Secondary RPM', power1: 'Primary power', power2: 'Secondary power', efficiency: 'Efficiency', shiftRatio: 'Shift ratio' }
type ChartPoint = TelemetrySample & { seconds: number; shiftRatio: number } & Record<`${MaField}Avg`, number>
type RawValues = Pick<TelemetrySample, 'rpm1' | 'rpm2' | 'shift' | 'torq1' | 'torq2'>
type ConsoleType = 'RPM1' | 'RPM2' | 'SHIFT' | 'TORQ1' | 'TORQ2' | 'READ CONFIG' | 'RPM TEST' | 'RPM COUNT TEST' | 'TEXT' | 'TX'
type ConsoleMessage = { id: number; time: string; type: ConsoleType; data: string }
type ConsoleSort = 'time' | 'type' | 'data'

const defaultCharts: ChartConfig[] = [
  { id: 'scatter', title: 'Primary vs secondary RPM', subtitle: 'Load transfer relationship', color: '#f05d3b', visible: true },
  { id: 'rpm1', title: 'Primary RPM', subtitle: 'Engine speed / time', color: '#d8a227', visible: true },
  { id: 'rpm2', title: 'Secondary RPM', subtitle: 'Output speed / time', color: '#3c8f88', visible: true },
  { id: 'shift', title: 'Shift position', subtitle: 'Actuator travel / time', color: '#b86b3a', visible: true },
  { id: 'power', title: 'Power output', subtitle: 'Primary and secondary / time', color: '#f05d3b', visible: true },
  { id: 'efficiency', title: 'Efficiency', subtitle: 'Secondary power / primary power', color: '#668b48', visible: true },
  { id: 'shiftRatio', title: 'Shift ratio', subtitle: 'Primary RPM / secondary RPM', color: '#7d5ba6', visible: true },
  { id: 'shiftEfficiency', title: 'Ratio vs. efficiency', subtitle: 'Shift ratio / efficiency relationship', color: '#2f6f9e', visible: true },
]

const emptyRaw: RawValues = { rpm1: 0, rpm2: 0, shift: 0, torq1: 0, torq2: 0 }
const SENSOR_RETENTION_MS = 300_000
const MAX_CONSOLE_MESSAGES = 500
const KW_TO_HP = 1.341022


function retainRecentSamples(history: TelemetrySample[], next: TelemetrySample): TelemetrySample[] {
  const cutoff = next.time - SENSOR_RETENTION_MS
  return [...history.filter((sample) => sample.time >= cutoff), next]
}

function makeDemoSample(index: number, torqueScale: number, torqueOffset: number, powerMode: PowerMode = 'torque', previous?: TelemetrySample, inertiaKgM2 = 0.3134, torqueCurve: EngineTorquePoint[] = defaultEngineTorqueCurve as EngineTorquePoint[]): TelemetrySample {
  const phase = index / 10
  const values = { time: index * 100, rpm1: Math.round(3200 + Math.sin(phase) * 720 + index * 3), rpm2: Math.round(2200 + Math.sin(phase - 0.5) * 500 + index * 2), shift: Math.round(35 + Math.sin(phase * 0.45) * 20), torq1: Math.round(380 + Math.sin(phase * 0.8) * 90), torq2: Math.round(305 + Math.sin(phase * 0.8 - 0.3) * 76) }
  return deriveSample(values, torqueScale, torqueOffset, powerMode, previous, inertiaKgM2, torqueCurve)
}

function formatNumber(value: number, decimals = 0) { return value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) }

/** Binary search for the data point whose `seconds` is closest to `target` (data sorted ascending). */
function findNearestBySeconds(data: ChartPoint[], target: number): ChartPoint | undefined {
  if (!data.length) return undefined
  let low = 0
  let high = data.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (data[mid].seconds < target) low = mid + 1
    else high = mid
  }
  if (low > 0 && Math.abs(data[low - 1].seconds - target) <= Math.abs(data[low].seconds - target)) return data[low - 1]
  return data[low]
}

function App() {
  const [connected, setConnected] = useState(false)
  const [demoMode, setDemoMode] = useState(false)
  const [firmwareDemoMode, setFirmwareDemoMode] = useState(false)
  const [powerMode, setPowerMode] = useState<PowerMode>('inertia')
  const [inertiaKgM2, setInertiaKgM2] = useState(0.3134)
  const [torqueCurve, setTorqueCurve] = useState<EngineTorquePoint[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('cvt-dyno-torque-curve') ?? 'null')
      return Array.isArray(stored) && stored.length >= 2 ? [...stored].sort((a, b) => a.rpm - b.rpm) : [...defaultEngineTorqueCurve]
    } catch { return [...defaultEngineTorqueCurve] }
  })
  const [inertiaSettingsOpen, setInertiaSettingsOpen] = useState(false)
  const [rpmPinTest, setRpmPinTest] = useState(false)
  const [rpmInterruptTest, setRpmInterruptTest] = useState(false)
  const [rpmCountTest, setRpmCountTest] = useState(false)
  const [rpmPinStates, setRpmPinStates] = useState<[boolean | null, boolean | null]>([null, null])
  const [rpmCountStates, setRpmCountStates] = useState<[number | null, number | null]>([null, null])
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleLines, setConsoleLines] = useState<string[]>([])
  const [consoleMessages, setConsoleMessages] = useState<ConsoleMessage[]>([])
  const [showSensorConsole, setShowSensorConsole] = useState(true)
  const [autoScrollConsole, setAutoScrollConsole] = useState(true)
  const [customCommand, setCustomCommand] = useState('03 00 00 00')
  const [logging, setLogging] = useState(false)
  const [sessionName, setSessionName] = useState('baseline-pull')
  const [torqueScale, setTorqueScale] = useState(0.01)
  const [torqueOffset, setTorqueOffset] = useState(0)
  const [channels, setChannels] = useState([true, true, true, true, true])
  const [frequencies, setFrequencies] = useState([20, 20, 10, 50, 50])
  const [primarySpokes, setPrimarySpokes] = useState(16)
  const [secondarySpokes, setSecondarySpokes] = useState(12)
  const [playbackSamples, setPlaybackSamples] = useState<TelemetrySample[]>([])
  const [playbackFileName, setPlaybackFileName] = useState('')
  const [playbackElapsedMs, setPlaybackElapsedMs] = useState(0)
  const [playbackPlaying, setPlaybackPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [playbackRangeStart, setPlaybackRangeStart] = useState(0)
  const [playbackRangeEnd, setPlaybackRangeEnd] = useState(1)
  const [samples, setSamples] = useState<TelemetrySample[]>([])
  const [raw, setRaw] = useState<RawValues>(emptyRaw)
  const [chartPlaying, setChartPlaying] = useState(true)
  const [frozenDomainEnd, setFrozenDomainEnd] = useState<number | null>(null)
  const [rangeStart, setRangeStart] = useState(0)
  const [rangeEnd, setRangeEnd] = useState(1)
  const [maEnabled, setMaEnabled] = useState<MaEnabled>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('cvt-dyno-ma-enabled') ?? 'null')
      return stored && typeof stored === 'object' ? { ...defaultMaEnabled, ...stored } : defaultMaEnabled
    } catch { return defaultMaEnabled }
  })
  const [maWindow, setMaWindow] = useState(() => {
    const stored = Number(localStorage.getItem('cvt-dyno-ma-window'))
    return Number.isFinite(stored) && stored >= 2 ? stored : 5
  })
  const [charts, setCharts] = useState<ChartConfig[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('cvt-dyno-layout') ?? 'null') as ChartConfig[] | null
      if (!Array.isArray(stored)) return defaultCharts
      const storedIds = new Set(stored.map((chart) => chart.id))
      // Merge in any newly added chart types so returning users see them without losing their saved order/visibility.
      return [...stored, ...defaultCharts.filter((chart) => !storedIds.has(chart.id))]
    } catch { return defaultCharts }
  })

  // Reference lines on the primary-vs-secondary RPM chart: y = ratio * x through the origin,
  // marking a low/high acceptable ratio band for the user to compare live data against.
  const [lowRatio, setLowRatio] = useState(() => {
    const stored = Number(localStorage.getItem('cvt-dyno-low-ratio'))
    return Number.isFinite(stored) && stored > 0 ? stored : 2.5
  })
  const [highRatio, setHighRatio] = useState(() => {
    const stored = Number(localStorage.getItem('cvt-dyno-high-ratio'))
    return Number.isFinite(stored) && stored > 0 ? stored : 0.9
  })
  const [notice, setNotice] = useState('Demo telemetry is flowing')
  const [directoryName, setDirectoryName] = useState('Browser download')
  const transport = useRef<SerialTransport | null>(null)
  const directoryHandle = useRef<FileSystemDirectoryHandle | null>(null)
  const logWriter = useRef<FileSystemWritableFileStream | null>(null)
  const logCommitTimer = useRef<number | undefined>(undefined)
  const logCommitInProgress = useRef(false)
  const pendingLogRows = useRef('')
  const lastLoggedSampleTime = useRef<number | null>(null)
  const logFileName = useRef('')
  const consoleOutputRef = useRef<HTMLDivElement | null>(null)
  const consoleMessageId = useRef(0)
  const demoTimer = useRef<number | undefined>(undefined)
  const telemetryTimer = useRef<number | undefined>(undefined)
  const pendingRaw = useRef<RawValues>(emptyRaw)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const current = samples[samples.length - 1] ?? deriveSample({ time: 0, ...raw }, torqueScale, torqueOffset, powerMode, undefined, inertiaKgM2, torqueCurve)
  const isPlaybackActive = playbackSamples.length > 0
  // Recompute power/efficiency from the CSV's raw RPM/torque columns using the current power
  // mode, torque conversion, inertia value, and torque curve, so playback reflects live edits
  // to those settings instead of only replaying whatever was recorded at log time.
  const derivedPlaybackSamples = useMemo(() => {
    if (!playbackSamples.length) return []
    let previous: TelemetrySample | undefined
    return playbackSamples.map((sample) => {
      const derived = deriveSample(sample, torqueScale, torqueOffset, powerMode, previous, inertiaKgM2, torqueCurve)
      previous = derived
      return derived
    })
  }, [playbackSamples, torqueScale, torqueOffset, powerMode, inertiaKgM2, torqueCurve])
  const playbackDurationMs = playbackSamples.length ? playbackSamples[playbackSamples.length - 1].time - playbackSamples[0].time : 0
  const playbackStartBoundMs = playbackRangeStart * playbackDurationMs
  const playbackEndBoundMs = playbackRangeEnd * playbackDurationMs
  const displaySamples = useMemo(() => {
    if (chartPlaying || frozenDomainEnd === null) return samples
    return samples.filter((sample) => sample.time <= frozenDomainEnd)
  }, [samples, chartPlaying, frozenDomainEnd])
  const domainStart = displaySamples[0]?.time ?? 0
  const domainEnd = displaySamples[displaySamples.length - 1]?.time ?? domainStart
  const domainSpan = Math.max(0, domainEnd - domainStart)
  const windowStartMs = domainStart + rangeStart * domainSpan
  const windowEndMs = domainStart + rangeEnd * domainSpan
  const chartData = useMemo(() => {
    if (!displaySamples.length) return []
    const windowed = displaySamples.filter((sample) => sample.time >= windowStartMs && sample.time <= windowEndMs)
    if (!windowed.length) return []
    const windowSize = Math.max(1, Math.round(maWindow))

    // O(n) trailing moving average via a sliding-window sum.
    function trailingAverage(values: number[]): number[] {
      const result = new Array<number>(values.length)
      let sum = 0
      for (let index = 0; index < values.length; index += 1) {
        sum += values[index]
        if (index >= windowSize) sum -= values[index - windowSize]
        result[index] = sum / Math.min(windowSize, index + 1)
      }
      return result
    }

    // Moving averages propagate into calculated series: enabling primary RPM's average feeds the
    // smoothed RPM into the power and shift-ratio calculations, enabling power's average feeds the
    // smoothed power into efficiency, and so on -- matching how the raw values are actually derived.
    const rpm1Raw = windowed.map((sample) => sample.rpm1)
    const rpm2Raw = windowed.map((sample) => sample.rpm2)
    const rpm1AvgArr = trailingAverage(rpm1Raw)
    const rpm2AvgArr = trailingAverage(rpm2Raw)
    const rpm1Eff = maEnabled.rpm1 ? rpm1AvgArr : rpm1Raw
    const rpm2Eff = maEnabled.rpm2 ? rpm2AvgArr : rpm2Raw

    let previousCascaded: { time: number; rpm1: number; rpm2: number } | undefined
    const power1Cascaded: number[] = []
    const power2Cascaded: number[] = []
    windowed.forEach((sample, index) => {
      const derived = deriveSample(
        { time: sample.time, rpm1: rpm1Eff[index], rpm2: rpm2Eff[index], shift: sample.shift, torq1: sample.torq1, torq2: sample.torq2 },
        torqueScale, torqueOffset, powerMode, previousCascaded, inertiaKgM2, torqueCurve,
      )
      power1Cascaded.push(derived.power1)
      power2Cascaded.push(derived.power2)
      previousCascaded = { time: sample.time, rpm1: rpm1Eff[index], rpm2: rpm2Eff[index] }
    })
    const power1AvgArr = trailingAverage(power1Cascaded)
    const power2AvgArr = trailingAverage(power2Cascaded)
    const power1Eff = maEnabled.power1 ? power1AvgArr : windowed.map((sample) => sample.power1)
    const power2Eff = maEnabled.power2 ? power2AvgArr : windowed.map((sample) => sample.power2)

    const shiftRatioRaw = windowed.map((sample) => (sample.rpm2 !== 0 ? sample.rpm1 / sample.rpm2 : 0))
    const shiftRatioCascaded = windowed.map((_sample, index) => (rpm2Eff[index] !== 0 ? rpm1Eff[index] / rpm2Eff[index] : 0))
    const shiftRatioAvgArr = trailingAverage(shiftRatioCascaded)

    const efficiencyCascaded = windowed.map((_sample, index) => (power1Eff[index] > 0 ? Math.min(150, (power2Eff[index] / power1Eff[index]) * 100) : 0))
    const efficiencyAvgArr = trailingAverage(efficiencyCascaded)

    return windowed.map((sample, index) => ({
      ...sample,
      seconds: (sample.time - domainStart) / 1000,
      shiftRatio: shiftRatioRaw[index],
      rpm1Avg: rpm1AvgArr[index],
      rpm2Avg: rpm2AvgArr[index],
      power1Avg: power1AvgArr[index],
      power2Avg: power2AvgArr[index],
      efficiencyAvg: efficiencyAvgArr[index],
      shiftRatioAvg: shiftRatioAvgArr[index],
    }))
  }, [displaySamples, windowStartMs, windowEndMs, domainStart, maWindow, maEnabled, torqueScale, torqueOffset, powerMode, inertiaKgM2, torqueCurve])


  useEffect(() => { localStorage.setItem('cvt-dyno-layout', JSON.stringify(charts)) }, [charts])
  useEffect(() => { localStorage.setItem('cvt-dyno-torque-curve', JSON.stringify(torqueCurve)) }, [torqueCurve])
  useEffect(() => { localStorage.setItem('cvt-dyno-ma-enabled', JSON.stringify(maEnabled)) }, [maEnabled])
  useEffect(() => { localStorage.setItem('cvt-dyno-ma-window', String(maWindow)) }, [maWindow])
  useEffect(() => { localStorage.setItem('cvt-dyno-low-ratio', String(lowRatio)) }, [lowRatio])
  useEffect(() => { localStorage.setItem('cvt-dyno-high-ratio', String(highRatio)) }, [highRatio])
  useEffect(() => {
    if (!playbackPlaying || !playbackSamples.length) return
    const timer = window.setInterval(() => { setPlaybackElapsedMs((elapsed) => Math.min(playbackEndBoundMs, elapsed + 100 * playbackSpeed)) }, 100)
    return () => window.clearInterval(timer)
  }, [playbackPlaying, playbackSpeed, playbackSamples, playbackEndBoundMs])
  useEffect(() => {
    if (!derivedPlaybackSamples.length) return
    const start = derivedPlaybackSamples[0].time
    const cutoff = start + playbackElapsedMs
    let index = derivedPlaybackSamples.length - 1
    for (let sampleIndex = 0; sampleIndex < derivedPlaybackSamples.length; sampleIndex += 1) {
      if (derivedPlaybackSamples[sampleIndex].time > cutoff) { index = Math.max(0, sampleIndex - 1); break }
    }
    setSamples(derivedPlaybackSamples.slice(0, index + 1))
    if (playbackPlaying && playbackElapsedMs >= playbackEndBoundMs) setPlaybackPlaying(false)
  }, [derivedPlaybackSamples, playbackElapsedMs, playbackPlaying, playbackEndBoundMs])
  useEffect(() => {
    if (!logging || !logWriter.current) return
    const newSamples = samples.filter((sample) => lastLoggedSampleTime.current === null || sample.time > lastLoggedSampleTime.current)
    if (!newSamples.length) return
    const rows = newSamples.map((sample) => sampleToCsvRow(sample, torqueScale, torqueOffset)).join('\n') + '\n'
    lastLoggedSampleTime.current = newSamples[newSamples.length - 1].time
    pendingLogRows.current += rows
    if (logCommitTimer.current === undefined) logCommitTimer.current = window.setTimeout(() => { logCommitTimer.current = undefined; void commitLog(true) }, 500)
  }, [logging, samples])
  useEffect(() => {
    if (autoScrollConsole && consoleOutputRef.current) consoleOutputRef.current.scrollTop = 0
  }, [autoScrollConsole, consoleLines])
  useEffect(() => {
    if (!demoMode || connected || isPlaybackActive) return
    let index = 80
    demoTimer.current = window.setInterval(() => {
      setSamples((history) => {
        const previous = history[history.length - 1] ?? undefined
        const next = makeDemoSample(index++, torqueScale, torqueOffset, powerMode, previous, inertiaKgM2, torqueCurve)
        return retainRecentSamples(history, next)
      })
    }, 100)
    return () => window.clearInterval(demoTimer.current)
  }, [demoMode, connected, torqueScale, torqueOffset, powerMode, inertiaKgM2, torqueCurve, isPlaybackActive])
  useEffect(() => () => { window.clearTimeout(telemetryTimer.current); window.clearTimeout(logCommitTimer.current); void commitLog(false); void transport.current?.disconnect() }, [])

  async function connect() {
    try {
      const next = new SerialTransport({ onValue: handleValue, onPacket: handleSerialPacket, onText: handleSerialText })
      await next.connect(); transport.current = next; setConnected(true); setDemoMode(false); setFirmwareDemoMode(false); setSamples([]); setRaw(emptyRaw); pendingRaw.current = emptyRaw; setPlaybackSamples([]); setPlaybackPlaying(false); setPlaybackFileName(''); setPlaybackElapsedMs(0); setNotice('Reading dyno configuration...'); await next.send(encodeCommand(3))
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not connect to serial device') }
  }
  async function disconnect() { await transport.current?.disconnect(); transport.current = null; setConnected(false); setFirmwareDemoMode(false); setNotice('Device disconnected') }
  function consoleTimestamp() {
    const now = new Date()
    return `${now.toLocaleTimeString([], { hour12: false })}.${String(now.getMilliseconds()).padStart(3, '0')}`
  }
  function consoleTypeFor(data: string): ConsoleType {
    if (data.includes('[RAW SENSOR]')) {
      if (data.includes('Primary RPM')) return 'RPM1'
      if (data.includes('Secondary RPM')) return 'RPM2'
      if (data.includes('Shift position')) return 'SHIFT'
      if (data.includes('Primary torque')) return 'TORQ1'
      return 'TORQ2'
    }
    if (data.includes('RPM COUNT TEST')) return 'RPM COUNT TEST'
    if (data.includes('RPM TEST')) return 'RPM TEST'
    if (data.includes('Read configuration') || data.includes('CURRENT CONFIGURATION') || data.includes('Bench mode:') || data.includes('Channel [')) return 'READ CONFIG'
    if (data.startsWith('[TX]')) return 'TX'
    return 'TEXT'
  }
  function appendConsoleLines(linesToAdd: string[]) {
    const messages = linesToAdd.map((line) => { const time = consoleTimestamp(); return { id: consoleMessageId.current++, time, type: consoleTypeFor(line), data: line } })
    setConsoleMessages((messagesSoFar) => [...messagesSoFar, ...messages].slice(-MAX_CONSOLE_MESSAGES))
    setConsoleLines((lines) => [...lines, ...messages.map((message) => `${message.time} ${message.data}`)].slice(-MAX_CONSOLE_MESSAGES))
  }
  function handleSerialText(text: string) {
    appendConsoleLines([`[RAW TEXT] ${text}`])
    const rpmTestMatch = text.match(/^RPM TEST \| PIN_RPM1=(HIGH|LOW) edges=(\d+) \| PIN_RPM2=(HIGH|LOW) edges=(\d+)$/i)
    if (rpmTestMatch) {
      setRpmPinStates([rpmTestMatch[1].toUpperCase() === 'HIGH', rpmTestMatch[3].toUpperCase() === 'HIGH'])
      setNotice(`RPM pins: ${rpmTestMatch[1].toUpperCase()} / ${rpmTestMatch[3].toUpperCase()} | edges ${rpmTestMatch[2]} / ${rpmTestMatch[4]}`)
      return
    }
    const benchModeMatch = text.match(/^Bench mode:\s*(ENABLED|DISABLED)$/i)
    if (benchModeMatch) {
      const enabled = benchModeMatch[1].toUpperCase() === 'ENABLED'
      setFirmwareDemoMode(enabled)
      setNotice(`Dyno bench mode: ${enabled ? 'enabled' : 'disabled'}`)
      return
    }
    const rpmTestModeMatch = text.match(/^RPM pin test:\s*(ENABLED|DISABLED)$/i)
    if (rpmTestModeMatch) {
      const enabled = rpmTestModeMatch[1].toUpperCase() === 'ENABLED'
      setRpmPinTest(enabled)
      setNotice(`RPM pin test: ${enabled ? 'enabled' : 'disabled'}`)
      return
    }
    const rpmInterruptTestMatch = text.match(/^RPM interrupt test:\s*(ENABLED|DISABLED)$/i)
    if (rpmInterruptTestMatch) {
      const enabled = rpmInterruptTestMatch[1].toUpperCase() === 'ENABLED'
      setRpmInterruptTest(enabled)
      setNotice(`RPM interrupt test: ${enabled ? 'enabled' : 'disabled'}`)
      return
    }
    const rpmCountTestModeMatch = text.match(/^RPM count test:\s*(ENABLED|DISABLED)$/i)
    if (rpmCountTestModeMatch) {
      const enabled = rpmCountTestModeMatch[1].toUpperCase() === 'ENABLED'
      setRpmCountTest(enabled)
      setNotice(`RPM count test: ${enabled ? 'enabled' : 'disabled'}`)
      return
    }
    const spokesMatch = text.match(/^RPM Spokes - PRIMARY:\s*(\d+)\s*\|\s*SECONDARY:\s*(\d+)$/i)
    if (spokesMatch) {
      const primary = Number(spokesMatch[1])
      const secondary = Number(spokesMatch[2])
      setPrimarySpokes(primary)
      setSecondarySpokes(secondary)
      setNotice(`RPM spokes: Primary=${primary}, Secondary=${secondary}`)
      return
    }
    const rpmCountMatch = text.match(/^RPM COUNT TEST \| RPM1 count=(\d+) \| RPM2 count=(\d+)$/i)
    if (rpmCountMatch) {
      const rpm1Count = Number(rpmCountMatch[1])
      const rpm2Count = Number(rpmCountMatch[2])
      setRpmCountStates([rpm1Count, rpm2Count])
      setNotice(`RPM counts: RPM1=${rpm1Count}, RPM2=${rpm2Count}`)
      return
    }
    const configMatch = text.match(/^Channel \[(\d)\].*:\s(ENABLED|DISABLED)\s+\|\s+Target Tx Freq:\s+(\d+)\s+Hz$/i)
    if (configMatch) {
      const channel = Number(configMatch[1])
      const enabled = configMatch[2].toUpperCase() === 'ENABLED'
      const frequency = Number(configMatch[3])
      setChannels((values) => values.map((value, index) => index === channel ? enabled : value))
      setFrequencies((values) => values.map((value, index) => index === channel ? frequency : value))
      setNotice(`Dyno configuration received: ${channelNames[channel]}`)
      return
    }
    setNotice(text)
  }
  function handleSerialPacket(rawPacket: Uint8Array, channel: ChannelId, value: number) {
    appendConsoleLines([`[RAW SENSOR] ${bytesToHex(rawPacket)} | [DECODED] ${channelNames[channel]} = ${value}`])
  }
  function bytesToHex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ') }
  async function sendRawCommand(bytes: Uint8Array, description = 'Custom command') {
    if (!transport.current) { setNotice('Connect the firmware before sending commands'); return }
    await transport.current.send(bytes)
    appendConsoleLines([`[TX] ${bytesToHex(bytes)} ${description}`])
  }
  async function sendCustomCommand() {
    const tokens = customCommand.trim().split(/[\s,]+/).filter(Boolean)
    const values = tokens.map((token) => Number.parseInt(token.replace(/^0x/i, ''), 16))
    if (!tokens.length || values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) { setNotice('Enter hexadecimal bytes, for example: 03 00 00 00'); return }
    try { await sendRawCommand(new Uint8Array(values)); setNotice('Custom command sent') } catch { setNotice('Could not send custom command') }
  }
  async function toggleFirmwareDemo() {
    if (!transport.current) { setNotice('Connect the firmware before enabling bench mode'); return }
    const enabled = !firmwareDemoMode
    await transport.current.send(encodeCommand(4, 0, enabled ? 1 : 0))
    setFirmwareDemoMode(enabled)
    setNotice(enabled ? 'Firmware bench mode enabled' : 'Firmware sensors enabled')
  }
  async function toggleRpmPinTest() {
    if (!transport.current) { setNotice('Connect the firmware before starting the RPM pin test'); return }
    const enabled = !rpmPinTest
    try {
      await sendRawCommand(encodeCommand(5, 0, enabled ? 1 : 0), enabled ? 'Enable RPM pin test' : 'Disable RPM pin test')
      setRpmPinTest(enabled)
      setNotice(enabled ? 'RPM pin test enabled' : 'RPM pin test disabled')
    } catch { setNotice('Could not change RPM pin test mode') }
  }
  async function toggleRpmInterruptTest() {
    if (!transport.current) { setNotice('Connect the firmware before starting the RPM interrupt test'); return }
    const enabled = !rpmInterruptTest
    try {
      await sendRawCommand(encodeCommand(7, 0, enabled ? 1 : 0), enabled ? 'Enable RPM interrupt test' : 'Disable RPM interrupt test')
      setRpmInterruptTest(enabled)
      setNotice(enabled ? 'RPM interrupt test enabled' : 'RPM interrupt test disabled')
    } catch { setNotice('Could not change RPM interrupt test mode') }
  }
  async function toggleRpmCountTest() {
    if (!transport.current) { setNotice('Connect the firmware before starting the RPM count test'); return }
    const enabled = !rpmCountTest
    try {
      await sendRawCommand(encodeCommand(8, 0, enabled ? 1 : 0), enabled ? 'Enable RPM count test' : 'Disable RPM count test')
      setRpmCountTest(enabled)
      setNotice(enabled ? 'RPM count test enabled' : 'RPM count test disabled')
    } catch { setNotice('Could not change RPM count test mode') }
  }
  function handleValue(channel: ChannelId, value: number) {
    if (isPlaybackActive) return
    const key = (['rpm1', 'rpm2', 'shift', 'torq1', 'torq2'] as const)[channel]
    pendingRaw.current = { ...pendingRaw.current, [key]: value }
    if (telemetryTimer.current !== undefined) return
    telemetryTimer.current = window.setTimeout(() => {
      telemetryTimer.current = undefined
      const next = pendingRaw.current
      setSamples((history) => {
        const previous = history[history.length - 1] ?? undefined
        const sample = deriveSample({ time: performance.timeOrigin + performance.now(), ...next }, torqueScale, torqueOffset, powerMode, previous, inertiaKgM2, torqueCurve)
        return retainRecentSamples(history, sample)
      })
      setRaw(next)
    }, 50)
  }
  async function sendConfig(channel: number, enabled: boolean, frequency: number) { if (transport.current) { await transport.current.send(encodeCommand(1, channel, enabled ? 1 : 0)); await transport.current.send(encodeCommand(2, channel, frequency)) } }
  function updateChannel(channel: number, enabled: boolean) { setChannels((previous) => previous.map((value, index) => index === channel ? enabled : value)); void sendConfig(channel, enabled, frequencies[channel]).catch(() => setNotice('Could not send channel configuration')) }
  function updateFrequency(channel: number, frequency: number) { setFrequencies((previous) => previous.map((value, index) => index === channel ? frequency : value)); void sendConfig(channel, channels[channel], frequency).catch(() => setNotice('Could not send frequency configuration')) }
  function updateSpokes(channel: 0 | 1, spokes: number) {
    if (channel === 0) {
      setPrimarySpokes(spokes)
    } else {
      setSecondarySpokes(spokes)
    }
    void (async () => { if (transport.current) { await transport.current.send(encodeCommand(6, channel, spokes)) } })().catch(() => setNotice('Could not send spoke configuration'))
  }
  async function downloadCsv(sourceSamples: TelemetrySample[] = samples, baseName: string = sessionName || 'cvt-dyno-session') {
    const csv = samplesToCsv(sourceSamples, torqueScale, torqueOffset)
    if (directoryHandle.current) {
      const file = await directoryHandle.current.getFileHandle(`${baseName}.csv`, { create: true })
      const writable = await file.createWritable(); await writable.write(csv); await writable.close()
      setNotice(`Saved ${sourceSamples.length.toLocaleString()} samples to ${directoryHandle.current.name}`)
      return
    }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${baseName}.csv`; anchor.click(); URL.revokeObjectURL(url); setNotice(`Downloaded ${sourceSamples.length.toLocaleString()} samples`)
  }
  async function saveRecalculatedCsv() {
    if (!derivedPlaybackSamples.length) { setNotice('Load a CSV before saving recalculated values'); return }
    const baseName = `${(playbackFileName || 'cvt-dyno-session').replace(/\.csv$/i, '')}-recalculated`
    await downloadCsv(derivedPlaybackSamples, baseName)
  }
  async function chooseDirectory(): Promise<FileSystemDirectoryHandle | null> {
    if (!window.showDirectoryPicker) { setNotice('Chrome folder access is unavailable in this browser; CSV download remains available'); return null }
    try {
      directoryHandle.current = await window.showDirectoryPicker()
      setDirectoryName(directoryHandle.current.name)
      setNotice(`Folder access granted: ${directoryHandle.current.name}`)
      return directoryHandle.current
    } catch { setNotice('Folder selection cancelled'); return null }
  }
  async function nextLogFileName(directory: FileSystemDirectoryHandle): Promise<string> {
    const base = (sessionName.trim() || 'cvt-dyno-session').replace(/[<>:"/\\|?*]/g, '-')
    for (let index = 1; index < 10000; index += 1) {
      const name = index === 1 ? `${base}.csv` : `${base}-${index}.csv`
      try { await directory.getFileHandle(name); } catch { return name }
    }
    throw new Error('Could not find an available log filename')
  }
  async function openLogWriter(directory: FileSystemDirectoryHandle, name: string) {
    const file = await directory.getFileHandle(name, { create: true })
    const writer = await file.createWritable({ keepExistingData: true })
    await writer.seek((await file.getFile()).size)
    logWriter.current = writer
  }
  async function commitLog(reopen: boolean) {
    if (logCommitInProgress.current || !logWriter.current || !pendingLogRows.current) return
    logCommitInProgress.current = true
    const rows = pendingLogRows.current
    pendingLogRows.current = ''
    const writer = logWriter.current
    try {
      await writer.write(rows)
      await writer.close()
      logWriter.current = null
      if (reopen && directoryHandle.current) await openLogWriter(directoryHandle.current, logFileName.current)
    } catch { setNotice('Could not commit the log file') }
    finally {
      logCommitInProgress.current = false
      if (reopen && pendingLogRows.current && logCommitTimer.current === undefined) logCommitTimer.current = window.setTimeout(() => { logCommitTimer.current = undefined; void commitLog(true) }, 500)
    }
  }
  async function startLogging() {
    const directory = directoryHandle.current ?? await chooseDirectory()
    if (!directory) return
    try {
      const name = await nextLogFileName(directory)
      const file = await directory.getFileHandle(name, { create: true })
      const writer = await file.createWritable()
      await writer.write(`${csvHeader}\n`)
      await writer.close()
      logWriter.current = writer
      logFileName.current = name
      lastLoggedSampleTime.current = samples[samples.length - 1]?.time ?? null
      await openLogWriter(directory, name)
      setLogging(true)
      setNotice(`Writing ${name}`)
    } catch { setNotice('Could not open a log file in that folder') }
  }
  async function stopLogging() {
    setLogging(false)
    window.clearTimeout(logCommitTimer.current)
    logCommitTimer.current = undefined
    if (logWriter.current) {
      await commitLog(false)
      await logWriter.current?.close().catch(() => undefined)
      logWriter.current = null
      setNotice(`Closed ${logFileName.current}`)
    }
  }
  async function loadPlaybackFile(file: File) {
    try {
      const text = await file.text()
      const parsed = parseSamplesCsv(text, torqueScale, torqueOffset)
      if (!parsed.length) { setNotice('No samples found in that CSV file'); return }
      window.clearInterval(demoTimer.current)
      setDemoMode(false)
      setPlaybackSamples(parsed)
      setPlaybackFileName(file.name)
      setPlaybackElapsedMs(parsed[parsed.length - 1].time - parsed[0].time)
      setPlaybackPlaying(false)
      setPlaybackRangeStart(0)
      setPlaybackRangeEnd(1)
      setChartPlaying(true)
      setFrozenDomainEnd(null)
      setRangeStart(0)
      setRangeEnd(1)
      setNotice(`Loaded ${parsed.length.toLocaleString()} samples from ${file.name}`)
    } catch { setNotice('Could not read that CSV file') }
  }
  function togglePlaybackPlaying() {
    setPlaybackPlaying((playing) => {
      if (!playing) setPlaybackElapsedMs((elapsed) => (elapsed < playbackStartBoundMs || elapsed >= playbackEndBoundMs ? playbackStartBoundMs : elapsed))
      return !playing
    })
  }
  function handlePlaybackRangeChange(next: { start: number; end: number }) {
    const startMoved = next.start !== playbackRangeStart
    setPlaybackRangeStart(next.start)
    setPlaybackRangeEnd(next.end)
    if (!playbackDurationMs) return
    seekPlayback((startMoved ? next.start : next.end) * playbackDurationMs)
  }
  function stopPlayback() {
    setPlaybackPlaying(false)
    setPlaybackSamples([])
    setPlaybackFileName('')
    setPlaybackElapsedMs(0)
    setPlaybackRangeStart(0)
    setPlaybackRangeEnd(1)
    setSamples([])
    setNotice('Playback cleared; live and demo telemetry are available again')
  }
  function seekPlayback(ms: number) {
    if (!playbackSamples.length) return
    const start = playbackSamples[0].time
    const duration = playbackSamples[playbackSamples.length - 1].time - start
    setPlaybackElapsedMs(Math.min(duration, Math.max(0, ms)))
  }
  function toggleChartPlaying() {
    setChartPlaying((playing) => {
      setFrozenDomainEnd(playing ? (samples[samples.length - 1]?.time ?? null) : null)
      return !playing
    })
  }
  function toggleMa(field: MaField) { setMaEnabled((previous) => ({ ...previous, [field]: !previous[field] })) }
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Activity size={20} /></div><div><span className="eyebrow">CVT DYNAMOMETER</span><h1>Live instrument</h1></div></div><div className="topbar-status"><span className={`status-dot ${connected ? 'is-live' : 'is-demo'}`} />{connected ? firmwareDemoMode ? 'Firmware bench mode' : 'Serial link active' : demoMode ? 'Browser demo stream' : 'Offline'}<span className="status-divider" /><span className="mono">{formatNumber(current.rpm1)} RPM</span></div><div className="top-actions"><button className="button button-quiet" onClick={() => setDemoMode((value) => !value)} title="Toggle browser demo telemetry"><Gauge size={16} />{demoMode ? 'Browser demo' : 'Demo off'}</button>{connected && <button className={`button ${firmwareDemoMode ? 'button-accent' : 'button-quiet'}`} onClick={() => void toggleFirmwareDemo()} title="Toggle synthetic data on the connected firmware"><Gauge size={16} />{firmwareDemoMode ? 'Bench on' : 'Bench mode'}</button>}<button className={`button ${consoleOpen ? 'button-dark' : 'button-quiet'}`} onClick={() => setConsoleOpen((value) => !value)}><Terminal size={16} />Console<ChevronDown size={14} className={consoleOpen ? 'icon-rotate' : ''} /></button>{connected ? <button className="button button-dark" onClick={() => void disconnect()}><Usb size={16} />Disconnect</button> : <button className="button button-accent" onClick={() => void connect()}><Cable size={16} />Connect device</button>}</div></header>
    {consoleOpen && <SerialConsolePanel messages={consoleMessages} showSensorData={showSensorConsole} autoScroll={autoScrollConsole} customCommand={customCommand} setCustomCommand={setCustomCommand} onToggleSensorData={() => setShowSensorConsole((value) => !value)} onToggleAutoScroll={() => setAutoScrollConsole((value) => !value)} onClear={() => { setConsoleLines([]); setConsoleMessages([]) }} onSendCommand={sendRawCommand} onSendCustom={sendCustomCommand} rpmPinTest={rpmPinTest} rpmInterruptTest={rpmInterruptTest} rpmCountTest={rpmCountTest} rpmPinStates={rpmPinStates} rpmCountStates={rpmCountStates} onToggleRpmPinTest={toggleRpmPinTest} onToggleRpmInterruptTest={toggleRpmInterruptTest} onToggleRpmCountTest={toggleRpmCountTest} />}
    <section className="command-deck"><div className="deck-heading"><span className="section-kicker">01 / CONTROL ROOM</span><h2>Run configuration</h2><p>{notice}</p></div><div className="control-group"><label htmlFor="session">Session name</label><input id="session" value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></div>{powerMode === 'torque' && <><div className="control-group compact"><label htmlFor="scale">Torque scale</label><div className="input-with-unit"><input id="scale" type="number" step="0.001" value={torqueScale} onChange={(event) => setTorqueScale(Number(event.target.value))} /><span>N m/count</span></div></div><div className="control-group compact"><label htmlFor="offset">Torque zero</label><div className="input-with-unit"><input id="offset" type="number" value={torqueOffset} onChange={(event) => setTorqueOffset(Number(event.target.value))} /><span>count</span></div></div></>}{powerMode === 'inertia' && <div className="control-group compact"><label htmlFor="inertia-settings">Inertia settings</label><button id="inertia-settings" className={`button ${inertiaSettingsOpen ? 'button-dark' : 'button-quiet'}`} type="button" onClick={() => setInertiaSettingsOpen((value) => !value)}><Settings2 size={14} />{formatNumber(inertiaKgM2, 2)} kg·m²<ChevronDown size={14} className={inertiaSettingsOpen ? 'icon-rotate' : ''} /></button></div>}<div className="control-group compact"><label htmlFor="power-mode">Power mode</label><button id="power-mode" className="button button-quiet" type="button" onClick={() => setPowerMode((mode) => mode === 'torque' ? 'inertia' : 'torque')}>{powerMode === 'torque' ? 'Torque conversion' : 'Inertia mode'}</button></div>
        <div className="deck-actions"><button className={`button button-log ${logging ? 'is-recording' : ''}`} onClick={() => void (logging ? stopLogging() : startLogging())}>{logging ? <Square size={14} fill="currentColor" /> : <CircleHelp size={14} />}{logging ? `Logging ${logFileName.current}` : 'Start log'}</button><button className="button button-quiet" onClick={() => void chooseDirectory()} title="Grant Chrome permission to write logs directly">{directoryName === 'Browser download' ? 'Grant folder access' : directoryName}</button><button className="icon-button" title="Download CSV" onClick={() => void downloadCsv()}><Download size={17} /></button><button className="icon-button" title="Clear session" onClick={() => { setSamples([]); setNotice('Session buffer cleared') }}><Trash2 size={17} /></button></div></section>
    {powerMode === 'inertia' && inertiaSettingsOpen && <section className="inertia-settings"><div className="inertia-settings-header"><span className="section-kicker">INERTIA MODE SETTINGS</span><h3>Shaft inertia and engine curve</h3><button className="icon-button" title="Close" onClick={() => setInertiaSettingsOpen(false)}><X size={15} /></button></div><div className="inertia-settings-body"><div className="control-group compact inertia-input"><label htmlFor="inertia-value">Secondary inertia</label><div className="input-with-unit"><input id="inertia-value" type="number" step="0.01" min="0" value={inertiaKgM2} onChange={(event) => setInertiaKgM2(Number(event.target.value))} /><span>kg·m²</span></div></div><div className="torque-curve-wrap"><div className="torque-curve-heading"><span>Primary RPM vs. torque curve</span><button className="button button-quiet" onClick={() => setTorqueCurve([...defaultEngineTorqueCurve])}><RotateCcw size={13} />Reset curve</button></div><TorqueCurveEditor points={torqueCurve} onChange={setTorqueCurve} /></div></div></section>}
    <section className="channel-strip"><div className="strip-label"><SlidersHorizontal size={17} /><span>Telemetry channels</span></div>{channelNames.map((name, index) => <div className="channel-control" key={name}><button className={`channel-toggle ${channels[index] ? 'enabled' : ''}`} onClick={() => updateChannel(index, !channels[index])}>{channels[index] ? 'ON' : 'OFF'}</button><span>{name.replace('Primary ', 'PRI ').replace('Secondary ', 'SEC ')}</span><select value={frequencies[index]} onChange={(event) => updateFrequency(index, Number(event.target.value))}><option value="10">10 Hz</option><option value="20">20 Hz</option><option value="50">50 Hz</option></select></div>)}</section>
    <section className="channel-strip"><div className="strip-label"><Gauge size={17} /><span>RPM wheel teeth / spokes</span></div><div className="channel-control"><span>Primary wheel teeth</span><input type="number" min="1" max="999" value={primarySpokes} onChange={(event) => updateSpokes(0, Number(event.target.value))} /></div><div className="channel-control"><span>Secondary wheel teeth</span><input type="number" min="1" max="999" value={secondarySpokes} onChange={(event) => updateSpokes(1, Number(event.target.value))} /></div></section>
    <section className="playback-bar"><div className="strip-label"><Upload size={17} /><span>CSV playback</span></div><input ref={fileInputRef} type="file" accept=".csv,text/csv" className="visually-hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadPlaybackFile(file); event.target.value = '' }} /><button className="button button-quiet" onClick={() => fileInputRef.current?.click()}><Upload size={14} />Load CSV</button>{isPlaybackActive && <><span className="mono playback-filename">{playbackFileName}</span><button className="icon-button" title={playbackPlaying ? 'Pause playback' : 'Play playback'} onClick={togglePlaybackPlaying}>{playbackPlaying ? <Pause size={16} /> : <Play size={16} />}</button><TimeRangeSlider startFraction={playbackRangeStart} endFraction={playbackRangeEnd} onChange={handlePlaybackRangeChange} formatValue={(fraction) => `${((fraction * playbackDurationMs) / 1000).toFixed(1)}s`} /><span className="mono">{(playbackElapsedMs / 1000).toFixed(1)}s / {(playbackDurationMs / 1000).toFixed(1)}s</span><select value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select><button className="icon-button" title="Save recalculated CSV (current power settings applied to every row)" onClick={() => void saveRecalculatedCsv()}><Download size={16} /></button><button className="icon-button" title="Clear playback" onClick={stopPlayback}><Trash2 size={16} /></button></>}</section>
    <section className="metric-grid">{[['Primary RPM', current.rpm1, 'rpm'], ['Secondary RPM', current.rpm2, 'rpm'], ['Shift position', current.shift, '%'], ['Primary power', current.power1, 'kW'], ['Secondary power', current.power2, 'kW'], ['Efficiency', current.efficiency, '%']].map(([label, value, unit], index) => <article className="metric" key={label as string}><span className="metric-index">0{index + 1}</span><span className="metric-label">{label as string}</span><strong>{formatNumber(value as number, unit === 'kW' || unit === '%' ? 1 : 0)}</strong><span className="metric-unit">{unit as string}</span></article>)}</section>
    <ChartWorkspace
      sampleCount={samples.length}
      chartPlaying={chartPlaying}
      onToggleChartPlaying={toggleChartPlaying}
      maWindow={maWindow}
      onMaWindowChange={setMaWindow}
      charts={charts}
      setCharts={setCharts}
      domainSpan={domainSpan}
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      onRangeChange={(next) => { setRangeStart(next.start); setRangeEnd(next.end) }}
      onFullRange={() => { setRangeStart(0); setRangeEnd(1) }}
      chartData={chartData}
      windowStartMs={windowStartMs}
      windowEndMs={windowEndMs}
      maEnabled={maEnabled}
      onToggleMa={toggleMa}
      lowRatio={lowRatio}
      highRatio={highRatio}
      onLowRatioChange={setLowRatio}
      onHighRatioChange={setHighRatio}
    />
    <footer className="footer"><span><Wifi size={14} /> Browser serial requires Chromium</span><span className="mono">CVT / {sessionName || 'untitled'} / {new Date().toLocaleTimeString()}</span></footer>
  </main>
}

/**
 * Owns the chart grid's hover-sync state (and drag-to-reorder state) in its own subtree, isolated
 * from the rest of the app. Hovering a chart updates this state on essentially every animation
 * frame while the mouse moves; if that state lived in the top-level App component instead, every
 * hover would re-render the whole app (topbar, console, control deck, playback bar, etc.), not
 * just the charts, which is visibly laggy. Keeping it here means only this subtree re-renders.
 */
function ChartWorkspace({ sampleCount, chartPlaying, onToggleChartPlaying, maWindow, onMaWindowChange, charts, setCharts, domainSpan, rangeStart, rangeEnd, onRangeChange, onFullRange, chartData, windowStartMs, windowEndMs, maEnabled, onToggleMa, lowRatio, highRatio, onLowRatioChange, onHighRatioChange }: { sampleCount: number; chartPlaying: boolean; onToggleChartPlaying: () => void; maWindow: number; onMaWindowChange: (value: number) => void; charts: ChartConfig[]; setCharts: Dispatch<SetStateAction<ChartConfig[]>>; domainSpan: number; rangeStart: number; rangeEnd: number; onRangeChange: (next: { start: number; end: number }) => void; onFullRange: () => void; chartData: ChartPoint[]; windowStartMs: number; windowEndMs: number; maEnabled: MaEnabled; onToggleMa: (field: MaField) => void; lowRatio: number; highRatio: number; onLowRatioChange: (value: number) => void; onHighRatioChange: (value: number) => void }) {
  const [hoverTime, setHoverTime] = useState<number | null>(null)
  const hoverFrameRef = useRef<number | null>(null)
  const pendingHoverRef = useRef<number | null>(null)
  const hasPendingHoverRef = useRef(false)
  const [dragged, setDragged] = useState<ChartId | null>(null)

  useEffect(() => () => { if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current) }, [])

  // Chart hover fires on every raw mousemove event, which can be very frequent; committing
  // `hoverTime` directly would re-render all eight chart cards on every pixel of movement and
  // thrash badly enough to look broken. Coalesce updates to at most one per animation frame.
  // Stable identity (useCallback, refs only, no deps) so downstream dot renderers don't get
  // recreated -- and their underlying SVG elements torn down and rebuilt -- on every hover tick.
  const scheduleHover = useCallback((time: number | null) => {
    pendingHoverRef.current = time
    hasPendingHoverRef.current = true
    if (hoverFrameRef.current !== null) return
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null
      if (hasPendingHoverRef.current) { setHoverTime(pendingHoverRef.current); hasPendingHoverRef.current = false }
    })
  }, [])
  function reorder(target: ChartId) { if (!dragged || dragged === target) return; const from = charts.findIndex((chart) => chart.id === dragged); const to = charts.findIndex((chart) => chart.id === target); const next = [...charts]; const [item] = next.splice(from, 1); next.splice(to, 0, item); setCharts(next); setDragged(null) }
  // Looked up once here (not once per chart card) since every card shares the same `chartData`
  // array and the same `hoverTime` -- an O(n) search per card, times eight cards, on every hover
  // tick adds up on longer sessions.
  const hoveredPoint = useMemo(() => (hoverTime !== null ? chartData.find((point) => point.time === hoverTime) : undefined), [chartData, hoverTime])

  return <>
    <section className="workspace-heading"><div><span className="section-kicker">02 / LIVE TELEMETRY</span><h2>Analysis workspace</h2></div><div className="workspace-tools"><span><span className="status-dot is-live" />{sampleCount.toLocaleString()} samples buffered</span><button className={`button ${chartPlaying ? 'button-quiet' : 'button-accent'}`} onClick={onToggleChartPlaying} title={chartPlaying ? 'Pause chart updates' : 'Resume chart updates'}>{chartPlaying ? <Pause size={15} /> : <Play size={15} />}{chartPlaying ? 'Pause' : 'Paused'}</button><label className="ma-window-label" title="Number of samples averaged for each moving-average trace"><span>MA points</span><input type="number" min="2" max="500" value={maWindow} onChange={(event) => { const next = Number(event.target.value); onMaWindowChange(Number.isFinite(next) && next >= 2 ? Math.round(next) : 2) }} /></label><button className="button button-quiet" onClick={() => setCharts(defaultCharts)}><RotateCcw size={15} />Reset layout</button></div></section>
    {domainSpan > 0 && <section className="chart-range-bar"><TimeRangeSlider startFraction={rangeStart} endFraction={rangeEnd} onChange={onRangeChange} formatValue={(fraction) => `${((fraction * domainSpan) / 1000).toFixed(1)}s`} /><button className="button button-quiet chart-range-reset" onClick={onFullRange}>Full range</button></section>}
    <section className="chart-grid">{charts.filter((chart) => chart.visible).map((chart) => <ChartCard key={chart.id} config={chart} data={chartData} windowSeconds={(windowEndMs - windowStartMs) / 1000} maEnabled={maEnabled} onToggleMa={onToggleMa} hoveredPoint={hoveredPoint} onHover={scheduleHover} lowRatio={lowRatio} highRatio={highRatio} onLowRatioChange={onLowRatioChange} onHighRatioChange={onHighRatioChange} onDragStart={() => setDragged(chart.id)} onDrop={() => reorder(chart.id)} onHide={() => setCharts((items) => items.map((item) => item.id === chart.id ? { ...item, visible: false } : item))} />)}</section>
  </>
}

function ChartCard({ config, data, windowSeconds, maEnabled, onToggleMa, hoveredPoint, onHover, lowRatio, highRatio, onLowRatioChange, onHighRatioChange, onDragStart, onDrop, onHide }: { config: ChartConfig; data: ChartPoint[]; windowSeconds: number; maEnabled: MaEnabled; onToggleMa: (field: MaField) => void; hoveredPoint: ChartPoint | undefined; onHover: (time: number | null) => void; lowRatio: number; highRatio: number; onLowRatioChange: (value: number) => void; onHighRatioChange: (value: number) => void; onDragStart: () => void; onDrop: () => void; onHide: () => void }) {
  const yUnit = config.id === 'rpm1' || config.id === 'rpm2' ? 'RPM' : config.id === 'shift' || config.id === 'efficiency' ? '%' : config.id === 'shiftRatio' ? 'Ratio' : ''
  const axisLabelStyle = { fill: '#8b8982', fontSize: 10 }
  const common = { data, margin: { top: 8, right: config.id === 'power' ? 4 : 14, left: 4, bottom: 14 } }
  const yDomain = config.id === 'shiftRatio' ? [0, 5] : undefined
  // `onHover` can change identity across renders. A ref lets the dot renderer always call the
  // *latest* callback without itself needing to be recreated -- recreating it would make Recharts
  // tear down and rebuild the dot's SVG element on every hover tick, which can drop the mouse
  // mid-hover.
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  const dotRendererCache = useRef(new Map<string, (props: { cx?: number; cy?: number; payload?: ChartPoint }) => ReactElement>())
  const hoverCursorProps = { stroke: '#67655e', strokeDasharray: '4 4', strokeWidth: 1 }
  const isRelationshipChart = config.id === 'scatter' || config.id === 'shiftEfficiency'
  // Time-series hover bypasses Recharts' own mouse tracking entirely: attaching Recharts'
  // onMouseMove and rendering its <ReferenceLine> for the crosshair meant every one of the eight
  // charts fully re-rendered its SVG tree on every hover tick, which is what made hovering feel
  // slow and, under fast mouse movement, made the crosshair visibly lag behind the cursor. Instead
  // the nearest point is found with plain DOM math, and the crosshair is a plain CSS-positioned
  // line, not an SVG element inside the chart, so moving it never touches Recharts at all.
  //
  // The plot area's exact pixel bounds (margins, reserved axis width, the extra Y axis on the
  // power chart, etc.) are read directly from Recharts' own rendered grid background rect
  // (`.recharts-cartesian-grid-bg`, enabled by passing CartesianGrid a `fill`) instead of being
  // separately guessed here as hardcoded margin constants -- guessing them by hand was fragile
  // and got out of sync with Recharts' actual layout more than once. Reading the real geometry
  // is simpler and correct for any chart's margin configuration automatically.
  const chartBodyRef = useRef<HTMLDivElement | null>(null)
  const crosshairRef = useRef<HTMLDivElement | null>(null)
  function getPlotRect(chartBody: HTMLDivElement): DOMRect | null {
    return chartBody.querySelector('.recharts-cartesian-grid-bg')?.getBoundingClientRect() ?? null
  }
  function handlePlotMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    if (isRelationshipChart || !data.length) return
    const plotRect = getPlotRect(event.currentTarget)
    if (!plotRect || plotRect.width <= 0) return
    const fraction = Math.min(1, Math.max(0, (event.clientX - plotRect.left) / plotRect.width))
    const domainStart = data[0].seconds
    const domainEnd = data[data.length - 1].seconds
    const nearest = findNearestBySeconds(data, domainStart + fraction * (domainEnd - domainStart))
    if (nearest) onHoverRef.current(nearest.time)
  }
  function handlePlotMouseLeave() { onHoverRef.current(null) }
  // Positions the crosshair imperatively (a direct style mutation, not React state) so showing it
  // on the other seven charts when hovering one of them doesn't require yet another re-render.
  useLayoutEffect(() => {
    const crosshair = crosshairRef.current
    const chartBody = chartBodyRef.current
    if (!crosshair || !chartBody) return
    if (isRelationshipChart || !hoveredPoint || data.length < 2) { crosshair.style.display = 'none'; return }
    const plotRect = getPlotRect(chartBody)
    if (!plotRect || plotRect.width <= 0) { crosshair.style.display = 'none'; return }
    const domainStart = data[0].seconds
    const domainEnd = data[data.length - 1].seconds
    const fraction = domainEnd > domainStart ? (hoveredPoint.seconds - domainStart) / (domainEnd - domainStart) : 0
    const bodyRect = chartBody.getBoundingClientRect()
    crosshair.style.display = 'block'
    crosshair.style.left = `${plotRect.left - bodyRect.left + Math.min(1, Math.max(0, fraction)) * plotRect.width}px`
  }, [hoveredPoint, data, isRelationshipChart])
  function renderHoverDot(color: string) {
    const cached = dotRendererCache.current.get(color)
    if (cached) return cached
    const renderer = (dotProps: { cx?: number; cy?: number; payload?: ChartPoint }) => {
      const { cx, cy, payload } = dotProps
      if (typeof cx !== 'number' || typeof cy !== 'number' || !payload) return <g key={payload?.time ?? Math.random()} />
      return <circle key={payload.time} cx={cx} cy={cy} r={3.5} fill={color} stroke="#fffdf8" strokeWidth={1} style={{ cursor: 'pointer' }} onMouseEnter={() => onHoverRef.current(payload.time)} onMouseLeave={() => onHoverRef.current(null)} />
    }
    dotRendererCache.current.set(color, renderer)
    return renderer
  }
  const axis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis dataKey="seconds" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={46} domain={yDomain} allowDataOverflow={yDomain !== undefined} label={{ value: yUnit, angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const powerMaxKw = Math.max(1, ...data.map((sample) => sample.power1), ...data.map((sample) => sample.power2)) * 1.1
  const powerAxis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis dataKey="seconds" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis yAxisId="kw" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={40} domain={[0, powerMaxKw]} label={{ value: 'kW', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /><YAxis yAxisId="hp" orientation="right" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={40} domain={[0, powerMaxKw * KW_TO_HP]} label={{ value: 'hp', angle: 90, position: 'insideRight', style: axisLabelStyle }} /></>
  const lineProps = { isAnimationActive: false, animationDuration: 0, dot: false, activeDot: false, connectNulls: false }
  // Moving averages propagate downstream (RPM -> power -> efficiency, RPM -> shift ratio). When an
  // upstream field is being averaged, a chart's own raw trace is redundant -- only the resulting
  // (already-cascaded) value is shown, as a single solid line. The "double" raw+average display is
  // reserved for the chart where the averaging actually originates (its own checkbox is checked and
  // nothing upstream of it is already averaged).
  const power1Upstream = maEnabled.rpm1
  const power2Upstream = maEnabled.rpm2
  const shiftRatioUpstream = maEnabled.rpm1 || maEnabled.rpm2
  const efficiencyUpstream = maEnabled.power1 || maEnabled.power2 || maEnabled.rpm1 || maEnabled.rpm2
  const shiftRatioUsesAvg = shiftRatioUpstream || maEnabled.shiftRatio
  const efficiencyUsesAvg = efficiencyUpstream || maEnabled.efficiency
  const rawLineProps = { ...lineProps, strokeWidth: 2, strokeDasharray: '2 3', strokeLinecap: 'round' as const, strokeOpacity: 0.65 }
  const avgLineProps = { ...lineProps, strokeWidth: 2 }
  function seriesLines(field: MaField, dataKey: string, avgDataKey: string, color: string, upstreamAveraged: boolean, extra: Record<string, unknown> = {}) {
    const label = maFieldLabels[field]
    if (upstreamAveraged) return <Line type="monotone" dataKey={avgDataKey} name={label} stroke={color} {...avgLineProps} {...extra} />
    if (maEnabled[field]) return <><Line type="monotone" dataKey={dataKey} name={label} stroke={color} {...rawLineProps} {...extra} /><Line type="monotone" dataKey={avgDataKey} name={`${label} (avg)`} stroke={color} {...avgLineProps} {...extra} /></>
    return <Line type="monotone" dataKey={dataKey} name={label} stroke={color} {...avgLineProps} {...extra} />
  }
  const relationshipX = config.id === 'scatter' ? hoveredPoint?.rpm2 : hoveredPoint?.[shiftRatioUsesAvg ? 'shiftRatioAvg' : 'shiftRatio']
  const relationshipY = config.id === 'scatter' ? hoveredPoint?.rpm1 : hoveredPoint?.[efficiencyUsesAvg ? 'efficiencyAvg' : 'efficiency']
  const relationshipCrosshair = <>{typeof relationshipX === 'number' && <ReferenceLine x={relationshipX} {...hoverCursorProps} />}{typeof relationshipY === 'number' && <ReferenceLine y={relationshipY} {...hoverCursorProps} />}</>
  // A plain, static text readout instead of a Recharts <Tooltip> floating box. Every chart shares
  // the same `hoveredPoint`, so this shows every chart's relevant value(s) at once when hovering
  // any one of them -- and it's just a text node update, not a mouse-following popup recomputed
  // on eight separate chart instances, which is what made hovering feel slow.
  function formatField(raw: number, avg: number, upstream: boolean, own: boolean) {
    if (upstream) return `${avg.toFixed(2)} (avg)`
    if (own) return `${raw.toFixed(2)} (avg ${avg.toFixed(2)})`
    return raw.toFixed(2)
  }
  const readout = (() => {
    if (!hoveredPoint) return null
    switch (config.id) {
      case 'rpm1': return `${formatField(hoveredPoint.rpm1, hoveredPoint.rpm1Avg, false, maEnabled.rpm1)} RPM`
      case 'rpm2': return `${formatField(hoveredPoint.rpm2, hoveredPoint.rpm2Avg, false, maEnabled.rpm2)} RPM`
      case 'shift': return `${hoveredPoint.shift.toFixed(2)}%`
      case 'power': return `Pri ${formatField(hoveredPoint.power1, hoveredPoint.power1Avg, power1Upstream, maEnabled.power1)} kW / Sec ${formatField(hoveredPoint.power2, hoveredPoint.power2Avg, power2Upstream, maEnabled.power2)} kW`
      case 'efficiency': return `${formatField(hoveredPoint.efficiency, hoveredPoint.efficiencyAvg, efficiencyUpstream, maEnabled.efficiency)}%`
      case 'shiftRatio': return formatField(hoveredPoint.shiftRatio, hoveredPoint.shiftRatioAvg, shiftRatioUpstream, maEnabled.shiftRatio)
      case 'scatter': return `Sec ${hoveredPoint.rpm2.toFixed(2)} / Pri ${hoveredPoint.rpm1.toFixed(2)}`
      case 'shiftEfficiency': return `Ratio ${(shiftRatioUsesAvg ? hoveredPoint.shiftRatioAvg : hoveredPoint.shiftRatio).toFixed(2)} / Eff ${(efficiencyUsesAvg ? hoveredPoint.efficiencyAvg : hoveredPoint.efficiency).toFixed(2)}%`
      default: return null
    }
  })()
  // Reference lines y = ratio * x through the origin, marking a low/high acceptable shift-ratio
  // band. Rendered as their own two-point Line series (with an explicit `data` override) so they
  // draw independent of the live telemetry data, spanning the same square domain as the RPM axes.
  const scatterMax = Math.max(10, ...data.map((point) => point.rpm1), ...data.map((point) => point.rpm2)) * 1.05
  // Point keys must match the shared axes' dataKeys ("rpm2"/"rpm1") -- Recharts resolves a
  // Line's X position via the chart's XAxis dataKey even when the Line supplies its own `data`.
  const lowRatioLine = [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * lowRatio }]
  const highRatioLine = [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * highRatio }]
  const relationshipAxis = config.id === 'scatter'
    ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="rpm2" name="Secondary" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Secondary RPM', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="rpm1" name="Primary" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: 'Primary RPM', angle: -90, position: 'insideLeft', style: axisLabelStyle }} />{relationshipCrosshair}</>
    : <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey={shiftRatioUsesAvg ? 'shiftRatioAvg' : 'shiftRatio'} name="Shift ratio" domain={[0.5, 5]} reversed allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Shift ratio', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey={efficiencyUsesAvg ? 'efficiencyAvg' : 'efficiency'} name="Efficiency" domain={[0, 125]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: '%', angle: -90, position: 'insideLeft', style: axisLabelStyle }} />{relationshipCrosshair}</>
  // Memoized so time-series charts (which no longer depend on hoveredPoint at all -- their
  // crosshair is the plain CSS overlay above, not an SVG element in here) skip Recharts'
  // reconciliation entirely while only the hover position changes. The two relationship charts
  // still depend on relationshipX/relationshipY (their crosshair is a real <ReferenceLine>, kept
  // for pixel-perfect placement on their non-time axes), so only those two still recompute here.
  const chart = useMemo(() => <ResponsiveContainer width="100%" height="100%"><LineChart {...common} onMouseLeave={isRelationshipChart ? () => onHoverRef.current(null) : undefined}>{config.id === 'power' ? powerAxis : isRelationshipChart ? relationshipAxis : axis}{config.id === 'scatter' && <><Line data={lowRatioLine} name="Low ratio" type="linear" dataKey="rpm1" stroke="#d8a227" strokeWidth={2} strokeDasharray="1 5" strokeLinecap="round" isAnimationActive={false} dot={false} activeDot={false} legendType="none" tooltipType="none" /><Line data={highRatioLine} name="High ratio" type="linear" dataKey="rpm1" stroke="#3c8f88" strokeWidth={2} strokeDasharray="1 5" strokeLinecap="round" isAnimationActive={false} dot={false} activeDot={false} legendType="none" tooltipType="none" /><Line type="monotone" dataKey="rpm1" name="Primary RPM" stroke={config.color} strokeWidth={2} {...lineProps} dot={renderHoverDot(config.color)} /></>}{config.id === 'shiftEfficiency' && <Line type="monotone" dataKey={efficiencyUsesAvg ? 'efficiencyAvg' : 'efficiency'} name="Efficiency" stroke={config.color} strokeWidth={2} {...lineProps} dot={renderHoverDot(config.color)} />}{config.id === 'rpm1' && seriesLines('rpm1', 'rpm1', 'rpm1Avg', config.color, false)}{config.id === 'rpm2' && seriesLines('rpm2', 'rpm2', 'rpm2Avg', config.color, false)}{config.id === 'shift' && <Line type="monotone" dataKey="shift" name="Shift position" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'power' && <>{seriesLines('power1', 'power1', 'power1Avg', '#f05d3b', power1Upstream, { yAxisId: 'kw' })}{seriesLines('power2', 'power2', 'power2Avg', '#3c8f88', power2Upstream, { yAxisId: 'kw' })}</>}{config.id === 'efficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.5} />{seriesLines('efficiency', 'efficiency', 'efficiencyAvg', config.color, efficiencyUpstream)}</>}{config.id === 'shiftRatio' && seriesLines('shiftRatio', 'shiftRatio', 'shiftRatioAvg', config.color, shiftRatioUpstream)}</LineChart></ResponsiveContainer>, [config, data, maEnabled, lowRatio, highRatio, isRelationshipChart ? relationshipX : null, isRelationshipChart ? relationshipY : null])
  const singleMaField: MaField | null = config.id === 'rpm1' || config.id === 'rpm2' || config.id === 'efficiency' || config.id === 'shiftRatio' ? config.id : null
  const maToggles = config.id === 'power'
    ? <div className="chart-ma-toggles"><label className="ma-toggle" style={{ color: '#f05d3b' }}><input type="checkbox" checked={maEnabled.power1} onChange={() => onToggleMa('power1')} />Primary MA</label><label className="ma-toggle" style={{ color: '#3c8f88' }}><input type="checkbox" checked={maEnabled.power2} onChange={() => onToggleMa('power2')} />Secondary MA</label></div>
    : singleMaField
    ? <div className="chart-ma-toggles"><label className="ma-toggle"><input type="checkbox" checked={maEnabled[singleMaField]} onChange={() => onToggleMa(singleMaField)} />Moving avg</label></div>
    : config.id === 'scatter'
    ? <div className="chart-ratio-inputs">
        <label className="ratio-input" style={{ color: '#d8a227' }}>
          <span>Low ratio</span>
          <input type="number" step="0.01" min="0" value={lowRatio} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next) && next > 0) onLowRatioChange(next) }} />
        </label>
        <label className="ratio-input" style={{ color: '#3c8f88' }}>
          <span>High ratio</span>
          <input type="number" step="0.01" min="0" value={highRatio} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next) && next > 0) onHighRatioChange(next) }} />
        </label>
      </div>
    : null
  return <article className="chart-card" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><header className="chart-header"><div className="drag-handle" title="Drag to reorder" draggable onDragStart={onDragStart}><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div>{maToggles}<button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header><div className="chart-body" ref={chartBodyRef} onMouseMove={handlePlotMouseMove} onMouseLeave={handlePlotMouseLeave}>{chart}{!isRelationshipChart && <div ref={crosshairRef} className="chart-crosshair-line" style={{ display: 'none' }} />}</div><div className="chart-footer"><span style={{ color: config.color }}>● LIVE</span>{readout && <span className="hover-readout">{readout}</span>}<span>{config.id === 'scatter' ? 'RPM / RPM' : config.id === 'efficiency' ? 'Percent' : config.id === 'power' ? 'kW / hp' : config.id === 'shiftRatio' ? 'Ratio' : config.id === 'shiftEfficiency' ? 'Ratio / Percent' : `Time window: ${windowSeconds.toFixed(1)} s`}</span></div></article>
}

function SerialConsolePanel({ messages, showSensorData, autoScroll, customCommand, setCustomCommand, onToggleSensorData, onToggleAutoScroll, onClear, onSendCommand, onSendCustom, rpmPinTest, rpmInterruptTest, rpmCountTest, rpmPinStates, rpmCountStates, onToggleRpmPinTest, onToggleRpmInterruptTest, onToggleRpmCountTest }: { messages: ConsoleMessage[]; showSensorData: boolean; autoScroll: boolean; customCommand: string; setCustomCommand: (value: string) => void; onToggleSensorData: () => void; onToggleAutoScroll: () => void; onClear: () => void; onSendCommand: (bytes: Uint8Array, description?: string) => Promise<void>; onSendCustom: () => Promise<void>; rpmPinTest: boolean; rpmInterruptTest: boolean; rpmCountTest: boolean; rpmPinStates: [boolean | null, boolean | null]; rpmCountStates: [number | null, number | null]; onToggleRpmPinTest: () => Promise<void>; onToggleRpmInterruptTest: () => Promise<void>; onToggleRpmCountTest: () => Promise<void> }) {
  const [sortBy, setSortBy] = useState<ConsoleSort>('time')
  const [sortAscending, setSortAscending] = useState(false)
  const [globalStackByType, setGlobalStackByType] = useState(false)
  const [stackedTypes, setStackedTypes] = useState<Partial<Record<ConsoleType, boolean>>>({})
  const visibleMessages = showSensorData ? messages : messages.filter((message) => !['RPM1', 'RPM2', 'SHIFT', 'TORQ1', 'TORQ2'].includes(message.type))
  const stackedMessages = Object.entries(stackedTypes).reduce((current, [type, enabled]) => {
    if (!enabled) return current
    const latest = new Map<ConsoleType, ConsoleMessage>()
    current.forEach((message) => { if (message.type === type) latest.set(message.type, message) })
    return current.filter((message) => message.type !== type || latest.get(message.type)?.id === message.id)
  }, visibleMessages)
  const sortedMessages = [...stackedMessages].sort((left, right) => {
    const comparison = sortBy === 'time' ? left.id - right.id : sortBy === 'type' ? left.type.localeCompare(right.type) : left.data.localeCompare(right.data)
    return (sortAscending ? 1 : -1) * comparison
  })
  const types: ConsoleType[] = ['RPM1', 'RPM2', 'SHIFT', 'TORQ1', 'TORQ2', 'READ CONFIG', 'RPM TEST', 'RPM COUNT TEST', 'TEXT', 'TX']
  function changeSort(next: ConsoleSort) { if (sortBy === next) setSortAscending((value) => !value); else { setSortBy(next); setSortAscending(next !== 'time') } }
  function toggleGlobalStackByType() {
    setGlobalStackByType((current) => !current)
    const newStackedTypes: Partial<Record<ConsoleType, boolean>> = {}
    if (!globalStackByType) {
      types.forEach((type) => { newStackedTypes[type] = true })
      setStackedTypes(newStackedTypes)
    } else {
      setStackedTypes({})
    }
  }
  return <section className="serial-console serial-console-structured"><div className="console-toolbar"><div><span className="section-kicker">SERIAL CONSOLE / 115200 BAUD</span><h2>Command link</h2></div><div className="console-toolbar-actions"><button className={`button ${showSensorData ? 'button-accent' : 'button-quiet'}`} onClick={onToggleSensorData}>{showSensorData ? 'Hide sensor data' : 'Show sensor data'}</button><button className={`button ${autoScroll ? 'button-accent' : 'button-quiet'}`} onClick={onToggleAutoScroll}>{autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}</button><button className="button button-quiet" onClick={onClear}><Trash2 size={14} />Clear</button></div></div><div className="console-stack-controls"><button className={`button ${globalStackByType ? 'button-accent' : 'button-quiet'}`} onClick={toggleGlobalStackByType}>Stack latest by type</button></div><div className="console-grid"><div className="console-table-wrap"><table className="console-table"><thead><tr><th><button onClick={() => changeSort('time')}>Time {sortBy === 'time' && (sortAscending ? '↑' : '↓')}</button></th><th><button onClick={() => changeSort('type')}>Type {sortBy === 'type' && (sortAscending ? '↑' : '↓')}</button></th><th><button onClick={() => changeSort('data')}>Data {sortBy === 'data' && (sortAscending ? '↑' : '↓')}</button></th></tr></thead><tbody>{sortedMessages.length ? sortedMessages.map((message) => <tr key={message.id}><td>{message.time}</td><td><span className={`console-type-pill type-${message.type.toLowerCase().replaceAll(' ', '-')}`}>{message.type}</span></td><td>{message.data}</td></tr>) : <tr><td colSpan={3} className="console-empty">No serial messages yet. Connect the firmware or send a command.</td></tr>}</tbody></table></div><div className="console-controls"><span className="console-label">Firmware commands</span><div className="rpm-pin-status"><div className={`rpm-pin-card ${rpmPinStates[0] === null ? 'unknown' : rpmPinStates[0] ? 'is-high' : 'is-low'}`}><span>RPM1 / PIN 1</span><strong>{rpmPinStates[0] === null ? 'WAITING' : rpmPinStates[0] ? 'HIGH' : 'LOW'}</strong></div><div className={`rpm-pin-card ${rpmPinStates[1] === null ? 'unknown' : rpmPinStates[1] ? 'is-high' : 'is-low'}`}><span>RPM2 / PIN 3</span><strong>{rpmPinStates[1] === null ? 'WAITING' : rpmPinStates[1] ? 'HIGH' : 'LOW'}</strong></div></div><div className="rpm-pin-status"><div className={`rpm-pin-card ${rpmCountStates[0] === null ? 'unknown' : 'is-high'}`}><span>RPM1 count</span><strong>{rpmCountStates[0] === null ? 'WAITING' : rpmCountStates[0]}</strong></div><div className={`rpm-pin-card ${rpmCountStates[1] === null ? 'unknown' : 'is-high'}`}><span>RPM2 count</span><strong>{rpmCountStates[1] === null ? 'WAITING' : rpmCountStates[1]}</strong></div></div><button className="console-command" onClick={() => void onSendCommand(encodeCommand(3), 'Read configuration')}><span>Read configuration</span><code>03 00 00 00</code></button><button className="console-command" onClick={() => void onSendCommand(encodeCommand(4, 0, 1), 'Enable bench mode')}><span>Enable bench mode</span><code>04 00 00 01</code></button><button className="console-command" onClick={() => void onSendCommand(encodeCommand(4, 0, 0), 'Disable bench mode')}><span>Use real sensors</span><code>04 00 00 00</code></button><button className={`console-command ${rpmPinTest ? 'is-active' : ''}`} onClick={() => void onToggleRpmPinTest()}><span>{rpmPinTest ? 'Stop RPM pin test' : 'Start RPM pin test'}</span><code>05 00 00 0{rpmPinTest ? '0' : '1'}</code></button><button className={`console-command ${rpmInterruptTest ? 'is-active' : ''}`} onClick={() => void onToggleRpmInterruptTest()}><span>{rpmInterruptTest ? 'Stop interrupt test' : 'Start interrupt test'}</span><code>07 00 00 0{rpmInterruptTest ? '0' : '1'}</code></button><button className={`console-command ${rpmCountTest ? 'is-active' : ''}`} onClick={() => void onToggleRpmCountTest()}><span>{rpmCountTest ? 'Stop RPM count test' : 'Start RPM count test'}</span><code>08 00 00 0{rpmCountTest ? '0' : '1'}</code></button><label className="console-label" htmlFor="custom-command">Custom hex bytes</label><div className="custom-command"><input id="custom-command" value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void onSendCustom() }} /><button className="icon-button" title="Send custom bytes" onClick={() => void onSendCustom()}><Send size={16} /></button></div></div></div></section>
}

export default App