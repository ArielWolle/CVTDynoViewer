import { decodePacket, TELEMETRY_PACKET_LEN, TELEMETRY_SYNC0, TELEMETRY_SYNC1, type ChannelId } from './protocol'

export type UsbHandlers = {
  onValue: (channel: ChannelId, value: number, tUs: number, seq: number) => void
  onPacket?: (raw: Uint8Array, channel: ChannelId, value: number) => void
  onText: (text: string) => void
}

// TinyUSB's vendor-class descriptor (see Adafruit_USBD_WebUSB::getInterfaceDescriptor(), which
// uses TUD_VENDOR_DESCRIPTOR) declares a standard vendor-specific interface: class 0xFF, subclass
// 0x00, protocol 0x00. Used to pick the firmware's telemetry interface out of the device's USB
// configuration rather than assuming it's always interface 0 (robust if a future firmware version
// adds another interface before/after it).
const VENDOR_INTERFACE_CLASS = 0xff
const VENDOR_INTERFACE_SUBCLASS = 0x00
const VENDOR_INTERFACE_PROTOCOL = 0x00

// Adafruit_USBD_WebUSB internally simulates the CDC SET_CONTROL_LINE_STATE request (bRequest
// 0x22) to track a "connected" flag -- see Adafruit_USBD_WebUSB.cpp's tud_vendor_control_xfer_cb.
// Until the host sends this, the firmware's usb_web.write() loops on `while (remain && _connected)`
// and never actually transmits anything: this is NOT optional for telemetry to flow, it's the
// WebUSB-vendor-class equivalent of a serial port's DTR line going high.
const VENDOR_REQUEST_SET_LINE_STATE = 0x22

// How many bytes to request per transferIn() call. A single call can return multiple coalesced
// USB bulk packets (up to this many bytes), so this is a throughput/latency tradeoff, not a
// hard protocol limit -- comfortably above the largest realistic burst between reads.
const READ_CHUNK_SIZE = 4096

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

export class UsbTransport {
  private device: USBDevice | null = null
  private interfaceNumber = -1
  private endpointIn = -1
  private endpointOut = -1
  private buffer = new Uint8Array()
  private readonly textDecoder = new TextDecoder()
  private reading = false

  constructor(private readonly handlers: UsbHandlers) {}

  get connected() { return this.device !== null }

  async connect() {
    if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser.')
    // Empty filter list shows every USB device the OS/browser will allow raw access to in the
    // chooser -- we don't hardcode a VID/PID here since the firmware doesn't customize them.
    const device = await navigator.usb.requestDevice({ filters: [] })
    await device.open()
    if (!device.configuration) await device.selectConfiguration(1)

    const found = findVendorInterface(device)
    if (!found) throw new Error('Selected USB device has no matching vendor interface (wrong device, or firmware is not the WebUSB build).')

    await device.claimInterface(found.interfaceNumber)
    // See VENDOR_REQUEST_SET_LINE_STATE comment above -- required before the firmware will
    // actually transmit telemetry, not just a nicety.
    await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: VENDOR_REQUEST_SET_LINE_STATE, value: 0x0001, index: found.interfaceNumber })

    this.device = device
    this.interfaceNumber = found.interfaceNumber
    this.endpointIn = found.endpointIn
    this.endpointOut = found.endpointOut
    this.buffer = new Uint8Array()
    this.reading = true
    this.readLoop()
  }

  async disconnect() {
    this.reading = false
    const device = this.device
    this.device = null
    if (device) {
      await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: VENDOR_REQUEST_SET_LINE_STATE, value: 0x0000, index: this.interfaceNumber }).catch(() => undefined)
      await device.releaseInterface(this.interfaceNumber).catch(() => undefined)
      await device.close().catch(() => undefined)
    }
    this.interfaceNumber = -1
    this.endpointIn = -1
    this.endpointOut = -1
  }

  async send(bytes: Uint8Array) {
    if (!this.device) throw new Error('USB device is not connected.')
    await this.device.transferOut(this.endpointOut, bytes)
  }

  private async readLoop() {
    while (this.reading && this.device) {
      try {
        const result = await this.device.transferIn(this.endpointIn, READ_CHUNK_SIZE)
        if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
          this.consume(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength))
        }
      } catch (error) {
        if (!this.reading) break // disconnect() already tore this down; not a real failure
        this.handlers.onText(error instanceof Error ? error.message : 'USB read failed')
        this.device = null
        break
      }
    }
  }

  // --- Framing/parsing below is transport-agnostic and unchanged from the previous Web Serial
  // transport: a stream of bytes in, sync-byte/CRC-framed binary telemetry packets and newline-
  // delimited text interleaved on the same stream out. ---

  private consume(chunk: Uint8Array) {
    const combined = new Uint8Array(this.buffer.length + chunk.length)
    combined.set(this.buffer)
    combined.set(chunk, this.buffer.length)
    this.buffer = combined
    while (this.buffer.length > 0) {
      const header = this.findPacketHeader()
      if (!header) {
        const newline = this.buffer.lastIndexOf(0x0a)
        if (newline < 0) return
        this.emitText(this.buffer.slice(0, newline + 1))
        this.buffer = this.buffer.slice(newline + 1)
        continue
      }
      if (header.index > 0) {
        this.emitText(this.buffer.slice(0, header.index))
        this.buffer = this.buffer.slice(header.index)
      }
      if (this.buffer.length < header.length) return
      const packet = decodePacket(this.buffer.slice(0, header.length))
      if (packet) {
        this.handlers.onPacket?.(this.buffer.slice(0, header.length), packet.channel, packet.value)
        this.handlers.onValue(packet.channel, packet.value, packet.tUs, packet.seq)
        this.buffer = this.buffer.slice(header.length)
      } else {
        // Sync bytes matched but the rest failed to validate (bad CRC/channel) -- drop only the
        // sync bytes and keep scanning, instead of discarding the whole tentative packet length,
        // so a false-positive sync match can't swallow real data that follows it.
        this.emitText(this.buffer.slice(0, 1))
        this.buffer = this.buffer.slice(1)
      }
    }
  }

  private findPacketHeader(): { index: number; length: number } | null {
    for (let index = 0; index < this.buffer.length - 1; index += 1) {
      const first = this.buffer[index]
      const second = this.buffer[index + 1]
      if (first === TELEMETRY_SYNC0 && second === TELEMETRY_SYNC1) return { index, length: TELEMETRY_PACKET_LEN }
      if ((first === 0xbb && second === 0xaa) || (first === 0xaa && second === 0xbb)) return { index, length: 8 }
    }
    return null
  }

  private emitText(bytes: Uint8Array) {
    const text = this.textDecoder.decode(bytes)
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) this.handlers.onText(line.trim())
    }
  }
}
