import { verify } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

const INSTALL_FILES = [
  "scripts/panel/RVSBridgePanel.jsx",
  "scripts/extendscript/rvs-dispatcher.jsx",
] as const;
const ManifestSchema = z
  .object({
    version: z.literal(1),
    files: z.tuple([z.literal(INSTALL_FILES[0]), z.literal(INSTALL_FILES[1])]),
    signature: z.string().min(40),
  })
  .strict();

export class SignatureError extends Error {
  public constructor() {
    super("installer manifest signature is invalid");
    this.name = "SignatureError";
  }
}

export const installSignedPanel = async (
  sourceRoot: string,
  afterEffectsRoot: string,
  input: unknown,
  releasePublicKey: string,
): Promise<void> => {
  const manifest = ManifestSchema.parse(input);
  const payload = JSON.stringify({
    version: manifest.version,
    files: manifest.files,
  });
  if (
    !verify(
      null,
      Buffer.from(payload),
      releasePublicKey,
      Buffer.from(manifest.signature, "base64"),
    )
  )
    throw new SignatureError();
  const destination = join(afterEffectsRoot, "Scripts", "ScriptUI Panels");
  await mkdir(destination, { recursive: true });
  await Promise.all(
    manifest.files.map((file) =>
      copyFile(join(sourceRoot, file), join(destination, basename(file))),
    ),
  );
};
