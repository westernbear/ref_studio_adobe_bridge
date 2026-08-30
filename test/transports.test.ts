import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import golden from "../contract/adobe-mcp-v1.json" with { type: "json" };
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
    deviceId: envelope.deviceId,
    jobId: envelope.jobId,
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

test("stdio and cloud relay preserve all 25 golden command and result vectors", async () => {
  // Given
  const directSpool = new CommandSpool(
    await mkdtemp(join(tmpdir(), "rvs-golden-direct-")),
  );
  const relaySpool = new CommandSpool(
    await mkdtemp(join(tmpdir(), "rvs-golden-relay-")),
  );
  const secret = "test-secret";

  for (const [index, vector] of golden.tools.entries()) {
    const commandId = `cmd-golden-${String(index).padStart(2, "0")}`;
    const call = {
      jsonrpc: "2.0" as const,
      id: index,
      method: "tools/call",
      params: {
        name: vector.tool,
        arguments: { ...golden.commandBase, commandId, args: vector.args },
      },
    };

    // When
    const directResponse = await dispatchJsonRpc(call, directSpool);
    const body = JSON.stringify(call);
    const relayResponse = await relayRequest(
      body,
      createHmac("sha256", secret).update(body).digest("hex"),
      secret,
      relaySpool,
    );

    // Then
    expect(relayResponse).toEqual(directResponse);
    const directCommand = await directSpool.claimNext();
    const relayCommand = await relaySpool.claimNext();
    expect(relayCommand).toEqual(directCommand);
    const result = {
      ...golden.resultBase,
      commandId,
      changedFields: vector.changedFields,
      payload: vector.payload,
    };
    expect(await relaySpool.complete(result)).toEqual(
      await directSpool.complete(result),
    );
  }
});
