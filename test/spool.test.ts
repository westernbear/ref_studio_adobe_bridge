import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
    let now = 1_000;
    const spool = new CommandSpool(root, { leaseMs: 500, now: () => now });
    await spool.enqueue(command);
    await spool.claimNext();
    now = 1_501;
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
    let now = 1_000;
    const spool = new CommandSpool(root, { leaseMs: 500, now: () => now });
    await spool.enqueue(command);
    await spool.claimNext();
    now = 1_501;
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

  test("restart reconciles a terminal result left beside running crash state", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    await spool.claimNext();
    const runningPath = join(
      root,
      "commands",
      `${command.commandId}.running.json`,
    );
    const running = await readFile(runningPath, "utf8");
    const lockPath = join(root, "mutation.lock.json");
    const lock = await readFile(lockPath, "utf8");
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
    await writeFile(runningPath, running, { mode: 0o600 });
    await writeFile(lockPath, lock, { mode: 0o600 });

    // When
    const restarted = new CommandSpool(root);
    expect(await restarted.recover()).toBe(1);

    // Then
    expect(await readdir(join(root, "commands"))).toEqual([]);
    expect((await restarted.result(command)).status).toBe("SUCCEEDED");
    expect(readFile(lockPath, "utf8")).rejects.toThrow();
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
    expect(
      spool.enqueue({ ...command, tool: "adobe.composition.list_v1" }),
    ).rejects.toThrow("binding");
    expect(
      spool.result({ ...command, tool: "adobe.composition.list_v1" }),
    ).rejects.toThrow("binding");
  });

  test("rejects changed arguments after a terminal result", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    const createCommand = {
      ...command,
      commandId: "cmd-create-replay",
      tool: "adobe.composition.create_v1" as const,
      args: {
        name: "Main",
        width: 1920,
        height: 1080,
        durationSeconds: 15,
        frameRate: 30,
      },
    };
    await spool.enqueue(createCommand);
    await spool.claimNext();
    await spool.complete({
      version: 1,
      commandId: createCommand.commandId,
      nonce: createCommand.nonce,
      sceneDigest: createCommand.sceneDigest,
      deviceId: createCommand.deviceId,
      jobId: createCommand.jobId,
      status: "SUCCEEDED",
      beforeDigest: createCommand.sceneDigest,
      afterDigest: createCommand.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    });

    expect(
      spool.enqueue({
        ...createCommand,
        args: { ...createCommand.args, width: 1280 },
      }),
    ).rejects.toThrow("binding");
    expect(
      spool.result({
        ...createCommand,
        args: { ...createCommand.args, width: 1280 },
      }),
    ).rejects.toThrow("binding");
  });

  test("returns the running command without creating duplicate pending work", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    const running = await spool.claimNext();
    if (running === undefined) throw new TypeError("command was not claimed");

    expect(await spool.enqueue(command)).toEqual(running);
    expect(await readdir(join(root, "commands"))).toEqual([
      `${command.commandId}.running.json`,
    ]);
    expect(
      spool.enqueue({ ...command, nonce: "nonce-running-other" }),
    ).rejects.toThrow("binding");
    expect(
      spool.enqueue({ ...command, sceneDigest: "b".repeat(64) }),
    ).rejects.toThrow("binding");
  });

  test("twenty processes enqueue one identical pending lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const moduleUrl = new URL("../src/spool.ts", import.meta.url).href;
    const script = `import { CommandSpool } from ${JSON.stringify(moduleUrl)}; const value = await new CommandSpool(process.env.RVS_SPOOL_ROOT).enqueue(JSON.parse(process.env.RVS_COMMAND)); process.stdout.write(value.status);`;
    const admitted = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const child = Bun.spawn([process.execPath, "-e", script], {
          env: {
            ...process.env,
            RVS_SPOOL_ROOT: root,
            RVS_COMMAND: JSON.stringify(command),
          },
          stderr: "pipe",
          stdout: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(stderr);
        return stdout;
      }),
    );

    expect(admitted.every((status) => status === "QUEUED")).toBe(true);
    expect(await readdir(join(root, "commands"))).toEqual([
      `${command.commandId}.pending.json`,
    ]);
    const spool = new CommandSpool(root);
    expect((await spool.claimNext())?.status).toBe("RUNNING");
    expect(await spool.claimNext()).toBeUndefined();
  });

  test("reconciles an orphan binding into a real pending command", async () => {
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    await mkdir(join(root, "bindings"), { recursive: true });
    await writeFile(
      join(root, "bindings", `${command.commandId}.json`),
      JSON.stringify({
        nonce: command.nonce,
        sceneDigest: command.sceneDigest,
        deviceId: command.deviceId,
        jobId: command.jobId,
        commandDigest: createHash("sha256")
          .update(JSON.stringify(command))
          .digest("hex"),
      }),
    );
    const spool = new CommandSpool(root);

    expect((await spool.enqueue(command)).status).toBe("QUEUED");
    expect(await readdir(join(root, "commands"))).toEqual([
      `${command.commandId}.pending.json`,
    ]);
    expect((await spool.claimNext())?.status).toBe("RUNNING");
  });

  test("keeps one exclusive mutation claim across twenty-four processes", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        new CommandSpool(root).enqueue({
          ...command,
          commandId: `cmd-race-${String(index).padStart(8, "0")}`,
          nonce: `nonce-race-${String(index).padStart(8, "0")}`,
        }),
      ),
    );

    // When
    const moduleUrl = new URL("../src/spool.ts", import.meta.url).href;
    const script = `import { CommandSpool } from ${JSON.stringify(moduleUrl)}; const value = await new CommandSpool(process.env.RVS_SPOOL_ROOT).claimNext(); process.stdout.write(value === undefined ? "0" : "1");`;
    const claims = await Promise.all(
      Array.from({ length: 24 }, async () => {
        const child = Bun.spawn([process.execPath, "-e", script], {
          env: { ...process.env, RVS_SPOOL_ROOT: root },
          stderr: "pipe",
          stdout: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exitCode !== 0) throw new Error(stderr);
        return stdout;
      }),
    );

    // Then
    expect(claims.filter((claim) => claim === "1")).toHaveLength(1);
  });

  test("recovers only an expired running lease", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    let now = 1_000;
    const spool = new CommandSpool(root, { leaseMs: 500, now: () => now });
    await spool.enqueue(command);
    await spool.claimNext();

    // When / Then
    expect(await spool.recover()).toBe(0);
    now = 1_501;
    expect(await spool.recover()).toBe(1);
  });

  test("rejects a regressed clock and completion after lease expiry", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    let now = 1_000;
    const spool = new CommandSpool(root, { leaseMs: 500, now: () => now });
    await spool.enqueue(command);
    await spool.claimNext();

    // When / Then
    now = 999;
    expect(spool.recover()).rejects.toThrow("non-monotonic");
    now = 1_501;
    expect(
      spool.complete({
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
      }),
    ).rejects.toThrow("lease expired");
  });

  test("cancels queued and running commands without allowing terminal overwrite", async () => {
    // Given
    const queuedRoot = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const queuedSpool = new CommandSpool(queuedRoot);
    await queuedSpool.enqueue(command);

    // When
    await queuedSpool.cancel(command.commandId);

    // Then
    expect((await queuedSpool.result(command)).status).toBe("CANCELLED");

    // Given
    const runningRoot = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const runningSpool = new CommandSpool(runningRoot);
    await runningSpool.enqueue(command);
    await runningSpool.claimNext();

    // When
    await runningSpool.cancel(command.commandId);

    // Then
    expect((await runningSpool.result(command)).status).toBe("CANCELLED");
    expect(
      (
        await runningSpool.complete({
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
        })
      ).status,
    ).toBe("CANCELLED");
  });

  test("claim and cancel overlap leaves no residue and admits the next command", async () => {
    for (let iteration = 0; iteration < 300; iteration += 1) {
      // Given
      const root = await mkdtemp(join(tmpdir(), "rvs-spool-overlap-"));
      const spool = new CommandSpool(root);
      const current = {
        ...command,
        commandId: `cmd-overlap-${String(iteration).padStart(8, "0")}`,
        nonce: `nonce-overlap-${String(iteration).padStart(8, "0")}`,
      };
      const next = {
        ...command,
        commandId: `cmd-overlap-next-${String(iteration).padStart(8, "0")}`,
        nonce: `nonce-overlap-next-${String(iteration).padStart(8, "0")}`,
      };
      await spool.enqueue(current);

      // When
      await Promise.all([spool.claimNext(), spool.cancel(current.commandId)]);

      // Then
      expect((await spool.result(current)).status).toBe("CANCELLED");
      expect(
        (await readdir(join(root, "commands"))).some(
          (name) =>
            name === `${current.commandId}.running.json` ||
            name === `${current.commandId}.pending.json`,
        ),
      ).toBe(false);
      expect(
        (await readdir(root)).filter(
          (name) =>
            name === "mutation.lock.json" || name === "transition.lock.json",
        ),
      ).toEqual([]);
      await spool.enqueue(next);
      expect((await spool.claimNext())?.commandId).toBe(next.commandId);
      await spool.cancel(next.commandId);
      await rm(root, { recursive: true });
    }
  });

  test("uses restrictive files and rejects malformed or oversized lifecycle data", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    const pendingPath = join(
      root,
      "commands",
      `${command.commandId}.pending.json`,
    );

    // When / Then
    expect((await stat(join(root, "commands"))).mode & 0o777).toBe(0o700);
    expect((await stat(pendingPath)).mode & 0o777).toBe(0o600);
    await writeFile(pendingPath, "{broken", { mode: 0o600 });
    expect(spool.claimNext()).rejects.toThrow("malformed");

    const oversizedRoot = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const oversizedSpool = new CommandSpool(oversizedRoot);
    await oversizedSpool.enqueue(command);
    await writeFile(
      join(oversizedRoot, "commands", `${command.commandId}.pending.json`),
      "x".repeat(1_048_577),
      { mode: 0o600 },
    );
    expect(oversizedSpool.claimNext()).rejects.toThrow("oversized");
  });

  test("keeps running lifecycle and removes temporary files after an oversized write fault", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "rvs-spool-"));
    const spool = new CommandSpool(root);
    await spool.enqueue(command);
    await spool.claimNext();

    // When / Then
    expect(
      spool.complete({
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
        payload: { oversized: "x".repeat(1_048_576) },
      }),
    ).rejects.toThrow("oversized write");
    expect(await readdir(join(root, "results"))).toEqual([]);
    expect(await readdir(join(root, "commands"))).toEqual([
      `${command.commandId}.running.json`,
    ]);
    expect(
      (await readdir(join(root, "results"))).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
  });
});
