import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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

const MAX_RELAY_BODY_BYTES = 262_144; // lockstep with RESOURCE_BUDGETS.maxRelayBodyBytes
const DEFAULT_MAX_SKEW_MS = 300_000;

export type RelaySignatureV1 = Readonly<{
  keyId: string;
  timestampMs: number;
  requestId: string;
  nonce: string;
  bodyHash: string;
  signature: string;
}>;

type RelaySigningInput = Readonly<{
  keyId: string;
  secret: string;
  timestampMs: number;
  requestId: string;
  nonce: string;
}>;

type RelayKey = Readonly<{
  secret: string;
  deviceId: string;
  notBeforeMs: number;
  expiresAtMs: number;
}>;

type RelayVerification = Readonly<{
  now: () => number;
  resolveKey: (keyId: string) => RelayKey | undefined;
  consumeNonce: (keyId: string, nonce: string) => boolean | Promise<boolean>;
  maxSkewMs?: number;
}>;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AuthenticationError("non-finite body");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  throw new AuthenticationError("non-json body");
};

const bodyDigest = (body: unknown): string => {
  const canonical = canonicalJson(body);
  if (Buffer.byteLength(canonical) > MAX_RELAY_BODY_BYTES)
    throw new AuthenticationError("oversized body");
  return createHash("sha256").update(canonical).digest("hex");
};

const signingPayload = (
  signature: Omit<RelaySignatureV1, "signature">,
): string =>
  [
    signature.keyId,
    String(signature.timestampMs),
    signature.requestId,
    signature.nonce,
    signature.bodyHash,
  ].join("\n");

export const signRelayRequest = (
  body: unknown,
  input: RelaySigningInput,
): RelaySignatureV1 => {
  const unsigned = {
    keyId: input.keyId,
    timestampMs: input.timestampMs,
    requestId: input.requestId,
    nonce: input.nonce,
    bodyHash: bodyDigest(body),
  };
  return {
    ...unsigned,
    signature: createHmac("sha256", input.secret)
      .update(signingPayload(unsigned))
      .digest("hex"),
  };
};

export const verifyRelayRequest = async (
  body: unknown,
  signature: RelaySignatureV1,
  verification: RelayVerification,
): Promise<Readonly<{ deviceId: string }>> => {
  const now = verification.now();
  if (
    !Number.isSafeInteger(signature.timestampMs) ||
    Math.abs(now - signature.timestampMs) >
      (verification.maxSkewMs ?? DEFAULT_MAX_SKEW_MS)
  )
    throw new AuthenticationError("timestamp skew");
  const key = verification.resolveKey(signature.keyId);
  if (
    key === undefined ||
    signature.timestampMs < key.notBeforeMs ||
    signature.timestampMs >= key.expiresAtMs
  )
    throw new AuthenticationError("expired key");
  const digest = bodyDigest(body);
  if (digest !== signature.bodyHash) throw new AuthenticationError("body hash");
  const expected = createHmac("sha256", key.secret)
    .update(signingPayload({ ...signature, bodyHash: digest }))
    .digest();
  const provided = Buffer.from(signature.signature, "hex");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    throw new AuthenticationError("signature");
  const directDevice = isObject(body) ? body["deviceId"] : undefined;
  const params =
    isObject(body) && isObject(body["params"]) ? body["params"] : undefined;
  const argumentsValue =
    params && isObject(params["arguments"]) ? params["arguments"] : undefined;
  const commandDevice = argumentsValue?.["deviceId"];
  if (
    (directDevice !== undefined && directDevice !== key.deviceId) ||
    (commandDevice !== undefined && commandDevice !== key.deviceId)
  )
    throw new AuthenticationError("device binding");
  if (!(await verification.consumeNonce(signature.keyId, signature.nonce)))
    throw new AuthenticationError("replay");
  return { deviceId: key.deviceId };
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
  signature: RelaySignatureV1,
  verification: RelayVerification,
  spool?: CommandSpool,
): Promise<JsonRpcResponse> => {
  const parsed: unknown = JSON.parse(body);
  await verifyRelayRequest(parsed, signature, verification);
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
