#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AdobeCommandEnvelopeV1Schema } from "./contracts.js";
import { finalizePanelResult } from "./execution.js";
import { runStdioServer } from "./server.js";
import { CommandSpool } from "./spool.js";
import { AdobeWorkingCopy } from "./working-copy.js";

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
  if (mode === "prepare") {
    const original = option("--original-aep");
    const jobId = option("--job-id");
    const sceneDigest = option("--scene-digest");
    if (
      original === undefined ||
      jobId === undefined ||
      sceneDigest === undefined
    )
      throw new TypeError(
        "--original-aep, --job-id and --scene-digest are required",
      );
    const project = await AdobeWorkingCopy.open(
      option("--workspace") ?? join(spoolRoot, "working-copies"),
      jobId,
      original,
    );
    await project.snapshot(sceneDigest);
    process.stdout.write(`${JSON.stringify({ projectPath: project.path })}\n`);
    return;
  }
  if (mode === "enqueue") {
    const input = AdobeCommandEnvelopeV1Schema.parse(
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
  if (mode === "finalize") {
    const original = option("--original-aep");
    const panelResultPath = option("--panel-result");
    if (original === undefined || panelResultPath === undefined)
      throw new TypeError("--original-aep and --panel-result are required");
    const command = await spool.claimNext();
    if (command === undefined) return;
    const project = await AdobeWorkingCopy.open(
      option("--workspace") ?? join(spoolRoot, "working-copies"),
      command.jobId,
      original,
    );
    const renderProgram = process.env["RVS_ADOBE_RENDER_PROGRAM"];
    const uploadProgram = process.env["RVS_ADOBE_UPLOAD_PROGRAM"];
    const connectorAuthorization = process.env["RVS_ADOBE_UPLOAD_AUTH"];
    if (
      command.tool === "adobe.render_upload_v1" &&
      (renderProgram === undefined ||
        uploadProgram === undefined ||
        connectorAuthorization === undefined)
    )
      throw new TypeError("local render/upload configuration is required");
    const { status: _status, ...envelope } = command;
    const result = await finalizePanelResult(
      AdobeCommandEnvelopeV1Schema.parse(envelope),
      JSON.parse(await readFile(panelResultPath, "utf8")),
      {
        project,
        renderProgram,
        uploadProgram,
        connectorAuthorization:
          connectorAuthorization ?? "local-connector-only",
      },
    );
    process.stdout.write(`${JSON.stringify(await spool.complete(result))}\n`);
    return;
  }
  throw new TypeError(`unknown mode: ${mode}`);
};

await main();
