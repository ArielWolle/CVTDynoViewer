import { COMMAND_PACKET_LEN, COMMAND_SYNC, EXPECTED_PROTOCOL_VERSION, TELEMETRY_PACKET_LEN, TELEMETRY_SYNC0, TELEMETRY_SYNC1, crc8 } from '../protocol'

// This is a WebUSB device double, NOT a COM-port or chart-data mock. The ordinary USB worker
// opens, configures, claims, reads and writes this object exactly as it does a USBDevice.
// Wire semantics follow ArielWolle/CVTDynoFirmware src/main.cpp (protocol v2).
export type VirtualUsbScenario = 'normal' | 'fragmented' | 'unplug' | 'claim-error'

// Exact injection points for reproducible unit tests. The UI's combined fault
// scenario remains unchanged; these overrides let each failure be isolated.
export type VirtualUsbFaultPlan = Readonly<{
  fragmentTransfers?: boolean
  corruptPacketOrdinals?: readonly number[]
  dropOutgoingPacketOrdinals?: readonly number[]
  dropBufferedEdgeCounts?: Partial<Record<0 | 1, readonly number[]>>
  missSensorToothOrdinals?: Partial<Record<0 | 1, readonly number[]>>
  stallOutTransferOrdinal?: number
}>

type PendingRead = {
  length: number
  resolve: (value: USBInTransferResult) => void
  reject: (error: Error) => void
}

const CONFIGURATION_VALUE = 1
const INTERFACE_NUMBER = 0
const ENDPOINT_IN = 1
const ENDPOINT_OUT = 2

export class VirtualUsbDevice implements USBDevice {
  readonly vendorId = 0x1209
  readonly productId = 0xcd10
  readonly productName = 'CVT Dyno (virtual RP2040)'
  readonly configurations: USBConfiguration[]
  configuration: USBConfiguration | null = null
  opened = false
  get bufferedBytes(): number { return this.output.length }

  private lineState = false
  private timer: ReturnType<typeof setInterval> | null = null
  private reads: PendingRead[] = []
  private output: number[] = []
  private commandBytes: number[] = []
  private chunkIndex = 0
  private startedMs = 0
  private intentionallyUnplugged = false
  private seq = [0, 0, 0, 0, 0, 0]
  private edgeCounts = [0, 0]
  private physicalToothCount = [0, 0]
  private lastAcceptedEdgeUs = [0, 0]
  private nextEdgeUs = [1_000_000, 1_000_000]
  private nextPollUs = [0, 0, 1_000_000, 1_000_000, 1_000_000]
  private channels = [true, true, true, true, true]
  private frequencies = [0, 0, 10, 50, 50]
  private benchMode = true
  private stoppedSent = [false, false]
  private benchDisabledAtUs = 0
  private rpmPinTest = false
  private rpmInterruptTest = false
  private rpmCountTest = false
  private lastDiagnosticUs = 0
  private lastThrottle = -1
  private sentPackets = 0
  private outTransfers = 0

  constructor(readonly scenario: VirtualUsbScenario = 'normal',
    private readonly faultPlan: VirtualUsbFaultPlan = {}) {
    const alternate: USBAlternateInterface = {
      alternateSetting: 0,
      interfaceClass: 0xff,
      interfaceSubclass: 0,
      interfaceProtocol: 0,
      endpoints: [
        { endpointNumber: ENDPOINT_IN, direction: 'in', type: 'bulk', packetSize: 64 },
        { endpointNumber: ENDPOINT_OUT, direction: 'out', type: 'bulk', packetSize: 64 },
      ],
    }
    this.configurations = [{
      configurationValue: CONFIGURATION_VALUE,
      interfaces: [{ interfaceNumber: INTERFACE_NUMBER, alternate, alternates: [alternate], claimed: false }],
    }]
  }

  async open(): Promise<void> {
    if (this.opened) throw new Error('Virtual USB device is already open')
    this.opened = true
    this.intentionallyUnplugged = false
    this.startedMs = performance.now()
    this.timer = setInterval(() => this.tick(), 10)
  }

  async close(): Promise<void> {
    this.opened = false
    this.lineState = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const config of this.configurations) {
      for (const iface of config.interfaces) iface.claimed = false
    }
    this.configuration = null
    this.output = []
    const reads = this.reads.splice(0)
    for (const read of reads) read.reject(new Error(this.intentionallyUnplugged
      ? 'Simulated RP2040 unplugged after 5 seconds (intentional test)'
      : 'Virtual USB device closed'))
  }

  async selectConfiguration(value: number): Promise<void> {
    if (!this.opened) throw new Error('USB device is not open')
    const config = this.configurations.find((item) => item.configurationValue === value)
    if (!config) throw new Error('Unknown USB configuration')
    this.configuration = config
  }

  async claimInterface(number: number): Promise<void> {
    if (!this.opened || !this.configuration) throw new Error('USB device is not configured')
    if (this.scenario === 'claim-error') throw new Error('Simulated claimInterface failure')
    const iface = this.configuration.interfaces.find((item) => item.interfaceNumber === number)
    if (!iface) throw new Error('No such USB interface')
    if (iface.claimed) throw new Error('USB interface already claimed')
    iface.claimed = true
  }

  async releaseInterface(number: number): Promise<void> {
    const iface = this.configuration?.interfaces.find((item) => item.interfaceNumber === number)
    if (iface) iface.claimed = false
  }

  async controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult> {
    this.assertClaimed()
    if (setup.requestType !== 'class' || setup.recipient !== 'interface' || setup.request !== 0x22 || setup.index !== INTERFACE_NUMBER) {
      throw new Error('Unsupported USB control transfer')
    }
    this.lineState = setup.value === 1
    return { status: 'ok', bytesWritten: 0 }
  }

  async transferOut(endpoint: number, data: Uint8Array): Promise<USBOutTransferResult> {
    this.assertReady()
    if (endpoint !== ENDPOINT_OUT) throw new Error('Incorrect USB OUT endpoint')
    this.outTransfers += 1
    if (this.faultPlan.stallOutTransferOrdinal === this.outTransfers) {
      throw new Error('Injected USB OUT transfer stall')
    }
    for (const byte of data) this.commandBytes.push(byte)
    // Same sync-seeking, fixed-five-byte framing as handleIncomingCommands() in the firmware.
    while (this.commandBytes.length) {
      if (this.commandBytes[0] !== COMMAND_SYNC) {
        this.commandBytes.shift()
        continue
      }
      if (this.commandBytes.length < COMMAND_PACKET_LEN) break
      const frame = this.commandBytes.splice(0, COMMAND_PACKET_LEN)
      this.handleCommand(frame[1], frame[2], frame[3] * 256 + frame[4])
    }
    return { status: 'ok', bytesWritten: data.byteLength }
  }

  async transferIn(endpoint: number, length: number): Promise<USBInTransferResult> {
    this.assertReady()
    if (endpoint !== ENDPOINT_IN || length < 1) throw new Error('Incorrect USB IN endpoint')
    if (this.output.length) return this.takeBytes(length)
    return new Promise<USBInTransferResult>((resolve, reject) => {
      this.reads.push({ length, resolve, reject })
    })
  }

  private assertClaimed(): void {
    if (!this.opened || !this.configuration?.interfaces[0]?.claimed) {
      throw new Error(this.intentionallyUnplugged
        ? 'Simulated RP2040 unplugged after 5 seconds (intentional test)'
        : 'Virtual USB interface is not claimed')
    }
  }

  private assertReady(): void {
    this.assertClaimed()
    if (!this.lineState) throw new Error('Virtual USB line state is not enabled')
  }

  private append(bytes: Uint8Array): void {
    for (const byte of bytes) this.output.push(byte)
    this.wakeReads()
  }

  private writeText(value: string): void {
    this.append(new TextEncoder().encode(value))
  }

  private wakeReads(): void {
    while (this.reads.length && this.output.length && this.opened) {
      const read = this.reads.shift()!
      read.resolve(this.takeBytes(read.length))
    }
  }

  private takeBytes(length: number): USBInTransferResult {
    // The browser's transfer boundaries do not coincide with telemetry frame boundaries.
    const sizes = (this.scenario === 'fragmented' || this.faultPlan.fragmentTransfers)
      ? [1, 3, 7, 2, 21, 5, 13, 64, 11, 37] : [64, 19, 127, 31, 7, 88]
    const count = Math.min(length, this.output.length, sizes[this.chunkIndex++ % sizes.length])
    const bytes = new Uint8Array(this.output.splice(0, count))
    return { status: 'ok', data: new DataView(bytes.buffer) }
  }

  private makePacket(channel: number, value: number, timeUs: number, edgeCount = 0): Uint8Array {
    const packet = new Uint8Array(TELEMETRY_PACKET_LEN)
    packet[0] = TELEMETRY_SYNC0
    packet[1] = TELEMETRY_SYNC1
    packet[2] = channel
    packet[3] = this.seq[channel]++ & 0xff
    const view = new DataView(packet.buffer)
    view.setInt32(4, value, true)
    view.setUint32(8, timeUs >>> 0, true)
    view.setUint32(12, Math.floor(timeUs / 0x100000000), true)
    view.setUint32(16, edgeCount >>> 0, true)
    packet[20] = crc8(packet.subarray(2, 20))
    this.sentPackets += 1
    // Corrupted packet -> downstream sequence gap. Omitted physical RPM edge -> edgeCount gap.
    if ((this.scenario === 'fragmented' && this.sentPackets % 173 === 0) ||
        this.faultPlan.corruptPacketOrdinals?.includes(this.sentPackets)) packet[20] ^= 0xff
    return packet
  }

  private sendPacket(channel: number, value: number, timeUs: number, edgeCount = 0): void {
    const packet = this.makePacket(channel, value, timeUs, edgeCount)
    // A packet may be assigned a transmit sequence number and then never
    // arrive in the browser. This must not alter the firmware-side edge count.
    if (this.faultPlan.dropOutgoingPacketOrdinals?.includes(this.sentPackets)) return
    this.append(packet)
  }

  private tick(): void {
    if (!this.opened || !this.lineState || !this.configuration?.interfaces[0]?.claimed) return
    const elapsedUs = Math.max(1, Math.floor((performance.now() - this.startedMs) * 1000))
    if (this.scenario === 'unplug' && elapsedUs > 5_000_000) {
      this.intentionallyUnplugged = true
      void this.close()
      return
    }
    const timeUs = 1_000_000 + elapsedUs
    const t = elapsedUs / 1_000_000
    const envelope = Math.sin(Math.PI * ((t % 60) / 60))
    const rpm = [
      3000 + Math.sin(t) * 400 + Math.sin(t * 0.015) * 200 + envelope * 3000,
      3000 - envelope * 2200 + Math.sin(t - 0.55) * 300 + Math.sin(t * 0.011 - 0.3) * 150,
    ]
    const teeth = [16, 12]
    for (let channel = 0; channel < 2; channel += 1) {
      if (!this.benchMode) {
        // With no physical sensors attached, stopping bench mode produces the firmware's
        // explicit period=0 stale event once after ~500ms, rather than freezing last RPM.
        if (!this.stoppedSent[channel] && timeUs - this.benchDisabledAtUs >= 500_000) {
          this.stoppedSent[channel] = true
          if (this.channels[channel]) this.sendPacket(channel, 0, timeUs, this.edgeCounts[channel])
        }
        continue
      }
      const period = Math.max(1, Math.floor(60_000_000 / (Math.max(1, rpm[channel]) * teeth[channel])))
      let emitted = 0
      while (this.nextEdgeUs[channel] <= timeUs && emitted < 80) {
        const captureTime = this.nextEdgeUs[channel]
        this.physicalToothCount[channel] += 1
        // In the fault scenario a primary sensor occasionally never sees a real tooth.
        // Firmware cannot count that missing capture: the NEXT accepted edge simply
        // carries a roughly doubled inter-edge period with uninterrupted seq/edgeCount.
        const missedBySensor = (this.scenario === 'fragmented' && channel === 0 &&
          this.physicalToothCount[channel] % 257 === 0) ||
          this.faultPlan.missSensorToothOrdinals?.[channel as 0 | 1]?.includes(this.physicalToothCount[channel])
        if (!missedBySensor) {
          const actualPeriod = this.lastAcceptedEdgeUs[channel] > 0
            ? captureTime - this.lastAcceptedEdgeUs[channel] : period
          this.lastAcceptedEdgeUs[channel] = captureTime
          this.edgeCounts[channel] += 1
          // Separately simulate an edge captured by firmware but lost in its ring.
          const dropBeforeSend = (this.scenario === 'fragmented' && this.edgeCounts[channel] % 191 === 0) ||
            this.faultPlan.dropBufferedEdgeCounts?.[channel as 0 | 1]?.includes(this.edgeCounts[channel])
          if (this.channels[channel] && !dropBeforeSend) this.sendPacket(channel, actualPeriod, captureTime, this.edgeCounts[channel])
        }
        this.nextEdgeUs[channel] += period
        emitted += 1
      }
      if (emitted >= 80) this.nextEdgeUs[channel] = timeUs + period
    }
    for (let channel = 2; channel <= 4; channel += 1) {
      if (!this.channels[channel] || this.frequencies[channel] <= 0 || timeUs < this.nextPollUs[channel]) continue
      const value = this.benchMode
        ? channel === 2 ? Math.round(1800 + Math.sin(t * 0.45) * 850)
          : channel === 3 ? Math.round(420 + Math.sin(t * 0.8) * 105)
            : Math.round(335 + Math.sin(t * 0.8 - 0.3) * 88)
        : 0
      this.sendPacket(channel, value, timeUs)
      this.nextPollUs[channel] = timeUs + Math.round(1_000_000 / this.frequencies[channel])
    }
    const throttle = this.benchMode && (t % 60) >= 9 && (t % 60) < 51 ? 1 : 0
    if (throttle !== this.lastThrottle) {
      this.lastThrottle = throttle
      this.sendPacket(5, throttle, timeUs)
    }
    if (timeUs - this.lastDiagnosticUs >= 100_000) {
      this.lastDiagnosticUs = timeUs
      if (this.rpmPinTest) this.writeText('RPM TEST | PIN_RPM1=HIGH edges=' + this.edgeCounts[0] + ' | PIN_RPM2=HIGH edges=' + this.edgeCounts[1] + '\r\n')
      if (this.rpmCountTest) this.writeText('RPM COUNT TEST | RPM1 count=' + this.edgeCounts[0] + ' dropped=0 rejected=0 | RPM2 count=' + this.edgeCounts[1] + ' dropped=0 rejected=0\r\n')
      if (this.rpmInterruptTest) this.writeText('RPM INTERRUPT TEST | PRIMARY edges=' + this.edgeCounts[0] + ' | SECONDARY edges=' + this.edgeCounts[1] + '\r\n')
    }
  }

  private handleCommand(command: number, channel: number, value: number): void {
    if (command === 4) {
      const enable = value === 1
      if (enable !== this.benchMode) {
        this.benchMode = enable
        const nowUs = 1_000_000 + Math.floor((performance.now() - this.startedMs) * 1000)
        this.stoppedSent = [false, false]
        this.benchDisabledAtUs = nowUs
        if (enable) {
          this.nextEdgeUs = [nowUs, nowUs]
          this.lastAcceptedEdgeUs = [0, 0]
        }
      }
      this.writeText(this.benchMode ? 'BENCH MODE ENABLED\r\n' : 'BENCH MODE DISABLED\r\n')
    } else if (command === 5) {
      this.rpmPinTest = value === 1
      this.writeText(this.rpmPinTest ? 'RPM PIN TEST ENABLED\r\n' : 'RPM PIN TEST DISABLED\r\n')
    } else if (channel <= 4 && command === 1) {
      this.channels[channel] = value === 1
    } else if (channel <= 4 && command === 2) {
      this.frequencies[channel] = value
    }
    if (command === 3) this.printConfig()
    else if (command === 7) {
      this.rpmInterruptTest = value === 1
      this.writeText(this.rpmInterruptTest ? 'RPM INTERRUPT TEST ENABLED\r\n' : 'RPM INTERRUPT TEST DISABLED\r\n')
    } else if (command === 8) {
      this.rpmCountTest = value === 1
      this.writeText(this.rpmCountTest ? 'RPM COUNT TEST ENABLED\r\n' : 'RPM COUNT TEST DISABLED\r\n')
    }
  }

  private printConfig(): void {
    const labels = ['RPM1', 'RPM2', 'SHIFT', 'TORQ1', 'TORQ2']
    const lines = [
      '', '--- CURRENT CONFIGURATION STATUS ---',
      'Firmware git: simulator',
      'Protocol version: ' + EXPECTED_PROTOCOL_VERSION,
      'Bench mode: ' + (this.benchMode ? 'ENABLED' : 'DISABLED'),
      'RPM pin test: ' + (this.rpmPinTest ? 'ENABLED' : 'DISABLED'),
      'RPM interrupt test: ' + (this.rpmInterruptTest ? 'ENABLED' : 'DISABLED'),
      'RPM count test: ' + (this.rpmCountTest ? 'ENABLED' : 'DISABLED'),
      'Persisted config: DEFAULTS (no valid saved config found)',
      'Full throttle input: NOT FULL THROTTLE',
    ]
    for (let channel = 0; channel <= 4; channel += 1) {
      lines.push('Channel [' + channel + '] (' + labels[channel] + '): ' +
        (this.channels[channel] ? 'ENABLED' : 'DISABLED') +
        (channel < 2 ? ' | Edge-triggered (one packet per tooth, no fixed rate)'
          : ' | Target Tx Freq: ' + this.frequencies[channel] + ' Hz'))
    }
    lines.push('------------------------------------', '')
    this.writeText(lines.join('\r\n') + '\r\n')
  }
}
