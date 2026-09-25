import type { AnalysisFrame } from './types'

export const processedAnalysisHeader = 'timestamp_s,primary_rpm,secondary_rpm,shift_position_percent,primary_power_kw,secondary_power_kw,efficiency_percent,shift_ratio,full_throttle'

export function analysisFramesToCsv(frames: readonly AnalysisFrame[]): string {
  const rows = frames.map((frame) => [
    (frame.time / 1000).toFixed(6),
    frame.rpm1.toFixed(3),
    frame.rpm2.toFixed(3),
    frame.shift.toFixed(4),
    frame.power1.toFixed(5),
    frame.power2.toFixed(5),
    Number.isFinite(frame.efficiency) ? frame.efficiency.toFixed(4) : '',
    frame.shiftRatio.toFixed(6),
    frame.fullThrottle ? '1' : '0',
  ].join(','))
  return [processedAnalysisHeader, ...rows].join('\n')
}
