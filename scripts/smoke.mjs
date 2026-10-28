#!/usr/bin/env node
/**
 * Zero-dependency smoke client for the /mcp-dsh endpoint.
 *
 *   node scripts/smoke.mjs [url] [--full]
 *
 * Default: initialize, tools/list, status, workspaces, sessions.
 * --full: also create a session, send "只回复 OK", wait, and read the result.
 */

const args = process.argv.slice(2)
const url = args.find((value) => !value.startsWith('--')) ?? 'http://127.0.0.1:3080/mcp-dsh'
const full = args.includes('--full')

function readToken() {
  return process.env.DSH_MCP_KEY ?? process.env.DSH_MCP_TOKEN ?? ''
}

const token = readToken()
if (token.length === 0) {
  console.warn('warning: no DSH_MCP_KEY set; requests are sent without Authorization (only works with auth: none).')
}
let nextId = 1
let sessionId

async function rpc(method, params) {
  const id = nextId++
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} -> HTTP ${response.status}: ${text}`)
  if (text.length === 0) return undefined
  const message = JSON.parse(text)
  if (message.error) throw new Error(`${method} -> ${message.error.code}: ${message.error.message}`)
  return message.result
}

async function notify(method, params) {
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }),
  })
}

function payload(result) {
  const text = result?.content?.[0]?.text ?? '{}'
  return JSON.parse(text)
}

async function call(name, toolArgs = {}) {
  const result = await rpc('tools/call', { name, arguments: toolArgs })
  if (result?.isError === true) {
    const body = payload(result)
    throw new Error(`${name} failed: ${body.error?.code} ${body.error?.message} ${body.error?.hint ?? ''}`)
  }
  return payload(result)
}

async function main() {
  console.log(`endpoint: ${url}`)
  console.log(`token:    ${token ? `${token.slice(0, 6)}…` : 'none'}`)

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'mcp-dsh-smoke', version: '0.1.0' },
    capabilities: {},
  })
  console.log(`server:   ${init.serverInfo.name} ${init.serverInfo.version} (protocol ${init.protocolVersion})`)
  await notify('notifications/initialized')

  const tools = await rpc('tools/list', {})
  console.log(`tools:    ${tools.tools.map((tool) => tool.name).join(', ')}`)

  const status = await call('dsh_server_status')
  console.log(`status:   ${JSON.stringify(status)}`)

  const workspaces = await call('dsh_list_workspaces')
  console.log(`workspaces: ${workspaces.workspaces.length}`)
  for (const workspace of workspaces.workspaces.slice(0, 5)) {
    console.log(`  - ${workspace.workspaceId}  ${workspace.title}  ${workspace.path} (${workspace.sessionCount} sessions)`)
  }

  const presets = await call('dsh_list_presets')
  console.log(`presets:  ${presets.presets.map((preset) => preset.id).join(', ') || '(none)'}`)

  const sessions = await call('dsh_list_sessions', { limit: 10 })
  console.log(`sessions: ${sessions.total}`)
  for (const session of sessions.sessions.slice(0, 5)) {
    console.log(`  - ${session.sessionId}  ${session.running ? 'running' : 'idle'}  ${session.title}`)
  }

  if (!full) return

  const workspace = workspaces.workspaces[0]
  if (!workspace) throw new Error('no workspace to create a session in')
  const preset = presets.presets.find((item) => item.isDefault && !item.broken) ?? presets.presets.find((item) => !item.broken)

  const created = await call('dsh_create_session', {
    workspaceId: workspace.workspaceId,
    ...(preset ? { agentPreset: preset.id } : {}),
    title: 'mcp-dsh smoke',
  })
  sessionId = created.sessionId
  console.log(`created:  ${sessionId} (${created.cwd ?? workspace.path})`)

  const sent = await call('dsh_session_send_message', {
    sessionId,
    text: '只回复 OK，不要使用任何工具。',
    requestId: `smoke-${Date.now()}`,
  })
  console.log(`sent:     ${JSON.stringify(sent)}`)

  let cursor = sent.cursor
  let state = 'running'
  for (let attempt = 0; attempt < 8 && state !== 'completed' && state !== 'failed' && state !== 'cancelled' && state !== 'interrupted'; attempt += 1) {
    const waited = await call('dsh_session_wait', {
      sessionId,
      sinceSeq: cursor,
      until: 'idle',
      timeoutMs: 20_000,
    })
    console.log(`wait:     ${JSON.stringify(waited)}`)
    state = waited.state
    cursor = waited.cursor ?? cursor
  }

  const read = await call('dsh_session_read_messages', { sessionId, sinceSeq: sent.cursor })
  console.log(`read:     ${JSON.stringify(read, null, 2)}`)

  if (state !== 'completed') throw new Error(`smoke did not complete: ${state}`)
  console.log('OK')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  if (sessionId) console.error(`session left in place for inspection: ${sessionId}`)
  process.exitCode = 1
})
