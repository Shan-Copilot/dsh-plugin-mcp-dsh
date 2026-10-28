import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { KeyLimitError, KeyStore } from '../lib/keys/store.js'

function makeStore(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dsh-keys-'))
  const file = path.join(dir, 'keys.json')
  const store = new KeyStore({ file, maxActive: 3, ...options }).load()
  return { dir, file, store }
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
}

test('creates a prefixed key, verifies it, and stores only a digest', () => {
  const { dir, file, store } = makeStore()
  try {
    const { key, record } = store.create('Claude Code')
    assert.match(key, /^dshmcp_[a-f0-9]{12}_[A-Za-z0-9_-]{40,}$/)
    assert.equal(record.name, 'Claude Code')
    assert.equal(record.useCount, 0)
    assert.equal(record.revokedAt, null)
    assert.match(record.masked, /^dshmcp_[a-f0-9]{4}…[A-Za-z0-9_-]{4}$/)
    assert.equal('hash' in record, false)

    const onDisk = fs.readFileSync(file, 'utf8')
    assert.equal(onDisk.includes(key), false)
    assert.equal(onDisk.includes('"hash"'), true)

    assert.equal(store.verify(key)?.id, record.id)
    assert.equal(store.verify(`${key}x`), undefined)
    assert.equal(store.verify('dshmcp_000000000000_nope'), undefined)
  } finally {
    store.dispose()
    cleanup(dir)
  }
})

test('tracks usage without rewriting the file for every call', () => {
  const { dir, store } = makeStore()
  try {
    const { key, record } = store.create('agent')
    store.verify(key)
    store.verify(key)
    const listed = store.list().find((item) => item.id === record.id)
    assert.equal(listed.useCount, 2)
    assert.equal(typeof listed.lastUsedAt, 'number')
  } finally {
    store.dispose()
    cleanup(dir)
  }
})

test('persists usage metadata across a reload', () => {
  const { dir, file, store } = makeStore()
  const { key, record } = store.create('agent')
  store.verify(key)
  store.verify(key)
  store.dispose()

  const reopened = new KeyStore({ file }).load()
  try {
    const listed = reopened.list().find((item) => item.id === record.id)
    assert.equal(listed.useCount, 2)
    assert.equal(typeof listed.lastUsedAt, 'number')
  } finally {
    reopened.dispose()
    cleanup(dir)
  }
})

test('revoked keys stop working immediately', () => {
  const { dir, store } = makeStore()
  try {
    const { key, record } = store.create('revoked')
    assert.equal(store.verify(key)?.id, record.id)
    const revoked = store.revoke(record.id)
    assert.equal(typeof revoked.revokedAt, 'number')
    assert.equal(store.verify(key), undefined)
    assert.deepEqual(store.list(), [])
  } finally {
    store.dispose()
    cleanup(dir)
  }
})

test('persists records across a reload', () => {
  const { dir, file, store } = makeStore()
  const { key, record } = store.create('persisted')
  store.dispose()

  const reopened = new KeyStore({ file }).load()
  try {
    assert.equal(reopened.verify(key)?.id, record.id)
    assert.equal(reopened.list().length, 1)
  } finally {
    reopened.dispose()
    cleanup(dir)
  }
})

test('migrates a legacy token without storing the plaintext', () => {
  const { dir, file, store } = makeStore()
  try {
    const token = 'legacy-token-value-1234567890abcdef'
    const record = store.addMigrated({ name: '默认（迁移）', token, createdAt: Date.now() })
    assert.equal(record.migrated, true)
    assert.match(record.masked, /^legacy…[a-f0-9]{4}$/)
    assert.equal(store.verify(token)?.id, record.id)

    const onDisk = fs.readFileSync(file, 'utf8')
    assert.equal(onDisk.includes(token), false)
    assert.equal(store.addMigrated({ name: 'again', token }).id, record.id)
  } finally {
    store.dispose()
    cleanup(dir)
  }
})

test('enforces the active-key limit', () => {
  const { dir, store } = makeStore({ maxActive: 2 })
  try {
    store.create('one')
    store.create('two')
    assert.throws(() => store.create('three'), KeyLimitError)
  } finally {
    store.dispose()
    cleanup(dir)
  }
})

test('starts empty and quarantines a corrupt file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dsh-keys-'))
  const file = path.join(dir, 'keys.json')
  fs.writeFileSync(file, '{not json', 'utf8')
  try {
    const store = new KeyStore({ file }).load()
    assert.deepEqual(store.list(), [])
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('keys.json.corrupt-'))
    assert.equal(backups.length, 1)
    store.dispose()
  } finally {
    cleanup(dir)
  }
})
