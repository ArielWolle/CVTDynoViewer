import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Cable, ChevronDown, CircleHelp, Download, Gauge, GripVertical, Send, SlidersHorizontal, Square, Terminal, Trash2, Usb, Wifi, X, RotateCcw } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { channelNames, csvHeader, deriveSample, encodeCommand, sampleToCsvRow, samplesToCsv, type ChannelId, type PowerMode, type TelemetrySample } from './protocol'
import { SerialTransport } from './serialTransport'

type ChartId = 'scatter' | 'rpm1' | 'rpm2' | 'shift' | 'power' | 'efficiency'
type ChartConfig = { id: ChartId; title: string; subtitle: string; color: string; visible: boolean }
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
]

const emptyRaw: RawValues = { rpm1: 0, rpm2: 0, shift: 0, torq1: 0, torq2: 0 }
const SENSOR_RETENTION_MS = 300_000
const DEFAULT_CHART_WINDOW_MS = 240_000
const CHART_WINDOW_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 60_000, label: '1 min' },
  { value: 120_000, label: '2 min' },
  { value: 240_000, label: '4 min' },
  { value: 300_000, label: '5 min' },
]
const MAX_CONSOLE_MESSAGES = 500

function retainRecentSamples(history: TelemetrySample[], next: TelemetrySample): TelemetrySample[] {
  const cutoff = next.time - SENSOR_RETENTION_MS
  return [...history.filter((sample) => sample.time >= cutoff), next]
}

function makeDemoSample(index: number, torqueScale: number, torqueOffset: number, powerMode: PowerMode = 'torque', previous?: TelemetrySample): TelemetrySample {
  const phase = index / 10
  const values = { time: index * 100, rpm1: Math.round(3200 + Math.sin(phase) * 720 + index * 3), rpm2: Math.round(2200 + Math.sin(phase - 0.5) * 500 + index * 2), shift: Math.round(35 + Math.sin(phase * 0.45) * 20), torq1: Math.round(380 + Math.sin(phase * 0.8) * 90), torq2: Math.round(305 + Math.sin(phase * 0.8 - 0.3) * 76) }
  return deriveSample(values, torqueScale, torqueOffset, powerMode, previous)
}

function formatNumber(value: number, decimals = 0) { return value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) }

function App() {
  const [connected, setConnected] = useState(false)
  const [demoMode, setDemoMode] = useState(false)
  const [firmwareDemoMode, setFirmwareDemoMode] = useState(false)
  const [powerMode, setPowerMode] = useState<PowerMode>('torque')
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
  const [samples, setSamples] = useState<TelemetrySample[]>([])
  const [raw, setRaw] = useState<RawValues>(emptyRaw)
  const [chartWindowMs, setChartWindowMs] = useState(DEFAULT_CHART_WINDOW_MS)
  const [charts, setCharts] = useState<ChartConfig[]>(() => { try { return JSON.parse(localStorage.getItem('cvt-dyno-layout') ?? 'null') ?? defaultCharts } catch { return defaultCharts } })
  const [dragged, setDragged] = useState<ChartId | null>(null)
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

  const current = samples[samples.length - 1] ?? deriveSample({ time: 0, ...raw }, torqueScale, torqueOffset, powerMode)
  const chartData = useMemo(() => {
    if (!samples.length) return []
    const cutoff = samples[samples.length - 1].time - chartWindowMs
    return samples.filter((sample) => sample.time >= cutoff).map((sample) => ({ ...sample, seconds: sample.time / 1000 }))
  }, [samples, chartWindowMs])
  const scatterChartData = useMemo(() => {
    if (!samples.length) return []
    const cutoff = samples[samples.length - 1].time - chartWindowMs
    return samples.filter((sample) => sample.time >= cutoff).map((sample) => ({ ...sample, seconds: sample.time / 1000 }))
  }, [samples, chartWindowMs])

  useEffect(() => { localStorage.setItem('cvt-dyno-layout', JSON.stringify(charts)) }, [charts])
  useEffect(() => {
    if (!logging || !logWriter.current) return
    const newSamples = samples.filter((sample) => lastLoggedSampleTime.current === null || sample.time > lastLoggedSampleTime.current)
    if (!newSamples.length) return
    const rows = newSamples.map(sampleToCsvRow).join('\n') + '\n'
    lastLoggedSampleTime.current = newSamples[newSamples.length - 1].time
    pendingLogRows.current += rows
    if (logCommitTimer.current === undefined) logCommitTimer.current = window.setTimeout(() => { logCommitTimer.current = undefined; void commitLog(true) }, 500)
  }, [logging, samples])
  useEffect(() => {
    if (autoScrollConsole && consoleOutputRef.current) consoleOutputRef.current.scrollTop = 0
  }, [autoScrollConsole, consoleLines])
  useEffect(() => {
    if (!demoMode || connected) return
    let index = 80
    demoTimer.current = window.setInterval(() => {
      setSamples((history) => {
        const previous = history[history.length - 1] ?? undefined
        const next = makeDemoSample(index++, torqueScale, torqueOffset, powerMode, previous)
        return retainRecentSamples(history, next)
      })
    }, 100)
    return () => window.clearInterval(demoTimer.current)
  }, [demoMode, connected, torqueScale, torqueOffset, powerMode])
  useEffect(() => () => { window.clearTimeout(telemetryTimer.current); window.clearTimeout(logCommitTimer.current); void commitLog(false); void transport.current?.disconnect() }, [])

  async function connect() {
    try {
      const next = new SerialTransport({ onValue: handleValue, onPacket: handleSerialPacket, onText: handleSerialText })
      await next.connect(); transport.current = next; setConnected(true); setDemoMode(false); setFirmwareDemoMode(false); setSamples([]); setRaw(emptyRaw); pendingRaw.current = emptyRaw; setNotice('Reading dyno configuration...'); await next.send(encodeCommand(3))
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
    const key = (['rpm1', 'rpm2', 'shift', 'torq1', 'torq2'] as const)[channel]
    pendingRaw.current = { ...pendingRaw.current, [key]: value }
    if (telemetryTimer.current !== undefined) return
    telemetryTimer.current = window.setTimeout(() => {
      telemetryTimer.current = undefined
      const next = pendingRaw.current
      setSamples((history) => {
        const previous = history[history.length - 1] ?? undefined
        const sample = deriveSample({ time: performance.timeOrigin + performance.now(), ...next }, torqueScale, torqueOffset, powerMode, previous)
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
  async function downloadCsv() {
    const csv = samplesToCsv(samples)
    if (directoryHandle.current) {
      const file = await directoryHandle.current.getFileHandle(`${sessionName || 'cvt-dyno-session'}.csv`, { create: true })
      const writable = await file.createWritable(); await writable.write(csv); await writable.close()
      setNotice(`Saved ${samples.length.toLocaleString()} samples to ${directoryHandle.current.name}`)
      return
    }
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${sessionName || 'cvt-dyno-session'}.csv`; anchor.click(); URL.revokeObjectURL(url); setNotice(`Downloaded ${samples.length.toLocaleString()} samples`)
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
  function reorder(target: ChartId) { if (!dragged || dragged === target) return; const from = charts.findIndex((chart) => chart.id === dragged); const to = charts.findIndex((chart) => chart.id === target); const next = [...charts]; const [item] = next.splice(from, 1); next.splice(to, 0, item); setCharts(next); setDragged(null) }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Activity size={20} /></div><div><span className="eyebrow">CVT DYNAMOMETER</span><h1>Live instrument</h1></div></div><div className="topbar-status"><span className={`status-dot ${connected ? 'is-live' : 'is-demo'}`} />{connected ? firmwareDemoMode ? 'Firmware bench mode' : 'Serial link active' : demoMode ? 'Browser demo stream' : 'Offline'}<span className="status-divider" /><span className="mono">{formatNumber(current.rpm1)} RPM</span></div><div className="top-actions"><button className="button button-quiet" onClick={() => setDemoMode((value) => !value)} title="Toggle browser demo telemetry"><Gauge size={16} />{demoMode ? 'Browser demo' : 'Demo off'}</button>{connected && <button className={`button ${firmwareDemoMode ? 'button-accent' : 'button-quiet'}`} onClick={() => void toggleFirmwareDemo()} title="Toggle synthetic data on the connected firmware"><Gauge size={16} />{firmwareDemoMode ? 'Bench on' : 'Bench mode'}</button>}<button className={`button ${consoleOpen ? 'button-dark' : 'button-quiet'}`} onClick={() => setConsoleOpen((value) => !value)}><Terminal size={16} />Console<ChevronDown size={14} className={consoleOpen ? 'icon-rotate' : ''} /></button>{connected ? <button className="button button-dark" onClick={() => void disconnect()}><Usb size={16} />Disconnect</button> : <button className="button button-accent" onClick={() => void connect()}><Cable size={16} />Connect device</button>}</div></header>
    {consoleOpen && <SerialConsolePanel messages={consoleMessages} showSensorData={showSensorConsole} autoScroll={autoScrollConsole} customCommand={customCommand} setCustomCommand={setCustomCommand} onToggleSensorData={() => setShowSensorConsole((value) => !value)} onToggleAutoScroll={() => setAutoScrollConsole((value) => !value)} onClear={() => { setConsoleLines([]); setConsoleMessages([]) }} onSendCommand={sendRawCommand} onSendCustom={sendCustomCommand} rpmPinTest={rpmPinTest} rpmInterruptTest={rpmInterruptTest} rpmCountTest={rpmCountTest} rpmPinStates={rpmPinStates} rpmCountStates={rpmCountStates} onToggleRpmPinTest={toggleRpmPinTest} onToggleRpmInterruptTest={toggleRpmInterruptTest} onToggleRpmCountTest={toggleRpmCountTest} />}
    <section className="command-deck"><div className="deck-heading"><span className="section-kicker">01 / CONTROL ROOM</span><h2>Run configuration</h2><p>{notice}</p></div><div className="control-group"><label htmlFor="session">Session name</label><input id="session" value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></div><div className="control-group compact"><label htmlFor="scale">Torque scale</label><div className="input-with-unit"><input id="scale" type="number" step="0.001" value={torqueScale} onChange={(event) => setTorqueScale(Number(event.target.value))} /><span>N m/count</span></div></div><div className="control-group compact"><label htmlFor="offset">Torque zero</label><div className="input-with-unit"><input id="offset" type="number" value={torqueOffset} onChange={(event) => setTorqueOffset(Number(event.target.value))} /><span>count</span></div></div><div className="control-group compact"><label htmlFor="power-mode">Power mode</label><select id="power-mode" value={powerMode} onChange={(event) => setPowerMode(event.target.value as PowerMode)}><option value="torque">Torque conversion</option><option value="inertia">Power estimation / inertia mode</option></select></div>
        <div className="deck-actions"><button className={`button button-log ${logging ? 'is-recording' : ''}`} onClick={() => void (logging ? stopLogging() : startLogging())}>{logging ? <Square size={14} fill="currentColor" /> : <CircleHelp size={14} />}{logging ? `Logging ${logFileName.current}` : 'Start log'}</button><button className="button button-quiet" onClick={() => void chooseDirectory()} title="Grant Chrome permission to write logs directly">{directoryName === 'Browser download' ? 'Grant folder access' : directoryName}</button><button className="icon-button" title="Download CSV" onClick={() => void downloadCsv()}><Download size={17} /></button><button className="icon-button" title="Clear session" onClick={() => { setSamples([]); setNotice('Session buffer cleared') }}><Trash2 size={17} /></button></div></section>
    <section className="channel-strip"><div className="strip-label"><SlidersHorizontal size={17} /><span>Telemetry channels</span></div>{channelNames.map((name, index) => <div className="channel-control" key={name}><button className={`channel-toggle ${channels[index] ? 'enabled' : ''}`} onClick={() => updateChannel(index, !channels[index])}>{channels[index] ? 'ON' : 'OFF'}</button><span>{name.replace('Primary ', 'PRI ').replace('Secondary ', 'SEC ')}</span><select value={frequencies[index]} onChange={(event) => updateFrequency(index, Number(event.target.value))}><option value="10">10 Hz</option><option value="20">20 Hz</option><option value="50">50 Hz</option></select></div>)}</section>
    <section className="channel-strip"><div className="strip-label"><Gauge size={17} /><span>RPM wheel teeth / spokes</span></div><div className="channel-control"><span>Primary wheel teeth</span><input type="number" min="1" max="999" value={primarySpokes} onChange={(event) => updateSpokes(0, Number(event.target.value))} /></div><div className="channel-control"><span>Secondary wheel teeth</span><input type="number" min="1" max="999" value={secondarySpokes} onChange={(event) => updateSpokes(1, Number(event.target.value))} /></div></section>
    <section className="metric-grid">{[['Primary RPM', current.rpm1, 'rpm'], ['Secondary RPM', current.rpm2, 'rpm'], ['Shift position', current.shift, '%'], ['Primary power', current.power1, 'kW'], ['Secondary power', current.power2, 'kW'], ['Efficiency', current.efficiency, '%']].map(([label, value, unit], index) => <article className="metric" key={label as string}><span className="metric-index">0{index + 1}</span><span className="metric-label">{label as string}</span><strong>{formatNumber(value as number, unit === 'kW' || unit === '%' ? 1 : 0)}</strong><span className="metric-unit">{unit as string}</span></article>)}</section>
    <section className="workspace-heading"><div><span className="section-kicker">02 / LIVE TELEMETRY</span><h2>Analysis workspace</h2></div><div className="workspace-tools"><span><span className="status-dot is-live" />{samples.length.toLocaleString()} samples buffered</span><button className="button button-quiet" onClick={() => setCharts(defaultCharts)}><RotateCcw size={15} />Reset layout</button></div></section>
    <section className="chart-grid">{charts.filter((chart) => chart.visible).map((chart) => <ChartCard key={chart.id} config={chart} data={chartData} scatterData={scatterChartData} chartWindowMs={chartWindowMs} onChartWindowChange={setChartWindowMs} onDragStart={() => setDragged(chart.id)} onDrop={() => reorder(chart.id)} onHide={() => setCharts((items) => items.map((item) => item.id === chart.id ? { ...item, visible: false } : item))} />)}</section>
    <footer className="footer"><span><Wifi size={14} /> Browser serial requires Chromium</span><span className="mono">CVT / {sessionName || 'untitled'} / {new Date().toLocaleTimeString()}</span></footer>
  </main>
}

function ChartCard({ config, data, scatterData, chartWindowMs, onChartWindowChange, onDragStart, onDrop, onHide }: { config: ChartConfig; data: (TelemetrySample & { seconds: number })[]; scatterData: (TelemetrySample & { seconds: number })[]; chartWindowMs: number; onChartWindowChange: (value: number) => void; onDragStart: () => void; onDrop: () => void; onHide: () => void }) {
  const common = { data, margin: { top: 8, right: 14, left: -18, bottom: 0 } }
  const axis = <><CartesianGrid stroke="#e4dfd5" vertical={false} /><XAxis dataKey="seconds" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={42} /><Tooltip contentStyle={{ border: '1px solid #ded8cc', borderRadius: 2, fontSize: 12, background: '#fffdf8' }} /></>
  const lineProps = { isAnimationActive: false, animationDuration: 0, dot: { r: 2, strokeWidth: 0 }, activeDot: { r: 3 } }
  const chart = config.id === 'scatter' ? <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={common.margin}><CartesianGrid stroke="#e4dfd5" /><XAxis type="number" dataKey="rpm2" name="Secondary" tick={{ fill: '#8b8982', fontSize: 10 }} /><YAxis type="number" dataKey="rpm1" name="Primary" tick={{ fill: '#8b8982', fontSize: 10 }} /><Tooltip cursor={{ strokeDasharray: '3 3' }} /><Scatter data={scatterData} fill={config.color} isAnimationActive={false} /></ScatterChart></ResponsiveContainer> : <ResponsiveContainer width="100%" height="100%"><LineChart {...common}>{axis}{config.id === 'rpm1' && <Line type="monotone" dataKey="rpm1" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'rpm2' && <Line type="monotone" dataKey="rpm2" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'shift' && <Line type="monotone" dataKey="shift" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'power' && <><Line type="monotone" dataKey="power1" stroke="#f05d3b" strokeWidth={2} {...lineProps} /><Line type="monotone" dataKey="power2" stroke="#3c8f88" strokeWidth={2} {...lineProps} /></>}{config.id === 'efficiency' && <Line type="monotone" dataKey="efficiency" stroke={config.color} strokeWidth={2} {...lineProps} />}</LineChart></ResponsiveContainer>
  return <article className={`chart-card ${config.id === 'scatter' ? 'chart-wide' : ''}`} draggable onDragStart={onDragStart} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><header className="chart-header"><div className="drag-handle" title="Drag to reorder"><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div><select aria-label="Chart time window" value={chartWindowMs} onChange={(event) => onChartWindowChange(Number(event.target.value))}>{CHART_WINDOW_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header><div className="chart-body">{chart}</div><div className="chart-footer"><span style={{ color: config.color }}>● LIVE</span><span>{config.id === 'scatter' ? 'RPM / RPM' : config.id === 'efficiency' ? 'Percent' : 'Time window: 12.0 s'}</span></div></article>
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