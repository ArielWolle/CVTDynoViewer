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

export type WorkerDecodedPacket = { channel: ChannelId; value: number; tUs: number; seq: number; edgeCount: number; raw: Uint8Array }

export type WorkerOutboundMessage =
  | { type: 'connected' }
  | { type: 'connect-error'; message: string }
  | { type: 'disconnected'; reason?: string }
  // overflowDropped is almost always 0 -- see MAX_BUFFERED_PACKETS below -- and is only nonzero
  // when this specific delivery includes a report of packets dropped from the internal buffer
  // since the last delivery (an extreme, sustained main-thread stall well beyond what the buffer's
  // generous cap is sized to absorb).
  | { type: 'chunk'; packets: WorkerDecodedPacket[]; texts: string[]; overflowDropped: number }
  | { type: 'send-error'; message: string }

export type WorkerInboundMessage =
  | { type: 'connect'; vendorId: number; productId: number }
  | { type: 'send'; bytes: Uint8Array }
  | { type: 'disconnect' }
  | { type: 'ack' }

// --- Two decoupled stages: an unthrottled read loop, and a paced delivery loop ------------------
// Earlier this file had ONE combined loop: transferIn() -> decode -> postMessage(), gated by a
// small credit window that only refilled once the main thread acked having processed the previous
// chunk. That tied how fast USB got drained directly to main-thread processing speed -- if the
// main thread was ever behind, the read loop itself stalled, which (worse) could leave the
// firmware's own RPM event ring buffer (a comparatively scarce, fixed-size resource -- see
// EVENT_RING_SIZE in RpmCounter.cpp) filling up and dropping physical edges that the host would
// never even find out about via a sequence-number gap (see protocol.ts's edgeCount comment).
//
// Now: the READ loop (below) never waits on the main thread at all -- it keeps calling
// transferIn() and decoding as fast as the device provides data, appending into the bounded
// buffer below. This is what actually keeps the firmware's ring from overflowing during a
// transient host-side stall: the device's own tiny local FIFO gets drained continuously, so
// usb_web.write() on the firmware side never blocks waiting for the host. The DELIVERY loop
// (tryDeliver(), triggered after every buffer push and every 'ack') is the only place backpressure
// from the main thread still applies -- it hands off bounded batches, gated by a small credit
// window exactly like before, so the browser's own internal postMessage queue can't grow without
// bound either. The bounded backlog this whole scheme can ever accumulate now lives in cheap,
// effectively-unlimited host RAM (see MAX_BUFFERED_PACKETS) instead of the firmware's scarce RAM
// or the main thread's now-decoupled processing rate.
// Shared cap for both buffers below (not just packets, despite the name) -- text lines are rare
// (config dumps, diagnostics) compared to packets and would never realistically approach this on
// their own, so one generous constant for both keeps this simple without meaningfully changing the
// worst-case memory bound.
const MAX_BUFFERED_PACKETS = 50_000 // a few MB worst case -- comfortably absorbs any realistic stall
const DELIVERY_BATCH_SIZE = 500 // caps how much a single delivered message asks the main thread to process at once
const DELIVERY_CREDIT_WINDOW = 2

let bufferedPackets: WorkerDecodedPacket[] = []
let bufferedTexts: string[] = []
let bufferOverflowDropped = 0
let deliveryCredits = DELIVERY_CREDIT_WINDOW

// Drop-newest on overflow, matching the same policy the firmware's own ring buffer uses (see
// RpmCounter.cpp's pushEdge()) -- and count it instead of growing without bound or silently
// discarding without any visibility.
function bufferPacket(packet: WorkerDecodedPacket) {
  if (bufferedPackets.length >= MAX_BUFFERED_PACKETS) { bufferOverflowDropped++; return }
  bufferedPackets.push(packet)
}
function bufferText(text: string) {
  if (bufferedTexts.length >= MAX_BUFFERED_PACKETS) { bufferOverflowDropped++; return }
  bufferedTexts.push(text)
}

function tryDeliver() {
  while (deliveryCredits > 0 && (bufferedPackets.length > 0 || bufferedTexts.length > 0)) {
    const packets = bufferedPackets.splice(0, DELIVERY_BATCH_SIZE)
    const texts = bufferedTexts.splice(0, DELIVERY_BATCH_SIZE)
    deliveryCredits -= 1
    const overflowDropped = bufferOverflowDropped
    bufferOverflowDropped = 0
    post({ type: 'chunk', packets, texts, overflowDropped })
  }
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
    bufferedPackets = []
    bufferedTexts = []
    bufferOverflowDropped = 0
    deliveryCredits = DELIVERY_CREDIT_WINDOW
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

// Unthrottled: no credit/backpressure of any kind here -- see the top-of-file comment for why.
async function readLoop() {
  while (reading && device) {
    try {
      const result = await device.transferIn(endpointIn, READ_CHUNK_SIZE)
      if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
        consume(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength))
      }
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
// on the same stream out. The only difference is the sink -- decoded packets/texts are appended to
// the bounded buffer above (then handed off by the separate, paced delivery loop) instead of being
// posted directly here. ---

function consume(chunk: Uint8Array) {
  const combined = new Uint8Array(buffer.length + chunk.length)
  combined.set(buffer)
  combined.set(chunk, buffer.length)
  buffer = combined

  const emitText = (bytes: Uint8Array) => {
    const text = textDecoder.decode(bytes)
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) bufferText(line.trim())
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
      bufferPacket({ channel: packet.channel, value: packet.value, tUs: packet.tUs, seq: packet.seq, edgeCount: packet.edgeCount, raw })
      buffer = buffer.slice(header.length)
    } else {
      // Sync bytes matched but the rest failed to validate (bad CRC/channel) -- drop only the
      // sync bytes and keep scanning, instead of discarding the whole tentative packet length, so
      // a false-positive sync match can't swallow real data that follows it.
      emitText(buffer.slice(0, 1))
      buffer = buffer.slice(1)
    }
  }

  tryDeliver()
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const message = event.data
  if (message.type === 'connect') void connect(message.vendorId, message.productId)
  else if (message.type === 'send') void send(message.bytes)
  else if (message.type === 'disconnect') void disconnect()
  else if (message.type === 'ack') { deliveryCredits += 1; tryDeliver() }
}
