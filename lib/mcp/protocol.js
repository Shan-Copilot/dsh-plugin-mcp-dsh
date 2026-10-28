/**
 * MCP / JSON-RPC 2.0 message layer.
 *
 * Pure: no DSH dependency. Transport and tool implementations are injected so the
 * protocol can be tested without a Host process.
 */

export const DEFAULT_PROTOCOL_VERSION = '2025-06-18'

/** Handshake and stateless protocol versions understood by this server. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2026-07-28']

/** Request `_meta` key that carries the protocol version in stateless mode. */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'

/** Response `_meta` key that carries the server identity in stateless mode. */
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

export const ErrorCode = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
})

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {object} options
 * @param {{name: string, version: string, title?: string}} options.serverInfo
 * @param {string} [options.instructions] - client-visible usage guidance
 * @param {() => Array<{name: string, description: string, inputSchema: object}>} options.listTools
 * @param {(name: string, args: object, context: object) => Promise<object>} options.callTool
 * @param {(level: string, fields: object) => void} [options.log]
 * @returns {(msg: object, context?: object) => Promise<object | null>}
 */
export function createProtocol({ serverInfo, instructions = '', listTools, callTool, log = () => {} }) {
  return async function handleMessage(msg, context = {}) {
    if (!isPlainObject(msg)) {
      return { jsonrpc: '2.0', id: null, error: { code: ErrorCode.INVALID_REQUEST, message: 'invalid request' } }
    }

    const declared = msg._meta?.[META_PROTOCOL_VERSION]
    if (typeof declared === 'string' && !PROTOCOL_VERSIONS.includes(declared)) {
      return {
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: {
          code: ErrorCode.INVALID_PARAMS,
          message: `unsupported protocol version: ${declared} (supported: ${PROTOCOL_VERSIONS.join(', ')})`,
        },
      }
    }

    const stateless = declared === '2026-07-28'
    const respond = (result) => (stateless
      ? { jsonrpc: '2.0', id: msg.id ?? null, result, _meta: { [META_SERVER_INFO]: serverInfo } }
      : { jsonrpc: '2.0', id: msg.id ?? null, result })
    const respondError = (code, message, data) => ({
      jsonrpc: '2.0',
      id: msg.id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    })

    try {
      switch (msg.method) {
        case 'initialize': {
          const requested = msg.params?.protocolVersion
          const protocolVersion = PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION
          return respond({
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            ...(instructions ? { instructions } : {}),
          })
        }

        case 'server/discover':
          return respond({
            protocolVersions: PROTOCOL_VERSIONS,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
            ...(instructions ? { instructions } : {}),
          })

        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return null

        case 'ping':
          return respond({})

        // Clients probe these even when the server declares tools only.
        case 'resources/list':
          return respond({ resources: [] })
        case 'resources/templates/list':
          return respond({ resourceTemplates: [] })
        case 'prompts/list':
          return respond({ prompts: [] })
        case 'logging/setLevel':
          return respond({})

        case 'tools/list':
          return respond({ tools: listTools() })

        case 'tools/call': {
          const name = msg.params?.name
          if (typeof name !== 'string' || name.length === 0) {
            return respondError(ErrorCode.INVALID_PARAMS, 'tools/call requires a tool name')
          }
          const args = msg.params?.arguments ?? {}
          if (!isPlainObject(args)) {
            return respondError(ErrorCode.INVALID_PARAMS, 'tools/call arguments must be an object')
          }
          const result = await callTool(name, args, context)
          return respond(result)
        }

        default:
          return respondError(ErrorCode.METHOD_NOT_FOUND, `unknown method: ${String(msg.method)}`)
      }
    } catch (error) {
      log('error', { method: msg.method, message: error instanceof Error ? error.message : String(error) })
      return respondError(
        ErrorCode.INTERNAL_ERROR,
        error instanceof Error ? error.message : 'internal error',
      )
    }
  }
}
