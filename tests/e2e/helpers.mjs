import { expect } from '@playwright/test'

export function chartCard(page, title) {
  return page.locator('.chart-card').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  })
}

export async function canvasHasInk(card) {
  const canvas = card.locator('canvas.chart-canvas-layer')
  return canvas.evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement) || element.width < 5 || element.height < 5) return false
    const pixels = element.getContext('2d')?.getImageData(0, 0, element.width, element.height).data
    if (!pixels) return false
    for (let offset = 3; offset < pixels.length; offset += 64) {
      if (pixels[offset] > 0) return true
    }
    return false
  })
}

export async function connectVirtual(page, scenario = 'normal') {
  await page.getByRole('combobox', { name: 'Virtual USB test scenario' }).selectOption(scenario)
  await page.getByRole('button', { name: 'Simulate RP2040' }).click()
  await expect(page.locator('.topbar-status')).toContainText('SIMULATED RP2040 / WebUSB')
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
}

export function rpmMetric(page, name) {
  return page.locator('.metric').filter({ has: page.locator('.metric-label', { hasText: name }) })
    .locator('strong')
}

export async function expectRpmAbove(page, name, minimum = 300) {
  await expect.poll(async () => {
    const value = (await rpmMetric(page, name).innerText()).replaceAll(',', '')
    return Number.parseFloat(value)
  }).toBeGreaterThan(minimum)
}

export function makeFaultyRawCsv(withMetadata = false) {
  const packets = []
  const names = ['Primary RPM', 'Secondary RPM', 'Shift position', 'Primary torque', 'Secondary torque', 'Full throttle']
  const add = (channel, tUs, seq, value, edgeCount) => {
    packets.push({ channel, tUs, seq, value, edgeCount })
  }
  let timePrimary = 1_000_000
  let primarySeq = 0
  for (let tooth = 1; tooth <= 1100; tooth++) {
    const periodUs = tooth === 165 ? 2500 : 1250
    timePrimary += periodUs
    // Ring overflow: physical edge count advances, but a sequence is never assigned.
    if (tooth === 540) continue
    primarySeq = (primarySeq + 1) & 0xff
    // Transmission loss: both counters advance and the packet disappears.
    if (tooth === 350) continue
    add(0, timePrimary, primarySeq, periodUs, tooth)
  }

  let timeSecondary = 1_000_000
  for (let tooth = 1; tooth <= 650; tooth++) {
    timeSecondary += 2500
    add(1, timeSecondary, tooth & 0xff, 2500, tooth)
  }
  for (let n = 1; n <= 30; n++) {
    const time = 1_000_000 + 50_000 * n
    add(2, time, n & 0xff, 1800 + Math.round(n * 4), 0)
    add(3, time, n & 0xff, 400 + n, 0)
    add(4, time, n & 0xff, 330 + n, 0)
  }
  add(5, 1_010_000, 1, 0, 0)
  packets.sort((a, b) => a.tUs - b.tUs || a.channel - b.channel)
  const lines = []
  if (withMetadata) {
    lines.push('# cvt-dyno-meta-v1 ' + JSON.stringify({
      schemaVersion: 1, startedAt: '2026-10-16T00:00:00Z', captureSource: 'virtual',
      primaryTeeth: 16, secondaryTeeth: 12, analysisWindowMs: 100, powerMode: 'inertia',
    }))
  }
  lines.push('firmware_t_us,wall_time_s,channel,channel_name,seq,raw_value,edge_count')
  for (const packet of packets) {
    lines.push([
      packet.tUs, (packet.tUs / 1_000_000).toFixed(6), packet.channel, names[packet.channel],
      packet.seq, packet.value, packet.edgeCount,
    ].join(','))
  }
  return { csv: lines.join('\n') + '\n', expectedCount: packets.length }
}

/**
 * Model only the browser's directory/file system boundary. The actual React app and its
 * raw-file logging flow remain real; headless CI cannot use the native picker dialog.
 */
export async function installInMemoryDirectory(page) {
  await page.addInitScript(() => {
    const store = new Map()
    window.__e2eFiles = store
    window.showDirectoryPicker = async () => ({
      name: 'E2E capture',
      async getFileHandle(name, options = {}) {
        if (!store.has(name)) {
          if (!options.create) throw new DOMException('File does not exist', 'NotFoundError')
          store.set(name, { text: '' })
        }
        const file = store.get(name)
        return {
          async getFile() { return new File([file.text], name, { type: 'text/csv' }) },
          async createWritable(options = {}) {
            let contents = options.keepExistingData ? file.text : ''
            let position = 0
            return {
              async seek(offset) { position = offset },
              async write(value) {
                const text = String(value)
                contents = contents.slice(0, position) + text + contents.slice(position + text.length)
                position += text.length
              },
              async close() { file.text = contents },
            }
          },
        }
      },
    })
  })
}
