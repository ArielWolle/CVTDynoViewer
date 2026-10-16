import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeCommand } from './protocol'
import { UsbTransport } from './usbTransport'
import type { WorkerInboundMessage, WorkerOutboundMessage } from './usbWorker'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent<WorkerOutboundMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  cleanedUp = false
  deferredSend = false
  sent: WorkerInboundMessage[] = []

  constructor() { FakeWorker.instances.push(this) }

  postMessage(message: WorkerInboundMessage) {
    this.sent.push(message)
    queueMicrotask(() => {
      if (this.terminated) return
      if (message.type === 'connect') {
        this.emit(message.virtualScenario === 'claim-error'
          ? { type: 'connect-error', message: 'USB connect (interface claim): Simulated claimInterface failure' }
          : { type: 'connected' })
      } else if (message.type === 'disconnect') {
        this.cleanedUp = true
        this.emit({ type: 'disconnected' })
      } else if (message.type === 'send' && !this.deferredSend) {
        this.emit({ type: 'sent', requestId: message.requestId })
      } else if (message.type === 'flush') {
        this.emit({ type: 'flushed', requestId: message.requestId })
      }
    })
  }

  emit(message: WorkerOutboundMessage) {
    this.onmessage?.({ data: message } as MessageEvent<WorkerOutboundMessage>)
  }

  terminate() { this.terminated = true }
}

function instance() {
  return FakeWorker.instances[FakeWorker.instances.length - 1]
}

describe('UsbTransport lifecycle and command delivery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeWorker.instances = []
  })

  it('uses the same worker for a virtual device and waits for a clean disconnect acknowledgment', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const transport = new UsbTransport({ onValue: () => undefined, onText: () => undefined })
    await transport.connect('normal')
    expect(transport.connected).toBe(true)
    expect(instance().sent[0]).toMatchObject({ type: 'connect', virtualScenario: 'normal' })
    await transport.send(encodeCommand(3))
    expect(instance().sent.some((message) => message.type === 'send')).toBe(true)
    await transport.flushDelivered()
    await transport.disconnect()
    expect(instance().cleanedUp).toBe(true)
    expect(instance().terminated).toBe(true)
    expect(transport.connected).toBe(false)
  })

  it('connects, commands and cleanly disconnects repeatedly without accumulating workers', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const transport = new UsbTransport({ onValue: () => undefined, onText: () => undefined })
    for (let i = 0; i < 25; i += 1) {
      await transport.connect('normal')
      await transport.send(encodeCommand(3))
      await transport.disconnect()
      expect(transport.connected).toBe(false)
    }
    expect(FakeWorker.instances).toHaveLength(25)
    expect(FakeWorker.instances.every((worker) => worker.cleanedUp && worker.terminated)).toBe(true)
  })

  it('terminates a worker that fails connection setup and permits reconnect', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const transport = new UsbTransport({ onValue: () => undefined, onText: () => undefined })
    await expect(transport.connect('claim-error')).rejects.toThrow('interface claim')
    expect(instance().terminated).toBe(true)
    await transport.connect('normal')
    expect(transport.connected).toBe(true)
    await transport.disconnect()
  })

  it('does not claim a command succeeded when the USB OUT transfer failed', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const sendErrors: string[] = []
    const transport = new UsbTransport({
      onValue: () => undefined,
      onText: () => undefined,
      onError: (message) => sendErrors.push(message),
    })
    await transport.connect('normal')
    const worker = instance()
    worker.deferredSend = true
    const promise = transport.send(encodeCommand(4, 0, 1))
    const sent = worker.sent.find((message) => message.type === 'send')
    expect(sent?.type).toBe('send')
    const failure = expect(promise).rejects.toThrow('Simulated USB OUT stall')
    if (sent?.type === 'send') {
      worker.emit({ type: 'send-error', requestId: sent.requestId, message: 'Simulated USB OUT stall' })
    }
    await failure
    expect(sendErrors).toContain('USB send error: Simulated USB OUT stall')
    await transport.disconnect()
  })

  it('rejects outstanding commands on unexpected read failure and informs the UI', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const disconnected: string[] = []
    const transport = new UsbTransport({
      onValue: () => undefined,
      onText: () => undefined,
      onDisconnected: (reason) => disconnected.push(reason),
    })
    await transport.connect('normal')
    const worker = instance()
    worker.deferredSend = true
    const command = transport.send(encodeCommand(3))
    const failure = expect(command).rejects.toThrow('USB read')
    worker.emit({ type: 'disconnected', reason: 'USB read: simulated cable removal' })
    await failure
    expect(disconnected).toEqual(['USB read: simulated cable removal'])
    expect(transport.connected).toBe(false)
    expect(worker.terminated).toBe(true)
    await transport.connect('normal')
    await transport.disconnect()
  })
})
