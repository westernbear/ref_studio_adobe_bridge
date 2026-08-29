import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { enqueueToolCall } from "./connector.js";
import { TOOL_NAMES } from "./contracts.js";
import { CommandSpool } from "./spool.js";

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "version",
    "commandId",
    "nonce",
    "sceneDigest",
    "deviceId",
    "jobId",
    "projectHandle",
    "args",
  ],
  properties: {
    version: { const: 1 },
    commandId: { type: "string" },
    nonce: { type: "string" },
    sceneDigest: { type: "string" },
    deviceId: { type: "string" },
    jobId: { type: "string" },
    projectHandle: { const: "project:working-copy" },
    args: { type: "object" },
  },
} as const;

export const createServer = (spoolRoot: string): Server => {
  const spool = new CommandSpool(spoolRoot);
  const server = new Server(
    { name: "rvs-adobe-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description:
        "Queue a typed command for the enrolled After Effects device",
      inputSchema: INPUT_SCHEMA,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return enqueueToolCall(spool, {
      name: request.params.name,
      arguments: request.params.arguments,
    });
  });
  return server;
};

export const runStdioServer = async (spoolRoot: string): Promise<void> => {
  await createServer(spoolRoot).connect(new StdioServerTransport());
};
