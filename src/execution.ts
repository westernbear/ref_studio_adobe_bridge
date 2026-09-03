import type {
  AdobeCommandEnvelopeV1,
  AdobeCommandResultV1,
} from "./contracts.js";
import { AdobeCommandResultV1Schema } from "./contracts.js";
import type { AdobeWorkingCopy } from "./working-copy.js";

type ExecutionContext = {
  readonly project: AdobeWorkingCopy;
  readonly renderProgram: string | undefined;
  readonly uploadProgram: string | undefined;
  readonly connectorAuthorization: string;
};

export const finalizePanelResult = async (
  command: AdobeCommandEnvelopeV1,
  panelResultInput: unknown,
  context: ExecutionContext,
): Promise<AdobeCommandResultV1> => {
  const panelResult = AdobeCommandResultV1Schema.parse(panelResultInput);
  if (
    panelResult.commandId !== command.commandId ||
    panelResult.nonce !== command.nonce ||
    panelResult.deviceId !== command.deviceId ||
    panelResult.jobId !== command.jobId
  )
    throw new TypeError("panel result binding mismatch");
  if (panelResult.status !== "SUCCEEDED") {
    await context.project.assertOriginalUnchanged();
    return panelResult;
  }
  if (command.tool === "adobe.rollback_v1") {
    const rollback = await context.project.rollback(
      command.args.expectedSceneDigest,
    );
    return AdobeCommandResultV1Schema.parse({
      ...panelResult,
      beforeDigest: rollback.beforeDigest,
      afterDigest: rollback.afterDigest,
      payload: { ...panelResult.payload, rolledBack: true },
    });
  }
  if (command.tool === "adobe.render_upload_v1") {
    if (
      context.renderProgram === undefined ||
      context.uploadProgram === undefined
    )
      throw new TypeError("local render/upload configuration is required");
    const rendered = await context.project.renderUpload(
      command.args,
      {
        renderProgram: context.renderProgram,
        uploadProgram: context.uploadProgram,
      },
      context.connectorAuthorization,
    );
    return AdobeCommandResultV1Schema.parse({
      ...panelResult,
      payload: { uploadId: rendered.uploadId },
      mp4: rendered.mp4,
    });
  }
  await context.project.assertOriginalUnchanged();
  return panelResult;
};
