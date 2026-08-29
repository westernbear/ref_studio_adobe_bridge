import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type {
  AdobeCommandEnvelope,
  AdobeCommandResult,
  QueuedCommand,
  RunningCommand,
} from "./contracts.js";
import {
  AdobeCommandEnvelopeSchema,
  AdobeCommandResultSchema,
  StoredCommandSchema,
} from "./contracts.js";
import { BindingError, SpoolStateError } from "./errors.js";

const parseJson = (contents: string): unknown => JSON.parse(contents);

export class CommandSpool {
  readonly #commands: string;
  readonly #results: string;
  readonly #bindings: string;

  public constructor(root: string) {
    this.#commands = join(root, "commands");
    this.#results = join(root, "results");
    this.#bindings = join(root, "bindings");
  }

  async #init(): Promise<void> {
    await Promise.all([
      mkdir(this.#commands, { recursive: true }),
      mkdir(this.#results, { recursive: true }),
      mkdir(this.#bindings, { recursive: true }),
    ]);
  }

  async #writeAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  }

  public async enqueue(input: unknown): Promise<QueuedCommand> {
    const command = AdobeCommandEnvelopeSchema.parse(input);
    await this.#init();
    const bindingPath = join(this.#bindings, `${command.commandId}.json`);
    const binding = {
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: command.deviceId,
      jobId: command.jobId,
    };
    try {
      await writeFile(bindingPath, `${JSON.stringify(binding)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
      const existing = parseJson(await readFile(bindingPath, "utf8"));
      if (JSON.stringify(existing) !== JSON.stringify(binding))
        throw new BindingError(command.commandId);
    }
    const queued = { ...command, status: "QUEUED" as const };
    await this.#writeAtomic(
      join(this.#commands, `${command.commandId}.pending.json`),
      queued,
    );
    return queued;
  }

  public async claimNext(): Promise<RunningCommand | undefined> {
    await this.#init();
    const pending = (await readdir(this.#commands))
      .filter((name) => name.endsWith(".pending.json"))
      .sort()[0];
    if (pending === undefined) return undefined;
    const from = join(this.#commands, pending);
    const to = join(
      this.#commands,
      pending.replace(".pending.json", ".running.json"),
    );
    await rename(from, to);
    const queued = StoredCommandSchema.parse(
      parseJson(await readFile(to, "utf8")),
    );
    const running = { ...queued, status: "RUNNING" as const };
    await this.#writeAtomic(to, running);
    return running;
  }

  public async complete(input: unknown): Promise<AdobeCommandResult> {
    const result = AdobeCommandResultSchema.parse(input);
    await this.#init();
    const runningPath = join(
      this.#commands,
      `${result.commandId}.running.json`,
    );
    const running = StoredCommandSchema.parse(
      parseJson(await readFile(runningPath, "utf8")),
    );
    if (
      running.nonce !== result.nonce ||
      running.sceneDigest !== result.sceneDigest
    )
      throw new BindingError(result.commandId);
    await this.#writeAtomic(
      join(this.#results, `${result.commandId}.json`),
      result,
    );
    await rm(runningPath);
    return result;
  }

  public async result(
    command: AdobeCommandEnvelope,
  ): Promise<AdobeCommandResult> {
    const result = AdobeCommandResultSchema.parse(
      parseJson(
        await readFile(
          join(this.#results, `${command.commandId}.json`),
          "utf8",
        ),
      ),
    );
    if (
      result.nonce !== command.nonce ||
      result.sceneDigest !== command.sceneDigest
    )
      throw new BindingError(command.commandId);
    return result;
  }

  public async recover(): Promise<number> {
    await this.#init();
    const running = (await readdir(this.#commands)).filter((name) =>
      name.endsWith(".running.json"),
    );
    await Promise.all(
      running.map(async (name) => {
        const path = join(this.#commands, name);
        const command = StoredCommandSchema.parse(
          parseJson(await readFile(path, "utf8")),
        );
        await this.#writeAtomic(
          path.replace(".running.json", ".pending.json"),
          { ...command, status: "QUEUED" },
        );
      }),
    );
    return running.length;
  }

  public async cancel(commandId: string): Promise<void> {
    await this.#init();
    const pendingPath = join(this.#commands, `${commandId}.pending.json`);
    let command: AdobeCommandEnvelope;
    try {
      command = AdobeCommandEnvelopeSchema.parse(
        parseJson(await readFile(pendingPath, "utf8")),
      );
    } catch (error) {
      if (error instanceof Error)
        throw new SpoolStateError(commandId, "not queued");
      throw error;
    }
    await this.#writeAtomic(join(this.#results, `${commandId}.json`), {
      version: 1,
      commandId,
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      status: "CANCELLED",
      beforeDigest: command.sceneDigest,
      afterDigest: command.sceneDigest,
      changedFields: [],
      warnings: [],
      payload: {},
    });
    await rm(pendingPath);
  }
}
