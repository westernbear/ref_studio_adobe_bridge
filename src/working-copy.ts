import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const IdentifierSchema = z.string().regex(/^[A-Za-z0-9._-]{3,128}$/u);
const OutputNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+\.mp4$/u);
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ProbeSchema = z
  .object({
    streams: z
      .array(
        z.object({
          codec_type: z.string(),
          codec_name: z.string().optional(),
          profile: z.string().optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          nb_frames: z.string().regex(/^\d+$/u).optional(),
          avg_frame_rate: z
            .string()
            .regex(/^\d+\/\d+$/u)
            .optional(),
          duration: z.string().optional(),
        }),
      )
      .min(1),
    format: z.object({ duration: z.string() }),
  })
  .passthrough();
const MAX_MP4_BYTES = 2_147_483_648;
const MAX_RENDER_MS = 15 * 60_000;

type RenderRequest = {
  readonly compHandle: string;
  readonly outputPath: string;
  readonly workingCopyPath: string;
  readonly signal: AbortSignal;
};

export type LocalRenderAdapter = {
  readonly render: (request: RenderRequest) => Promise<void>;
};

export type LocalUploadAdapter = {
  readonly upload: (
    localPath: string,
    authorization: string,
  ) => Promise<{ readonly uploadId: string }>;
};

export class LocalProgramRenderAdapter implements LocalRenderAdapter {
  public constructor(private readonly executable: string) {}

  public async render(request: RenderRequest): Promise<void> {
    await execFileAsync(
      this.executable,
      [request.workingCopyPath, request.compHandle, request.outputPath],
      { maxBuffer: 1_048_576, signal: request.signal },
    );
  }
}

export class LocalProgramUploadAdapter implements LocalUploadAdapter {
  public constructor(private readonly executable: string) {}

  public async upload(
    localPath: string,
    authorization: string,
  ): Promise<{ readonly uploadId: string }> {
    const { stdout } = await execFileAsync(this.executable, [localPath], {
      maxBuffer: 1_048_576,
      env: { ...process.env, RVS_CONNECTOR_AUTHORIZATION: authorization },
    });
    return z
      .object({ uploadId: IdentifierSchema })
      .strict()
      .parse(JSON.parse(stdout));
  }
}

type OriginalBinding = {
  readonly originalPath: string;
  readonly originalSha256: string;
  readonly originalMode: number;
};

export class AdobeWorkingCopyError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "AdobeWorkingCopyError";
  }
}

const sha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const boundedPath = (parent: string, child: string): string => {
  const target = resolve(parent, child);
  if (!target.startsWith(`${resolve(parent)}${sep}`))
    throw new AdobeWorkingCopyError("ADOBE_PATH_BINDING_REJECTED");
  return target;
};

export class AdobeWorkingCopy {
  readonly #jobRoot: string;
  readonly #binding: OriginalBinding;
  public readonly path: string;

  private constructor(jobRoot: string, path: string, binding: OriginalBinding) {
    this.#jobRoot = jobRoot;
    this.path = path;
    this.#binding = binding;
  }

  public static async open(
    root: string,
    jobIdInput: string,
    originalInput: string,
  ): Promise<AdobeWorkingCopy> {
    const jobId = IdentifierSchema.parse(jobIdInput);
    const originalPath = await realpath(originalInput);
    const source = await stat(originalPath);
    if (!source.isFile())
      throw new AdobeWorkingCopyError("ADOBE_ORIGINAL_NOT_FILE");
    const handle = await open(originalPath, "r");
    await handle.close();
    const jobRoot = boundedPath(root, jobId);
    await mkdir(jobRoot, { recursive: true, mode: 0o700 });
    const path = join(jobRoot, "project.rvs-working-copy.aep");
    const binding = {
      originalPath,
      originalSha256: await sha256(originalPath),
      originalMode: source.mode & 0o777,
    } satisfies OriginalBinding;
    const bindingPath = join(jobRoot, "original-binding.json");
    try {
      const existing = z
        .object({
          originalPath: z.string(),
          originalSha256: DigestSchema,
          originalMode: z.number().int().nonnegative(),
        })
        .strict()
        .parse(JSON.parse(await readFile(bindingPath, "utf8")));
      if (JSON.stringify(existing) !== JSON.stringify(binding))
        throw new AdobeWorkingCopyError("ADOBE_ORIGINAL_BINDING_MISMATCH");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      await copyFile(originalPath, path);
      await chmod(path, 0o600);
      await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    }
    return new AdobeWorkingCopy(jobRoot, path, binding);
  }

  public async assertOriginalUnchanged(): Promise<void> {
    const current = await stat(this.#binding.originalPath);
    if (
      (current.mode & 0o777) !== this.#binding.originalMode ||
      (await sha256(this.#binding.originalPath)) !==
        this.#binding.originalSha256
    )
      throw new AdobeWorkingCopyError("ADOBE_ORIGINAL_CHANGED");
  }

  public async snapshot(sceneDigestInput: string): Promise<void> {
    const sceneDigest = DigestSchema.parse(sceneDigestInput);
    await this.assertOriginalUnchanged();
    const snapshot = join(this.#jobRoot, `safe-${sceneDigest}.aep`);
    await copyFile(this.path, snapshot);
    await chmod(snapshot, 0o600);
  }

  public async rollback(sceneDigestInput: string): Promise<{
    readonly beforeDigest: string;
    readonly afterDigest: string;
  }> {
    const sceneDigest = DigestSchema.parse(sceneDigestInput);
    const beforeDigest = await sha256(this.path);
    await copyFile(join(this.#jobRoot, `safe-${sceneDigest}.aep`), this.path);
    await chmod(this.path, 0o600);
    await this.assertOriginalUnchanged();
    return { beforeDigest, afterDigest: await sha256(this.path) };
  }

  public async renderUpload(
    input: { readonly compHandle: string; readonly outputName: string },
    renderer: LocalRenderAdapter,
    uploader: LocalUploadAdapter,
    connectorAuthorization: string,
  ): Promise<{
    readonly uploadId: string;
    readonly mp4: {
      readonly sha256: string;
      readonly codec: "h264";
      readonly profile: "High";
      readonly frameCount: number;
      readonly durationSeconds: number;
      readonly width: number;
      readonly height: number;
    };
  }> {
    if (!/^comp:[1-9]\d*$/u.test(input.compHandle))
      throw new AdobeWorkingCopyError("ADOBE_COMP_HANDLE_REJECTED");
    const outputName = OutputNameSchema.parse(input.outputName);
    if (connectorAuthorization.length < 8)
      throw new AdobeWorkingCopyError("ADOBE_UPLOAD_AUTH_MISSING");
    const outputPath = boundedPath(join(this.#jobRoot, "renders"), outputName);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_RENDER_MS);
    try {
      await renderer.render({
        compHandle: input.compHandle,
        outputPath,
        workingCopyPath: this.path,
        signal: controller.signal,
      });
      const output = await stat(outputPath);
      if (!output.isFile() || output.size <= 0 || output.size > MAX_MP4_BYTES)
        throw new AdobeWorkingCopyError("ADOBE_RENDER_SIZE_REJECTED");
      const { stdout } = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          outputPath,
        ],
        { maxBuffer: 1_048_576, signal: controller.signal },
      );
      const probe = ProbeSchema.parse(JSON.parse(stdout));
      const video = probe.streams.find(
        (stream) => stream.codec_type === "video",
      );
      if (
        video?.codec_name !== "h264" ||
        video.profile !== "High" ||
        video.width === undefined ||
        video.height === undefined
      )
        throw new AdobeWorkingCopyError("ADOBE_RENDER_CODEC_REJECTED");
      const durationSeconds = Number(video.duration ?? probe.format.duration);
      const frameCount = Number(video.nb_frames);
      if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        !Number.isSafeInteger(frameCount) ||
        frameCount <= 0
      )
        throw new AdobeWorkingCopyError("ADOBE_RENDER_TIMING_REJECTED");
      const uploaded = await uploader.upload(
        outputPath,
        connectorAuthorization,
      );
      await this.assertOriginalUnchanged();
      return {
        uploadId: IdentifierSchema.parse(uploaded.uploadId),
        mp4: {
          sha256: await sha256(outputPath),
          codec: "h264",
          profile: "High",
          frameCount,
          durationSeconds,
          width: video.width,
          height: video.height,
        },
      };
    } catch (error) {
      await this.assertOriginalUnchanged();
      await rm(outputPath, { force: true });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
