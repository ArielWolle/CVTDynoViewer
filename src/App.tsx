import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from 'react'
import { Activity, Cable, ChevronDown, CircleHelp, Download, Gauge, GripVertical, Pause, Play, Send, Settings2, SlidersHorizontal, Square, Terminal, Trash2, Upload, Usb, Wifi, X, RotateCcw } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { channelNames, defaultEngineTorqueCurve, deriveSample, encodeCommand, EXPECTED_PROTOCOL_VERSION, parseSamplesCsv, periodUsToRpm, type ChannelId, type EngineTorquePoint, type PowerMode, type TelemetrySample } from './protocol'
import { UsbTransport } from './usbTransport'
import { downsampleForChart } from './downsample'
import { TorqueCurveEditor } from './TorqueCurveEditor'
import { TimeRangeSlider } from './TimeRangeSlider'
import { AnalysisClient } from './analysis/client'
import { ANALYSIS_WINDOWS_MS, DEFAULT_ANALYSIS_WINDOW_MS, DEFAULT_SECONDARY_INERTIA_KG_M2, type AnalysisConfig, type AnalysisFrame, type RpmObservation, type RpmObservationMode } from './analysis/types'
import { analysisFramesToCsv } from './analysis/exportCsv'
import { isRawLogCsv, parseRawLogCsv } from './analysis/rawCsv'
import { RawSessionLogger, type RawSessionMetadata } from './session/rawSessionLogger'

type ChartId = 'scatter' | 'rpm1' | 'rpm2' | 'shift' | 'power' | 'efficiency' | 'shiftRatio' | 'shiftEfficiency'
type ChartConfig = { id: ChartId; title: string; subtitle: string; color: string; visible: boolean }
type ChartPoint = AnalysisFrame & { seconds: number }
type RpmObservationPoint = RpmObservation & { seconds: number }
type ConsoleType = 'RPM1' | 'RPM2' | 'SHIFT' | 'TORQ1' | 'TORQ2' | 'READ CONFIG' | 'RPM TEST' | 'RPM COUNT TEST' | 'TEXT' | 'TX'
type ConsoleMessage = { id: number; time: string; type: ConsoleType; data: string }
type ConsoleSort = 'time' | 'type' | 'data'

const defaultCharts: ChartConfig[] = [
  { id: 'scatter', title: 'Primary vs secondary RPM', subtitle: 'Load transfer relationship', color: '#f05d3b', visible: true },
  { id: 'shiftEfficiency', title: 'Ratio vs. efficiency', subtitle: 'Shift ratio / efficiency relationship', color: '#2f6f9e', visible: true },
  { id: 'rpm1', title: 'Primary RPM', subtitle: 'Engine speed / time', color: '#d8a227', visible: true },
  { id: 'rpm2', title: 'Secondary RPM', subtitle: 'Output speed / time', color: '#3c8f88', visible: true },
  { id: 'shift', title: 'Shift position', subtitle: 'Actuator travel / time', color: '#b86b3a', visible: true },
  { id: 'power', title: 'Power output', subtitle: 'Primary and secondary / time', color: '#f05d3b', visible: true },
  { id: 'efficiency', title: 'Efficiency', subtitle: 'Secondary power / primary power', color: '#668b48', visible: true },
  { id: 'shiftRatio', title: 'Shift ratio', subtitle: 'Primary RPM / secondary RPM', color: '#7d5ba6', visible: true },
]

const SENSOR_RETENTION_MS = 300_000
const MAX_CHART_POINTS = 1500
const MAX_CONSOLE_MESSAGES = 500
const DEFAULT_LIVE_WINDOW_MS = 10_000

const EMPTY_ANALYSIS_FRAME: AnalysisFrame = { time: 0, rpm1: 0, rpm2: 0, rpm1Sigma: 0, rpm2Sigma: 0, shift: 0, torq1: 0, torq2: 0, power1: 0, power2: 0, efficiency: Number.NaN, shiftRatio: 0, fullThrottle: false }

function retainRecentSamples(history: AnalysisFrame[], next: AnalysisFrame): AnalysisFrame[] {
  const cutoff = next.time - SENSOR_RETENTION_MS
  return [...history.filter((sample) => sample.time >= cutoff), next]
}

function appendRecentFrames(history: AnalysisFrame[], next: AnalysisFrame[]): AnalysisFrame[] {
  if (!next.length) return history
  const cutoff = next[next.length - 1].time - SENSOR_RETENTION_MS
  return [...history.filter((sample) => sample.time >= cutoff), ...next.filter((sample) => sample.time >= cutoff)]
}

function appendRecentObservations(history: RpmObservation[], next: RpmObservation[]): RpmObservation[] {
  if (!next.length) return history
  const cutoff = next[next.length - 1].time - SENSOR_RETENTION_MS
  return [...history.filter((sample) => sample.time >= cutoff), ...next.filter((sample) => sample.time >= cutoff)]
}

function legacySampleToAnalysisFrame(sample: TelemetrySample): AnalysisFrame {
  return { ...sample, rpm1Sigma: 0, rpm2Sigma: 0, shiftRatio: sample.rpm2 !== 0 ? sample.rpm1 / sample.rpm2 : 0 }
}

function makeDemoSample(index: number, torqueScale: number, torqueOffset: number, powerMode: PowerMode = 'torque', previous?: AnalysisFrame, inertiaKgM2 = DEFAULT_SECONDARY_INERTIA_KG_M2, torqueCurve: EngineTorquePoint[] = defaultEngineTorqueCurve as EngineTorquePoint[]): AnalysisFrame {
  const phase = index / 10
  const values = { time: index * 100, rpm1: Math.round(3200 + Math.sin(phase) * 720 + index * 3), rpm2: Math.round(2200 + Math.sin(phase - 0.5) * 500 + index * 2), shift: Math.round(35 + Math.sin(phase * 0.45) * 20), torq1: Math.round(380 + Math.sin(phase * 0.8) * 90), torq2: Math.round(305 + Math.sin(phase * 0.8 - 0.3) * 76), fullThrottle: Math.sin(phase) > 0.6 }
  const telemetryPrevious: TelemetrySample | undefined = previous ? { time: previous.time, rpm1: previous.rpm1, rpm2: previous.rpm2, shift: previous.shift, torq1: previous.torq1, torq2: previous.torq2, power1: previous.power1, power2: previous.power2, efficiency: previous.efficiency, fullThrottle: previous.fullThrottle } : undefined
  return legacySampleToAnalysisFrame(deriveSample(values, torqueScale, torqueOffset, powerMode, telemetryPrevious, inertiaKgM2, torqueCurve))
}

function formatNumber(value: number, decimals = 0) { return value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) }

function clamp01(value: number) { return Math.min(1, Math.max(0, value)) }

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
  // Populated from the firmware's "Firmware git: <sha>" / "Protocol version: <n>" lines in its
  // command-0x03 config dump, sent automatically right after every connect (see connect() below).
  // firmwareProtocolVersion !== null && !== EXPECTED_PROTOCOL_VERSION means the connected firmware
  // predates (or postdates, in a breaking way) what this viewer was built against -- see
  // EXPECTED_PROTOCOL_VERSION's comment in protocol.ts for why this exists and what it's meant to
  // catch immediately instead of silently misbehaving.
  const [firmwareGitSha, setFirmwareGitSha] = useState<string | null>(null)
  const [firmwareProtocolVersion, setFirmwareProtocolVersion] = useState<number | null>(null)
  const [powerMode, setPowerMode] = useState<PowerMode>('inertia')
  const [inertiaKgM2, setInertiaKgM2] = useState(DEFAULT_SECONDARY_INERTIA_KG_M2)
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
  const [channels, setChannels] = useState([true, true, true, true, true, true])
  const [frequencies, setFrequencies] = useState([20, 20, 10, 50, 50, 0])
  // RPM tooth/spoke counts are a purely local display setting now -- the firmware streams a raw
  // per-tooth period for channels 0/1 and has no concept of tooth count at all anymore (see
  // periodUsToRpm() in protocol.ts), so these persist to localStorage like the other display
  // settings below instead of being read from / sent to the firmware.
  const [primarySpokes, setPrimarySpokes] = useState(() => {
    const stored = Number(localStorage.getItem('cvt-dyno-primary-teeth'))
    return Number.isFinite(stored) && stored >= 1 ? stored : 16
  })
  const [secondarySpokes, setSecondarySpokes] = useState(() => {
    const stored = Number(localStorage.getItem('cvt-dyno-secondary-teeth'))
    return Number.isFinite(stored) && stored >= 1 ? stored : 12
  })
  const [playbackSamples, setPlaybackSamples] = useState<TelemetrySample[]>([])
  const [playbackFileName, setPlaybackFileName] = useState('')
  const [rawPlaybackActive, setRawPlaybackActive] = useState(false)
  const [playbackElapsedMs, setPlaybackElapsedMs] = useState(0)
  const [playbackPlaying, setPlaybackPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [playbackRangeStart, setPlaybackRangeStart] = useState(0)
  const [playbackRangeEnd, setPlaybackRangeEnd] = useState(1)
  const [samples, setSamples] = useState<AnalysisFrame[]>([])
  const [primaryObservations, setPrimaryObservations] = useState<RpmObservation[]>([])
  const [secondaryObservations, setSecondaryObservations] = useState<RpmObservation[]>([])
  // Mirrors droppedPacketsRef for display -- counted via the firmware's per-channel sequence
  // numbers (protocol v2+ only; always 0 against older firmware, which has no sequence number to
  // detect gaps with). This ONLY reveals loss AFTER a packet was already queued for transmission
  // (downstream/USB loss) -- it can NOT reveal an RPM edge that the firmware's own ring buffer
  // dropped before ever assigning it a sequence number, which is exactly why edgeCount/lostEdges
  // below exists as a separate metric (see protocol.ts's EXPECTED_PROTOCOL_VERSION comment for the
  // full reasoning; this used to be conflated as one thing here, which was incorrect).
  const [droppedPackets, setDroppedPackets] = useState(0)
  // Mirrors lostEdgesRef -- per-RPM-channel gaps in the firmware's physical edge counter (protocol
  // v3+ only; always 0 against older firmware). A nonzero value here means an edge was lost BEFORE
  // it ever reached the ring/USB (e.g. RpmCounter's ring buffer overflowing during a transient host
  // stall), distinct from droppedPackets above.
  const [lostEdges, setLostEdges] = useState<[number, number]>([0, 0])
  const [chartPlaying, setChartPlaying] = useState(true)
  const [frozenDomainEnd, setFrozenDomainEnd] = useState<number | null>(null)
  // Bumped whenever a new dataset (CSV) is loaded, so <ChartWorkspace key={chartResetKey}> remounts
  // fresh -- cleanly resetting its internal hover/drag/time-range-slider state without needing to
  // plumb individual reset callbacks down into it.
  const [chartResetKey, setChartResetKey] = useState(0)
  const [analysisWindowMs, setAnalysisWindowMs] = useState(() => {
    const stored = Number(localStorage.getItem('cvt-dyno-analysis-window-ms'))
    return ANALYSIS_WINDOWS_MS.includes(stored as typeof ANALYSIS_WINDOWS_MS[number]) ? stored : DEFAULT_ANALYSIS_WINDOW_MS
  })
  const [rpmObservationMode, setRpmObservationMode] = useState<RpmObservationMode>(() => localStorage.getItem('cvt-dyno-rpm-observation-mode') === 'tooth' ? 'tooth' : 'revolution')
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
  // Full-throttle input (channel 5) is never plotted as its own series -- it's purely a visual
  // styling signal for the other charts (background band on time-series charts, dot color on
  // relationship charts). Togglable since it's a visual effect some users may not want.
  const [highlightFullThrottle, setHighlightFullThrottle] = useState(() => localStorage.getItem('cvt-dyno-highlight-full-throttle') !== 'false')
  const [notice, setNotice] = useState('Demo telemetry is flowing')
  const [directoryName, setDirectoryName] = useState('Browser download')
  const transport = useRef<UsbTransport | null>(null)
  const directoryHandle = useRef<FileSystemDirectoryHandle | null>(null)
  const rawLoggerRef = useRef<RawSessionLogger | null>(null)
  if (!rawLoggerRef.current) rawLoggerRef.current = new RawSessionLogger((message) => setNotice(message))
  const logStartedAtRef = useRef<string | null>(null)
  const consoleOutputRef = useRef<HTMLDivElement | null>(null)
  const consoleMessageId = useRef(0)
  const demoTimer = useRef<number | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // --- Live event-driven capture ---------------------------------------------------------
  // Raw disk logging is deliberately independent of the analysis worker. handleValue() appends the
  // exact packet to RawSessionLogger before health accounting or analysis dispatch.
  const timeOffsetMsRef = useRef<number | null>(null)
  const channelSeqRef = useRef<number[]>([-1, -1, -1, -1, -1, -1])
  const droppedPacketsRef = useRef(0)
  const lastEdgeCountRef = useRef<number[]>([-1, -1])
  const lostEdgesRef = useRef<[number, number]>([0, 0])
  const pendingConsoleLinesRef = useRef<string[]>([])
  const primarySpokesRef = useRef(primarySpokes)
  const secondarySpokesRef = useRef(secondarySpokes)
  const isPlaybackActiveRef = useRef(false)
  const showSensorConsoleRef = useRef(showSensorConsole)
  const analysisClientRef = useRef<AnalysisClient | null>(null)

  const current = samples[samples.length - 1] ?? EMPTY_ANALYSIS_FRAME
  const isPlaybackActive = rawPlaybackActive || playbackSamples.length > 0
  const protocolMismatch = connected && firmwareProtocolVersion !== null && firmwareProtocolVersion !== EXPECTED_PROTOCOL_VERSION
  const derivedPlaybackFrames = useMemo(() => {
    if (!playbackSamples.length) return []
    let previous: TelemetrySample | undefined
    return playbackSamples.map((sample) => {
      const derived = deriveSample(sample, torqueScale, torqueOffset, powerMode, previous, inertiaKgM2, torqueCurve)
      previous = derived
      return legacySampleToAnalysisFrame(derived)
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
  const derivedFullData = useMemo(() => displaySamples.map((sample) => ({ ...sample, seconds: (sample.time - domainStart) / 1000 })), [displaySamples, domainStart])
  const analysisConfig = useMemo<AnalysisConfig>(() => ({
    windowMs: analysisWindowMs,
    primaryTeeth: primarySpokes,
    secondaryTeeth: secondarySpokes,
    secondaryInertiaKgM2: inertiaKgM2,
    torqueCurve: [...torqueCurve],
    powerMode,
    torqueScale,
    torqueOffset,
    observationMode: rpmObservationMode,
  }), [analysisWindowMs, primarySpokes, secondarySpokes, inertiaKgM2, torqueCurve, powerMode, torqueScale, torqueOffset, rpmObservationMode])

  useEffect(() => { localStorage.setItem('cvt-dyno-layout', JSON.stringify(charts)) }, [charts])
  useEffect(() => { localStorage.setItem('cvt-dyno-torque-curve', JSON.stringify(torqueCurve)) }, [torqueCurve])
  useEffect(() => { localStorage.setItem('cvt-dyno-analysis-window-ms', String(analysisWindowMs)) }, [analysisWindowMs])
  useEffect(() => { localStorage.setItem('cvt-dyno-rpm-observation-mode', rpmObservationMode) }, [rpmObservationMode])
  useEffect(() => { localStorage.setItem('cvt-dyno-low-ratio', String(lowRatio)) }, [lowRatio])
  useEffect(() => { localStorage.setItem('cvt-dyno-high-ratio', String(highRatio)) }, [highRatio])
  useEffect(() => { localStorage.setItem('cvt-dyno-primary-teeth', String(primarySpokes)) }, [primarySpokes])
  useEffect(() => { localStorage.setItem('cvt-dyno-secondary-teeth', String(secondarySpokes)) }, [secondarySpokes])
  useEffect(() => { primarySpokesRef.current = primarySpokes }, [primarySpokes])
  useEffect(() => { secondarySpokesRef.current = secondarySpokes }, [secondarySpokes])
  useEffect(() => { isPlaybackActiveRef.current = isPlaybackActive }, [isPlaybackActive])
  useEffect(() => { showSensorConsoleRef.current = showSensorConsole }, [showSensorConsole])
  useEffect(() => {
    const client = new AnalysisClient(analysisConfig, (update) => {
      if (update.type === 'replace') {
        setSamples(update.snapshot.frames)
        setPrimaryObservations(update.snapshot.primaryObservations)
        setSecondaryObservations(update.snapshot.secondaryObservations)
      } else {
        if (update.snapshot.frames.length) setSamples((history) => appendRecentFrames(history, update.snapshot.frames))
        if (update.snapshot.primaryObservations.length) setPrimaryObservations((history) => appendRecentObservations(history, update.snapshot.primaryObservations))
        if (update.snapshot.secondaryObservations.length) setSecondaryObservations((history) => appendRecentObservations(history, update.snapshot.secondaryObservations))
      }
    })
    analysisClientRef.current = client
    return () => { client.terminate(); if (analysisClientRef.current === client) analysisClientRef.current = null }
    // Initial worker creation only; configuration changes use the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { analysisClientRef.current?.configure(analysisConfig) }, [analysisConfig])
  useEffect(() => {
    if (!playbackPlaying || !playbackSamples.length) return
    const timer = window.setInterval(() => { setPlaybackElapsedMs((elapsed) => Math.min(playbackEndBoundMs, elapsed + 100 * playbackSpeed)) }, 100)
    return () => window.clearInterval(timer)
  }, [playbackPlaying, playbackSpeed, playbackSamples, playbackEndBoundMs])
  useEffect(() => {
    if (!derivedPlaybackFrames.length) return
    const start = derivedPlaybackFrames[0].time
    const cutoff = start + playbackElapsedMs
    let index = derivedPlaybackFrames.length - 1
    for (let sampleIndex = 0; sampleIndex < derivedPlaybackFrames.length; sampleIndex += 1) {
      if (derivedPlaybackFrames[sampleIndex].time > cutoff) { index = Math.max(0, sampleIndex - 1); break }
    }
    setSamples(derivedPlaybackFrames.slice(0, index + 1))
    if (playbackPlaying && playbackElapsedMs >= playbackEndBoundMs) setPlaybackPlaying(false)
  }, [derivedPlaybackFrames, playbackElapsedMs, playbackPlaying, playbackEndBoundMs])
  useEffect(() => {
    if (!connected) return
    const flush = () => {
      const consoleLinesToFlush = pendingConsoleLinesRef.current
      if (consoleLinesToFlush.length) {
        pendingConsoleLinesRef.current = []
        appendConsoleLines(consoleLinesToFlush)
      }
      setDroppedPackets(droppedPacketsRef.current)
      setLostEdges([...lostEdgesRef.current])
    }
    const timer = window.setInterval(flush, 33)
    return () => { window.clearInterval(timer); flush() }
  }, [connected])
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
  useEffect(() => () => { void rawLoggerRef.current?.stop(); void transport.current?.disconnect() }, [])

  async function connect() {
    try {
      const next = new UsbTransport({ onValue: handleValue, onPacket: handleUsbPacket, onText: handleUsbText })
      timeOffsetMsRef.current = null
      channelSeqRef.current = [-1, -1, -1, -1, -1, -1]
      droppedPacketsRef.current = 0
      lastEdgeCountRef.current = [-1, -1]
      lostEdgesRef.current = [0, 0]
      pendingConsoleLinesRef.current = []
      analysisClientRef.current?.reset()
      setPrimaryObservations([])
      setSecondaryObservations([])
      // Cleared on every fresh connect (not just at app startup) so stale info from a previously
      // connected device -- or a firmware that hadn't been reflashed with this feature yet -- can
      // never be mistaken for the currently connected device's actual identity.
      setFirmwareGitSha(null)
      setFirmwareProtocolVersion(null)
      await next.connect(); transport.current = next; setConnected(true); setDemoMode(false); setFirmwareDemoMode(false); setSamples([]); setPlaybackSamples([]); setRawPlaybackActive(false); setPlaybackPlaying(false); setPlaybackFileName(''); setPlaybackElapsedMs(0); setNotice('Reading dyno configuration...'); await next.send(encodeCommand(3))
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not connect to USB device') }
  }
  async function disconnect() { if (logging) await stopLogging(); await transport.current?.disconnect(); transport.current = null; setConnected(false); setFirmwareDemoMode(false); setFirmwareGitSha(null); setFirmwareProtocolVersion(null); setNotice('Device disconnected') }
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
    // Only the trailing MAX_CONSOLE_MESSAGES lines can ever survive the slice()s below anyway, so
    // anything before that is dropped up front -- at a high packet rate (per-tooth RPM streaming
    // with the sensor console open) a single ~33ms flush batch could otherwise contain thousands
    // of buffered lines, each needlessly getting a real Date()/toLocaleTimeString() call and a
    // classification pass before being thrown away regardless.
    const relevant = linesToAdd.length > MAX_CONSOLE_MESSAGES ? linesToAdd.slice(-MAX_CONSOLE_MESSAGES) : linesToAdd
    // One timestamp for the whole batch rather than one real Date() call per line -- they all
    // arrived within the same flush tick anyway (this is receive time, not firmware capture time,
    // so per-line precision here was never meaningful), and at burst sizes this removes what would
    // otherwise be hundreds-to-thousands of redundant Date()/formatting calls per flush.
    const time = consoleTimestamp()
    const messages = relevant.map((line) => ({ id: consoleMessageId.current++, time, type: consoleTypeFor(line), data: line }))
    setConsoleMessages((messagesSoFar) => [...messagesSoFar, ...messages].slice(-MAX_CONSOLE_MESSAGES))
    setConsoleLines((lines) => [...lines, ...messages.map((message) => `${message.time} ${message.data}`)].slice(-MAX_CONSOLE_MESSAGES))
  }
  function handleUsbText(text: string) {
    appendConsoleLines([`[RAW TEXT] ${text}`])
    // Sent as the first two lines of every command-0x03 config dump (see connect() below) --
    // see EXPECTED_PROTOCOL_VERSION's comment in protocol.ts for why this exists.
    const firmwareGitMatch = text.match(/^Firmware git:\s*(\S+)$/i)
    if (firmwareGitMatch) {
      setFirmwareGitSha(firmwareGitMatch[1])
      return
    }
    const protocolVersionMatch = text.match(/^Protocol version:\s*(\d+)$/i)
    if (protocolVersionMatch) {
      const version = Number(protocolVersionMatch[1])
      setFirmwareProtocolVersion(version)
      if (version !== EXPECTED_PROTOCOL_VERSION) {
        setNotice(`Firmware/viewer protocol mismatch: device reports v${version}, this viewer expects v${EXPECTED_PROTOCOL_VERSION}. Reflash the firmware (or update the viewer) before trusting any data.`)
      }
      return
    }
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
    // RPM wheel teeth/spoke counts are no longer read from the firmware at all -- they're a
    // purely local display setting now (see the primarySpokes/secondarySpokes state comment).
    // Firmware also includes per-channel dropped-edge and rejected-noise counts now (see
    // RpmCounter::popEdge()'s ring buffer and MIN_VALID_PERIOD_US respectively) -- surfaced in the
    // notice for visibility, though not wired into their own UI state beyond that.
    const rpmCountMatch = text.match(/^RPM COUNT TEST \| RPM1 count=(\d+) dropped=(\d+) rejected=(\d+) \| RPM2 count=(\d+) dropped=(\d+) rejected=(\d+)$/i)
    if (rpmCountMatch) {
      const rpm1Count = Number(rpmCountMatch[1])
      const rpm1Dropped = Number(rpmCountMatch[2])
      const rpm1Rejected = Number(rpmCountMatch[3])
      const rpm2Count = Number(rpmCountMatch[4])
      const rpm2Dropped = Number(rpmCountMatch[5])
      const rpm2Rejected = Number(rpmCountMatch[6])
      setRpmCountStates([rpm1Count, rpm2Count])
      setNotice(`RPM counts: RPM1=${rpm1Count} (dropped ${rpm1Dropped}, rejected ${rpm1Rejected}), RPM2=${rpm2Count} (dropped ${rpm2Dropped}, rejected ${rpm2Rejected})`)
      return
    }
    // RPM channels (0/1) print a different tail now -- "Edge-triggered (...)" instead of "Target
    // Tx Freq: N Hz" -- since they're no longer polled at a configurable rate (see the firmware's
    // printCurrentConfig()). Match both formats so the enable state still syncs for every channel;
    // only channels 2-4 have a frequency to also sync.
    const configMatchPolled = text.match(/^Channel \[(\d)\].*:\s(ENABLED|DISABLED)\s+\|\s+Target Tx Freq:\s+(\d+)\s+Hz$/i)
    const configMatchEdgeTriggered = text.match(/^Channel \[(\d)\].*:\s(ENABLED|DISABLED)\s+\|\s+Edge-triggered/i)
    const configMatch = configMatchPolled ?? configMatchEdgeTriggered
    if (configMatch) {
      const channel = Number(configMatch[1])
      const enabled = configMatch[2].toUpperCase() === 'ENABLED'
      setChannels((values) => values.map((value, index) => index === channel ? enabled : value))
      if (configMatchPolled) {
        const frequency = Number(configMatchPolled[3])
        setFrequencies((values) => values.map((value, index) => index === channel ? frequency : value))
      }
      setNotice(`Dyno configuration received: ${channelNames[channel]}`)
      return
    }
    setNotice(text)
  }
  function handleUsbPacket(rawPacket: Uint8Array, channel: ChannelId, value: number, seq: number) {
    // Skip formatting/buffering entirely when the sensor console view is off -- at real telemetry
    // rates (up to 50 Hz now, potentially much higher per-channel later) doing this unconditionally
    // for every single packet would itself become a rendering bottleneck. When it is on, lines are
    // buffered and flushed in a batch (see the display-throttle effect) rather than one React
    // state update per packet.
    if (!showSensorConsoleRef.current) return
    // Bounded so a high-rate burst (per-tooth RPM streaming with the console open) can't build up
    // an ever-growing backlog of formatted lines between ~33ms flushes -- only the trailing
    // MAX_CONSOLE_MESSAGES can ever be shown anyway (see appendConsoleLines()), so skip the
    // hex/decode formatting work below entirely once already at that cap rather than doing it just
    // to throw the result away at flush time.
    if (pendingConsoleLinesRef.current.length >= MAX_CONSOLE_MESSAGES) return
    // RPM channels carry a raw period_us on the wire, not RPM (see protocol.ts) -- show both the
    // raw value and the translated RPM (using this app's own tooth-count setting) so the console
    // is actually readable at a glance instead of just a period figure. seq is labeled explicitly
    // (not a bare number) since it's otherwise ambiguous next to the other figures on the line.
    const decoded = channel === 0 || channel === 1
      ? `${channelNames[channel]} = ${value}us (seq #${seq}) -> ${formatNumber(periodUsToRpm(value, channel === 0 ? primarySpokesRef.current : secondarySpokesRef.current), 1)} RPM`
      : `${channelNames[channel]} = ${value} (seq #${seq})`
    pendingConsoleLinesRef.current.push(`[RAW SENSOR] ${bytesToHex(rawPacket)} | [DECODED] ${decoded}`)
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
    // Wrapped in try/catch (unlike a previous version of this function) so a failed send can't
    // silently leave the button showing the old state with no indication anything went wrong --
    // matches the pattern already used by the other firmware-toggle functions below.
    try {
      await transport.current.send(encodeCommand(4, 0, enabled ? 1 : 0))
      setFirmwareDemoMode(enabled)
      setNotice(enabled ? 'Firmware bench mode enabled' : 'Firmware sensors enabled')
    } catch {
      setNotice('Could not change bench mode')
    }
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
  // Event-driven raw-first capture. The exact packet is queued for durable logging before
  // health accounting, display work, or analysis dispatch. Analysis therefore cannot compromise
  // the source-of-truth recording path.
  function handleValue(channel: ChannelId, value: number, tUs: number, seq: number, edgeCount: number) {
    const receivedAtMs = performance.timeOrigin + performance.now()
    let sampleTimeMs = receivedAtMs
    if (tUs > 0) {
      if (timeOffsetMsRef.current === null) timeOffsetMsRef.current = receivedAtMs - tUs / 1000
      sampleTimeMs = timeOffsetMsRef.current + tUs / 1000
    }

    rawLoggerRef.current?.append(channel, value, tUs, sampleTimeMs, seq, edgeCount)

    const expectedSeq = channelSeqRef.current[channel]
    let seqGap = 0
    if (tUs > 0 && expectedSeq !== -1) {
      seqGap = (seq - expectedSeq - 1) & 0xff
      if (seqGap > 0) droppedPacketsRef.current += seqGap
    }
    channelSeqRef.current[channel] = seq
    if (channel === 0 || channel === 1) {
      if (value === 0) lastEdgeCountRef.current[channel] = -1
      else {
        const lastEdgeCount = lastEdgeCountRef.current[channel]
        if (lastEdgeCount !== -1) {
          const edgeGap = (edgeCount - lastEdgeCount - 1) >>> 0
          const deviceOnlyLoss = Math.max(0, edgeGap - seqGap)
          if (deviceOnlyLoss > 0) lostEdgesRef.current[channel] += deviceOnlyLoss
        }
        lastEdgeCountRef.current[channel] = edgeCount
      }
    }

    if (isPlaybackActiveRef.current) return
    analysisClientRef.current?.push({ channel, value, tUs, seq, edgeCount })
  }
  // RPM channels (0/1) are edge-triggered now, not polled -- command 0x02 (target frequency) is
  // vestigial for them (see the firmware's cfg_freq[] comment), so it's simply never sent for
  // those two channels. The enable toggle (command 0x01) still matters for every channel, RPM
  // included -- it gates whether the firmware bothers draining/transmitting that channel at all.
  async function sendConfig(channel: number, enabled: boolean, frequency: number) {
    if (!transport.current) return
    await transport.current.send(encodeCommand(1, channel, enabled ? 1 : 0))
    if (channel >= 2 && channel <= 4) await transport.current.send(encodeCommand(2, channel, frequency))
  }
  function updateChannel(channel: number, enabled: boolean) {
    setChannels((previous) => previous.map((value, index) => index === channel ? enabled : value))
    // The firmware's RpmCounter keeps incrementing edgeCount for real edges even while a channel
    // is disabled -- disabling only stops the drain loop from building/sending a packet for them
    // (see RpmCounter.cpp's edgeCount comment and this file's cfg_write_en discussion above), it
    // doesn't stop the underlying edge from being counted. Without resetting the baseline here,
    // every edge that occurred during the disabled window would show up as a sudden, spurious
    // "device-side loss" spike on the very first packet after re-enabling -- edges the firmware
    // never intended to transmit in the first place, not a real loss. Resetting on EITHER
    // direction of the toggle (not just re-enabling) keeps this simple and correct regardless of
    // how long the channel stays disabled.
    if (channel === 0 || channel === 1) lastEdgeCountRef.current[channel] = -1
    void sendConfig(channel, enabled, frequencies[channel]).catch(() => setNotice('Could not send channel configuration'))
  }
  function updateFrequency(channel: number, frequency: number) { setFrequencies((previous) => previous.map((value, index) => index === channel ? frequency : value)); void sendConfig(channel, channels[channel], frequency).catch(() => setNotice('Could not send frequency configuration')) }
  // Local-only display setting now -- see the primarySpokes/secondarySpokes state comment. No
  // firmware command is sent; command 0x06 (the old "set RPM spoke count") is reserved/removed on
  // the firmware side, since spoke count no longer has any on-device meaning to configure.
  function updateSpokes(channel: 0 | 1, spokes: number) {
    if (channel === 0) setPrimarySpokes(spokes)
    else setSecondarySpokes(spokes)
  }
  async function downloadProcessedCsv(sourceFrames: AnalysisFrame[] = samples, baseName: string = sessionName || 'cvt-dyno-session') {
    const csv = analysisFramesToCsv(sourceFrames)
    const name = `${baseName}-processed-${analysisWindowMs}ms.csv`
    if (directoryHandle.current) {
      const file = await directoryHandle.current.getFileHandle(name, { create: true })
      const writable = await file.createWritable(); await writable.write(csv); await writable.close()
      setNotice(`Saved ${sourceFrames.length.toLocaleString()} processed frames to ${directoryHandle.current.name}`)
      return
    }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); setNotice(`Downloaded ${sourceFrames.length.toLocaleString()} processed frames`)
  }
  async function saveRecalculatedCsv() { await downloadProcessedCsv(samples, (playbackFileName || 'cvt-dyno-session').replace(/\.csv$/i, '')) }
  async function chooseDirectory(): Promise<FileSystemDirectoryHandle | null> {
    if (!window.showDirectoryPicker) { setNotice('Chrome folder access is required for lossless raw logging'); return null }
    try { directoryHandle.current = await window.showDirectoryPicker(); setDirectoryName(directoryHandle.current.name); setNotice(`Folder access granted: ${directoryHandle.current.name}`); return directoryHandle.current } catch { setNotice('Folder selection cancelled'); return null }
  }
  function sessionMetadata(stoppedAt?: string): RawSessionMetadata {
    return { schemaVersion: 1, startedAt: logStartedAtRef.current ?? new Date().toISOString(), ...(stoppedAt ? { stoppedAt } : {}), firmwareGitSha, firmwareProtocolVersion, primaryTeeth: primarySpokes, secondaryTeeth: secondarySpokes, secondaryInertiaKgM2: inertiaKgM2, analysisWindowMs, powerMode, torqueCurve, torqueScale, torqueOffset, channels, frequencies }
  }
  async function startLogging() {
    if (!connected) { setNotice('Connect the dyno before starting lossless raw logging'); return }
    const directory = directoryHandle.current ?? await chooseDirectory()
    if (!directory) return
    try { logStartedAtRef.current = new Date().toISOString(); await rawLoggerRef.current?.start(directory, sessionName, sessionMetadata()); setLogging(true); setNotice(`Writing ${rawLoggerRef.current?.fileName ?? 'raw log'}`) } catch { setNotice('Could not open the raw log file in that folder') }
  }
  async function stopLogging() {
    try { await transport.current?.flush(); await rawLoggerRef.current?.stop(sessionMetadata(new Date().toISOString())); setLogging(false); setNotice(`Closed ${rawLoggerRef.current?.fileName ?? 'raw log'}`) } catch { setNotice('Could not finish the raw log cleanly') }
  }
  async function loadPlaybackFile(file: File) {
    try {
      const text = await file.text()
      if (!isRawLogCsv(text)) {
        setNotice('That file is not a raw dyno run. Load the *-raw.csv file with firmware_t_us / seq / raw_value / edge_count columns.')
        return
      }
      const rawPackets = parseRawLogCsv(text)
      if (!rawPackets.length) { setNotice('Raw CSV recognized, but it contains no telemetry packets'); return }
      window.clearInterval(demoTimer.current)
      setDemoMode(false)
      setRawPlaybackActive(true)
      setPlaybackSamples([])
      setPlaybackFileName(file.name)
      setPlaybackPlaying(false)
      setSamples([])
      setPrimaryObservations([])
      setSecondaryObservations([])
      setChartPlaying(true)
      setFrozenDomainEnd(null)
      setChartResetKey((key) => key + 1)
      analysisClientRef.current?.reset()
      for (let index = 0; index < rawPackets.length; index += 5000) analysisClientRef.current?.pushMany(rawPackets.slice(index, index + 5000))
      setNotice(`Loaded ${rawPackets.length.toLocaleString()} raw packets from ${file.name}`)
    } catch { setNotice('Could not read that raw CSV file') }
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
    setRawPlaybackActive(false)
    setPlaybackFileName('')
    setPlaybackElapsedMs(0)
    setPlaybackRangeStart(0)
    setPlaybackRangeEnd(1)
    setSamples([])
    setPrimaryObservations([])
    setSecondaryObservations([])
    analysisClientRef.current?.reset()
    setNotice('Playback cleared; live analysis resumes from new incoming packets')
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
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Activity size={20} /></div><div><span className="eyebrow">CVT DYNAMOMETER</span><h1>Live instrument</h1></div></div><div className="topbar-status"><span className={`status-dot ${connected ? 'is-live' : 'is-demo'}`} />{connected ? firmwareDemoMode ? 'Firmware bench mode' : 'USB link active' : demoMode ? 'Browser demo stream' : 'Offline'}<span className="status-divider" /><span className="mono">{formatNumber(current.rpm1)} RPM</span>{connected && firmwareGitSha && <><span className="status-divider" /><span className="mono" title="Firmware build identifier (git commit), reported on connect">fw {firmwareGitSha}</span></>}</div><div className="top-actions"><button className="button button-quiet" onClick={() => setDemoMode((value) => !value)} title="Toggle browser demo telemetry"><Gauge size={16} />{demoMode ? 'Browser demo' : 'Demo off'}</button>{connected && <button className={`button ${firmwareDemoMode ? 'button-accent' : 'button-quiet'}`} onClick={() => void toggleFirmwareDemo()} title="Toggle synthetic data on the connected firmware"><Gauge size={16} />{firmwareDemoMode ? 'Bench on' : 'Bench mode'}</button>}<button className={`button ${consoleOpen ? 'button-dark' : 'button-quiet'}`} onClick={() => setConsoleOpen((value) => !value)}><Terminal size={16} />Console<ChevronDown size={14} className={consoleOpen ? 'icon-rotate' : ''} /></button>{connected ? <button className="button button-dark" onClick={() => void disconnect()}><Usb size={16} />Disconnect</button> : <button className="button button-accent" onClick={() => void connect()}><Cable size={16} />Connect device</button>}</div></header>
    {protocolMismatch && <section className="protocol-mismatch-banner" role="alert">
      <strong>Firmware/viewer protocol mismatch.</strong> Connected device reports protocol v{firmwareProtocolVersion}{firmwareGitSha ? ` (build ${firmwareGitSha})` : ''}, this viewer expects v{EXPECTED_PROTOCOL_VERSION}.
      Data may be misinterpreted -- reflash the firmware from the latest build, or use a matching viewer version, before trusting anything shown below.
    </section>}
    {consoleOpen && <UsbConsolePanel messages={consoleMessages} showSensorData={showSensorConsole} autoScroll={autoScrollConsole} customCommand={customCommand} setCustomCommand={setCustomCommand} onToggleSensorData={() => setShowSensorConsole((value) => !value)} onToggleAutoScroll={() => setAutoScrollConsole((value) => !value)} onClear={() => { setConsoleLines([]); setConsoleMessages([]) }} onSendCommand={sendRawCommand} onSendCustom={sendCustomCommand} rpmPinTest={rpmPinTest} rpmInterruptTest={rpmInterruptTest} rpmCountTest={rpmCountTest} rpmPinStates={rpmPinStates} rpmCountStates={rpmCountStates} onToggleRpmPinTest={toggleRpmPinTest} onToggleRpmInterruptTest={toggleRpmInterruptTest} onToggleRpmCountTest={toggleRpmCountTest} />}
    <section className="command-deck"><div className="deck-heading"><span className="section-kicker">01 / CONTROL ROOM</span><h2>Run configuration</h2><p>{notice}</p></div><div className="control-group"><label htmlFor="session">Session name</label><input id="session" value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></div>{powerMode === 'torque' && <><div className="control-group compact"><label htmlFor="scale">Torque scale</label><div className="input-with-unit"><input id="scale" type="number" step="0.001" value={torqueScale} onChange={(event) => setTorqueScale(Number(event.target.value))} /><span>N m/count</span></div></div><div className="control-group compact"><label htmlFor="offset">Torque zero</label><div className="input-with-unit"><input id="offset" type="number" value={torqueOffset} onChange={(event) => setTorqueOffset(Number(event.target.value))} /><span>count</span></div></div></>}{powerMode === 'inertia' && <div className="control-group compact"><label htmlFor="inertia-settings">Inertia settings</label><button id="inertia-settings" className={`button ${inertiaSettingsOpen ? 'button-dark' : 'button-quiet'}`} type="button" onClick={() => setInertiaSettingsOpen((value) => !value)}><Settings2 size={14} />{formatNumber(inertiaKgM2, 4)} kg·m²<ChevronDown size={14} className={inertiaSettingsOpen ? 'icon-rotate' : ''} /></button></div>}<div className="control-group compact"><label htmlFor="power-mode">Power mode</label><button id="power-mode" className="button button-quiet" type="button" onClick={() => setPowerMode((mode) => mode === 'torque' ? 'inertia' : 'torque')}>{powerMode === 'torque' ? 'Torque conversion' : 'Inertia mode'}</button></div>
        <div className="deck-actions"><button className={`button button-log ${logging ? 'is-recording' : ''}`} onClick={() => void (logging ? stopLogging() : startLogging())}>{logging ? <Square size={14} fill="currentColor" /> : <CircleHelp size={14} />}{logging ? `Logging ${rawLoggerRef.current?.fileName ?? 'raw'}` : 'Start raw log'}</button><button className="button button-quiet" onClick={() => void chooseDirectory()} title="Grant Chrome permission to write logs directly">{directoryName === 'Browser download' ? 'Grant folder access' : directoryName}</button><button className="icon-button" title="Export processed CSV" onClick={() => void downloadProcessedCsv()}><Download size={17} /></button><button className="icon-button" title="Clear session" onClick={() => { setSamples([]); setNotice('Session buffer cleared') }}><Trash2 size={17} /></button></div></section>
    {powerMode === 'inertia' && inertiaSettingsOpen && <section className="inertia-settings"><div className="inertia-settings-header"><span className="section-kicker">INERTIA MODE SETTINGS</span><h3>Shaft inertia and engine curve</h3><button className="icon-button" title="Close" onClick={() => setInertiaSettingsOpen(false)}><X size={15} /></button></div><div className="inertia-settings-body"><div className="control-group compact inertia-input"><label htmlFor="inertia-value">Secondary inertia</label><div className="input-with-unit"><input id="inertia-value" type="number" step="0.0001" min="0" value={inertiaKgM2} onChange={(event) => setInertiaKgM2(Number(event.target.value))} /><span>kg·m²</span></div></div><div className="torque-curve-wrap"><div className="torque-curve-heading"><span>Primary RPM vs. torque curve</span><button className="button button-quiet" onClick={() => setTorqueCurve([...defaultEngineTorqueCurve])}><RotateCcw size={13} />Reset curve</button></div><TorqueCurveEditor points={torqueCurve} onChange={setTorqueCurve} /></div></div></section>}
    <section className="channel-strip"><div className="strip-label"><SlidersHorizontal size={17} /><span>Telemetry channels</span></div>{channelNames.map((name, index) => <div className="channel-control" key={name}><button className={`channel-toggle ${channels[index] ? 'enabled' : ''}`} onClick={() => updateChannel(index, !channels[index])}>{channels[index] ? 'ON' : 'OFF'}</button><span>{name.replace('Primary ', 'PRI ').replace('Secondary ', 'SEC ')}</span>{index <= 1 ? <span className="mono" title="RPM channels are edge-triggered (one packet per physical tooth), not polled at a configurable rate">Per-tooth</span> : index === 5 ? <span className="mono" title="Full-throttle state is event-driven and transmitted only when it changes">On change</span> : <select value={frequencies[index]} onChange={(event) => updateFrequency(index, Number(event.target.value))}><option value="10">10 Hz</option><option value="20">20 Hz</option><option value="50">50 Hz</option></select>}</div>)}</section>
    <section className="channel-strip"><div className="strip-label"><Gauge size={17} /><span>RPM wheel teeth / spokes</span></div><div className="channel-control"><span>Primary wheel teeth</span><input type="number" min="1" max="999" value={primarySpokes} onChange={(event) => updateSpokes(0, Number(event.target.value))} /></div><div className="channel-control"><span>Secondary wheel teeth</span><input type="number" min="1" max="999" value={secondarySpokes} onChange={(event) => updateSpokes(1, Number(event.target.value))} /></div></section>
    <section className="playback-bar"><div className="strip-label"><Upload size={17} /><span>Raw run playback</span></div><input ref={fileInputRef} type="file" accept=".csv,text/csv" className="visually-hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadPlaybackFile(file); event.target.value = '' }} /><button className="button button-quiet" onClick={() => fileInputRef.current?.click()}><Upload size={14} />Load raw CSV</button>{isPlaybackActive && <><span className="mono playback-filename">{playbackFileName}</span>{rawPlaybackActive ? <span className="mono">Raw run · reprocessed at {analysisWindowMs} ms</span> : <><button className="icon-button" title={playbackPlaying ? 'Pause playback' : 'Play playback'} onClick={togglePlaybackPlaying}>{playbackPlaying ? <Pause size={16} /> : <Play size={16} />}</button><TimeRangeSlider startFraction={playbackRangeStart} endFraction={playbackRangeEnd} onChange={handlePlaybackRangeChange} formatValue={(fraction) => `${((fraction * playbackDurationMs) / 1000).toFixed(1)}s`} /><span className="mono">{(playbackElapsedMs / 1000).toFixed(1)}s / {(playbackDurationMs / 1000).toFixed(1)}s</span><select value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))}><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option></select></>}<button className="icon-button" title="Export processed CSV" onClick={() => void saveRecalculatedCsv()}><Download size={16} /></button><button className="icon-button" title="Clear playback" onClick={stopPlayback}><Trash2 size={16} /></button></>}</section>
    <section className="metric-grid">{[['Primary RPM', current.rpm1, 'rpm'], ['Secondary RPM', current.rpm2, 'rpm'], ['Shift position', current.shift, '%'], ['Primary power', current.power1, 'kW'], ['Secondary power', current.power2, 'kW'], ['Efficiency', current.efficiency, '%']].map(([label, value, unit], index) => <article className="metric" key={label as string}><span className="metric-index">0{index + 1}</span><span className="metric-label">{label as string}</span><strong>{Number.isFinite(value as number) ? formatNumber(value as number, unit === 'kW' || unit === '%' ? 1 : 0) : '—'}</strong><span className="metric-unit">{unit as string}</span></article>)}</section>
    <ChartWorkspace
      key={chartResetKey}
      sampleCount={samples.length}
      chartPlaying={chartPlaying}
      onToggleChartPlaying={toggleChartPlaying}
      analysisWindowMs={analysisWindowMs}
      onAnalysisWindowChange={setAnalysisWindowMs}
      observationMode={rpmObservationMode}
      onObservationModeChange={setRpmObservationMode}
      charts={charts}
      setCharts={setCharts}
      data={derivedFullData}
      primaryObservations={primaryObservations}
      secondaryObservations={secondaryObservations}
      lowRatio={lowRatio}
      highRatio={highRatio}
      onLowRatioChange={setLowRatio}
      onHighRatioChange={setHighRatio}
      droppedPackets={droppedPackets}
      lostEdges={lostEdges}
      powerMode={powerMode}
    />
    <footer className="footer"><span><Wifi size={14} /> Browser WebUSB requires Chromium</span><span className="mono">CVT / {sessionName || 'untitled'} / {new Date().toLocaleTimeString()}</span></footer>
  </main>
}

/**
 * Owns the chart grid's hover-sync state (and drag-to-reorder state) in its own subtree, isolated
 * from the rest of the app. Hovering a chart updates this state on essentially every animation
 * frame while the mouse moves; if that state lived in the top-level App component instead, every
 * hover would re-render the whole app (topbar, console, control deck, playback bar, etc.), not
 * just the charts, which is visibly laggy. Keeping it here means only this subtree re-renders.
 */
function ChartWorkspace({ sampleCount, chartPlaying, onToggleChartPlaying, analysisWindowMs, onAnalysisWindowChange, observationMode, onObservationModeChange, charts, setCharts, data, primaryObservations, secondaryObservations, lowRatio, highRatio, onLowRatioChange, onHighRatioChange, droppedPackets, lostEdges, powerMode }: { sampleCount: number; chartPlaying: boolean; onToggleChartPlaying: () => void; analysisWindowMs: number; onAnalysisWindowChange: (value: number) => void; observationMode: RpmObservationMode; onObservationModeChange: (value: RpmObservationMode) => void; charts: ChartConfig[]; setCharts: Dispatch<SetStateAction<ChartConfig[]>>; data: ChartPoint[]; primaryObservations: RpmObservation[]; secondaryObservations: RpmObservation[]; lowRatio: number; highRatio: number; onLowRatioChange: (value: number) => void; onHighRatioChange: (value: number) => void; droppedPackets: number; lostEdges: [number, number]; powerMode: PowerMode }) {
  const [manualRange, setManualRange] = useState<{ start: number; end: number } | null>(null)
  const domainStart = data[0]?.time ?? 0
  const domainEnd = data[data.length - 1]?.time ?? domainStart
  const domainSpan = Math.max(0, domainEnd - domainStart)
  const autoRangeStart = domainSpan <= DEFAULT_LIVE_WINDOW_MS ? 0 : 1 - DEFAULT_LIVE_WINDOW_MS / domainSpan
  const rangeStart = manualRange ? manualRange.start : autoRangeStart
  const rangeEnd = manualRange ? manualRange.end : 1
  const windowStartMs = domainStart + rangeStart * domainSpan
  const windowEndMs = domainStart + rangeEnd * domainSpan
  const windowedData = useMemo(() => data.filter((point) => point.time >= windowStartMs && point.time <= windowEndMs), [data, windowStartMs, windowEndMs])
  const chartData = useMemo(() => downsampleForChart(windowedData, MAX_CHART_POINTS), [windowedData])
  const observationData = useCallback((observations: RpmObservation[]) => downsampleForChart(
    observations
      .filter((point) => point.time >= windowStartMs && point.time <= windowEndMs)
      .map((point) => ({ ...point, seconds: (point.time - domainStart) / 1000 })),
    MAX_CHART_POINTS,
  ), [windowStartMs, windowEndMs, domainStart])
  const primaryObservationData = useMemo(() => observationData(primaryObservations), [observationData, primaryObservations])
  const secondaryObservationData = useMemo(() => observationData(secondaryObservations), [observationData, secondaryObservations])
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
  function reorder(target: ChartId) { if (!dragged || dragged === target) return; const from = charts.findIndex((chart) => chart.id === dragged); const to = charts.findIndex((chart) => chart.id === target); const next = [...charts]; const [item] = next.splice(from, 1); next.splice(to, 0, item); setCharts(next); setDragged(null) }
  const hoveredPoint = useMemo(() => (hoverTime !== null ? chartData.find((point) => point.time === hoverTime) : undefined), [chartData, hoverTime])

  return <>
    <section className="workspace-heading"><div><span className="section-kicker">02 / LIVE TELEMETRY</span><h2>Analysis workspace</h2></div><div className="workspace-tools"><span><span className="status-dot is-live" />{sampleCount.toLocaleString()} analysis frames</span>{droppedPackets > 0 && <span className="workspace-dropped" title="Packets lost after being queued for transmission, detected via sequence numbers"><X size={13} />{droppedPackets.toLocaleString()} dropped</span>}{(lostEdges[0] + lostEdges[1]) > 0 && <span className="workspace-dropped" title={`Primary RPM: ${lostEdges[0].toLocaleString()} lost | Secondary RPM: ${lostEdges[1].toLocaleString()} lost`}><X size={13} />{(lostEdges[0] + lostEdges[1]).toLocaleString()} lost (device)</span>}<button className={`button ${chartPlaying ? 'button-quiet' : 'button-accent'}`} onClick={onToggleChartPlaying}>{chartPlaying ? <Pause size={15} /> : <Play size={15} />}{chartPlaying ? 'Pause' : 'Paused'}</button><label className="analysis-select"><span>Analysis window</span><select value={analysisWindowMs} onChange={(event) => onAnalysisWindowChange(Number(event.target.value))}>{ANALYSIS_WINDOWS_MS.map((value) => <option value={value} key={value}>{value} ms</option>)}</select></label><label className="analysis-select"><span>RPM points</span><select value={observationMode} onChange={(event) => onObservationModeChange(event.target.value as RpmObservationMode)}><option value="revolution">1 revolution</option><option value="tooth">Per tooth</option></select></label><button className="button button-quiet" onClick={() => setCharts(defaultCharts)}><RotateCcw size={15} />Reset layout</button></div></section>
    {domainSpan > 0 && <section className="chart-range-bar"><TimeRangeSlider startFraction={rangeStart} endFraction={rangeEnd} onChange={(next) => setManualRange(next)} formatValue={(fraction) => `${((fraction * domainSpan) / 1000).toFixed(1)}s`} /><button className="button button-quiet chart-range-reset" onClick={() => setManualRange({ start: 0, end: 1 })}>Full range</button></section>}
    <section className="chart-grid">{charts.filter((chart) => chart.visible).map((chart) => <ChartCard key={chart.id} config={chart} data={chartData} primaryObservations={primaryObservationData} secondaryObservations={secondaryObservationData} analysisWindowMs={analysisWindowMs} windowSeconds={(windowEndMs - windowStartMs) / 1000} hoveredPoint={hoveredPoint} onHover={scheduleHover} lowRatio={lowRatio} highRatio={highRatio} onLowRatioChange={onLowRatioChange} onHighRatioChange={onHighRatioChange} powerMode={powerMode} onDragStart={() => setDragged(chart.id)} onDrop={() => reorder(chart.id)} onHide={() => setCharts((items) => items.map((item) => item.id === chart.id ? { ...item, visible: false } : item))} />)}</section>
  </>
}

function ChartCard({ config, data, primaryObservations, secondaryObservations, analysisWindowMs, windowSeconds, hoveredPoint, onHover, lowRatio, highRatio, onLowRatioChange, onHighRatioChange, powerMode, onDragStart, onDrop, onHide }: { config: ChartConfig; data: ChartPoint[]; primaryObservations: RpmObservationPoint[]; secondaryObservations: RpmObservationPoint[]; analysisWindowMs: number; windowSeconds: number; hoveredPoint: ChartPoint | undefined; onHover: (time: number | null) => void; lowRatio: number; highRatio: number; onLowRatioChange: (value: number) => void; onHighRatioChange: (value: number) => void; powerMode: PowerMode; onDragStart: () => void; onDrop: () => void; onHide: () => void }) {
  const yUnit = config.id === 'rpm1' || config.id === 'rpm2' ? 'RPM' : config.id === 'shift' || config.id === 'efficiency' ? '%' : config.id === 'shiftRatio' ? 'Ratio' : ''
  const axisLabelStyle = { fill: '#8b8982', fontSize: 10 }
  const common = { data, margin: { top: 8, right: 14, left: 4, bottom: 14 } }
  const yDomain = config.id === 'shiftRatio' ? [0, 6] : config.id === 'efficiency' ? [0, 110] : undefined
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover
  const isRelationshipChart = config.id === 'scatter' || config.id === 'shiftEfficiency'
  const chartBodyRef = useRef<HTMLDivElement | null>(null)
  const crosshairRef = useRef<HTMLDivElement | null>(null)
  const crosshairHRef = useRef<HTMLDivElement | null>(null)
  const plotRectRef = useRef<DOMRect | null>(null)
  const bodyRectRef = useRef<DOMRect | null>(null)
  function measurePlotRect(chartBody: HTMLDivElement) {
    plotRectRef.current = chartBody.querySelector('.recharts-cartesian-grid-bg')?.getBoundingClientRect() ?? null
    bodyRectRef.current = chartBody.getBoundingClientRect()
  }
  useEffect(() => {
    const chartBody = chartBodyRef.current
    if (!chartBody) return
    measurePlotRect(chartBody)
    const observer = new ResizeObserver(() => measurePlotRect(chartBody))
    observer.observe(chartBody)
    return () => observer.disconnect()
  }, [])

  const finiteRpms = data.flatMap((point) => [point.rpm1, point.rpm2]).filter(Number.isFinite)
  const scatterMax = Math.max(10, ...finiteRpms) * 1.05
  const lowRatioLine = [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * lowRatio }]
  const highRatioLine = [{ rpm2: 0, rpm1: 0 }, { rpm2: scatterMax, rpm1: scatterMax * highRatio }]
  const relationshipXMax = config.id === 'scatter' ? scatterMax : 6
  const relationshipXMin = config.id === 'scatter' ? 0 : 0.5
  const relationshipYMax = config.id === 'scatter' ? scatterMax : 110
  function relationshipCoords(point: ChartPoint) {
    return config.id === 'scatter' ? { x: point.rpm2, y: point.rpm1 } : { x: point.shiftRatio, y: point.efficiency }
  }
  function handlePlotMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    if (!data.length) return
    const plotRect = plotRectRef.current
    if (!plotRect || plotRect.width <= 0) return
    if (!isRelationshipChart) {
      const fraction = clamp01((event.clientX - plotRect.left) / plotRect.width)
      const domainStart = data[0].seconds
      const domainEnd = data[data.length - 1].seconds
      const nearest = findNearestBySeconds(data, domainStart + fraction * (domainEnd - domainStart))
      if (nearest) onHoverRef.current(nearest.time)
      return
    }
    if (plotRect.height <= 0) return
    const fx = clamp01((event.clientX - plotRect.left) / plotRect.width)
    const fy = clamp01((event.clientY - plotRect.top) / plotRect.height)
    const targetX = config.id === 'scatter' ? fx * relationshipXMax : relationshipXMax - fx * (relationshipXMax - relationshipXMin)
    const targetY = (1 - fy) * relationshipYMax
    let nearest: ChartPoint | null = null
    let bestDist = Infinity
    for (const point of data) {
      const { x: px, y: py } = relationshipCoords(point)
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue
      const dx = (px - targetX) / (relationshipXMax || 1)
      const dy = (py - targetY) / (relationshipYMax || 1)
      const dist = dx * dx + dy * dy
      if (dist < bestDist) { bestDist = dist; nearest = point }
    }
    if (nearest) onHoverRef.current(nearest.time)
  }
  function handlePlotMouseLeave() { onHoverRef.current(null) }
  useLayoutEffect(() => {
    const crosshairV = crosshairRef.current
    const crosshairH = crosshairHRef.current
    const chartBody = chartBodyRef.current
    if (!crosshairV || !chartBody) return
    const hide = () => { crosshairV.style.display = 'none'; if (crosshairH) crosshairH.style.display = 'none' }
    if (!hoveredPoint) { hide(); return }
    const plotRect = plotRectRef.current
    const bodyRect = bodyRectRef.current
    if (!plotRect || !bodyRect || plotRect.width <= 0) { hide(); return }
    if (!isRelationshipChart) {
      if (data.length < 2) { hide(); return }
      const domainStart = data[0].seconds
      const domainEnd = data[data.length - 1].seconds
      const fraction = domainEnd > domainStart ? (hoveredPoint.seconds - domainStart) / (domainEnd - domainStart) : 0
      crosshairV.style.display = 'block'
      crosshairV.style.left = `${plotRect.left - bodyRect.left + clamp01(fraction) * plotRect.width}px`
      if (crosshairH) crosshairH.style.display = 'none'
      return
    }
    const { x: px, y: py } = relationshipCoords(hoveredPoint)
    if (!Number.isFinite(px) || !Number.isFinite(py) || plotRect.height <= 0) { hide(); return }
    const fx = config.id === 'scatter' ? px / relationshipXMax : (relationshipXMax - px) / (relationshipXMax - relationshipXMin)
    const fy = 1 - py / relationshipYMax
    crosshairV.style.display = 'block'
    crosshairV.style.left = `${plotRect.left - bodyRect.left + clamp01(fx) * plotRect.width}px`
    if (crosshairH) {
      crosshairH.style.display = 'block'
      crosshairH.style.top = `${plotRect.top - bodyRect.top + clamp01(fy) * plotRect.height}px`
    }
  }, [hoveredPoint, data, isRelationshipChart, config.id, relationshipXMax, relationshipXMin, relationshipYMax])

  const axis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={46} domain={yDomain} allowDataOverflow={yDomain !== undefined} label={{ value: yUnit, angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const finitePowers = data.flatMap((sample) => [sample.power1, sample.power2]).filter(Number.isFinite)
  const powerMinKw = Math.min(0, ...finitePowers) * 1.08
  const powerMaxKw = Math.max(1, ...finitePowers) * 1.08
  const powerAxis = <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="seconds" domain={['dataMin', 'dataMax']} tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} label={{ value: 'Time (s)', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={46} domain={[powerMinKw, powerMaxKw]} label={{ value: 'kW', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const relationshipAxis = config.id === 'scatter'
    ? <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="rpm2" name="Secondary" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Secondary RPM', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="rpm1" name="Primary" domain={[0, scatterMax]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: 'Primary RPM', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
    : <><CartesianGrid stroke="#e4dfd5" vertical={false} fill="transparent" /><XAxis type="number" dataKey="shiftRatio" name="Shift ratio" domain={[0.5, 6]} reversed allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} label={{ value: 'Shift ratio', position: 'insideBottom', offset: -6, style: axisLabelStyle }} /><YAxis type="number" dataKey="efficiency" name="Efficiency" domain={[0, 110]} allowDataOverflow tick={{ fill: '#8b8982', fontSize: 10 }} width={46} label={{ value: '%', angle: -90, position: 'insideLeft', style: axisLabelStyle }} /></>
  const lineProps = { isAnimationActive: false, animationDuration: 0, dot: false, activeDot: false, connectNulls: false }
  const rpmDot = (color: string) => ({ r: 1.6, fill: color, fillOpacity: 0.28, stroke: 'none' })
  const invalidSegments = useMemo(() => {
    if (powerMode !== 'inertia' || (config.id !== 'power' && config.id !== 'efficiency')) return []
    const segments: { start: number; end: number }[] = []
    let start: number | null = null
    data.forEach((point, index) => {
      if (!point.fullThrottle) {
        if (start === null) start = point.seconds
      } else if (start !== null) {
        segments.push({ start, end: data[index - 1].seconds })
        start = null
      }
    })
    if (start !== null && data.length) segments.push({ start, end: data[data.length - 1].seconds })
    return segments
  }, [data, config.id, powerMode])
  const efficiencyTrend = useMemo(() => {
    if (config.id !== 'shiftEfficiency') return []
    const valid = data.filter((point) => Number.isFinite(point.efficiency) && point.shiftRatio >= 0.5 && point.shiftRatio <= 6)
    const bins = 16
    const width = (6 - 0.5) / bins
    const result: { shiftRatio: number; efficiency: number }[] = []
    for (let bin = 0; bin < bins; bin += 1) {
      const low = 0.5 + bin * width
      const high = low + width
      const values = valid.filter((point) => point.shiftRatio >= low && point.shiftRatio < high).map((point) => point.efficiency).sort((a, b) => a - b)
      if (values.length < 2) continue
      const middle = Math.floor(values.length / 2)
      const median = values.length % 2 ? values[middle] : 0.5 * (values[middle - 1] + values[middle])
      result.push({ shiftRatio: 0.5 * (low + high), efficiency: median })
    }
    return result
  }, [config.id, data])

  const readout = (() => {
    if (!hoveredPoint) return null
    switch (config.id) {
      case 'rpm1': return `${hoveredPoint.rpm1.toFixed(2)} RPM`
      case 'rpm2': return `${hoveredPoint.rpm2.toFixed(2)} RPM`
      case 'shift': return `${hoveredPoint.shift.toFixed(2)}%`
      case 'power': return `Pri ${hoveredPoint.power1.toFixed(2)} kW / Sec ${hoveredPoint.power2.toFixed(2)} kW`
      case 'efficiency': return Number.isFinite(hoveredPoint.efficiency) ? `${hoveredPoint.efficiency.toFixed(2)}%` : 'Efficiency unavailable (not WOT / no positive output)'
      case 'shiftRatio': return hoveredPoint.shiftRatio.toFixed(3)
      case 'scatter': return `Sec ${hoveredPoint.rpm2.toFixed(2)} / Pri ${hoveredPoint.rpm1.toFixed(2)}`
      case 'shiftEfficiency': return Number.isFinite(hoveredPoint.efficiency) ? `Ratio ${hoveredPoint.shiftRatio.toFixed(2)} / Eff ${hoveredPoint.efficiency.toFixed(2)}%` : 'Efficiency unavailable'
      default: return null
    }
  })()

  const chart = useMemo(() => <ResponsiveContainer width="100%" height="100%"><LineChart {...common}>{config.id === 'power' ? powerAxis : isRelationshipChart ? relationshipAxis : axis}{invalidSegments.map((segment, index) => <ReferenceArea key={index} x1={segment.start} x2={segment.end} fill="rgba(80, 80, 80, 0.10)" stroke="none" ifOverflow="visible" />)}{config.id === 'scatter' && <><Line data={lowRatioLine} type="linear" dataKey="rpm1" stroke="#d8a227" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line data={highRatioLine} type="linear" dataKey="rpm1" stroke="#3c8f88" strokeWidth={2} strokeDasharray="1 5" {...lineProps} /><Line type="linear" dataKey="rpm1" stroke={config.color} strokeOpacity={0} {...lineProps} dot={{ r: 2.2, fill: config.color, stroke: 'none' }} /></>}{config.id === 'shiftEfficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="linear" dataKey="efficiency" stroke={config.color} strokeOpacity={0} {...lineProps} dot={{ r: 2.2, fill: config.color, fillOpacity: .55, stroke: 'none' }} /><Line data={efficiencyTrend} type="monotone" dataKey="efficiency" stroke={config.color} strokeWidth={2.3} {...lineProps} /></>}{config.id === 'rpm1' && <><Line data={primaryObservations} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={rpmDot(config.color)} /><Line type="monotone" dataKey="rpm1" name="Primary RPM" stroke={config.color} strokeWidth={2} {...lineProps} /></>}{config.id === 'rpm2' && <><Line data={secondaryObservations} type="linear" dataKey="rpm" stroke="transparent" {...lineProps} dot={rpmDot(config.color)} /><Line type="monotone" dataKey="rpm2" name="Secondary RPM" stroke={config.color} strokeWidth={2} {...lineProps} /></>}{config.id === 'shift' && <Line type="monotone" dataKey="shift" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'power' && <><Line type="monotone" dataKey="power1" name="Primary" stroke="#f05d3b" strokeWidth={2} {...lineProps} /><Line type="monotone" dataKey="power2" name="Secondary" stroke="#3c8f88" strokeWidth={2} {...lineProps} /></>}{config.id === 'efficiency' && <><ReferenceLine y={100} stroke="#d92b2b" strokeDasharray="4 4" strokeWidth={1.2} /><Line type="monotone" dataKey="efficiency" stroke={config.color} strokeWidth={2} {...lineProps} /></>}{config.id === 'shiftRatio' && <Line type="monotone" dataKey="shiftRatio" stroke={config.color} strokeWidth={2} {...lineProps} />}</LineChart></ResponsiveContainer>, [config, data, primaryObservations, secondaryObservations, lowRatio, highRatio, invalidSegments, efficiencyTrend, powerMode])

  const headerControls = config.id === 'scatter'
    ? <div className="chart-ratio-inputs"><label className="ratio-input" style={{ color: '#d8a227' }}><span>Low ratio</span><input type="number" step="0.01" min="0" value={lowRatio} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next) && next > 0) onLowRatioChange(next) }} /></label><label className="ratio-input" style={{ color: '#3c8f88' }}><span>High ratio</span><input type="number" step="0.01" min="0" value={highRatio} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next) && next > 0) onHighRatioChange(next) }} /></label></div>
    : null
  return <article className="chart-card" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><header className="chart-header"><div className="drag-handle" title="Drag to reorder" draggable onDragStart={onDragStart}><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div>{headerControls}<button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header><div className="chart-body" ref={chartBodyRef} onMouseMove={handlePlotMouseMove} onMouseLeave={handlePlotMouseLeave}>{chart}<div ref={crosshairRef} className="chart-crosshair-line" style={{ display: 'none' }} />{isRelationshipChart && <div ref={crosshairHRef} className="chart-crosshair-line-h" style={{ display: 'none' }} />}</div><div className="chart-footer"><span style={{ color: config.color }}>● {analysisWindowMs} ms</span>{readout && <span className="hover-readout">{readout}</span>}<span>{config.id === 'scatter' ? 'RPM / RPM' : config.id === 'efficiency' ? 'Percent' : config.id === 'power' ? 'kW' : config.id === 'shiftRatio' ? 'Ratio' : config.id === 'shiftEfficiency' ? 'Ratio / Percent' : `Visible: ${windowSeconds.toFixed(1)} s`}</span></div></article>
}


// Hoisted to module scope (rather than declared inside UsbConsolePanel, where it's also used) so
// it's available to the useState lazy initializers below, which run before any in-component
// `const` declarations further down the function body would be reachable.
const CONSOLE_TYPES: ConsoleType[] = ['RPM1', 'RPM2', 'SHIFT', 'TORQ1', 'TORQ2', 'READ CONFIG', 'RPM TEST', 'RPM COUNT TEST', 'TEXT', 'TX']

function UsbConsolePanel({ messages, showSensorData, autoScroll, customCommand, setCustomCommand, onToggleSensorData, onToggleAutoScroll, onClear, onSendCommand, onSendCustom, rpmPinTest, rpmInterruptTest, rpmCountTest, rpmPinStates, rpmCountStates, onToggleRpmPinTest, onToggleRpmInterruptTest, onToggleRpmCountTest }: { messages: ConsoleMessage[]; showSensorData: boolean; autoScroll: boolean; customCommand: string; setCustomCommand: (value: string) => void; onToggleSensorData: () => void; onToggleAutoScroll: () => void; onClear: () => void; onSendCommand: (bytes: Uint8Array, description?: string) => Promise<void>; onSendCustom: () => Promise<void>; rpmPinTest: boolean; rpmInterruptTest: boolean; rpmCountTest: boolean; rpmPinStates: [boolean | null, boolean | null]; rpmCountStates: [number | null, number | null]; onToggleRpmPinTest: () => Promise<void>; onToggleRpmInterruptTest: () => Promise<void>; onToggleRpmCountTest: () => Promise<void> }) {
  const [sortBy, setSortBy] = useState<ConsoleSort>('time')
  const [sortAscending, setSortAscending] = useState(false)
  // Defaults to ON (not persisted -- resets to on every load/reopen) so the console shows only the
  // latest message per type from the moment it's opened, rather than an unbounded, fast-scrolling
  // list -- especially important at high packet rates (per-tooth RPM streaming) where "one row per
  // packet" would otherwise mean thousands of rows accumulating almost instantly.
  const [globalStackByType, setGlobalStackByType] = useState(true)
  const [stackedTypes, setStackedTypes] = useState<Partial<Record<ConsoleType, boolean>>>(() => Object.fromEntries(CONSOLE_TYPES.map((type) => [type, true])))
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
  const types = CONSOLE_TYPES
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
  return <section className="serial-console serial-console-structured"><div className="console-toolbar"><div><span className="section-kicker">USB CONSOLE</span><h2>Command link</h2></div><div className="console-toolbar-actions"><button className={`button ${showSensorData ? 'button-accent' : 'button-quiet'}`} onClick={onToggleSensorData}>{showSensorData ? 'Hide sensor data' : 'Show sensor data'}</button><button className={`button ${autoScroll ? 'button-accent' : 'button-quiet'}`} onClick={onToggleAutoScroll}>{autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}</button><button className="button button-quiet" onClick={onClear}><Trash2 size={14} />Clear</button></div></div><div className="console-stack-controls"><button className={`button ${globalStackByType ? 'button-accent' : 'button-quiet'}`} onClick={toggleGlobalStackByType}>Stack latest by type</button></div><div className="console-grid"><div className="console-table-wrap"><table className="console-table"><thead><tr><th><button onClick={() => changeSort('time')}>Time {sortBy === 'time' && (sortAscending ? '↑' : '↓')}</button></th><th><button onClick={() => changeSort('type')}>Type {sortBy === 'type' && (sortAscending ? '↑' : '↓')}</button></th><th><button onClick={() => changeSort('data')}>Data {sortBy === 'data' && (sortAscending ? '↑' : '↓')}</button></th></tr></thead><tbody>{sortedMessages.length ? sortedMessages.map((message) => <tr key={message.id}><td>{message.time}</td><td><span className={`console-type-pill type-${message.type.toLowerCase().replaceAll(' ', '-')}`}>{message.type}</span></td><td>{message.data}</td></tr>) : <tr><td colSpan={3} className="console-empty">No USB messages yet. Connect the firmware or send a command.</td></tr>}</tbody></table></div><div className="console-controls"><span className="console-label">Firmware commands</span><div className="rpm-pin-status"><div className={`rpm-pin-card ${rpmPinStates[0] === null ? 'unknown' : rpmPinStates[0] ? 'is-high' : 'is-low'}`}><span>RPM1 / PIN 1</span><strong>{rpmPinStates[0] === null ? 'WAITING' : rpmPinStates[0] ? 'HIGH' : 'LOW'}</strong></div><div className={`rpm-pin-card ${rpmPinStates[1] === null ? 'unknown' : rpmPinStates[1] ? 'is-high' : 'is-low'}`}><span>RPM2 / PIN 3</span><strong>{rpmPinStates[1] === null ? 'WAITING' : rpmPinStates[1] ? 'HIGH' : 'LOW'}</strong></div></div><div className="rpm-pin-status"><div className={`rpm-pin-card ${rpmCountStates[0] === null ? 'unknown' : 'is-high'}`}><span>RPM1 count</span><strong>{rpmCountStates[0] === null ? 'WAITING' : rpmCountStates[0]}</strong></div><div className={`rpm-pin-card ${rpmCountStates[1] === null ? 'unknown' : 'is-high'}`}><span>RPM2 count</span><strong>{rpmCountStates[1] === null ? 'WAITING' : rpmCountStates[1]}</strong></div></div><button className="console-command" onClick={() => void onSendCommand(encodeCommand(3), 'Read configuration')}><span>Read configuration</span><code>03 00 00 00</code></button><button className="console-command" onClick={() => void onSendCommand(encodeCommand(4, 0, 1), 'Enable bench mode')}><span>Enable bench mode</span><code>04 00 00 01</code></button><button className="console-command" onClick={() => void onSendCommand(encodeCommand(4, 0, 0), 'Disable bench mode')}><span>Use real sensors</span><code>04 00 00 00</code></button><button className={`console-command ${rpmPinTest ? 'is-active' : ''}`} onClick={() => void onToggleRpmPinTest()}><span>{rpmPinTest ? 'Stop RPM pin test' : 'Start RPM pin test'}</span><code>05 00 00 0{rpmPinTest ? '0' : '1'}</code></button><button className={`console-command ${rpmInterruptTest ? 'is-active' : ''}`} onClick={() => void onToggleRpmInterruptTest()}><span>{rpmInterruptTest ? 'Stop interrupt test' : 'Start interrupt test'}</span><code>07 00 00 0{rpmInterruptTest ? '0' : '1'}</code></button><button className={`console-command ${rpmCountTest ? 'is-active' : ''}`} onClick={() => void onToggleRpmCountTest()}><span>{rpmCountTest ? 'Stop RPM count test' : 'Start RPM count test'}</span><code>08 00 00 0{rpmCountTest ? '0' : '1'}</code></button><label className="console-label" htmlFor="custom-command">Custom hex bytes</label><div className="custom-command"><input id="custom-command" value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void onSendCustom() }} /><button className="icon-button" title="Send custom bytes" onClick={() => void onSendCustom()}><Send size={16} /></button></div></div></div></section>
}

export default App