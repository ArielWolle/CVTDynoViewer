import { describe, expect, it } from 'vitest'
import { crc8, TELEMETRY_PACKET_LEN } from './protocol'
import { UsbStreamFramer } from './usbStreamFramer'

function packet(channel: number, seq: number): Uint8Array {
  const data = new Uint8Array(TELEMETRY_PACKET_LEN)
  data.set([0xaa, 0x55, channel, seq])
  const view = new DataView(data.buffer)
  view.setInt32(4, 1234, true)
  view.setUint32(8, 5_000_123, true)
  view.setUint32(12, 0, true)
  view.setUint32(16, 56, true)
  data[20] = crc8(data.subarray(2, 20))
  return data
}

function join(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const part of parts) { out.set(part, pos); pos += part.length }
  return out
}

describe('stream framer for actual bulk WebUSB reads', () => {
  it('joins configuration lines and valid packets cut at every possible transfer offset', () => {
    const first = packet(0, 11)
    const second = packet(2, 12)
    const encode = (s: string) => new TextEncoder().encode(s)
    const source = join(
      encode('Firmware git: simu'), first,
      encode('lator\r\nProtocol version: 2\r\n'), second,
      encode('Bench mode: ENABLED\r\n'),
    )
    const seen: number[] = []
    const text: string[] = []
    const framer = new UsbStreamFramer((p) => seen.push(p.seq), (s) => text.push(s))
    // Every transfer is 1-7 bytes; neither a packet nor a config line aligns to reads.
    for (let i = 0; i < source.length;) {
      const count = 1 + ((i * 7) % 7)
      framer.push(source.subarray(i, i + count))
      i += count
    }
    expect(seen).toEqual([11, 12])
    expect(text).toEqual(['Firmware git: simulator', 'Protocol version: 2', 'Bench mode: ENABLED'])
  })

  it('resynchronizes after a corrupt CRC and still decodes the next valid packet', () => {
    const bad = packet(1, 4)
    bad[20] ^= 0xff
    const seen: number[] = []
    const framer = new UsbStreamFramer((decoded) => seen.push(decoded.seq), () => undefined)
    framer.push(join(bad, packet(1, 5)))
    expect(seen).toEqual([5])
  })

  it('reset removes leftovers from a disconnected device before reading new firmware', () => {
    const seen: number[] = []
    const text: string[] = []
    const framer = new UsbStreamFramer((decoded) => seen.push(decoded.seq), (line) => text.push(line))
    framer.push(packet(0, 3).subarray(0, 7))
    framer.push(new TextEncoder().encode('stale, incomplete status'))
    framer.reset()
    framer.push(join(packet(0, 4), new TextEncoder().encode('Protocol version: 2\r\n')))
    expect(seen).toEqual([4])
    expect(text).toEqual(['Protocol version: 2'])
  })
})
