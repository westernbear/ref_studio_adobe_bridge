import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeSignedPanelRelease,
  InstallerInterruptedError,
  installSignedPanel,
  supportedAfterEffectsRoots,
} from "../src/installer.js";

const files = [
  { path: "scripts/panel/RVSBridgePanel.jsx", sha256: "" },
  { path: "scripts/extendscript/rvs-dispatcher.jsx", sha256: "" },
] as const;

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const fixture = async (): Promise<{
  readonly source: string;
  readonly aeRoot: string;
  readonly publicKey: string;
  readonly signManifest: (
    input?: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
}> => {
  const root = await mkdtemp(join(tmpdir(), "rvs-installer-"));
  const source = join(root, "source");
  const aeRoot = join(root, "Adobe After Effects 2026");
  await mkdir(join(source, "scripts/panel"), { recursive: true });
  await mkdir(join(source, "scripts/extendscript"), { recursive: true });
  await Bun.write(join(source, files[0].path), "panel");
  await Bun.write(join(source, files[1].path), "dispatcher");
  const keys = generateKeyPairSync("ed25519");
  const signedFiles = files.map((file) => ({
    ...file,
    sha256: sha256(file.path.includes("panel") ? "panel" : "dispatcher"),
  }));
  const signManifest = (
    input: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> => {
    const unsigned = {
      version: 1,
      afterEffectsVersions: ["2024", "2025", "2026"],
      files: signedFiles,
      ...input,
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(unsigned)),
        keys.privateKey,
      ).toString("base64"),
    };
  };
  return {
    source,
    aeRoot,
    publicKey: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    signManifest,
  };
};

test("installs only signed hash-pinned panel files into the fixed ScriptUI location", async () => {
  // Given
  const setup = await fixture();

  // When
  await installSignedPanel(
    setup.source,
    setup.aeRoot,
    setup.signManifest(),
    setup.publicKey,
  );

  // Then
  expect(
    await readFile(
      join(
        setup.aeRoot,
        "Scripts/ScriptUI Panels/RVSBridge/releases",
        (await activeSignedPanelRelease(setup.aeRoot)) ?? "",
        "RVSBridgePanel.jsx",
      ),
      "utf8",
    ),
  ).toBe("panel");
  expect(
    await readFile(
      join(
        setup.aeRoot,
        "Scripts/ScriptUI Panels/RVSBridge/releases",
        (await activeSignedPanelRelease(setup.aeRoot)) ?? "",
        "rvs-dispatcher.jsx",
      ),
      "utf8",
    ),
  ).toBe("dispatcher");
  expect(
    (
      await stat(
        join(
          setup.aeRoot,
          "Scripts/ScriptUI Panels/RVSBridge/releases",
          (await activeSignedPanelRelease(setup.aeRoot)) ?? "",
          "RVSBridgePanel.jsx",
        ),
      )
    ).mode & 0o777,
  ).toBe(0o644);
});

test("rejects traversal, unknown files, invalid signatures, hashes, and unsupported AE versions before mutation", async () => {
  // Given
  const setup = await fixture();
  const cases = [
    setup.signManifest({
      files: [
        { path: "../evil.jsx", sha256: "0".repeat(64) },
        { path: files[1].path, sha256: sha256("dispatcher") },
      ],
    }),
    setup.signManifest({
      files: [
        {
          path: "scripts/panel/RVSBridgePanel.jsx;touch",
          sha256: "0".repeat(64),
        },
        { path: files[1].path, sha256: sha256("dispatcher") },
      ],
    }),
    setup.signManifest({ unexpected: true }),
    { ...setup.signManifest(), signature: "invalid-base64" },
    setup.signManifest({
      files: [
        { path: files[0].path, sha256: "0".repeat(64) },
        { path: files[1].path, sha256: sha256("dispatcher") },
      ],
    }),
    setup.signManifest({ afterEffectsVersions: ["2024"] }),
  ];

  // When / Then
  for (const manifest of cases) {
    await expect(
      installSignedPanel(setup.source, setup.aeRoot, manifest, setup.publicKey),
    ).rejects.toThrow();
  }
});

test("keeps the prior release active across an interruption before the one-file pointer transition", async () => {
  // Given
  const setup = await fixture();
  await installSignedPanel(
    setup.source,
    setup.aeRoot,
    setup.signManifest(),
    setup.publicKey,
  );
  const before = await activeSignedPanelRelease(setup.aeRoot);
  await Bun.write(join(setup.source, files[0].path), "panel v2");
  const manifest = setup.signManifest({
    files: [
      { path: files[0].path, sha256: sha256("panel v2") },
      { path: files[1].path, sha256: sha256("dispatcher") },
    ],
  });

  // When
  await expect(
    installSignedPanel(setup.source, setup.aeRoot, manifest, setup.publicKey, {
      interruptBeforeActivation: true,
    }),
  ).rejects.toBeInstanceOf(InstallerInterruptedError);

  // Then
  expect(await activeSignedPanelRelease(setup.aeRoot)).toBe(before);
  await installSignedPanel(
    setup.source,
    setup.aeRoot,
    manifest,
    setup.publicKey,
  );
  expect(
    await readFile(
      join(
        setup.aeRoot,
        "Scripts/ScriptUI Panels/RVSBridge/releases",
        (await activeSignedPanelRelease(setup.aeRoot)) ?? "",
        "RVSBridgePanel.jsx",
      ),
      "utf8",
    ),
  ).toBe("panel v2");
});

test("enumerates canonical roots and rejects a malformed Windows root", async () => {
  // Given / When
  const mac = supportedAfterEffectsRoots(
    "darwin",
    "/Users/rvs",
    "C:\\Program Files",
  );
  const linux = supportedAfterEffectsRoots(
    "linux",
    "/home/rvs",
    "C:\\Program Files",
  );
  const windows = supportedAfterEffectsRoots(
    "win32",
    "C:\\Users\\rvs",
    "D:\\Adobe",
  );

  // Then
  expect(mac).toContain("/Users/rvs/Applications/Adobe After Effects 2026");
  expect(linux).toContain(
    "/home/rvs/.wine/drive_c/Program Files/Adobe/Adobe After Effects 2026",
  );
  expect(windows).toContain("D:\\Adobe\\Adobe\\Adobe After Effects 2026");
  expect(windows.every((value) => !value.includes("/"))).toBe(true);
  const setup = await fixture();
  await expect(
    installSignedPanel(
      setup.source,
      "D:\\Adobe/Adobe After Effects 2026",
      setup.signManifest(),
      setup.publicKey,
    ),
  ).rejects.toThrow("non-canonical Windows");
});
