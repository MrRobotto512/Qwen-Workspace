'use strict';
// Agent tool definitions and display metadata: core and deferred tool specs, the
// per-conversation toolset, batching rules, and the text tool-call helpers.

const CORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and folders in a project folder (skips node_modules, .git and build output). Folders end with "/". Starts shallow; list a subfolder or raise depth to see more. Use this instead of run_command with dir or ls.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder relative to the project root. Defaults to ".".' },
          depth: { type: 'integer', description: 'How many folder levels to descend (1-6). Defaults to 2.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the project, optionally only a range of lines. Use this instead of run_command with type or cat. Several read_file calls in one reply run in parallel.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          start_line: { type: 'integer', description: '1-based first line (optional).' },
          end_line: { type: 'integer', description: '1-based last line, inclusive (optional).' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search all project files for text (case-insensitive) and return matching file:line entries. Use this to find where something is defined or used instead of reading files one by one.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regular expression to search for.' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression.' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file, or completely overwrite an existing one. Parent folders are created automatically. For changes to an existing file, use edit_file instead.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          content: { type: 'string', description: 'The complete new file content.' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace one exact snippet in an existing file. old_text must match the file exactly (including indentation) and appear exactly once; include a few surrounding lines to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root.' },
          old_text: { type: 'string', description: 'Exact existing text to replace.' },
          new_text: { type: 'string', description: 'Replacement text.' }
        },
        required: ['path', 'old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user what only they can answer (goals, target platform, constraints, what they have installed, choices between approaches) instead of guessing. Put all your questions in one call. Offer short options when there are obvious choices; the user can always type their own answer.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1 to 4 questions.',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers (up to 6).' }
              },
              required: ['question']
            }
          }
        },
        required: ['questions']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Use it to research SDKs, toolchains, file formats, APIs and error messages instead of relying on memory, which may be outdated. Returns titles, URLs and snippets; read the useful pages with fetch_url.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search terms, e.g. "libnx homebrew getting started".' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Read a web page (or a raw file, e.g. from GitHub) as text, with links kept as [text](url). Long pages come in parts; pass offset to continue. Prefer official documentation and project repositories.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' }, offset: { type: 'integer', description: 'Character offset to continue from, as given at the end of the previous part.' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Keep a short checklist for tasks with 3 or more steps, instead of listing the steps in your reply. Send the whole list every time. Mark one item in_progress while you work on it and mark items completed as soon as they are done. Skip it for simple one-step requests.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'What needs to be done, in a few words.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the project root and return its output (non-interactive). Use it to build, test, install packages or run scripts, instead of for reading or searching files. The default timeout is 2 minutes — for anything long (compiling a project, cloning a big repo, an installer) pass timeout_seconds, up to 3600. A command killed by the timeout says so at the end of its output; rerun it with a larger timeout_seconds instead of assuming it failed.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to run.' },
          timeout_seconds: { type: 'number', description: 'How long to let it run, 10–3600 (default 120). Use 1800+ for full builds.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'install_app',
      description: 'Install an application or tool with the system package manager: winget on Windows, Homebrew on macOS. Use this when the user asks to install an app, or a task needs one. On Windows pass the winget package id when you know it (e.g. "Google.Chrome", "Kitware.CMake"), otherwise a name to search for; on macOS pass the Homebrew formula or cask name (e.g. "cmake", "visual-studio-code") and set cask true for GUI apps. If several packages match, the result lists them so you can retry exactly. Needs the user\'s approval. For Git on Windows, prefer install_git, which works even without winget.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exact package id: a winget id on Windows, a Homebrew formula/cask name on macOS.' },
          name: { type: 'string', description: 'App name to search for when you do not know the id.' },
          cask: { type: 'boolean', description: 'macOS only: true for GUI applications (brew install --cask).' }
        },
        required: []
      }
    }
  }
];

const PROGRAM_TOOL = {
  type: 'function',
  function: {
    name: 'run_program',
    description: 'Run a short JavaScript program that batches many tool calls in one turn — sequence, branch, loop, Promise.all. The code is the body of an async function. Call tools as `await tools.read_file({ path: "src/a.js" })`; each returns the tool\'s result as a string, and a failed call rejects with the error text (try/catch to handle it). `console.log(...)` reports progress, `sleep(ms)` waits, and `return` a final summary. There is no network, file system, require or import — only the provided tools, which still follow the user\'s approval rules. Max 50 tool calls. Use it for mechanical multi-step work (collect TODOs from many files, apply the same change across files); work step by step yourself when each step needs judgment.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript statements forming an async function body.' } }, required: ['code'] }
  }
};
// Meta tools stay outside programs: they steer the conversation, not the project.
const PROGRAM_EXCLUDED = new Set(['run_program', 'consult_planner', 'tool_search', 'load_skill', 'ask_user', 'todo_write']);

const DEFERRED_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a text file from the project. The user can restore it from the Changes panel.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to the project root.' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a text file inside the project, instead of writing a copy and deleting the original.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string', description: 'Current path.' }, to: { type: 'string', description: 'New path; must not exist yet.' } },
        required: ['from', 'to']
      }
    }
  },
  PROGRAM_TOOL,
  {
    type: 'function',
    function: {
      name: 'install_git',
      description: 'Windows only: install Git by downloading a portable Git into the app\'s own folder (no winget, no admin rights). Use this when Git is missing and a git command is needed. On macOS tell the user to run xcode-select --install instead.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
];

const LOAD_SKILL_TOOL = {
  type: 'function',
  function: {
    name: 'load_skill',
    description: 'Load the full instructions of a skill listed in <skills>, or one of its supporting files. Do this before starting a task the skill covers.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name as listed.' },
        file: { type: 'string', description: 'Optional supporting file inside the skill, as listed after loading it.' }
      },
      required: ['name']
    }
  }
};

const TOOL_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'tool_search',
    description: 'Load tools listed in <deferred_tools> so you can call them. Search by name or purpose. This searches the app\'s own tool catalog only — to find software, documentation or facts, use web_search instead.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you need to do, or a tool name.' } }, required: ['query'] }
  }
};

const ALL_TOOLS = [...CORE_TOOLS, ...DEFERRED_TOOLS, LOAD_SKILL_TOOL, TOOL_SEARCH_TOOL];

// MCP tools are deferred too: their servers can expose many of them, so only their names go in
// the prompt and tool_search loads the ones a task needs. state.mcp holds the live list.
function mcpToolSpecs() {
  const out = [];
  for (const srv of state.mcp || []) {
    if (srv.status !== 'ready') continue;
    for (const t of srv.tools || []) {
      out.push({ type: 'function', function: { name: t.name, description: `[${srv.id}] ${t.description || t.rawName}`, parameters: t.parameters || { type: 'object', properties: {} } } });
    }
  }
  return out;
}

// Every deferred tool, built-in and MCP, for tool_search and text-call parsing.
function deferredCatalog() {
  return [...DEFERRED_TOOLS, ...mcpToolSpecs()];
}

// The tool list for one request. It only changes when skills appear or tool_search loads a
// deferred tool, because Qwen's template puts the tools inside the cached system prompt.
const WEB_TOOLS = new Set(['web_search', 'fetch_url']);

const SEM_TOOL = {
  type: 'function',
  function: {
    name: 'semantic_search',
    description: 'Search the project\'s semantic code index: returns the most relevant functions/classes for a concept, plus related files from the import graph. Better than search_code for "where is X handled?" questions; use search_code for exact strings.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'The concept to find, e.g. "where are commands approved before running".' } }, required: ['query'] }
  }
};

const CONSULT_TOOL = {
  type: 'function',
  function: {
    name: 'consult_planner',
    description: 'Ask the stronger "planner" model for help with a hard sub-problem: a design decision, a tricky bug, a review, or a plan. Include all the context it needs in your question (paste the relevant code and error). Use it sparingly for the hard parts; do the ordinary work yourself.',
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'The question, with enough context to answer it standalone.' } }, required: ['question'] }
  }
};

function toolsFor(c) {
  const active = new Set(c.activeTools || []);
  const core = state.settings.webResearch === false ? CORE_TOOLS.filter((t) => !WEB_TOOLS.has(t.function.name)) : CORE_TOOLS;
  const deferred = deferredCatalog();
  const tools = [...core, ...deferred.filter((t) => active.has(t.function.name))];
  if (c.skills?.length) tools.push(LOAD_SKILL_TOOL);
  if (state.semReady) tools.push(SEM_TOOL);
  if (heavyOverride()) tools.push(CONSULT_TOOL);
  if ((heavyOverride() || conversationOverride(c)) && !tools.some((t) => t.function.name === 'run_program')) tools.push(PROGRAM_TOOL);
  if (deferred.some((t) => !active.has(t.function.name))) tools.push(TOOL_SEARCH_TOOL);
  return tools;
}

// Tools that only read can run together; anything that changes files or runs commands is a
// barrier that runs alone, in the order Qwen asked.
const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'search_code', 'semantic_search', 'load_skill', 'tool_search', 'web_search', 'fetch_url', 'consult_planner']);
const WEB_PAGE_CHARS = 12_000;
const READ_PAGE = 400;

// A stable signature for a tool call, used to spot the model repeating the exact same call.
function callSignature(call) {
  let args = call.function.arguments || '';
  try {
    args = JSON.stringify(sortedKeys(JSON.parse(args)));
  } catch {
    /* use raw */
  }
  return `${call.function.name}(${args})`;
}
function sortedKeys(v) {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])]));
  return v;
}

function toolBatches(calls) {
  const batches = [];
  for (const call of calls) {
    const last = batches[batches.length - 1];
    if (READ_ONLY_TOOLS.has(call.function.name) && last && READ_ONLY_TOOLS.has(last[0].function.name)) last.push(call);
    else batches.push([call]);
  }
  return batches;
}

const TOOL_INFO = {
  list_files: { icon: 'list', verb: 'List', doing: 'Listing' },
  read_file: { icon: 'eye', verb: 'Read', doing: 'Reading' },
  search_code: { icon: 'search', verb: 'Search', doing: 'Searching for' },
  write_file: { icon: 'filePlus', verb: 'Write', doing: 'Writing' },
  edit_file: { icon: 'pencil', verb: 'Edit', doing: 'Editing' },
  run_command: { icon: 'terminal', verb: 'Run', doing: 'Running' },
  install_app: { icon: 'download', verb: 'Install', doing: 'Installing' },
  run_program: { icon: 'zap', verb: 'Program', doing: 'Running a program with' },
  semantic_search: { icon: 'crosshair', verb: 'Semantic', doing: 'Searching the code index for' },
  install_git: { icon: 'download', verb: 'Install', doing: 'Installing Git' },
  todo_write: { icon: 'list', verb: 'Plan', doing: 'Updating the plan' },
  ask_user: { icon: 'chat', verb: 'Question', doing: 'Waiting for your answer to' },
  web_search: { icon: 'search', verb: 'Web search', doing: 'Searching the web for' },
  fetch_url: { icon: 'external', verb: 'Read page', doing: 'Reading' },
  delete_file: { icon: 'trash', verb: 'Delete', doing: 'Deleting' },
  move_file: { icon: 'external', verb: 'Move', doing: 'Moving' },
  load_skill: { icon: 'book', verb: 'Skill', doing: 'Loading skill' },
  consult_planner: { icon: 'sparkles', verb: 'Consult', doing: 'Asking the planner about' },
  tool_search: { icon: 'search', verb: 'Find tools', doing: 'Looking up tools for' }
};

// Context is assembled in layers, from least to most likely to change, so Ollama can reuse its
// KV cache: the system prompt stays byte-identical for the whole conversation (identity, rules,
// environment, project memory), and editor state that changes between turns goes into a
// <system-reminder> on the newest message only, which is never stored in the history.

function mcpServerOf(name) {
  return (/^mcp__([a-z0-9_]+)__/.exec(name) || [])[1] || 'mcp';
}
function mcpToolShort(name) {
  return name.replace(/^mcp__[a-z0-9_]+__/, '');
}

function describeCall(name, args) {
  if (name.startsWith('mcp__')) {
    const a = args.path || args.url || args.query || args.file || args.command || '';
    return { target: `${mcpToolShort(name)}${a ? ` · ${String(a).slice(0, 60)}` : ''}`, title: `${name} ${JSON.stringify(args).slice(0, 200)}` };
  }
  switch (name) {
    case 'list_files': {
      const p = normPath(args.path || '.');
      return { target: p === '.' ? 'project root' : `${p}/` };
    }
    case 'read_file': {
      const p = normPath(args.path);
      const range = args.start_line || args.end_line ? ` · lines ${args.start_line || 1}–${args.end_line || 'end'}` : '';
      return { target: baseName(p) + range, path: p, title: p };
    }
    case 'search_code':
      return { target: `“${args.query || ''}”` };
    case 'write_file':
    case 'edit_file': {
      const p = normPath(args.path);
      return { target: baseName(p), path: p, title: p };
    }
    case 'run_command':
      return { target: args.command || '', mono: true, title: args.command };
    case 'delete_file': {
      const p = normPath(args.path);
      return { target: baseName(p), title: p };
    }
    case 'move_file':
      return { target: `${baseName(normPath(args.from))} → ${normPath(args.to)}`, title: `${args.from} → ${args.to}` };
    case 'load_skill':
      return { target: `${args.name || ''}${args.file ? ` · ${args.file}` : ''}` };
    case 'install_app':
      return { target: args.id || args.name || 'app' };
    case 'run_program': {
      const lines = String(args.code || '').split('\n').length;
      return { target: `${lines} line${lines === 1 ? '' : 's'}`, title: String(args.code || '').slice(0, 400) };
    }
    case 'install_git':
      return { target: 'Git' };
    case 'consult_planner':
      return { target: `${heavyLabel()}: ${String(args.question || '').slice(0, 60)}`, title: args.question };
    case 'semantic_search':
    case 'tool_search':
    case 'web_search':
      return { target: `“${args.query || ''}”` };
    case 'fetch_url': {
      let host = String(args.url || '');
      try {
        const u = new URL(host);
        host = `${u.hostname}${u.pathname.length > 1 ? u.pathname : ''}`;
      } catch {
        /* show as given */
      }
      return { target: host, title: args.url };
    }
    case 'ask_user': {
      const qs = Array.isArray(args.questions) ? args.questions : [args];
      return { target: qs.length > 1 ? `${qs.length} questions` : String(qs[0]?.question || '') };
    }
    case 'todo_write': {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      const current = todos.find((t) => t.status === 'in_progress');
      return { target: current ? current.content : `${todos.filter((t) => t.status === 'completed').length}/${todos.length} done` };
    }
    default:
      return { target: '' };
  }
}

// ---------- approvals ----------

function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/').trim();
  if (state.ws) {
    const root = state.ws.root.replace(/\\/g, '/');
    if (s.toLowerCase().startsWith(root.toLowerCase() + '/')) s = s.slice(root.length + 1);
  }
  return s.replace(/^\.\//, '').replace(/^\/+/, '') || '.';
}

function truncate(s) {
  return s.length > MAX_TOOL_RESULT ? s.slice(0, MAX_TOOL_RESULT) + `\n... [truncated ${s.length - MAX_TOOL_RESULT} chars]` : s;
}

// Thin wrappers over the pure parser in toolparse.js, passing the current tool names (built-in
// plus any connected MCP tools).
function allToolNames() {
  return [...ALL_TOOLS, ...mcpToolSpecs()].map((t) => t.function.name);
}
function textToolCallStart(content) {
  return ToolParse.textToolCallStart(content, allToolNames());
}
function extractTextToolCalls(content) {
  return ToolParse.extractTextToolCalls(content, allToolNames());
}
