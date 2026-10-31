/**
 * Session domain adapter.
 *
 * This is the only module that touches Host services. It deliberately uses
 * `sessionController` (the same entry the Web UI uses) so external callers see
 * the same sessions, titles, and turn semantics.
 */

import { randomUUID } from 'node:crypto'
import { Codes, ToolError, translateHostError } from '../errors.js'
import {
  approvalView,
  inboxSize,
  lastSeq,
  lastTurnOf,
  openQuestions,
  openTurnOf,
  projectionTitle,
  sessionState,
  summarize,
} from './state.js'
import { renderMessages } from './render.js'
import { createWaitHub } from './wait.js'

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
const IDEMPOTENCY_MAX = 500

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ToolError(Codes.INVALID_ARGUMENT, `${name} must be a non-empty string`)
  }
  return value
}

function timeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {object} options.config
 * @param {(level: string, fields: object) => void} options.log
 */
export function createSessionService({ ctx, config, log }) {
  const controller = ctx.sessionController
  const idempotency = new Map()
  let archiveCache = { at: 0, ids: new Set() }

  function optional(name) {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  function agentOf(sessionId) {
    return optional('agents')?.get?.(sessionId)
  }

  function requireController() {
    if (controller === undefined || controller === null) {
      throw new ToolError(Codes.UNSUPPORTED, 'sessionController is not available in this Host composition')
    }
    return controller
  }

  async function loadSummary(sessionId) {
    try {
      const value = await requireController().list({})
      const items = Array.isArray(value?.items) ? value.items : []
      return items.find((item) => item.sessionId === sessionId)
    } catch {
      return undefined
    }
  }

  async function loadValues(sessionId) {
    const summary = await loadSummary(sessionId)
    return summary?.projections?.values ?? {}
  }

  async function loadLog(sessionId) {
    const active = requireController()
    try {
      const snapshot = await active.inspect(sessionId)
      return {
        header: snapshot?.meta,
        events: Array.isArray(snapshot?.events) ? snapshot.events : [],
      }
    } catch (error) {
      const query = optional('sessionQuery')
      if (query?.readSession !== undefined) {
        try {
          const snapshot = await query.readSession(sessionId)
          return {
            header: snapshot?.session,
            events: Array.isArray(snapshot?.events) ? snapshot.events : [],
          }
        } catch (inner) {
          throw translateHostError(inner, sessionId)
        }
      }
      throw translateHostError(error, sessionId)
    }
  }

  async function tailCursor(sessionId) {
    const query = optional('sessionQuery')
    if (query?.readSurface !== undefined) {
      try {
        const surface = await query.readSurface(sessionId)
        if (typeof surface?.capturedThroughSeq === 'number') return surface.capturedThroughSeq
      } catch {
        // Fall back to the full log below.
      }
    }
    const snapshot = await loadLog(sessionId)
    return lastSeq(snapshot.events)
  }

  function workspaceOf(sessionId) {
    const registry = optional('workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    for (const workspace of workspaces) {
      if ((workspace.sessionIds ?? []).includes(sessionId)) return workspace
    }
    return undefined
  }

  /**
   * The workspace surface hides archived sessions; `sessionController.list`
   * does not. Read the archive set from the first baseline frame of the
   * workspace stream and cache it briefly.
   */
  async function loadArchived() {
    if (Date.now() - archiveCache.at < 1500) return archiveCache.ids
    const workspaceController = optional('workspaceController')
    const ids = new Set()
    if (workspaceController?.follow !== undefined) {
      const abort = new AbortController()
      let iterator
      try {
        const stream = workspaceController.follow(abort.signal)
        iterator = stream?.[Symbol.asyncIterator]?.() ?? stream
        const first = await iterator?.next?.()
        const frame = first?.value
        if (frame?.type === 'baseline') {
          for (const id of frame.value?.archivedSessionIds ?? []) ids.add(id)
        }
      } catch (error) {
        log('archived-read-failed', { message: error instanceof Error ? error.message : String(error) })
      } finally {
        abort.abort()
        try {
          await iterator?.return?.()
        } catch {
          // The stream is already closing.
        }
      }
    }
    archiveCache = { at: Date.now(), ids }
    return ids
  }

  async function counts() {
    const archived = await loadArchived()
    const value = await requireController().list({})
    const items = Array.isArray(value?.items) ? value.items : []
    let total = 0
    let running = 0
    for (const item of items) {
      if (archived.has(item.sessionId)) continue
      if (item.origin === 'subagent' || item.parentSessionId !== undefined) continue
      total += 1
      if (item.running === true) running += 1
    }
    return { total, running }
  }

  async function listSessions(args = {}) {
    const active = requireController()
    const value = await active.list({})
    const items = Array.isArray(value?.items) ? value.items : []
    const limit = clampInt(args.limit, 1, 100, 20)
    const start = Math.max(0, Number.parseInt(String(args.cursor ?? '0'), 10) || 0)
    const includeSubagents = args.includeSubagents === true
    const workspaceFilter = typeof args.workspaceId === 'string' ? args.workspaceId : undefined
    const archived = args.includeArchived === true ? new Set() : await loadArchived()

    const registry = optional('workspaceRegistry')
    const workspaces = registry?.list?.() ?? []
    const owner = new Map()
    for (const workspace of workspaces) {
      for (const sessionId of workspace.sessionIds ?? []) owner.set(sessionId, workspace)
    }

    const rows = []
    for (const item of items) {
      if (!includeSubagents && (item.origin === 'subagent' || item.parentSessionId !== undefined)) continue
      if (archived.has(item.sessionId)) continue
      const workspace = owner.get(item.sessionId)
      if (workspaceFilter !== undefined && workspace?.id !== workspaceFilter) continue
      const values = item.projections?.values ?? {}
      const cwd = values.workingDirectory ?? item.cwd
      rows.push({
        sessionId: item.sessionId,
        title: projectionTitle(values) ?? item.sessionId,
        running: item.running === true,
        blank: item.blank === true,
        updatedAt: item.updatedAt,
        ...(workspace === undefined ? {} : { workspaceId: workspace.id, workspace: workspace.path }),
        ...(typeof cwd === 'string' ? { cwd } : {}),
        ...(typeof values.agentPreset === 'string' ? { preset: values.agentPreset } : {}),
        ...(item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }),
      })
    }

    const page = rows.slice(start, start + limit)
    return {
      sessions: page,
      total: rows.length,
      ...(start + limit < rows.length ? { nextCursor: String(start + limit) } : {}),
    }
  }

  async function getSession(args = {}) {
    const sessionId = requireString(args.sessionId, 'sessionId')
    const snapshot = await loadLog(sessionId)
    const events = snapshot.events
    const info = summarize(events)
    const agent = agentOf(sessionId)
    const summary = await loadSummary(sessionId)
    const values = summary?.projections?.values ?? {}
    const workspace = workspaceOf(sessionId)
    const cwd = values.workingDirectory ?? summary?.cwd ?? snapshot.header?.cwd
    const model = values.modelSelection?.lastUsed ?? values.modelSelection?.next
    const archived = (await loadArchived()).has(sessionId)
    const lastTurn = lastTurnOf(info)

    return {
      sessionId,
      title: projectionTitle(values) ?? sessionId,
      state: sessionState({ summary: info, agent, values }),
      blank: summary?.blank === true,
      archived,
      lastSeq: lastSeq(events),
      ...(lastTurn === undefined ? {} : { lastTurn }),
      pendingApprovals: approvalView(info.approvals),
      pendingQuestions: openQuestions(values).length,
      queued: inboxSize(agent),
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(workspace === undefined ? {} : { workspaceId: workspace.id, workspace: workspace.path }),
      ...(typeof values.agentPreset === 'string' ? { preset: values.agentPreset } : {}),
      ...(model === undefined || model === null ? {} : { model }),
    }
  }

  async function assertPreset(preset) {
    const presets = optional('agentPresets')
    if (presets?.list === undefined) return
    const catalog = await presets.list()
    const list = Array.isArray(catalog) ? catalog : catalog?.presets ?? []
    if (!list.some((item) => item.id === preset)) {
      throw new ToolError(
        Codes.PRESET_NOT_FOUND,
        `agent preset not found: ${preset}`,
        'Call dsh_list_presets to get a valid preset id.',
      )
    }
  }

  async function createSession(args = {}) {
    const workspaceArg = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : ''
    const cwdArg = typeof args.cwd === 'string' ? args.cwd.trim() : ''
    if (workspaceArg.length === 0 && cwdArg.length === 0) {
      throw new ToolError(
        Codes.INVALID_ARGUMENT,
        'workspaceId or cwd is required',
        'Call dsh_list_workspaces and pass a workspaceId, or pass an absolute cwd.',
      )
    }

    const registry = optional('workspaceRegistry')
    let workspaceId = workspaceArg.length > 0 ? workspaceArg : undefined
    let cwd = cwdArg.length > 0 ? cwdArg : undefined

    if (workspaceId !== undefined) {
      const workspace = registry?.get?.(workspaceId)
      if (registry !== undefined && workspace === undefined) {
        throw new ToolError(
          Codes.WORKSPACE_NOT_FOUND,
          `workspace not found: ${workspaceId}`,
          'Call dsh_list_workspaces to get a valid workspaceId.',
        )
      }
      if (workspace !== undefined && cwd === undefined) cwd = workspace.path
    } else if (cwd !== undefined && registry?.resolveByPath !== undefined) {
      try {
        const workspace = await registry.resolveByPath(cwd)
        if (workspace !== undefined) {
          workspaceId = workspace.id
        } else if (registry.create !== undefined) {
          // A session outside every workspace does not appear in the Web sidebar.
          // Registering the directory keeps MCP-created sessions visible and
          // matches "open this folder" in the UI.
          const createdWorkspace = await registry.create(cwd)
          if (createdWorkspace?.id !== undefined) {
            workspaceId = createdWorkspace.id
            log('workspace-created', { cwd, workspaceId })
          }
        }
      } catch (error) {
        log('workspace-resolve-failed', {
          cwd,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const preset = typeof args.agentPreset === 'string' ? args.agentPreset.trim() : ''
    if (preset.length > 0) await assertPreset(preset)

    let created
    try {
      created = await requireController().create({
        ...(workspaceId === undefined ? (cwd === undefined ? {} : { cwd }) : { workspaceId }),
        ...(preset.length === 0 ? {} : { agentPreset: preset }),
      })
    } catch (error) {
      throw translateHostError(error, 'new session')
    }

    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ToolError(Codes.INTERNAL, 'session create returned no id')
    }
    log('create', {
      sessionId,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(preset.length === 0 ? {} : { preset }),
      ...(cwd === undefined ? {} : { cwd }),
    })

    let title
    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      title = args.title.trim()
      try {
        await requireController().rename({ sessionId, title })
      } catch (error) {
        log('rename-skipped', { sessionId, message: error instanceof Error ? error.message : String(error) })
        title = undefined
      }
    }

    return {
      sessionId,
      ...(title === undefined ? {} : { title }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(preset.length === 0 && created?.agentPreset === undefined
        ? {}
        : { preset: created?.agentPreset ?? preset }),
    }
  }

  function remember(key, entry) {
    idempotency.set(key, { ...entry, at: Date.now() })
    if (idempotency.size <= IDEMPOTENCY_MAX) return
    const now = Date.now()
    for (const [candidate, value] of idempotency) {
      if (now - value.at > IDEMPOTENCY_TTL_MS) idempotency.delete(candidate)
    }
    while (idempotency.size > IDEMPOTENCY_MAX) {
      const oldest = idempotency.keys().next().value
      if (oldest === undefined) break
      idempotency.delete(oldest)
    }
  }

  /**
   * Find the durable seq of the user message admitted for this prompt. The
   * controller echoes the request id as the user source's `rpcId`, including
   * pending inbox messages. Returning this seq instead of the pre-send tail
   * keeps `wait` from mistaking a crash-repair `turn/end` for this turn's end.
   */
  function findRequestSeq(events, requestId) {
    for (const event of events) {
      const source = event?.data?.source ?? event?.data?.message?.source
      if (source?.rpcId === requestId) return event.seq
      const messages = Array.isArray(event?.data?.messages) ? event.data.messages : []
      for (const message of messages) {
        if (message?.source?.rpcId === requestId) return event.seq
      }
    }
    return undefined
  }

  async function sendMessage(args = {}, signal) {
    const sessionId = requireString(args.sessionId, 'sessionId')
    const text = requireString(args.text, 'text')
    if (text.length > config.maxPromptChars) {
      throw new ToolError(
        Codes.INVALID_ARGUMENT,
        `text exceeds ${config.maxPromptChars} characters`,
        'Split the request into smaller messages.',
      )
    }
    const mode = args.mode === 'steer' ? 'steer' : 'queue'
    const requestId = typeof args.requestId === 'string' && args.requestId.trim().length > 0
      ? args.requestId.trim()
      : `mcp-${randomUUID()}`
    const key = `${sessionId}\u0000${requestId}`
    const cached = idempotency.get(key)
    if (cached !== undefined) {
      if (cached.text !== text) {
        throw new ToolError(
          Codes.INVALID_ARGUMENT,
          'requestId was reused with different text',
          'Use a new requestId for a new message.',
        )
      }
      return cached.value
    }

    // Baseline must be read before admission: if the turn finishes before the
    // caller waits, the end event still has a seq greater than this cursor.
    if (config.allowSubagentSessions !== true) {
      const summary = await loadSummary(sessionId)
      if (summary?.origin === 'subagent' || summary?.parentSessionId !== undefined) {
        throw new ToolError(
          Codes.UNSUPPORTED,
          'subagent sessions are disabled',
          'Set allowSubagentSessions to true to drive subagent sessions.',
        )
      }
    }
    const beforeCursor = await tailCursor(sessionId)
    const zone = timeZone()
    try {
      await requireController().prompt(
        {
          requestId,
          sessionId,
          mode,
          content: [{ type: 'text', text }],
          ...(zone === undefined ? {} : { clientTimeZone: zone }),
        },
        signal,
      )
    } catch (error) {
      throw translateHostError(error, sessionId)
    }

    let cursor = beforeCursor
    try {
      const snapshot = await loadLog(sessionId)
      const messageSeq = findRequestSeq(snapshot.events, requestId)
      if (typeof messageSeq === 'number') cursor = messageSeq
    } catch {
      // The message is accepted; the cursor stays at the pre-send tail.
    }

    const value = { accepted: true, sessionId, requestId, mode, cursor }
    remember(key, { text, value })
    log('send', { sessionId, requestId, mode, chars: text.length })
    return value
  }

  async function interruptSession(args = {}) {
    const sessionId = requireString(args.sessionId, 'sessionId')
    const snapshot = await loadLog(sessionId)
    const info = summarize(snapshot.events)
    const agent = agentOf(sessionId)
    const before = lastSeq(snapshot.events)
    const active = agent !== undefined && (openTurnOf(info) || agent?.status === 'running')

    if (!active) {
      return {
        accepted: false,
        reason: 'not-running',
        sessionId,
        state: sessionState({ summary: info, agent }),
        cursor: before,
      }
    }

    try {
      await requireController().cancel({ sessionId })
    } catch (error) {
      throw translateHostError(error, sessionId)
    }
    let after = snapshot
    try {
      after = await loadLog(sessionId)
    } catch {
      // Cancellation already succeeded; the post-cancel snapshot is best-effort.
    }
    const afterInfo = summarize(after.events)
    const afterAgent = agentOf(sessionId)
    log('interrupt', { sessionId })
    return {
      accepted: true,
      sessionId,
      state: sessionState({ summary: afterInfo, agent: afterAgent }),
      cursor: lastSeq(after.events),
    }
  }

  async function readSession(args = {}) {
    const sessionId = requireString(args.sessionId, 'sessionId')
    const snapshot = await loadLog(sessionId)
    const cursor = lastSeq(snapshot.events)
    const rendered = renderMessages(snapshot.events, {
      sinceSeq: Number.isFinite(args.sinceSeq) ? args.sinceSeq : undefined,
      maxChars: clampInt(args.maxChars, 1000, config.maxReadChars, 60_000),
      includeToolCalls: args.includeToolCalls === true,
    })
    return { sessionId, cursor, ...rendered }
  }

  async function archiveSession(args = {}) {
    const sessionId = requireString(args.sessionId, 'sessionId')
    const registry = optional('workspaceRegistry')
    if (registry?.archiveSession === undefined) {
      throw new ToolError(Codes.UNSUPPORTED, 'workspaceRegistry.archiveSession is not available')
    }
    try {
      await registry.archiveSession(sessionId, { stopActivity: args.stopActivity === true })
    } catch (error) {
      throw translateHostError(error, sessionId)
    }
    archiveCache = { at: 0, ids: new Set() }
    log('archive', { sessionId, stopActivity: args.stopActivity === true })
    return { archived: true, sessionId }
  }

  async function listWorkspaces(args = {}) {
    const registry = optional('workspaceRegistry')
    if (registry?.list === undefined) {
      throw new ToolError(Codes.UNSUPPORTED, 'workspaceRegistry is not available in this Host composition')
    }
    const limit = clampInt(args.limit, 1, 200, 50)
    const archived = await loadArchived()
    return {
      workspaces: registry.list().slice(0, limit).map((workspace) => ({
        workspaceId: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessionCount: (workspace.sessionIds ?? []).filter((sessionId) => !archived.has(sessionId)).length,
      })),
    }
  }

  async function listPresets() {
    const presets = optional('agentPresets')
    if (presets?.list === undefined) {
      return { presets: [] }
    }
    const catalog = await presets.list()
    const list = Array.isArray(catalog) ? catalog : catalog?.presets ?? []
    return {
      presets: list.map((item) => ({
        id: item.id,
        name: item.name ?? item.id,
        isDefault: item.isDefault === true,
        broken: item.broken === true,
      })),
    }
  }

  const waitHub = createWaitHub({ ctx, config, loadLog, loadValues, log })

  function dispose() {
    waitHub.dispose()
    idempotency.clear()
  }

  return {
    counts,
    listSessions,
    getSession,
    createSession,
    sendMessage,
    interruptSession,
    archiveSession,
    readSession,
    listWorkspaces,
    listPresets,
    wait: waitHub.wait,
    waiterCount: waitHub.waiterCount,
    dispose,
  }
}
