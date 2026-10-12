// Screenshot + overflow check: node scripts/shots.mjs [baseUrl] [outDir]
// Uses an already-installed Chromium (never downloads a browser).
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const out = process.argv[3] ?? 'shots'
fs.mkdirSync(out, { recursive: true })

function findChromium() {
  const candidates = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH].filter(Boolean)
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache)) {
      for (const sub of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-headless-shell-mac-arm64/chrome-headless-shell']) {
        candidates.push(path.join(cache, d, sub))
      }
    }
  }
  return candidates.find((p) => fs.existsSync(p))
}

const executablePath = findChromium()
if (!executablePath) { console.error('no Chromium found; set CHROMIUM_PATH'); process.exit(2) }
const browser = await chromium.launch({ executablePath })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const [w, h] of [[1366, 768], [1920, 1080]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(base)
  await page.waitForSelector('svg[role=img]')
  // Deterministic start: paused, scenario armed at tick 0, then advance with the Step button.
  await page.evaluate(async () => {
    const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) })
    await post('/api/pause')
    await post('/api/scenario/start', { name: 'link_failure' })
  })
  await sleep(1500)
  const tick = async () => Number((await page.locator('[aria-label="Current tick"]').innerText()).replace('t=', ''))
  const to = async (t) => { while ((await tick()) < t) { await page.click('button:has-text("Step")'); await sleep(70) } }
  const snap = async (name) => {
    await sleep(500)
    await page.screenshot({ path: path.join(out, `${name}_${w}x${h}.png`) })
  }
  await snap('00_start')
  await to(9); await snap('09_healthy')
  await to(10); await snap('10_fault_undetected')
  await to(11); await snap('11_rerouted')
  await to(12); await page.click('button:has-text("Resume")'); await sleep(900); await snap('12_packets_live')
  await page.click('button:has-text("Pause")')
  await to(42); await snap('42_recovering')
  await to(44); await snap('44_failback')
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollHeight > window.innerHeight + 1 ||
      document.documentElement.scrollWidth > window.innerWidth + 1,
    sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
  }))
  console.log(`${w}x${h}`, JSON.stringify(overflow), errors.length ? `errors: ${errors.slice(0, 3)}` : 'no console errors')
  await page.close()
}
await browser.close()
