import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';

const requestSchema = z.object({ sessionId: z.string().min(1).max(256) });
const setSchema = requestSchema.extend({ limit: z.number().int().min(1).max(10).nullable() });
const stateSchema = z.object({
  sessionId: z.string(), rootSessionId: z.string(),
  limit: z.number().int().min(1).max(10).nullable(),
  active: z.number().int().nonnegative(), queued: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(), hostCapacity: z.number().int().positive().nullable(),
  trackedChildren: z.number().int().nonnegative(), parkedChildren: z.number().int().nonnegative(),
  serialAgentId: z.string().nullable(), monitorMode: z.enum(['native', 'events']),
});
const codec = (schema, symbol) => ({
  mode: 'strict', typeSymbol: `@local/session-concurrency#${symbol}`,
  create: () => schema,
  jsonSchema: z.toJSONSchema(schema),
});
const definition = (schema, symbol) => ({
  service: 'sessionConcurrency', invocation: { kind: 'direct' },
  parameters: [{ name: 'request', source: 'json',
    codec: codec(schema, symbol), strictCodec: codec(schema.strict(), symbol) }],
  result: codec(stateSchema, 'Snapshot'),
});

/** Shared native Remote contribution, mounted on both Host and Client. */
export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: '@local/session-concurrency',
  methods: {
    'sessionConcurrency/get': definition(requestSchema, 'GetRequest'),
    'sessionConcurrency/set': definition(setSchema, 'SetRequest'),
  },
}, z);

export default TYPERT_REMOTE;
