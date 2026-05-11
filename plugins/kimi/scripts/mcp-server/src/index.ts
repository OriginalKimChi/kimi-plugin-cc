import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const PLUGIN_VERSION = "0.0.1";

const server = new Server(
  { name: "kimi", version: PLUGIN_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "kimi_status",
      description:
        "Return basic health info for the kimi MCP server. Used by the packaging spike to verify the plugin is wired up correctly. No external calls.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "kimi_status") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const hasKimiCodeKey = Boolean(process.env.KIMI_CODE_API_KEY);
  const hasMoonshotKey = Boolean(process.env.MOONSHOT_API_KEY);

  const payload = {
    plugin: "kimi",
    version: PLUGIN_VERSION,
    state: "ok",
    node: process.version,
    plugin_root: process.env.CLAUDE_PLUGIN_ROOT ?? null,
    auth: {
      kimi_code_api_key_present: hasKimiCodeKey,
      moonshot_api_key_present: hasMoonshotKey,
      preferred: hasKimiCodeKey ? "kimi_code" : hasMoonshotKey ? "moonshot" : "none",
    },
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
