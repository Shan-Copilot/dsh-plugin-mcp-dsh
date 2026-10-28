import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAdminHandler } from '../lib/keys/admin.js'
import { KeyStore } from '../lib/keys/store.js'

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dsh-admin-'))
  const file = path.join(dir, 'keys.json')
  const store = new KeyStore({ file, maxActive: 5 }).load()
  return { dir, store }
}

function request({ method = 'GET', url = '/_mcp-dsh/admin/keys', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writableEnded: false,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(body) {
      state.body = body ?? ''
      this.writableEnded = true
    },
  }
}

async function invoke(handler, options) {
  const res = response()
  await handler(request(options), res)
  const parsed = res.state.body.length > 0 ? JSON.parse(res.state.body) : undefined
  return { status: res.state.status, headers: res.state.headers, body: parsed }
}

function handlerFor(store, overrides = {}) {
  return createAdminHandler({
    store,
    connection: { requestRejection: () => undefined },
    origin: 'http://127.0.0.1:3080',
    mcpPath: '/mcp-dsh',
    authMode: 'bearer',
    log: () => {},
    ...overrides,
  })
}

test('rejects requests without the DSH browser session', async () => {
  const { dir, store } = makeStore()
  try {
    const handler = handlerFor(store, { connection: { requestRejection: () => 401 } })
    const result = await invoke(handler)
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, 'UNAUTHORIZED')
  } finally {
    store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fails closed when the connection service is unavailable', async () => {
  const { dir, store } = makeStore()
  try {
    const handler = handlerFor(store, { connection: undefined })
    const result = await invoke(handler)
    assert.equal(result.status, 403)
  } finally {
    store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('lists keys without hashes or plaintext', async () => {
  const { dir, store } = makeStore()
  try {
    const { key } = store.create('Claude Code')
    const handler = handlerFor(store)
    const result = await invoke(handler)
    assert.equal(result.status, 200)
    assert.equal(result.body.endpoint, 'http://127.0.0.1:3080/mcp-dsh')
    assert.equal(result.body.auth, 'bearer')
    assert.equal(result.body.keys.length, 1)
    assert.equal(result.body.keys[0].name, 'Claude Code')
    assert.equal(JSON.stringify(result.body).includes(key), false)
    assert.equal(JSON.stringify(result.body).includes('hash'), false)
  } finally {
    store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('creates a key once and revokes it', async () => {
  const { dir, store } = makeStore()
  try {
    const handler = handlerFor(store)
    const created = await invoke(handler, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ name: 'Codex' }),
    })
    assert.equal(created.status, 201)
    assert.match(created.body.key, /^dshmcp_/)
    assert.equal(created.headers['Cache-Control'], 'no-store')
    assert.equal(store.verify(created.body.key)?.id, created.body.record.id)

    const list = await invoke(handler)
    assert.equal(list.body.keys[0].name, 'Codex')
    assert.equal(JSON.stringify(list.body).includes(created.body.key), false)

    const revoked = await invoke(handler, {
      method: 'POST',
      url: '/_mcp-dsh/admin/keys/revoke',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: created.body.record.id }),
    })
    assert.equal(revoked.status, 200)
    assert.equal(revoked.body.revoked, true)
    assert.equal(store.verify(created.body.key), undefined)
  } finally {
    store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects cross-site and cross-origin admin calls', async () => {
  const { dir, store } = makeStore()
  try {
    const handler = handlerFor(store)
    const crossSite = await invoke(handler, { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(crossSite.status, 403)

    const crossOrigin = await invoke(handler, { headers: { origin: 'http://evil.example' } })
    assert.equal(crossOrigin.status, 403)
  } finally {
    store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('requires JSON for mutations', async () => {
  const { dir, store } = makeStore()
  try {
    const handler = handlerFor(store)
    const result = await invoke(handler, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'nope' }),
    })
    assert.equal(result.status, 415)
  } finally {
    store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reports the key limit as a conflict', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dsh-admin-'))
  const store = new KeyStore({ file: path.join(dir, 'keys.json'), maxActive: 1 }).load()
  try {
    const handler = handlerFor(store)
    store.create('first')
    const result = await invoke(handler, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'second' }),
    })
    assert.equal(result.status, 409)
    assert.equal(result.body.error.code, 'KEY_LIMIT')
  } finally {
    store.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
