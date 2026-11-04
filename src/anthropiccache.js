'use strict';

// Anthropic prompt caching. Every request re-sends the system prompt, the tool definitions
// and the conversation so far; marking them cacheable makes Claude bill a repeat of that prefix
// at about a tenth of the input price (a write costs 1.25×, once). Up to four breakpoints are
// allowed: the system prompt, the last tool, and the newest message — so the next request
// (the same prefix plus a few new turns) reads everything before its own newest message from
// the cache. Prefixes shorter than the model's minimum (about 1,024 tokens) are simply not
// cached; nothing fails. Pure: works on the Messages API request body.

const EPHEMERAL = { type: 'ephemeral' };

function markLast(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content, cache_control: EPHEMERAL }] : content;
  if (!Array.isArray(content) || !content.length) return content;
  const out = content.slice();
  out[out.length - 1] = { ...out[out.length - 1], cache_control: EPHEMERAL };
  return out;
}

function addCacheBreakpoints(body) {
  const b = { ...body };
  if (typeof b.system === 'string' && b.system) b.system = [{ type: 'text', text: b.system, cache_control: EPHEMERAL }];
  if (Array.isArray(b.tools) && b.tools.length) {
    b.tools = b.tools.slice();
    b.tools[b.tools.length - 1] = { ...b.tools[b.tools.length - 1], cache_control: EPHEMERAL };
  }
  if (Array.isArray(b.messages) && b.messages.length) {
    b.messages = b.messages.slice();
    const i = b.messages.length - 1;
    b.messages[i] = { ...b.messages[i], content: markLast(b.messages[i].content) };
  }
  return b;
}

// Input tokens as billed: uncached at full price, cache writes at 1.25×, cache reads at 0.1×,
// so the cost meter (priced per input token) stays right with caching on.
function billedInput(u) {
  const plain = Number(u?.input_tokens) || 0;
  const write = Number(u?.cache_creation_input_tokens) || 0;
  const read = Number(u?.cache_read_input_tokens) || 0;
  return Math.round(plain + write * 1.25 + read * 0.1);
}

module.exports = { addCacheBreakpoints, billedInput };
