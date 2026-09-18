/// <reference lib="webworker" />
// Runs entirely on its own thread (a dedicated Worker -- see UsbTransport in usbTransport.ts,
// which is now just a thin postMessage proxy in front of this file). This is the actual fix for
// "clicking Disable bench mode feels laggy while telemetry is streaming": on the main thread, USB
// I/O and React rendering/click dispatch all shared one JS thread, so however much work rendering
// (or a backlog of it) was doing, a queued command send had to wait behind it. Moving the
// `USBDevice` itself -- open/claim, the transferIn() read loop, byte framing/decoding, and
// transferOut() for outgoing commands -- into a worker means none of that main-thread congestion
// can delay a command anymore: `send()` on the main thread is just a cheap postMessage, and this
// file executes the actual transferOut() independently, on a thread with nothing else competing
// for it.
//
// WebUSB is available in dedicated workers (confirmed via MDN's WebUSB API page: "This feature is
// available in Web Workers", backed by WorkerNavigator.usb) -- but navigator.usb.requestDevice()
// (the device chooser) requires a user gesture and can only be shown from a window, not a worker.
// That's why pairing still happens on the main thread (see usbTransport.ts's connect()) -- it only
// needs to obtain the permission grant, not open the device. USB permission grants are recorded
// per-origin, not per-context, so this worker's own getDevices() call (issued only after the main
// thread's requestDevice()/getDevices() has already resolved) sees that same grant immediately and
// does the actual open()/claimInterface()/read loop entirely on its own side.
import { decodePacket, TELEMETRY_SYNC0, TELEMETRY_SYNC1, TELEMETRY_PACKET_LEN, type ChannelId } from './protocol'

// See usbTransport.ts for the meaning of each of these -- copied here unchanged since this file
// now owns the device instead of usbTransport.ts.
const VENDOR_INTERFACE_CLASS = 0xff
const VENDOR_INTERFACE_SUBCLASS = 0x00
const VENDOR_INTERFACE_PROTOCOL = 0x00
const VENDOR_REQUEST_SET_LINE_STATE = 0x22
const READ_CHUNK_SIZE = 4096

export type WorkerDecodedPacket = { channel: ChannelId; value: number; tUs: number; seq: number; raw: Uint8Array }

export type WorkerOutboundMessage =
  | { type: 'connected' }
  | { type: 'connect-error'; message: string }
  | { type: 'disconnected'; reason?: string }
  | { type: 'chunk'; packets: WorkerDecodedPacket[]; texts: string[] }
  | { type: 'send-error'; message: string }

export type WorkerInboundMessage =
  | { type: 'connect'; vendorId: number; productId: number }
  | { type: 'send'; bytes: Uint8Array }
  | { type: 'disconnect' }
  | { type: 'ack' }

// Backpressure: without this, the read loop below would call transferIn() and postMessage() a
// decoded chunk as fast as the device provides data, with zero regard for whether the main thread
// has even finished processing the PREVIOUS chunk yet -- postMessage() never blocks, so if main-
// thread processing (handleValue's derivation/logging per packet) is ever slower than the
// incoming data rate, a backlog would build up in the browser's own worker message queue with no
// upper bound, and -- critically -- never self-correct, since nothing here would ever slow back
// down once behind. Before this file existed, the single-threaded read loop had this for free:
// the next transferIn() simply couldn't start until the previous chunk's handler calls returned,
// which (worst case) let USB-level flow control and the firmware's own TX FIFO absorb the
// slowdown. This credit gate reproduces that same real-time throttling explicitly: the worker
// only issues up to CREDIT_WINDOW transferIn() calls ahead of what the main thread has actually
// finished processing (see the 'ack' message main-thread side, sent once per chunk after its
// synchronous handler loop returns), stalling readLoop() itself -- not just the postMessage --
// once exhausted, so a genuinely-too-slow consumer naturally pushes back all the way to the
// firmware's write() calls instead of piling up invisibly in this thread's memory.
const CREDIT_WINDOW = 2
let credits = CREDIT_WINDOW
let creditWaiters: Array<() => void> = []

function takeCredit(): Promise<void> {
  if (credits > 0) { credits -= 1; return Promise.resolve() }
  return new Promise((resolve) => creditWaiters.push(resolve))
}

function grantCredit() {
  const waiter = creditWaiters.shift()
  if (waiter) waiter() // handed directly to whoever's waiting -- credits itself stays unchanged
  else credits += 1
}

function matchesDevice(device: USBDevice, vendorId: number, productId: number): boolean {
  return device.vendorId === vendorId && device.productId === productId
}

function findVendorInterface(device: USBDevice): { interfaceNumber: number; endpointIn: number; endpointOut: number } | null {
  for (const iface of device.configuration?.interfaces ?? []) {
    const alt = iface.alternate
    if (alt.interfaceClass !== VENDOR_INTERFACE_CLASS) continue
    if (alt.interfaceSubclass !== VENDOR_INTERFACE_SUBCLASS) continue
    if (alt.interfaceProtocol !== VENDOR_INTERFACE_PROTOCOL) continue
    const endpointIn = alt.endpoints.find((endpoint) => endpoint.direction === 'in' && endpoint.type === 'bulk')
    const endpointOut = alt.endpoints.find((endpoint) => endpoint.direction === 'out' && endpoint.type === 'bulk')
    if (endpointIn && endpointOut) return { interfaceNumber: iface.interfaceNumber, endpointIn: endpointIn.endpointNumber, endpointOut: endpointOut.endpointNumber }
  }
  return null
}

let device: USBDevice | null = null
let interfaceNumber = -1
let endpointIn = -1
let endpointOut = -1
let buffer = new Uint8Array()
let reading = false
const textDecoder = new TextDecoder()

function post(message: WorkerOutboundMessage) {
  postMessage(message)
}

async function connect(vendorId: number, productId: number) {
  if (!('usb' in navigator)) { post({ type: 'connect-error', message: 'WebUSB is not supported in this browser.' }); return }
  try {
    const authorized = await navigator.usb.getDevices()
    const found = authorized.find((candidate) => matchesDevice(candidate, vendorId, productId))
    if (!found) {
      // The main thread already ran requestDevice() before sending us 'connect' -- if we still
      // can't see it here, permission genuinely wasn't granted (user dismissed the chooser).
      post({ type: 'connect-error', message: 'USB device permission was not granted.' })
      return
    }
    await found.open()
    if (!found.configuration) await found.selectConfiguration(1)
    const vendorInterface = findVendorInterface(found)
    if (!vendorInterface) { post({ type: 'connect-error', message: 'Selected USB device has no matching vendor interface (wrong device, or firmware is not the WebUSB build).' }); return }
    await found.claimInterface(vendorInterface.interfaceNumber)
    await found.controlTransferOut({ requestType: 'class', recipient: 'interface', request: VENDOR_REQUEST_SET_LINE_STATE, value: 0x0001, index: vendorInterface.interfaceNumber })

    device = found
    interfaceNumber = vendorInterface.interfaceNumber
    endpointIn = vendorInterface.endpointIn
    endpointOut = vendorInterface.endpointOut
    buffer = new Uint8Array()
    reading = true
    credits = CREDIT_WINDOW
    creditWaiters = []
    post({ type: 'connected' })
    readLoop()
  } catch (error) {
    post({ type: 'connect-error', message: error instanceof Error ? error.message : 'Could not connect to USB device' })
  }
}

async function disconnect() {
  reading = false
  const current = device
  device = null
  if (current) {
    await current.controlTransferOut({ requestType: 'class', recipient: 'interface', request: VENDOR_REQUEST_SET_LINE_STATE, value: 0x0000, index: interfaceNumber }).catch(() => undefined)
    await current.releaseInterface(interfaceNumber).catch(() => undefined)
    await current.close().catch(() => undefined)
  }
  interfaceNumber = -1
  endpointIn = -1
  endpointOut = -1
}

async function send(bytes: Uint8Array) {
  if (!device) { post({ type: 'send-error', message: 'USB device is not connected.' }); return }
  try {
    await device.transferOut(endpointOut, bytes)
  } catch (error) {
    // Deliberately not awaited by the main thread's send() (see usbTransport.ts) -- reported here
    // asynchronously instead so a failed command is still visible without making every command
    // send wait on this thread's transferOut() to fully resolve before the caller can continue.
    post({ type: 'send-error', message: error instanceof Error ? error.message : 'USB send failed' })
  }
}

async function readLoop() {
  while (reading && device) {
    await takeCredit()
    if (!reading || !device) break // disconnect() may have run while we were waiting for credit
    try {
      const result = await device.transferIn(endpointIn, READ_CHUNK_SIZE)
      let posted = false
      if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
        posted = consume(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength))
      }
      // No chunk means no corresponding 'ack' will ever arrive from the main thread to return
      // this credit -- a zero-length read, or a read that only completed a partial packet/line
      // with nothing yet ready to emit, are both routine and would otherwise leak one credit each
      // time, eventually stalling the read loop for good even with a main thread that's fully
      // caught up. Granting it back immediately (rather than waiting on an ack) keeps the credit
      // count meaning exactly "chunks currently awaiting processing", not "reads issued".
      if (!posted) grantCredit()
    } catch (error) {
      if (!reading) break // disconnect() already tore this down; not a real failure
      post({ type: 'disconnected', reason: error instanceof Error ? error.message : 'USB read failed' })
      device = null
      break
    }
  }
}

// --- Framing/parsing below is unchanged from the previous main-thread UsbTransport: a stream of
// bytes in, sync-byte/CRC-framed binary telemetry packets and newline-delimited text interleaved
// on the same stream out. The only difference is the sink -- instead of calling handler callbacks
// directly, one chunk's worth of results is collected and posted as a single message so the main
// thread does one batched postMessage-handling task per transferIn() resolution, same as it did
// per read before this file existed. ---

function consume(chunk: Uint8Array): boolean {
  const combined = new Uint8Array(buffer.length + chunk.length)
  combined.set(buffer)
  combined.set(chunk, buffer.length)
  buffer = combined

  const packets: WorkerDecodedPacket[] = []
  const texts: string[] = []

  const emitText = (bytes: Uint8Array) => {
    const text = textDecoder.decode(bytes)
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) texts.push(line.trim())
    }
  }
  const findPacketHeader = (): { index: number; length: number } | null => {
    for (let index = 0; index < buffer.length - 1; index += 1) {
      const first = buffer[index]
      const second = buffer[index + 1]
      if (first === TELEMETRY_SYNC0 && second === TELEMETRY_SYNC1) return { index, length: TELEMETRY_PACKET_LEN }
      if ((first === 0xbb && second === 0xaa) || (first === 0xaa && second === 0xbb)) return { index, length: 8 }
    }
    return null
  }

  while (buffer.length > 0) {
    const header = findPacketHeader()
    if (!header) {
      const newline = buffer.lastIndexOf(0x0a)
      if (newline < 0) break
      emitText(buffer.slice(0, newline + 1))
      buffer = buffer.slice(newline + 1)
      continue
    }
    if (header.index > 0) {
      emitText(buffer.slice(0, header.index))
      buffer = buffer.slice(header.index)
    }
    if (buffer.length < header.length) break
    const raw = buffer.slice(0, header.length)
    const packet = decodePacket(raw)
    if (packet) {
      packets.push({ channel: packet.channel, value: packet.value, tUs: packet.tUs, seq: packet.seq, raw })
      buffer = buffer.slice(header.length)
    } else {
      // Sync bytes matched but the rest failed to validate (bad CRC/channel) -- drop only the
      // sync bytes and keep scanning, instead of discarding the whole tentative packet length, so
      // a false-positive sync match can't swallow real data that follows it.
      emitText(buffer.slice(0, 1))
      buffer = buffer.slice(1)
    }
  }

  if (packets.length || texts.length) { post({ type: 'chunk', packets, texts }); return true }
  return false
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data
  if (message.type === 'connect') void connect(message.vendorId, message.productId)
  else if (message.type === 'send') void send(message.bytes)
  else if (message.type === 'disconnect') void disconnect()
  else if (message.type === 'ack') grantCredit()
}
