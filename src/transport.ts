import { createHmac, timingSafeEqual } from "node:crypto";
import { enqueueToolCall } from "./connector.js";
import { TOOL_NAMES } from "./contracts.js";
import { AuthenticationError } from "./errors.js";
import type { CommandSpool } from "./spool.js";

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
};
type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result: unknown;
};

export const dispatchJsonRpc = async (
  request: JsonRpcRequest,
  spool?: CommandSpool,
): Promise<JsonRpcResponse> => {
  let result: unknown;
  if (request.method === "tools/list") {
    result = {
      tools: TOOL_NAMES.map((name) => ({
        name,
        description: "Queue a typed After Effects command",
        inputSchema: { type: "object" },
      })),
    };
  } else if (request.method === "tools/call" && spool !== undefined) {
    result = await enqueueToolCall(spool, request.params);
  } else {
    result = { accepted: false };
  }
  return { jsonrpc: "2.0", id: request.id, result };
};

export const relayRequest = async (
  body: string,
  signature: string,
  secret: string,
  spool?: CommandSpool,
): Promise<JsonRpcResponse> => {
  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(signature, "hex");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    throw new AuthenticationError();
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("jsonrpc" in parsed) ||
    !("id" in parsed) ||
    !("method" in parsed) ||
    !("params" in parsed)
  ) {
    throw new AuthenticationError();
  }
  const value = parsed;
  if (
    value.jsonrpc !== "2.0" ||
    (typeof value.id !== "string" && typeof value.id !== "number") ||
    typeof value.method !== "string"
  ) {
    throw new AuthenticationError();
  }
  return dispatchJsonRpc(
    {
      jsonrpc: value.jsonrpc,
      id: value.id,
      method: value.method,
      params: value.params,
    },
    spool,
  );
};
