export type AnalysisChannelId = 0 | 1 | 2 | 3 | 4 | 5
export type AnalysisPowerMode = 'inertia' | 'torque'
// Display-only choice. The analysis engine always retains both observation families.
export type RpmObservationMode = 'none' | 'revolution' | 'tooth'

export type EngineTorquePoint = { rpm: number; torque: number }

export type AnalysisPacket = {
  channel: AnalysisChannelId
  value: number
  tUs: number
  seq: number
  edgeCount: number
}

export type AnalysisConfig = {
  windowMs: number
  primaryTeeth: number
  secondaryTeeth: number
  secondaryInertiaKgM2: number
  torqueCurve: EngineTorquePoint[]
  powerMode: AnalysisPowerMode
  torqueScale: number
  torqueOffset: number
}

export type RpmObservation = {
  time: number
  rpm: number
  sigmaRpm: number
}

export type RpmObservationView = {
  primary: RpmObservation[]
  secondary: RpmObservation[]
}

export type RpmPoint = {
  time: number
  rpm: number
  sigmaRpm: number
}

export type PowerPoint = {
  time: number
  powerKw: number
}

export type ShiftPoint = {
  time: number
  value: number
}

export type RatioPoint = {
  time: number
  rpm1: number
  rpm2: number
  ratio: number
}

export type EfficiencyPoint = {
  time: number
  power1Kw: number
  power2Kw: number
  efficiencyPct: number
  ratio: number
}

export type AnalysisSnapshot = {
  primaryRpm: RpmPoint[]
  secondaryRpm: RpmPoint[]
  primaryPower: PowerPoint[]
  secondaryPower: PowerPoint[]
  ratio: RatioPoint[]
  efficiency: EfficiencyPoint[]
  shift: ShiftPoint[]
}

export type AnalysisCounts = {
  primaryRpm: number
  secondaryRpm: number
  primaryPower: number
  secondaryPower: number
  ratio: number
  efficiency: number
  shift: number
}

export const ANALYSIS_WINDOWS_MS = [5, 10, 20, 50, 100, 250] as const
export const DEFAULT_ANALYSIS_WINDOW_MS = 100
export const DEFAULT_SECONDARY_INERTIA_KG_M2 = 0.3134

export type AnalysisUpdate =
  | { type: 'replace'; snapshot: AnalysisSnapshot }
  | { type: 'append'; snapshot: AnalysisSnapshot }
