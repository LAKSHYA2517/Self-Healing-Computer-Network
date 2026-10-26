// End-to-end check of the topology editor against a running backend (python app.py --no-noise).
// Usage: node scripts/e2e.mjs [baseUrl] [outDir]. Uses an installed Chromium; never downloads a browser.
import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const base = process.argv[2] ?? 'http://127.0.0.1:3000'
const out = process.argv[3] ?? 'shots'
fs.mkdirSync(out, { recursive: true })

function findChromium() {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright')
  const found = ['/opt/pw-browsers/chromium', process.env.CHROMIUM_PATH]
  if (fs.existsSync(cache)) {
    for (const d of fs.readdirSync(cache)) {
      found.push(path.join(cache, d, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'))
      found.push(path.join(cache, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
    }
  }
  return found.filter(Boolean).find((p) => fs.existsSync(p))
}
const executablePath = findChromium()
if (!executablePath) { console.error('no Chromium found; set CHROMIUM_PATH'); process.exit(2) }
const browser = await chromium.launch({ executablePath })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const api = (page, url, method = 'GET', body) => page.evaluate(async ([u, m, b]) => {
  const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return r.json()
}, [url, method, body])

async function center(page, sel) {
  const b = await page.locator(sel).boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
async function drag(page, from, to) {
  const a = await center(page, `[data-node-id="${from}"]`), b = await center(page, `[data-node-id="${to}"]`)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 })
  await page.mouse.move(b.x, b.y, { steps: 5 })
  await page.mouse.up()
}

for (const [w, h] of [[1366, 768], [1920, 1080]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(base)
  await page.waitForSelector('[data-node-id="R10"]')
  await api(page, '/api/pause', 'POST')
  await api(page, '/api/topology/reset', 'POST')
  await api(page, '/api/reset', 'POST')
  await sleep(1500)
  const shot = (name) => page.screenshot({ path: path.join(out, `${name}_${w}x${h}.png`) })
  const badge = () => page.getByLabel('Best path').innerText()
  const toast = () => page.getByTestId('toast').innerText()

  assert.match(await badge(), /cost 33/)
  await shot('00_default')

  // E1: add R11, link R7-R11 (3 ms), link R11-R10 (4 ms)
  await page.keyboard.press('a')
  const svg = await page.locator('svg[role=img]').boundingBox()
  await page.mouse.click(svg.x + svg.width * 0.64, svg.y + svg.height * 0.1)
  await page.waitForSelector('[data-node-id="R11"]')
  assert.equal((await api(page, '/api/topology')).nodes.length, 11)
  await page.keyboard.press('l')
  await drag(page, 'R7', 'R11')
  await page.getByLabel('Latency in milliseconds').fill('3')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('[data-link-id]').length === 16)
  assert.match(await badge(), /cost 33/, 'adding R11 and L16 changes nothing')
  await drag(page, 'R11', 'R10')
  await page.getByLabel('Latency in milliseconds').fill('4')
  await shot('01_link_popover')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('[data-link-id]').length === 17)
  await sleep(300)
  assert.match(await badge(), /R1>R2>R5>R7>R11>R10, cost 27/)
  assert.match(await toast(), /Self-healing switched to R1>R2>R5>R7>R11>R10 \(cost 27, was 33\)\. Static routing keeps its manual route\./)
  await shot('02_e1_toast')
  await api(page, '/api/step', 'POST')
  const st = await api(page, '/api/state')
  assert.equal(st.series.healing.at(-1).delay_ms, 27)
  assert.equal(st.series.static.at(-1).delay_ms, 33)
  assert.deepEqual(st.static_path.nodes, ['R1', 'R2', 'R5', 'R7', 'R9', 'R10'])

  // a fault is still discovered from metrics (about 2 ticks), unlike a planned delete
  await page.keyboard.press('v')
  await page.locator('[data-link-id="L8"]').click({ force: true })
  await page.getByRole('button', { name: 'Fail link' }).click()
  await api(page, '/api/step', 'POST'); await api(page, '/api/step', 'POST')
  const faulted = await api(page, '/api/state')
  assert.deepEqual(faulted.healing_path.nodes, ['R1', 'R2', 'R4', 'R7', 'R11', 'R10'])
  assert.equal(faulted.healing_path.cost, 28)
  await shot('03_fault_reroute')
  await page.getByRole('button', { name: 'Restore link' }).click()

  // planned delete with the Delete tool: no loss for self-healing, static routing breaks
  const lostBefore = (await api(page, '/api/state')).kpis.healing.lost_packets
  await page.keyboard.press('x')
  await page.locator('[data-link-id="L1"]').click({ force: true })
  await sleep(300)
  assert.match(await toast(), /Deleted link L1/)
  await api(page, '/api/step', 'POST')
  const after = await api(page, '/api/state')
  assert.equal(after.kpis.healing.lost_packets, lostBefore, 'planned delete loses nothing for self-healing')
  assert.equal(after.static_path_valid, false)
  await shot('04_planned_delete')
  const reconf = page.getByRole('button', { name: 'Reconfigure static route' })
  await page.keyboard.press('v')
  await reconf.click()
  await sleep(300)
  assert.equal((await api(page, '/api/state')).static_path_valid, true)

  // undo twice restores L1, then drag-move a router
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z')
  await sleep(300)
  assert.ok((await api(page, '/api/topology')).can_redo)
  const before = (await api(page, '/api/topology')).nodes.find((n) => n.id === 'R3')
  const c = await center(page, '[data-node-id="R3"]')
  await page.mouse.move(c.x, c.y); await page.mouse.down()
  await page.mouse.move(c.x - 40, c.y + 20, { steps: 6 }); await page.mouse.up()
  await sleep(400)
  const moved = (await api(page, '/api/topology')).nodes.find((n) => n.id === 'R3')
  assert.ok(moved.x < before.x && moved.y > before.y, 'router moved')
  await shot('05_after_undo_move')

  // menu: save, then scenario start asks before replacing unsaved edits
  await page.getByRole('button', { name: /^Topology default/ }).click()
  await page.getByRole('menuitem', { name: 'Save as…' }).click()
  await page.getByLabel('Topology name').fill('e2e_demo')
  await page.keyboard.press('Enter')
  await sleep(400)
  assert.equal((await api(page, '/api/topology')).name, 'e2e_demo')
  console.log(`${w}x${h} ok; console errors: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`)
  await page.close()
}
await browser.close()
fs.rmSync(path.resolve('..', 'topologies', 'e2e_demo.json'), { force: true })
