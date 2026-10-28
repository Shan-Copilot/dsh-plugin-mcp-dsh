/**
 * Streamable-HTTP transport for the MCP endpoint.
 *
 * POST   JSON-RPC request/notification
 * GET    SSE channel for server notifications (kept for older clients)
 * DELETE session teardown (this server keeps no per-client session state)
 * OPTIONS preflight, answered without CORS grants
 */

import { ErrorCode } from './protocol.js'
import { parseBearer } from './auth.js'

const MAX_BODY_BYTES = 1024 * 1024
const HEARTBEAT_MS = 20_000

function json(res, status, body) {
  if (res.writableEnded || res.destroyed === true) return
  try {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch {
    // The peer left while the response was being written.
  }
}

function unauthorized(res) {
  if (res.writableEnded || res.destroyed === true) return
  try {
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Bearer realm="mcp-dsh"',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify({ error: 'unauthorized' }))
  } catch {
    // The peer left before the challenge was written.
  }
}

/**
 * @param {object} options
 * @param {string} options.path - mounted route path, e.g. `/mcp-dsh`
 * @param {{mode: 'none'|'bearer', verify: (token: string) => boolean}} options.auth
 * @param {(msg: object, context: {signal: AbortSignal, remote: string}) => Promise<object|null>} options.handleMessage
 * @param {(level: string, fields: object) => void} [options.log]
 */
export function createTransport({ path, auth, handleMessage, log = () => {} }) {
  const clients = new Set()

  function acceptsPath(pathname) {
    return pathname === path || pathname === `${path}/`
  }

  function authorized(req) {
    if (auth.mode === 'none') return true
    const token = parseBearer(req.headers?.authorization)
    if (token === undefined) return false
    return auth.verify(token) === true
  }

  function openStream(req, res, remote) {
    if (res.writableEnded || res.destroyed === true) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    clients.add(res)
    log('sse-open', { remote, count: clients.size })

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        // The socket is gone; close cleanup below runs on close.
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    const cleanup = () => {
      clearInterval(heartbeat)
      clients.delete(res)
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  async function readBody(req, res) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        json(res, 413, {
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCode.INVALID_REQUEST, message: 'request body too large' },
        })
        req.destroy()
        return undefined
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} */
  async function handler(req, res) {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      json(res, 400, { error: 'bad-url' })
      return
    }
    if (!acceptsPath(pathname)) {
      json(res, 404, { error: 'not-found' })
      return
    }

    const remote = req.socket?.remoteAddress ?? 'unknown'

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        Allow: 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
        'Content-Length': '0',
      })
      res.end()
      return
    }

    if (!authorized(req)) {
      log('auth-reject', { remote, method: req.method })
      unauthorized(res)
      return
    }

    if (req.method === 'GET') {
      openStream(req, res, remote)
      return
    }

    if (req.method === 'DELETE') {
      res.writeHead(204, { Allow: 'GET, POST, DELETE, OPTIONS' })
      res.end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST, DELETE, OPTIONS', 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'method not allowed' } }))
      return
    }

    const body = await readBody(req, res).catch(() => undefined)
    if (body === undefined) {
      if (!res.writableEnded) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.INVALID_REQUEST, message: 'request aborted' } }))
      }
      return
    }

    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: ErrorCode.PARSE_ERROR, message: 'parse error' } })
      return
    }
    if (Array.isArray(msg)) {
      json(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: ErrorCode.INVALID_REQUEST, message: 'batch requests are not supported' },
      })
      return
    }

    const controller = new AbortController()
    const abort = () => {
      if (!controller.signal.aborted) controller.abort()
    }
    // `IncomingMessage` may emit `close` once the body is consumed while the
    // response is still pending; only an aborted request means the caller left.
    req.on('aborted', abort)
    res.on('close', abort)

    let result
    try {
      result = await handleMessage(msg, { signal: controller.signal, remote })
    } catch (error) {
      log('handler-error', { remote, message: error instanceof Error ? error.message : String(error) })
      result = {
        jsonrpc: '2.0',
        id: msg?.id ?? null,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'internal error' },
      }
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }

    if (controller.signal.aborted && res.writableEnded) return

    if (result === null) {
      if (res.writableEnded) return
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end()
      return
    }
    json(res, 200, result)
  }

  function broadcast(message) {
    const frame = `event: message\ndata: ${JSON.stringify(message)}\n\n`
    for (const res of clients) {
      try {
        res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  function close() {
    for (const res of clients) {
      try {
        res.end()
      } catch {
        // Already closed.
      }
    }
    clients.clear()
  }

  return { handler, broadcast, close, clientCount: () => clients.size }
}
