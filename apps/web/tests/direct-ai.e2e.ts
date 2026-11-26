/** Real Web composition exercises direct HTTP protocols without an Agent model round or workspace selection. */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

interface ObservedRequest { path: string; authorization: string | undefined; body: string }

async function addService(page: Page, baseURL: string, capability: 'chat' | 'image' | 'video'): Promise<void> {
  await page.getByRole('button', { name: 'Add service', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add service', exact: true })
  await dialog.getByLabel('Service name', { exact: true }).fill(`Personal ${capability}`)
  const protocol = capability === 'chat' ? 'OpenAI Chat Completions' : capability === 'image' ? 'OpenAI Images' : 'OpenAI Videos (asynchronous)'
  await dialog.getByRole('radio', { name: protocol, exact: true }).check()
  await dialog.getByLabel('API base URL', { exact: true }).fill(`${baseURL}/v1`)
  await dialog.getByLabel('API key', { exact: true }).fill('fixture-direct-key-not-a-real-secret')
  if (capability === 'chat') {
    await dialog.getByRole('button', { name: 'Get models for this key', exact: true }).click()
    await dialog.getByLabel('Search model IDs, platforms or groups', { exact: true }).fill('fixture-chat')
    await dialog.getByRole('button', { name: /fixture-chat.*openai/ }).click()
    expect(await dialog.getByLabel('Model ID', { exact: true }).inputValue()).toBe('fixture-chat')
    await dialog.getByLabel('Group label (optional)', { exact: true }).fill('Personal chat route')
  } else await dialog.getByLabel('Model ID', { exact: true }).fill(`fixture-${capability}`)
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

describe('personal direct provider interface', () => {
  let server: Server
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let directory: string
  let baseURL: string
  const requests: ObservedRequest[] = []
  let videoChecks = 0

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-direct-web-'))
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const value: unknown = chunk
          if (typeof value === 'string' || Buffer.isBuffer(value)) chunks.push(Buffer.from(value))
          else throw new Error('Unexpected fixture request chunk')
        }
        const body = Buffer.concat(chunks).toString('utf8')
        const path = request.url ?? ''
        requests.push({ path, body, authorization: request.headers.authorization })
        if (path === '/v1/models') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ object: 'list', data: [
            { id: 'fixture-chat', owned_by: 'openai' }, { id: 'another-model', owned_by: 'anthropic' },
          ] }))
        } else if (path === '/v1/chat/completions') {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Direct fixture answer' }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`)
        } else if (path === '/v1/images/generations') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZxkAAAAASUVORK5CYII=' }] }))
        } else if (path === '/v1/videos' && request.method === 'POST') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ id: 'video-fixture', status: 'queued', progress: 0 }))
        } else if (path === '/v1/videos/video-fixture') {
          videoChecks += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ id: 'video-fixture', status: 'completed', progress: 100 }))
        } else if (path === '/v1/videos/video-fixture/content') {
          response.writeHead(200, { 'content-type': 'video/mp4' })
          // This fixture verifies protocol and delivery, not video decoding or playback.
          response.end(Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]))
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
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    }
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it('reveals configured capabilities, sends direct input, and retains results in the real Host', async () => {
    const errors: string[] = []
    const consoleMessages: string[] = []
    page.on('console', (message) => { consoleMessages.push(`${message.type()}: ${message.text()}`) })
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    const main = page.locator('[data-slot="main"]')
    try {
      await main.getByRole('heading', { name: 'Direct AI', exact: true }).waitFor({ timeout: 20_000 })
    } catch (error) {
      const diagnostics = join(REPO_ROOT, '.playwright-mcp/direct-ai-validation')
      await mkdir(diagnostics, { recursive: true })
      await page.screenshot({ path: join(diagnostics, 'startup-failure.png'), fullPage: true })
      await writeFile(join(diagnostics, 'startup-failure.txt'), JSON.stringify({
        errors, consoleMessages, body: await page.locator('body').innerText(),
      }))
      throw error
    }
    await main.getByText('Add an API service to begin', { exact: true }).waitFor()
    expect(await main.getByRole('tab', { name: 'Images', exact: true }).count()).toBe(0)
    await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/direct-ai-empty.expected.md'),
      await captureStableAria(page, '[data-slot="main"]', scaffold.workspaceCwd), scaffold.mode)
    await addService(page, baseURL, 'chat')
    expect(requests.filter(request => request.path === '/v1/models')).toHaveLength(1)
    expect(requests.find(request => request.path === '/v1/models')?.authorization).toBe('Bearer fixture-direct-key-not-a-real-secret')
    await main.getByLabel('Search API services', { exact: true }).fill('no-match')
    await main.getByText('No services match. Adjust the search or filters.', { exact: true }).waitFor()
    await main.getByLabel('Search API services', { exact: true }).fill('Personal chat')
    await main.getByText('Personal chat route', { exact: false }).first().waitFor()
    await main.getByLabel('Search API services', { exact: true }).fill('')
    expect(await main.getByRole('tab', { name: 'Chat', exact: true }).isVisible()).toBe(true)
    expect(await main.getByRole('tab', { name: 'Images', exact: true }).count()).toBe(0)
    await main.getByLabel('Input', { exact: true }).fill('Hello directly')
    await main.getByRole('button', { name: 'Send', exact: true }).click()
    await main.getByText('Direct fixture answer', { exact: true }).waitFor()
    await main.getByText('Completed', { exact: true }).first().waitFor()
    const chat = requests.find(request => request.path === '/v1/chat/completions')
    expect(chat?.authorization).toBe('Bearer fixture-direct-key-not-a-real-secret')
    expect(JSON.parse(chat?.body ?? '{}')).toEqual({ model: 'fixture-chat', messages: [{ role: 'user', content: 'Hello directly' }], stream: true })

    await addService(page, baseURL, 'image')
    await main.getByLabel('Input', { exact: true }).fill('One pixel')
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    const image = main.getByRole('img', { name: 'Generated result', exact: true })
    await image.waitFor()
    await expect.poll(() => image.evaluate(element =>
      element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
    )).toBe(true)
    expect(JSON.parse(requests.find(request => request.path === '/v1/images/generations')?.body ?? '{}')).toEqual({ model: 'fixture-image', prompt: 'One pixel' })
    const mediaURL = await image.getAttribute('src')
    expect(mediaURL).toMatch(/^api\/direct-ai\/media\?id=/)
    const unauthenticated = await fetch(new URL(mediaURL ?? '', `${scaffold.baseUrl}/`))
    expect(unauthenticated.status).not.toBe(200)

    await addService(page, baseURL, 'video')
    await main.getByLabel('Input', { exact: true }).fill('A short view')
    await main.getByRole('button', { name: 'Generate', exact: true }).click()
    await main.getByText('Completed', { exact: true }).first().waitFor()
    await main.getByRole('link', { name: 'Open or download', exact: true }).waitFor()
    expect(videoChecks).toBe(1)
    expect(requests.filter(request => request.path === '/v1/videos' && request.body.includes('A short view'))).toHaveLength(1)
    expect(requests.filter(request => request.path.startsWith('/v1/videos')).every(request => request.authorization === 'Bearer fixture-direct-key-not-a-real-secret')).toBe(true)

    await page.reload({ waitUntil: 'load' })
    await main.getByRole('heading', { name: 'Direct AI', exact: true }).waitFor()
    await main.getByRole('tab', { name: 'Video', exact: true }).waitFor()
    await main.getByText('Request history', { exact: true }).click()
    await main.getByRole('button', { name: /^View Personal / }).first().waitFor()
    expect(await page.locator('body').innerText()).not.toContain('fixture-direct-key-not-a-real-secret')
    expect(errors).toEqual([])

    const screenshots = join(REPO_ROOT, '.playwright-mcp/direct-ai-validation')
    await mkdir(screenshots, { recursive: true })
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme })
      await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'dark' ? '' : null)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await main.getByRole('heading', { name: 'Direct AI', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(screenshots, `desktop-${theme}.png`), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      const frame = page.locator('[data-sidebar-drawer]')
      await frame.waitFor({ state: 'attached' })
      const sidebar = page.locator('[data-slot="sidebar"]')
      if (await frame.getAttribute('data-sidebar-collapsed') === null) {
        await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      }
      await expect.poll(() => sidebar.locator('..').evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.right <= 0 || getComputedStyle(element).display === 'none'
      })).toBe(true)
      await main.getByRole('heading', { name: 'Direct AI', exact: true }).scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `mobile-${theme}.png`), fullPage: true })
      await main.getByRole('button', { name: 'Add service', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Add service', exact: true })
      await editor.getByLabel('Service name', { exact: true }).fill('A long personal service name for narrow-layout review')
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await editor.getByRole('alert').waitFor()
      expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, `mobile-editor-${theme}.png`), fullPage: true })
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    if (process.env.DSH_DIRECT_PUBLIC_SMOKE === '1') {
      await page.setViewportSize({ width: 1440, height: 1000 })
      await main.getByRole('button', { name: 'Add service', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Add service', exact: true })
      await editor.getByRole('button', { name: 'CrazyToken / aiyoyoo', exact: true }).click()
      expect(await editor.getByLabel('API base URL', { exact: true }).inputValue()).toBe('https://www.aiyoyoo.com/v1')
      expect(await editor.getByLabel('API key', { exact: true }).inputValue()).toBe('')
      await editor.getByRole('button', { name: 'Public model directory', exact: true }).click()
      await editor.getByLabel('Search model IDs, platforms or groups', { exact: true }).fill('claude')
      await editor.getByRole('button', { name: 'Platform: All', exact: true }).click()
      await page.getByRole('menuitem', { name: 'anthropic', exact: true }).click()
      await editor.getByRole('button', { name: 'Group: All', exact: true }).waitFor()
      await editor.getByRole('heading', { name: 'Model directory', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(screenshots, 'directory-public-desktop.png'), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.screenshot({ path: join(screenshots, 'directory-public-mobile.png'), fullPage: true })
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    await writeFile(join(screenshots, 'transport-note.txt'), 'Real built Web/Host composition; local deterministic HTTP fixture; no real model round. Video fixture tests transport, not decoding.\n')
  })
})
