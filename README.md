# DSH 会话 MCP（mcp-dsh）

把 DeepSeek Harness 的会话能力以标准 **MCP（Streamable HTTP）** 暴露给本机外部客户端：Claude Code、Codex、Cursor、任意 MCP SDK。

- 端点：`http://127.0.0.1:<DSH Web 端口>/mcp-dsh`（默认 `3080`）
- 复用 DSH 自己的 Web 服务，不新起端口、不新起进程
- 会话操作走 `sessionController`——与 DSH Web UI 同一个入口
- 等待与恢复基于会话日志 `seq` 游标，断线/插件重载/DSH 重启后都能继续
- API Key 在插件自己的配置页里创建；服务端只保存 SHA-256 哈希，明文只显示一次

## 快速开始

1. 安装 bundle（本地目录），在 DSH 的插件管理里启用。
2. **首次启用（或从没有配置页的版本升级）后，完全退出并重新打开一次 DSH。** DSH 会缓存“这个包是否带 client 半屏”的判定；Host 侧的 MCP 端点在此之前已经可用，重启只是为了加载配置页。
3. 打开 **插件 → 本插件 → 配置页**，在 “API Keys” 里点 **创建 API Key**，输入名称。
4. 弹层会显示完整 Key（形如 `dshmcp_ab12cd34ef56_...`），并可以直接：
   - **复制 Key**：粘贴到 MCP 客户端的 `Authorization` 头；
   - **复制客户端配置**：得到一份已经填好 Key 的 JSON。
5. 关闭弹层后，列表只显示掩码，服务端无法再次取回明文。

首次加载会在 `%DSH_HOME%\mcp-dsh\` 下生成：

| 文件 | 用途 |
| --- | --- |
| `keys.json` | 只有 Key 的 SHA-256 哈希和元数据，**没有明文** |
| `client-config.json` | 不带密钥的客户端配置模板（`<PASTE_API_KEY_HERE>` 占位） |
| `mcp-dsh.log` | 挂载、鉴权拒绝、Key 创建/撤销的 JSONL 日志（不含明文） |

客户端配置模板：

```json
{
  "mcpServers": {
    "dsh-sessions": {
      "type": "http",
      "url": "http://127.0.0.1:3080/mcp-dsh",
      "headers": { "Authorization": "Bearer <PASTE_API_KEY_HERE>" }
    }
  }
}
```

Claude Code：

```sh
claude mcp add --transport http dsh-sessions http://127.0.0.1:3080/mcp-dsh \
  --header "Authorization: Bearer <你复制的 Key>"
```

## API Key 管理

配置页在 **默认插件管理面板 → 本插件页面**，由 `plugins.bundle.config` 挂载。

- 列表列：名称、Key ID、掩码 Key、创建时间、最近使用、撤销。
- 创建：名称必填；最多 20 个 active key（可配）。
- 展示：明文只在创建响应里出现一次，页面关闭后不可恢复。
- 撤销：立即生效；已建立的连接不受影响，下一次请求开始 401。
- 使用统计：每次鉴权成功更新 `lastUsedAt` / `useCount`，去抖写盘。
- 迁移：旧版本的 `token` 文件会在首次加载时被哈希成一条 “默认（迁移）” Key，然后删除明文文件；已经配置好的客户端不会失效。

管理页调用的是 Host 的内部接口 `/_mcp-dsh/admin/*`，它不是 MCP 端点，也不接受 MCP Key——只接受 DSH 浏览器页面会话。普通用户不需要直接访问它。

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_server_status` | 端点自检：版本、鉴权模式、Key 数、会话数 |
| `dsh_list_workspaces` | 工作区列表，新建会话的落点 |
| `dsh_list_presets` | 能力包（agent preset）列表 |
| `dsh_list_sessions` | 列出会话：标题、工作区、运行状态、最近活动 |
| `dsh_create_session` | 新建会话（`workspaceId` 或 `cwd` 至少给一个；`cwd` 不属于任何工作区时会自动注册一个，保证侧栏可见） |
| `dsh_get_session` | 单个会话状态：`idle` / `running` / `waiting_approval` / `waiting_input` / `completed` / `cancelled` / `failed` / `interrupted`，以及最近 turn、待审批、排队数 |
| `dsh_archive_session` | 归档会话，从侧栏移除（日志保留，UI 可恢复） |
| `dsh_session_send_message` | 发消息；`queue` 排队，`steer` 插话；崩溃后的半开 turn 会在发送时自动修复 |
| `dsh_session_interrupt_turn` | 停止当前 turn，保留已排队消息；没有活动 turn 时返回 `accepted:false` + `reason:"not-running"` |
| `dsh_session_wait` | 等待 turn 结束 / 会话空闲（长轮询，25s 默认，超时带 `timedOut:true` 和游标返回） |
| `dsh_session_read_messages` | 读取消息与工具调用摘要（有界输出） |

典型流程：

```text
list_workspaces / list_presets
  -> create_session
  -> session_send_message              (返回 cursor)
  -> session_wait(until:"idle", sinceSeq: cursor)
  -> session_read_messages(sinceSeq: cursor)
```

## 等待与状态

`dsh_session_wait` 是长轮询，不是“挂起直到完成”：

- 返回 `completed` / `cancelled` / `failed` / `interrupted`：本轮结束。
- 返回 `waiting_approval` / `waiting_input`：会话卡在审批或提问上，**去 DSH UI 处理**；MCP 不代答。
- 返回 `running` + `timedOut: true`：预算用完但还在跑；把返回的 `cursor` 作为下一次的 `sinceSeq` 继续等。
- 返回 `idle`：没有活动 turn，也没有排队消息。
- 冷会话 + 未闭合 turn（DSH 崩溃）：立即返回 `interrupted`，不会挂到超时；想继续就直接发消息，修复在内部发生。

断线重连后：

```text
get_session                              -> 拿 lastSeq / state
session_read_messages(sinceSeq: lastSeq) -> 补齐断线期间的消息
session_wait(sinceSeq: lastSeq)          -> 继续等或立即拿到终态
```

游标语义是**排他下界**（只返回 `seq > sinceSeq`），所以重复调用不会重复消费同一条消息。

## 配置

patch 里可直接改：

```yaml
- insert:
    - id: mcp-dsh
      name: '@local/mcp-dsh'
      config:
        path: /mcp-dsh
        auth: bearer          # none | bearer
        mode: full            # full | read-only
        defaultWaitMs: 25000
        maxWaitMs: 120000
        maxKeys: 20
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `path` | `/mcp-dsh` | 端点路径；与 `dsh-mcp-bridge` 的 `/mcp` 不冲突 |
| `auth` | `bearer` | `none` 仅建议在确认 loopback 时使用；监听非 loopback 时会被强制改回 `bearer` |
| `token` | 空 | 高级用法：写死一个固定主凭据（不进入 `keys.json`）；YAML 里是明文，通常不要用 |
| `mode` | `full` | `read-only` 只暴露查询类工具 |
| `defaultWaitMs` | 25000 | `dsh_session_wait` 默认预算 |
| `maxWaitMs` | 120000 | `dsh_session_wait` 上限 |
| `maxPromptChars` | 100000 | 单条消息上限 |
| `maxReadChars` | 120000 | `dsh_session_read_messages` 输出上限 |
| `maxKeys` | 20 | 最多 active API Key 数 |
| `allowSubagentSessions` | false | 是否允许对 subagent 会话发消息 |
| `audit` | true | 写 `%DSH_HOME%\mcp-dsh\mcp-dsh.log`（不记录消息正文或 Key） |

## 安全

- **Key 不落明文**：`keys.json` 只存 SHA-256 哈希；明文只在创建响应中出现一次，不进日志、不进列表。
- **撤销即时生效**：鉴权每请求一次，撤销后下一次请求即 401。
- **管理接口与 MCP 分离**：`/_mcp-dsh/admin/*` 只认 DSH 浏览器会话，不认 MCP Key；MCP Key 不能用来创建新 Key。
- 这个端点能**真实驱动会话**，会话里的工具会按该会话的 permission preset 执行；Key 请像密码一样保管。
- 不提供设置 sandbox、权限、模型、工具或审批的接口；外部调用方不能借 MCP 提权。
- 不代答审批与提问；`dsh_session_wait` 只报告 `waiting_approval` / `waiting_input`。
- 通过 MCP 发出的消息在 DSH 里显示为普通用户消息，与手动输入不可区分。
- 不加 CORS 头；请求体上限 1 MiB，消息与读取都有长度上限。
- 旧 `token` 文件迁移后会被删除；`%DSH_HOME%` 下的 `keys.json` 只含哈希，备份泄露也无法直接重放。

## 排障

| 现象 | 检查 |
| --- | --- |
| 401 | 客户端是否带了 `Authorization: Bearer <Key>`；Key 是否已在插件页被撤销 |
| 页面里的 Key 列表 401/403 | 必须从 DSH 插件页打开；直接访问 `/_mcp-dsh/admin/keys` 不会授权 |
| 404 | MCP 路径必须是 `/mcp-dsh` 或 `/mcp-dsh/` |
| `SESSION_NOT_FOUND` | 先 `dsh_list_sessions` 拿有效 id |
| `dsh_session_wait` 一直 `running` | 去 DSH UI 看是否卡在审批；`timedOut:true` 时带同一 cursor 继续等 |
| 工具没出现在客户端 | 客户端需支持 Streamable HTTP；先调 `tools/list` |
| 插件没起来 | 看 `%DSH_HOME%\mcp-dsh\mcp-dsh.log` 与插件行的诊断 |

## 开发

```powershell
node --test          # 52 个单元测试，不依赖 DSH
$env:DSH_MCP_KEY = '<在插件页创建的 Key>'
node scripts/smoke.mjs http://127.0.0.1:3080/mcp-dsh
node scripts/smoke.mjs http://127.0.0.1:3080/mcp-dsh --full
```

`--full` 会真的建一个会话、发一条“只回复 OK”的消息、等待、读取；会在 DSH 侧栏留下这个会话。

## 兼容性

- 已验证宿主：DSH `0.2.1-rc.3`（Windows desktop profile）
- MCP 协议：`2025-06-18` 握手、`2026-07-28` 无状态
- 依赖的 Host 服务：`webServer`、`sessionController`、`connection`；可选 `sessionQuery`、`workspaceRegistry`、`agentPresets`、`agents`
- 客户端页面依赖 `plugins.bundle.config` slot（`@deepseek-ai/dsh-client-ui-plugin-manager`）
- 传输层思路参考了同工作区的 `dsh-mcp-bridge`（MIT），本插件按会话域重写
