/**
 * mcp-dsh — browser half.
 *
 * Renders the API-key manager inside the plugin's own page in the default
 * Plugin Manager (`plugins.bundle.config`). The page never holds key digests:
 * it calls the Host's internal admin API, which is guarded by the DSH browser
 * session.
 */

window.__ModuleLoader__.load({
  id: '@local/mcp-dsh',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 'mcpDsh'
    /** Internal admin API; fixed so the page does not depend on the MCP path. */
    const ADMIN = '/_mcp-dsh/admin'
    const STYLE_ATTR = 'data-mcp-dsh-style'

    const zh = {
      title: 'API Keys',
      intro: '外部 MCP 客户端用这里的 Key 访问 DSH 会话桥。Key 只在创建时显示一次，服务端只保存哈希。',
      summary: 'Bearer 鉴权 · 在插件页管理 API Key',
      endpoint: 'MCP 端点',
      create: '创建 API Key',
      name: '名称',
      'name.placeholder': '例如：Claude Code',
      cancel: '取消',
      confirm: '创建',
      creating: '正在创建…',
      loading: '正在读取 API Key…',
      empty: '还没有 API Key',
      'empty.hint': '创建一个 Key，粘贴到 MCP 客户端的 Authorization 头。',
      'col.name': '名称',
      'col.id': 'Key ID',
      'col.key': 'Key',
      'col.created': '创建时间',
      'col.lastUsed': '最近使用',
      'col.actions': '操作',
      revoke: '撤销',
      'revoke.confirm': '撤销「{name}」？使用这个 Key 的客户端会立刻失去访问权限。',
      'revoked.notice': '已撤销「{name}」',
      never: '从未使用',
      uses: '{count} 次调用',
      'once.title': 'API Key 已创建',
      'once.warning': '只显示这一次。关闭后服务端只保留哈希，无法再次查看。',
      'copy.key': '复制 Key',
      'copy.config': '复制客户端配置',
      'copy': '复制',
      copied: '已复制',
      done: '完成',
      'once.hint': '也可以从 README 复制客户端配置模板，把 Key 填进去。',
      'copy.failed': '复制失败，请手动选择文本。',
      'error.auth': '管理接口要求 DSH 页面会话。请从插件页打开；直接访问接口不会授权。',
      'error.load': '读取 API Key 失败：{message}',
      'error.create': '创建失败：{message}',
      'error.revoke': '撤销失败：{message}',
      footer: '服务端只保存 SHA-256 哈希；请像密码一样保管 Key。',
      'auth.none': '当前插件配置为 auth: none，MCP 端点不校验 Key。改成 bearer 后这里的 Key 才会生效。',
      'limit.reached': '已达到 Key 数量上限（{max} 个）。',
    }

    const en = {
      title: 'API Keys',
      intro: 'External MCP clients use these keys for the DSH session bridge. A key is shown once at creation; the server stores only its hash.',
      summary: 'Bearer auth · manage API keys on the plugin page',
      endpoint: 'MCP endpoint',
      create: 'Create API key',
      name: 'Name',
      'name.placeholder': 'e.g. Claude Code',
      cancel: 'Cancel',
      confirm: 'Create',
      creating: 'Creating…',
      loading: 'Reading API keys…',
      empty: 'No API key yet',
      'empty.hint': 'Create one and paste it into the MCP client Authorization header.',
      'col.name': 'Name',
      'col.id': 'Key ID',
      'col.key': 'Key',
      'col.created': 'Created',
      'col.lastUsed': 'Last used',
      'col.actions': 'Actions',
      revoke: 'Revoke',
      'revoke.confirm': 'Revoke “{name}”? Clients using this key lose access immediately.',
      'revoked.notice': 'Revoked “{name}”',
      never: 'Never',
      uses: '{count} calls',
      'once.title': 'API key created',
      'once.warning': 'This is the only time the key is shown. After closing, only its hash remains on the server.',
      'copy.key': 'Copy key',
      'copy.config': 'Copy client config',
      'copy': 'Copy',
      copied: 'Copied',
      done: 'Done',
      'once.hint': 'You can also copy the client config template from the README and fill in the key.',
      'copy.failed': 'Copy failed; select the text manually.',
      'error.auth': 'The admin API requires the DSH page session. Open it from the plugin page; direct requests are rejected.',
      'error.load': 'Could not read API keys: {message}',
      'error.create': 'Could not create the key: {message}',
      'error.revoke': 'Could not revoke the key: {message}',
      footer: 'The server stores only a SHA-256 hash; treat the key like a password.',
      'auth.none': 'This plugin is configured with auth: none, so the MCP endpoint does not check keys. Keys take effect after switching back to bearer.',
      'limit.reached': 'The key limit is reached ({max}).',
    }

    const CSS = `
[data-mcp-dsh-page]{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;padding:4px 0 8px}
[data-mcp-dsh-page] *{box-sizing:border-box}
.md-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.md-title{margin:0;font-size:16px;font-weight:600;line-height:24px}
.md-intro{margin:4px 0 0;max-width:640px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.md-primary{height:32px;padding:0 14px;border:1px solid transparent;border-radius:7px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.md-primary:hover:not(:disabled){opacity:.85}
.md-primary:active:not(:disabled){opacity:.75}
.md-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.md-primary:disabled{opacity:.4;cursor:default}
.md-ghost{height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;white-space:nowrap}
.md-ghost:hover{background:var(--dsw-alias-bg-layer-2)}
.md-endpoint{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.md-endpoint-label{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}
.md-endpoint-url{flex:1;min-width:220px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.md-create{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.md-create-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.md-input{flex:1;min-width:200px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}
.md-input:focus{border-color:var(--dsw-alias-brand-primary)}
.md-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.md-table{width:100%;border-collapse:collapse;font-size:13px;min-width:720px}
.md-table th{text-align:left;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;white-space:nowrap}
.md-table td{padding:11px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
.md-table tr:last-child td{border-bottom:0}
.md-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.md-name{font-weight:500}
.md-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;vertical-align:1px}
.md-danger{border:0;background:transparent;color:var(--dsw-alias-state-error-primary);font-size:12px;cursor:pointer;padding:0}
.md-danger:disabled{opacity:.5;cursor:default}
.md-empty{padding:28px 20px;text-align:center;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.md-empty p{margin:0}
.md-empty p+p{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px}
.md-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px}
.md-notice{margin:0;padding:8px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px}
.md-notice[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.md-notice[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.md-notice[data-kind=warn]{color:var(--dsw-alias-state-warn-primary)}
.md-muted{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px}
.md-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.md-summary{color:var(--dsw-alias-label-secondary);font-size:12px}
.md-overlay{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.46)}
.md-modal{width:min(640px,100%);max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:12px;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 20px 60px rgba(0,0,0,.4)}
.md-modal h3{margin:0;font-size:15px;font-weight:600;line-height:22px}
.md-key{margin:0;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:18px;word-break:break-all;white-space:pre-wrap;user-select:all}
.md-warn{margin:0;color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px}
.md-modal-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
`

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function request(url, options = {}) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: { accept: 'application/json', ...(options.headers ?? {}) },
      })
      const text = await response.text()
      let body = {}
      if (text.length > 0) {
        try {
          body = JSON.parse(text)
        } catch {
          body = { message: text.slice(0, 200) }
        }
      }
      if (!response.ok) {
        const error = new Error(body?.error?.message ?? body?.message ?? `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return body
    }

    function formatTime(value, fallback) {
      if (typeof value !== 'number' || value <= 0) return fallback
      try {
        return new Date(value).toLocaleString()
      } catch {
        return fallback
      }
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall through to the selection-based path.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    function configSnippet(endpoint, key) {
      return JSON.stringify({
        mcpServers: {
          'dsh-sessions': {
            type: 'http',
            url: endpoint,
            headers: { Authorization: `Bearer ${key}` },
          },
        },
      }, null, 2)
    }

    function Summary({ t }) {
      return h('span', { className: 'md-summary' }, t('summary'))
    }

    function KeysPage({ t }) {
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState(null)
      const [creating, setCreating] = useState(false)
      const [name, setName] = useState('')
      const [busy, setBusy] = useState(false)
      const [revoking, setRevoking] = useState(null)
      const [created, setCreated] = useState(null)
      const [copied, setCopied] = useState('')

      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          setData(await request(`${ADMIN}/keys`))
        } catch (failure) {
          setError(failure.status === 401 || failure.status === 403
            ? t('error.auth')
            : t('error.load', { message: messageOf(failure) }))
        } finally {
          setLoading(false)
        }
      }, [t])

      useEffect(() => {
        void load()
      }, [load])

      async function submitCreate(event) {
        event.preventDefault()
        const label = name.trim()
        if (label.length === 0 || busy) return
        setBusy(true)
        setNotice(null)
        try {
          const result = await request(`${ADMIN}/keys`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: label }),
          })
          setCreated(result)
          setCreating(false)
          setName('')
          await load()
        } catch (failure) {
          setNotice({ kind: 'error', text: t('error.create', { message: messageOf(failure) }) })
        } finally {
          setBusy(false)
        }
      }

      async function revoke(record) {
        const confirmed = typeof window.confirm !== 'function'
          || window.confirm(t('revoke.confirm', { name: record.name }))
        if (!confirmed) return
        setRevoking(record.id)
        setNotice(null)
        try {
          await request(`${ADMIN}/keys/revoke`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: record.id }),
          })
          setNotice({ kind: 'ok', text: t('revoked.notice', { name: record.name }) })
          await load()
        } catch (failure) {
          setNotice({ kind: 'error', text: t('error.revoke', { message: messageOf(failure) }) })
        } finally {
          setRevoking(null)
        }
      }

      async function copy(label, text) {
        const ok = await copyText(text)
        if (ok) {
          setCopied(label)
          window.setTimeout(() => setCopied(''), 2000)
        } else {
          setNotice({ kind: 'error', text: t('copy.failed') })
        }
      }

      const endpoint = data?.endpoint ?? `${window.location.origin}/mcp-dsh`
      const keys = Array.isArray(data?.keys) ? data.keys : []
      const atLimit = typeof data?.maxKeys === 'number' && keys.length >= data.maxKeys
      const createdKey = created?.key

      return h('section', { 'data-mcp-dsh-page': true },
        h('header', { className: 'md-head' },
          h('div', null,
            h('h2', { className: 'md-title' }, t('title')),
            h('p', { className: 'md-intro' }, t('intro')),
          ),
          h('button', {
            type: 'button',
            className: 'md-primary',
            disabled: creating || busy || atLimit,
            title: atLimit ? t('limit.reached', { max: data.maxKeys }) : undefined,
            onClick: () => {
              setCreating(true)
              setNotice(null)
            },
          }, t('create')),
        ),

        data?.auth === 'none' ? h('p', { className: 'md-notice', 'data-kind': 'warn' }, t('auth.none')) : null,
        notice === null ? null : h('p', { className: 'md-notice', 'data-kind': notice.kind }, notice.text),
        error ? h('p', { className: 'md-error', role: 'alert' }, error) : null,

        creating ? h('form', { className: 'md-create', onSubmit: submitCreate },
          h('div', { className: 'md-create-row' },
            h('input', {
              className: 'md-input',
              value: name,
              maxLength: 64,
              autoFocus: true,
              placeholder: t('name.placeholder'),
              'aria-label': t('name'),
              onChange: (event) => setName(event.target.value),
            }),
            h('button', { type: 'submit', className: 'md-primary', disabled: busy || name.trim().length === 0 },
              busy ? t('creating') : t('confirm')),
            h('button', {
              type: 'button',
              className: 'md-ghost',
              disabled: busy,
              onClick: () => {
                setCreating(false)
                setName('')
              },
            }, t('cancel')),
          ),
        ) : null,

        loading && data === null ? h('p', { className: 'md-muted' }, t('loading')) : null,

        data !== null && keys.length === 0
          ? h('div', { className: 'md-empty' },
              h('p', null, t('empty')),
              h('p', null, t('empty.hint')),
            )
          : null,

        data !== null && keys.length > 0
          ? h('div', { className: 'md-table-wrap' },
              h('table', { className: 'md-table' },
                h('thead', null,
                  h('tr', null,
                    h('th', null, t('col.name')),
                    h('th', null, t('col.id')),
                    h('th', null, t('col.key')),
                    h('th', null, t('col.created')),
                    h('th', null, t('col.lastUsed')),
                    h('th', { 'aria-label': t('col.actions') }),
                  ),
                ),
                h('tbody', null, keys.map((record) => h('tr', { key: record.id },
                  h('td', { className: 'md-name' },
                    record.name,
                    record.migrated ? h('span', { className: 'md-tag' }, 'migrated') : null,
                  ),
                  h('td', { className: 'md-mono' }, record.id),
                  h('td', { className: 'md-mono' }, record.masked),
                  h('td', null, formatTime(record.createdAt, '—')),
                  h('td', null,
                    formatTime(record.lastUsedAt, t('never')),
                    record.useCount > 0 ? h('span', { className: 'md-summary' }, ` · ${t('uses', { count: record.useCount })}`) : null,
                  ),
                  h('td', null,
                    h('button', {
                      type: 'button',
                      className: 'md-danger',
                      disabled: revoking === record.id,
                      onClick: () => revoke(record),
                    }, t('revoke')),
                  ),
                ))),
              ),
            )
          : null,

        h('div', { className: 'md-endpoint' },
          h('span', { className: 'md-endpoint-label' }, t('endpoint')),
          h('code', { className: 'md-endpoint-url' }, endpoint),
          h('button', {
            type: 'button',
            className: 'md-ghost',
            onClick: () => copy('endpoint', endpoint),
          }, copied === 'endpoint' ? t('copied') : t('copy')),
        ),

        h('p', { className: 'md-hint' }, t('footer')),

        createdKey === undefined ? null : h('div', { className: 'md-overlay' },
          h('div', {
            className: 'md-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('once.title'),
          },
            h('h3', null, t('once.title')),
            h('p', { className: 'md-warn' }, t('once.warning')),
            h('pre', { className: 'md-key' }, createdKey),
            h('div', { className: 'md-modal-actions' },
              h('button', {
                type: 'button',
                className: 'md-ghost',
                onClick: () => copy('key', createdKey),
              }, copied === 'key' ? t('copied') : t('copy.key')),
              h('button', {
                type: 'button',
                className: 'md-ghost',
                onClick: () => copy('config', configSnippet(endpoint, createdKey)),
              }, copied === 'config' ? t('copied') : t('copy.config')),
              h('button', {
                type: 'button',
                className: 'md-primary',
                onClick: () => {
                  setCreated(null)
                  setCopied('')
                },
              }, t('done')),
            ),
            h('p', { className: 'md-hint' }, t('once.hint')),
          ),
        ),
      )
    }

    const KeysEntry = (props) => {
      const view = props?.view === 'summary' ? Summary : KeysPage
      const translate = typeof props?.t === 'function' ? props.t : (key) => key
      return h(view, { t: translate })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-dsh: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const existing = document.querySelector(`style[${STYLE_ATTR}]`)
          if (existing) existing.remove()
          const tag = document.createElement('style')
          tag.setAttribute(STYLE_ATTR, 'true')
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'mcp-dsh: styles')

        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: '@local/mcp-dsh', locale: NS },
            (props) => h(KeysEntry, { ...props, t }),
          ),
        )

        // One diagnostic line per page load. A 401 here means the browser half
        // loaded but the admin session check did not recognize the page.
        try {
          void fetch(`${ADMIN}/client-loaded`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: '@local/mcp-dsh', at: Date.now() }),
          }).catch(() => {})
        } catch {
          // Diagnostics never affect the page.
        }
      },
    }
  },
})
