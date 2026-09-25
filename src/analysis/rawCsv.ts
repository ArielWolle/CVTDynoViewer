import type { AnalysisPacket, AnalysisChannelId } from './types'

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

export const RAW_LOG_HEADER = 'firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count'

export function isRawLogCsv(text: string): boolean {
  const first = text.split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith('#'))
  if (!first) return false
  return first.split(',').map((cell) => cell.trim().toLowerCase()).join(',') === RAW_LOG_HEADER
}

export function parseRawLogCsv(text: string): AnalysisPacket[] {
  if (!isRawLogCsv(text)) return []
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#'))
  if (lines.length < 2) return []
  const header = splitCsvLine(lines[0]).map((cell) => cell.trim().toLowerCase())
  const tIndex = header.indexOf('firmware_t_us')
  const channelIndex = header.indexOf('channel')
  const seqIndex = header.indexOf('seq')
  const valueIndex = header.indexOf('raw_value')
  const edgeIndex = header.indexOf('edge_count')
  if ([tIndex, channelIndex, seqIndex, valueIndex, edgeIndex].some((index) => index < 0)) return []

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
  // Preserve the exact file/host arrival order. The analysis engine is deliberately channel-local
  // and must not require a globally timestamp-sorted stream.
  return packets
}
