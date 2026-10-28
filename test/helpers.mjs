/** Minimal Cordis-shaped context for unit tests: `on`, `get`, and event emit. */
export function fakeCtx({ services = {}, agents = new Map() } = {}) {
  const listeners = new Map()
  const ctx = {
    on(name, handler) {
      const set = listeners.get(name) ?? new Set()
      set.add(handler)
      listeners.set(name, set)
      return () => set.delete(handler)
    },
    get(name) {
      if (name === 'agents') return { get: (id) => agents.get(id) }
      return services[name]
    },
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args)
      return args
    },
  }
  return { ctx, agents }
}
