import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSignedPanel } from "../src/installer.js";

test("signed installer copies only the fixed allowlist without a shell", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "rvs-installer-"));
  const source = join(root, "source");
  const aeRoot = join(root, "After Effects 2026");
  await Bun.write(join(source, "scripts/panel/RVSBridgePanel.jsx"), "panel");
  await Bun.write(
    join(source, "scripts/extendscript/rvs-dispatcher.jsx"),
    "dispatcher",
  );
  const files = [
    "scripts/panel/RVSBridgePanel.jsx",
    "scripts/extendscript/rvs-dispatcher.jsx",
  ] as const;
  const payload = JSON.stringify({ version: 1, files });
  const keys = generateKeyPairSync("ed25519");
  const manifest = {
    version: 1,
    files,
    signature: sign(null, Buffer.from(payload), keys.privateKey).toString(
      "base64",
    ),
  };

  // When
  await installSignedPanel(
    source,
    aeRoot,
    manifest,
    keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  );

  // Then
  expect(
    await readFile(
      join(aeRoot, "Scripts/ScriptUI Panels/RVSBridgePanel.jsx"),
      "utf8",
    ),
  ).toBe("panel");
  expect(
    await readFile(
      join(aeRoot, "Scripts/ScriptUI Panels/rvs-dispatcher.jsx"),
      "utf8",
    ),
  ).toBe("dispatcher");
});
