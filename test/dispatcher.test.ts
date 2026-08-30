import { expect, test } from "bun:test";
import golden from "../contract/adobe-mcp-v1.json" with { type: "json" };
import { AdobeCommandEnvelopeSchema } from "../src/contracts.js";
import { dispatchFixture } from "./dispatcher-fixture.js";

test("installed dispatcher executes every strict golden command shape", () => {
  for (const [index, vector] of golden.tools.entries()) {
    const command = AdobeCommandEnvelopeSchema.parse({
      ...golden.commandBase,
      commandId: `cmd-dispatch-${String(index).padStart(2, "0")}`,
      tool: vector.tool,
      args: vector.args,
    });
    expect(dispatchFixture(command)).toEqual(vector.payload);
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
