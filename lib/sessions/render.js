/**
 * Render a session log slice into bounded message and tool summaries.
 *
 * The newest content is kept. When older content is dropped, `truncated` and
 * `oldestSeq` tell the caller what is missing.
 */

const MAX_TOOL_CALLS = 100

export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function toolNameMap(events) {
  const names = new Map()
  for (const event of events) {
    if (event?.type === 'tool/call' && typeof event.data?.callId === 'string') {
      names.set(event.data.callId, event.data.name)
    }
  }
  return names
}

/**
 * @param {Array<object>} events
 * @param {{sinceSeq?: number, maxChars?: number, includeToolCalls?: boolean}} options
 */
export function renderMessages(events, options = {}) {
  const sinceSeq = Number.isFinite(options.sinceSeq) ? options.sinceSeq : -1
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0 ? options.maxChars : 60_000
  const includeToolCalls = options.includeToolCalls === true
  const names = toolNameMap(events)

  const messages = []
  const toolCalls = []

  for (const event of events) {
    if (typeof event?.seq === 'number' && event.seq <= sinceSeq) continue
    if (event?.type === 'user/message') {
      // DSH injects workspace instructions, runtime context, time context, and
      // the skill catalog as user-role messages. Only an authored user message
      // belongs in the conversation an external client reads.
      const kind = event.data?.source?.kind
      if (kind !== undefined && kind !== 'user') continue
      const text = textOfContent(event.data?.content)
      if (text) messages.push({ seq: event.seq, role: 'user', text, time: event.time })
    } else if (event?.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content)
      if (text) {
        messages.push({
          seq: event.seq,
          role: 'assistant',
          text,
          time: event.time,
          ...(event.data?.interrupted === true ? { interrupted: true } : {}),
        })
      }
    } else if (event?.type === 'tool/result' && includeToolCalls) {
      const message = event.data?.message
      const callId = message?.toolCallId ?? message?.source?.callId
      toolCalls.push({
        seq: event.seq,
        callId: typeof callId === 'string' ? callId : undefined,
        name: typeof callId === 'string' ? names.get(callId) ?? null : null,
        isError: message?.isError === true || event.data?.error !== undefined,
      })
    }
  }

  let cut = 0
  let total = messages.reduce((sum, message) => sum + message.text.length, 0)
  while (total > maxChars && cut < messages.length - 1) {
    total -= messages[cut].text.length
    cut += 1
  }
  let kept = messages.slice(cut)
  let textClipped = false
  if (kept.length === 1 && kept[0].text.length > maxChars) {
    kept = [{ ...kept[0], text: kept[0].text.slice(0, maxChars), complete: false }]
    textClipped = true
  }

  const toolCut = Math.max(0, toolCalls.length - MAX_TOOL_CALLS)
  const keptTools = toolCalls.slice(toolCut)

  return {
    messages: kept,
    ...(includeToolCalls ? { toolCalls: keptTools } : {}),
    truncated: cut > 0 || textClipped || toolCut > 0,
    ...(kept.length > 0 ? { oldestSeq: kept[0].seq } : {}),
    hasMore: cut > 0 || toolCut > 0,
  }
}
