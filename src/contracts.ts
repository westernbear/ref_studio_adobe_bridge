import { z } from "zod";

// allow: SIZE_OK — generated from the indivisible root Adobe MCP v1 schema table.

export const ADOBE_TOOL_NAMES_V1 = [
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

const IdentifierSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z0-9:._-]+$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const HandleSchema = (prefix: string) =>
  z
    .string()
    .min(3)
    .max(128)
    .regex(new RegExp(`^${prefix}:[1-9][0-9]*$`, "u"));
const CompHandleSchema = HandleSchema("comp");
const LayerHandleSchema = HandleSchema("layer");
const FiniteSchema = z.number().finite();
const ColorSchema = z.tuple([
  FiniteSchema.min(0).max(1),
  FiniteSchema.min(0).max(1),
  FiniteSchema.min(0).max(1),
]);
export const ADOBE_PROPERTY_IDS_V1 = [
  "ADBE Anchor Point",
  "ADBE Position",
  "ADBE Scale",
  "ADBE Rotate Z",
  "ADBE Opacity",
] as const;
const PropertyIdSchema = z.enum(ADOBE_PROPERTY_IDS_V1);
const PropertyValueSchema = z.union([
  FiniteSchema,
  z.tuple([FiniteSchema, FiniteSchema]),
  z.tuple([FiniteSchema, FiniteSchema, FiniteSchema]),
]);
const PropertiesSchema = z.partialRecord(PropertyIdSchema, PropertyValueSchema);
const EmptyArgsSchema = z.object({}).strict();
const CompArgsSchema = z.object({ compHandle: CompHandleSchema }).strict();
const LayerArgsSchema = z
  .object({ compHandle: CompHandleSchema, layerHandle: LayerHandleSchema })
  .strict();
const CompositionFieldsSchema = {
  width: FiniteSchema.int().min(1).max(32_768),
  height: FiniteSchema.int().min(1).max(32_768),
  durationSeconds: FiniteSchema.positive().max(86_400),
  frameRate: FiniteSchema.positive().max(240),
} as const;
const KeyframeSchema = z
  .object({
    property: PropertyIdSchema,
    frame: FiniteSchema.int().nonnegative().max(21_600_000),
    value: PropertyValueSchema,
    easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]),
  })
  .strict();

const command = <T extends string, A extends z.ZodType>(tool: T, args: A) =>
  z
    .object({
      version: z.literal(1),
      commandId: IdentifierSchema,
      nonce: IdentifierSchema,
      sceneDigest: DigestSchema,
      deviceId: IdentifierSchema,
      jobId: IdentifierSchema,
      projectHandle: z.literal("project:working-copy"),
      tool: z.literal(tool),
      args,
    })
    .strict();

export const AdobeCommandEnvelopeV1Schema = z.discriminatedUnion("tool", [
  command("adobe.project.get_v1", EmptyArgsSchema),
  command("adobe.composition.list_v1", EmptyArgsSchema),
  command(
    "adobe.composition.create_v1",
    z
      .object({
        name: z.string().min(1).max(200),
        ...CompositionFieldsSchema,
      })
      .strict(),
  ),
  command(
    "adobe.composition.update_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        width: CompositionFieldsSchema.width.optional(),
        height: CompositionFieldsSchema.height.optional(),
        durationSeconds: CompositionFieldsSchema.durationSeconds.optional(),
        frameRate: CompositionFieldsSchema.frameRate.optional(),
      })
      .strict(),
  ),
  command("adobe.layer.get_v1", LayerArgsSchema),
  command(
    "adobe.layer.create_text_v1",
    z
      .object({ compHandle: CompHandleSchema, text: z.string().max(20_000) })
      .strict(),
  ),
  command(
    "adobe.layer.create_shape_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        shape: z.enum(["rectangle", "ellipse", "polygon"]),
        color: ColorSchema,
      })
      .strict(),
  ),
  command(
    "adobe.layer.create_solid_v1",
    z.object({ compHandle: CompHandleSchema, color: ColorSchema }).strict(),
  ),
  command("adobe.layer.create_camera_v1", CompArgsSchema),
  command("adobe.layer.create_null_v1", CompArgsSchema),
  command("adobe.layer.duplicate_v1", LayerArgsSchema),
  command("adobe.layer.delete_v1", LayerArgsSchema),
  command(
    "adobe.layer.set_properties_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layerHandle: LayerHandleSchema,
        properties: PropertiesSchema,
      })
      .strict(),
  ),
  command(
    "adobe.layer.batch_set_properties_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layers: z
          .array(
            z
              .object({
                layerHandle: LayerHandleSchema,
                properties: PropertiesSchema,
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
  ),
  command(
    "adobe.animation.set_keyframes_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layerHandle: LayerHandleSchema,
        keyframes: z.array(KeyframeSchema).min(1).max(500),
      })
      .strict(),
  ),
  command(
    "adobe.mask.set_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layerHandle: LayerHandleSchema,
        mode: z.enum(["add", "subtract", "intersect"]),
        vertices: z
          .array(z.tuple([FiniteSchema, FiniteSchema]))
          .min(3)
          .max(500),
      })
      .strict(),
  ),
  command(
    "adobe.effect.apply_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layerHandle: LayerHandleSchema,
        effectId: z.literal("ADBE Drop Shadow"),
      })
      .strict(),
  ),
  command(
    "adobe.effect.apply_template_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layerHandle: LayerHandleSchema,
        templateId: z.literal("drop-shadow-v1"),
      })
      .strict(),
  ),
  command(
    "adobe.expression.apply_template_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layerHandle: LayerHandleSchema,
        templateId: z.literal("loop-cycle-v1"),
        propertyId: PropertyIdSchema,
      })
      .strict(),
  ),
  command(
    "adobe.expression.remove_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        layerHandle: LayerHandleSchema,
        propertyId: PropertyIdSchema,
      })
      .strict(),
  ),
  command(
    "adobe.command.status_v1",
    z.object({ targetCommandId: IdentifierSchema }).strict(),
  ),
  command(
    "adobe.command.cancel_v1",
    z.object({ targetCommandId: IdentifierSchema }).strict(),
  ),
  command(
    "adobe.verify_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        expectedSceneDigest: DigestSchema,
      })
      .strict(),
  ),
  command(
    "adobe.render_upload_v1",
    z
      .object({
        compHandle: CompHandleSchema,
        outputName: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._-]+$/u),
      })
      .strict(),
  ),
  command(
    "adobe.rollback_v1",
    z.object({ expectedSceneDigest: DigestSchema }).strict(),
  ),
]);
export type AdobeCommandEnvelopeV1 = z.infer<
  typeof AdobeCommandEnvelopeV1Schema
>;

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    FiniteSchema,
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
export const AdobeCommandResultV1Schema = z
  .object({
    version: z.literal(1),
    commandId: IdentifierSchema,
    nonce: IdentifierSchema,
    sceneDigest: DigestSchema,
    deviceId: IdentifierSchema,
    jobId: IdentifierSchema,
    status: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
    beforeDigest: DigestSchema,
    afterDigest: DigestSchema,
    changedFields: z.array(z.string().min(1).max(256)).max(500),
    warnings: z.array(z.string().max(500)).max(50),
    payload: z.record(z.string(), JsonValueSchema),
    mp4: z
      .object({
        sha256: DigestSchema,
        codec: z.literal("h264"),
        profile: z.literal("High"),
        frameCount: FiniteSchema.int().positive(),
        durationSeconds: FiniteSchema.positive(),
        width: FiniteSchema.int().positive(),
        height: FiniteSchema.int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AdobeCommandResultV1 = z.infer<typeof AdobeCommandResultV1Schema>;

export const AdobeCapabilitySnapshotV1Schema = z
  .object({
    version: z.literal(1),
    deviceId: IdentifierSchema,
    afterEffectsVersion: z.string().min(1).max(64),
    capturedAt: z.string().datetime(),
    tools: z
      .array(z.enum(ADOBE_TOOL_NAMES_V1))
      .length(ADOBE_TOOL_NAMES_V1.length),
    pollingIntervalMs: z.literal(2_000),
    maxConcurrentMutations: z.literal(1),
    arbitraryScripts: z.literal(false),
    rawExpressions: z.literal(false),
    rawPresetPaths: z.literal(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.tools.join("\0") !== ADOBE_TOOL_NAMES_V1.join("\0"))
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "tools must match the ordered Adobe MCP v1 tool set",
      });
  });
export type AdobeCapabilitySnapshotV1 = z.infer<
  typeof AdobeCapabilitySnapshotV1Schema
>;

// Runtime names stay stable while their wire format is the shared V1 contract.
export const TOOL_NAMES = ADOBE_TOOL_NAMES_V1;
export const PROPERTY_IDS = ADOBE_PROPERTY_IDS_V1;
export const AdobeCommandEnvelopeSchema = AdobeCommandEnvelopeV1Schema;
export type AdobeCommandEnvelope = AdobeCommandEnvelopeV1;
export const AdobeCommandResultSchema = AdobeCommandResultV1Schema;
export type AdobeCommandResult = AdobeCommandResultV1;
export const AdobeCapabilitySnapshotSchema = AdobeCapabilitySnapshotV1Schema;
export const StoredCommandSchema = AdobeCommandEnvelopeV1Schema.and(
  z.object({ status: z.enum(["QUEUED", "RUNNING"]) }).passthrough(),
);
export type QueuedCommand = AdobeCommandEnvelopeV1 & {
  readonly status: "QUEUED";
};
export type RunningCommand = AdobeCommandEnvelopeV1 & {
  readonly status: "RUNNING";
};
