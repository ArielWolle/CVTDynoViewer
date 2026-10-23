import type { ChannelId } from './protocol'
import type { WorkerInboundMessage, WorkerOutboundMessage } from './usbWorker'
import type { VirtualUsbScenario } from './testing/virtualUsbDevice'

export type UsbHandlers = {
  onValue: (channel: ChannelId, value: number, tUs: number, seq: number, edgeCount: number) => void
  onPacket?: (raw: Uint8Array, channel: ChannelId, value: number, seq: number) => void
  onText: (text: string) => void
  onError?: (message: string) => void
  onDisconnected?: (reason: string) => void
}

const DEVICE_VENDOR_ID = 0x1209
const DEVICE_PRODUCT_ID = 0xcd10
const DISCONNECT_TIMEOUT_MS = 1500
const CONNECT_TIMEOUT_MS = 15000
const COMMAND_TIMEOUT_MS = 5000

type Waiter = { resolve: () => void; reject: (error: Error) => void; timeout?: ReturnType<typeof setTimeout> }

function matchesOurDevice(device: USBDevice): boolean {
  return device.vendorId === DEVICE_VENDOR_ID && device.productId === DEVICE_PRODUCT_ID
}

// The virtual path skips only the OS permission/USB-device lookup. The real and virtual
// connections thereafter use exactly the same worker, interface discovery, transferIn,
// framing/decoding, transferOut, delivery backpressure, and telemetry handlers.
export class UsbTransport {
  private worker: Worker | null = null
  private connectedFlag = false
  private connecting = false
  private nextRequestId = 1
  private sendWaiters = new Map<number, Waiter>()
  private flushWaiters = new Map<number, Waiter>()

  constructor(private readonly handlers: UsbHandlers) {}

  get connected() { return this.connectedFlag }

  async connect(virtualScenario?: VirtualUsbScenario): Promise<void> {
    if (this.worker || this.connecting) throw new Error('USB connection already in progress')

    this.connecting = true
    let worker: Worker | null = null
    try {
      if (!virtualScenario) {
        if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser.')
        const authorized = await navigator.usb.getDevices()
        if (!authorized.some(matchesOurDevice)) {
          await navigator.usb.requestDevice({
            filters: [{ vendorId: DEVICE_VENDOR_ID, productId: DEVICE_PRODUCT_ID }],
          })
        }
      }

      worker = new Worker(new URL('./usbWorker.ts', import.meta.url), { type: 'module' })
      this.worker = worker
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('USB connection timed out after 15 seconds')), CONNECT_TIMEOUT_MS)
        const finish = (error?: Error) => {
          clearTimeout(timeout)
          if (error) reject(error)
          else resolve()
        }
        worker!.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
          const message = event.data
          if (message.type === 'connected') finish()
          else if (message.type === 'connect-error') finish(new Error(message.message))
          else if (message.type === 'disconnected') finish(new Error(message.reason ?? 'USB disconnected during initialization'))
        }
        worker!.onerror = (event) => finish(new Error(event.message || 'USB worker failed to start'))
        const message: WorkerInboundMessage = {
          type: 'connect', vendorId: DEVICE_VENDOR_ID, productId: DEVICE_PRODUCT_ID,
          ...(virtualScenario ? { virtualScenario } : {}),
        }
        worker!.postMessage(message)
      })
      this.connectedFlag = true
      worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => this.handleMessage(event)
      worker.onerror = (event) => this.failConnection('USB worker: ' + (event.message || 'worker error'))
    } catch (error) {
      worker?.terminate()
      if (this.worker === worker) this.worker = null
      this.connectedFlag = false
      throw error
    } finally {
      this.connecting = false
    }
  }

  async disconnect(): Promise<void> {
    const worker = this.worker
    this.worker = null
    this.connectedFlag = false
    this.rejectPending(new Error('USB device disconnected'))
    if (!worker) return

    // Unlike the previous implementation, do NOT terminate immediately after sending a
    // disconnect command: that killed the worker before releaseInterface()/close() could run.
    try {
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve()
        }
        const timeout = setTimeout(finish, DISCONNECT_TIMEOUT_MS)
        worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
          if (event.data.type === 'disconnected') finish()
        }
        worker.onerror = finish
        const message: WorkerInboundMessage = { type: 'disconnect' }
        try { worker.postMessage(message) } catch { finish() }
      })
    } finally {
      worker.terminate()
    }
  }

  async send(bytes: Uint8Array): Promise<void> {
    const worker = this.worker
    if (!worker || !this.connectedFlag) throw new Error('USB device is not connected.')
    const requestId = this.nextRequestId++
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      waiter.timeout = setTimeout(() => {
        this.sendWaiters.delete(requestId)
        reject(new Error('USB command transfer timed out'))
      }, COMMAND_TIMEOUT_MS)
      this.sendWaiters.set(requestId, waiter)
      const message: WorkerInboundMessage = { type: 'send', bytes, requestId }
      try { worker.postMessage(message) } catch (error) {
        this.settle(this.sendWaiters, requestId, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  // Worker delivery barrier, not a guarantee about bytes still buffered in physical USB.
  async flushDelivered(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    const requestId = this.nextRequestId++
    return new Promise<void>((resolve, reject) => {
      this.flushWaiters.set(requestId, { resolve, reject })
      const message: WorkerInboundMessage = { type: 'flush', requestId }
      try { worker.postMessage(message) } catch (error) {
        this.settle(this.flushWaiters, requestId, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private settle(map: Map<number, Waiter>, requestId: number, error?: Error) {
    const waiter = map.get(requestId)
    if (!waiter) return
    map.delete(requestId)
    if (waiter.timeout !== undefined) clearTimeout(waiter.timeout)
    if (error) waiter.reject(error)
    else waiter.resolve()
  }

  private rejectPending(error: Error) {
    for (const [requestId] of this.sendWaiters) this.settle(this.sendWaiters, requestId, error)
    for (const [requestId] of this.flushWaiters) this.settle(this.flushWaiters, requestId, error)
  }

  private failConnection(reason: string) {
    const worker = this.worker
    if (!worker && !this.connectedFlag) return
    this.worker = null
    this.connectedFlag = false
    this.rejectPending(new Error(reason))
    worker?.terminate()
    this.handlers.onText('[USB DISCONNECTED] ' + reason)
    this.handlers.onError?.(reason)
    this.handlers.onDisconnected?.(reason)
  }

  private handleMessage(event: MessageEvent<WorkerOutboundMessage>) {
    const message = event.data
    if (message.type === 'chunk') {
      try {
        if (message.overflowDropped > 0) this.handlers.onText('[BUFFER OVERFLOW] ' + message.overflowDropped + ' packet(s) dropped')
        for (const text of message.texts) this.handlers.onText(text)
        for (const packet of message.packets) {
          this.handlers.onPacket?.(packet.raw, packet.channel, packet.value, packet.seq)
          this.handlers.onValue(packet.channel, packet.value, packet.tUs, packet.seq, packet.edgeCount)
        }
      } finally {
        // Processing exceptions may not consume delivery credits indefinitely.
        if (this.worker) {
          const ack: WorkerInboundMessage = {
            type: 'ack', deliveryId: message.deliveryId, maxPacketOrdinal: message.maxPacketOrdinal,
          }
          this.worker.postMessage(ack)
        }
      }
    } else if (message.type === 'sent') {
      this.settle(this.sendWaiters, message.requestId)
    } else if (message.type === 'send-error') {
      this.settle(this.sendWaiters, message.requestId, new Error(message.message))
      this.handlers.onText('[SEND ERROR] ' + message.message)
      this.handlers.onError?.('USB send error: ' + message.message)
    } else if (message.type === 'flushed') {
      this.settle(this.flushWaiters, message.requestId)
    } else if (message.type === 'disconnected') {
      this.failConnection(message.reason ?? 'USB device disconnected')
    }
  }
}
