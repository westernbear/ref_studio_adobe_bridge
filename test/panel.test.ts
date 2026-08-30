import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Value = Record<string, unknown>;
type Controller = { runNext(confirmed: boolean): boolean; shutdown(): void };
type Fixture = {
  createController(
    io: unknown,
    binding: unknown,
    state: (message: string) => void,
  ): Controller;
  isWorkingCopy(path: string): boolean;
  setDispatch(dispatch: () => Value): void;
};

const command = (tool = "adobe.project.get_v1"): Value => ({
  version: 1,
  commandId: "cmd-panel-01",
  nonce: "nonce-panel-01",
  sceneDigest: "a".repeat(64),
  deviceId: "device-panel",
  jobId: "job-panel",
  projectHandle: "project:working-copy",
  tool,
  args: {},
  status: "QUEUED",
});
const loadFixture = (): Fixture => {
  class Panel {}
  const controls: Value[] = [];
  const context: Value = {
    $: { fileName: "/panel/RVSBridgePanel.jsx", evalFile: () => {} },
    File: (input: string | { fullName: string }) => {
      const path = typeof input === "string" ? input : input.fullName;
      return {
        fullName: path,
        parent: { fullName: path.split("/").slice(0, -1).join("/") },
        name: path.split("/").at(-1),
        exists: false,
        open: () => false,
      };
    },
    Folder: Object.assign(
      (path: string) => ({
        fullName: path,
        exists: true,
        create: () => true,
        getFiles: () => [],
      }),
      { userData: { fullName: "/user" } },
    ),
    Panel,
    Window: function () {
      return {
        add: (_type: string) => {
          const control = {
            text: "",
            value: false,
            preferredSize: [],
            onClick: undefined,
          };
          controls.push(control);
          return control;
        },
        layout: { layout: () => {} },
        show: () => {},
      };
    },
    app: {
      project: { file: { fullName: "/jobs/job-panel.rvs-working-copy.aep" } },
      scheduleTask: () => 7,
      cancelTask: () => {},
      beginUndoGroup: () => {},
      endUndoGroup: () => {},
    },
    RVSDispatch: () => ({ ok: true }),
    Date,
    JSON,
    Error,
    String,
    Math,
  };
  runInNewContext(
    readFileSync(
      new URL("../scripts/panel/RVSBridgePanel.jsx", import.meta.url),
      "utf8",
    ),
    context,
  );
  return {
    ...(context["RVSPanelFixture"] as Fixture),
    setDispatch: (dispatch) => {
      context["RVSDispatch"] = dispatch;
    },
  };
};
const setup = (tool = "adobe.project.get_v1") => {
  const values = new Map<string, Value>();
  const states: string[] = [];
  const queued = command(tool);
  values.set("commands/cmd-panel-01.pending.json", queued);
  values.set("bindings/cmd-panel-01.json", {
    nonce: queued["nonce"],
    sceneDigest: queued["sceneDigest"],
    deviceId: queued["deviceId"],
    jobId: queued["jobId"],
  });
  const io = {
    spoolRoot: () => "/spool",
    workingCopyPath: () => "/jobs/job-panel.rvs-working-copy.aep",
    now: () => 1,
    read: (path: string) => values.get(path) ?? null,
    write: (path: string, value: Value) => values.set(path, value),
    remove: (path: string) => values.delete(path),
    rename: (from: string, to: string) => {
      const value = values.get(from);
      if (!value) return false;
      values.delete(from);
      values.set(to, value);
      return true;
    },
    list: (folder: string, suffix: string) =>
      [...values.keys()]
        .filter((key) => key.startsWith(`${folder}/`) && key.endsWith(suffix))
        .map((key) => key.slice(folder.length + 1)),
  };
  const binding = {
    version: 1,
    deviceId: "device-panel",
    jobId: "job-panel",
    spoolRoot: "/spool",
    workingCopyPath: "/jobs/job-panel.rvs-working-copy.aep",
  };
  return { values, states, io, binding };
};

test("panel fixture exposes working-copy and terminal-state contracts", () => {
  const fixture = loadFixture();
  expect(fixture.isWorkingCopy("/jobs/x.rvs-working-copy.aep")).toBe(true);
  expect(fixture.isWorkingCopy("/jobs/original.aep")).toBe(false);
});

test("panel executes queued readonly command and writes SUCCEEDED result", () => {
  const fixture = loadFixture();
  const { values, states, io, binding } = setup();
  expect(
    fixture
      .createController(io, binding, (state) => states.push(state))
      .runNext(false),
  ).toBe(true);
  expect(values.get("results/cmd-panel-01.json")?.["status"]).toBe("SUCCEEDED");
  expect(states).toContain("cmd-panel-01 QUEUED");
  expect(states).toContain("cmd-panel-01 RUNNING");
});

test("panel retains CANCELLED when shutdown races a returning dispatch", () => {
  const fixture = loadFixture();
  const { values, io, binding } = setup("adobe.rollback_v1");
  let controller: Controller;
  fixture.setDispatch(() => {
    controller.shutdown();
    return { late: true };
  });
  controller = fixture.createController(io, binding, () => {});
  expect(controller.runNext(true)).toBe(true);
  expect(values.get("results/cmd-panel-01.json")?.["status"]).toBe("CANCELLED");
  expect(values.has("mutation.lock.json")).toBe(false);
  expect(values.has("commands/cmd-panel-01.running.json")).toBe(false);
});

test("panel requires explicit confirmation for mutation", () => {
  const fixture = loadFixture();
  const { values, states, io, binding } = setup("adobe.rollback_v1");
  const controller = fixture.createController(io, binding, (state) =>
    states.push(state),
  );
  expect(controller.runNext(false)).toBe(false);
  expect(states.at(-1)).toContain("Confirmation required");
  expect(controller.runNext(true)).toBe(true);
  expect(values.get("results/cmd-panel-01.json")?.["status"]).toBe("SUCCEEDED");
});

test("panel rejects mismatched enrollment and original project paths", () => {
  const fixture = loadFixture();
  const { values, states, io, binding } = setup();
  expect(
    fixture
      .createController(io, { ...binding, jobId: "job-other" }, (state) =>
        states.push(state),
      )
      .runNext(false),
  ).toBe(false);
  expect(states.at(-1)).toContain("binding mismatch");
  expect(
    fixture
      .createController(
        { ...io, workingCopyPath: () => "/jobs/original.aep" },
        binding,
        () => {},
      )
      .runNext(false),
  ).toBe(false);
  expect(values.has("results/cmd-panel-01.json")).toBe(false);
});

test("panel rejects command binding mismatch and respects an existing mutation lock", () => {
  const fixture = loadFixture();
  const { values, states, io, binding } = setup();
  values.set("bindings/cmd-panel-01.json", {
    nonce: "wrong",
    sceneDigest: "a".repeat(64),
    deviceId: "device-panel",
    jobId: "job-panel",
  });
  expect(
    fixture
      .createController(io, binding, (state) => states.push(state))
      .runNext(false),
  ).toBe(false);
  expect(states.at(-1)).toContain("command binding mismatch");
  values.set("bindings/cmd-panel-01.json", {
    nonce: "nonce-panel-01",
    sceneDigest: "a".repeat(64),
    deviceId: "device-panel",
    jobId: "job-panel",
  });
  values.set("mutation.lock.json", { commandId: "cmd-other" });
  expect(
    fixture
      .createController(io, binding, (state) => states.push(state))
      .runNext(false),
  ).toBe(false);
  expect(states.at(-1)).toContain("mutation lock");
});
