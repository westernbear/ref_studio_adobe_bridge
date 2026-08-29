import { describe, expect, test } from "bun:test";
import {
  AdobeCommandEnvelopeSchema,
  AdobeCommandResultSchema,
  TOOL_NAMES,
} from "../src/contracts.js";

const valid = {
  version: 1,
  commandId: "cmd-00000001",
  nonce: "nonce-00000001",
  sceneDigest: "a".repeat(64),
  deviceId: "device-1",
  jobId: "job-1",
  projectHandle: "project:working-copy",
  tool: "adobe.project.get_v1",
  args: {},
};

describe("Adobe command boundary", () => {
  test("accepts every exact versioned tool", () => {
    for (const tool of TOOL_NAMES)
      expect(
        AdobeCommandEnvelopeSchema.safeParse({ ...valid, tool }).success,
      ).toBe(true);
  });

  test("rejects unknown fields and forbidden cloud input before mutation", () => {
    for (const forbidden of [
      { expressionString: "wiggle(2, 5)" },
      { presetPath: "/tmp/a.ffx" },
      { localPath: "/tmp/a.aep" },
      { uploadUrl: "https://example.test" },
      { accessToken: "secret" },
      { tenantId: "tenant" },
      { userId: "user" },
      { script: "app.project.close()" },
    ])
      expect(
        AdobeCommandEnvelopeSchema.safeParse({ ...valid, args: forbidden })
          .success,
      ).toBe(false);
    expect(
      AdobeCommandEnvelopeSchema.safeParse({ ...valid, surprise: true })
        .success,
    ).toBe(false);
  });

  test("result rejects unknown fields", () => {
    const result = {
      version: 1,
      commandId: valid.commandId,
      nonce: valid.nonce,
      sceneDigest: valid.sceneDigest,
      status: "SUCCEEDED",
      beforeDigest: valid.sceneDigest,
      afterDigest: valid.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    };
    expect(AdobeCommandResultSchema.safeParse(result).success).toBe(true);
    expect(
      AdobeCommandResultSchema.safeParse({ ...result, extra: true }).success,
    ).toBe(false);
  });
});
