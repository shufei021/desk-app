/** The image workspace generates through the configured image service without a chat model or Agent turn. */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, connectFreshWorkspace, openSettings, revealNavigationDrawer } from './support.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const key = 'fixture-image-studio-key-not-a-real-secret'

describe('image workspace', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let server: Server
  let baseURL: string
  let directory: string
  let gridPng: string
  const requests: { path: string; authorization: string | undefined; body: string }[] = []

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-image-studio-'))
    gridPng = (await readFile(join(REPO_ROOT, 'apps/web/tests/fixtures/grid-2x2.png'))).toString('base64')
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const value: unknown = chunk
          if (typeof value === 'string' || Buffer.isBuffer(value)) chunks.push(Buffer.from(value))
          else throw new Error('Unexpected fixture request chunk')
        }
        requests.push({ path: request.url ?? '', authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8') })
        if (request.url === '/v1/images/generations') {
          const wantsGrid = Buffer.concat(chunks).toString('utf8').includes('grid')
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: [{ b64_json: wantsGrid ? gridPng : png }] }))
        } else if (request.url === '/v1/images/edits') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: [{ b64_json: png }] }))
        } else if (request.url === '/v1/chat/completions') {
          // Streamed expansion text; the new prompt is composed from two SSE chunks.
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
          for (const text of ['全景宽幅电影感的城市夜景', '，高清细节，四个方案']) {
            response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`)
          }
          response.end('data: [DONE]\n\n')
        } else { response.writeHead(404); response.end() }
      })().catch(() => { response.destroy() })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture server has no bound address')
    baseURL = `http://127.0.0.1:${address.port}`
    scaffold = await launchWebScaffold({ directAi: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    }
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it('generates in its own workspace, keeps the run, and returns to the conversation', async () => {
    const screenshots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
    await mkdir(screenshots, { recursive: true })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Direct AI', exact: true }).waitFor({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Add service', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add service', exact: true })
    await dialog.getByLabel('Service name', { exact: true }).fill('Studio image route')
    await dialog.getByRole('radio', { name: 'OpenAI Images', exact: true }).check()
    await dialog.getByLabel('API base URL', { exact: true }).fill(`${baseURL}/v1`)
    await dialog.getByLabel('Model ID', { exact: true }).fill('gpt-image-studio')
    await dialog.getByLabel('API key', { exact: true }).fill(key)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })

    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    expect(await main.getByLabel('Image description', { exact: true }).count()).toBe(1)

    await main.getByLabel('Image description', { exact: true }).fill('A studio-lit product photo')
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    const result = main.getByRole('link', { name: 'Open or download', exact: true }).first()
    const alert = main.getByRole('alert').first()
    await Promise.race([
      result.waitFor({ timeout: 30_000 }),
      alert.waitFor({ timeout: 30_000 }),
    ]).catch(() => {})
    if (await alert.count() > 0) {
      await page.screenshot({ path: join(screenshots, 'generation-failure.png'), fullPage: true })
      const diagnostic = { alerts: await main.getByRole('alert').allInnerTexts(), requests,
        body: await main.innerText() }
      await writeFile(join(screenshots, 'generation-failure.json'), JSON.stringify(diagnostic, null, 2))
    }
    await result.waitFor({ timeout: 30_000 })
    const image = main.locator('figure img').first()
    await expect.poll(() => image.evaluate(element =>
      element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
    )).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.path).toBe('/v1/images/generations')
    expect(requests[0]?.authorization).toBe(`Bearer ${key}`)
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({ model: 'gpt-image-studio', prompt: 'A studio-lit product photo' })
    await page.screenshot({ path: join(screenshots, 'image-studio-light.png'), fullPage: true })

    // The retained run reopens from history without a second provider request.
    await page.reload()
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    await main.getByText('Recent generations', { exact: true }).click()
    await main.getByRole('button', { name: /gpt-image-studio/u }).first().click()
    await expect.poll(() => image.evaluate(element =>
      element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
    )).toBe(true)
    expect(requests).toHaveLength(1)

    // The workspace switch returns to the conversation and leaves the image run untouched.
    await main.getByRole('group', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Chat', exact: true }).click()
    await expect.poll(() => main.getByRole('heading', { name: 'Image generation', exact: true }).count()).toBe(0)
    expect(requests).toHaveLength(1)

    // Dark theme keeps the workspace readable and the same materials.
    await openSettings(page, 'en')
    const settingsDialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settingsDialog.getByRole('button', { name: 'General', exact: true }).click()
    await settingsDialog.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.keyboard.press('Escape')
    await settingsDialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(screenshots, 'image-studio-dark.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('Image description', { exact: true }).scrollIntoViewIfNeeded()
    expect(await main.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, 'image-studio-narrow-dark.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
  }, 180_000)

  it('splits a generated contact sheet into its panels in the browser', async () => {
    const screenshots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    await main.getByLabel('Image description', { exact: true }).fill('grid contact sheet')
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    const source = main.locator('figure img').first()
    await expect.poll(() => source.evaluate(element =>
      element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
    )).toBe(true)

    await main.getByRole('button', { name: 'Split grid', exact: true }).click()
    const tiles = main.locator('img[alt^="grid-split-"]')
    await expect.poll(() => tiles.count(), { timeout: 15_000 }).toBe(4)
    expect(await main.getByRole('button', { name: 'Splitting…', exact: true }).count()).toBe(0)
    for (let index = 0; index < 4; index += 1) {
      await expect.poll(() => tiles.nth(index).evaluate(element =>
        element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
      )).toBe(true)
    }
    const downloads = main.locator('a[download^="grid-split-"]')
    expect(await downloads.count()).toBe(4)
    expect(await downloads.evaluateAll(links => links.map(link => link.getAttribute('download'))))
      .toEqual(['grid-split-1-1.jpg', 'grid-split-1-2.jpg', 'grid-split-2-1.jpg', 'grid-split-2-2.jpg'])
    await page.screenshot({ path: join(screenshots, 'grid-split.png'), fullPage: true })
  }, 120_000)

  it('sends an uploaded reference image through the edit endpoint', async () => {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    const before = requests.length
    await main.locator('input[type="file"]').setInputFiles(join(REPO_ROOT, 'apps/web/tests/fixtures/grid-2x2.png'))
    const thumb = main.getByRole('img', { name: 'Reference images', exact: true })
    const referenceAlert = main.getByRole('alert')
    await Promise.race([
      thumb.first().waitFor({ timeout: 10_000 }),
      referenceAlert.first().waitFor({ timeout: 10_000 }),
    ]).catch(() => {})
    if (await thumb.count() === 0) {
      const shots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
      await mkdir(shots, { recursive: true })
      await writeFile(join(shots, 'reference-failure.json'), JSON.stringify({
        alerts: await referenceAlert.allInnerTexts(), body: await main.innerText(), requests: requests.slice(before),
      }, null, 2))
      await page.screenshot({ path: join(shots, 'reference-failure.png'), fullPage: true })
    }
    await expect.poll(() => thumb.count()).toBe(1)
    await main.getByLabel('Image description', { exact: true }).fill('turn this into a poster')
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect.poll(() => requests.slice(before).filter(request => request.path === '/v1/images/edits').length,
      { timeout: 30_000 }).toBe(1)
    await main.locator('figure img').first().waitFor({ timeout: 30_000 })

    const edit = requests.slice(before).find(request => request.path === '/v1/images/edits')
    expect(edit).toBeDefined()
    expect(edit?.authorization).toBe(`Bearer ${key}`)
    expect(edit?.body).toContain('name="image"; filename="grid-2x2.png"')
    expect(edit?.body).toContain('name="prompt"')
    expect(edit?.body).toContain('turn this into a poster')
    expect(edit?.body).toContain('name="model"')
    expect(requests.slice(before).some(request => request.path === '/v1/images/generations')).toBe(false)
    expect(await main.getByRole('img', { name: 'Reference images', exact: true }).count()).toBe(0)
  }, 120_000)

  it('appends the character turnaround template only when one reference is present', async () => {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    await main.getByRole('button', { name: /Free/u }).click()
    await page.getByRole('menuitem', { name: 'Character turnaround', exact: true }).click()
    await main.getByText('This preset requires exactly one reference image.', { exact: true }).waitFor()
    expect(await main.getByRole('button', { name: 'Generate', exact: true }).isDisabled()).toBe(true)

    const before = requests.length
    await main.locator('input[type="file"]').setInputFiles(join(REPO_ROOT, 'apps/web/tests/fixtures/grid-2x2.png'))
    await expect.poll(() => main.getByRole('img', { name: 'Reference images', exact: true }).count()).toBe(1)
    await main.getByLabel('Image description', { exact: true }).fill('same character, red coat')
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect.poll(() => requests.slice(before).filter(request => request.path === '/v1/images/edits').length,
      { timeout: 30_000 }).toBe(1)
    const edit = requests.slice(before).find(request => request.path === '/v1/images/edits')
    expect(edit?.body).toContain('same character, red coat')
    expect(edit?.body).toContain('正交')
    await main.locator('figure img').first().waitFor({ timeout: 30_000 })
    expect(await main.getByLabel('Image description', { exact: true }).inputValue()).toBe('')
  }, 120_000)

  it('pairs each generated image with its prompt across a reload', async () => {
    const promptText = 'A paired prompt that survives a reload'
    const screenshots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
    await mkdir(screenshots, { recursive: true })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    const before = requests.length
    await main.getByLabel('Image description', { exact: true }).fill(promptText)
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect.poll(() => requests.slice(before).length, { timeout: 30_000 }).toBe(1)
    expect(requests.slice(before)[0]?.body).toContain(promptText)
    const card = main.getByRole('region', { name: 'Prompt', exact: true })
    await card.waitFor({ timeout: 30_000 })
    expect(await card.innerText()).toContain(promptText)
    expect(await card.innerText()).toContain('gpt-image-studio')
    await page.screenshot({ path: join(screenshots, 'prompt-pairing.png'), fullPage: true })

    // The retained run reopens with its prompt after a reload, without a second provider request.
    await page.reload()
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    await main.getByText('Recent generations', { exact: true }).click()
    await main.getByRole('button', { name: new RegExp(promptText, 'u') }).first().click()
    await card.waitFor({ timeout: 15_000 })
    expect(await card.innerText()).toContain(promptText)
    expect(requests.slice(before)).toHaveLength(1)

    // Reuse fills the composer with the paired prompt and waits for an explicit submission.
    await main.getByRole('button', { name: 'Use again', exact: true }).click()
    expect(await main.getByLabel('Image description', { exact: true }).inputValue()).toBe(promptText)
    expect(requests.slice(before)).toHaveLength(1)
    await page.screenshot({ path: join(screenshots, 'prompt-pairing-reused.png'), fullPage: true })
  }, 120_000)

  it('submits an explicit size, quality and count and shows them on the result card', async () => {
    const screenshots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
    await mkdir(screenshots, { recursive: true })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    const before = requests.length
    await main.getByLabel('Image description', { exact: true }).fill('A widescreen product pair')
    await main.getByRole('button', { name: 'Parameters', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Generation parameters', exact: true })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: '16:9', exact: true }).click()
    await dialog.getByRole('button', { name: '2K', exact: true }).click()
    await dialog.getByRole('button', { name: 'High', exact: true }).click()
    await dialog.getByRole('button', { name: '2', exact: true }).click()
    // The ratio and resolution derive the exact size; 2K 16:9 is 2048×1152.
    const width = dialog.getByRole('spinbutton', { name: 'Width', exact: true })
    const height = dialog.getByRole('spinbutton', { name: 'Height', exact: true })
    await expect.poll(() => width.inputValue()).toBe('2048')
    await expect.poll(() => height.inputValue()).toBe('1152')
    await page.screenshot({ path: join(screenshots, 'generation-parameters.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count()).toBe(0)
    await page.screenshot({ path: join(screenshots, 'image-studio-tool-row.png'), fullPage: true })

    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect.poll(() => requests.slice(before).filter(request => request.path === '/v1/images/generations').length,
      { timeout: 30_000 }).toBe(1)
    const generation = requests.slice(before).find(request => request.path === '/v1/images/generations')
    const body = JSON.parse(generation?.body ?? '{}') as Record<string, unknown>
    expect(body).toMatchObject({ size: '2048x1152', quality: 'high', n: 2 })

    const card = main.getByRole('region', { name: 'Prompt', exact: true })
    await card.waitFor({ timeout: 30_000 })
    const cardText = await card.innerText()
    expect(cardText).toContain('Size 2048x1152')
    expect(cardText).toContain('Quality High')
    expect(cardText).toContain('Count 2')
    await main.locator('figure img').first().waitFor({ timeout: 30_000 })
    await page.screenshot({ path: join(screenshots, 'generation-parameters-result.png'), fullPage: true })
  }, 120_000)

  it('erases a mask region and submits it with the reference edit', async () => {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    // Mask editing is one generation mode; its editor control appears once that mode is chosen.
    await main.getByRole('button', { name: /^Generation mode/u }).click()
    await page.getByRole('menuitem', { name: 'Mask editing', exact: true }).click()
    expect(await main.getByRole('button', { name: 'Edit mask', exact: true }).isDisabled()).toBe(true)
    await main.locator('input[type="file"]').setInputFiles(join(REPO_ROOT, 'apps/web/tests/fixtures/grid-2x2.png'))
    await expect.poll(() => main.getByRole('img', { name: 'Reference images', exact: true }).count()).toBe(1)
    await main.getByRole('button', { name: 'Edit mask', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Mask editing', exact: true })
    await dialog.waitFor()
    const canvas = dialog.locator('canvas')
    const box = await canvas.boundingBox()
    if (box === null) throw new Error('Mask canvas has no layout box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 6 })
    await page.mouse.up()
    await page.screenshot({ path: join(REPO_ROOT, '.playwright-mcp/image-studio-validation/mask-editor.png'), fullPage: true })
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect.poll(() => dialog.count()).toBe(0)
    await main.getByText('Mask added', { exact: true }).waitFor()

    const before = requests.length
    await main.getByLabel('Image description', { exact: true }).fill('repaint the erased area')
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    await expect.poll(() => requests.slice(before).filter(request => request.path === '/v1/images/edits').length,
      { timeout: 30_000 }).toBe(1)
    const edit = requests.slice(before).find(request => request.path === '/v1/images/edits')
    expect(edit?.body).toContain('name="mask"')
    expect(edit?.body).toContain('name="image"')
    await main.locator('figure img').first().waitFor({ timeout: 30_000 })
  }, 120_000)

  it('stores an asset in the workspace folder and reuses it as a reference image', async () => {
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await revealNavigationDrawer(page, 'en')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'asset-e2e')
    // Scope to the composer mode bar: the sidebar also carries a panel launcher with the same label.
    await page.getByRole('group', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    await main.getByRole('button', { name: 'Asset library', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Asset library', exact: true })
    await panel.waitFor()
    await panel.getByText('This category has no images yet. Add a local image to see it here.', { exact: true }).waitFor()
    await panel.locator('input[type="file"]').setInputFiles(join(REPO_ROOT, 'apps/web/tests/fixtures/grid-2x2.png'))
    await panel.getByLabel('Asset name', { exact: true }).fill('Hero')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await panel.getByText('Asset added', { exact: true }).waitFor()

    // The library is a real workspace folder, not browser storage.
    const stored = join(scaffold.workspaceCwd, 'asset-e2e', '资产库', '角色', 'Hero.png')
    await expect.poll(async () => (await stat(stored)).size).toBeGreaterThan(0)
    await page.screenshot({ path: join(REPO_ROOT, '.playwright-mcp/image-studio-validation/asset-library.png'), fullPage: true })

    await panel.getByRole('button', { name: 'Use as reference image Hero', exact: true }).click()
    await expect.poll(() => main.getByRole('img', { name: 'Reference images', exact: true }).count()).toBe(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => panel.count()).toBe(0)
    await page.reload()
    // The composer mounts before its mode bar; wait for the frame like the sibling scenarios do.
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    const studio = main.getByRole('heading', { name: 'Image generation', exact: true })
    if (await studio.count() === 0) {
      await page.getByRole('button', { name: 'Image generation', exact: true }).first().click()
    }
    await studio.waitFor({ timeout: 15_000 })
    await main.getByRole('button', { name: 'Asset library', exact: true }).click()
    await panel.getByRole('button', { name: 'Use as reference image Hero', exact: true }).waitFor({ timeout: 15_000 })
  }, 120_000)

  it('expands a prompt through a chat service and applies suggested parameters without generating', async () => {
    const screenshots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
    await mkdir(screenshots, { recursive: true })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    const main = page.locator('[data-slot="main"]')
    // A previous scenario may have left the image workspace active; always open the Direct AI page first.
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Direct AI', exact: true }).first().click()
    await main.getByRole('heading', { name: 'Direct AI', exact: true }).waitFor({ timeout: 30_000 })

    const addService = async (values: { name: string; protocol: string; model: string }): Promise<void> => {
      await page.getByRole('button', { name: 'Add service', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add service', exact: true })
      await dialog.getByLabel('Service name', { exact: true }).fill(values.name)
      await dialog.getByRole('radio', { name: values.protocol, exact: true }).check()
      await dialog.getByLabel('API base URL', { exact: true }).fill(`${baseURL}/v1`)
      await dialog.getByLabel('Model ID', { exact: true }).fill(values.model)
      await dialog.getByLabel('API key', { exact: true }).fill(key)
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
    }
    // The assistant needs a chat service, while the parameter dialog needs a configured image service.
    await addService({ name: 'Assist image route', protocol: 'OpenAI Images', model: 'assist-image' })
    await addService({ name: 'Assist chat route', protocol: 'OpenAI Chat Completions', model: 'assist-chat' })

    await page.getByRole('button', { name: 'Image generation', exact: true }).click()
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    await main.getByLabel('Image description', { exact: true }).fill('一只橘猫')
    const suggestion = main.getByRole('group', { name: 'Parameter suggestion', exact: true })
    await suggestion.waitFor({ timeout: 15_000 })
    expect(await suggestion.innerText()).toContain('1:1')

    // Expansion streams into the inline panel; adopting it must not submit anything.
    const before = requests.length
    await main.getByRole('button', { name: 'Prompt assistant', exact: true }).click()
    const panel = main.getByRole('region', { name: 'Prompt assistant', exact: true })
    await panel.waitFor()
    await panel.getByRole('button', { name: 'Expand', exact: true }).click()
    const expanded = '全景宽幅电影感的城市夜景，高清细节，四个方案'
    await panel.getByText(expanded, { exact: true }).waitFor({ timeout: 30_000 })
    await page.screenshot({ path: join(screenshots, 'prompt-assistant.png'), fullPage: true })
    await panel.getByRole('button', { name: 'Use this prompt', exact: true }).click()
    await expect.poll(() => main.getByLabel('Image description', { exact: true }).inputValue()).toBe(expanded)
    expect(requests.slice(before).filter(request => request.path === '/v1/images/generations')).toHaveLength(0)
    expect(requests.slice(before).filter(request => request.path === '/v1/images/edits')).toHaveLength(0)

    const chatRequests = requests.slice(before).filter(request => request.path === '/v1/chat/completions')
    expect(chatRequests).toHaveLength(1)
    const chatBody = JSON.parse(chatRequests[0]?.body ?? '{}') as {
      model?: string
      stream?: boolean
      messages?: readonly { role: string; content: string }[]
    }
    expect(chatBody).toMatchObject({ model: 'assist-chat', stream: true })
    expect(chatBody.messages?.[0]?.role).toBe('system')
    expect(chatBody.messages?.at(-1)?.content).toBe('一只橘猫')

    // The expanded description suggests a panoramic 4K selection; applying it changes the dialog.
    await expect.poll(async () => (await suggestion.count())).toBe(1)
    expect(await suggestion.innerText()).toContain('21:9')
    await suggestion.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect.poll(async () => (await suggestion.count())).toBe(0)
    await main.getByRole('button', { name: 'Parameters', exact: true }).click()
    const parameters = page.getByRole('dialog', { name: 'Generation parameters', exact: true })
    await parameters.waitFor()
    expect(await parameters.getByRole('button', { name: '21:9', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await parameters.getByRole('button', { name: '4K', exact: true }).getAttribute('aria-pressed')).toBe('true')
    // Let the modal's entrance animation settle before capturing the validation screenshot.
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(screenshots, 'prompt-assistant-suggested-parameters.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await parameters.count())).toBe(0)
    expect(requests.slice(before).filter(request => request.path === '/v1/images/generations')).toHaveLength(0)
  }, 180_000)

  it('runs two styles as one serial variant batch and adopts a column prompt without generating', async () => {
    const screenshots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
    await mkdir(screenshots, { recursive: true })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Direct AI', exact: true }).first().click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Direct AI', exact: true }).waitFor({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Add service', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add service', exact: true })
    await dialog.getByLabel('Service name', { exact: true }).fill('Variant comparison route')
    await dialog.getByRole('radio', { name: 'OpenAI Images', exact: true }).check()
    await dialog.getByLabel('API base URL', { exact: true }).fill(`${baseURL}/v1`)
    await dialog.getByLabel('Model ID', { exact: true }).fill('variant-image')
    await dialog.getByLabel('API key', { exact: true }).fill(key)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })

    await page.getByRole('button', { name: 'Image generation', exact: true }).first().click()
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    const description = main.getByLabel('Image description', { exact: true })
    await description.fill('A lantern-lit alley')

    const before = requests.length
    await main.getByRole('button', { name: 'Style variants', exact: true }).click()
    const panel = main.getByRole('region', { name: 'Style variants', exact: true })
    await panel.waitFor()
    // Two styles: drop the third default style; the count keeps its default of three and runs the two checked ones.
    await panel.getByRole('checkbox', { name: 'Illustration', exact: true }).uncheck()
    await panel.getByRole('button', { name: 'Start batch', exact: true }).click()

    const generations = (): typeof requests =>
      requests.slice(before).filter(request => request.path === '/v1/images/generations')
    await expect.poll(() => generations().length, { timeout: 30_000 }).toBe(2)
    expect(generations().map((request) => {
      const parsed: unknown = JSON.parse(request.body)
      return typeof parsed === 'object' && parsed !== null && 'prompt' in parsed ? String(parsed.prompt) : ''
    })).toEqual([
      'A lantern-lit alley，写实摄影质感，自然光',
      'A lantern-lit alley，电影感画面，戏剧性布光，宽银幕构图',
    ])

    const columns = panel.getByRole('img', { name: 'Generated result', exact: true })
    await expect.poll(() => columns.count(), { timeout: 30_000 }).toBe(2)
    await expect.poll(() => columns.evaluateAll(elements => elements.every(element =>
      element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
    ))).toBe(true)
    await page.screenshot({ path: join(screenshots, 'variant-comparison.png'), fullPage: true })

    // A narrow viewport stacks the columns instead of overflowing.
    await page.setViewportSize({ width: 390, height: 844 })
    const grid = panel.getByRole('list')
    expect(await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1)
    expect(await main.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, 'variant-comparison-narrow.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })

    // Adopting a column writes its styled prompt into the description, closing the panel without a new request.
    await panel.getByRole('button', { name: 'Use this one', exact: true }).nth(1).click()
    await expect.poll(() => description.inputValue()).toBe('A lantern-lit alley，电影感画面，戏剧性布光，宽银幕构图')
    await expect.poll(() => panel.count()).toBe(0)
    expect(generations()).toHaveLength(2)
    expect(requests.slice(before).filter(request => request.path === '/v1/images/edits')).toHaveLength(0)
    await page.screenshot({ path: join(screenshots, 'variant-comparison-adopted.png'), fullPage: true })
  }, 180_000)

  it('switches workspaces from the composer mode bar', async () => {
    const screenshots = join(REPO_ROOT, '.playwright-mcp/image-studio-validation')
    await mkdir(screenshots, { recursive: true })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    await revealNavigationDrawer(page, 'en')
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'image-studio-mode-bar')
    const bar = page.getByRole('group', { name: 'Workspace', exact: true })
    await bar.waitFor({ timeout: 15_000 })
    expect(await bar.getByRole('button', { name: 'Chat', exact: true }).getAttribute('aria-pressed')).toBe('true')
    await page.screenshot({ path: join(screenshots, 'composer-mode-bar-chat.png'), fullPage: true })
    await bar.getByRole('button', { name: 'Image generation', exact: true }).click()
    const main = page.locator('[data-slot="main"]')
    await main.getByRole('heading', { name: 'Image generation', exact: true }).waitFor({ timeout: 15_000 })
    await main.getByRole('group', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Chat', exact: true }).click()
    await expect.poll(() => main.getByRole('heading', { name: 'Image generation', exact: true }).count()).toBe(0)
    await page.getByRole('group', { name: 'Workspace', exact: true })
      .getByRole('button', { name: 'Chat', exact: true }).waitFor({ timeout: 15_000 })
  }, 180_000)
})
