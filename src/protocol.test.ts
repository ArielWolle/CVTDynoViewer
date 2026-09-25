import { describe, expect, it } from 'vitest'
import { COMMAND_SYNC, TELEMETRY_PACKET_LEN, TELEMETRY_SYNC0, TELEMETRY_SYNC1, crc8, decodePacket, encodeCommand, periodUsToRpm, rawLogRow, type ChannelId } from './protocol'

function packetV2(channel: number, seq: number, value: number, tUs: number, edgeCount: number) {
  const packet = new Uint8Array(TELEMETRY_PACKET_LEN)
  packet[0] = TELEMETRY_SYNC0
  packet[1] = TELEMETRY_SYNC1
  packet[2] = channel
  packet[3] = seq
  const view = new DataView(packet.buffer)
  view.setInt32(4, value, true)
  view.setUint32(8, tUs >>> 0, true)
  view.setUint32(12, Math.floor(tUs / 4294967296), true)
  view.setUint32(16, edgeCount >>> 0, true)
  packet[20] = crc8(packet.slice(2, 20))
  return packet
}

describe('wire protocol', () => {
  it('encodes commands with the command sync byte and big-endian value', () => {
    expect([...encodeCommand(2, 4, 0x1234)]).toEqual([COMMAND_SYNC, 2, 4, 0x12, 0x34])
  })

  it('decodes the fixed telemetry packet including firmware time and physical edge count', () => {
    const decoded = decodePacket(packetV2(1, 7, 12345, 5_000_000_123, 99))
    expect(decoded).toEqual({ channel: 1, seq: 7, value: 12345, tUs: 5_000_000_123, edgeCount: 99 })
  })

  it('rejects a telemetry packet with a bad CRC', () => {
    const packet = packetV2(0, 1, 1000, 1234, 2)
    packet[20] ^= 0xff
    expect(decodePacket(packet)).toBeNull()
  })

  it('converts raw inter-tooth periods to RPM and preserves the explicit stopped value', () => {
    expect(periodUsToRpm(1250, 16)).toBeCloseTo(3000)
    expect(periodUsToRpm(0, 16)).toBe(0)
  })

  it('formats the canonical lossless raw row', () => {
    expect(rawLogRow(1 as ChannelId, 4200, 123456789, 1500.25, 7, 99)).toBe('123456789,1.500250,1,Secondary RPM,7,4200,99')
  })
})
