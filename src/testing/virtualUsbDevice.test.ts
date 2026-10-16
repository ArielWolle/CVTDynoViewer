import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodePacket, encodeCommand, EXPECTED_PROTOCOL_VERSION } from '../protocol'
import { VirtualUsbDevice } from './virtualUsbDevice'
import { UsbStreamFramer } from '../usbStreamFramer'
import { DataQualityMonitor } from '../quality/dataQuality'

function readBytes(result: USBInTransferResult): Uint8Array {
  const data = result.data!
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

async function ready(scenario: ConstructorParameters<typeof VirtualUsbDevice>[0] = 'normal') {
  const device = new VirtualUsbDevice(scenario)
  await device.open()
  await device.selectConfiguration(1)
  await device.claimInterface(0)
  await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 1, index: 0 })
  return device
}

async function readTextUntil(device: VirtualUsbDevice, marker: string) {
  let result = ''
  for (let attempt = 0; attempt < 150 && !result.includes(marker); attempt += 1) {
    result += new TextDecoder().decode(readBytes(await device.transferIn(1, 4096)))
  }
  if (!result.includes(marker)) throw new Error('No virtual firmware reply: ' + marker)
  return result
}

describe('virtual RP2040 WebUSB interface', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('exposes the same vendor bulk endpoints and initial configuration as real firmware', async () => {
    const device = await ready()
    expect(device.vendorId).toBe(0x1209)
    expect(device.productId).toBe(0xcd10)
    expect(device.configuration!.interfaces[0].alternate.interfaceClass).toBe(0xff)
    expect(device.configuration!.interfaces[0].alternate.endpoints.map((endpoint) => endpoint.direction)).toEqual(['in', 'out'])
    await device.transferOut(2, encodeCommand(3))
    const text = await readTextUntil(device, '------------------------------------')
    expect(text).toContain('Firmware git: simulator')
    expect(text).toContain('Protocol version: ' + EXPECTED_PROTOCOL_VERSION)
    expect(text).toContain('Bench mode: ENABLED')
    expect(text).toContain('Channel [0] (RPM1): ENABLED | Edge-triggered')
    expect(text).toContain('Channel [4] (TORQ2): ENABLED | Target Tx Freq: 50 Hz')
    await device.close()
  })

  it('handles five-byte commands including changes to independently polled channels', async () => {
    const device = await ready()
    await device.transferOut(2, encodeCommand(1, 2, 0))
    await device.transferOut(2, encodeCommand(2, 4, 20))
    // Two partial USB OUT writes must be assembled into one command.
    const command = encodeCommand(3)
    await device.transferOut(2, command.subarray(0, 2))
    await device.transferOut(2, command.subarray(2))
    const text = await readTextUntil(device, '------------------------------------')
    expect(text).toContain('Channel [2] (SHIFT): DISABLED')
    expect(text).toContain('Channel [4] (TORQ2): ENABLED | Target Tx Freq: 20 Hz')
    await device.close()
  })

  it('streams CRC-valid per-tooth RPM packets split across arbitrary transfer boundaries', async () => {
    const device = await ready('fragmented')
    await vi.advanceTimersByTimeAsync(250)
    const bytes: number[] = []
    let rpmPacket = null
    let seenSplit = false
    for (let read = 0; read < 1500 && !rpmPacket; read += 1) {
      const chunk = readBytes(await device.transferIn(1, 4096))
      if (chunk.length < 21) seenSplit = true
      bytes.push(...chunk)
      for (let index = 0; index <= bytes.length - 21; index += 1) {
        if (bytes[index] !== 0xaa || bytes[index + 1] !== 0x55) continue
        const packet = decodePacket(new Uint8Array(bytes.slice(index, index + 21)))
        if (packet && packet.channel <= 1) { rpmPacket = packet; break }
      }
    }
    expect(seenSplit).toBe(true)
    expect(rpmPacket).not.toBeNull()
    expect(rpmPacket!.edgeCount).toBeGreaterThan(0)
    expect(rpmPacket!.value).toBeGreaterThan(0)
    await device.close()
  })

  it('exercises inferred sensor misses separately from transmission and ring loss', async () => {
    const device = await ready('fragmented')
    await vi.advanceTimersByTimeAsync(650)
    const monitor = new DataQualityMonitor()
    const framer = new UsbStreamFramer((decoded) => monitor.ingest(decoded), () => undefined)
    for (let read = 0; read < 4000; read += 1) {
      framer.push(readBytes(await device.transferIn(1, 4096)))
      if (monitor.snapshot().suspectedSensorPulses[0] > 0) break
    }
    const quality = monitor.snapshot()
    expect(quality.suspectedSensorPulses[0]).toBeGreaterThan(0)
    expect(quality.events.some((event) => event.kind === 'suspected-missed-pulse')).toBe(true)
    await device.close()
  })

  it('fails claiming and can be explicitly closed without a dangling interface', async () => {
    const device = new VirtualUsbDevice('claim-error')
    await device.open()
    await device.selectConfiguration(1)
    await expect(device.claimInterface(0)).rejects.toThrow('Simulated claimInterface failure')
    await device.close()
    expect(device.opened).toBe(false)
  })

  it('clearly identifies the deliberate unplug to a pending USB reader', async () => {
    const device = await ready('unplug')
    // The device may already have buffered telemetry. Act like the actual worker:
    // drain every available read until the scheduled cable unplug aborts the stream.
    const readUntilUnplug = async () => {
      for (let i = 0; i < 25000; i += 1) await device.transferIn(1, 4096)
      throw new Error('Virtual USB failed to unplug')
    }
    const rejection = expect(readUntilUnplug()).rejects.toThrow('Simulated RP2040 unplugged after 5 seconds')
    await vi.advanceTimersByTimeAsync(5100)
    await rejection
    expect(device.opened).toBe(false)
  })

  it('turns a deterministic synthetic cable removal into a rejected read', async () => {
    const device = await ready('unplug')
    await vi.advanceTimersByTimeAsync(5100)
    expect(device.opened).toBe(false)
    await expect(device.transferIn(1, 4096)).rejects.toThrow('Simulated RP2040 unplugged after 5 seconds (intentional test)')
  })
})
