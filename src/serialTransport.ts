import { decodePacket, TELEMETRY_PACKET_LEN, TELEMETRY_SYNC0, TELEMETRY_SYNC1, type ChannelId } from './protocol'

export type SerialHandlers = {
  onValue: (channel: ChannelId, value: number, tUs: number, seq: number) => void
  onPacket?: (raw: Uint8Array, channel: ChannelId, value: number) => void
  onText: (text: string) => void
}

export class SerialTransport {
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private buffer = new Uint8Array()
  private readonly textDecoder = new TextDecoder()

  constructor(private readonly handlers: SerialHandlers) {}

  get connected() { return this.port !== null }

  async connect() {
    if (!('serial' in navigator)) throw new Error('Web Serial is not supported in this browser.')
    this.port = await navigator.serial.requestPort()
    await this.port.open({ baudRate: 115200 })
    this.writer = this.port.writable?.getWriter() ?? null
    this.readLoop()
  }

  async disconnect() {
    await this.reader?.cancel().catch(() => undefined)
    this.reader?.releaseLock()
    this.reader = null
    this.writer?.releaseLock()
    this.writer = null
    await this.port?.close().catch(() => undefined)
    this.port = null
  }

  async send(bytes: Uint8Array) {
    if (!this.writer) throw new Error('Serial device is not connected.')
    await this.writer.write(bytes)
  }

  private async readLoop() {
    if (!this.port?.readable) return
    this.reader = this.port.readable.getReader()
    try {
      while (true) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value) this.consume(value)
      }
    } catch (error) {
      this.handlers.onText(error instanceof Error ? error.message : 'Serial read failed')
    }
  }

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
