import assert from 'node:assert/strict'
import test from 'node:test'

import { endState, lastTurnOf, openTurnOf, sessionState, summarize } from '../lib/sessions/state.js'

test('maps turn-end reasons onto public states', () => {
  assert.equal(endState({ kind: 'completed' }), 'completed')
  assert.equal(endState({ kind: 'completed' }, true), 'interrupted')
  assert.equal(endState({ kind: 'max-tokens' }), 'interrupted')
  assert.equal(endState({ kind: 'interrupted' }), 'interrupted')
  assert.equal(endState({ kind: 'forked' }), 'interrupted')
  assert.equal(endState({ kind: 'aborted', reason: { kind: 'user' } }), 'cancelled')
  assert.equal(endState({ kind: 'aborted', reason: { kind: 'parent' } }), 'interrupted')
  assert.equal(endState({ kind: 'aborted', reason: { kind: 'hook' } }), 'interrupted')
  assert.equal(endState({ kind: 'error' }), 'failed')
  assert.equal(endState({ kind: 'blocked' }), 'failed')
  assert.equal(endState(undefined), 'idle')
})

test('a cold session with an unclosed turn is interrupted', () => {
  const summary = summarize([{ seq: 11, type: 'turn/start', data: { turn: 2 } }])
  assert.equal(openTurnOf(summary), true)
  assert.equal(sessionState({ summary, agent: undefined, values: {} }), 'interrupted')
})

test('a live session with an open turn is running even before an event arrives', () => {
  const summary = summarize([{ seq: 11, type: 'turn/start', data: { turn: 2 } }])
  const agent = { status: 'idle', inbox: { nextTurn: [], nextStep: [] } }
  assert.equal(sessionState({ summary, agent, values: {} }), 'running')
})

test('pending approvals and questions win over running', () => {
  const summary = summarize([
    { seq: 11, type: 'turn/start', data: { turn: 2 } },
    { seq: 12, type: 'approval/asked', data: { id: 'a1' } },
  ])
  const agent = { status: 'running', inbox: { nextTurn: [], nextStep: [] } }
  assert.equal(sessionState({ summary, agent, values: {} }), 'waiting_approval')
  assert.equal(
    sessionState({
      summary: summarize([{ seq: 11, type: 'turn/start', data: { turn: 2 } }]),
      agent,
      values: { userQuestions: { active: [{ state: 'open' }] } },
    }),
    'waiting_input',
  )
})

test('a closed completed turn is completed, and an empty session is idle', () => {
  const closed = summarize([
    { seq: 11, type: 'turn/start', data: { turn: 2 } },
    { seq: 12, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ])
  assert.equal(sessionState({ summary: closed, agent: undefined, values: {} }), 'completed')
  assert.equal(sessionState({ summary: summarize([]), agent: undefined, values: {} }), 'idle')
})

test('lastTurnOf distinguishes an open turn from a closed one', () => {
  const open = summarize([{ seq: 11, type: 'turn/start', data: { turn: 2 } }])
  assert.deepEqual(lastTurnOf(open), { turn: 2, endReason: null })

  const closed = summarize([
    { seq: 11, type: 'turn/start', data: { turn: 2 } },
    { seq: 12, type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } },
  ])
  assert.deepEqual(lastTurnOf(closed), { turn: 2, endReason: { kind: 'max-tokens' } })

  assert.equal(lastTurnOf(summarize([])), undefined)
})
