#!/usr/bin/env node
/**
 * Fake powerbi-modeling-mcp used by the e2e tests. Returns fixture data
 * containing "sensitive" customer names in the same shapes the real server
 * uses (CSV inside resource content blocks, JSON status text).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const CUSTOMERS = ["Contoso Ltd", "Fabrikam Inc", "Adventure Works"];

const server = new Server(
  { name: "fake-powerbi", version: "0.0.1" },
  { capabilities: { tools: {}, prompts: {}, resources: {} } },
);

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: "dax_help", description: "DAX guidance" }],
}));

server.setRequestHandler(GetPromptRequestSchema, async () => ({
  messages: [
    {
      role: "user" as const,
      content: { type: "text" as const, text: "Example: filter Contoso Ltd by month" },
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: "guide://dax", name: "DAX instructions" }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async () => ({
  contents: [{ uri: "guide://dax", mimeType: "text/markdown", text: "Top customer: Fabrikam Inc" }],
}));

const ANY_SCHEMA = { type: "object" as const, additionalProperties: true };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "dax_query_operations", description: "Execute DAX", inputSchema: ANY_SCHEMA },
    { name: "connection_operations", description: "Connections", inputSchema: ANY_SCHEMA },
    { name: "column_operations", description: "List columns", inputSchema: ANY_SCHEMA },
    { name: "run_dax", description: "Run a canned query", inputSchema: ANY_SCHEMA },
    { name: "check_filter", description: "Returns MATCH if client arg is the real name", inputSchema: ANY_SCHEMA },
    { name: "boom", description: "Returns an error result that echoes a customer name", inputSchema: ANY_SCHEMA },
    { name: "crash", description: "Throws a protocol error that echoes a customer name", inputSchema: ANY_SCHEMA },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  if (name === "connection_operations") {
    const request = (args.request ?? {}) as Record<string, unknown>;
    const op = String(request.operation ?? "").toLowerCase();
    if (op === "listlocalinstances") {
      return text(
        JSON.stringify({
          success: true,
          data: [
            { connectionString: "Data Source=localhost:9999", parentWindowTitle: "Fake Model" },
            { connectionString: "Data Source=localhost:9998", parentWindowTitle: "Other Model" },
          ],
        }),
      );
    }
    return text(JSON.stringify({ success: true }));
  }

  if (name === "column_operations") {
    return text(
      JSON.stringify({
        success: true,
        data: [
          {
            tableName: "Customer",
            columns: [
              { name: "Customer Name", dataType: "String" },
              { name: "Email", dataType: "String" },
              { name: "Amount", dataType: "Double" },
            ],
          },
        ],
      }),
    );
  }

  if (name === "dax_query_operations") {
    const request = (args.request ?? {}) as Record<string, unknown>;
    const query = String(request.query ?? "");
    if (query.includes("DISTINCTCOUNT")) {
      return csvResult("[DistinctCount]\n" + CUSTOMERS.length);
    }
    if (String(request.operation).toLowerCase() === "execute" && query.includes("VALUES")) {
      // Real shape: CSV in a resource content block.
      return csvResult("Customer[Customer Name]\n" + CUSTOMERS.join("\n"));
    }
    return text(JSON.stringify({ success: false, message: `Unsupported query: ${query}` }));
  }

  if (name === "run_dax") {
    const lines = CUSTOMERS.map((c, i) => `${c},${(i + 1) * 100}`);
    return csvResult("Customer[Customer Name],[Amount]\n" + lines.join("\n"));
  }

  if (name === "check_filter") {
    return text(args.client === "Contoso Ltd" ? "MATCH" : `NO(${String(args.client)})`);
  }

  if (name === "boom") {
    return { content: [{ type: "text" as const, text: "Error: timeout while scanning Contoso Ltd partition" }], isError: true };
  }

  if (name === "crash") {
    throw new Error("internal failure processing row for Fabrikam Inc");
  }

  return text(`unknown tool ${name}`);
});

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function csvResult(csv: string) {
  return {
    content: [
      { type: "text" as const, text: '{"success":true}' },
      {
        type: "resource" as const,
        resource: { uri: "file:///tmp/fake_query_result.csv", mimeType: "text/csv", text: csv },
      },
    ],
  };
}

await server.connect(new StdioServerTransport());
