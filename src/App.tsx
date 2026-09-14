import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Cable, ChevronDown, CircleHelp, Download, Gauge, GripVertical, Send, SlidersHorizontal, Square, Terminal, Trash2, Usb, Wifi, X, RotateCcw } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { channelNames, csvHeader, deriveSample, encodeCommand, sampleToCsvRow, samplesToCsv, type ChannelId, type TelemetrySample } from './protocol'
import { SerialTransport } from './serialTransport'

type ChartId = 'scatter' | 'rpm1' | 'rpm2' | 'shift' | 'power' | 'efficiency'
type ChartConfig = { id: ChartId; title: string; subtitle: string; color: string; visible: boolean }
type RawValues = Pick<TelemetrySample, 'rpm1' | 'rpm2' | 'shift' | 'torq1' | 'torq2'>

const defaultCharts: ChartConfig[] = [
  { id: 'scatter', title: 'Primary vs secondary RPM', subtitle: 'Load transfer relationship', color: '#f05d3b', visible: true },
  { id: 'rpm1', title: 'Primary RPM', subtitle: 'Engine speed / time', color: '#d8a227', visible: true },
  { id: 'rpm2', title: 'Secondary RPM', subtitle: 'Output speed / time', color: '#3c8f88', visible: true },
  { id: 'shift', title: 'Shift position', subtitle: 'Actuator travel / time', color: '#b86b3a', visible: true },
  { id: 'power', title: 'Power output', subtitle: 'Primary and secondary / time', color: '#f05d3b', visible: true },
  { id: 'efficiency', title: 'Efficiency', subtitle: 'Secondary power / primary power', color: '#668b48', visible: true },
]

const emptyRaw: RawValues = { rpm1: 0, rpm2: 0, shift: 0, torq1: 0, torq2: 0 }
const SENSOR_RETENTION_MS = 30_000
const MAX_CONSOLE_MESSAGES = 500

function retainRecentSamples(history: TelemetrySample[], next: TelemetrySample): TelemetrySample[] {
  const cutoff = next.time - SENSOR_RETENTION_MS
  return [...history.filter((sample) => sample.time >= cutoff), next]
}

function makeDemoSample(index: number, torqueScale: number, torqueOffset: number): TelemetrySample {
  const phase = index / 10
  return deriveSample({ time: index * 100, rpm1: Math.round(3200 + Math.sin(phase) * 720 + index * 3), rpm2: Math.round(2200 + Math.sin(phase - 0.5) * 500 + index * 2), shift: Math.round(35 + Math.sin(phase * 0.45) * 20), torq1: Math.round(380 + Math.sin(phase * 0.8) * 90), torq2: Math.round(305 + Math.sin(phase * 0.8 - 0.3) * 76) }, torqueScale, torqueOffset)
}

function formatNumber(value: number, decimals = 0) { return value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) }

function App() {
  const [connected, setConnected] = useState(false)
  const [demoMode, setDemoMode] = useState(false)
  const [firmwareDemoMode, setFirmwareDemoMode] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleLines, setConsoleLines] = useState<string[]>([])
  const [showSensorConsole, setShowSensorConsole] = useState(true)
  const [autoScrollConsole, setAutoScrollConsole] = useState(true)
  const [customCommand, setCustomCommand] = useState('03 00 00 00')
  const [logging, setLogging] = useState(false)
  const [sessionName, setSessionName] = useState('baseline-pull')
  const [torqueScale, setTorqueScale] = useState(0.01)
  const [torqueOffset, setTorqueOffset] = useState(0)
  const [channels, setChannels] = useState([true, true, true, true, true])
  const [frequencies, setFrequencies] = useState([20, 20, 10, 50, 50])
  const [samples, setSamples] = useState<TelemetrySample[]>([])
  const [raw, setRaw] = useState<RawValues>(emptyRaw)
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
  const demoTimer = useRef<number | undefined>(undefined)
  const telemetryTimer = useRef<number | undefined>(undefined)
  const pendingRaw = useRef<RawValues>(emptyRaw)

  const current = samples[samples.length - 1] ?? deriveSample({ time: 0, ...raw }, torqueScale, torqueOffset)
  const chartData = useMemo(() => samples.slice(-72).map((sample) => ({ ...sample, seconds: sample.time / 1000 })), [samples])

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
    demoTimer.current = window.setInterval(() => { const next = makeDemoSample(index++, torqueScale, torqueOffset); setSamples((history) => retainRecentSamples(history, next)) }, 100)
    return () => window.clearInterval(demoTimer.current)
  }, [demoMode, connected, torqueScale, torqueOffset])
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
  function appendConsoleLines(linesToAdd: string[]) { setConsoleLines((lines) => [...lines, ...linesToAdd.map((line) => `${consoleTimestamp()} ${line}`)].slice(-MAX_CONSOLE_MESSAGES)) }
  function handleSerialText(text: string) {
    appendConsoleLines([`[RAW TEXT] ${text}`])
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
  function handleValue(channel: ChannelId, value: number) {
    const key = (['rpm1', 'rpm2', 'shift', 'torq1', 'torq2'] as const)[channel]
    pendingRaw.current = { ...pendingRaw.current, [key]: value }
    if (telemetryTimer.current !== undefined) return
    telemetryTimer.current = window.setTimeout(() => {
      telemetryTimer.current = undefined
      const next = pendingRaw.current
      setRaw(next)
      setSamples((history) => retainRecentSamples(history, deriveSample({ time: performance.timeOrigin + performance.now(), ...next }, torqueScale, torqueOffset)))
    }, 50)
  }
  async function sendConfig(channel: number, enabled: boolean, frequency: number) { if (transport.current) { await transport.current.send(encodeCommand(1, channel, enabled ? 1 : 0)); await transport.current.send(encodeCommand(2, channel, frequency)) } }
  function updateChannel(channel: number, enabled: boolean) { setChannels((previous) => previous.map((value, index) => index === channel ? enabled : value)); void sendConfig(channel, enabled, frequencies[channel]).catch(() => setNotice('Could not send channel configuration')) }
  function updateFrequency(channel: number, frequency: number) { setFrequencies((previous) => previous.map((value, index) => index === channel ? frequency : value)); void sendConfig(channel, channels[channel], frequency).catch(() => setNotice('Could not send frequency configuration')) }
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
    const visibleConsoleLines = showSensorConsole ? consoleLines : consoleLines.filter((line) => !line.includes('[RAW SENSOR]'))

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Activity size={20} /></div><div><span className="eyebrow">CVT DYNAMOMETER</span><h1>Live instrument</h1></div></div><div className="topbar-status"><span className={`status-dot ${connected ? 'is-live' : 'is-demo'}`} />{connected ? firmwareDemoMode ? 'Firmware bench mode' : 'Serial link active' : demoMode ? 'Browser demo stream' : 'Offline'}<span className="status-divider" /><span className="mono">{formatNumber(current.rpm1)} RPM</span></div><div className="top-actions"><button className="button button-quiet" onClick={() => setDemoMode((value) => !value)} title="Toggle browser demo telemetry"><Gauge size={16} />{demoMode ? 'Browser demo' : 'Demo off'}</button>{connected && <button className={`button ${firmwareDemoMode ? 'button-accent' : 'button-quiet'}`} onClick={() => void toggleFirmwareDemo()} title="Toggle synthetic data on the connected firmware"><Gauge size={16} />{firmwareDemoMode ? 'Bench on' : 'Bench mode'}</button>}<button className={`button ${consoleOpen ? 'button-dark' : 'button-quiet'}`} onClick={() => setConsoleOpen((value) => !value)}><Terminal size={16} />Console<ChevronDown size={14} className={consoleOpen ? 'icon-rotate' : ''} /></button>{connected ? <button className="button button-dark" onClick={() => void disconnect()}><Usb size={16} />Disconnect</button> : <button className="button button-accent" onClick={() => void connect()}><Cable size={16} />Connect device</button>}</div></header>
    {consoleOpen && <section className="serial-console"><div className="console-toolbar"><div><span className="section-kicker">SERIAL CONSOLE / 115200 BAUD</span><h2>Command link</h2></div><div className="console-toolbar-actions"><button className={`button ${showSensorConsole ? 'button-accent' : 'button-quiet'}`} onClick={() => setShowSensorConsole((value) => !value)}>{showSensorConsole ? 'Hide sensor data' : 'Show sensor data'}</button><button className={`button ${autoScrollConsole ? 'button-accent' : 'button-quiet'}`} onClick={() => setAutoScrollConsole((value) => !value)}>{autoScrollConsole ? 'Auto-scroll on' : 'Auto-scroll off'}</button><button className="button button-quiet" onClick={() => setConsoleLines([])}><Trash2 size={14} />Clear</button></div></div><div className="console-grid"><div className="console-output" ref={consoleOutputRef}>{consoleLines.length ? [...consoleLines].reverse().map((line, index) => <div key={`${line}-${index}`}>{line}</div>) : <span className="console-empty">No serial messages yet. Connect the firmware or send a command.</span>}</div><div className="console-controls"><span className="console-label">Firmware commands</span><button className="console-command" onClick={() => void sendRawCommand(encodeCommand(3), 'Read configuration')}><span>Read configuration</span><code>03 00 00 00</code></button><button className="console-command" onClick={() => void sendRawCommand(encodeCommand(4, 0, 1), 'Enable bench mode')}><span>Enable bench mode</span><code>04 00 00 01</code></button><button className="console-command" onClick={() => void sendRawCommand(encodeCommand(4, 0, 0), 'Disable bench mode')}><span>Use real sensors</span><code>04 00 00 00</code></button><label className="console-label" htmlFor="custom-command">Custom hex bytes</label><div className="custom-command"><input id="custom-command" value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendCustomCommand() }} /><button className="icon-button" title="Send custom bytes" onClick={() => void sendCustomCommand()}><Send size={16} /></button></div></div></div></section>}
      {consoleOpen && <section className="serial-console"><div className="console-toolbar"><div><span className="section-kicker">SERIAL CONSOLE / 115200 BAUD</span><h2>Command link</h2></div><div className="console-toolbar-actions"><button className={`button ${showSensorConsole ? 'button-accent' : 'button-quiet'}`} onClick={() => setShowSensorConsole((value) => !value)}>{showSensorConsole ? 'Hide sensor data' : 'Show sensor data'}</button><button className={`button ${autoScrollConsole ? 'button-accent' : 'button-quiet'}`} onClick={() => setAutoScrollConsole((value) => !value)}>{autoScrollConsole ? 'Auto-scroll on' : 'Auto-scroll off'}</button><button className="button button-quiet" onClick={() => setConsoleLines([])}><Trash2 size={14} />Clear</button></div></div><div className="console-grid"><div className="console-output" ref={consoleOutputRef}>{visibleConsoleLines.length ? [...visibleConsoleLines].reverse().map((line, index) => <div key={`${line}-${index}`}>{line}</div>) : <span className="console-empty">No serial messages yet. Connect the firmware or send a command.</span>}</div><div className="console-controls"><span className="console-label">Firmware commands</span><button className="console-command" onClick={() => void sendRawCommand(encodeCommand(3), 'Read configuration')}><span>Read configuration</span><code>03 00 00 00</code></button><button className="console-command" onClick={() => void sendRawCommand(encodeCommand(4, 0, 1), 'Enable bench mode')}><span>Enable bench mode</span><code>04 00 00 01</code></button><button className="console-command" onClick={() => void sendRawCommand(encodeCommand(4, 0, 0), 'Disable bench mode')}><span>Use real sensors</span><code>04 00 00 00</code></button><label className="console-label" htmlFor="custom-command">Custom hex bytes</label><div className="custom-command"><input id="custom-command" value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void sendCustomCommand() }} /><button className="icon-button" title="Send custom bytes" onClick={() => void sendCustomCommand()}><Send size={16} /></button></div></div></div></section>}
    <section className="command-deck"><div className="deck-heading"><span className="section-kicker">01 / CONTROL ROOM</span><h2>Run configuration</h2><p>{notice}</p></div><div className="control-group"><label htmlFor="session">Session name</label><input id="session" value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></div><div className="control-group compact"><label htmlFor="scale">Torque scale</label><div className="input-with-unit"><input id="scale" type="number" step="0.001" value={torqueScale} onChange={(event) => setTorqueScale(Number(event.target.value))} /><span>N m/count</span></div></div><div className="control-group compact"><label htmlFor="offset">Torque zero</label><div className="input-with-unit"><input id="offset" type="number" value={torqueOffset} onChange={(event) => setTorqueOffset(Number(event.target.value))} /><span>count</span></div></div><div className="deck-actions"><button className={`button button-log ${logging ? 'is-recording' : ''}`} onClick={() => void (logging ? stopLogging() : startLogging())}>{logging ? <Square size={14} fill="currentColor" /> : <CircleHelp size={14} />}{logging ? `Logging ${logFileName.current}` : 'Start log'}</button><button className="button button-quiet" onClick={() => void chooseDirectory()} title="Grant Chrome permission to write logs directly">{directoryName === 'Browser download' ? 'Grant folder access' : directoryName}</button><button className="icon-button" title="Download CSV" onClick={() => void downloadCsv()}><Download size={17} /></button><button className="icon-button" title="Clear session" onClick={() => { setSamples([]); setNotice('Session buffer cleared') }}><Trash2 size={17} /></button></div></section>
    <section className="channel-strip"><div className="strip-label"><SlidersHorizontal size={17} /><span>Telemetry channels</span></div>{channelNames.map((name, index) => <div className="channel-control" key={name}><button className={`channel-toggle ${channels[index] ? 'enabled' : ''}`} onClick={() => updateChannel(index, !channels[index])}>{channels[index] ? 'ON' : 'OFF'}</button><span>{name.replace('Primary ', 'PRI ').replace('Secondary ', 'SEC ')}</span><select value={frequencies[index]} onChange={(event) => updateFrequency(index, Number(event.target.value))}><option value="10">10 Hz</option><option value="20">20 Hz</option><option value="50">50 Hz</option></select></div>)}</section>
    <section className="metric-grid">{[['Primary RPM', current.rpm1, 'rpm'], ['Secondary RPM', current.rpm2, 'rpm'], ['Shift position', current.shift, '%'], ['Primary power', current.power1, 'kW'], ['Secondary power', current.power2, 'kW'], ['Efficiency', current.efficiency, '%']].map(([label, value, unit], index) => <article className="metric" key={label as string}><span className="metric-index">0{index + 1}</span><span className="metric-label">{label as string}</span><strong>{formatNumber(value as number, unit === 'kW' || unit === '%' ? 1 : 0)}</strong><span className="metric-unit">{unit as string}</span></article>)}</section>
    <section className="workspace-heading"><div><span className="section-kicker">02 / LIVE TELEMETRY</span><h2>Analysis workspace</h2></div><div className="workspace-tools"><span><span className="status-dot is-live" />{samples.length.toLocaleString()} samples buffered</span><button className="button button-quiet" onClick={() => setCharts(defaultCharts)}><RotateCcw size={15} />Reset layout</button></div></section>
    <section className="chart-grid">{charts.filter((chart) => chart.visible).map((chart) => <ChartCard key={chart.id} config={chart} data={chartData} onDragStart={() => setDragged(chart.id)} onDrop={() => reorder(chart.id)} onHide={() => setCharts((items) => items.map((item) => item.id === chart.id ? { ...item, visible: false } : item))} />)}</section>
    <footer className="footer"><span><Wifi size={14} /> Browser serial requires Chromium</span><span className="mono">CVT / {sessionName || 'untitled'} / {new Date().toLocaleTimeString()}</span></footer>
  </main>
}

function ChartCard({ config, data, onDragStart, onDrop, onHide }: { config: ChartConfig; data: (TelemetrySample & { seconds: number })[]; onDragStart: () => void; onDrop: () => void; onHide: () => void }) {
  const common = { data, margin: { top: 8, right: 14, left: -18, bottom: 0 } }
  const axis = <><CartesianGrid stroke="#e4dfd5" vertical={false} /><XAxis dataKey="seconds" tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} tickFormatter={(value) => `${value}s`} /><YAxis tickLine={false} axisLine={false} tick={{ fill: '#8b8982', fontSize: 10 }} width={42} /><Tooltip contentStyle={{ border: '1px solid #ded8cc', borderRadius: 2, fontSize: 12, background: '#fffdf8' }} /></>
  const lineProps = { isAnimationActive: false, animationDuration: 0, dot: { r: 2, strokeWidth: 0 }, activeDot: { r: 3 } }
  const chart = config.id === 'scatter' ? <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={common.margin}><CartesianGrid stroke="#e4dfd5" /><XAxis type="number" dataKey="rpm1" name="Primary" tick={{ fill: '#8b8982', fontSize: 10 }} /><YAxis type="number" dataKey="rpm2" name="Secondary" tick={{ fill: '#8b8982', fontSize: 10 }} /><Tooltip cursor={{ strokeDasharray: '3 3' }} /><Scatter data={data} fill={config.color} isAnimationActive={false} /></ScatterChart></ResponsiveContainer> : <ResponsiveContainer width="100%" height="100%"><LineChart {...common}>{axis}{config.id === 'rpm1' && <Line type="monotone" dataKey="rpm1" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'rpm2' && <Line type="monotone" dataKey="rpm2" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'shift' && <Line type="monotone" dataKey="shift" stroke={config.color} strokeWidth={2} {...lineProps} />}{config.id === 'power' && <><Line type="monotone" dataKey="power1" stroke="#f05d3b" strokeWidth={2} {...lineProps} /><Line type="monotone" dataKey="power2" stroke="#3c8f88" strokeWidth={2} {...lineProps} /></>}{config.id === 'efficiency' && <Line type="monotone" dataKey="efficiency" stroke={config.color} strokeWidth={2} {...lineProps} />}</LineChart></ResponsiveContainer>
  return <article className={`chart-card ${config.id === 'scatter' ? 'chart-wide' : ''}`} draggable onDragStart={onDragStart} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><header className="chart-header"><div className="drag-handle" title="Drag to reorder"><GripVertical size={16} /></div><div className="chart-title"><h3>{config.title}</h3><span>{config.subtitle}</span></div><button className="chart-menu" onClick={onHide} title="Hide chart"><X size={15} /></button></header><div className="chart-body">{chart}</div><div className="chart-footer"><span style={{ color: config.color }}>● LIVE</span><span>{config.id === 'scatter' ? 'RPM / RPM' : config.id === 'efficiency' ? 'Percent' : 'Time window: 12.0 s'}</span></div></article>
}

export default App