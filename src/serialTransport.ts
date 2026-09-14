import { decodePacket, type ChannelId } from './protocol'

export type SerialHandlers = {
  onValue: (channel: ChannelId, value: number) => void
  onText: (text: string) => void
}

export class SerialTransport {
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private buffer = new Uint8Array()

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
    while (this.buffer.length >= 8) {
      const header = this.buffer.findIndex((byte) => byte === 0xaa)
      if (header < 0) { this.buffer = new Uint8Array(); return }
      if (header > 0) this.buffer = this.buffer.slice(header)
      if (this.buffer.length < 8) return
      const packet = decodePacket(this.buffer.slice(0, 8))
      if (packet) this.handlers.onValue(packet.channel, packet.value)
      this.buffer = this.buffer.slice(8)
    }
  }
}
