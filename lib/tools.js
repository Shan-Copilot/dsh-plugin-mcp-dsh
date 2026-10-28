/**
 * Static MCP tool catalog.
 *
 * Descriptions state behavior and the state machine; implementation details stay
 * out. Every domain failure is returned as an `isError` result so the calling
 * model can read the code and recover.
 */

import { asToolError, Codes, ToolError } from './errors.js'

const object = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})

const sessionId = {
  type: 'string',
  description: 'Session id from dsh_list_sessions or dsh_create_session.',
}

const sinceSeq = {
  type: 'number',
  description:
    'Exclusive lower bound: only events with seq greater than this value are considered. '
    + 'Pass the cursor returned by a previous call. Omit to use the latest turn.',
}

function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(error) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: asToolError(error).toJSON() }, null, 2) }],
    isError: true,
  }
}

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./sessions/service.js').createSessionService>} options.service
 * @param {{mode: 'full'|'read-only', defaultWaitMs: number, maxWaitMs: number}} options.config
 * @param {() => object} options.status
 */
export function createTools({ service, config, status }) {
  const definitions = [
    {
      name: 'dsh_server_status',
      readOnly: true,
      description:
        'Check the DSH session bridge: endpoint, auth mode, version, and live session counts. '
        + 'Use it first when another call fails unexpectedly.',
      inputSchema: object({}),
      handler: async () => status(),
    },
    {
      name: 'dsh_list_workspaces',
      readOnly: true,
      description:
        'List DSH workspaces (project directories). A workspaceId is the normal way to choose '
        + 'where a new session lives.',
      inputSchema: object({
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      }),
      handler: async (args) => service.listWorkspaces(args),
    },
    {
      name: 'dsh_list_presets',
      readOnly: true,
      description:
        'List agent presets (capability bundles) that can be assigned when creating a session.',
      inputSchema: object({}),
      handler: async () => service.listPresets(),
    },
    {
      name: 'dsh_list_sessions',
      readOnly: true,
      description:
        'List visible DSH sessions with title, workspace path, running state, and last activity, '
        + 'newest first. Subagent and archived sessions are hidden unless the matching flag is true.',
      inputSchema: object({
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string', description: 'nextCursor from a previous page.' },
        workspaceId: { type: 'string', description: 'Only sessions attached to this workspace.' },
        includeSubagents: { type: 'boolean', default: false },
        includeArchived: { type: 'boolean', default: false },
      }),
      handler: async (args) => service.listSessions(args),
    },
    {
      name: 'dsh_get_session',
      readOnly: true,
      description:
        "Read one session's state: idle, running, waiting_approval, waiting_input, completed, "
        + 'cancelled, failed, or interrupted. Also returns the last turn, queued messages, pending '
        + 'approvals, model, and working directory. Does not start work.',
      inputSchema: object({ sessionId }, ['sessionId']),
      handler: async (args) => service.getSession(args),
    },
    {
      name: 'dsh_session_read_messages',
      readOnly: true,
      description:
        'Read messages newer than sinceSeq, oldest first. Returns at most maxChars from the newest end; '
        + 'truncated and oldestSeq mark omitted older content. Tool calls are summarized by name and status. '
        + 'A turn interrupted by a crash may end without a final assistant message; the state comes from '
        + 'dsh_get_session.',
      inputSchema: object({
        sessionId,
        sinceSeq,
        maxChars: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          description: 'Output budget in characters. Defaults to 60000.',
        },
        includeToolCalls: { type: 'boolean', default: true },
      }, ['sessionId']),
      handler: async (args) => service.readSession(args),
    },
    {
      name: 'dsh_create_session',
      readOnly: false,
      description:
        'Create a session in a workspace (or at an absolute cwd). Returns its sessionId. The session '
        + 'stays blank until the first message.',
      inputSchema: object({
        workspaceId: { type: 'string', description: 'From dsh_list_workspaces.' },
        cwd: {
          type: 'string',
          description: 'Absolute directory. Ignored when workspaceId is given. If the directory is not '
            + 'a workspace yet, one is registered for it so the session stays visible in the DSH sidebar.',
        },
        agentPreset: { type: 'string', description: 'From dsh_list_presets. Defaults to the DSH default.' },
        title: { type: 'string', description: 'Optional session title, at most 200 characters.' },
      }),
      handler: async (args) => service.createSession(args),
    },
    {
      name: 'dsh_session_send_message',
      readOnly: false,
      description:
        'Send a user message to a session. mode "queue" waits for the current turn (default); "steer" '
        + 'interrupts the model at its next step. Returns the cursor to pass to dsh_session_wait. '
        + 'Sending also repairs a session whose previous turn was interrupted by a crash, then starts '
        + 'a new turn. The same requestId retries safely with the same text.',
      inputSchema: object({
        sessionId,
        text: { type: 'string', minLength: 1, description: 'Message text.' },
        mode: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
        requestId: {
          type: 'string',
          description: 'Idempotency key. Omit to let the server generate one; reuse it only for retries.',
        },
      }, ['sessionId', 'text']),
      handler: async (args, context) => service.sendMessage(args, context?.signal),
    },
    {
      name: 'dsh_session_interrupt_turn',
      readOnly: false,
      description:
        "Stop the session's active turn. Queued messages are kept. Returns accepted, the resulting "
        + 'state, and the current cursor; when no turn is running it returns accepted false with '
        + 'reason "not-running".',
      inputSchema: object({ sessionId }, ['sessionId']),
      handler: async (args) => service.interruptSession(args),
    },
    {
      name: 'dsh_archive_session',
      readOnly: false,
      description:
        'Archive a session so it leaves the DSH sidebar. The session log is kept; archive is reversible '
        + 'from the DSH UI. A running session needs stopActivity to be stopped first.',
      inputSchema: object({
        sessionId,
        stopActivity: { type: 'boolean', default: false },
      }, ['sessionId']),
      handler: async (args) => service.archiveSession(args),
    },
    {
      name: 'dsh_session_wait',
      readOnly: true,
      description:
        'Wait for work to finish. until "idle" returns when the session has no running turn and no '
        + 'queued messages; "turn-end" returns on the next completed turn. Returns the session state; '
        + 'on timeout state is running with timedOut true and a cursor, so call again with the same '
        + 'sinceSeq. A cold session with an unclosed turn returns interrupted immediately. Never starts work.',
      inputSchema: object({
        sessionId,
        sinceSeq,
        until: { type: 'string', enum: ['idle', 'turn-end'], default: 'idle' },
        timeoutMs: {
          type: 'integer',
          minimum: 0,
          maximum: 120000,
          description: `Wait budget. Defaults to ${config.defaultWaitMs}ms, capped at ${config.maxWaitMs}ms.`,
        },
      }, ['sessionId']),
      handler: async (args, context) => service.wait({
        sessionId: args.sessionId,
        sinceSeq: args.sinceSeq,
        until: args.until === 'turn-end' ? 'turn-end' : 'idle',
        timeoutMs: args.timeoutMs,
        signal: context?.signal,
      }),
    },
  ]

  const visible = config.mode === 'read-only'
    ? definitions.filter((definition) => definition.readOnly)
    : definitions
  const byName = new Map(visible.map((definition) => [definition.name, definition]))

  function list() {
    return visible.map(({ handler, readOnly, ...schema }) => schema)
  }

  async function call(name, args, context = {}) {
    const definition = byName.get(name)
    if (definition === undefined) {
      return fail(new ToolError(Codes.UNSUPPORTED, `unknown tool: ${name}`, 'Call tools/list for the available tools.'))
    }
    try {
      const payload = await definition.handler(args, context)
      return ok(payload)
    } catch (error) {
      return fail(error)
    }
  }

  return { list, call, count: visible.length }
}
