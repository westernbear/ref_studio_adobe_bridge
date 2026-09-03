import { describe, expect, test } from "bun:test";
import golden from "../contract/adobe-mcp-v1.json" with { type: "json" };
import {
  ADOBE_TOOL_NAMES_V1,
  AdobeCommandEnvelopeV1Schema,
  AdobeCommandResultV1Schema,
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
    expect(golden.tools.map(({ tool }) => tool)).toEqual([
      ...ADOBE_TOOL_NAMES_V1,
    ]);
    for (const { tool, args } of golden.tools) {
      expect(
        AdobeCommandEnvelopeV1Schema.safeParse({ ...valid, tool, args })
          .success,
      ).toBe(true);
    }
  });

  test("rejects unknown fields and forbidden cloud input before mutation", () => {
    for (const forbidden of golden.rejectedArgs)
      expect(
        AdobeCommandEnvelopeV1Schema.safeParse({ ...valid, args: forbidden })
          .success,
      ).toBe(false);
    expect(
      AdobeCommandEnvelopeV1Schema.safeParse({ ...valid, surprise: true })
        .success,
    ).toBe(false);
  });

  test("rejects unknown properties effects and templates before mutation", () => {
    const cases = [
      {
        tool: "adobe.layer.set_properties_v1",
        args: { properties: { "ADBE Unknown": 1 } },
      },
      {
        tool: "adobe.layer.batch_set_properties_v1",
        args: {
          layers: [
            { layerHandle: "layer:1", properties: { "ADBE Opacity": 50 } },
            { layerHandle: "layer:2", properties: { "ADBE Unknown": 1 } },
          ],
        },
      },
      { tool: "adobe.effect.apply_v1", args: { effectId: "ADBE Arbitrary" } },
      {
        tool: "adobe.effect.apply_template_v1",
        args: { templateId: "unknown-template-v1" },
      },
      {
        tool: "adobe.expression.apply_template_v1",
        args: { templateId: "raw-expression-v1" },
      },
    ];
    for (const candidate of cases) {
      expect(
        AdobeCommandEnvelopeV1Schema.safeParse({ ...valid, ...candidate })
          .success,
      ).toBe(false);
    }
  });

  test("result rejects unknown fields", () => {
    const result = {
      version: 1,
      commandId: valid.commandId,
      nonce: valid.nonce,
      sceneDigest: valid.sceneDigest,
      deviceId: valid.deviceId,
      jobId: valid.jobId,
      status: "SUCCEEDED",
      beforeDigest: valid.sceneDigest,
      afterDigest: valid.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    };
    expect(AdobeCommandResultV1Schema.safeParse(result).success).toBe(true);
    expect(
      AdobeCommandResultV1Schema.safeParse({ ...result, extra: true }).success,
    ).toBe(false);
  });
});
