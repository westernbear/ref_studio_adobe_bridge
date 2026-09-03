import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import golden from "../contract/adobe-mcp-v1.json" with { type: "json" };
import { AdobeCommandResultV1Schema } from "../src/contracts.js";
import { createDispatcherFixture } from "./dispatcher-fixture.js";

const command = (tool: string, args: unknown, index: number) => ({
  ...golden.commandBase,
  commandId: `cmd-readback-${String(index).padStart(3, "0")}`,
  tool,
  args,
});
const LayerPayloadSchema = z
  .object({
    layerHandle: z.string(),
    readback: z.object({ kind: z.string(), source: z.unknown() }).passthrough(),
  })
  .passthrough();
const VerificationPayloadSchema = z
  .object({ verified: z.boolean() })
  .passthrough();
const RenderPayloadSchema = z
  .object({
    renderPlan: z
      .object({
        projectDigest: z.string(),
        compHandle: z.string(),
        uploadByConnector: z.boolean(),
      })
      .passthrough(),
  })
  .passthrough();

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
};

test("dispatcher returns canonical project digests and actual mutation readback", () => {
  const fixture = createDispatcherFixture();
  const before = fixture.snapshot();
  const created = AdobeCommandResultV1Schema.parse(
    fixture.dispatch(
      command(
        "adobe.layer.create_text_v1",
        { compHandle: "comp:1", text: "Read me" },
        1,
      ),
    ),
  );
  expect(created.beforeDigest).not.toBe(golden.commandBase.sceneDigest);
  expect(fixture.canonical()).toBe(canonical(fixture.snapshot()));
  expect(fixture.sha256("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(created.beforeDigest).toBe(
    createHash("sha256").update(canonical(before)).digest("hex"),
  );
  expect(created.afterDigest).not.toBe(created.beforeDigest);
  expect(created.changedFields).toEqual(["layers"]);
  expect(created.payload).toMatchObject({
    layerHandle: "layer:2",
    name: "Text",
    readback: { kind: "text", source: "Read me" },
  });
  expect(fixture.snapshot()).not.toEqual(before);
});

test("dispatcher reads back composition and all supported layer mutations", () => {
  const fixture = createDispatcherFixture();
  const composition = fixture.dispatch(
    command(
      "adobe.composition.create_v1",
      {
        name: "Delivery",
        width: 1_280,
        height: 720,
        durationSeconds: 12,
        frameRate: 24,
      },
      20,
    ),
  );
  expect(composition.payload).toMatchObject({
    compHandle: "comp:2",
    readback: { width: 1_280, height: 720, durationSeconds: 12, frameRate: 24 },
  });
  const updated = fixture.dispatch(
    command(
      "adobe.composition.update_v1",
      { compHandle: "comp:2", width: 1_920, durationSeconds: 15 },
      21,
    ),
  );
  expect(updated.payload).toMatchObject({
    readback: { compHandle: "comp:2", width: 1_920, durationSeconds: 15 },
  });
  const created = [
    [
      "adobe.layer.create_shape_v1",
      { compHandle: "comp:2", shape: "polygon", color: [1, 0, 0] },
    ],
    ["adobe.layer.create_solid_v1", { compHandle: "comp:2", color: [0, 0, 0] }],
    ["adobe.layer.create_camera_v1", { compHandle: "comp:2" }],
    ["adobe.layer.create_null_v1", { compHandle: "comp:2" }],
  ].map(([tool, args], index) =>
    LayerPayloadSchema.parse(
      fixture.dispatch(command(String(tool), args, 22 + index)).payload,
    ),
  );
  expect(new Set(created.map((payload) => payload.layerHandle)).size).toBe(4);
  expect(created.map((payload) => payload.readback.kind)).toEqual([
    "shape",
    "solid",
    "camera",
    "null",
  ]);
  expect(created[0]?.readback.source).toEqual({
    shape: "polygon",
    color: [1, 0, 0],
  });
  const duplicate = fixture.dispatch(
    command(
      "adobe.layer.duplicate_v1",
      {
        compHandle: "comp:2",
        layerHandle: String(created[0]?.layerHandle),
      },
      26,
    ),
  );
  expect(duplicate.payload["layerHandle"]).not.toBe(created[0]?.layerHandle);
  fixture.dispatch(
    command(
      "adobe.layer.delete_v1",
      {
        compHandle: "comp:2",
        layerHandle: String(created[1]?.layerHandle),
      },
      27,
    ),
  );
  expect(() =>
    fixture.dispatch(
      command(
        "adobe.layer.get_v1",
        {
          compHandle: "comp:2",
          layerHandle: String(created[1]?.layerHandle),
        },
        28,
      ),
    ),
  ).toThrow("unknown layerHandle");
});

test("dispatcher reads back expression lifecycle status verify and safe render plan", () => {
  const fixture = createDispatcherFixture();
  const expression = fixture.dispatch(
    command(
      "adobe.expression.apply_template_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        templateId: "loop-cycle-v1",
        propertyId: "ADBE Opacity",
      },
      30,
    ),
  );
  expect(expression.payload).toMatchObject({
    readback: {
      expressionTemplateId: "loop-cycle-v1",
      expressionEnabled: true,
    },
  });
  const removed = fixture.dispatch(
    command(
      "adobe.expression.remove_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        propertyId: "ADBE Opacity",
      },
      31,
    ),
  );
  expect(removed.payload).toMatchObject({
    readback: { expressionEnabled: false },
  });
  const status = fixture.dispatch(
    command(
      "adobe.command.status_v1",
      { targetCommandId: "cmd-readback-030" },
      32,
    ),
  );
  expect(status.payload).toEqual({
    commandId: "cmd-readback-030",
    status: "SUCCEEDED",
  });
  const verification = fixture.dispatch(
    command(
      "adobe.verify_v1",
      { compHandle: "comp:1", expectedSceneDigest: "a".repeat(64) },
      33,
    ),
  );
  expect(VerificationPayloadSchema.parse(verification.payload).verified).toBe(
    false,
  );
  expect(verification.warnings).toEqual(["scene digest mismatch"]);
  const render = fixture.dispatch(
    command(
      "adobe.render_upload_v1",
      { compHandle: "comp:1", outputName: "delivery.mp4" },
      34,
    ),
  );
  expect(render.payload).toMatchObject({
    queued: true,
    renderPlan: { compHandle: "comp:1", uploadByConnector: true },
  });
  expect(
    RenderPayloadSchema.parse(render.payload).renderPlan.projectDigest,
  ).toBe(render.beforeDigest);
});

test("dispatcher rejects replay-shaped and digest-tampered rollback inputs without mutation", () => {
  const fixture = createDispatcherFixture();
  const before = fixture.snapshot();
  for (const candidate of [
    {
      ...command("adobe.project.get_v1", {}, 40),
      script: "app.project.close()",
    },
    command(
      "adobe.layer.set_properties_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:999",
        properties: { "ADBE Opacity": 50 },
      },
      41,
    ),
    command(
      "adobe.effect.apply_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        effectId: "ADBE Arbitrary",
      },
      42,
    ),
    command("adobe.rollback_v1", { expectedSceneDigest: "f".repeat(64) }, 43),
  ])
    expect(() => fixture.dispatch(candidate)).toThrow();
  expect(fixture.snapshot()).toEqual(before);
});

test("dispatcher persists typed properties keyframes masks effects and templates", () => {
  const fixture = createDispatcherFixture();
  const set = fixture.dispatch(
    command(
      "adobe.layer.set_properties_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        properties: { "ADBE Position": [100, 200], "ADBE Opacity": 80 },
      },
      2,
    ),
  );
  expect(set.payload).toMatchObject({
    readback: {
      properties: { "ADBE Position": [100, 200], "ADBE Opacity": 80 },
    },
  });
  const animated = fixture.dispatch(
    command(
      "adobe.animation.set_keyframes_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        keyframes: [
          { property: "ADBE Opacity", frame: 0, value: 0, easing: "linear" },
          { property: "ADBE Opacity", frame: 12, value: 80, easing: "easeOut" },
          {
            property: "ADBE Opacity",
            frame: 36,
            value: 100,
            easing: "easeInOut",
          },
        ],
      },
      3,
    ),
  );
  expect(animated.payload).toMatchObject({
    readback: {
      keyframes: [
        { frame: 0, time: 0, value: 0, easing: "linear" },
        { frame: 12, time: 0.4, value: 80, easing: "easeOut" },
        { frame: 36, time: 1.2, value: 100, easing: "easeInOut" },
      ],
    },
  });
  const mask = fixture.dispatch(
    command(
      "adobe.mask.set_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        mode: "subtract",
        vertices: [
          [0, 0],
          [100, 0],
          [100, 100],
        ],
      },
      4,
    ),
  );
  expect(mask.payload).toMatchObject({
    readback: {
      mode: "subtract",
      closed: true,
      vertices: [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
    },
  });
  const effect = fixture.dispatch(
    command(
      "adobe.effect.apply_template_v1",
      {
        compHandle: "comp:1",
        layerHandle: "layer:1",
        templateId: "drop-shadow-v1",
      },
      5,
    ),
  );
  expect(effect.payload).toMatchObject({
    templateId: "drop-shadow-v1",
    readback: { effectName: "Drop Shadow" },
  });
});

test("dispatcher rejects atomic batch and malformed keyframes before mutation", () => {
  const fixture = createDispatcherFixture();
  const baseline = fixture.snapshot();
  expect(() =>
    fixture.dispatch(
      command(
        "adobe.layer.batch_set_properties_v1",
        {
          compHandle: "comp:1",
          layers: [
            { layerHandle: "layer:1", properties: { "ADBE Opacity": 50 } },
            { layerHandle: "layer:999", properties: { "ADBE Opacity": 25 } },
          ],
        },
        6,
      ),
    ),
  ).toThrow();
  expect(fixture.snapshot()).toEqual(baseline);
  for (const frame of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      fixture.dispatch(
        command(
          "adobe.animation.set_keyframes_v1",
          {
            compHandle: "comp:1",
            layerHandle: "layer:1",
            keyframes: [
              { property: "ADBE Opacity", frame, value: 50, easing: "linear" },
            ],
          },
          7,
        ),
      ),
    ).toThrow();
  }
  expect(fixture.snapshot()).toEqual(baseline);
});

test("cancel is terminal and rollback restores the captured working-copy snapshot", () => {
  const fixture = createDispatcherFixture();
  const baseline = fixture.snapshot();
  const mutation = fixture.dispatch(
    command(
      "adobe.composition.update_v1",
      { compHandle: "comp:1", width: 1_280 },
      8,
    ),
  );
  const cancel = fixture.dispatch(
    command(
      "adobe.command.cancel_v1",
      { targetCommandId: "cmd-missing-target" },
      9,
    ),
  );
  expect(cancel.status).toBe("CANCELLED");
  expect(cancel.payload).toEqual({
    commandId: "cmd-missing-target",
    cancelled: true,
    status: "CANCELLED",
  });
  const rolledBack = fixture.dispatch(
    command(
      "adobe.rollback_v1",
      { expectedSceneDigest: mutation.beforeDigest },
      10,
    ),
  );
  expect(rolledBack.payload).toMatchObject({ rolledBack: true });
  expect(fixture.snapshot()).toEqual(baseline);
  expect(rolledBack.afterDigest).toBe(mutation.beforeDigest);
});
