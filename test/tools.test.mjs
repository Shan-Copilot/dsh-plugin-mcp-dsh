import assert from 'node:assert/strict'
import test from 'node:test'

import { createTools } from '../lib/tools.js'

function serviceStub(overrides = {}) {
  const calls = []
  const record = (name) => async (args) => {
    calls.push({ name, args })
    return { from: name }
  }
  const service = {
    listSessions: record('listSessions'),
    getSession: record('getSession'),
    createSession: record('createSession'),
    sendMessage: record('sendMessage'),
    interruptSession: record('interruptSession'),
    archiveSession: record('archiveSession'),
    readSession: record('readSession'),
    listWorkspaces: record('listWorkspaces'),
    listPresets: record('listPresets'),
    wait: record('wait'),
    waiterCount: () => 0,
    dispose: () => {},
    ...overrides,
  }
  return { service, calls }
}

const config = { mode: 'full', defaultWaitMs: 240_000, maxWaitMs: 240_000 }

test('full mode exposes eleven tools', () => {
  const { service } = serviceStub()
  const tools = createTools({ service, config, status: () => ({ ok: true }) })
  assert.equal(tools.count, 11)
  assert.deepEqual(
    tools.list().map((tool) => tool.name).sort(),
    [
      'dsh_archive_session',
      'dsh_create_session',
      'dsh_get_session',
      'dsh_list_presets',
      'dsh_list_sessions',
      'dsh_list_workspaces',
      'dsh_server_status',
      'dsh_session_interrupt_turn',
      'dsh_session_read_messages',
      'dsh_session_send_message',
      'dsh_session_wait',
    ],
  )
})

test('read-only mode keeps only observation tools', () => {
  const { service } = serviceStub()
  const tools = createTools({ service, config: { ...config, mode: 'read-only' }, status: () => ({ ok: true }) })
  assert.deepEqual(
    tools.list().map((tool) => tool.name).sort(),
    [
      'dsh_get_session',
      'dsh_list_presets',
      'dsh_list_sessions',
      'dsh_list_workspaces',
      'dsh_server_status',
      'dsh_session_read_messages',
      'dsh_session_wait',
    ],
  )
})

test('dsh_session_wait advertises the configured wait cap', () => {
  const { service } = serviceStub()
  const tools = createTools({ service, config, status: () => ({ ok: true }) })
  const wait = tools.list().find((tool) => tool.name === 'dsh_session_wait')
  assert.equal(wait.inputSchema.properties.timeoutMs.maximum, config.maxWaitMs)
  assert.match(wait.inputSchema.properties.timeoutMs.description, /Defaults to 240000ms, capped at 240000ms/)
  assert.match(wait.inputSchema.properties.timeoutMs.description, /300000ms for undici\/Node fetch/)
  assert.match(wait.description, /300000ms/)
})

test('dsh_session_read_messages omits tool calls by default', () => {
  const { service } = serviceStub()
  const tools = createTools({ service, config, status: () => ({ ok: true }) })
  const read = tools.list().find((tool) => tool.name === 'dsh_session_read_messages')
  assert.equal(read.inputSchema.properties.includeToolCalls.default, false)
})

test('unknown tools return an isError result', async () => {
  const { service } = serviceStub()
  const tools = createTools({ service, config, status: () => ({ ok: true }) })
  const result = await tools.call('nope', {})
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0].text).error.code, 'UNSUPPORTED')
})

test('a domain error becomes an isError result with its code', async () => {
  const { service } = serviceStub({
    getSession: async () => {
      throw Object.assign(new Error('missing'), { name: 'ToolError', code: 'SESSION_NOT_FOUND', hint: 'list first' })
    },
  })
  const tools = createTools({ service, config, status: () => ({ ok: true }) })
  const result = await tools.call('dsh_get_session', { sessionId: 'x' })
  assert.equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  assert.equal(body.error.code, 'SESSION_NOT_FOUND')
  assert.equal(body.error.hint, 'list first')
})

test('successful results are JSON text content', async () => {
  const { service, calls } = serviceStub()
  const tools = createTools({ service, config, status: () => ({ ok: true }) })
  const result = await tools.call('dsh_list_workspaces', {})
  assert.equal(result.isError, undefined)
  assert.deepEqual(JSON.parse(result.content[0].text), { from: 'listWorkspaces' })
  assert.deepEqual(calls, [{ name: 'listWorkspaces', args: {} }])
})
