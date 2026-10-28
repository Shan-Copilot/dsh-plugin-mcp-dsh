import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMessages } from '../lib/sessions/render.js'

const events = [
  { seq: 1, time: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }] } },
  {
    seq: 2,
    time: 2,
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'hi there' }] }, interrupted: false },
  },
  { seq: 3, time: 3, type: 'tool/call', data: { callId: 'c1', name: 'pwsh', arguments: '{}' } },
  {
    seq: 4,
    time: 4,
    type: 'tool/result',
    data: { message: { toolCallId: 'c1', isError: false, content: [] } },
  },
]

test('renders only events newer than sinceSeq', () => {
  const result = renderMessages(events, { sinceSeq: 1 })
  assert.deepEqual(result.messages.map((message) => message.text), ['hi there'])
  assert.equal(result.cursor, undefined)
  assert.equal(result.truncated, false)
})

test('summarizes tool calls with their names and error state', () => {
  const result = renderMessages(events)
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].name, 'pwsh')
  assert.equal(result.toolCalls[0].isError, false)
})

test('hides injected context messages that use the user role', () => {
  const result = renderMessages([
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'real' }], source: { kind: 'user' } } },
    { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>' }], source: { kind: 'runtime-context' } } },
    { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '<system-reminder>' }], source: { kind: 'time-context' } } },
  ])
  assert.deepEqual(result.messages.map((message) => message.text), ['real'])
})

test('keeps the newest messages when the budget is exceeded', () => {
  const result = renderMessages(events, { maxChars: 5 })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].text, 'hi th')
  assert.equal(result.truncated, true)
  assert.equal(result.hasMore, true)
})

test('drops older messages rather than clipping the newest one', () => {
  const result = renderMessages(events, { maxChars: 6 })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].text, 'hi the')
  assert.equal(result.oldestSeq, 2)
})
