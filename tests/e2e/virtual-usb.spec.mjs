import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  canvasHasInk, chartCard, connectVirtual, expectRpmAbove, installInMemoryDirectory,
  makeFaultyRawCsv,
} from './helpers.mjs'

test('normal virtual WebUSB drives real RPM charts, hover, settings and reconnection', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.chart-card')).toHaveCount(8)
  await connectVirtual(page)
  await expectRpmAbove(page, 'Primary RPM')
  await expectRpmAbove(page, 'Secondary RPM')
  await expect(page.locator('.topbar-status')).toContainText('fw simulator')

  const primary = chartCard(page, 'Primary RPM')
  await expect.poll(() => canvasHasInk(primary)).toBe(true)
  await expect(primary.locator('.chart-axis-layer svg')).toBeVisible()
  const relationship = chartCard(page, 'Primary vs secondary RPM')
  await expect.poll(() => canvasHasInk(relationship)).toBe(true)
  const lowRatio = relationship.locator('.ratio-input').filter({ hasText: 'Low ratio' }).locator('input')
  await lowRatio.fill('2.75')
  await expect(lowRatio).toHaveValue('2.75')

  const plot = primary.locator('.chart-body')
  await plot.scrollIntoViewIfNeeded()
  const rect = await plot.boundingBox()
  expect(rect).not.toBeNull()
  await page.mouse.move(rect.x + rect.width * .78, rect.y + rect.height * .52)
  await expect(primary.locator('.chart-crosshair-line')).toBeVisible()
  await expect(primary.locator('.hover-readout')).toContainText('RPM')

  await page.locator('.analysis-select').filter({ hasText: 'Analysis interval' }).locator('select').selectOption('50')
  await expect(page.locator('.analysis-select').filter({ hasText: 'Analysis interval' }).locator('select')).toHaveValue('50')
  await page.locator('.analysis-select').filter({ hasText: 'RPM observations' }).locator('select').selectOption('tooth')

  await page.getByRole('button', { name: 'Freeze view' }).click()
  await expect(page.getByRole('button', { name: 'View frozen' })).toBeVisible()
  await page.getByRole('button', { name: 'View frozen' }).click()
  await expect(page.getByRole('button', { name: 'Freeze view' })).toBeVisible()

  await chartCard(page, 'Shift position').getByTitle('Hide chart').click()
  await expect(page.locator('.chart-card')).toHaveCount(7)
  await page.getByRole('button', { name: 'Reset layout' }).click()
  await expect(page.locator('.chart-card')).toHaveCount(8)

  await page.getByRole('button', { name: 'Console' }).click()
  await expect(page.getByRole('heading', { name: 'Command link' })).toBeVisible()
  await page.locator('.console-command').filter({ hasText: 'Read configuration' }).click()
  await expect(page.locator('.console-table')).toContainText('READ CONFIG')

  await page.setViewportSize({ width: 940, height: 800 })
  await expect.poll(() => canvasHasInk(chartCard(page, 'Primary RPM'))).toBe(true)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Simulate RP2040' })).toBeVisible()
  await connectVirtual(page)
  await expectRpmAbove(page, 'Primary RPM')
})

test('faulty virtual stream surfaces distinct warnings, plot markers and sticky minimization', async ({ page }) => {
  await page.goto('/')
  await connectVirtual(page, 'fragmented')
  const warnings = page.getByRole('region', { name: 'Run warnings' })
  await expect(warnings).toBeVisible()
  await expect(warnings).toContainText('Telemetry loss')
  await expect(warnings).toContainText('RPM edge loss')
  await expect(warnings).toContainText('Suspected sensor misses')
  await expect(page.locator('.quality-timeline-marker.confirmed').first()).toBeVisible()
  await expect(page.locator('.quality-timeline-marker.suspected').first()).toBeVisible()
  await expect(page.locator('.chart-card .quality-chart-marker').first()).toBeVisible()

  await warnings.getByRole('button', { name: 'Minimize run warnings' }).click()
  await expect(warnings.getByRole('button', { name: 'Show all run warnings' })).toHaveAttribute('aria-expanded', 'false')
  await expect(warnings.locator('.warning-compact-summary')).not.toBeEmpty()
  // The operator can hide the details while live measurements continue to arrive.
  await expect(warnings.locator('.warning-updated')).toBeVisible({ timeout: 12_000 })
  await page.evaluate(() => window.scrollTo(0, 2100))
  await expect.poll(async () => {
    const rect = await warnings.boundingBox()
    return rect === null ? 1000 : rect.y
  }).toBeLessThan(18)

  await warnings.getByRole('button', { name: 'Show all run warnings' }).click()
  await expect(warnings.locator('.warning-issue-label')).toContainText([
    'Telemetry loss', 'RPM edge loss', 'Suspected sensor misses',
  ])
  await expect(warnings.locator('.warning-issues')).toBeVisible()
})

test('connection-claim failure and virtual cable removal recover without a page refresh', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Virtual USB test scenario' }).selectOption('claim-error')
  await page.getByRole('button', { name: 'Simulate RP2040' }).click()
  await expect(page.getByRole('region', { name: 'Run warnings' })).toContainText('Simulated claimInterface failure')
  await expect(page.getByRole('button', { name: 'Simulate RP2040' })).toBeEnabled()

  await connectVirtual(page, 'unplug')
  await expect(page.getByRole('region', { name: 'Run warnings' })).toContainText(
    'Virtual unplug test completed', { timeout: 12_000 },
  )
  await expect(page.getByRole('button', { name: 'Simulate RP2040' })).toBeVisible()
  await connectVirtual(page)
  await expectRpmAbove(page, 'Primary RPM')
})

test('headless raw capture round-trips from the production viewer into replay', async ({ page }) => {
  await installInMemoryDirectory(page)
  await page.goto('/')
  await connectVirtual(page)
  await expectRpmAbove(page, 'Primary RPM')
  await page.getByRole('button', { name: 'Start raw log' }).click()
  await expect(page.getByRole('button', { name: /Logging SIMULATED-/ })).toBeVisible()
  await page.waitForTimeout(1450)
  await page.getByRole('button', { name: /Logging SIMULATED-/ }).click()
  await expect(page.locator('.deck-heading')).toContainText('Closed SIMULATED-')
  const saved = await page.evaluate(() =>
    [...window.__e2eFiles.entries()].map(([name, data]) => ({ name, text: data.text })),
  )
  expect(saved).toHaveLength(1)
  expect(saved[0].name).toMatch(/^SIMULATED-.*-raw\.csv$/)
  expect(saved[0].text).toContain('# cvt-dyno-meta-v1 ')
  expect(saved[0].text).toContain('# cvt-dyno-end-v1 ')
  const packetLines = saved[0].text.split('\n').filter((line) => /^\d+,/.test(line))
  expect(packetLines.length).toBeGreaterThan(300)

  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: saved[0].name, mimeType: 'text/csv', buffer: Buffer.from(saved[0].text),
  })
  await expect(page.locator('.deck-heading')).toContainText('Loaded and analyzed', { timeout: 20_000 })
  await expect(page.locator('.playback-filename')).toContainText(saved[0].name)
  await expectRpmAbove(page, 'Primary RPM')
  await expect.poll(() => canvasHasInk(chartCard(page, 'Primary RPM'))).toBe(true)
  await expect(page.getByRole('region', { name: 'Run warnings' })).toHaveCount(0)
  await page.locator('.playback-bar button[title="Export processed CSV"]').click()
  await expect.poll(async () => {
    const files = await page.evaluate(() =>
      [...window.__e2eFiles.entries()].map(([name, data]) => ({ name, text: data.text })),
    )
    return files.some(({ name, text }) =>
      name.includes('-processed-') && text.includes('schema_version,timestamp_s,primary_rpm,secondary_rpm'))
  }).toBe(true)
  await page.locator('.playback-bar button[title="Play replay"]').click()
  await expect(page.locator('.playback-bar')).toContainText('x')
  await page.locator('.playback-bar button[title="Clear replay"]').click()
  await expect(page.locator('.playback-filename')).toHaveCount(0)
})

test('raw replay exposes missing sensor pulses and both loss counters on rendered charts', async ({ page }) => {
  await page.goto('/')
  const fixture = makeFaultyRawCsv(false)
  await page.locator('input[type=file]').setInputFiles({
    name: 'faults-without-metadata-raw.csv', mimeType: 'text/csv', buffer: Buffer.from(fixture.csv),
  })
  await expect(page.locator('.deck-heading')).toContainText('Loaded and analyzed', { timeout: 20_000 })
  const warning = page.getByRole('region', { name: 'Run warnings' })
  await expect(warning).toContainText('Replay setup')
  await expect(warning).toContainText('Telemetry loss')
  await expect(warning).toContainText('RPM edge loss')
  await expect(warning).toContainText('Suspected sensor misses')
  await expect(page.locator('.quality-timeline-marker.confirmed').first()).toBeVisible()
  await expect(page.locator('.quality-timeline-marker.suspected').first()).toBeVisible()
  await expect(page.locator('.chart-card .quality-chart-marker.suspected').first()).toBeVisible()
  await expect.poll(() => canvasHasInk(chartCard(page, 'Primary RPM'))).toBe(true)
  await expectRpmAbove(page, 'Secondary RPM')
  const track = page.locator('.time-range-track')
  await track.scrollIntoViewIfNeeded()
  const trackBounds = await track.boundingBox()
  expect(trackBounds).not.toBeNull()
  const startThumb = page.getByRole('button', { name: 'Chart window start time' })
  await startThumb.hover()
  await page.mouse.down()
  await page.mouse.move(trackBounds.x + trackBounds.width * 0.25, trackBounds.y + trackBounds.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => startThumb.evaluate((element) => Number.parseFloat(element.style.left))).toBeGreaterThan(10)
  await expect.poll(() => canvasHasInk(chartCard(page, 'Primary RPM'))).toBe(true)
  await page.getByRole('button', { name: 'Full range' }).click()
  await expect(page.locator('.chart-range-bar')).toBeVisible()
  await page.locator('.analysis-select').filter({ hasText: 'Analysis interval' }).locator('select').selectOption('20')
  await expect(page.locator('.analysis-select').filter({ hasText: 'Analysis interval' }).locator('select')).toHaveValue('20')
})


test('real 23CVT recording restores declared defaults and reproduces observed sensor anomalies in the plots', async ({ page }) => {
  // The real source file had no embedded setup; the promoted excerpt explicitly
  // carries contemporary viewer defaults, documented as assumptions in its manifest.
  const fixture = fileURLToPath(new URL('../fixtures/real/reference-run-raw.csv', import.meta.url))
  const manifestPath = fileURLToPath(new URL('../fixtures/real/reference-run.manifest.json', import.meta.url))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await page.addInitScript(() => {
    localStorage.setItem('cvt-dyno-primary-teeth', '23')
    localStorage.setItem('cvt-dyno-secondary-teeth', '19')
    localStorage.setItem('cvt-dyno-analysis-window-ms', '20')
  })
  await page.goto('/')
  const wheelSection = page.locator('.channel-strip').filter({ hasText: 'RPM wheel teeth / spokes' })
  await expect(wheelSection.locator('input').nth(0)).toHaveValue('23')
  await expect(wheelSection.locator('input').nth(1)).toHaveValue('19')

  // Load the actual committed hardware-derived CSV, not a generated test packet sequence.
  await page.locator('input[type=file]').setInputFiles(fixture)
  await expect(page.locator('.deck-heading')).toContainText('Loaded and analyzed', { timeout: 25_000 })
  await expect(page.locator('.playback-filename')).toContainText(manifest.fixture.file)
  await expect(wheelSection.locator('input').nth(0)).toHaveValue('16')
  await expect(wheelSection.locator('input').nth(1)).toHaveValue('12')
  await expect(page.locator('.analysis-select').filter({ hasText: 'Analysis interval' }).locator('select')).toHaveValue('100')

  const warnings = page.getByRole('region', { name: 'Run warnings' })
  await expect(warnings).toContainText('Suspected sensor misses')
  await expect(warnings).toContainText(manifest.expectedObservedDataQuality.suspectedSensorPulses[0] + ' primary')
  await expect(warnings).not.toContainText('Telemetry loss')
  await expect(warnings).not.toContainText('RPM edge loss')
  await expect(warnings).not.toContainText('Replay setup')

  await expect(page.locator('.quality-timeline-count')).toContainText('35 events')
  await expect(page.locator('.quality-timeline-marker.suspected').first()).toBeVisible()
  await expect(page.locator('.quality-timeline-marker.confirmed')).toHaveCount(0)
  await expect(page.locator('.chart-card .quality-chart-marker.suspected').first()).toBeVisible()

  await expectRpmAbove(page, 'Primary RPM')
  await expectRpmAbove(page, 'Secondary RPM')
  await expect.poll(() => canvasHasInk(chartCard(page, 'Primary RPM'))).toBe(true)
  await expect.poll(() => canvasHasInk(chartCard(page, 'Secondary RPM'))).toBe(true)
  await expect.poll(() => canvasHasInk(chartCard(page, 'Primary vs secondary RPM'))).toBe(true)

  // Confirm detailed warnings remain accessible after minimization on this real run.
  await warnings.getByRole('button', { name: 'Minimize run warnings' }).click()
  await expect(warnings.getByRole('button', { name: 'Show all run warnings' })).toBeVisible()
  await warnings.getByRole('button', { name: 'Show all run warnings' }).click()
  await expect(warnings).toContainText('Suspected sensor misses')
})
