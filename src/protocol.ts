export type ChannelId = 0 | 1 | 2 | 3 | 4

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

export function decodePacket(packet: Uint8Array): { channel: ChannelId; value: number } | null {
  if (packet.length !== 8 || packet[0] !== 0xaa || packet[1] !== 0xbb || packet[2] > 4) return null
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  return { channel: packet[2] as ChannelId, value: view.getInt32(4, true) }
}

export function encodeCommand(command: 1 | 2 | 3, channel = 0, value = 0): Uint8Array {
  return new Uint8Array([command, channel, (value >> 8) & 0xff, value & 0xff])
}

export function deriveSample(values: Pick<TelemetrySample, 'time' | 'rpm1' | 'rpm2' | 'shift' | 'torq1' | 'torq2'>, torqueScale: number, torqueOffset: number): TelemetrySample {
  const power1 = Math.max(0, ((values.torq1 - torqueOffset) * torqueScale * values.rpm1) / 9549)
  const power2 = Math.max(0, ((values.torq2 - torqueOffset) * torqueScale * values.rpm2) / 9549)
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
