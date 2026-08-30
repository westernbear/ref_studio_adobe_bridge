import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import golden from "../contract/adobe-mcp-v1.json" with { type: "json" };
import {
  AdobeCommandEnvelopeSchema,
  AdobeCommandResultSchema,
} from "../src/contracts.js";
import { CommandSpool } from "../src/spool.js";
import {
  dispatchJsonRpc,
  relayRequest,
  signRelayRequest,
} from "../src/transport.js";
import { dispatchFixture } from "./dispatcher-fixture.js";

const request = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/list",
  params: {},
};

const authenticatedRelay = (
  body: string,
  nonce: string,
  spool?: CommandSpool,
  deviceId = "device-parity",
) => {
  const parsed: unknown = JSON.parse(body);
  const secret = "test-secret-long-enough-for-relay-signing";
  return relayRequest(
    body,
    signRelayRequest(parsed, {
      keyId: "key-parity",
      secret,
      timestampMs: 1_000,
      requestId: `request-${nonce}`,
      nonce,
    }),
    {
      now: () => 1_000,
      resolveKey: () => ({
        secret,
        deviceId,
        notBeforeMs: 0,
        expiresAtMs: 2_000,
      }),
      consumeNonce: () => true,
    },
    spool,
  );
};

test("stdio and authenticated cloud relay produce the same golden response", async () => {
  const direct = await dispatchJsonRpc(request);
  const body = JSON.stringify(request);
  const relayed = await authenticatedRelay(body, "relay-list");
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
  const relayed = await authenticatedRelay(
    body,
    "relay-tools-call",
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
    const relayResponse = await authenticatedRelay(
      body,
      `relay-golden-${index}`,
      relaySpool,
      "device-golden",
    );

    // Then
    expect(relayResponse).toEqual(directResponse);
    const directCommand = await directSpool.claimNext();
    const relayCommand = await relaySpool.claimNext();
    expect(relayCommand).toEqual(directCommand);
    if (directCommand === undefined || relayCommand === undefined)
      throw new TypeError("golden command was not claimed");
    const { status: directStatus, ...directEnvelope } = directCommand;
    const { status: relayStatus, ...relayEnvelope } = relayCommand;
    expect(relayStatus).toBe(directStatus);
    const parsedDirect = AdobeCommandEnvelopeSchema.parse(directEnvelope);
    const parsedRelay = AdobeCommandEnvelopeSchema.parse(relayEnvelope);
    const directDispatch = AdobeCommandResultSchema.parse(
      dispatchFixture(parsedDirect),
    );
    const relayDispatch = AdobeCommandResultSchema.parse(
      dispatchFixture(parsedRelay),
    );
    expect(relayDispatch).toEqual(directDispatch);
    expect(directDispatch.payload).toMatchObject(vector.payload);
    const directResult = {
      ...golden.resultBase,
      commandId,
      changedFields: vector.changedFields,
      payload: directDispatch.payload,
    };
    const relayResult = { ...directResult, payload: relayDispatch.payload };
    expect(await relaySpool.complete(relayResult)).toEqual(
      await directSpool.complete(directResult),
    );
  }
});
