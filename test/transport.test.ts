import { describe, expect, test } from "bun:test";
import { signRelayRequest, verifyRelayRequest } from "../src/transport.js";

const body = {
  version: 1,
  commandId: "cmd-relay-0001",
  nonce: "command-nonce-0001",
  sceneDigest: "a".repeat(64),
  deviceId: "device-relay-1",
  jobId: "job-relay-1",
  projectHandle: "project:working-copy",
  tool: "adobe.project.get_v1",
  args: {},
} as const;

describe("authenticated cloud relay", () => {
  test("signs canonical JSON and rejects replay", async () => {
    const seen = new Set<string>();
    const signed = signRelayRequest(body, {
      keyId: "key-1",
      secret: "relay-secret-000000000000000000000001",
      timestampMs: 1_000,
      requestId: "request-1",
      nonce: "relay-nonce-1",
    });
    const verify = () =>
      verifyRelayRequest(body, signed, {
        now: () => 1_000,
        resolveKey: (keyId) =>
          keyId === "key-1"
            ? {
                secret: "relay-secret-000000000000000000000001",
                deviceId: "device-relay-1",
                notBeforeMs: 0,
                expiresAtMs: 2_000,
              }
            : undefined,
        consumeNonce: (keyId, nonce) => {
          const binding = `${keyId}:${nonce}`;
          if (seen.has(binding)) return false;
          seen.add(binding);
          return true;
        },
      });
    expect(await verify()).toEqual({ deviceId: "device-relay-1" });
    await expect(verify()).rejects.toThrow("replay");
  });

  test("binds signature to canonical body device and active key window", async () => {
    const input = {
      keyId: "key-rotation-1",
      secret: "relay-secret-000000000000000000000002",
      timestampMs: 10_000,
      requestId: "request-rotation-1",
      nonce: "relay-nonce-rotation-1",
    } as const;
    const reordered = {
      args: body.args,
      tool: body.tool,
      projectHandle: body.projectHandle,
      jobId: body.jobId,
      deviceId: body.deviceId,
      sceneDigest: body.sceneDigest,
      nonce: body.nonce,
      commandId: body.commandId,
      version: body.version,
    };
    expect(signRelayRequest(reordered, input)).toEqual(
      signRelayRequest(body, input),
    );

    const signed = signRelayRequest(body, input);
    const options = {
      now: () => 10_000,
      resolveKey: () => ({
        secret: input.secret,
        deviceId: body.deviceId,
        notBeforeMs: 9_000,
        expiresAtMs: 11_000,
      }),
      consumeNonce: () => true,
    } as const;
    await expect(
      verifyRelayRequest(
        { ...body, deviceId: "device-foreign" },
        signed,
        options,
      ),
    ).rejects.toThrow("body hash");
    await expect(
      verifyRelayRequest(
        body,
        { ...signed, signature: "00".repeat(32) },
        options,
      ),
    ).rejects.toThrow("signature");
    await expect(
      verifyRelayRequest(body, signed, { ...options, now: () => 700_001 }),
    ).rejects.toThrow("timestamp skew");
    await expect(
      verifyRelayRequest(body, signed, {
        ...options,
        resolveKey: () => ({ ...options.resolveKey(), expiresAtMs: 10_000 }),
      }),
    ).rejects.toThrow("expired key");
  });

  test("rejects oversized relay body before signing", () => {
    expect(() =>
      signRelayRequest(
        { ...body, args: { text: "x".repeat(262_145) } },
        {
          keyId: "key-1",
          secret: "relay-secret-000000000000000000000003",
          timestampMs: 1_000,
          requestId: "request-oversize",
          nonce: "relay-nonce-oversize",
        },
      ),
    ).toThrow("oversized body");
  });
});
