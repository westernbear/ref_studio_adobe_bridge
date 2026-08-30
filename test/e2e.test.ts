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
