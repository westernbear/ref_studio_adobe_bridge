import type { AdobeCommandEnvelope, AdobeCommandResult } from "./contracts.js";
import { AdobeCommandResultSchema } from "./contracts.js";
import type {
  AdobeWorkingCopy,
  LocalRenderAdapter,
  LocalUploadAdapter,
} from "./working-copy.js";

type ExecutionContext = {
  readonly project: AdobeWorkingCopy;
  readonly renderer: LocalRenderAdapter;
  readonly uploader: LocalUploadAdapter;
  readonly connectorAuthorization: string;
};

export const finalizePanelResult = async (
  command: AdobeCommandEnvelope,
  panelResultInput: unknown,
  context: ExecutionContext,
): Promise<AdobeCommandResult> => {
  const panelResult = AdobeCommandResultSchema.parse(panelResultInput);
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
    return AdobeCommandResultSchema.parse({
      ...panelResult,
      beforeDigest: rollback.beforeDigest,
      afterDigest: rollback.afterDigest,
      payload: { ...panelResult.payload, rolledBack: true },
    });
  }
  if (command.tool === "adobe.render_upload_v1") {
    const rendered = await context.project.renderUpload(
      command.args,
      context.renderer,
      context.uploader,
      context.connectorAuthorization,
    );
    return AdobeCommandResultSchema.parse({
      ...panelResult,
      payload: { uploadId: rendered.uploadId },
      mp4: rendered.mp4,
    });
  }
  await context.project.assertOriginalUnchanged();
  return panelResult;
};
