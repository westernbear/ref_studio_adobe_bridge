import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const enabledEnvironment = {
  ...getDefaultEnvironment(),
  RVS_ADOBE_MCP: "true",
};

test("CLI refuses new commands while the Adobe feature flag is disabled", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "stdio"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).not.toBe(0);
  expect(await new Response(process.stderr).text()).toContain(
    "ADOBE_MCP_DISABLED",
  );
});

test("CLI queues and locally completes one MCP command without changing original AEP", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "rvs-e2e-"));
  const original = join(root, "original.aep");
  await writeFile(original, "immutable-aep-fixture");
  const command = JSON.stringify({
    version: 1,
    commandId: "cmd-e2e-0001",
    nonce: "nonce-e2e-0001",
    sceneDigest: "a".repeat(64),
    deviceId: "device-e2e",
    jobId: "job-e2e",
    projectHandle: "project:working-copy",
    tool: "adobe.project.get_v1",
    args: {},
  });

  // When
  const enqueue = Bun.spawn(
    ["bun", "run", "src/cli.ts", "enqueue", "--spool", root],
    {
      env: enabledEnvironment,
      stdin: new Blob([command]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await enqueue.exited).toBe(0);
  const once = Bun.spawn(
    [
      "bun",
      "run",
      "src/cli.ts",
      "once",
      "--spool",
      root,
      "--original-aep",
      original,
    ],
    { env: enabledEnvironment, stdout: "pipe", stderr: "pipe" },
  );
  expect(await once.exited).toBe(0);

  // Then
  expect(await readFile(original, "utf8")).toBe("immutable-aep-fixture");
  const result = JSON.parse(
    await readFile(join(root, "results", "cmd-e2e-0001.json"), "utf8"),
  );
  expect(result.status).toBe("SUCCEEDED");
  expect(result.deviceId).toBe("device-e2e");
  expect(result.jobId).toBe("job-e2e");
  expect(result.beforeDigest).toBe(result.afterDigest);
});

test("CLI prepare and finalize bind a cancelled command to the filesystem working copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "rvs-finalize-"));
  const original = join(root, "original.aep");
  const panelResult = join(root, "panel-result.json");
  const digest = "c".repeat(64);
  await writeFile(original, "immutable-finalize-fixture", { mode: 0o640 });
  const prepare = Bun.spawn(
    [
      "bun",
      "run",
      "src/cli.ts",
      "prepare",
      "--spool",
      root,
      "--original-aep",
      original,
      "--job-id",
      "job-finalize",
      "--scene-digest",
      digest,
    ],
    { env: enabledEnvironment, stdout: "pipe", stderr: "pipe" },
  );
  expect(await prepare.exited).toBe(0);
  const command = {
    version: 1,
    commandId: "cmd-finalize-1",
    nonce: "nonce-finalize-1",
    sceneDigest: digest,
    deviceId: "device-finalize",
    jobId: "job-finalize",
    projectHandle: "project:working-copy",
    tool: "adobe.rollback_v1",
    args: { expectedSceneDigest: digest },
  };
  const enqueue = Bun.spawn(
    ["bun", "run", "src/cli.ts", "enqueue", "--spool", root],
    {
      env: enabledEnvironment,
      stdin: new Blob([JSON.stringify(command)]),
      stdout: "pipe",
    },
  );
  expect(await enqueue.exited).toBe(0);
  await writeFile(
    panelResult,
    JSON.stringify({
      version: 1,
      commandId: command.commandId,
      nonce: command.nonce,
      sceneDigest: digest,
      deviceId: command.deviceId,
      jobId: command.jobId,
      status: "CANCELLED",
      beforeDigest: digest,
      afterDigest: digest,
      changedFields: [],
      warnings: [],
      payload: {},
    }),
  );
  const finalize = Bun.spawn(
    [
      "bun",
      "run",
      "src/cli.ts",
      "finalize",
      "--spool",
      root,
      "--original-aep",
      original,
      "--panel-result",
      panelResult,
    ],
    { env: enabledEnvironment, stdout: "pipe", stderr: "pipe" },
  );
  expect(await finalize.exited).toBe(0);
  expect(await readFile(original, "utf8")).toBe("immutable-finalize-fixture");
  expect(
    JSON.parse(
      await readFile(join(root, "results", "cmd-finalize-1.json"), "utf8"),
    ).status,
  ).toBe("CANCELLED");
});

test("MCP stdio lists tools and queues a bound command", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "rvs-mcp-"));
  const client = new Client({ name: "rvs-e2e", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/cli.ts", "stdio", "--spool", root],
    cwd: process.cwd(),
    env: enabledEnvironment,
    stderr: "pipe",
  });
  await client.connect(transport);

  // When
  const tools = await client.listTools();
  await client.callTool({
    name: "adobe.project.get_v1",
    arguments: {
      version: 1,
      commandId: "cmd-mcp-0001",
      nonce: "nonce-mcp-0001",
      sceneDigest: "b".repeat(64),
      deviceId: "device-mcp",
      jobId: "job-mcp",
      projectHandle: "project:working-copy",
      args: {},
    },
  });

  // Then
  expect(tools.tools.length).toBe(25);
  const queued = JSON.parse(
    await readFile(join(root, "commands", "cmd-mcp-0001.pending.json"), "utf8"),
  );
  expect(queued.status).toBe("QUEUED");
  await client.close();
});
