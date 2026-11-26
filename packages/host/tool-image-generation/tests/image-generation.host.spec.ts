/** Loader composition exercises owner-turn authority, real scoped dispatch and reversible registration. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type UserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { GeneratedImageResult, RunId, ServiceId } from '@deepseek-ai/dsh-direct-ai/types'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import ImageGeneration from '../src/index.ts'
import * as ImageTool from '../src/tool.ts'
import * as PersonalChat from '../src/chat.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { imageGenerationTestViewer: { readonly kind: 'image-test-viewer' } }
}

const RESULT: GeneratedImageResult = {
  runId: brandString<RunId>('r-fixture'), service: { id: brandString<ServiceId>('s-fixture'), name: 'Image route', model: 'fixture-image' },
  images: [{ attachmentId: brandString<AttachmentId>('sha256:fixture'), mediaType: 'image/png', bytes: 8, width: 1, height: 1 }],
}

async function composed(options: { configured?: boolean; provider?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-images-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const generate = vi.fn(async (_id: ServiceId, _prompt: string, signal: AbortSignal): Promise<GeneratedImageResult> => {
    signal.throwIfAborted()
    return RESULT
  })
  class Provider extends Service {
    constructor(child: Context) { super(child, 'directAi'); child.set('directAi', { generateImage: generate }) }
  }
  class AttachmentFixture extends Service {
    constructor(child: Context) { super(child, 'attachments') }
  }
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    { name: 'cordis:projections' }, { name: 'cordis:prompt' }, { name: 'cordis:tools' },
    { name: 'cordis:native' }, { name: 'cordis:agents' }, { name: 'cordis:attachment-fixture' },
    ...options.provider === false ? [] : [{ name: 'cordis:provider' }],
    { id: 'conversation-images', name: 'cordis:images', config: { defaultServiceId: options.configured === false ? '' : 's-fixture' } },
  ].map(row => `- ${JSON.stringify(row)}`).join('\n') + '\n')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, projections: SessionProjectionRegistry, prompt: SystemPrompt,
    tools: Tools, native: NativeExecutor, agents: AgentRegistry, provider: Provider, images: ImageGeneration,
    'attachment-fixture': AttachmentFixture })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  return { ctx, generate, updateDefault: async (value: string) => {
    const entry = [...ctx.loader.entries()].find(item => item.options.id === 'conversation-images')
    if (entry === undefined) throw new Error('Image service fixture was not loaded')
    await entry.update({ config: { defaultServiceId: value } })
  } }
}

async function agentFixture(ctx: Context, meta: { parentSession?: SessionId; origin?: 'subagent' } = {}) {
  const id = brandString<SessionId>('image-agent')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, ...meta })
  const agent = { id, session, ctx, options: {}, status: 'idle' } as Agent
  const unregister = await ctx.agents.register(agent)
  onTestFinished(unregister)
  return agent
}

function owner(): UserMessage {
  return createUserMessage({ source: { kind: 'user', rpcId: 'owner-browser-call' }, content: [{ type: 'text', text: 'Please generate an image.' }] })
}
function automation(): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Generate automatically.' }] })
}
function foreign(): UserMessage {
  return createUserMessage({ source: { kind: 'user', rpcId: 'foreign-browser-call', principal: { kind: 'image-test-viewer' } },
    content: [{ type: 'text', text: 'Untrusted viewer asks for an image.' }] })
}
async function admit(ctx: Context, agent: Agent, turn: number, messages: UserMessage[]) {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { turn, step: 1, messages,
    signal: new AbortController().signal, modelSelection: { provider: 'fixture', model: 'chat' } },
  async () => ({ kind: 'enter', messages }))
}
function open(agent: Agent, turn = 1): void { agent.session.append('turn/start', { turn }) }

async function mountTool(ctx: Context, agent: Agent) {
  let scope!: Scope
  await ctx.plugin(Object.assign((child: Context) => { scope = createScope(child, agent) }, { inject: ['tools', 'imageGeneration'] }))
  await scope.ctx.plugin(ImageTool)
  const execute = (args: unknown = { prompt: 'A seaside sunset' }, signal = new AbortController().signal, subject: Agent | undefined = agent) =>
    executeToolFixture(ctx, { name: 'generate_image', arguments: args, callId: brandString<ToolCallId>('image-call'), signal,
      ...subject === undefined ? {} : { agent: subject } })
  return { scope, execute }
}

it('uses the explicit image route once and returns replayable stored image content through scoped dispatch', async () => {
  const { ctx, generate } = await composed()
  const agent = await agentFixture(ctx)
  open(agent)
  await admit(ctx, agent, 1, [owner()])
  const { execute } = await mountTool(ctx, agent)
  const result = await execute()
  expect(result.isError).toBe(false)
  expect(result.content).toContainEqual({ type: 'image', attachment: RESULT.images[0] })
  expect(result.meta).toMatchObject({ runId: RESULT.runId, serviceName: 'Image route', model: 'fixture-image' })
  expect(generate).toHaveBeenCalledTimes(1)
  expect(generate.mock.calls[0]?.slice(0, 2)).toEqual(['s-fixture', 'A seaside sunset'])
  expect(JSON.stringify(result)).not.toMatch(/apiKey|authorization|Bearer/)
})

it.each(['unadmitted', 'automatic', 'foreign', 'no-open-turn', 'next-turn'] as const)(
  'rejects %s execution without calling the image provider', async (kind) => {
    const { ctx, generate } = await composed()
    const agent = await agentFixture(ctx)
    if (kind !== 'no-open-turn') open(agent)
    if (kind === 'automatic') await admit(ctx, agent, 1, [automation()])
    if (kind === 'foreign') await admit(ctx, agent, 1, [foreign()])
    if (kind === 'next-turn') {
      await admit(ctx, agent, 1, [owner()])
      agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      open(agent, 2)
    }
    const { execute } = await mountTool(ctx, agent)
    expect((await execute()).error?.info?.code).toBe('IMAGE_GENERATION_FORBIDDEN')
    expect(generate).not.toHaveBeenCalled()
  },
)

it('revokes a mixed-authority turn permanently and permits a later fresh owner turn', async () => {
  const { ctx, generate } = await composed()
  const agent = await agentFixture(ctx)
  open(agent)
  await admit(ctx, agent, 1, [owner()])
  await admit(ctx, agent, 1, [foreign()])
  await admit(ctx, agent, 1, [owner()])
  const { execute } = await mountTool(ctx, agent)
  expect((await execute()).error?.info?.code).toBe('IMAGE_GENERATION_FORBIDDEN')
  expect(generate).not.toHaveBeenCalled()
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  open(agent, 2)
  await admit(ctx, agent, 2, [owner()])
  expect((await execute()).isError).toBe(false)
  expect(generate).toHaveBeenCalledTimes(1)
})

it.each([{ parentSession: brandString<SessionId>('parent') }, { origin: 'subagent' as const }])(
  'rejects delegated or forked sessions despite copied owner inputs: %j', async (meta) => {
    const { ctx, generate } = await composed()
    const agent = await agentFixture(ctx, meta)
    open(agent)
    await admit(ctx, agent, 1, [owner()])
    await expect(ctx.imageGeneration.generate(agent, 'A sunset', new AbortController().signal))
      .rejects.toMatchObject({ code: 'IMAGE_GENERATION_FORBIDDEN' })
    expect(generate).not.toHaveBeenCalled()
  },
)

it.each([{ configured: false }, { provider: false }])('fails clearly before dispatch when configuration is unavailable: %j', async (options) => {
  const { ctx, generate } = await composed(options)
  const agent = await agentFixture(ctx)
  open(agent)
  await admit(ctx, agent, 1, [owner()])
  const { execute } = await mountTool(ctx, agent)
  expect((await execute()).error?.info?.code).toBe('IMAGE_GENERATION_NOT_CONFIGURED')
  expect(generate).not.toHaveBeenCalled()
})

it('rejects blank prompts, missing Agent ownership, pre-cancellation and stale Agent identity before provider work', async () => {
  const { ctx, generate } = await composed()
  const agent = await agentFixture(ctx)
  open(agent)
  await admit(ctx, agent, 1, [owner()])
  const { execute } = await mountTool(ctx, agent)
  expect((await execute({ prompt: '  ' })).error?.info?.code).toBe('INVALID_ARGS')
  const controller = new AbortController()
  controller.abort()
  await expect(ctx.imageGeneration.generate(agent, 'A sunset', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  const stale = { ...agent } as Agent
  await expect(ctx.imageGeneration.generate(stale, 'A sunset', new AbortController().signal))
    .rejects.toMatchObject({ code: 'IMAGE_GENERATION_FORBIDDEN' })
  const tool = ctx.tools.get('generate_image', agent)!
  await expect(tool.execute({ prompt: 'A sunset' }, { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1]))
    .rejects.toMatchObject({ code: 'TOOL_CONTEXT_UNAVAILABLE' })
  expect(generate).not.toHaveBeenCalled()
})

it('reads the latest explicit default service without accepting provider routing or credentials from tool arguments', async () => {
  const { ctx, generate, updateDefault } = await composed()
  const agent = await agentFixture(ctx)
  open(agent)
  await admit(ctx, agent, 1, [owner()])
  const { execute } = await mountTool(ctx, agent)
  await updateDefault('s-second-image-route')
  expect((await execute()).isError).toBe(false)
  expect(generate.mock.calls[0]?.slice(0, 2)).toEqual(['s-second-image-route', 'A seaside sunset'])
  await updateDefault('')
  expect((await execute()).error?.info?.code).toBe('IMAGE_GENERATION_NOT_CONFIGURED')
  expect(generate).toHaveBeenCalledTimes(1)
  const schema = ctx.tools.schemas(agent).find(tool => tool.name === 'generate_image')!
  expect(Object.keys(schema.parameters.properties ?? {})).toEqual(['prompt'])
})

it('forwards cancellation to an issued request and settles it once without retrying', async () => {
  const { ctx, generate } = await composed()
  const agent = await agentFixture(ctx)
  open(agent)
  await admit(ctx, agent, 1, [owner()])
  const started = Promise.withResolvers<undefined>()
  generate.mockImplementationOnce(async (_id, _prompt, signal) => {
    started.resolve(undefined)
    await new Promise<undefined>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Fixture cancelled'))
      }, { once: true })
    })
    throw new Error('Cancelled provider fixture must not resume')
  })
  const controller = new AbortController()
  const pending = ctx.imageGeneration.generate(agent, 'A sunset', controller.signal)
  await started.promise
  controller.abort()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(generate).toHaveBeenCalledTimes(1)
})

it('does not grant authority from rewritten rejected steps or from owner-like external queue sources', async () => {
  const { ctx, generate } = await composed()
  const agent = await agentFixture(ctx)
  open(agent)
  const ownerMessage = owner()
  await agentEvents(ctx, agent).waterfall('agent/pre-step', { turn: 1, step: 1, messages: [ownerMessage],
    signal: new AbortController().signal, modelSelection: { provider: 'fixture', model: 'chat' } },
  async () => ({ kind: 'reject' }))
  await expect(ctx.imageGeneration.generate(agent, 'A sunset', new AbortController().signal))
    .rejects.toMatchObject({ code: 'IMAGE_GENERATION_FORBIDDEN' })
  const scheduled = { ...ownerMessage, source: { kind: 'schedule', rpcId: 'not-a-browser-input' } } as UserMessage
  await admit(ctx, agent, 1, [scheduled])
  await expect(ctx.imageGeneration.generate(agent, 'A sunset', new AbortController().signal))
    .rejects.toMatchObject({ code: 'IMAGE_GENERATION_FORBIDDEN' })
  expect(generate).not.toHaveBeenCalled()
})

it('retains the preset image tool in child Agent scopes while hiding inherited coding tools and disposing its listener', async () => {
  const { ctx } = await composed()
  ctx.tools.register(defineTool({ name: 'coding_fixture', description: 'Inherited coding capability.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'coding' } }))
  const presetKey = {}
  let preset!: Scope
  await ctx.plugin(Object.assign((child: Context) => { preset = createScope(child, presetKey) },
    { inject: ['tools', 'imageGeneration', 'agents'] }))
  onTestFinished(() => preset.dispose())
  await preset.ctx.plugin(ImageTool)
  const mask = preset.ctx.plugin(PersonalChat)
  await mask
  async function childAgent(id: string) {
    const sessionId = brandString<SessionId>(id)
    const session = Session.create(sessionId)
    const agent = { id: sessionId, session, options: {}, status: 'idle' } as Agent
    const scope = createScope(preset.ctx, agent, { parent: presetKey })
    Object.assign(agent, { ctx: scope.ctx })
    onTestFinished(() => scope.dispose())
    await agentEvents(ctx, agent).serial('agent/created', { source: 'startup' })
    return { agent, scope }
  }
  const first = await childAgent('personal-child')
  expect(ctx.tools.schemas(first.agent).map(tool => tool.name)).toEqual(['generate_image'])
  expect(ctx.tools.get('generate_image', first.agent)).toBeDefined()
  expect(ctx.tools.get('coding_fixture', first.agent)).toBeUndefined()
  expect(ctx.tools.schemas(presetKey).map(tool => tool.name).sort()).toEqual(['coding_fixture', 'generate_image'])
  expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(['coding_fixture'])
  const retained = await childAgent('live-at-mask-unload')
  expect(ctx.tools.schemas(retained.agent).map(tool => tool.name)).toEqual(['generate_image'])
  await first.scope.dispose()
  expect(ctx.tools.schemas(first.agent).map(tool => tool.name).sort()).toEqual(['coding_fixture', 'generate_image'])
  await mask.dispose()
  expect(ctx.tools.schemas(retained.agent).map(tool => tool.name).sort()).toEqual(['coding_fixture', 'generate_image'])
  const afterUnload = await childAgent('after-chat-mask-unload')
  expect(ctx.tools.schemas(afterUnload.agent).map(tool => tool.name).sort()).toEqual(['coding_fixture', 'generate_image'])
  await preset.dispose()
  expect(ctx.tools.schemas(first.agent).map(tool => tool.name)).toEqual(['coding_fixture'])
})

it('removes the authority listeners and refuses old service handles after the Host owner disposes', async () => {
  const { ctx, generate } = await composed()
  const agent = await agentFixture(ctx)
  open(agent)
  await admit(ctx, agent, 1, [owner()])
  const service = ctx.imageGeneration
  await ctx.fiber.dispose()
  await expect(service.generate(agent, 'A sunset', new AbortController().signal))
    .rejects.toMatchObject({ code: 'IMAGE_GENERATION_FORBIDDEN' })
  expect(generate).not.toHaveBeenCalled()
})
