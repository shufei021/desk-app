/** One real conversation invokes a configured image provider, renders durable images, and resumes after reload. */
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, REPO_ROOT } from './support.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const key = 'conversation-image-fixture-key-not-real'
const callId = brandString<ToolCallId>('conversation-image-call')
const toolChunks: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: callId, name: 'generate_image', argumentsDelta: '{"prompt":"A sunset over the sea"}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'generate_image', arguments: '{"prompt":"A sunset over the sea"}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
function textChunks(text: string): StreamChunk[] {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

describe('personal chat with configured image generation', () => {
  let scaffold: WebScaffold
  let server: Server
  let browser: Browser
  let page: Page
  let root: string
  let baseURL: string
  const requests: { authorization: string | undefined; body: unknown; path: string }[] = []
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-conversation-images-'))
    const script: ReplayOverrideDoc = [{ kind: 'chunks', chunks: toolChunks },
      { kind: 'chunks', chunks: textChunks('Your image is ready in this conversation.') },
      { kind: 'chunks', chunks: textChunks('We can keep chatting here without generating another image.') }]
    const replayOverride = join(root, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(script))
    server = createServer((req, res) => { void (async () => {
      const parts: Buffer[] = []
      for await (const part of req) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)))
      const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
      requests.push({ authorization: req.headers.authorization, path: req.url ?? '', body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: png, url: 'https://unused.example/image' }] }))
    })().catch(() => res.destroy()) })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Image fixture has no port')
    baseURL = `http://127.0.0.1:${address.port}/v1`
    scaffold = await launchWebScaffold({ conversationImages: true, agentPresets: { default: 'personal-chat' },
      replayFixture: join(root, 'override-only.jsonl'), replayOverride, replayContextWindow: 1_000_000 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl)
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'conversation-image-e2e')
  }, 120_000)
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    }
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })
  it('configures images next to chat models and keeps image output in the same conversation', async () => {
    await openSettings(page, 'en')
    await page.getByRole('button', { name: 'Models', exact: true }).click()
    const settings = page.getByRole('region', { name: 'Conversation images', exact: true })
    await settings.getByLabel('Service name', { exact: true }).fill('Image route for conversations')
    await settings.getByLabel('API base URL', { exact: true }).fill(baseURL)
    await settings.getByLabel('Image model ID', { exact: true }).fill('gpt-image-fixture')
    await settings.getByLabel('API key', { exact: true }).fill(key)
    await settings.getByRole('button', { name: 'Save and use for conversation images', exact: true }).click()
    await expect.poll(() => settings.getByRole('button', { name: 'Image service for conversations', exact: true }).textContent())
      .toContain('Image route for conversations')
    expect(await settings.getByLabel('API key', { exact: true }).inputValue()).toBe('')
    const screenshots = join(REPO_ROOT, '.playwright-mcp/conversation-image-validation')
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'settings-light.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' })
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill('Generate a sunset over the sea.')
    const completed = scaffold.whenTurnSettled(60_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const sessionId = await completed
    await page.getByText('Your image is ready in this conversation.', { exact: true }).waitFor()
    const result = page.getByRole('region', { name: 'Image generated', exact: true })
    await page.screenshot({ path: join(screenshots, 'generation-diagnostic.png'), fullPage: true })
    await writeFile(join(screenshots, 'generation-diagnostic.json'), JSON.stringify({
      events: scaffold.ctx.sessions.get(sessionId)?.snapshotEvents().filter(event => event.type === 'tool/result' || event.type === 'tool/call'),
      body: await page.locator('body').innerText(), requestCount: requests.length,
    }, null, 2))
    await result.getByRole('img').first().waitFor()
    expect(await result.getByRole('img').first().evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true)
    expect(requests).toEqual([{ path: '/v1/images/generations', authorization: `Bearer ${key}`,
      body: { model: 'gpt-image-fixture', prompt: 'A sunset over the sea' } }])
    const session = scaffold.ctx.sessions.get(sessionId)
    expect(session).toBeDefined()
    const events = session!.snapshotEvents()
    expect(JSON.stringify(events)).not.toContain(key)
    expect(events.some(event => event.type === 'tool/result' && event.data.message.toolCallId === callId)).toBe(true)
    const instructions = events.filter(event => event.type === 'system/message').map(event => JSON.stringify(event.data)).join('\n')
    expect(instructions).not.toContain('coding agent')
    expect(instructions).not.toContain('AGENTS.md')
    await page.screenshot({ path: join(screenshots, 'conversation-light.png'), fullPage: true })
    await page.reload()
    await page.getByRole('region', { name: 'Image generated', exact: true }).getByRole('img').first().waitFor()
    await composer.fill('Keep chatting about the view, without generating another image.')
    const continued = scaffold.whenTurnSettled(60_000)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    expect(await continued).toBe(sessionId)
    await page.getByText('We can keep chatting here without generating another image.', { exact: true }).waitFor()
    expect(requests).toHaveLength(1)
    await openSettings(page, 'en')
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'General', exact: true }).click()
    await dialog.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.getByRole('heading', { name: 'Conversation images', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(screenshots, 'settings-dark.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await settings.getByRole('button', { name: 'Save and use for conversation images', exact: true }).scrollIntoViewIfNeeded()
    expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: join(screenshots, 'settings-mobile-dark.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    const historyImage = page.getByRole('region', { name: 'Image generated', exact: true }).getByRole('img').first()
    await historyImage.scrollIntoViewIfNeeded()
    const closeSidebar = page.getByRole('button', { name: 'Close sidebar', exact: true })
    if (await closeSidebar.isVisible()) await closeSidebar.click()
    await page.locator('[data-composer-input]').last().click()
    await page.screenshot({ path: join(screenshots, 'conversation-mobile-dark.png'), fullPage: true })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: join(screenshots, 'conversation-dark.png'), fullPage: true })
  }, 120_000)
})
