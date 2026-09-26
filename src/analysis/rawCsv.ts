import type { AnalysisPacket, AnalysisChannelId } from './types'
import { RAW_LOG_HEADER, parseEmbeddedRawMetadata, type RawSessionMetadata } from '../session/rawFormat'

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { current += '"'; index += 1 } else quoted = false
      } else current += char
    } else if (char === '"') quoted = true
    else if (char === ',') { cells.push(current); current = '' }
    else current += char
  }
  cells.push(current)
  return cells
}

export { RAW_LOG_HEADER } from '../session/rawFormat'

export type ParsedRawLog = {
  packets: AnalysisPacket[]
  metadata: RawSessionMetadata | null
}

export function isRawLogCsv(text: string): boolean {
  const first = text.split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith('#'))
  if (!first) return false
  return first.split(',').map((cell) => cell.trim().toLowerCase()).join(',') === RAW_LOG_HEADER
}

export function parseRawLog(text: string): ParsedRawLog {
  const metadata = parseEmbeddedRawMetadata(text)
  if (!isRawLogCsv(text)) return { packets: [], metadata }

  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'))
  if (lines.length < 2) return { packets: [], metadata }

  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
  const tIndex = header.indexOf('firmware_t_us')
  const channelIndex = header.indexOf('channel')
  const seqIndex = header.indexOf('seq')
  const valueIndex = header.indexOf('raw_value')
  const edgeIndex = header.indexOf('edge_count')
  if ([tIndex, channelIndex, seqIndex, valueIndex, edgeIndex].some((index) => index < 0)) return { packets: [], metadata }

  const packets: AnalysisPacket[] = []
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const cells = splitCsvLine(lines[lineIndex])
    const tUs = Number(cells[tIndex])
    const channel = Number(cells[channelIndex])
    const seq = Number(cells[seqIndex])
    const value = Number(cells[valueIndex])
    const edgeCount = Number(cells[edgeIndex])
    if (!Number.isFinite(tUs) || !Number.isInteger(channel) || channel < 0 || channel > 5 || !Number.isFinite(seq) || !Number.isFinite(value) || !Number.isFinite(edgeCount)) continue
    packets.push({ channel: channel as AnalysisChannelId, value, tUs, seq, edgeCount })
  }

  return { packets, metadata }
}

export function parseRawLogCsv(text: string): AnalysisPacket[] {
  return parseRawLog(text).packets
}
