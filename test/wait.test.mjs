import assert from 'node:assert/strict'
import test from 'node:test'

import { createWaitHub } from '../lib/sessions/wait.js'
import { fakeCtx } from './helpers.mjs'

const config = { defaultWaitMs: 100, maxWaitMs: 1000 }

function build(events, { agent, values, config: override } = {}) {
  const agents = new Map()
  if (agent !== undefined) agents.set('s1', agent)
  const { ctx } = fakeCtx({ agents })
  const hub = createWaitHub({
    ctx,
    config: override ?? config,
    loadLog: async () => ({ events }),
    loadValues: async () => values ?? {},
  })
  return { hub, ctx }
}

const runningAgent = () => ({ status: 'running', inbox: { nextTurn: [], nextStep: [] } })

test('returns the last completed turn immediately', async () => {
  const { hub } = build([
    { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
    { seq: 10, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const result = await hub.wait({ sessionId: 's1', sinceSeq: -1 })
  assert.equal(result.state, 'completed')
  assert.equal(result.cursor, 10)
  assert.equal(result.turn, 1)
  assert.equal(result.preview, 'answer')
})

test('waits for a turn that is still open', async () => {
  const { hub, ctx } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent() },
  )
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  ctx.emit('session/event', { id: 's1' }, { seq: 12, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const result = await pending
  assert.equal(result.state, 'completed')
  assert.equal(result.cursor, 12)
})

test('maps a user abort to cancelled', async () => {
  const { hub, ctx } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent() },
  )
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  ctx.emit('session/event', { id: 's1' }, {
    seq: 12,
    type: 'turn/end',
    data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  })
  assert.equal((await pending).state, 'cancelled')
})

test('returns running plus timedOut when the deadline passes', async () => {
  const { hub } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent() },
  )
  const result = await hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 30 })
  assert.equal(result.state, 'running')
  assert.equal(result.timedOut, true)
  assert.equal(result.cursor, 11)
  assert.equal('running' in result, false)
})

test('an omitted timeoutMs falls back to defaultWaitMs', async () => {
  const { hub } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent(), config: { defaultWaitMs: 60, maxWaitMs: 60_000 } },
  )
  const startedAt = Date.now()
  const result = await hub.wait({ sessionId: 's1', sinceSeq: 11 })
  const elapsed = Date.now() - startedAt
  assert.equal(result.timedOut, true)
  assert.ok(elapsed >= 50 && elapsed < 5_000, `waited ${elapsed}ms`)
})

test('a request above the cap is clamped to maxWaitMs', async () => {
  const { hub } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent(), config: { defaultWaitMs: 10, maxWaitMs: 120 } },
  )
  const startedAt = Date.now()
  const result = await hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 60_000 })
  const elapsed = Date.now() - startedAt
  assert.equal(result.state, 'running')
  assert.equal(result.timedOut, true)
  assert.ok(elapsed < 5_000, `waited ${elapsed}ms, the cap was not applied`)
  assert.ok(elapsed >= 100, `waited ${elapsed}ms, shorter than the cap`)
})

test('a cold session with an unclosed turn returns interrupted immediately', async () => {
  const { hub } = build([{ seq: 11, type: 'turn/start', data: { turn: 2 } }])
  const result = await hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 1000 })
  assert.equal(result.state, 'interrupted')
  assert.equal(result.cursor, 11)
  assert.equal(result.turn, 2)
  assert.equal(result.endReason, null)
  assert.equal(hub.waiterCount(), 0)
})

test('agent/status idle after an unclosed turn releases the waiter as interrupted', async () => {
  const agent = { ...runningAgent(), id: 's1' }
  const { hub, ctx } = build([{ seq: 11, type: 'turn/start', data: { turn: 2 } }], { agent })
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal((await pending).state, 'interrupted')
})

test('until turn-end returns the next completed turn', async () => {
  const { hub, ctx } = build(
    [
      { seq: 10, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { seq: 11, type: 'turn/start', data: { turn: 2 } },
    ],
    { agent: runningAgent() },
  )
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 10, until: 'turn-end', timeoutMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  ctx.emit('session/event', { id: 's1' }, { seq: 12, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  const result = await pending
  assert.equal(result.state, 'completed')
  assert.equal(result.turn, 2)
})

test('reports a pending user question as waiting_input', async () => {
  const { hub } = build([], { values: { userQuestions: { active: [{ id: 'q1', state: 'open' }] } } })
  const result = await hub.wait({ sessionId: 's1', timeoutMs: 1000 })
  assert.equal(result.state, 'waiting_input')
  assert.equal(result.pendingQuestions, 1)
})

test('surfaces an approval prompt without answering it', async () => {
  const { hub, ctx } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent() },
  )
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 2000 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  ctx.emit('session/event', { id: 's1' }, {
    seq: 12,
    type: 'approval/asked',
    data: { id: 'a1', toolName: 'pwsh', reason: 'run tests' },
  })
  const result = await pending
  assert.equal(result.state, 'waiting_approval')
  assert.equal(result.approvals[0].toolName, 'pwsh')
})

test('an approved decision keeps waiting for the turn end', async () => {
  const { hub, ctx } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent() },
  )
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  ctx.emit('session/event', { id: 's1' }, { seq: 12, type: 'approval/asked', data: { id: 'a1' } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  ctx.emit('session/event', { id: 's1' }, { seq: 13, type: 'approval/decided', data: { id: 'a1' } })
  ctx.emit('session/event', { id: 's1' }, { seq: 14, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal((await pending).state, 'completed')
})

test('an aborted caller releases its waiter', async () => {
  const { hub } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent() },
  )
  const controller = new AbortController()
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 1000, signal: controller.signal })
  controller.abort()
  assert.equal((await pending).state, 'aborted')
  assert.equal(hub.waiterCount(), 0)
})

test('dispose releases every waiter', async () => {
  const { hub } = build(
    [{ seq: 11, type: 'turn/start', data: { turn: 2 } }],
    { agent: runningAgent() },
  )
  const pending = hub.wait({ sessionId: 's1', sinceSeq: 11, timeoutMs: 5000 })
  hub.dispose()
  assert.equal((await pending).state, 'aborted')
})
