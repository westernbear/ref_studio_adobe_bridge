import { createHash, verify } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { z } from "zod";

const INSTALL_FILES = [
  "scripts/panel/RVSBridgePanel.jsx",
  "scripts/extendscript/rvs-dispatcher.jsx",
] as const;
const TARGET_FILES = ["RVSBridgePanel.jsx", "rvs-dispatcher.jsx"] as const;
const SUPPORTED_AE_VERSIONS = ["2024", "2025", "2026"] as const;
const PLATFORM_NAMES = ["darwin", "linux", "win32"] as const;

type AdobePlatform = (typeof PLATFORM_NAMES)[number];

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ManifestSchema = z
  .object({
    version: z.literal(1),
    afterEffectsVersions: z
      .array(z.enum(SUPPORTED_AE_VERSIONS))
      .min(1)
      .max(SUPPORTED_AE_VERSIONS.length)
      .refine((versions) => new Set(versions).size === versions.length),
    files: z.tuple([
      z
        .object({ path: z.literal(INSTALL_FILES[0]), sha256: HashSchema })
        .strict(),
      z
        .object({ path: z.literal(INSTALL_FILES[1]), sha256: HashSchema })
        .strict(),
    ]),
    signature: z.string().min(1),
  })
  .strict();

type InstallerManifest = z.infer<typeof ManifestSchema>;

export class SignatureError extends Error {
  public override readonly name = "SignatureError";
  public constructor() {
    super("installer manifest signature is invalid");
  }
}

export class InstallerValidationError extends Error {
  public override readonly name = "InstallerValidationError";
  public constructor(readonly reason: string) {
    super(`installer manifest is invalid: ${reason}`);
  }
}

export class InstallerRollbackError extends Error {
  public override readonly name = "InstallerRollbackError";
  public constructor(readonly originalCause: unknown) {
    super("installer failed and destination was restored", {
      cause: originalCause,
    });
  }
}

const manifestPayload = (manifest: InstallerManifest): string =>
  JSON.stringify({
    version: manifest.version,
    afterEffectsVersions: manifest.afterEffectsVersions,
    files: manifest.files,
  });
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const rootName = (root: string): string =>
  root.includes("\\") ? win32.basename(root) : basename(root);
const targetPath = (destination: string, index: number): string =>
  join(destination, TARGET_FILES[index] ?? "");

const versionFromRoot = (
  root: string,
): (typeof SUPPORTED_AE_VERSIONS)[number] => {
  switch (rootName(root)) {
    case "Adobe After Effects 2024":
      return "2024";
    case "Adobe After Effects 2025":
      return "2025";
    case "Adobe After Effects 2026":
      return "2026";
    default:
      throw new InstallerValidationError("unsupported After Effects root");
  }
};

const readExisting = async (path: string): Promise<Buffer | null> => {
  try {
    return await readFile(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    )
      return null;
    throw error;
  }
};

const restoreDestination = async (
  destination: string,
  previous: readonly (Buffer | null)[],
): Promise<void> => {
  await Promise.all(
    previous.map(async (content, index) => {
      const path = targetPath(destination, index);
      if (content === null) {
        await rm(path, { force: true });
        return;
      }
      await writeFile(path, content, { mode: 0o644 });
    }),
  );
};

export const supportedAfterEffectsRoots = (
  platform: AdobePlatform,
  homeDirectory: string,
  programFilesDirectory: string,
): readonly string[] => {
  const parent =
    platform === "darwin"
      ? join(homeDirectory, "Applications")
      : platform === "linux"
        ? join(homeDirectory, ".wine", "drive_c", "Program Files", "Adobe")
        : join(programFilesDirectory, "Adobe");
  return SUPPORTED_AE_VERSIONS.map((version) =>
    join(parent, `Adobe After Effects ${version}`),
  );
};

export const discoverInstalledAfterEffectsRoots = async (
  platform: AdobePlatform,
  homeDirectory: string,
  programFilesDirectory: string,
): Promise<readonly string[]> => {
  const candidates = supportedAfterEffectsRoots(
    platform,
    homeDirectory,
    programFilesDirectory,
  );
  const installed = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return (await stat(candidate)).isDirectory() ? candidate : null;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }
    }),
  );
  return installed.filter(
    (candidate): candidate is string => candidate !== null,
  );
};

export const installSignedPanel = async (
  sourceRoot: string,
  afterEffectsRoot: string,
  input: unknown,
  releasePublicKey: string,
): Promise<void> => {
  const manifest = ManifestSchema.parse(input);
  const rootVersion = versionFromRoot(afterEffectsRoot);
  if (!manifest.afterEffectsVersions.includes(rootVersion))
    throw new InstallerValidationError(
      "release does not support this After Effects version",
    );
  if (
    !verify(
      null,
      Buffer.from(manifestPayload(manifest)),
      releasePublicKey,
      Buffer.from(manifest.signature, "base64"),
    )
  )
    throw new SignatureError();
  const sourceFiles = await Promise.all(
    manifest.files.map(async (file) => {
      const path = join(sourceRoot, file.path);
      const details = await stat(path);
      if (!details.isFile())
        throw new InstallerValidationError(
          `release file is not regular: ${file.path}`,
        );
      const content = await readFile(path);
      if (digest(content) !== file.sha256)
        throw new InstallerValidationError(
          `release file hash mismatch: ${file.path}`,
        );
      return content;
    }),
  );
  const destination = join(afterEffectsRoot, "Scripts", "ScriptUI Panels");
  await mkdir(destination, { recursive: true, mode: 0o755 });
  await chmod(destination, 0o755);
  const stage = await mkdtemp(join(tmpdir(), "rvs-adobe-install-"));
  const previous = await Promise.all(
    TARGET_FILES.map((file) => readExisting(join(destination, file))),
  );
  try {
    await Promise.all(
      sourceFiles.map((content, index) =>
        writeFile(targetPath(stage, index), content, { mode: 0o644 }),
      ),
    );
    await Promise.all(
      TARGET_FILES.map((_, index) => chmod(targetPath(stage, index), 0o644)),
    );
    for (const [index] of TARGET_FILES.entries())
      await rename(targetPath(stage, index), targetPath(destination, index));
  } catch (error) {
    try {
      await restoreDestination(destination, previous);
    } catch (restoreError) {
      throw new InstallerRollbackError(restoreError);
    }
    throw new InstallerRollbackError(error);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};
