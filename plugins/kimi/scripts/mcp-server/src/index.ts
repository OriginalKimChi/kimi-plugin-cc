import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runKimiAnalyze } from "./tools/analyze.js";
import { runKimiImplement } from "./tools/implement.js";
import { runKimiQuery } from "./tools/query.js";
import { runKimiResume } from "./tools/resume.js";
import { runKimiReview } from "./tools/review.js";
import { runStatusTool } from "./tools/status.js";

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
        "Return health info for the kimi MCP server: plugin version, auth env presence, kimi CLI version detection, and a high-level state (ok / degraded / missing). Probes 'kimi --version' once per call.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "kimi_query",
      description:
        "Run a single read-only kimi prompt and return the final assistant message. Default 120s timeout (cap 300s). Optional model, work_dir, add_dirs, max_steps_per_turn, session_id, output_format (set to 'stream-json' to also receive the full event stream in structuredContent.raw_events).",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 50000 },
          model: { type: "string", minLength: 1, maxLength: 256 },
          work_dir: { type: "string" },
          add_dirs: { type: "array", items: { type: "string" }, maxItems: 10 },
          max_steps_per_turn: { type: "integer", minimum: 1, maximum: 100 },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 300 },
          session_id: {
            type: "string",
            pattern:
              "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          },
          output_format: { type: "string", enum: ["text", "stream-json"] },
        },
      },
    },
    {
      name: "kimi_resume",
      description:
        "Resume an existing kimi session (`kimi -r <session_id>`) and return the final assistant message. Default 300s timeout (cap 600s). Requires session_id; otherwise same options as kimi_query.",
      inputSchema: {
        type: "object",
        required: ["prompt", "session_id"],
        additionalProperties: false,
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 50000 },
          session_id: {
            type: "string",
            pattern:
              "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          },
          model: { type: "string", minLength: 1, maxLength: 256 },
          work_dir: { type: "string" },
          add_dirs: { type: "array", items: { type: "string" }, maxItems: 10 },
          max_steps_per_turn: { type: "integer", minimum: 1, maximum: 100 },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 600 },
        },
      },
    },
    {
      name: "kimi_analyze",
      description:
        "Run a kimi prompt focused on analysing a repo or code area and return the final assistant message. Read-only. Default 300s timeout (cap 600s). Same options as kimi_query.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 50000 },
          model: { type: "string", minLength: 1, maxLength: 256 },
          work_dir: { type: "string" },
          add_dirs: { type: "array", items: { type: "string" }, maxItems: 10 },
          max_steps_per_turn: { type: "integer", minimum: 1, maximum: 100 },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 600 },
          session_id: {
            type: "string",
            pattern:
              "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          },
        },
      },
    },
    {
      name: "kimi_review",
      description:
        "Run a kimi prompt focused on reviewing a diff or branch and return the final assistant message. Read-only. Default 300s timeout (cap 600s). Same options as kimi_query.",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        additionalProperties: false,
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 50000 },
          model: { type: "string", minLength: 1, maxLength: 256 },
          work_dir: { type: "string" },
          add_dirs: { type: "array", items: { type: "string" }, maxItems: 10 },
          max_steps_per_turn: { type: "integer", minimum: 1, maximum: 100 },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 600 },
          session_id: {
            type: "string",
            pattern:
              "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          },
        },
      },
    },
    {
      name: "kimi_implement",
      description:
        "Run a kimi task that edits code inside a disposable git worktree (never the main checkout). Refuses if worktree_path is the main worktree or lives inside base_repo. Default 600s timeout (cap 1200s). Returns the captured diff + files_changed; the caller decides whether to merge.",
      inputSchema: {
        type: "object",
        required: ["task", "worktree_path", "base_repo"],
        additionalProperties: false,
        properties: {
          task: { type: "string", minLength: 1, maxLength: 50000 },
          worktree_path: { type: "string", minLength: 1 },
          base_repo: { type: "string", minLength: 1 },
          base_ref: { type: "string", minLength: 1, default: "HEAD" },
          create_worktree: { type: "boolean", default: true },
          allow_dirty: { type: "boolean", default: false },
          model: { type: "string", minLength: 1, maxLength: 256 },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 1200 },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "kimi_status": {
      const payload = await runStatusTool({
        parentEnv: process.env,
        pluginVersion: PLUGIN_VERSION,
        pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
    case "kimi_query": {
      const out = await runKimiQuery(request.params.arguments ?? {}, {
        parentEnv: process.env,
        pluginVersion: PLUGIN_VERSION,
      });
      // MCP SDK's CallToolResult is a discriminated union with a task-based
      // variant; widening through unknown is fine — we return the content-based shape.
      return out as unknown as { content: Array<{ type: "text"; text: string }> };
    }
    case "kimi_resume": {
      const out = await runKimiResume(request.params.arguments ?? {}, {
        parentEnv: process.env,
        pluginVersion: PLUGIN_VERSION,
      });
      return out as unknown as { content: Array<{ type: "text"; text: string }> };
    }
    case "kimi_analyze": {
      const out = await runKimiAnalyze(request.params.arguments ?? {}, {
        parentEnv: process.env,
        pluginVersion: PLUGIN_VERSION,
      });
      return out as unknown as { content: Array<{ type: "text"; text: string }> };
    }
    case "kimi_review": {
      const out = await runKimiReview(request.params.arguments ?? {}, {
        parentEnv: process.env,
        pluginVersion: PLUGIN_VERSION,
      });
      return out as unknown as { content: Array<{ type: "text"; text: string }> };
    }
    case "kimi_implement": {
      const out = await runKimiImplement(request.params.arguments ?? {}, {
        parentEnv: process.env,
        pluginVersion: PLUGIN_VERSION,
      });
      return out as unknown as { content: Array<{ type: "text"; text: string }> };
    }
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
