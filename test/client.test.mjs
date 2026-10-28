import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

function loadClient() {
  let captured
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          captured = definition
        },
      },
      location: { origin: 'http://127.0.0.1:3080' },
      setTimeout: () => 0,
    },
    fetch: async () => ({ ok: true }),
    console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'client.js must register through window.__ModuleLoader__.load')
  return captured
}

function fakeContext() {
  const registrations = []
  const dictionaries = []
  const effects = []
  const ctx = {
    effect(factory) {
      effects.push(factory())
      return () => {}
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'plugins.bundle.config')
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, dictionaries }
}

const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState() {
    return [undefined, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
}

test('client bundle registers the plugin-page slot under the bundle name', () => {
  const definition = loadClient()
  assert.equal(definition.id, '@local/mcp-dsh')
  assert.equal(typeof definition.factory, 'function')

  const plugin = definition.factory((name) => {
    assert.equal(name, 'react')
    return react
  })
  assert.equal(plugin.inject.join(','), 'slots,locale')

  const { ctx, registrations, dictionaries } = fakeContext()
  plugin.apply(ctx)

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'plugins.bundle.config')
  assert.equal(registrations[0].options.key, '@local/mcp-dsh')
  assert.equal(typeof registrations[0].component, 'function')

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].namespace, 'mcpDsh')
  assert.equal(typeof dictionaries[0].dicts.zh.title, 'string')
  assert.equal(typeof dictionaries[0].dicts.en.title, 'string')

  const summary = registrations[0].component({ view: 'summary', t: (key) => key })
  assert.equal(summary.type.name, 'KeysEntry')
})
