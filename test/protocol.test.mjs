import assert from 'node:assert/strict'
import test from 'node:test'

import { createProtocol, META_PROTOCOL_VERSION, META_SERVER_INFO } from '../lib/mcp/protocol.js'

const serverInfo = { name: 'dsh-sessions', version: '0.1.0' }
const tools = [
  { name: 'dsh_ping', description: 'ping', inputSchema: { type: 'object', properties: {} } },
]

function build(calls = []) {
  return createProtocol({
    serverInfo,
    instructions: 'flow',
    listTools: () => tools,
    callTool: async (name, args) => {
      calls.push({ name, args })
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })
}

test('initialize echoes a supported protocol version and instructions', async () => {
  const handle = build()
  const response = await handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } },
  })
  assert.equal(response.result.protocolVersion, '2025-06-18')
  assert.equal(response.result.serverInfo.name, 'dsh-sessions')
  assert.equal(response.result.instructions, 'flow')
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } })
})

test('initialize falls back to the default version for an unknown request', async () => {
  const handle = build()
  const response = await handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  })
  assert.equal(response.result.protocolVersion, '2025-06-18')
})

test('stateless requests carry server info in _meta', async () => {
  const handle = build()
  const response = await handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/list',
    _meta: { [META_PROTOCOL_VERSION]: '2026-07-28' },
  })
  assert.deepEqual(response._meta[META_SERVER_INFO], serverInfo)
  assert.equal(response.result.tools.length, 1)
})

test('notifications produce no response body', async () => {
  const handle = build()
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
})

test('tools/call forwards arguments and returns the tool result', async () => {
  const calls = []
  const handle = build(calls)
  const response = await handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'dsh_ping', arguments: { value: 1 } },
  })
  assert.equal(response.result.content[0].text, 'ok')
  assert.deepEqual(calls, [{ name: 'dsh_ping', args: { value: 1 } }])
})

test('unknown methods return a JSON-RPC method-not-found error', async () => {
  const handle = build()
  const response = await handle({ jsonrpc: '2.0', id: 5, method: 'nope' })
  assert.equal(response.error.code, -32601)
})

test('a tool failure becomes a JSON-RPC internal error only when it escapes', async () => {
  const handle = createProtocol({
    serverInfo,
    listTools: () => tools,
    callTool: async () => {
      throw new Error('boom')
    },
  })
  const response = await handle({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'dsh_ping', arguments: {} },
  })
  assert.equal(response.error.code, -32603)
  assert.match(response.error.message, /boom/)
})
