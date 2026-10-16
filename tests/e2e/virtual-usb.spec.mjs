import { test, expect } from '@playwright/test'
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
  await expect.poll(() => canvasHasInk(chartCard(page, 'Primary vs secondary RPM'))).toBe(true)

  const plot = primary.locator('.chart-body')
  await plot.scrollIntoViewIfNeeded()
  const rect = await plot.boundingBox()
  expect(rect).not.toBeNull()
  await page.mouse.move(rect.x + rect.width * .78, rect.y + rect.height * .52)
  await expect(primary.locator('.chart-crosshair-line')).toBeVisible()

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
  await page.getByRole('button', { name: 'Full range' }).click()
  await expect(page.locator('.chart-range-bar')).toBeVisible()
  await page.locator('.analysis-select').filter({ hasText: 'Analysis interval' }).locator('select').selectOption('20')
  await expect(page.locator('.analysis-select').filter({ hasText: 'Analysis interval' }).locator('select')).toHaveValue('20')
})
