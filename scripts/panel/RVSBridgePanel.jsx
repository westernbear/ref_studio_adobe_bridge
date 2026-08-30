(function (host) {
  $.evalFile(File(File($.fileName).parent.fullName + "/rvs-dispatcher.jsx"));
  var POLL_MS = 2000, MAX_LOG_LINES = 100;
  var TERMINAL = { SUCCEEDED: true, FAILED: true, CANCELLED: true };
  var READ_ONLY = { "adobe.project.get_v1": true, "adobe.composition.list_v1": true, "adobe.layer.get_v1": true, "adobe.command.status_v1": true, "adobe.verify_v1": true };
  function fail(message) { throw new Error(message); }
  function isWorkingCopy(path) { return /\.rvs-working-copy\.aep$/i.test(path || ""); }
  function exactKeys(value, allowed, label) { for (var key in value) if (value.hasOwnProperty(key) && !allowed[key]) fail("invalid " + label + " field: " + key); }
  function assertBinding(binding, command, spoolRoot, workingCopyPath) {
    if (!binding || binding.version !== 1) fail("missing panel binding");
    exactKeys(binding, { version: true, deviceId: true, jobId: true, spoolRoot: true, workingCopyPath: true }, "panel binding");
    if (binding.spoolRoot !== spoolRoot || binding.deviceId !== command.deviceId || binding.jobId !== command.jobId || binding.workingCopyPath !== workingCopyPath) fail("panel binding mismatch");
    if (!isWorkingCopy(workingCopyPath)) fail("original AEP is not permitted");
  }
  function isMutation(command) { return !READ_ONLY[command.tool]; }
  function resultFor(command, status, warning, payload) { return { version: 1, commandId: command.commandId, nonce: command.nonce, sceneDigest: command.sceneDigest, deviceId: command.deviceId, jobId: command.jobId, status: status, beforeDigest: command.sceneDigest, afterDigest: command.sceneDigest, changedFields: [], warnings: warning ? [String(warning).slice(0, 500)] : [], payload: payload || {} }; }
  function createController(io, binding, onState) {
    var active = null;
    function emit(message) { if (onState) onState(message); }
    function release(commandId) { var lock = io.read("mutation.lock.json"); if (lock && lock.commandId === commandId) io.remove("mutation.lock.json"); }
    function complete(command, status, warning, payload, result) { io.write("results/" + command.commandId + ".json", result || resultFor(command, status, warning, payload)); io.remove("commands/" + command.commandId + ".running.json"); release(command.commandId); active = null; emit(command.commandId + " " + status); }
    function next(confirmed) {
      if (active) return false;
      if (!isWorkingCopy(io.workingCopyPath())) { emit("Refused: open a job .rvs-working-copy.aep"); return false; }
      var pending = io.list("commands", ".pending.json");
      if (pending.length === 0) { emit("Idle"); return false; }
      pending.sort(); var source = "commands/" + pending[0], command = io.read(source);
      if (!command || command.status !== "QUEUED") { emit("Refused: malformed QUEUED command"); return false; }
      emit(command.commandId + " QUEUED");
      try { assertBinding(binding, command, io.spoolRoot(), io.workingCopyPath()); } catch (error) { emit("Refused: " + error); return false; }
      var commandBinding = io.read("bindings/" + command.commandId + ".json");
      if (!commandBinding || commandBinding.nonce !== command.nonce || commandBinding.deviceId !== command.deviceId || commandBinding.jobId !== command.jobId || commandBinding.sceneDigest !== command.sceneDigest) { emit("Refused: command binding mismatch"); return false; }
      if (isMutation(command) && !confirmed) { emit("Confirmation required: " + command.commandId); return false; }
      if (io.read("mutation.lock.json")) { emit("Waiting: mutation lock"); return false; }
      if (!io.rename(source, "commands/" + command.commandId + ".running.json")) return false;
      io.write("mutation.lock.json", { commandId: command.commandId, acquiredAtMs: io.now(), leaseExpiresAtMs: io.now() + 30000 }); active = command; emit(command.commandId + " RUNNING");
      try { app.beginUndoGroup("RVS " + command.commandId); var result = RVSDispatch(command); app.endUndoGroup(); if (active && active.commandId === command.commandId) complete(command, result.status, "", result.payload, result); } catch (error) { try { app.endUndoGroup(); } catch (ignored) {} if (active && active.commandId === command.commandId) complete(command, "FAILED", error, {}); }
      return true;
    }
    return { runNext: next, shutdown: function () { if (active) complete(active, "CANCELLED", "panel shutdown", {}); emit("CANCELLED"); }, active: function () { return active; } };
  }
  host.RVSPanelFixture = { createController: createController, assertBinding: assertBinding, isWorkingCopy: isWorkingCopy };
  var panel = host instanceof Panel ? host : new Window("palette", "RVS Adobe Bridge", undefined, { resizeable: true });
  var root = Folder(Folder.userData.fullName + "/RVSAdobeBridge/spool"), autoRun = panel.add("checkbox", undefined, "Auto-run (2s)"), confirmMutation = panel.add("checkbox", undefined, "I confirm queued mutations for this job"), runButton = panel.add("button", undefined, "Run next command"), current = panel.add("statictext", undefined, "Idle"), logBox = panel.add("edittext", undefined, "", { multiline: true, readonly: true, scrolling: true }), pollTaskId = null;
  logBox.preferredSize = [420, 160];
  function log(message) { var lines = logBox.text ? logBox.text.split("\n") : []; lines.push(new Date().toISOString() + " " + message); logBox.text = lines.slice(Math.max(0, lines.length - MAX_LOG_LINES)).join("\n"); }
  function file(relative) { return File(root.fullName + "/" + relative); }
  function read(relative) { var target = file(relative); if (!target.exists || !target.open("r")) return null; try { return JSON.parse(target.read()); } catch (error) { return null; } finally { target.close(); } }
  function write(relative, value) { var target = file(relative), temporary = File(target.fullName + ".tmp"); temporary.encoding = "UTF-8"; if (!temporary.open("w")) fail("cannot write spool result"); temporary.write(JSON.stringify(value)); temporary.close(); if (target.exists) target.remove(); if (!temporary.rename(target.name)) fail("atomic result rename failed"); }
  var io = { spoolRoot: function () { return root.fullName; }, workingCopyPath: function () { return app.project.file ? app.project.file.fullName : ""; }, now: function () { return new Date().getTime(); }, read: read, write: write, remove: function (relative) { var target = file(relative); if (target.exists) target.remove(); }, rename: function (from, to) { var source = file(from); return source.exists && source.rename(File(to).name); }, list: function (folder, suffix) { var target = Folder(root.fullName + "/" + folder); if (!target.exists) target.create(); var files = target.getFiles("*" + suffix), names = []; for (var i = 0; i < files.length; i += 1) names.push(files[i].name); return names; } };
  var binding = read("panel-binding.json"), controller = createController(io, binding, function (message) { current.text = message; log(message); });
  function schedulePoll() { if (pollTaskId === null) pollTaskId = app.scheduleTask("RVSPoll()", POLL_MS, false); }
  host.RVSPoll = function () { pollTaskId = null; if (autoRun.value) controller.runNext(confirmMutation.value); schedulePoll(); };
  host.RVSShutdown = function () { if (pollTaskId !== null) app.cancelTask(pollTaskId); pollTaskId = null; controller.shutdown(); };
  runButton.onClick = function () { controller.runNext(confirmMutation.value); }; schedulePoll(); panel.layout.layout(true); if (panel instanceof Window) panel.show();
}(this));
