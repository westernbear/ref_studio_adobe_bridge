import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { finalizePanelResult } from "../src/execution.js";
import { AdobeWorkingCopy } from "../src/working-copy.js";

const base = {
  version: 1 as const,
  commandId: "cmd-execution-1",
  nonce: "nonce-execution-1",
  sceneDigest: "a".repeat(64),
  deviceId: "device-execution",
  jobId: "job-execution",
  projectHandle: "project:working-copy" as const,
};

test("finalizes the P4.5 render plan with local render and connector upload", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const original = join(root, "source.aep");
  await writeFile(original, "ORIGINAL");
  const project = await AdobeWorkingCopy.open(root, base.jobId, original);
  const command = {
    ...base,
    tool: "adobe.render_upload_v1" as const,
    args: { compHandle: "comp:1", outputName: "delivery.mp4" },
  };
  const result = await finalizePanelResult(
    command,
    {
      version: 1,
      commandId: base.commandId,
      nonce: base.nonce,
      sceneDigest: base.sceneDigest,
      deviceId: base.deviceId,
      jobId: base.jobId,
      status: "SUCCEEDED",
      beforeDigest: base.sceneDigest,
      afterDigest: base.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {
        queued: true,
        renderPlan: { compHandle: "comp:1", uploadByConnector: true },
      },
    },
    {
      project,
      renderer: {
        render: async ({ outputPath }) => {
          await Bun.$`ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=320x240:r=30:d=1 -c:v libx264 -profile:v high -pix_fmt yuv420p -an -y ${outputPath}`;
        },
      },
      uploader: {
        upload: async (_path, authorization) => {
          expect(authorization).toBe("local-connector-secret");
          return { uploadId: "upl-adobe-local" };
        },
      },
      connectorAuthorization: "local-connector-secret",
    },
  );
  expect(result.payload).toEqual({ uploadId: "upl-adobe-local" });
  expect(result.mp4).toMatchObject({ codec: "h264", frameCount: 30 });
  expect(JSON.stringify(result)).not.toContain("local-connector-secret");
});
