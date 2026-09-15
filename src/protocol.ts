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

const engineTorqueCurveFtLb: ReadonlyArray<{ rpm: number; torque: number }> = [
  { rpm: 1000, torque: 0 },
  { rpm: 1800, torque: 18 },
  { rpm: 2400, torque: 18.5 },
  { rpm: 2600, torque: 18.1 },
  { rpm: 2800, torque: 17.4 },
  { rpm: 3000, torque: 16.6 },
  { rpm: 3200, torque: 15.4 },
  { rpm: 3400, torque: 14.5 },
  { rpm: 3600, torque: 13.5 },
  { rpm: 4000, torque: 0 },
]

function interpolateEngineTorque(rpm: number): number {
  if (!Number.isFinite(rpm) || rpm <= 0) return 0
  if (rpm <= engineTorqueCurveFtLb[0].rpm) return engineTorqueCurveFtLb[0].torque
  if (rpm >= engineTorqueCurveFtLb[engineTorqueCurveFtLb.length - 1].rpm) return 0

  for (let index = 0; index < engineTorqueCurveFtLb.length - 1; index += 1) {
    const current = engineTorqueCurveFtLb[index]
    const next = engineTorqueCurveFtLb[index + 1]
    if (rpm >= current.rpm && rpm <= next.rpm) {
      const span = next.rpm - current.rpm
      if (span === 0) return current.torque
      const fraction = (rpm - current.rpm) / span
      return current.torque + (next.torque - current.torque) * fraction
    }
  }

  return 0
}

export function estimatePrimaryPowerFromCurve(rpm: number): number {
  const torqueFtLb = interpolateEngineTorque(rpm)
  const torqueNm = torqueFtLb * 1.355817948
  const omega = (rpm * 2 * Math.PI) / 60
  return Math.max(0, (torqueNm * omega) / 1000)
}

export function estimateSecondaryPowerFromInertia(rpmNow: number, rpmPrevious: number, timeNow: number, timePrevious: number, inertiaKgM2 = 0.3): number {
  if (!Number.isFinite(rpmNow) || !Number.isFinite(rpmPrevious) || !Number.isFinite(timeNow) || !Number.isFinite(timePrevious)) return 0
  const dtSeconds = (timeNow - timePrevious) / 1000
  if (dtSeconds <= 0) return 0

  const omegaNow = (rpmNow * 2 * Math.PI) / 60
  const omegaPrevious = (rpmPrevious * 2 * Math.PI) / 60
  const alpha = (omegaNow - omegaPrevious) / dtSeconds
  const torqueNm = Math.max(0, inertiaKgM2 * alpha)
  return Math.max(0, (torqueNm * omegaNow) / 1000)
}

export function decodePacket(packet: Uint8Array): { channel: ChannelId; value: number } | null {
  if (packet.length !== 8 || !((packet[0] === 0xaa && packet[1] === 0xbb) || (packet[0] === 0xbb && packet[1] === 0xaa)) || packet[2] > 4) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  return { channel: packet[2] as ChannelId, value: view.getInt32(4, true) }
}

export function encodeCommand(command: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, channel = 0, value = 0): Uint8Array {
  return new Uint8Array([command, channel, (value >> 8) & 0xff, value & 0xff])
}

export function deriveSample(values: Pick<TelemetrySample, 'time' | 'rpm1' | 'rpm2' | 'shift' | 'torq1' | 'torq2'>, torqueScale: number, torqueOffset: number, powerMode: PowerMode = 'torque', previous?: Pick<TelemetrySample, 'time' | 'rpm1' | 'rpm2'>): TelemetrySample {
  const power1 = powerMode === 'inertia' ? estimatePrimaryPowerFromCurve(values.rpm1) : Math.max(0, ((values.torq1 - torqueOffset) * torqueScale * values.rpm1) / 9549)
  const power2 = powerMode === 'inertia' ? estimateSecondaryPowerFromInertia(values.rpm2, previous?.rpm2 ?? values.rpm2, values.time, previous?.time ?? values.time) : Math.max(0, ((values.torq2 - torqueOffset) * torqueScale * values.rpm2) / 9549)
  return { ...values, power1, power2, efficiency: power1 > 0 ? Math.min(150, (power2 / power1) * 100) : 0 }
}

export function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const csvHeader = 'timestamp_ms,primary_rpm,secondary_rpm,shift_position,primary_torque,secondary_torque,primary_power_kw,secondary_power_kw,efficiency_percent'

export function sampleToCsvRow(sample: TelemetrySample): string {
  return [sample.time, sample.rpm1, sample.rpm2, sample.shift, sample.torq1, sample.torq2, sample.power1.toFixed(3), sample.power2.toFixed(3), sample.efficiency.toFixed(2)].map(csvEscape).join(',')
}

export function samplesToCsv(samples: TelemetrySample[]): string {
  return [csvHeader, ...samples.map(sampleToCsvRow)].join('\n')
}
