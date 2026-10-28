/**
 * Domain errors are returned to the MCP client as `isError: true` tool results so
 * the model can read the code and recover. Protocol errors stay JSON-RPC errors.
 */
export class ToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(code, message, hint) {
    super(message)
    this.name = 'ToolError'
    this.code = code
    this.hint = hint
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
    }
  }
}

export const Codes = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  PRESET_NOT_FOUND: 'PRESET_NOT_FOUND',
  SESSION_BUSY: 'SESSION_BUSY',
  UNSUPPORTED: 'UNSUPPORTED',
  INTERNAL: 'INTERNAL',
})

export function asToolError(error, fallbackCode = Codes.INTERNAL) {
  if (error instanceof ToolError) return error
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return new ToolError(error.code, typeof error.message === 'string' ? error.message : error.code, error.hint)
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ToolError(fallbackCode, message)
}

export function translateHostError(error, sessionId) {
  if (error instanceof ToolError) return error
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'session/not-found' || /not found|unknown session/i.test(message)) {
    return new ToolError(Codes.SESSION_NOT_FOUND, `session not found: ${sessionId}`, 'Call dsh_list_sessions to get a valid sessionId.')
  }
  if (code === 'session/agent-busy') {
    return new ToolError(Codes.SESSION_BUSY, message, 'Wait for the current turn to end, then retry.')
  }
  if (code === 'session/writer-held') {
    return new ToolError(Codes.SESSION_BUSY, message, 'Another DSH window holds this session; retry later.')
  }
  return new ToolError(Codes.INTERNAL, message)
}
