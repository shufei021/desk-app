/** Versioned direct-request data, separate from Agent logs and credential storage. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { RunId, RunRecord, ServiceId } from './types.ts'
import { requestSchema, serviceFieldsSchema, serviceSchema } from './validation.ts'

/** Private immutable credential pointer; old local development records fail closed until a key is saved again. */
export const storedServiceSchema = serviceFieldsSchema.extend({ credentialId: z.string().regex(/^c-[0-9a-f-]{36}$/).optional() })
  .transform(value => ({
    ...serviceSchema.parse({ id: value.id, name: value.name, capability: value.capability, baseURL: value.baseURL,
      model: value.model, ...value.endpoint === undefined ? {} : { endpoint: value.endpoint },
      ...value.editEndpoint === undefined ? {} : { editEndpoint: value.editEndpoint },
      ...value.parametersJson === undefined ? {} : { parametersJson: value.parametersJson },
      ...value.platform === undefined ? {} : { platform: value.platform },
      ...value.groupId === undefined ? {} : { groupId: value.groupId },
      ...value.groupName === undefined ? {} : { groupName: value.groupName } }),
    ...value.credentialId === undefined ? {} : { credentialId: value.credentialId },
  }))

const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('progress'), status: z.string(), progress: z.number().optional() }).strict().transform(value => ({
    type: value.type, status: value.status, ...value.progress === undefined ? {} : { progress: value.progress },
  })),
  z.object({ type: z.literal('media'), url: z.string(), mime: z.string() }).strict(),
  z.object({ type: z.literal('done') }).strict(),
])
const runSchema: z.ZodType<RunRecord> = z.object({
  id: z.string().transform(value => value as RunId), service: serviceSchema, request: requestSchema,
  startedAt: z.number(), finishedAt: z.number().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']), frames: z.array(frameSchema),
  error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict().transform(value => ({
  id: value.id, service: value.service, request: value.request, startedAt: value.startedAt,
  status: value.status, frames: value.frames,
  ...value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt },
  ...value.error === undefined ? {} : { error: value.error },
}))

/** Metadata used to serve media by identity; no caller-controlled path exists. */
export const mediaSchema = z.object({
  id: z.uuid(), runId: z.string().transform(value => value as RunId),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']),
  size: z.number().int().positive(),
}).strict()

/** Non-secret domain starts empty for a new Harness home. */
export const directDomain = defineDomain({
  name: 'direct_ai', version: 2, compatibleVersions: [1], layout: 'per-record',
  tables: {
    services: domainTable<ServiceId, z.infer<typeof storedServiceSchema>>(storedServiceSchema),
    runs: domainTable<RunId, RunRecord>(runSchema),
    media: domainTable<string, z.infer<typeof mediaSchema>>(mediaSchema),
  },
})
