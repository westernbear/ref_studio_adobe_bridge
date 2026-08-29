import { z } from "zod";

export const TOOL_NAMES = [
  "adobe.project.get_v1",
  "adobe.composition.list_v1",
  "adobe.composition.create_v1",
  "adobe.composition.update_v1",
  "adobe.layer.get_v1",
  "adobe.layer.create_text_v1",
  "adobe.layer.create_shape_v1",
  "adobe.layer.create_solid_v1",
  "adobe.layer.create_camera_v1",
  "adobe.layer.create_null_v1",
  "adobe.layer.duplicate_v1",
  "adobe.layer.delete_v1",
  "adobe.layer.set_properties_v1",
  "adobe.layer.batch_set_properties_v1",
  "adobe.animation.set_keyframes_v1",
  "adobe.mask.set_v1",
  "adobe.effect.apply_v1",
  "adobe.effect.apply_template_v1",
  "adobe.expression.apply_template_v1",
  "adobe.expression.remove_v1",
  "adobe.command.status_v1",
  "adobe.command.cancel_v1",
  "adobe.verify_v1",
  "adobe.render_upload_v1",
  "adobe.rollback_v1",
] as const;

const Identifier = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9:._-]+$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Handle = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z]+:[A-Za-z0-9._-]+$/);
const JsonPrimitive = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([JsonPrimitive, z.array(JsonValue), z.record(z.string(), JsonValue)]),
);

export const ApprovedArgsSchema = z
  .object({
    compHandle: Handle.optional(),
    layerHandle: Handle.optional(),
    targetLayerHandle: Handle.optional(),
    commandId: Identifier.optional(),
    name: z.string().min(1).max(200).optional(),
    width: z.number().int().min(1).max(32_768).optional(),
    height: z.number().int().min(1).max(32_768).optional(),
    durationSeconds: z.number().positive().max(86_400).optional(),
    frameRate: z.number().positive().max(240).optional(),
    text: z.string().max(20_000).optional(),
    shape: z.enum(["rectangle", "ellipse", "polygon"]).optional(),
    color: z
      .tuple([
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
      ])
      .optional(),
    properties: z.record(z.string(), JsonValue).optional(),
    layers: z
      .array(
        z
          .object({
            layerHandle: Handle,
            properties: z.record(z.string(), JsonValue),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    keyframes: z
      .array(
        z
          .object({
            property: z.string().min(1),
            frame: z.number().int().min(0),
            value: JsonValue,
            easing: z
              .enum(["linear", "easeIn", "easeOut", "easeInOut"])
              .optional(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    mask: z
      .object({
        mode: z.enum(["add", "subtract", "intersect"]),
        vertices: z
          .array(z.tuple([z.number(), z.number()]))
          .min(3)
          .max(500),
      })
      .strict()
      .optional(),
    effectId: Identifier.optional(),
    templateId: Identifier.optional(),
    parameters: z.record(z.string(), JsonValue).optional(),
    outputName: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    expectedSceneDigest: Digest.optional(),
  })
  .strict();

export const AdobeCommandEnvelopeSchema = z
  .object({
    version: z.literal(1),
    commandId: Identifier,
    nonce: Identifier,
    sceneDigest: Digest,
    deviceId: Identifier,
    jobId: Identifier,
    projectHandle: z.literal("project:working-copy"),
    tool: z.enum(TOOL_NAMES),
    args: ApprovedArgsSchema,
  })
  .strict();

export type AdobeCommandEnvelope = z.infer<typeof AdobeCommandEnvelopeSchema>;
export const StoredCommandSchema = AdobeCommandEnvelopeSchema.extend({
  status: z.enum(["QUEUED", "RUNNING"]),
});

export const AdobeCommandResultSchema = z
  .object({
    version: z.literal(1),
    commandId: Identifier,
    nonce: Identifier,
    sceneDigest: Digest,
    status: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
    beforeDigest: Digest,
    afterDigest: Digest,
    changedFields: z.array(z.string()).max(500),
    warnings: z.array(z.string().max(500)).max(50),
    payload: z.record(z.string(), JsonValue),
  })
  .strict();

export type AdobeCommandResult = z.infer<typeof AdobeCommandResultSchema>;

export const AdobeCapabilitySnapshotSchema = z
  .object({
    version: z.literal(1),
    deviceId: Identifier,
    afterEffectsVersion: z.string().min(1),
    tools: z.array(z.enum(TOOL_NAMES)).length(TOOL_NAMES.length),
    pollingIntervalMs: z.literal(2000),
    maxConcurrentMutations: z.literal(1),
    arbitraryScripts: z.literal(false),
    rawExpressions: z.literal(false),
    rawPresetPaths: z.literal(false),
  })
  .strict();

export type QueuedCommand = AdobeCommandEnvelope & {
  readonly status: "QUEUED";
};
export type RunningCommand = AdobeCommandEnvelope & {
  readonly status: "RUNNING";
};
