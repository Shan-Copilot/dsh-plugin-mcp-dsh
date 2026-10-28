/**
 * DSH Sessions MCP — Host plugin.
 *
 * Mounts one Streamable-HTTP MCP endpoint on the existing DSH Web server and
 * exposes session operations through `sessionController`, the same entry the
 * Web UI uses. No second listener, no separate process.
 */

import fs from 'node:fs'
import path from 'node:path'

import { createProtocol } from './lib/mcp/protocol.js'
import { createTransport } from './lib/mcp/transport.js'
import {
  isLoopbackOrigin,
  migrateLegacyToken,
  resolveAuth,
  stateDir,
  writeClientConfig,
} from './lib/mcp/auth.js'
import { ADMIN_PATH, createAdminHandler } from './lib/keys/admin.js'
import { KeyStore } from './lib/keys/store.js'
import { createSessionService } from './lib/sessions/service.js'
import { createTools } from './lib/tools.js'

export const name = 'mcp-dsh'
export const inject = ['webServer', 'sessionController', 'connection']

const VERSION = '0.3.0'
const SERVER_INFO = {
  name: 'dsh-sessions',
  title: 'DSH Sessions',
  version: VERSION,
}

const INSTRUCTIONS = [
  'DSH session bridge. Typical flow: dsh_list_workspaces / dsh_list_presets -> dsh_create_session',
  '-> dsh_session_send_message -> dsh_session_wait(until:"idle") -> dsh_session_read_messages.',
  'dsh_session_wait is a long poll: if it returns state running with timedOut true, call it again',
  'with the returned cursor as sinceSeq. After reconnecting, call dsh_get_session, then',
  'dsh_session_read_messages and dsh_session_wait with the last cursor.',
  'A session whose previous turn was interrupted (including a DSH crash) is reported as state',
  'interrupted. Sending a message repairs it internally; there is no resume tool.',
  'Approvals and questions are answered in the DSH UI; dsh_session_wait reports waiting_approval',
  'or waiting_input instead of answering them.',
].join(' ')

function normalize(raw = {}) {
  const route = typeof raw.path === 'string' && raw.path.trim().startsWith('/')
    ? raw.path.trim().replace(/\/+$/, '')
    : '/mcp-dsh'
  const number = (value, fallback, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.min(Math.max(Math.trunc(value), min), max)
  }
  return {
    path: route.length > 0 ? route : '/mcp-dsh',
    mode: raw.mode === 'read-only' ? 'read-only' : 'full',
    auth: raw.auth === 'none' ? 'none' : 'bearer',
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    defaultWaitMs: number(raw.defaultWaitMs, 25_000, 0, 300_000),
    maxWaitMs: number(raw.maxWaitMs, 120_000, 0, 600_000),
    maxPromptChars: number(raw.maxPromptChars, 100_000, 1_000, 1_000_000),
    maxReadChars: number(raw.maxReadChars, 120_000, 1_000, 1_000_000),
    maxKeys: number(raw.maxKeys, 20, 1, 100),
    allowSubagentSessions: raw.allowSubagentSessions === true,
    audit: raw.audit !== false,
  }
}

function createLogger(config, dir) {
  const file = path.join(dir, 'mcp-dsh.log')
  try {
    fs.mkdirSync(dir, { recursive: true })
    if (fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
  } catch {
    // A missing or unreadable log is not fatal.
  }
  return function log(level, fields) {
    if (config.audit !== true && level !== 'error') return
    try {
      fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), level, ...fields })}\n`)
    } catch {
      // Logging must never break the endpoint.
    }
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = normalize(rawConfig)
  const dir = stateDir()
  const log = createLogger(config, dir)

  let origin
  try {
    origin = ctx.webServer.getOrigin()
  } catch {
    origin = undefined
  }

  // A reachable non-loopback listener with no token would let any peer drive
  // the user's sessions; force the token instead of refusing to load.
  if (config.auth === 'none' && origin !== undefined && !isLoopbackOrigin(origin)) {
    config.auth = 'bearer'
    log('auth-forced', { origin, reason: 'non-loopback-listener' })
  }

  const store = new KeyStore({
    file: path.join(dir, 'keys.json'),
    maxActive: config.maxKeys,
    log,
  }).load()
  const migration = migrateLegacyToken({ dir, config, store, log })
  const auth = resolveAuth(config, { store, legacyToken: migration.legacyToken, log })
  const startedAt = Date.now()
  ctx.effect(() => () => store.dispose(), 'mcp-dsh: key store')

  const service = createSessionService({ ctx, config, log })
  ctx.effect(() => () => service.dispose(), 'mcp-dsh: wait hub')

  const tools = createTools({
    service,
    config,
    status: async () => {
      let sessionCount
      let runningCount
      try {
        const value = await service.counts()
        sessionCount = value.total
        runningCount = value.running
      } catch {
        // Counts are informational; the endpoint still answers.
      }
      return {
        ok: true,
        endpoint: origin === undefined ? config.path : `${origin}${config.path}`,
        version: VERSION,
        mode: config.mode,
        auth: auth.mode,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        waiters: service.waiterCount(),
        keys: store.activeCount(),
        admin: ADMIN_PATH,
        ...(sessionCount === undefined ? {} : { sessionCount, runningCount }),
        ...(origin !== undefined && auth.mode === 'bearer'
          ? { clientConfig: path.join(dir, 'client-config.json') }
          : {}),
      }
    },
  })

  const protocol = createProtocol({
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
    listTools: () => tools.list(),
    callTool: (toolName, args, context) => tools.call(toolName, args, context),
    log,
  })

  const transport = createTransport({
    path: config.path,
    auth,
    handleMessage: (msg, context) => protocol(msg, context),
    log,
  })

  const adminHandler = createAdminHandler({
    store,
    connection: ctx.get('connection'),
    origin,
    mcpPath: config.path,
    authMode: auth.mode,
    log,
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ADMIN_PATH, handler: adminHandler }),
    'mcp-dsh: admin route',
  )

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: config.path, handler: transport.handler }),
    'mcp-dsh: route',
  )
  ctx.effect(() => () => transport.close(), 'mcp-dsh: sse')

  if (origin !== undefined) {
    const file = writeClientConfig({ dir, origin, path: config.path, auth })
    log('mounted', {
      endpoint: `${origin}${config.path}`,
      version: VERSION,
      auth: auth.mode,
      mode: config.mode,
      tools: tools.count,
      keys: store.activeCount(),
      admin: ADMIN_PATH,
      migrated: migration.migrated === true,
      clientConfig: file,
    })
    try {
      const modules = ctx.get('clientModules')
      const graph = modules?.graph?.()
      const entry = graph?.entries?.find((item) => item.id === '@local/mcp-dsh')
      log('client-module', { registered: entry !== undefined, entry })
    } catch (error) {
      log('client-module-read-failed', { message: error instanceof Error ? error.message : String(error) })
    }
    if (auth.mode === 'bearer' && store.activeCount() === 0 && config.token.length === 0) {
      log('no-keys', { hint: 'create an API key on the plugin page before connecting clients' })
    }
  } else {
    log('mounted-without-origin', { path: config.path, auth: auth.mode, keys: store.activeCount() })
  }
}
