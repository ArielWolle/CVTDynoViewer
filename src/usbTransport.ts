import type { ChannelId } from './protocol'
import type { WorkerInboundMessage, WorkerOutboundMessage } from './usbWorker'

export type UsbHandlers = {
  onValue: (channel: ChannelId, value: number, tUs: number, seq: number, edgeCount: number) => void
  onPacket?: (raw: Uint8Array, channel: ChannelId, value: number, seq: number) => void
  onText: (text: string) => void
}

// Must match platformio.ini's board_build.arduino.earlephilhower.usb_vid/usb_pid exactly -- these
// are what let the browser recognize "this is our device" without the user having to eyeball
// "CVT Dyno" in a list of similarly-generic-looking USB devices.
const DEVICE_VENDOR_ID = 0x1209
const DEVICE_PRODUCT_ID = 0xcd10

function matchesOurDevice(device: USBDevice): boolean {
  return device.vendorId === DEVICE_VENDOR_ID && device.productId === DEVICE_PRODUCT_ID
}

// All actual USB I/O (device open/claim, the transferIn() read loop, byte framing/decoding, and
// transferOut() for outgoing commands) now runs inside usbWorker.ts, on its own thread -- this
// class is just a thin postMessage proxy in front of it. See usbWorker.ts's top comment for why:
// in short, a command send used to have to wait behind whatever the main thread (rendering, or a
// backlog of packet processing) happened to be doing at the moment `send()` was called, since it
// was all one JS thread. Moving the device itself to a worker means `send()` here is just a cheap
// postMessage, and the worker's transferOut() executes independently of main-thread load.
//
// requestDevice() (the device chooser) still has to run here, not in the worker: it requires a
// user gesture and can only be shown from a window. It only needs to obtain the permission grant
// though, not open the device -- see usbWorker.ts's connect() for how the worker picks up that
// same grant via its own getDevices() call.
export class UsbTransport {
  private worker: Worker | null = null
  private connectedFlag = false
  private nextFlushRequestId = 1
  private flushWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()

  constructor(private readonly handlers: UsbHandlers) {}

  get connected() { return this.connectedFlag }

  async connect() {
    if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser.')

    // Once a user has granted this origin permission for our device (via requestDevice() below,
    // which always needs a user gesture the first time), the browser remembers that grant --
    // getDevices() returns previously-authorized devices with NO chooser dialog at all. So every
    // connect after the first is a single click with no picker, as long as the same device is
    // plugged in and this origin hasn't had its USB permission revoked.
    const authorized = await navigator.usb.getDevices()
    if (!authorized.some(matchesOurDevice)) {
      // First-time pairing (or permission was revoked/a different device is plugged in) -- filter
      // the chooser to our exact vendor/product ID so the user sees "CVT Dyno" alone rather than
      // having to pick it out of every USB device on the system. The returned USBDevice is
      // deliberately not used any further here -- the worker opens/claims the actual device
      // itself (see the class comment above), this call's only job is obtaining the permission.
      await navigator.usb.requestDevice({ filters: [{ vendorId: DEVICE_VENDOR_ID, productId: DEVICE_PRODUCT_ID }] })
    }

    const worker = new Worker(new URL('./usbWorker.ts', import.meta.url), { type: 'module' })
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
        const message = event.data
        if (message.type === 'connected') { worker.onmessage = (nested) => this.handleMessage(nested); resolve() }
        else if (message.type === 'connect-error') reject(new Error(message.message))
      }
      worker.onerror = (event) => reject(new Error(event.message || 'USB worker failed to start'))
      const connectMessage: WorkerInboundMessage = { type: 'connect', vendorId: DEVICE_VENDOR_ID, productId: DEVICE_PRODUCT_ID }
      worker.postMessage(connectMessage)
    })
    this.worker = worker
    this.connectedFlag = true
  }

  async disconnect() {
    const worker = this.worker
    this.worker = null
    this.connectedFlag = false
    if (worker) {
      const disconnectMessage: WorkerInboundMessage = { type: 'disconnect' }
      worker.postMessage(disconnectMessage)
      worker.terminate()
    }
  }

  async send(bytes: Uint8Array) {
    if (!this.worker) throw new Error('USB device is not connected.')
    const sendMessage: WorkerInboundMessage = { type: 'send', bytes }
    this.worker.postMessage(sendMessage)
  }

  async flush() {
    if (!this.worker) return
    const requestId = this.nextFlushRequestId++
    await new Promise<void>((resolve, reject) => {
      this.flushWaiters.set(requestId, { resolve, reject })
      const message: WorkerInboundMessage = { type: 'flush', requestId }
      this.worker?.postMessage(message)
    })
  }

  private handleMessage(event: MessageEvent<WorkerOutboundMessage>) {
    const message = event.data
    if (message.type === 'chunk') {
      // The ack below MUST always be sent, even if a handler throws -- see the try/finally.
      // Without this, an exception anywhere in onPacket()/onValue() (a bug, an unexpected packet
      // shape, anything) would abort this function before reaching the ack, permanently costing
      // this chunk's delivery credit. With DELIVERY_CREDIT_WINDOW as small as 2, just two such
      // exceptions would exhaust all credit forever: the worker keeps draining USB into its own
      // buffer (per usbWorker.ts's design), but tryDeliver() would never again see
      // `deliveryCredits > 0`, silently stalling the entire live pipeline until a full
      // disconnect/reconnect (a fresh worker with fresh credit). A processing exception should
      // never be able to do that much damage on its own.
      try {
        if (message.overflowDropped > 0) this.handlers.onText(`[BUFFER OVERFLOW] ${message.overflowDropped} packet(s) dropped -- worker's internal buffer was full (see usbWorker.ts's MAX_BUFFERED_PACKETS)`)
        for (const text of message.texts) this.handlers.onText(text)
        for (const packet of message.packets) {
          this.handlers.onPacket?.(packet.raw, packet.channel, packet.value, packet.seq)
          this.handlers.onValue(packet.channel, packet.value, packet.tUs, packet.seq, packet.edgeCount)
        }
      } finally {
        // Returns this chunk's delivery credit only now that all of its synchronous processing
        // above has actually finished (successfully or not) -- see usbWorker.ts's
        // DELIVERY_CREDIT_WINDOW comment: this paces how fast the worker hands off buffered data
        // to the main thread (NOT how fast it drains USB, which is unthrottled -- see that file's
        // top comment), so a main thread that's genuinely behind naturally slows delivery instead
        // of an unbounded backlog piling up in the browser's own postMessage queue.
        if (this.worker) { const ackMessage: WorkerInboundMessage = { type: 'ack', deliveryId: message.deliveryId, maxPacketOrdinal: message.maxPacketOrdinal }; this.worker.postMessage(ackMessage) }
      }
    } else if (message.type === 'flushed') {
      this.flushWaiters.get(message.requestId)?.resolve()
      this.flushWaiters.delete(message.requestId)
    } else if (message.type === 'disconnected') {
      this.connectedFlag = false
      this.worker = null
      const error = new Error(message.reason ?? 'USB device disconnected')
      this.flushWaiters.forEach((waiter) => waiter.reject(error))
      this.flushWaiters.clear()
      this.handlers.onText(message.reason ?? 'USB device disconnected')
    } else if (message.type === 'send-error') {
      this.handlers.onText(`[SEND ERROR] ${message.message}`)
    }
  }
}
