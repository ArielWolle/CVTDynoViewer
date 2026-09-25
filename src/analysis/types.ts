export type AnalysisChannelId = 0 | 1 | 2 | 3 | 4 | 5
export type AnalysisPowerMode = 'inertia' | 'torque'
export type RpmObservationMode = 'revolution' | 'tooth'

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
  observationMode: RpmObservationMode
}

export type RpmObservation = {
  time: number // firmware time in milliseconds
  rpm: number
  sigmaRpm: number
}

export type AnalysisFrame = {
  time: number // firmware time in milliseconds, at the end of the analysis interval
  rpm1: number
  rpm2: number
  rpm1Sigma: number
  rpm2Sigma: number
  shift: number
  torq1: number
  torq2: number
  power1: number // kW, interval-averaged
  power2: number // kW, interval-averaged; signed outside efficiency use
  efficiency: number // NaN when the interval is not valid for an efficiency estimate
  shiftRatio: number
  fullThrottle: boolean // true only when the ENTIRE analysis interval was WOT
}

export type AnalysisSnapshot = {
  frames: AnalysisFrame[]
  primaryObservations: RpmObservation[]
  secondaryObservations: RpmObservation[]
}

export const ANALYSIS_WINDOWS_MS = [5, 10, 20, 50, 100, 250] as const
export const DEFAULT_ANALYSIS_WINDOW_MS = 100
export const DEFAULT_SECONDARY_INERTIA_KG_M2 = 0.3134

export type AnalysisUpdate =
  | { type: 'replace'; snapshot: AnalysisSnapshot }
  | { type: 'append'; snapshot: AnalysisSnapshot }
