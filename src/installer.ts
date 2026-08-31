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
import { basename, join, win32 } from "node:path";
import { z } from "zod";

const INSTALL_FILES = [
  "scripts/panel/RVSBridgePanel.jsx",
  "scripts/extendscript/rvs-dispatcher.jsx",
] as const;
const TARGET_FILES = ["RVSBridgePanel.jsx", "rvs-dispatcher.jsx"] as const;
/** Stable ScriptUI entry AE discovers; resolves RVSBridge/current.json. */
export const DIRECT_PANEL_FILE = "RVSBridgePanel.jsx";
const DIRECT_PANEL_LOADER = [
  "(function () {",
  "  var panels = File($.fileName).parent;",
  '  var pointer = File(panels.fullName + "/RVSBridge/current.json");',
  '  if (!pointer.exists) throw new Error("RVSBridge current.json missing");',
  '  if (!pointer.open("r")) throw new Error("RVSBridge current.json unreadable");',
  "  var raw = pointer.read();",
  "  pointer.close();",
  "  var active = JSON.parse(raw);",
  '  if (!active || typeof active.release !== "string") throw new Error("RVSBridge current.json invalid");',
  '  var panel = File(panels.fullName + "/RVSBridge/releases/" + active.release + "/RVSBridgePanel.jsx");',
  '  if (!panel.exists) throw new Error("RVSBridge release panel missing");',
  "  $.evalFile(panel);",
  "}());",
  "",
].join("\n");
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
      .max(3)
      .refine((value) => new Set(value).size === value.length),
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
const PointerSchema = z.object({ release: HashSchema }).strict();
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
export class InstallerInterruptedError extends Error {
  public override readonly name = "InstallerInterruptedError";
  public constructor() {
    super("installer interrupted before release activation");
  }
}

const payload = (manifest: InstallerManifest): string =>
  JSON.stringify({
    version: manifest.version,
    afterEffectsVersions: manifest.afterEffectsVersions,
    files: manifest.files,
  });
const hash = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const rootPlatform = (root: string): AdobePlatform =>
  root.includes("\\")
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
const rootName = (root: string): string =>
  rootPlatform(root) === "win32" ? win32.basename(root) : basename(root);
const rootVersion = (root: string): (typeof SUPPORTED_AE_VERSIONS)[number] => {
  if (
    rootPlatform(root) === "win32" &&
    (root.includes("/") ||
      win32.normalize(root) !== root ||
      !/^[A-Za-z]:\\/.test(root))
  )
    throw new InstallerValidationError(
      "non-canonical Windows After Effects root",
    );
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
const platformJoin = (
  platform: AdobePlatform,
  ...parts: readonly string[]
): string => (platform === "win32" ? win32.join(...parts) : join(...parts));

export const supportedAfterEffectsRoots = (
  platform: AdobePlatform,
  homeDirectory: string,
  programFilesDirectory: string,
): readonly string[] => {
  const parent =
    platform === "darwin"
      ? platformJoin(platform, homeDirectory, "Applications")
      : platform === "linux"
        ? platformJoin(
            platform,
            homeDirectory,
            ".wine",
            "drive_c",
            "Program Files",
            "Adobe",
          )
        : platformJoin(platform, programFilesDirectory, "Adobe");
  return SUPPORTED_AE_VERSIONS.map((version) =>
    platformJoin(platform, parent, `Adobe After Effects ${version}`),
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
  const found = await Promise.all(
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
  return found.filter((candidate): candidate is string => candidate !== null);
};

const scriptUiPanels = (afterEffectsRoot: string): string =>
  join(afterEffectsRoot, "Scripts", "ScriptUI Panels");
const releaseRoot = (destination: string): string =>
  join(destination, "RVSBridge");
const pointerPath = (destination: string): string =>
  join(releaseRoot(destination), "current.json");
const releasePath = (destination: string, release: string): string =>
  join(releaseRoot(destination), "releases", release);

export const directPanelEntryPath = (afterEffectsRoot: string): string =>
  join(scriptUiPanels(afterEffectsRoot), DIRECT_PANEL_FILE);

export const activeSignedPanelRelease = async (
  afterEffectsRoot: string,
): Promise<string | null> => {
  const destination = scriptUiPanels(afterEffectsRoot);
  try {
    return PointerSchema.parse(
      JSON.parse(await readFile(pointerPath(destination), "utf8")),
    ).release;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
};

const activateDirectPanelLoader = async (
  destination: string,
  release: string,
): Promise<void> => {
  const loaderStage = join(destination, `.${DIRECT_PANEL_FILE}-${release}.tmp`);
  await writeFile(loaderStage, DIRECT_PANEL_LOADER, { mode: 0o644 });
  await chmod(loaderStage, 0o644);
  await rename(loaderStage, join(destination, DIRECT_PANEL_FILE));
};

export const installSignedPanel = async (
  sourceRoot: string,
  afterEffectsRoot: string,
  input: unknown,
  releasePublicKey: string,
  options: { readonly interruptBeforeActivation?: boolean } = {},
): Promise<void> => {
  const manifest = ManifestSchema.parse(input);
  if (!manifest.afterEffectsVersions.includes(rootVersion(afterEffectsRoot)))
    throw new InstallerValidationError(
      "release does not support this After Effects version",
    );
  if (
    !verify(
      null,
      Buffer.from(payload(manifest)),
      releasePublicKey,
      Buffer.from(manifest.signature, "base64"),
    )
  )
    throw new SignatureError();
  const contents = await Promise.all(
    manifest.files.map(async (file) => {
      const content = await readFile(join(sourceRoot, file.path));
      if (hash(content) !== file.sha256)
        throw new InstallerValidationError(
          `release file hash mismatch: ${file.path}`,
        );
      return content;
    }),
  );
  const destination = scriptUiPanels(afterEffectsRoot);
  const releases = join(releaseRoot(destination), "releases");
  const release = hash(payload(manifest));
  const finalRelease = releasePath(destination, release);
  await mkdir(releases, { recursive: true, mode: 0o755 });
  // Stage as a hidden sibling of the final release so rename stays same-FS.
  const stage = await mkdtemp(join(releases, ".rvs-adobe-install-"));
  try {
    await Promise.all(
      contents.map((content, index) =>
        writeFile(join(stage, TARGET_FILES[index] ?? ""), content, {
          mode: 0o644,
        }),
      ),
    );
    await Promise.all(
      TARGET_FILES.map((_, index) =>
        chmod(join(stage, TARGET_FILES[index] ?? ""), 0o644),
      ),
    );
    try {
      await rename(stage, finalRelease);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "EEXIST" || error.code === "ENOTEMPTY")
        )
      )
        throw error;
    }
    if (options.interruptBeforeActivation)
      throw new InstallerInterruptedError();
    const pointerStage = join(
      releaseRoot(destination),
      `.current-${release}.tmp`,
    );
    await writeFile(pointerStage, JSON.stringify({ release }), { mode: 0o644 });
    await rename(pointerStage, pointerPath(destination));
    await activateDirectPanelLoader(destination, release);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
};
