// A minimal stdio MCP server for the e2e tests: one tool, get_state_snapshot, that returns a
// caption and a 1×1 PNG — the shape gimp-mcp's visual-feedback tool returns.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const server = new Server({ name: 'snap-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'get_state_snapshot', description: 'PNG preview of the current image state', inputSchema: { type: 'object', properties: { max_size: { type: 'number' } } } }]
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'get_state_snapshot') return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  return { content: [{ type: 'text', text: 'Snapshot of image 0 (1×1)' }, { type: 'image', mimeType: 'image/png', data: RED }] };
});
server.connect(new StdioServerTransport());
