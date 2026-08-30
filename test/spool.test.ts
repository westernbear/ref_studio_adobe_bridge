import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdobeCommandResult } from "../src/contracts.js";
import { CommandSpool } from "../src/spool.js";

const command = {
  version: 1 as const,
  commandId: "cmd-00000001",
  nonce: "nonce-00000001",
  sceneDigest: "a".repeat(64),
  deviceId: "device-1",
  jobId: "job-1",
  projectHandle: "project:working-copy" as const,
  tool: "adobe.project.get_v1" as const,
  args: {},
};

describe("atomic command spool", () => {
  test("moves pending to running and binds result to nonce and digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    const claimed = await spool.claimNext();
    expect(claimed?.status).toBe("RUNNING");
    await spool.complete({
      version: 1,
      commandId: command.commandId,
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: command.deviceId,
      jobId: command.jobId,
      status: "SUCCEEDED",
      beforeDigest: command.sceneDigest,
      afterDigest: command.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    });
    expect((await spool.result(command)).status).toBe("SUCCEEDED");
  });

  test("does not reuse stale result for repeated command id", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    await spool.claimNext();
    await spool.complete({
      version: 1,
      commandId: command.commandId,
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: command.deviceId,
      jobId: command.jobId,
      status: "SUCCEEDED",
      beforeDigest: command.sceneDigest,
      afterDigest: command.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    });
    expect(
      spool.result({ ...command, nonce: "nonce-00000002" }),
    ).rejects.toThrow("binding");
  });

  test("recovers a running command after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    await spool.claimNext();
    expect(await spool.recover()).toBe(1);
    expect(
      JSON.parse(
        await readFile(
          join(root, "commands", `${command.commandId}.pending.json`),
          "utf8",
        ),
      ).status,
    ).toBe("QUEUED");
  });

  test("recovered command is claimed and completed exactly once", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    await spool.claimNext();
    await spool.recover();
    expect(
      (await readdir(join(root, "commands"))).some((name) =>
        name.endsWith(".running.json"),
      ),
    ).toBe(false);

    // When
    const recovered = await spool.claimNext();
    await spool.complete({
      version: 1,
      commandId: command.commandId,
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: command.deviceId,
      jobId: command.jobId,
      status: "SUCCEEDED",
      beforeDigest: command.sceneDigest,
      afterDigest: command.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    });

    // Then
    expect(recovered?.status).toBe("RUNNING");
    expect(await spool.claimNext()).toBeUndefined();
    expect((await spool.result(command)).status).toBe("SUCCEEDED");
  });

  test("rejects replay from another device or job", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    expect(spool.enqueue({ ...command, deviceId: "device-2" })).rejects.toThrow(
      "binding",
    );
  });

  test("rejects terminal results from another device or job", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    await spool.claimNext();
    const result: AdobeCommandResult = {
      version: 1,
      commandId: command.commandId,
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: "device-other",
      jobId: command.jobId,
      status: "SUCCEEDED",
      beforeDigest: command.sceneDigest,
      afterDigest: command.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    };
    expect(spool.complete(result)).rejects.toThrow("binding");
    expect(
      spool.complete({
        ...result,
        deviceId: command.deviceId,
        jobId: "job-other",
      }),
    ).rejects.toThrow("binding");
  });

  test("returns the terminal result without recreating pending work on identical replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    await spool.claimNext();
    const result: AdobeCommandResult = {
      version: 1,
      commandId: command.commandId,
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: command.deviceId,
      jobId: command.jobId,
      status: "SUCCEEDED",
      beforeDigest: command.sceneDigest,
      afterDigest: command.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: { completed: true },
    };
    await spool.complete(result);

    expect(await spool.enqueue(command)).toEqual(result);
    expect(await spool.claimNext()).toBeUndefined();
    expect(
      spool.enqueue({ ...command, sceneDigest: "b".repeat(64) }),
    ).rejects.toThrow("binding");
  });
});
