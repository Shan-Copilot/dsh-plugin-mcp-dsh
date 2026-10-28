/**
 * Cursor-based waiting over live session events.
 *
 * A wait never mutates the session: it observes the durable log and the live
 * agent, then resolves on the next turn boundary, an approval prompt, or the
 * deadline. Every result carries the last observed `seq` so a client can resume
 * after a disconnect without replaying or missing work.
 */

import { approvalView, inboxSize, isRunning, lastSeq, openQuestions, openTurnOf, summarize, turnEndState } from './state.js'
import { textOfContent } from './render.js'

const ATTENTION_DELAY_MS = 250

function approvalKey(event) {
  return event?.data?.id ?? event?.data?.approvalId ?? event?.data?.requestId ?? event?.seq
}

function turnEndPayload(sessionId, info, cursor) {
  const preview = textOfContent(info.lastAssistant?.data?.message?.content)
  return {
    sessionId,
    state: turnEndState(info.lastEnd, info.lastAssistant),
    cursor,
    turn: info.lastEnd?.data?.turn,
    endReason: info.lastEnd?.data?.reason ?? null,
    ...(preview.length === 0 ? {} : { preview: preview.slice(0, 600) }),
    ...(info.lastAssistant?.data?.interrupted === true ? { interrupted: true } : {}),
  }
}

function interruptedPayload(sessionId, info, cursor) {
  const preview = textOfContent(info.lastAssistant?.data?.message?.content)
  return {
    sessionId,
    state: 'interrupted',
    cursor,
    turn: info.lastStart?.data?.turn ?? info.lastEnd?.data?.turn,
    endReason: null,
    ...(preview.length === 0 ? {} : { preview: preview.slice(0, 600) }),
  }
}

function approvalPayload(sessionId, info, cursor) {
  return {
    sessionId,
    state: 'waiting_approval',
    cursor,
    approvals: approvalView(info.approvals),
  }
}

function idlePayload(sessionId, cursor) {
  return { sessionId, state: 'idle', cursor }
}

function waitingInputPayload(sessionId, cursor, questions) {
  return {
    sessionId,
    state: 'waiting_input',
    cursor,
    pendingQuestions: questions.length,
  }
}

/**
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {{defaultWaitMs: number, maxWaitMs: number}} options.config
 * @param {(sessionId: string) => Promise<{header?: object, events: object[]}>} options.loadLog
 * @param {(sessionId: string) => Promise<object>} [options.loadValues]
 * @param {(level: string, fields: object) => void} [options.log]
 */
export function createWaitHub({ ctx, config, loadLog, loadValues, log = () => {} }) {
  /** @type {Map<string, Set<object>>} */
  const waiters = new Map()
  let disposed = false

  function agentOf(sessionId) {
    const agents = ctx.get('agents')
    return agents?.get?.(sessionId)
  }

  function deliver(session, event) {
    const sessionId = session?.id ?? session?.sessionId
    const set = waiters.get(sessionId)
    if (set === undefined) return
    for (const waiter of [...set]) {
      try {
        waiter.handle(event)
      } catch (error) {
        log('wait-event-error', { sessionId, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const offEvent = ctx.on('session/event', (session, event) => deliver(session, event))

  const offStatus = ctx.on('agent/status', ({ agent, status }) => {
    const set = waiters.get(agent?.id)
    if (set === undefined) return
    for (const waiter of [...set]) {
      try {
        waiter.status(status)
      } catch (error) {
        log('wait-status-error', { message: error instanceof Error ? error.message : String(error) })
      }
    }
  })

  function clampTimeout(requested) {
    const fallback = config.defaultWaitMs
    const value = Number.isFinite(requested) && requested >= 0 ? requested : fallback
    return Math.min(Math.max(value, 0), config.maxWaitMs)
  }

  /**
   * @param {{sessionId: string, sinceSeq?: number, until?: 'idle'|'turn-end', timeoutMs?: number, signal?: AbortSignal}} request
   */
  async function wait({ sessionId, sinceSeq, until = 'idle', timeoutMs, signal }) {
    const snapshot = await loadLog(sessionId)
    if (disposed) return { sessionId, state: 'aborted', cursor: lastSeq(snapshot.events ?? []) }
    const events = snapshot.events ?? []
    const info = summarize(events)
    const agent = agentOf(sessionId)
    const cursor = lastSeq(events)
    const baseline = Number.isFinite(sinceSeq) ? sinceSeq : -1
    const running = isRunning(agent, info)
    const openTurn = openTurnOf(info)
    const values = typeof loadValues === 'function'
      ? await loadValues(sessionId).catch(() => ({}))
      : {}
    const questions = openQuestions(values)

    if (info.approvals.size > 0) {
      return approvalPayload(sessionId, info, cursor)
    }
    if (questions.length > 0) {
      return waitingInputPayload(sessionId, cursor, questions)
    }

    // A cold session with an unclosed turn is a crash artifact: the turn is
    // dead, and the next send repairs it. There is no live event to wait for.
    if (agent === undefined && openTurn) {
      return interruptedPayload(sessionId, info, cursor)
    }

    if (until === 'turn-end') {
      if (info.lastEnd !== undefined && info.lastEnd.seq > baseline) {
        return turnEndPayload(sessionId, info, cursor)
      }
      if (!running && !openTurn) return idlePayload(sessionId, cursor)
    } else {
      if (!running && !openTurn) {
        if (info.lastEnd !== undefined && info.lastEnd.seq > baseline) {
          return turnEndPayload(sessionId, info, cursor)
        }
        return idlePayload(sessionId, cursor)
      }
    }

    return new Promise((resolve) => {
      const waiter = {
        sessionId,
        baseline,
        until,
        cursor,
        lastStart: info.lastStart,
        lastEnd: info.lastEnd,
        lastAssistant: info.lastAssistant,
        approvals: new Map(info.approvals),
        timer: undefined,
        attentionTimer: undefined,
        done: false,

        currentAgent() {
          return agentOf(this.sessionId)
        },

        finish(result) {
          if (this.done) return
          this.done = true
          if (this.timer !== undefined) clearTimeout(this.timer)
          if (this.attentionTimer !== undefined) clearTimeout(this.attentionTimer)
          signal?.removeEventListener?.('abort', this.onAbort)
          const set = waiters.get(this.sessionId)
          if (set !== undefined) {
            set.delete(this)
            if (set.size === 0) waiters.delete(this.sessionId)
          }
          resolve(result)
        },

        handle(event) {
          if (this.done) return
          if (typeof event?.seq === 'number' && event.seq > this.cursor) this.cursor = event.seq
          switch (event?.type) {
            case 'turn/start':
              this.lastStart = event
              break
            case 'assistant/message':
              this.lastAssistant = event
              break
            case 'approval/asked': {
              const key = approvalKey(event)
              if (key !== undefined) this.approvals.set(key, event)
              this.scheduleAttention()
              break
            }
            case 'approval/decided': {
              const key = approvalKey(event)
              if (key !== undefined) this.approvals.delete(key)
              this.cancelAttention()
              break
            }
            case 'turn/end': {
              this.lastEnd = event
              this.approvals.clear()
              this.cancelAttention()
              if (this.until === 'turn-end') {
                this.finish(turnEndPayload(this.sessionId, this, this.cursor))
                return
              }
              if (inboxSize(this.currentAgent()) === 0) {
                this.finish(turnEndPayload(this.sessionId, this, this.cursor))
              }
              break
            }
            case 'agent/error': {
              this.finish({
                sessionId: this.sessionId,
                state: 'failed',
                cursor: this.cursor,
                turn: event.data?.turn ?? this.lastStart?.data?.turn,
                endReason: {
                  kind: 'error',
                  ...(typeof event.data?.error?.message === 'string' ? { message: event.data.error.message } : {}),
                },
              })
              break
            }
            default:
              break
          }
        },

        status(status) {
          if (this.done || status !== 'idle') return
          if (this.approvals.size > 0) return
          if (inboxSize(this.currentAgent()) > 0) return
          const open = this.lastStart !== undefined
            && (this.lastEnd === undefined || this.lastStart.seq > this.lastEnd.seq)
          if (open) {
            this.finish(interruptedPayload(this.sessionId, this, this.cursor))
          } else if (this.lastEnd !== undefined) {
            this.finish(turnEndPayload(this.sessionId, this, this.cursor))
          } else {
            this.finish(idlePayload(this.sessionId, this.cursor))
          }
        },

        scheduleAttention() {
          if (this.attentionTimer !== undefined || this.done) return
          this.attentionTimer = setTimeout(() => {
            this.attentionTimer = undefined
            if (this.done || this.approvals.size === 0) return
            this.finish(approvalPayload(this.sessionId, this, this.cursor))
          }, ATTENTION_DELAY_MS)
          this.attentionTimer.unref?.()
        },

        cancelAttention() {
          if (this.attentionTimer === undefined) return
          clearTimeout(this.attentionTimer)
          this.attentionTimer = undefined
        },

        onAbort: undefined,
      }

      waiter.timer = setTimeout(() => {
        waiter.finish({
          sessionId,
          state: 'running',
          timedOut: true,
          cursor: waiter.cursor,
          turn: waiter.lastStart?.data?.turn ?? waiter.lastEnd?.data?.turn,
        })
      }, clampTimeout(timeoutMs))
      waiter.timer.unref?.()

      waiter.onAbort = () => waiter.finish({ sessionId, state: 'aborted', cursor: waiter.cursor })
      if (signal?.aborted === true) {
        waiter.finish({ sessionId, state: 'aborted', cursor })
        return
      }
      signal?.addEventListener?.('abort', waiter.onAbort, { once: true })

      const set = waiters.get(sessionId) ?? new Set()
      set.add(waiter)
      waiters.set(sessionId, set)
    })
  }

  function dispose() {
    disposed = true
    offEvent?.()
    offStatus?.()
    for (const set of [...waiters.values()]) {
      for (const waiter of [...set]) {
        try {
          waiter.finish({ sessionId: waiter.sessionId, state: 'aborted', cursor: waiter.cursor })
        } catch {
          // The waiter is already gone.
        }
      }
    }
    waiters.clear()
  }

  function waiterCount() {
    let count = 0
    for (const set of waiters.values()) count += set.size
    return count
  }

  return { wait, dispose, waiterCount }
}
