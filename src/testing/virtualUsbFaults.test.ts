import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeCommand } from '../protocol'
import { DataQualityMonitor } from '../quality/dataQuality'
import { UsbStreamFramer } from '../usbStreamFramer'
import { VirtualUsbDevice, type VirtualUsbFaultPlan } from './virtualUsbDevice'

async function connected(faultPlan: VirtualUsbFaultPlan = {}) {
  const device = new VirtualUsbDevice('normal', faultPlan)
  await device.open()
  await device.selectConfiguration(1)
  await device.claimInterface(0)
  await device.controlTransferOut({
    requestType: 'class', recipient: 'interface', request: 0x22, value: 1, index: 0,
  })
  return device
}

async function collect(faultPlan: VirtualUsbFaultPlan = {}) {
  const device = await connected(faultPlan)
  try {
    // Fixed simulated device duration and exact injected ordinals. No wall-clock
    // sleeps or randomized faults; repeatable on fast and slow CI runners.
    await vi.advanceTimersByTimeAsync(350)
    const monitor = new DataQualityMonitor()
    let decoded = 0
    let texts = 0
    const framer = new UsbStreamFramer(
      (packet) => { decoded++; monitor.ingest(packet) },
      () => { texts++ },
    )
    for (let n = 0; device.bufferedBytes > 0 && n < 10_000; n++) {
      const read = await device.transferIn(1, 4096)
      const view = read.data!
      framer.push(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    }
    expect(device.bufferedBytes).toBe(0)
    return { quality: monitor.snapshot(), decoded, texts }
  } finally {
    await device.close()
  }
}

describe('deterministic virtual RP2040 fault plan', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('decodes a high-rate clean stream, including deliberately split USB reads, without false loss', async () => {
    const { quality, decoded } = await collect({ fragmentTransfers: true })
    expect(decoded).toBeGreaterThan(350)
    expect(quality.transmissionPacketsLost).toBe(0)
    expect(quality.deviceEdgesLost).toEqual([0, 0])
    expect(quality.suspectedSensorPulses).toEqual([0, 0])
    expect(quality.events).toEqual([])
  })

  it('flags exactly one undetected tooth while both on-wire counters remain continuous', async () => {
    const { quality } = await collect({ missSensorToothOrdinals: { 0: [60] } })
    expect(quality.suspectedSensorPulses).toEqual([1, 0])
    expect(quality.transmissionPacketsLost).toBe(0)
    expect(quality.deviceEdgesLost).toEqual([0, 0])
    expect(quality.events).toMatchObject([{ kind: 'suspected-missed-pulse', channel: 0, count: 1 }])
  })

  it('flags exactly one captured physical edge discarded in the firmware ring buffer', async () => {
    const { quality } = await collect({ dropBufferedEdgeCounts: { 0: [70] } })
    expect(quality.transmissionPacketsLost).toBe(0)
    expect(quality.deviceEdgesLost).toEqual([1, 0])
    expect(quality.suspectedSensorPulses).toEqual([0, 0])
    expect(quality.events).toMatchObject([{ kind: 'device-edge-loss', channel: 0, count: 1 }])
  })

  it('flags exactly one transmitted packet missing after its sequence number was assigned', async () => {
    const { quality } = await collect({ dropOutgoingPacketOrdinals: [80] })
    expect(quality.transmissionPacketsLost).toBe(1)
    expect(quality.deviceEdgesLost).toEqual([0, 0])
    expect(quality.suspectedSensorPulses).toEqual([0, 0])
    expect(quality.events).toHaveLength(1)
    expect(quality.events[0].kind).toBe('transmission-loss')
  })

  it('resynchronizes after a CRC-corrupt frame and reports a transmission discontinuity', async () => {
    const { quality, decoded } = await collect({ corruptPacketOrdinals: [80], fragmentTransfers: true })
    expect(decoded).toBeGreaterThan(330)
    expect(quality.transmissionPacketsLost).toBe(1)
    expect(quality.deviceEdgesLost).toEqual([0, 0])
    expect(quality.suspectedSensorPulses).toEqual([0, 0])
    expect(quality.events).toHaveLength(1)
  })

  it('fails an injected USB OUT transfer rather than claiming a command was accepted', async () => {
    const device = await connected({ stallOutTransferOrdinal: 1 })
    try {
      await expect(device.transferOut(2, encodeCommand(3))).rejects.toThrow('Injected USB OUT transfer stall')
      await expect(device.transferOut(2, encodeCommand(3))).resolves.toMatchObject({
        status: 'ok', bytesWritten: 5,
      })
      expect(device.bufferedBytes).toBeGreaterThan(50)
    } finally {
      await device.close()
    }
  })
})
