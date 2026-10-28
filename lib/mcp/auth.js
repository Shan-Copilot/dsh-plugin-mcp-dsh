/**
 * Bearer verification, legacy-token migration, and the client configuration
 * template.
 *
 * No plaintext key is generated or persisted here: keys live in the hash-only
 * store, and the one-time plaintext is returned only by the admin API's create
 * response.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'

export function stateDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'mcp-dsh')
}

export function parseBearer(header) {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match === null ? undefined : match[1]
}

export function tokenEquals(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function isLoopbackOrigin(origin) {
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1'
      || hostname === 'localhost'
      || hostname === '::1'
      || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * @param {{auth: 'none'|'bearer', token?: string}} config
 * @param {{store?: {verify: (token: string) => unknown}, legacyToken?: string, log?: Function}} deps
 */
export function resolveAuth(config, { store, legacyToken, log = () => {} } = {}) {
  const dir = stateDir()
  if (config.auth === 'none') {
    return { mode: 'none', dir, verify: () => true }
  }
  return {
    mode: 'bearer',
    dir,
    verify(candidate) {
      if (typeof candidate !== 'string' || candidate.length < 16) return false
      if (typeof config.token === 'string' && config.token.length > 0 && tokenEquals(candidate, config.token)) {
        return true
      }
      if (typeof legacyToken === 'string' && legacyToken.length > 0 && tokenEquals(candidate, legacyToken)) {
        return true
      }
      const verified = store?.verify?.(candidate)
      if (verified === undefined) {
        log('auth-reject-token', { length: candidate.length })
        return false
      }
      return true
    },
  }
}

/**
 * Import the old single-token file into the key store, then remove the
 * plaintext file. Existing clients keep working because the same token string
 * is now one of the stored digests.
 *
 * @returns {{migrated: boolean, legacyToken?: string, record?: object}}
 */
export function migrateLegacyToken({ dir, config, store, log = () => {} }) {
  if (typeof config.token === 'string' && config.token.length > 0) return { migrated: false }
  const file = path.join(dir, 'token')
  let token
  let stat
  try {
    stat = fs.statSync(file)
    token = fs.readFileSync(file, 'utf8').trim()
  } catch {
    return { migrated: false }
  }
  if (token.length < 16) {
    try {
      fs.unlinkSync(file)
    } catch {
      // The empty file is harmless.
    }
    return { migrated: false }
  }

  let record
  try {
    record = store.addMigrated({
      name: '默认（迁移）',
      token,
      createdAt: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Date.now(),
    })
  } catch (error) {
    // Keep the token file and accept it directly rather than locking the user out.
    log('token-migration-failed', { message: error instanceof Error ? error.message : String(error) })
    return { migrated: false, legacyToken: token }
  }

  try {
    fs.unlinkSync(file)
  } catch (error) {
    log('token-file-remove-failed', { message: error instanceof Error ? error.message : String(error) })
  }
  log('token-migrated', { keyId: record.id })
  return { migrated: true, record }
}

/**
 * Write a secret-free client template. The real key is shown once in the plugin
 * page, where the page can build a filled-in config with the user's explicit copy.
 */
export function writeClientConfig({ dir, origin, path: routePath, auth }) {
  const url = `${origin}${routePath}`
  const config = {
    mcpServers: {
      'dsh-sessions': {
        type: 'http',
        url,
        ...(auth.mode === 'bearer'
          ? { headers: { Authorization: 'Bearer <PASTE_API_KEY_HERE>' } }
          : {}),
      },
    },
  }
  const file = path.join(dir, 'client-config.json')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    return file
  } catch {
    return undefined
  }
}
