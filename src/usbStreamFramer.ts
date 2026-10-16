import { decodePacket, TELEMETRY_PACKET_LEN, TELEMETRY_SYNC0, TELEMETRY_SYNC1, type DecodedPacket } from './protocol'

const MAX_UNFRAMED_BYTES = 8192

// One decoder for the mixed vendor-bulk stream: CRC-framed binary data and newline-delimited
// ASCII firmware replies can arrive in arbitrary USB transfer boundaries, even mid-line/frame.
export class UsbStreamFramer {
  private pending = new Uint8Array()
  private pendingText = ''
  private decoder = new TextDecoder()

  constructor(
    private readonly onPacket: (packet: DecodedPacket, raw: Uint8Array) => void,
    private readonly onText: (text: string) => void,
  ) {}

  reset() {
    this.pending = new Uint8Array()
    this.pendingText = ''
    this.decoder = new TextDecoder()
  }

  push(chunk: Uint8Array): void {
    const combined = new Uint8Array(this.pending.length + chunk.length)
    combined.set(this.pending)
    combined.set(chunk, this.pending.length)
    this.pending = combined

    while (this.pending.length) {
      const header = this.findSync()
      if (header >= 0) {
        if (header > 0) this.consumeTextBytes(header)
        if (this.pending.length < TELEMETRY_PACKET_LEN) break
        const raw = this.pending.slice(0, TELEMETRY_PACKET_LEN)
        const decoded = decodePacket(raw)
        if (decoded) {
          this.onPacket(decoded, raw)
          this.pending = this.pending.slice(TELEMETRY_PACKET_LEN)
        } else {
          // CRC failure or false header: move one byte, not an entire candidate packet,
          // so the real frame following a corrupt prefix can still be recovered.
          this.pending = this.pending.slice(1)
        }
        continue
      }
      const lastNewline = this.pending.lastIndexOf(0x0a)
      if (lastNewline >= 0) {
        this.consumeTextBytes(lastNewline + 1)
        continue
      }
      // A solitary AA at the end might be the first half of the sync pair. Otherwise this is
      // unfinished text, which must be retained until a newline or binary header arrives.
      if (this.pending.length > MAX_UNFRAMED_BYTES) {
        this.pending = this.pending.slice(-MAX_UNFRAMED_BYTES)
        this.pendingText = ''
        this.decoder = new TextDecoder()
      }
      break
    }
  }

  private findSync(): number {
    for (let i = 0; i < this.pending.length - 1; i += 1) {
      if (this.pending[i] === TELEMETRY_SYNC0 && this.pending[i + 1] === TELEMETRY_SYNC1) return i
    }
    return -1
  }

  private consumeTextBytes(count: number) {
    const prefix = this.pending.subarray(0, count)
    this.pending = this.pending.slice(count)
    this.pendingText += this.decoder.decode(prefix, { stream: true })
    const lines = this.pendingText.split(/\r?\n/)
    this.pendingText = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) this.onText(line.trim())
    }
  }
}
