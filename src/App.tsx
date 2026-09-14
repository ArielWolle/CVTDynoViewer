import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Cable, CircleHelp, Download, Gauge, GripVertical, SlidersHorizontal, Square, Trash2, Usb, Wifi, X, RotateCcw } from 'lucide-react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts'
import { channelNames, deriveSample, encodeCommand, samplesToCsv, type ChannelId, type TelemetrySample } from './protocol'
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

function makeDemoSample(index: number, torqueScale: number, torqueOffset: number): TelemetrySample {
  const phase = index / 10
  return deriveSample({ time: index * 100, rpm1: Math.round(3200 + Math.sin(phase) * 720 + index * 3), rpm2: Math.round(2200 + Math.sin(phase - 0.5) * 500 + index * 2), shift: Math.round(35 + Math.sin(phase * 0.45) * 20), torq1: Math.round(380 + Math.sin(phase * 0.8) * 90), torq2: Math.round(305 + Math.sin(phase * 0.8 - 0.3) * 76) }, torqueScale, torqueOffset)
}

function formatNumber(value: number, decimals = 0) { return value.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals }) }

function App() {
  const [connected, setConnected] = useState(false)
  const [demoMode, setDemoMode] = useState(true)
  const [logging, setLogging] = useState(false)
  const [sessionName, setSessionName] = useState('baseline-pull')
  const [torqueScale, setTorqueScale] = useState(0.01)
  const [torqueOffset, setTorqueOffset] = useState(0)
  const [channels, setChannels] = useState([true, true, true, true, true])
  const [frequencies, setFrequencies] = useState([20, 20, 10, 50, 50])
  const [samples, setSamples] = useState<TelemetrySample[]>(() => Array.from({ length: 80 }, (_, index) => makeDemoSample(index, 0.01, 0)))
  const [raw, setRaw] = useState<RawValues>(emptyRaw)
  const [charts, setCharts] = useState<ChartConfig[]>(() => { try { return JSON.parse(localStorage.getItem('cvt-dyno-layout') ?? 'null') ?? defaultCharts } catch { return defaultCharts } })
  const [dragged, setDragged] = useState<ChartId | null>(null)
  const [notice, setNotice] = useState('Demo telemetry is flowing')
  const [directoryName, setDirectoryName] = useState('Browser download')
  const transport = useRef<SerialTransport | null>(null)
  const directoryHandle = useRef<FileSystemDirectoryHandle | null>(null)
  const demoTimer = useRef<number | undefined>(undefined)
  const telemetryTimer = useRef<number | undefined>(undefined)
  const pendingRaw = useRef<RawValues>(emptyRaw)

  const current = samples[samples.length - 1] ?? deriveSample({ time: 0, ...raw }, torqueScale, torqueOffset)
  const chartData = useMemo(() => samples.slice(-72).map((sample) => ({ ...sample, seconds: sample.time / 1000 })), [samples])

  useEffect(() => { localStorage.setItem('cvt-dyno-layout', JSON.stringify(charts)) }, [charts])
  useEffect(() => {
    if (!demoMode || connected) return
    let index = 80
    demoTimer.current = window.setInterval(() => { const next = makeDemoSample(index++, torqueScale, torqueOffset); setSamples((history) => [...history.slice(-499), next]) }, 100)
    return () => window.clearInterval(demoTimer.current)
  }, [demoMode, connected, torqueScale, torqueOffset])
  useEffect(() => () => { window.clearTimeout(telemetryTimer.current); void transport.current?.disconnect() }, [])

  async function connect() {
    try {
      const next = new SerialTransport({ onValue: handleValue, onText: setNotice })
      await next.connect(); transport.current = next; setConnected(true); setDemoMode(false); setNotice('Connected at 115200 baud')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not connect to serial device') }
  }
  async function disconnect() { await transport.current?.disconnect(); transport.current = null; setConnected(false); setNotice('Device disconnected') }
  function handleValue(channel: ChannelId, value: number) {
    const key = (['rpm1', 'rpm2', 'shift', 'torq1', 'torq2'] as const)[channel]
    pendingRaw.current = { ...pendingRaw.current, [key]: value }
    if (telemetryTimer.current !== undefined) return
    telemetryTimer.current = window.setTimeout(() => {
      telemetryTimer.current = undefined
      const next = pendingRaw.current
      setRaw(next)
      setSamples((history) => [...history.slice(-499), deriveSample({ time: performance.timeOrigin + performance.now(), ...next }, torqueScale, torqueOffset)])
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
  async function chooseDirectory() { if (!navigator.showDirectoryPicker) { setNotice('Folder access is unavailable; CSV download remains available'); return } try { directoryHandle.current = await navigator.showDirectoryPicker(); setDirectoryName(directoryHandle.current.name); setNotice(`Logging folder: ${directoryHandle.current.name}`) } catch { setNotice('Folder selection cancelled') } }
  function reorder(target: ChartId) { if (!dragged || dragged === target) return; const from = charts.findIndex((chart) => chart.id === dragged); const to = charts.findIndex((chart) => chart.id === target); const next = [...charts]; const [item] = next.splice(from, 1); next.splice(to, 0, item); setCharts(next); setDragged(null) }

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><div className="brand-mark"><Activity size={20} /></div><div><span className="eyebrow">CVT DYNAMOMETER</span><h1>Live instrument</h1></div></div><div className="topbar-status"><span className={`status-dot ${connected ? 'is-live' : 'is-demo'}`} />{connected ? 'Serial link active' : demoMode ? 'Demo stream' : 'Offline'}<span className="status-divider" /><span className="mono">{formatNumber(current.rpm1)} RPM</span></div><div className="top-actions"><button className="button button-quiet" onClick={() => setDemoMode((value) => !value)} title="Toggle demo telemetry"><Gauge size={16} />{demoMode ? 'Demo on' : 'Demo off'}</button>{connected ? <button className="button button-dark" onClick={() => void disconnect()}><Usb size={16} />Disconnect</button> : <button className="button button-accent" onClick={() => void connect()}><Cable size={16} />Connect device</button>}</div></header>
    <section className="command-deck"><div className="deck-heading"><span className="section-kicker">01 / CONTROL ROOM</span><h2>Run configuration</h2><p>{notice}</p></div><div className="control-group"><label htmlFor="session">Session name</label><input id="session" value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></div><div className="control-group compact"><label htmlFor="scale">Torque scale</label><div className="input-with-unit"><input id="scale" type="number" step="0.001" value={torqueScale} onChange={(event) => setTorqueScale(Number(event.target.value))} /><span>N m/count</span></div></div><div className="control-group compact"><label htmlFor="offset">Torque zero</label><div className="input-with-unit"><input id="offset" type="number" value={torqueOffset} onChange={(event) => setTorqueOffset(Number(event.target.value))} /><span>count</span></div></div><div className="deck-actions"><button className={`button button-log ${logging ? 'is-recording' : ''}`} onClick={() => setLogging((value) => !value)}>{logging ? <Square size={14} fill="currentColor" /> : <CircleHelp size={14} />}{logging ? 'Logging' : 'Start log'}</button><button className="button button-quiet" onClick={() => void chooseDirectory()} title="Choose a folder for browser file access">{directoryName === 'Browser download' ? 'Choose folder' : directoryName}</button><button className="icon-button" title="Download CSV" onClick={() => void downloadCsv()}><Download size={17} /></button><button className="icon-button" title="Clear session" onClick={() => { setSamples([]); setNotice('Session buffer cleared') }}><Trash2 size={17} /></button></div></section>
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