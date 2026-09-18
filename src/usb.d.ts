// Minimal WebUSB ambient type declarations -- TypeScript's bundled "DOM" lib does not include the
// WebUSB API (same situation as the Web Serial API previously declared in serial.d.ts), and no
// @types/w3c-web-usb package is installed. Only the surface actually used by usbTransport.ts is
// declared here, not the full spec.

interface USBEndpoint {
  endpointNumber: number
  direction: 'in' | 'out'
  type: 'bulk' | 'interrupt' | 'isochronous'
  packetSize: number
}

interface USBAlternateInterface {
  alternateSetting: number
  interfaceClass: number
  interfaceSubclass: number
  interfaceProtocol: number
  endpoints: USBEndpoint[]
}

interface USBInterface {
  interfaceNumber: number
  alternate: USBAlternateInterface
  alternates: USBAlternateInterface[]
  claimed: boolean
}

interface USBConfiguration {
  configurationValue: number
  interfaces: USBInterface[]
}

interface USBInTransferResult {
  data?: DataView
  status: 'ok' | 'stall' | 'babble'
}

interface USBOutTransferResult {
  bytesWritten: number
  status: 'ok' | 'stall'
}

interface USBControlTransferParameters {
  requestType: 'standard' | 'class' | 'vendor'
  recipient: 'device' | 'interface' | 'endpoint' | 'other'
  request: number
  value: number
  index: number
}

interface USBDevice {
  readonly opened: boolean
  readonly configuration: USBConfiguration | null
  readonly configurations: USBConfiguration[]
  readonly vendorId: number
  readonly productId: number
  readonly productName?: string
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(configurationValue: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>
  transferOut(endpointNumber: number, data: Uint8Array): Promise<USBOutTransferResult>
  controlTransferOut(setup: USBControlTransferParameters, data?: Uint8Array): Promise<USBOutTransferResult>
}

interface USBDeviceFilter {
  vendorId?: number
  productId?: number
  classCode?: number
  subclassCode?: number
  protocolCode?: number
  serialNumber?: string
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[]
}

interface USB {
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>
  getDevices(): Promise<USBDevice[]>
}

interface Navigator {
  usb: USB
}

// WebUSB is also available in dedicated workers (WorkerNavigator.usb) -- see usbWorker.ts, which
// owns the actual USBDevice on its own thread.
interface WorkerNavigator {
  usb: USB
}
