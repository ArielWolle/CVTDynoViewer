export type ChannelId = 0 | 1 | 2 | 3 | 4

export type PowerMode = 'torque' | 'inertia'

export type TelemetrySample = {
  time: number
  rpm1: number
  rpm2: number
  shift: number
  torq1: number
  torq2: number
  power1: number
  power2: number
  efficiency: number
}

export const channelNames = ['Primary RPM', 'Secondary RPM', 'Shift position', 'Primary torque', 'Secondary torque'] as const

export type EngineTorquePoint = { rpm: number; torque: number }

export const defaultEngineTorqueCurve: ReadonlyArray<EngineTorquePoint> = [
  { rpm: 1000, torque: 0 },
  { rpm: 1800, torque: 18 },
  { rpm: 2400, torque: 18.5 },
  { rpm: 2600, torque: 18.1 },
  { rpm: 2800, torque: 17.4 },
  { rpm: 3000, torque: 16.6 },
  { rpm: 3200, torque: 15.4 },
  { rpm: 3400, torque: 14.5 },
  { rpm: 3600, torque: 13.5 },
  { rpm: 3950, torque: 10 },
  { rpm: 4000, torque: 0 },
]

// `curve` must already be sorted ascending by rpm. The torque curve editor keeps its points
// sorted as an invariant (drag clamps to neighbors, inserts land in sorted position), so this
// avoids an O(n log n) sort on every single sample when recalculating a whole logged run.
function interpolateEngineTorque(rpm: number, curve: ReadonlyArray<EngineTorquePoint> = defaultEngineTorqueCurve): number {
  if (!curve.length) return 0
  if (!Number.isFinite(rpm) || rpm <= 0) return 0
  if (rpm <= curve[0].rpm) return curve[0].torque
  if (rpm >= curve[curve.length - 1].rpm) return curve[curve.length - 1].torque

  for (let index = 0; index < curve.length - 1; index += 1) {
    const current = curve[index]
    const next = curve[index + 1]
    if (rpm >= current.rpm && rpm <= next.rpm) {
      const span = next.rpm - current.rpm
      if (span === 0) return current.torque
      const fraction = (rpm - current.rpm) / span
      return current.torque + (next.torque - current.torque) * fraction
    }
  }

  return 0
}

export function estimatePrimaryPowerFromCurve(rpm: number, curve: ReadonlyArray<EngineTorquePoint> = defaultEngineTorqueCurve): number {
  const torqueFtLb = interpolateEngineTorque(rpm, curve)
  const torqueNm = torqueFtLb * 1.355817948
  const omega = rpmToRadPerSecond(rpm)
  return Math.max(0, (torqueNm * omega) / 1000)
}

export function estimateSecondaryPowerFromInertia(rpmNow: number, rpmPrevious: number, timeNow: number, timePrevious: number, inertiaKgM2 = 0.3134): number {
  if (!Number.isFinite(rpmNow) || !Number.isFinite(rpmPrevious) || !Number.isFinite(timeNow) || !Number.isFinite(timePrevious)) return 0
  const dtSeconds = (timeNow - timePrevious) / 1000
  if (dtSeconds <= 0) return 0

  const omegaNow = rpmToRadPerSecond(rpmNow)
  const omegaPrevious = rpmToRadPerSecond(rpmPrevious)
  const alpha = (omegaNow - omegaPrevious) / dtSeconds
  const torqueNm = Math.max(0, inertiaKgM2 * alpha)
  return Math.max(0, (torqueNm * omegaNow) / 1000)
}

const RAD_PER_SEC_PER_RPM = (2 * Math.PI) / 60

export function rpmToRadPerSecond(rpm: number): number {
  return rpm * RAD_PER_SEC_PER_RPM
}

export function radPerSecondToRpm(radPerSecond: number): number {
  return radPerSecond / RAD_PER_SEC_PER_RPM
}

export function decodePacket(packet: Uint8Array): { channel: ChannelId; value: number } | null {
  if (packet.length !== 8 || !((packet[0] === 0xaa && packet[1] === 0xbb) || (packet[0] === 0xbb && packet[1] === 0xaa)) || packet[2] > 4) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  return { channel: packet[2] as ChannelId, value: view.getInt32(4, true) }
}

export function encodeCommand(command: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, channel = 0, value = 0): Uint8Array {
  return new Uint8Array([command, channel, (value >> 8) & 0xff, value & 0xff])
}

export function deriveSample(values: Pick<TelemetrySample, 'time' | 'rpm1' | 'rpm2' | 'shift' | 'torq1' | 'torq2'>, torqueScale: number, torqueOffset: number, powerMode: PowerMode = 'torque', previous?: Pick<TelemetrySample, 'time' | 'rpm1' | 'rpm2'>, inertiaKgM2 = 0.3134, torqueCurve: ReadonlyArray<EngineTorquePoint> = defaultEngineTorqueCurve): TelemetrySample {
  const power1 = powerMode === 'inertia' ? estimatePrimaryPowerFromCurve(values.rpm1, torqueCurve) : Math.max(0, ((values.torq1 - torqueOffset) * torqueScale * values.rpm1) / 9549)
  const power2 = powerMode === 'inertia' ? estimateSecondaryPowerFromInertia(values.rpm2, previous?.rpm2 ?? values.rpm2, values.time, previous?.time ?? values.time, inertiaKgM2) : Math.max(0, ((values.torq2 - torqueOffset) * torqueScale * values.rpm2) / 9549)
  return { ...values, power1, power2, efficiency: power1 > 0 ? Math.min(150, (power2 / power1) * 100) : 0 }
}

export function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

// Exported in SI units: seconds, rad/s, newton-meters, and watts. Torque counts are converted to
// N*m using the current torque scale/zero calibration (the same conversion the app already uses
// for torque-mode power) so the log is a physically meaningful, self-contained record.
export const csvHeader = 'timestamp_s,primary_angular_velocity_rad_s,secondary_angular_velocity_rad_s,shift_position_percent,primary_torque_nm,secondary_torque_nm,primary_power_w,secondary_power_w,efficiency_percent'

export function sampleToCsvRow(sample: TelemetrySample, torqueScale = 1, torqueOffset = 0): string {
  const primaryTorqueNm = (sample.torq1 - torqueOffset) * torqueScale
  const secondaryTorqueNm = (sample.torq2 - torqueOffset) * torqueScale
  return [
    (sample.time / 1000).toFixed(3),
    rpmToRadPerSecond(sample.rpm1).toFixed(4),
    rpmToRadPerSecond(sample.rpm2).toFixed(4),
    sample.shift,
    primaryTorqueNm.toFixed(4),
    secondaryTorqueNm.toFixed(4),
    (sample.power1 * 1000).toFixed(2),
    (sample.power2 * 1000).toFixed(2),
    sample.efficiency.toFixed(2),
  ].map(csvEscape).join(',')
}

export function samplesToCsv(samples: TelemetrySample[], torqueScale = 1, torqueOffset = 0): string {
  return [csvHeader, ...samples.map((sample) => sampleToCsvRow(sample, torqueScale, torqueOffset))].join('\n')
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') { current += '"'; index += 1 } else { inQuotes = false }
      } else current += char
    } else if (char === '"') inQuotes = true
    else if (char === ',') { cells.push(current); current = '' }
    else current += char
  }
  cells.push(current)
  return cells
}

type ColumnMatch = { index: number; unit: string }

function findColumn(header: string[], candidates: { name: string; unit: string }[]): ColumnMatch | null {
  for (const candidate of candidates) {
    // Substring (not exact equality) so a stray leading character or BOM in the header (e.g.
    // "Ctimestamp_ms" from a copy/paste artifact) still resolves the column. Candidates are
    // checked most-specific-first so e.g. "primary_power_w" doesn't get shadowed and vice versa.
    const index = header.findIndex((cell) => cell.includes(candidate.name))
    if (index >= 0) return { index, unit: candidate.unit }
  }
  return null
}

/**
 * Parses a logged CSV file back into telemetry samples for playback. Column order is resolved by
 * header name, and both the current SI-unit export format (seconds, rad/s, N*m, watts) and the
 * older RPM/kW/millisecond format are accepted -- whichever unit is detected per column is
 * converted back into the app's internal representation (ms, RPM, torque counts, kW).
 */
export function parseSamplesCsv(text: string, torqueScale = 1, torqueOffset = 0): TelemetrySample[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 2) return []
  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())

  const time = findColumn(header, [{ name: 'timestamp_s', unit: 's' }, { name: 'timestamp_ms', unit: 'ms' }])
  const rpm1 = findColumn(header, [{ name: 'primary_angular_velocity', unit: 'rad_s' }, { name: 'primary_rpm', unit: 'rpm' }])
  const rpm2 = findColumn(header, [{ name: 'secondary_angular_velocity', unit: 'rad_s' }, { name: 'secondary_rpm', unit: 'rpm' }])
  const shift = findColumn(header, [{ name: 'shift_position', unit: 'percent' }])
  const torq1 = findColumn(header, [{ name: 'primary_torque_nm', unit: 'nm' }, { name: 'primary_torque', unit: 'count' }])
  const torq2 = findColumn(header, [{ name: 'secondary_torque_nm', unit: 'nm' }, { name: 'secondary_torque', unit: 'count' }])
  const power1 = findColumn(header, [{ name: 'primary_power_w', unit: 'w' }, { name: 'primary_power_kw', unit: 'kw' }])
  const power2 = findColumn(header, [{ name: 'secondary_power_w', unit: 'w' }, { name: 'secondary_power_kw', unit: 'kw' }])
  const efficiency = findColumn(header, [{ name: 'efficiency_percent', unit: 'percent' }])
  if (!time || !rpm1 || !rpm2) return []

  const samples: TelemetrySample[] = []
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const cells = splitCsvLine(lines[lineIndex])
    const timeMs = time.unit === 's' ? Number(cells[time.index]) * 1000 : Number(cells[time.index])
    const rpm1Value = rpm1.unit === 'rad_s' ? radPerSecondToRpm(Number(cells[rpm1.index])) : Number(cells[rpm1.index])
    const rpm2Value = rpm2.unit === 'rad_s' ? radPerSecondToRpm(Number(cells[rpm2.index])) : Number(cells[rpm2.index])
    if (!Number.isFinite(timeMs) || !Number.isFinite(rpm1Value) || !Number.isFinite(rpm2Value)) continue
    const shiftValue = shift ? Number(cells[shift.index]) || 0 : 0
    const torq1Raw = torq1 ? Number(cells[torq1.index]) || 0 : 0
    const torq2Raw = torq2 ? Number(cells[torq2.index]) || 0 : 0
    const torq1Value = torq1?.unit === 'nm' && torqueScale !== 0 ? torq1Raw / torqueScale + torqueOffset : torq1Raw
    const torq2Value = torq2?.unit === 'nm' && torqueScale !== 0 ? torq2Raw / torqueScale + torqueOffset : torq2Raw
    const power1Raw = power1 ? Number(cells[power1.index]) || 0 : 0
    const power2Raw = power2 ? Number(cells[power2.index]) || 0 : 0
    const power1Value = power1?.unit === 'w' ? power1Raw / 1000 : power1Raw
    const power2Value = power2?.unit === 'w' ? power2Raw / 1000 : power2Raw
    const efficiencyValue = efficiency ? Number(cells[efficiency.index]) || 0 : power1Value > 0 ? Math.min(150, (power2Value / power1Value) * 100) : 0
    samples.push({ time: timeMs, rpm1: rpm1Value, rpm2: rpm2Value, shift: shiftValue, torq1: torq1Value, torq2: torq2Value, power1: power1Value, power2: power2Value, efficiency: efficiencyValue })
  }
  return samples.sort((a, b) => a.time - b.time)
}
