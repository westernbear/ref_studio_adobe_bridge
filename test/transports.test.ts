import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandSpool } from "../src/spool.js";
import { dispatchJsonRpc, relayRequest } from "../src/transport.js";

const request = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/list",
  params: {},
};

test("stdio and authenticated cloud relay produce the same golden response", async () => {
  const direct = await dispatchJsonRpc(request);
  const body = JSON.stringify(request);
  const secret = "test-secret";
  const relayed = await relayRequest(
    body,
    createHmac("sha256", secret).update(body).digest("hex"),
    secret,
  );
  expect(relayed).toEqual(direct);
});

test("stdio and authenticated cloud tools call enqueue equivalent contracts", async () => {
  // Given
  const directRoot = await mkdtemp(join(tmpdir(), "rvs-direct-"));
  const relayRoot = await mkdtemp(join(tmpdir(), "rvs-relay-"));
  const envelope = {
    version: 1,
    commandId: "cmd-parity-0001",
    nonce: "nonce-parity-0001",
    sceneDigest: "d".repeat(64),
    deviceId: "device-parity",
    jobId: "job-parity",
    projectHandle: "project:working-copy",
    args: {},
  };
  const call = {
    jsonrpc: "2.0" as const,
    id: 2,
    method: "tools/call",
    params: {
      name: "adobe.project.get_v1",
      arguments: envelope,
    },
  };

  // When
  const direct = await dispatchJsonRpc(call, new CommandSpool(directRoot));
  const body = JSON.stringify(call);
  const secret = "test-secret";
  const relayed = await relayRequest(
    body,
    createHmac("sha256", secret).update(body).digest("hex"),
    secret,
    new CommandSpool(relayRoot),
  );

  // Then
  expect(relayed).toEqual(direct);
  const directCommand = await new CommandSpool(directRoot).claimNext();
  const relayCommand = await new CommandSpool(relayRoot).claimNext();
  expect(directCommand?.status).toBe("RUNNING");
  expect(relayCommand?.status).toBe("RUNNING");
  expect(relayCommand).toEqual(directCommand);
  const terminal = {
    version: 1,
    commandId: envelope.commandId,
    nonce: envelope.nonce,
    sceneDigest: envelope.sceneDigest,
    status: "SUCCEEDED",
    beforeDigest: envelope.sceneDigest,
    afterDigest: envelope.sceneDigest,
    changedFields: [],
    warnings: [],
    payload: { readback: true },
  };
  const directResult = await new CommandSpool(directRoot).complete(terminal);
  const relayResult = await new CommandSpool(relayRoot).complete(terminal);
  expect(relayResult).toEqual(directResult);
});
