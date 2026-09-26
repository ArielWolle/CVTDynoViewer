import { RAW_LOG_HEADER, rawMetadataComment, type RawSessionMetadata } from './rawFormat'

const RAW_LOG_FLUSH_BYTES = 65_536
const RAW_LOG_FLUSH_DEBOUNCE_MS = 200
const CHANNEL_NAMES = ['Primary RPM', 'Secondary RPM', 'Shift position', 'Primary torque', 'Secondary torque', 'Full throttle'] as const

export type { RawSessionMetadata } from './rawFormat'

function csvEscape(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function rawLogRow(channel: number, value: number, tUs: number, wallTimeMs: number, seq: number, edgeCount: number): string {
  return [tUs, (wallTimeMs / 1000).toFixed(6), channel, CHANNEL_NAMES[channel] ?? `Channel ${channel}`, seq, value, edgeCount].map(csvEscape).join(',')
}

export class RawSessionLogger {
  constructor(private readonly onError?: (message: string) => void) {}

  private directory: FileSystemDirectoryHandle | null = null
  private writer: FileSystemWritableFileStream | null = null
  private pending = ''
  private flushTimer: number | undefined
  private flushPromise: Promise<void> | null = null
  private active = false
  private rawFileName = ''
  private metadataFileName = ''
  private metadata: RawSessionMetadata | null = null

  get isActive() { return this.active }
  get fileName() { return this.rawFileName }

  async start(directory: FileSystemDirectoryHandle, sessionName: string, metadata: RawSessionMetadata) {
    if (this.active) throw new Error('Raw logger is already active')
    this.directory = directory
    this.pending = ''
    this.metadata = metadata

    const base = (sessionName.trim() || 'cvt-dyno-session').replace(/[<>:"/\\|?*]/g, '-')
    const stem = await this.nextAvailableStem(directory, base)
    this.rawFileName = `${stem}-raw.csv`
    this.metadataFileName = `${stem}-meta.json`

    const file = await directory.getFileHandle(this.rawFileName, { create: true })
    const initial = await file.createWritable()
    await initial.write(`${rawMetadataComment(metadata)}\n${RAW_LOG_HEADER}\n`)
    await initial.close()
    await this.openWriter()
    await this.writeMetadata(metadata)
    this.active = true
  }

  append(channel: number, value: number, tUs: number, wallTimeMs: number, seq: number, edgeCount: number) {
    if (!this.active) return
    this.pending += rawLogRow(channel, value, tUs, wallTimeMs, seq, edgeCount) + '\n'
    if (this.pending.length >= RAW_LOG_FLUSH_BYTES) {
      if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer)
      this.flushTimer = undefined
      void this.flush(true).catch(() => this.onError?.('Could not commit the raw log file'))
    } else if (this.flushTimer === undefined) {
      this.flushTimer = window.setTimeout(() => { this.flushTimer = undefined; void this.flush(true).catch(() => this.onError?.('Could not commit the raw log file')) }, RAW_LOG_FLUSH_DEBOUNCE_MS)
    }
  }

  async stop(finalMetadata?: RawSessionMetadata) {
    if (!this.active && !this.writer) return
    this.active = false
    if (this.flushTimer !== undefined) window.clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    if (this.flushPromise) await this.flushPromise
    await this.flush(false)
    if (this.writer) await this.writer.close().catch(() => undefined)
    this.writer = null
    if (finalMetadata) {
      this.metadata = finalMetadata
      await this.writeMetadata(finalMetadata)
    }
  }

  private async nextAvailableStem(directory: FileSystemDirectoryHandle, base: string): Promise<string> {
    for (let index = 1; index < 10000; index += 1) {
      const stem = index === 1 ? base : `${base}-${index}`
      try { await directory.getFileHandle(`${stem}-raw.csv`) } catch { return stem }
    }
    throw new Error('Could not find an available raw log filename')
  }

  private async openWriter() {
    if (!this.directory) throw new Error('No logging directory selected')
    const file = await this.directory.getFileHandle(this.rawFileName, { create: true })
    const writer = await file.createWritable({ keepExistingData: true })
    await writer.seek((await file.getFile()).size)
    this.writer = writer
  }

  private async flush(reopen: boolean) {
    if (this.flushPromise) return this.flushPromise
    if (!this.pending) return
    this.flushPromise = this.doFlush(reopen).finally(() => { this.flushPromise = null })
    return this.flushPromise
  }

  private async doFlush(reopen: boolean) {
    if (!this.writer) await this.openWriter()
    if (!this.writer || !this.pending) return
    const rows = this.pending
    this.pending = ''
    const writer = this.writer
    try {
      await writer.write(rows)
      await writer.close()
      this.writer = null
      if (reopen && this.active) await this.openWriter()
    } catch (error) {
      this.pending = rows + this.pending
      this.writer = null
      if (reopen && this.active) await this.openWriter().catch(() => undefined)
      throw error
    } finally {
      if (reopen && this.active && this.pending && this.flushTimer === undefined) {
        this.flushTimer = window.setTimeout(() => { this.flushTimer = undefined; void this.flush(true).catch(() => this.onError?.('Could not commit the raw log file')) }, RAW_LOG_FLUSH_DEBOUNCE_MS)
      }
    }
  }

  private async writeMetadata(metadata: RawSessionMetadata) {
    if (!this.directory || !this.metadataFileName) return
    const file = await this.directory.getFileHandle(this.metadataFileName, { create: true })
    const writer = await file.createWritable()
    await writer.write(`${JSON.stringify(metadata, null, 2)}\n`)
    await writer.close()
  }
}
