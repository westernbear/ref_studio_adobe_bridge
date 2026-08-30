import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdobeWorkingCopy,
  type LocalRenderAdapter,
  type LocalUploadAdapter,
} from "../src/working-copy.js";

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test("working copy preserves original and rolls back to the last safe snapshot", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const original = join(root, "source.aep");
  await writeFile(original, "ORIGINAL", { mode: 0o640 });
  const originalMode = (await stat(original)).mode & 0o777;
  const project = await AdobeWorkingCopy.open(root, "job-a", original);
  expect(project.path).toBe(
    join(root, "job-a", "project.rvs-working-copy.aep"),
  );
  expect(await sha256(original)).toBe(await sha256(project.path));
  await project.snapshot("a".repeat(64));
  await chmod(project.path, 0o600);
  await writeFile(project.path, "MUTATED");
  const result = await project.rollback("a".repeat(64));
  expect(await readFile(project.path, "utf8")).toBe("ORIGINAL");
  expect(result.beforeDigest).not.toBe(result.afterDigest);
  expect(result.afterDigest).toBe("a".repeat(64));
  expect(await readFile(original, "utf8")).toBe("ORIGINAL");
  expect((await stat(original)).mode & 0o777).toBe(originalMode);
  await project.assertOriginalUnchanged();
});

test("render validates real MP4 metadata and uploads with connector-owned authentication", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const original = join(root, "source.aep");
  await writeFile(original, "ORIGINAL", { mode: 0o600 });
  const project = await AdobeWorkingCopy.open(root, "job-render", original);
  const render: LocalRenderAdapter = {
    render: async ({ outputPath }) => {
      await Bun.$`ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=320x240:r=30:d=1 -c:v libx264 -profile:v high -pix_fmt yuv420p -an -y ${outputPath}`;
    },
  };
  const uploads: Array<{ path: string; authorization: string }> = [];
  const upload: LocalUploadAdapter = {
    upload: async (path, authorization) => {
      uploads.push({ path, authorization });
      return { uploadId: "upl-local-1" };
    },
  };
  const result = await project.renderUpload(
    { compHandle: "comp:1", outputName: "delivery.mp4" },
    render,
    upload,
    "connector-secret",
  );
  expect(result.mp4).toMatchObject({
    codec: "h264",
    profile: "High",
    frameCount: 30,
    durationSeconds: 1,
    width: 320,
    height: 240,
  });
  expect(uploads).toHaveLength(1);
  expect(uploads[0]?.authorization).toBe("connector-secret");
  expect(JSON.stringify(result)).not.toContain("connector-secret");
  await project.assertOriginalUnchanged();
});

test("rejects traversal, credential-shaped render input, and false-success output", async () => {
  const root = await Bun.$`mktemp -d`.text().then((value) => value.trim());
  const original = join(root, "source.aep");
  await writeFile(original, "ORIGINAL");
  expect(AdobeWorkingCopy.open(root, "../escape", original)).rejects.toThrow();
  const project = await AdobeWorkingCopy.open(root, "job-fail", original);
  await mkdir(join(root, "fake"), { recursive: true });
  const render: LocalRenderAdapter = {
    render: async ({ outputPath }) => writeFile(outputPath, "not-an-mp4"),
  };
  const upload: LocalUploadAdapter = {
    upload: async () => ({ uploadId: "upl-never" }),
  };
  await expect(
    project.renderUpload(
      { compHandle: "comp:1", outputName: "../secret.mp4" },
      render,
      upload,
      "secret",
    ),
  ).rejects.toThrow();
  await expect(
    project.renderUpload(
      { compHandle: "comp:1", outputName: "bad.mp4" },
      render,
      upload,
      "secret",
    ),
  ).rejects.toThrow();
  await project.assertOriginalUnchanged();
});
