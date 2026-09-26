export type ChartId = 'scatter' | 'rpm1' | 'rpm2' | 'shift' | 'power' | 'efficiency' | 'shiftRatio' | 'shiftEfficiency'
export type ChartConfig = { id: ChartId; title: string; subtitle: string; color: string; visible: boolean }
