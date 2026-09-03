import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ADOBE_TOOL_NAMES_V1,
  AdobeCommandEnvelopeV1Schema,
} from "./contracts.js";
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

const ToolCallSchema = z
  .object({
    name: z.enum(ADOBE_TOOL_NAMES_V1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const createServer = (spoolRoot: string): Server => {
  const spool = new CommandSpool(spoolRoot);
  const server = new Server(
    { name: "rvs-adobe-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ADOBE_TOOL_NAMES_V1.map((name) => ({
      name,
      description:
        "Queue a typed command for the enrolled After Effects device",
      inputSchema: INPUT_SCHEMA,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const call = ToolCallSchema.parse({
      name: request.params.name,
      arguments: request.params.arguments,
    });
    const envelope = AdobeCommandEnvelopeV1Schema.parse({
      ...call.arguments,
      tool: call.name,
    });
    const queued = await spool.enqueue(envelope);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            commandId: queued.commandId,
            status: queued.status,
          }),
        },
      ],
    };
  });
  return server;
};

export const runStdioServer = async (spoolRoot: string): Promise<void> => {
  await createServer(spoolRoot).connect(new StdioServerTransport());
};
