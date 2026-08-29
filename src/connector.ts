import { z } from "zod";
import { AdobeCommandEnvelopeSchema, TOOL_NAMES } from "./contracts.js";
import type { CommandSpool } from "./spool.js";

const ToolCallSchema = z
  .object({
    name: z.enum(TOOL_NAMES),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const enqueueToolCall = async (
  spool: CommandSpool,
  input: unknown,
): Promise<{
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
}> => {
  const call = ToolCallSchema.parse(input);
  const envelope = AdobeCommandEnvelopeSchema.parse({
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
};
