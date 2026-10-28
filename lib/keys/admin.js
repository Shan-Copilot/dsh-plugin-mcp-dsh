/**
 * Internal admin API for the plugin's own configuration page.
 *
 * This is not an MCP endpoint and not a user-facing page: it is the only way the
 * browser half can list, create, and revoke keys without ever holding the key
 * digests. Every request must carry the DSH browser session; an MCP bearer key
 * is not accepted here.
 */

import { KeyLimitError } from './store.js'

/** Fixed internal path so the page does not depend on the configurable MCP path. */
export const ADMIN_PATH = '/_mcp-dsh/admin'

const MAX_BODY_BYTES = 16 * 1024
const CREATE_LIMIT = 10
const CREATE_WINDOW_MS = 60_000

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function json(res, status, body) {
  if (res.writableEnded === true) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(text)
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('invalid JSON body')
    error.code = 'BAD_JSON'
    throw error
  }
}

function acceptsJson(req) {
  const type = req.headers?.['content-type']
  return typeof type === 'string' && type.toLowerCase().includes('application/json')
}

/**
 * @param {object} options
 * @param {import('./store.js').KeyStore} options.store
 * @param {object | undefined} options.connection - Host connection service
 * @param {string | undefined} options.origin
 * @param {string} options.mcpPath
 * @param {'bearer' | 'none'} options.authMode
 * @param {(level: string, fields: object) => void} options.log
 */
export function createAdminHandler({ store, connection, origin, mcpPath, authMode, log }) {
  /** @type {number[]} */
  const creates = []

  function authorize(req) {
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
      return 403
    }
    let rejection
    try {
      rejection = connection.requestRejection({ headers: req.headers ?? {} })
    } catch (error) {
      log('admin-auth-error', { message: messageOf(error) })
      return 403
    }
    if (rejection !== undefined) return rejection

    // A browser fetch from the DSH page is same-origin; anything else is a
    // cross-site attempt even if it somehow shares a cookie.
    const site = req.headers?.['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 403
    const requestOrigin = req.headers?.origin
    if (typeof requestOrigin === 'string' && typeof origin === 'string' && requestOrigin !== origin) return 403
    return undefined
  }

  function endpoint() {
    return origin === undefined ? mcpPath : `${origin}${mcpPath}`
  }

  function createAllowed() {
    const now = Date.now()
    while (creates.length > 0 && now - creates[0] > CREATE_WINDOW_MS) creates.shift()
    if (creates.length >= CREATE_LIMIT) return false
    creates.push(now)
    return true
  }

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  return async function handleAdmin(req, res) {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      json(res, 400, { error: { code: 'BAD_URL', message: 'invalid request URL' } })
      return
    }
    if (pathname !== ADMIN_PATH && !pathname.startsWith(`${ADMIN_PATH}/`)) {
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
      return
    }
    const suffix = pathname.slice(ADMIN_PATH.length)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { Allow: 'GET, POST, OPTIONS', 'Content-Length': '0' })
      res.end()
      return
    }

    const rejection = authorize(req)
    if (rejection !== undefined) {
      log('admin-reject', { remote: req.socket?.remoteAddress ?? 'unknown', pathname, status: rejection })
      json(res, rejection, {
        error: {
          code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
          message: 'This admin API requires the DSH browser session. Use the plugin page; an MCP key is not accepted here.',
        },
      })
      return
    }

    if (req.method === 'GET' && (suffix === '' || suffix === '/keys')) {
      json(res, 200, {
        endpoint: endpoint(),
        auth: authMode,
        maxKeys: store.maxActive,
        keys: store.list(),
      })
      return
    }

    if (req.method === 'POST' && suffix === '/keys') {
      if (!acceptsJson(req)) {
        json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } })
        return
      }
      if (!createAllowed()) {
        json(res, 429, { error: { code: 'RATE_LIMITED', message: 'too many key creations, retry later' } })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
        json(res, status, { error: { code: error?.code ?? 'BAD_REQUEST', message: messageOf(error) } })
        return
      }
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length === 0) {
        json(res, 400, { error: { code: 'INVALID_NAME', message: 'name is required' } })
        return
      }
      try {
        const created = store.create(name)
        log('key-created', { id: created.record.id, name: created.record.name })
        json(res, 201, created)
      } catch (error) {
        if (error instanceof KeyLimitError) {
          json(res, 409, { error: { code: 'KEY_LIMIT', message: error.message } })
          return
        }
        log('key-create-failed', { message: messageOf(error) })
        json(res, 500, { error: { code: 'STORE_FAILED', message: 'the key could not be stored' } })
      }
      return
    }

    if (req.method === 'POST' && suffix === '/keys/revoke') {
      if (!acceptsJson(req)) {
        json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
        json(res, status, { error: { code: error?.code ?? 'BAD_REQUEST', message: messageOf(error) } })
        return
      }
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (!/^[a-f0-9]{12}$/.test(id)) {
        json(res, 400, { error: { code: 'INVALID_ID', message: 'a valid key id is required' } })
        return
      }
      const revoked = store.revoke(id)
      if (revoked === undefined) {
        json(res, 404, { error: { code: 'NOT_FOUND', message: 'key not found' } })
        return
      }
      log('key-revoked', { id })
      json(res, 200, { revoked: true, record: revoked })
      return
    }

    if (req.method === 'POST' && suffix === '/client-loaded') {
      if (!acceptsJson(req)) {
        json(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } })
        return
      }
      let body
      try {
        body = await readJson(req)
      } catch (error) {
        json(res, 400, { error: { code: 'BAD_REQUEST', message: messageOf(error) } })
        return
      }
      log('client-loaded', {
        id: typeof body.id === 'string' ? body.id : undefined,
        at: typeof body.at === 'number' ? body.at : undefined,
      })
      json(res, 200, { ok: true })
      return
    }

    json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
  }
}
