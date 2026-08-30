import { expect, test } from "bun:test";
import golden from "../contract/adobe-mcp-v1.json" with { type: "json" };
import {
  AdobeCommandEnvelopeSchema,
  AdobeCommandResultSchema,
} from "../src/contracts.js";
import { dispatchFixture } from "./dispatcher-fixture.js";

test("installed dispatcher executes every strict golden command shape", () => {
  for (const [index, vector] of golden.tools.entries()) {
    const command = AdobeCommandEnvelopeSchema.parse({
      ...golden.commandBase,
      commandId: `cmd-dispatch-${String(index).padStart(2, "0")}`,
      tool: vector.tool,
      args: vector.args,
    });
    const result = AdobeCommandResultSchema.parse(dispatchFixture(command));
    expect(result.payload).toMatchObject(vector.payload);
    expect(result.changedFields).toEqual(vector.changedFields);
  }
});

test("installed dispatcher rejects legacy and unknown argument shapes", () => {
  const base = {
    ...golden.commandBase,
    commandId: "cmd-dispatch-reject",
  };
  for (const candidate of [
    {
      tool: "adobe.composition.update_v1",
      args: { compHandle: "comp:1", properties: { width: 1280 } },
    },
    {
      tool: "adobe.mask.set_v1",
      args: {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        mask: {
          vertices: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      },
    },
    {
      tool: "adobe.expression.apply_template_v1",
      args: {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        templateId: "loop-cycle-v1",
        parameters: { property: "ADBE Opacity" },
      },
    },
    { tool: "adobe.command.status_v1", args: { commandId: "cmd-target-01" } },
    { tool: "adobe.project.get_v1", args: {}, localPath: "/tmp/aep" },
  ])
    expect(() => dispatchFixture({ ...base, ...candidate })).toThrow();
});

test("installed dispatcher rejects malformed identity numeric enum and nested fields", () => {
  const base = {
    ...golden.commandBase,
    commandId: "cmd-dispatch-deep-reject",
  };
  for (const candidate of [
    { ...base, nonce: "", tool: "adobe.project.get_v1", args: {} },
    { ...base, deviceId: "", tool: "adobe.project.get_v1", args: {} },
    { ...base, jobId: "", tool: "adobe.project.get_v1", args: {} },
    {
      ...base,
      tool: "adobe.composition.create_v1",
      args: {
        name: "Main",
        width: "1920",
        height: 1080,
        durationSeconds: 15,
        frameRate: 30,
      },
    },
    {
      ...base,
      tool: "adobe.mask.set_v1",
      args: {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        mode: "replace",
        vertices: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
    },
    {
      ...base,
      tool: "adobe.layer.batch_set_properties_v1",
      args: {
        compHandle: "comp:1",
        layers: [
          {
            layerHandle: "layer:1",
            properties: { "ADBE Opacity": 80 },
            surprise: true,
          },
        ],
      },
    },
  ])
    expect(() => dispatchFixture(candidate)).toThrow();
});
