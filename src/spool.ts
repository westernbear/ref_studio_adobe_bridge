import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  AdobeCommandEnvelopeV1,
  AdobeCommandResultV1,
  QueuedCommand,
  RunningCommand,
} from "./contracts.js";
import {
  AdobeCommandEnvelopeV1Schema,
  AdobeCommandResultV1Schema,
} from "./contracts.js";
import { BindingError, SpoolStateError } from "./errors.js";

const MAX_FILE_BYTES = 1_048_576; // lockstep with RESOURCE_BUDGETS.maxSpoolFileBytes
const DEFAULT_LEASE_MS = 30_000;
const TRANSITION_WAIT_MS = 5_000;
const TimestampSchema = z.number().int().nonnegative();
const LifecycleExtrasSchema = z
  .object({
    status: z.enum(["QUEUED", "RUNNING"]),
    queuedAtMs: TimestampSchema,
    runningAtMs: TimestampSchema.optional(),
    leaseExpiresAtMs: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "QUEUED" &&
      (value.runningAtMs !== undefined || value.leaseExpiresAtMs !== undefined)
    )
      context.addIssue({ code: "custom", message: "queued command has lease" });
    if (
      value.status === "RUNNING" &&
      (value.runningAtMs === undefined ||
        value.leaseExpiresAtMs === undefined ||
        value.runningAtMs < value.queuedAtMs ||
        value.leaseExpiresAtMs <= value.runningAtMs)
    )
      context.addIssue({ code: "custom", message: "invalid running lease" });
  });
type StoredCommand = AdobeCommandEnvelopeV1 &
  z.infer<typeof LifecycleExtrasSchema>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const LockSchema = z
  .object({
    commandId: z.string().min(3).max(128),
    acquiredAtMs: TimestampSchema,
    leaseExpiresAtMs: TimestampSchema,
  })
  .strict()
  .refine((value) => value.leaseExpiresAtMs > value.acquiredAtMs);

type SpoolOptions = {
  readonly leaseMs?: number;
  readonly now?: () => number;
};

const isFsError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

export class CommandSpool {
  readonly #root: string;
  readonly #commands: string;
  readonly #results: string;
  readonly #bindings: string;
  readonly #lock: string;
  readonly #transition: string;
  readonly #leaseMs: number;
  readonly #now: () => number;

  public constructor(root: string, options: SpoolOptions = {}) {
    this.#root = root;
    this.#commands = join(root, "commands");
    this.#results = join(root, "results");
    this.#bindings = join(root, "bindings");
    this.#lock = join(root, "mutation.lock.json");
    this.#transition = join(root, "transition.lock.json");
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs <= 0)
      throw new SpoolStateError("configuration", "invalid lease duration");
  }

  async #init(): Promise<void> {
    await Promise.all([
      mkdir(this.#commands, { recursive: true, mode: 0o700 }),
      mkdir(this.#results, { recursive: true, mode: 0o700 }),
      mkdir(this.#bindings, { recursive: true, mode: 0o700 }),
    ]);
  }

  #time(commandId: string, minimum = 0): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new SpoolStateError(commandId, "non-monotonic clock");
    return value;
  }

  async #readBounded(
    path: string,
    commandId: string,
    label: string,
  ): Promise<unknown> {
    let handle;
    try {
      handle = await open(path, "r");
      if ((await handle.stat()).size > MAX_FILE_BYTES)
        throw new SpoolStateError(commandId, `oversized ${label}`);
      const contents = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(contents) > MAX_FILE_BYTES)
        throw new SpoolStateError(commandId, `oversized ${label}`);
      try {
        const parsed: unknown = JSON.parse(contents);
        return parsed;
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new SpoolStateError(commandId, `malformed ${label}`);
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }

  async #createExclusive(path: string, value: unknown): Promise<boolean> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES)
      throw new SpoolStateError("spool-file", "oversized write");
    try {
      await writeFile(temporary, contents, {
        flag: "wx",
        mode: 0o600,
      });
      try {
        await link(temporary, path);
        return true;
      } catch (error) {
        if (isFsError(error, "EEXIST")) return false;
        throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #withTransition<T>(
    commandId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + TRANSITION_WAIT_MS;
    while (true) {
      try {
        await writeFile(this.#transition, `${commandId}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        break;
      } catch (error) {
        if (!isFsError(error, "EEXIST")) throw error;
        if (Date.now() >= deadline)
          throw new SpoolStateError(commandId, "transition lock timeout");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    try {
      return await action();
    } finally {
      await rm(this.#transition, { force: true });
    }
  }

  async #releaseMutationLock(commandId: string): Promise<void> {
    let lock: z.infer<typeof LockSchema> | undefined;
    try {
      lock = LockSchema.parse(
        await this.#readBounded(this.#lock, commandId, "mutation lock"),
      );
    } catch (error) {
      if (isFsError(error, "ENOENT")) return;
      if (error instanceof z.ZodError)
        throw new SpoolStateError(commandId, "malformed mutation lock");
      throw error;
    }
    if (lock.commandId === commandId) await rm(this.#lock, { force: true });
  }

  async #stored(
    path: string,
    commandId: string,
    label: string,
  ): Promise<StoredCommand | undefined> {
    try {
      const raw = await this.#readBounded(path, commandId, label);
      if (!isRecord(raw))
        throw new SpoolStateError(commandId, `malformed ${label}`);
      const {
        status,
        queuedAtMs,
        runningAtMs,
        leaseExpiresAtMs,
        ...envelopeRaw
      } = raw;
      const extras = LifecycleExtrasSchema.parse({
        status,
        queuedAtMs,
        ...(runningAtMs === undefined ? {} : { runningAtMs }),
        ...(leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs }),
      });
      return { ...AdobeCommandEnvelopeV1Schema.parse(envelopeRaw), ...extras };
    } catch (error) {
      if (isFsError(error, "ENOENT")) return undefined;
      if (error instanceof z.ZodError)
        throw new SpoolStateError(commandId, `malformed ${label}`);
      throw error;
    }
  }

  #assertStoredMatches(
    stored: StoredCommand,
    command: AdobeCommandEnvelopeV1,
  ): void {
    const envelope = this.#envelope(stored);
    if (JSON.stringify(envelope) !== JSON.stringify(command))
      throw new BindingError(command.commandId);
  }

  #envelope(stored: StoredCommand): AdobeCommandEnvelopeV1 {
    const {
      status: _status,
      queuedAtMs: _queuedAtMs,
      runningAtMs: _runningAtMs,
      leaseExpiresAtMs: _leaseExpiresAtMs,
      ...envelope
    } = stored;
    return AdobeCommandEnvelopeV1Schema.parse(envelope);
  }

  #lifecycle(stored: StoredCommand): QueuedCommand | RunningCommand {
    const envelope = this.#envelope(stored);
    return stored.status === "QUEUED"
      ? { ...envelope, status: "QUEUED" }
      : { ...envelope, status: "RUNNING" };
  }

  #binding(command: AdobeCommandEnvelopeV1) {
    return {
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: command.deviceId,
      jobId: command.jobId,
      commandDigest: createHash("sha256")
        .update(JSON.stringify(command))
        .digest("hex"),
    };
  }

  async #assertBinding(command: AdobeCommandEnvelopeV1): Promise<void> {
    const existing = await this.#readBounded(
      join(this.#bindings, `${command.commandId}.json`),
      command.commandId,
      "binding",
    );
    if (JSON.stringify(existing) !== JSON.stringify(this.#binding(command)))
      throw new BindingError(command.commandId);
  }

  async #terminal(
    commandId: string,
  ): Promise<AdobeCommandResultV1 | undefined> {
    try {
      return AdobeCommandResultV1Schema.parse(
        await this.#readBounded(
          join(this.#results, `${commandId}.json`),
          commandId,
          "result",
        ),
      );
    } catch (error) {
      if (isFsError(error, "ENOENT")) return undefined;
      if (error instanceof z.ZodError)
        throw new SpoolStateError(commandId, "malformed result");
      throw error;
    }
  }

  #assertResultBinding(
    result: AdobeCommandResultV1,
    expected: Pick<
      AdobeCommandEnvelopeV1,
      "commandId" | "nonce" | "sceneDigest" | "deviceId" | "jobId"
    >,
  ): void {
    if (
      result.commandId !== expected.commandId ||
      result.nonce !== expected.nonce ||
      result.sceneDigest !== expected.sceneDigest ||
      result.deviceId !== expected.deviceId ||
      result.jobId !== expected.jobId
    )
      throw new BindingError(expected.commandId);
  }

  public async enqueue(
    input: unknown,
  ): Promise<QueuedCommand | RunningCommand | AdobeCommandResultV1> {
    const command = AdobeCommandEnvelopeV1Schema.parse(input);
    await this.#init();
    const bindingPath = join(this.#bindings, `${command.commandId}.json`);
    if (!(await this.#createExclusive(bindingPath, this.#binding(command))))
      await this.#assertBinding(command);

    const terminal = await this.#terminal(command.commandId);
    if (terminal !== undefined) {
      this.#assertResultBinding(terminal, command);
      return terminal;
    }
    const running = await this.#stored(
      join(this.#commands, `${command.commandId}.running.json`),
      command.commandId,
      "running command",
    );
    if (running !== undefined) {
      this.#assertStoredMatches(running, command);
      return this.#lifecycle(running);
    }
    const pendingPath = join(
      this.#commands,
      `${command.commandId}.pending.json`,
    );
    const pending = await this.#stored(
      pendingPath,
      command.commandId,
      "pending command",
    );
    if (pending !== undefined) {
      this.#assertStoredMatches(pending, command);
      return this.#lifecycle(pending);
    }
    const queued = {
      ...command,
      status: "QUEUED" as const,
      queuedAtMs: this.#time(command.commandId),
    };
    if (await this.#createExclusive(pendingPath, queued))
      return { ...command, status: "QUEUED" };
    const collided = await this.#stored(
      pendingPath,
      command.commandId,
      "pending command",
    );
    if (collided === undefined)
      throw new SpoolStateError(command.commandId, "pending disappeared");
    this.#assertStoredMatches(collided, command);
    return this.#lifecycle(collided);
  }

  public async claimNext(): Promise<RunningCommand | undefined> {
    await this.#init();
    const pending = (await readdir(this.#commands))
      .filter((name) => name.endsWith(".pending.json"))
      .sort()[0];
    if (pending === undefined) return undefined;
    const commandId = pending.slice(0, -".pending.json".length);
    return this.#withTransition(commandId, async () => {
      const pendingPath = join(this.#commands, pending);
      const runningPath = join(this.#commands, `${commandId}.running.json`);
      if ((await this.#terminal(commandId)) !== undefined) {
        await rm(pendingPath, { force: true });
        await rm(runningPath, { force: true });
        await this.#releaseMutationLock(commandId);
        return undefined;
      }
      const queued = await this.#stored(
        pendingPath,
        commandId,
        "pending command",
      );
      if (queued === undefined) return undefined;
      if (queued.status !== "QUEUED")
        throw new SpoolStateError(commandId, "pending is not queued");
      const acquiredAtMs = this.#time(commandId, queued.queuedAtMs);
      const leaseExpiresAtMs = acquiredAtMs + this.#leaseMs;
      if (
        !(await this.#createExclusive(this.#lock, {
          commandId,
          acquiredAtMs,
          leaseExpiresAtMs,
        }))
      )
        return undefined;
      try {
        const running = {
          ...this.#envelope(queued),
          status: "RUNNING" as const,
          queuedAtMs: queued.queuedAtMs,
          runningAtMs: acquiredAtMs,
          leaseExpiresAtMs,
        };
        if (!(await this.#createExclusive(runningPath, running))) {
          const existing = await this.#stored(
            runningPath,
            commandId,
            "running command",
          );
          if (existing === undefined || existing.status !== "RUNNING")
            throw new SpoolStateError(commandId, "running disappeared");
          this.#assertStoredMatches(existing, this.#envelope(queued));
          return { ...this.#envelope(existing), status: "RUNNING" };
        }
        if ((await this.#terminal(commandId)) !== undefined) {
          await rm(runningPath, { force: true });
          await rm(pendingPath, { force: true });
          await this.#releaseMutationLock(commandId);
          return undefined;
        }
        await rm(pendingPath, { force: true });
        return { ...this.#envelope(running), status: "RUNNING" };
      } catch (error) {
        await this.#releaseMutationLock(commandId);
        throw error;
      }
    });
  }

  public async complete(input: unknown): Promise<AdobeCommandResultV1> {
    const result = AdobeCommandResultV1Schema.parse(input);
    await this.#init();
    return this.#withTransition(result.commandId, async () => {
      const terminal = await this.#terminal(result.commandId);
      if (terminal !== undefined) {
        this.#assertResultBinding(terminal, result);
        return terminal;
      }
      const runningPath = join(
        this.#commands,
        `${result.commandId}.running.json`,
      );
      const running = await this.#stored(
        runningPath,
        result.commandId,
        "running command",
      );
      if (running === undefined)
        throw new SpoolStateError(result.commandId, "not running");
      this.#assertResultBinding(result, running);
      const { leaseExpiresAtMs, runningAtMs } = running;
      if (leaseExpiresAtMs === undefined || runningAtMs === undefined)
        throw new SpoolStateError(result.commandId, "running lease missing");
      if (this.#time(result.commandId, runningAtMs) > leaseExpiresAtMs)
        throw new SpoolStateError(result.commandId, "lease expired");
      if (
        !(await this.#createExclusive(
          join(this.#results, `${result.commandId}.json`),
          result,
        ))
      ) {
        const winner = await this.#terminal(result.commandId);
        if (winner === undefined)
          throw new SpoolStateError(result.commandId, "result disappeared");
        this.#assertResultBinding(winner, result);
        return winner;
      }
      await rm(runningPath, { force: true });
      await this.#releaseMutationLock(result.commandId);
      return result;
    });
  }

  public async result(
    command: AdobeCommandEnvelopeV1,
  ): Promise<AdobeCommandResultV1> {
    await this.#assertBinding(command);
    const result = await this.#terminal(command.commandId);
    if (result === undefined)
      throw new SpoolStateError(command.commandId, "result missing");
    this.#assertResultBinding(result, command);
    return result;
  }

  public async recover(): Promise<number> {
    await this.#init();
    return this.#withTransition("recovery", async () => {
      const now = this.#time("recovery");
      const runningNames = (await readdir(this.#commands)).filter((name) =>
        name.endsWith(".running.json"),
      );
      let recovered = 0;
      for (const name of runningNames) {
        const commandId = name.slice(0, -".running.json".length);
        const runningPath = join(this.#commands, name);
        const command = await this.#stored(
          runningPath,
          commandId,
          "running command",
        );
        if (command === undefined || command.status !== "RUNNING") continue;
        const terminal = await this.#terminal(commandId);
        if (terminal !== undefined) {
          this.#assertResultBinding(terminal, command);
          await rm(runningPath, { force: true });
          await rm(this.#lock, { force: true });
          recovered += 1;
          continue;
        }
        const runningAtMs = command.runningAtMs;
        const leaseExpiresAtMs = command.leaseExpiresAtMs;
        if (runningAtMs === undefined || leaseExpiresAtMs === undefined)
          throw new SpoolStateError(commandId, "running lease missing");
        if (now < runningAtMs)
          throw new SpoolStateError(commandId, "non-monotonic clock");
        if (now <= leaseExpiresAtMs) continue;
        const pendingPath = join(this.#commands, `${commandId}.pending.json`);
        const queued = {
          ...this.#envelope(command),
          status: "QUEUED" as const,
          queuedAtMs: command.queuedAtMs,
        };
        if (!(await this.#createExclusive(pendingPath, queued))) {
          const existing = await this.#stored(
            pendingPath,
            commandId,
            "pending command",
          );
          if (existing === undefined)
            throw new SpoolStateError(commandId, "pending disappeared");
          this.#assertStoredMatches(existing, this.#envelope(command));
        }
        await rm(runningPath, { force: true });
        recovered += 1;
      }
      let lock: z.infer<typeof LockSchema> | undefined;
      try {
        lock = LockSchema.parse(
          await this.#readBounded(this.#lock, "mutation-lock", "mutation lock"),
        );
      } catch (error) {
        if (!isFsError(error, "ENOENT")) {
          if (error instanceof z.ZodError)
            throw new SpoolStateError(
              "mutation-lock",
              "malformed mutation lock",
            );
          throw error;
        }
      }
      if (lock !== undefined && now > lock.leaseExpiresAtMs)
        await rm(this.#lock, { force: true });
      return recovered;
    });
  }

  public async cancel(commandId: string): Promise<void> {
    await this.#init();
    await this.#withTransition(commandId, async () => {
      const terminal = await this.#terminal(commandId);
      const pendingPath = join(this.#commands, `${commandId}.pending.json`);
      const runningPath = join(this.#commands, `${commandId}.running.json`);
      const pending = await this.#stored(
        pendingPath,
        commandId,
        "pending command",
      );
      const running = await this.#stored(
        runningPath,
        commandId,
        "running command",
      );
      const command = running ?? pending;
      if (command === undefined && terminal === undefined)
        throw new SpoolStateError(commandId, "not queued or running");
      if (command === undefined) {
        await this.#releaseMutationLock(commandId);
        return;
      }
      const envelope = this.#envelope(command);
      if (terminal !== undefined) this.#assertResultBinding(terminal, envelope);
      const cancelled = AdobeCommandResultV1Schema.parse({
        version: 1,
        commandId,
        nonce: envelope.nonce,
        sceneDigest: envelope.sceneDigest,
        deviceId: envelope.deviceId,
        jobId: envelope.jobId,
        status: "CANCELLED",
        beforeDigest: envelope.sceneDigest,
        afterDigest: envelope.sceneDigest,
        changedFields: [],
        warnings: [],
        payload: {},
      });
      if (
        terminal === undefined &&
        !(await this.#createExclusive(
          join(this.#results, `${commandId}.json`),
          cancelled,
        ))
      ) {
        const winner = await this.#terminal(commandId);
        if (winner === undefined)
          throw new SpoolStateError(commandId, "result disappeared");
        this.#assertResultBinding(winner, envelope);
      }
      await rm(pendingPath, { force: true });
      await rm(runningPath, { force: true });
      await this.#releaseMutationLock(commandId);
    });
  }
}
