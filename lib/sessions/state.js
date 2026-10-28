/**
 * Pure derivations over a session event log: turn boundaries, approvals, state.
 * No Host calls here, so the rules are unit-testable.
 */

export function lastSeq(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const seq = events[index]?.seq
    if (typeof seq === 'number') return seq
  }
  return -1
}

function approvalKey(event) {
  return event?.data?.id ?? event?.data?.approvalId ?? event?.data?.requestId ?? event?.seq
}

export function summarize(events) {
  let lastStart
  let lastEnd
  let lastAssistant
  const approvals = new Map()

  for (const event of events) {
    switch (event?.type) {
      case 'turn/start':
        lastStart = event
        break
      case 'turn/end':
        lastEnd = event
        break
      case 'assistant/message':
        lastAssistant = event
        break
      case 'approval/asked': {
        const key = approvalKey(event)
        if (key !== undefined) approvals.set(key, event)
        break
      }
      case 'approval/decided': {
        const key = approvalKey(event)
        if (key !== undefined) approvals.delete(key)
        break
      }
      default:
        break
    }
  }

  return { lastStart, lastEnd, lastAssistant, approvals }
}

export function inboxSize(agent) {
  return (agent?.inbox?.nextTurn?.length ?? 0) + (agent?.inbox?.nextStep?.length ?? 0)
}

export function isRunning(agent, summary) {
  return agent?.status === 'running' || inboxSize(agent) > 0 || summary?.running === true
}

export function projectionTitle(values) {
  const title = values?.title
  if (typeof title === 'string' && title.length > 0) return title
  if (title !== null && typeof title === 'object') {
    if (typeof title.title === 'string' && title.title.length > 0) return title.title
    if (typeof title.text === 'string' && title.text.length > 0) return title.text
  }
  return undefined
}

export function openQuestions(values) {
  const active = values?.userQuestions?.active
  if (!Array.isArray(active)) return []
  return active.filter((question) => question?.state === 'open')
}

/** Map a durable turn-end reason onto the public session state. */
export function endState(reason, interrupted = false) {
  switch (reason?.kind) {
    case 'completed':
      return interrupted ? 'interrupted' : 'completed'
    case 'max-tokens':
    case 'interrupted':
    case 'forked':
      return 'interrupted'
    case 'aborted':
      return reason.reason?.kind === 'user' ? 'cancelled' : 'interrupted'
    case 'error':
    case 'blocked':
      return 'failed'
    default:
      return 'idle'
  }
}

export function openTurnOf(summary) {
  return summary?.lastStart !== undefined
    && (summary.lastEnd === undefined || summary.lastStart.seq > summary.lastEnd.seq)
}

/**
 * The latest turn as a client-facing view. `endReason` is null while the turn
 * is still open (including a crashed turn that never wrote `turn/end`).
 */
export function lastTurnOf(summary) {
  if (summary?.lastStart === undefined && summary?.lastEnd === undefined) return undefined
  const startSeq = summary?.lastStart?.seq ?? -1
  const endSeq = summary?.lastEnd?.seq ?? -1
  const closed = endSeq > startSeq
  const turn = (closed ? summary.lastEnd?.data?.turn : summary.lastStart?.data?.turn)
    ?? summary.lastEnd?.data?.turn
    ?? summary.lastStart?.data?.turn
  return {
    ...(turn === undefined ? {} : { turn }),
    endReason: closed ? summary.lastEnd?.data?.reason ?? null : null,
  }
}

export function turnEndState(event, lastAssistant) {
  return endState(event?.data?.reason, lastAssistant?.data?.interrupted === true)
}

export function approvalView(approvals) {
  return [...approvals.values()].map((event) => ({
    id: approvalKey(event),
    ...(typeof event.data?.toolName === 'string' ? { toolName: event.data.toolName } : {}),
    ...(typeof event.data?.reason === 'string' ? { reason: event.data.reason } : {}),
    ...(typeof event.data?.callId === 'string' ? { callId: event.data.callId } : {}),
  }))
}

/**
 * Public session state. Precedence: approval, question, running, terminal turn.
 * A cold session with an unclosed turn is `interrupted`: the turn is dead and
 * the next send repairs it internally.
 */
export function sessionState({ summary, agent, values }) {
  if (summary && summary.approvals.size > 0) return 'waiting_approval'
  if (openQuestions(values).length > 0) return 'waiting_input'

  const openTurn = openTurnOf(summary)
  if (agent !== undefined && agent !== null) {
    if (openTurn || isRunning(agent, summary)) return 'running'
  } else if (openTurn) {
    return 'interrupted'
  }

  if (summary?.lastEnd && (!summary.lastStart || summary.lastEnd.seq > summary.lastStart.seq)) {
    return turnEndState(summary.lastEnd, summary.lastAssistant)
  }
  return 'idle'
}
