import assert from 'node:assert/strict'
import test from 'node:test'

import { normalize } from '../index.js'

test('wait budget defaults to 240s', () => {
  const config = normalize({})
  assert.equal(config.defaultWaitMs, 240_000)
  assert.equal(config.maxWaitMs, 240_000)
})

test('a configured maxWaitMs cannot exceed the 240s hard cap', () => {
  assert.equal(normalize({ maxWaitMs: 600_000 }).maxWaitMs, 240_000)
  assert.equal(normalize({ maxWaitMs: 30_000 }).maxWaitMs, 30_000)
})

test('the default budget never exceeds the configured cap', () => {
  assert.equal(normalize({ maxWaitMs: 30_000 }).defaultWaitMs, 30_000)
  assert.equal(normalize({ defaultWaitMs: 5_000, maxWaitMs: 30_000 }).defaultWaitMs, 5_000)
  assert.equal(normalize({ defaultWaitMs: 999_999 }).defaultWaitMs, 240_000)
})
