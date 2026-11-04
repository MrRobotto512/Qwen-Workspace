const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  setWorkspace: (dir) => ipcRenderer.invoke('workspace:set', dir),

  list: (rel) => ipcRenderer.invoke('fs:list', rel),
  listRecursive: (rel, limit, maxDepth) => ipcRenderer.invoke('fs:listRecursive', rel, limit, maxDepth),
  read: (rel) => ipcRenderer.invoke('fs:read', rel),
  exists: (rel) => ipcRenderer.invoke('fs:exists', rel),
  write: (rel, content) => ipcRenderer.invoke('fs:write', rel, content),
  mkdir: (rel) => ipcRenderer.invoke('fs:mkdir', rel),
  remove: (rel, opts) => ipcRenderer.invoke('fs:delete', rel, opts),
  search: (query, opts) => ipcRenderer.invoke('fs:search', query, opts),
  reveal: (rel) => ipcRenderer.invoke('shell:reveal', rel),

  runCommand: (command, timeoutMs, owner) => ipcRenderer.invoke('cmd:run', command, timeoutMs, owner),
  syntaxCheck: (rel, before) => ipcRenderer.invoke('syntax:check', rel, before),
  saveOutput: (label, text) => ipcRenderer.invoke('output:save', label, text),
  restoreSecrets: (text) => ipcRenderer.invoke('secrets:restore', text),
  backgroundList: () => ipcRenderer.invoke('cmd:background'),
  stopBackground: (id) => ipcRenderer.invoke('cmd:stopBackground', id),
  onBackground: (fn) => {
    const h = (_e, list) => fn(list);
    ipcRenderer.on('cmd:background', h);
    return () => ipcRenderer.removeListener('cmd:background', h);
  },
  guiTest: (opts) => ipcRenderer.invoke('gui:test', opts),
  guiTestPage: (opts) => ipcRenderer.invoke('gui:testPage', opts),
  guiSelfTest: (opts) => ipcRenderer.invoke('gui:selfTest', opts),
  readImage: (rel) => ipcRenderer.invoke('fs:readImage', rel),
  onCommandOutput: (cb) => {
    const fn = (_e, text) => cb(text);
    ipcRenderer.on('cmd:output', fn);
    return () => ipcRenderer.removeListener('cmd:output', fn);
  },

  appInfo: () => ipcRenderer.invoke('app:info'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('update:progress', fn);
    return () => ipcRenderer.removeListener('update:progress', fn);
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  systemSpecs: (force) => ipcRenderer.invoke('system:specs', force),
  nodesCheck: (nodes) => ipcRenderer.invoke('nodes:check', nodes),
  ollamaFitInfo: (baseUrl, model) => ipcRenderer.invoke('ollama:fitinfo', baseUrl, model),
  ollamaPs: (baseUrl) => ipcRenderer.invoke('ollama:ps', baseUrl),
  modelProbe: (baseUrl, model) => ipcRenderer.invoke('model:probe', baseUrl, model),
  nodesDiagnose: (baseUrl) => ipcRenderer.invoke('nodes:diagnose', baseUrl),
  ollamaTags: () => ipcRenderer.invoke('ollama:tags'),
  ollamaPull: (model) => ipcRenderer.invoke('ollama:pull', model),
  ollamaPullCancel: (model) => ipcRenderer.invoke('ollama:pull-cancel', model),
  ollamaShow: (model) => ipcRenderer.invoke('ollama:show', model),
  hfResolve: (repo) => ipcRenderer.invoke('hf:resolve', repo),
  onPullProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('ollama:pull-progress', fn);
    return () => ipcRenderer.removeListener('ollama:pull-progress', fn);
  },

  mcpList: () => ipcRenderer.invoke('mcp:list'),
  checkApi: (names, language) => ipcRenderer.invoke('api:check', names, language),
  gimpSetup: () => ipcRenderer.invoke('gimp:setup'),
  benchPrepare: (runId, taskId) => ipcRenderer.invoke('bench:prepare', runId, taskId),
  benchSave: (run) => ipcRenderer.invoke('bench:save', run),
  benchLast: () => ipcRenderer.invoke('bench:last'),
  benchHas: (tool) => ipcRenderer.invoke('bench:has', tool),
  craftSetup: () => ipcRenderer.invoke('craft:setup'),
  browserSetup: (opts) => ipcRenderer.invoke('browser:setup', opts),
  mcpReconnect: () => ipcRenderer.invoke('mcp:reconnect'),
  mcpConnectOne: (cfg) => ipcRenderer.invoke('mcp:connectOne', cfg),
  mcpDisconnect: (id) => ipcRenderer.invoke('mcp:disconnect', id),
  mcpCall: (name, args, timeout) => ipcRenderer.invoke('mcp:call', name, args, timeout),
  onMcpChanged: (cb) => {
    const fn = (_e, list) => cb(list);
    ipcRenderer.on('mcp:changed', fn);
    return () => ipcRenderer.removeListener('mcp:changed', fn);
  },

  semStatus: () => ipcRenderer.invoke('sem:status'),
  semIndex: () => ipcRenderer.invoke('sem:index'),
  semSearch: (query, k) => ipcRenderer.invoke('sem:search', query, k),
  onSemProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('sem:progress', fn);
    return () => ipcRenderer.removeListener('sem:progress', fn);
  },

  webSearch: (query) => ipcRenderer.invoke('web:search', query),
  webFetch: (url) => ipcRenderer.invoke('web:fetch', url),

  templatesList: () => ipcRenderer.invoke('templates:list'),
  templatesInstall: (id) => ipcRenderer.invoke('templates:install', id),

  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsRead: (id, file) => ipcRenderer.invoke('skills:read', id, file),
  skillsInstall: (url, opts) => ipcRenderer.invoke('skills:install', url, opts),
  skillsCreate: (draft) => ipcRenderer.invoke('skills:create', draft),
  skillsUsed: (id) => ipcRenderer.invoke('skills:used', id),
  skillsCurate: (opts) => ipcRenderer.invoke('skills:curate', opts),
  skillsArchived: () => ipcRenderer.invoke('skills:archived'),
  skillsArchive: (name) => ipcRenderer.invoke('skills:archive', name),
  skillsRestore: (name) => ipcRenderer.invoke('skills:restore', name),

  programRun: (runId, code, names, timeoutMs) => ipcRenderer.invoke('program:run', runId, code, names, timeoutMs),
  programAnswer: (callId, result, failed) => ipcRenderer.invoke('program:answer', callId, result, failed),
  onProgramCall: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('program:call', fn);
    return () => ipcRenderer.removeListener('program:call', fn);
  },

  gitCommit: (message) => ipcRenderer.invoke('git:commit', message),
  gitInit: () => ipcRenderer.invoke('git:init'),
  gitClone: (url) => ipcRenderer.invoke('git:clone', url),
  gitEnsure: () => ipcRenderer.invoke('git:ensure'),
  gitInstall: () => ipcRenderer.invoke('git:install'),
  onGitInstallProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('git:install-progress', fn);
    return () => ipcRenderer.removeListener('git:install-progress', fn);
  },

  remoteState: () => ipcRenderer.invoke('remote:state'),
  remoteCall: (device, path, method, body) => ipcRenderer.invoke('remote:call', device, path, method, body),
  remoteAnswer: (id, result) => ipcRenderer.invoke('remote:answer', id, result),
  onRemoteAsk: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('remote:ask', fn);
    return () => ipcRenderer.removeListener('remote:ask', fn);
  },

  convList: (workspace) => ipcRenderer.invoke('conv:list', workspace),
  convLoad: (id) => ipcRenderer.invoke('conv:load', id),
  convSearch: (query, opts) => ipcRenderer.invoke('conv:search', query, opts),
  convCondensed: (id) => ipcRenderer.invoke('conv:condensed', id),
  userMemoryGet: () => ipcRenderer.invoke('userMemory:get'),
  userMemorySet: (text) => ipcRenderer.invoke('userMemory:set', text),
  userMemoryAppend: (fact) => ipcRenderer.invoke('userMemory:append', fact),
  convSave: (conv) => ipcRenderer.invoke('conv:save', conv),
  convDelete: (id) => ipcRenderer.invoke('conv:delete', id),

  modelCatalog: (override) => ipcRenderer.invoke('model:catalog', override),
  listModels: (override) => ipcRenderer.invoke('model:list', override),
  chatStream: (id, payload) => ipcRenderer.invoke('chat:stream', id, payload),
  chatAbort: (id) => ipcRenderer.invoke('chat:abort', id),
  onChatEvent: (cb) => {
    const fn = (_e, ev) => cb(ev);
    ipcRenderer.on('chat:event', fn);
    return () => ipcRenderer.removeListener('chat:event', fn);
  }
});
