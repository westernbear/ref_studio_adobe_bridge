#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { AdobeCommandEnvelopeSchema } from "./contracts.js";
import { runStdioServer } from "./server.js";
import { CommandSpool } from "./spool.js";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const digestFile = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const main = async (): Promise<void> => {
  if (process.env["RVS_ADOBE_MCP"] !== "true")
    throw new Error("ADOBE_MCP_DISABLED");
  const mode = process.argv[2] ?? "stdio";
  const { RVS_ADOBE_SPOOL } = process.env;
  const spoolRoot = option("--spool") ?? RVS_ADOBE_SPOOL;
  if (spoolRoot === undefined)
    throw new TypeError("--spool or RVS_ADOBE_SPOOL is required");
  if (mode === "stdio") {
    await runStdioServer(spoolRoot);
    return;
  }
  const spool = new CommandSpool(spoolRoot);
  if (mode === "enqueue") {
    const input = AdobeCommandEnvelopeSchema.parse(
      JSON.parse(await Bun.stdin.text()),
    );
    process.stdout.write(`${JSON.stringify(await spool.enqueue(input))}\n`);
    return;
  }
  if (mode === "once") {
    const original = option("--original-aep");
    if (original === undefined)
      throw new TypeError("--original-aep is required");
    const command = await spool.claimNext();
    if (command === undefined) return;
    const digest = await digestFile(original);
    const result = await spool.complete({
      version: 1,
      commandId: command.commandId,
      nonce: command.nonce,
      sceneDigest: command.sceneDigest,
      deviceId: command.deviceId,
      jobId: command.jobId,
      status: "SUCCEEDED",
      beforeDigest: digest,
      afterDigest: await digestFile(original),
      changedFields: [],
      warnings: ["fixture execution: After Effects readback unavailable"],
      payload: { fixture: true },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new TypeError(`unknown mode: ${mode}`);
};

await main();
