/**
 * Hash-only API key store.
 *
 * Keys are shown in plaintext exactly once, at creation. Only a SHA-256 digest
 * reaches disk, so a copied keys.json cannot be replayed as a credential.
 * `lastUsedAt` / `useCount` are updated in memory and flushed on a short debounce
 * so a busy MCP client does not rewrite the file on every request.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const FORMAT_VERSION = 1
const KEY_PREFIX = 'dshmcp'
const FLUSH_DELAY_MS = 2_000
const MAX_NAME = 64

export class KeyLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KeyLimitError'
    this.code = 'KEY_LIMIT'
  }
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function safeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length !== right.length || left.length % 2 !== 0) return false
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  } catch {
    return false
  }
}

function keyIdOf(token) {
  const match = /^dshmcp_([a-f0-9]{12})_/.exec(token)
  return match === null ? undefined : match[1]
}

function maskOf(id, secret) {
  return `${KEY_PREFIX}_${id.slice(0, 4)}…${secret.slice(-4)}`
}

function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    masked: record.masked,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    useCount: record.useCount,
    revokedAt: record.revokedAt,
    migrated: record.migrated === true,
  }
}

function normalizeRecord(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.id !== 'string' || !/^[a-f0-9]{12}$/.test(value.id)) return undefined
  if (typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) return undefined
  return {
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim().length > 0
      ? value.name.trim().slice(0, MAX_NAME)
      : '未命名',
    hash: value.hash,
    masked: typeof value.masked === 'string' && value.masked.length > 0 ? value.masked : '…',
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : Date.now(),
    lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : null,
    useCount: Number.isFinite(value.useCount) && value.useCount >= 0 ? Math.trunc(value.useCount) : 0,
    revokedAt: Number.isFinite(value.revokedAt) ? value.revokedAt : null,
    migrated: value.migrated === true,
  }
}

export class KeyStore {
  /**
   * @param {{file: string, log?: (level: string, fields: object) => void, maxActive?: number}} options
   */
  constructor({ file, log = () => {}, maxActive = 20 }) {
    this.file = file
    this.log = log
    this.maxActive = maxActive
    this.records = []
    this.dirty = false
    this.timer = undefined
    this.disposed = false
  }

  load() {
    let text
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('keys-read-failed', { message: messageOf(error) })
      return this
    }

    try {
      const parsed = JSON.parse(text)
      const raw = Array.isArray(parsed?.keys) ? parsed.keys : []
      const records = []
      for (const value of raw) {
        const record = normalizeRecord(value)
        if (record !== undefined) records.push(record)
      }
      this.records = records
      if (records.length !== raw.length) {
        this.log('keys-skipped-invalid', { total: raw.length, valid: records.length })
      }
    } catch (error) {
      this.log('keys-parse-failed', { message: messageOf(error) })
      try {
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        // A read-only or missing file is not fatal; the store starts empty.
      }
      this.records = []
    }
    return this
  }

  activeRecords() {
    return this.records.filter((record) => record.revokedAt === null)
  }

  activeCount() {
    return this.activeRecords().length
  }

  list() {
    return this.activeRecords()
      .slice()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(publicRecord)
  }

  create(name) {
    const label = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : ''
    if (label.length === 0) throw new Error('name is required')
    if (this.activeRecords().length >= this.maxActive) {
      throw new KeyLimitError(`at most ${this.maxActive} active keys are allowed`)
    }

    let id
    do {
      id = randomBytes(6).toString('hex')
    } while (this.records.some((record) => record.id === id))

    const secret = randomBytes(32).toString('base64url')
    const key = `${KEY_PREFIX}_${id}_${secret}`
    const record = {
      id,
      name: label,
      hash: hashToken(key),
      masked: maskOf(id, secret),
      createdAt: Date.now(),
      lastUsedAt: null,
      useCount: 0,
      revokedAt: null,
      migrated: false,
    }
    this.records.push(record)
    this.saveNow()
    return { key, record: publicRecord(record) }
  }

  revoke(id) {
    const record = this.records.find((candidate) => candidate.id === id)
    if (record === undefined) return undefined
    if (record.revokedAt === null) {
      record.revokedAt = Date.now()
      this.saveNow()
    }
    return publicRecord(record)
  }

  /** Verify a presented bearer token. A successful check updates usage metadata. */
  verify(token) {
    const record = this.match(token)
    if (record === undefined) return undefined
    record.lastUsedAt = Date.now()
    record.useCount += 1
    this.scheduleFlush()
    return publicRecord(record)
  }

  findByToken(token) {
    const record = this.match(token)
    return record === undefined ? undefined : publicRecord(record)
  }

  hasToken(token) {
    return this.match(token) !== undefined
  }

  /**
   * Import the legacy plaintext token as a revoked-capable key. The token keeps
   * working, but only its digest is stored from now on.
   */
  addMigrated({ name, token, createdAt }) {
    const existing = this.match(token)
    if (existing !== undefined) return publicRecord(existing)

    let id
    do {
      id = randomBytes(6).toString('hex')
    } while (this.records.some((record) => record.id === id))

    const record = {
      id,
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, MAX_NAME) : '默认（迁移）',
      hash: hashToken(token),
      masked: `legacy…${token.slice(-4)}`,
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
      lastUsedAt: null,
      useCount: 0,
      revokedAt: null,
      migrated: true,
    }
    this.records.push(record)
    this.saveNow()
    return publicRecord(record)
  }

  /** @returns {object | undefined} the internal record, never exposed to callers */
  match(token) {
    const candidate = typeof token === 'string' ? token.trim() : ''
    if (candidate.length < 16) return undefined
    const hash = hashToken(candidate)
    const id = keyIdOf(candidate)
    const candidates = id === undefined
      ? this.records
      : this.records.filter((record) => record.id === id)
    for (const record of candidates) {
      if (record.revokedAt !== null) continue
      if (safeEqualHex(record.hash, hash)) return record
    }
    return undefined
  }

  saveNow() {
    this.dirty = true
    this.flush(true)
  }

  flush(throwOnError = false) {
    if (!this.dirty) return true
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const text = `${JSON.stringify({ version: FORMAT_VERSION, keys: this.records }, null, 2)}\n`
      const temporary = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(temporary, this.file)
      this.dirty = false
      return true
    } catch (error) {
      this.log('keys-write-failed', { message: messageOf(error) })
      if (throwOnError) throw error
      return false
    }
  }

  scheduleFlush() {
    this.dirty = true
    if (this.timer !== undefined || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, FLUSH_DELAY_MS)
    this.timer.unref?.()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flush()
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
