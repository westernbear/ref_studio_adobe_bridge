(function (host) {
  $.evalFile(File(File($.fileName).parent.fullName + "/rvs-dispatcher.jsx"));
  var panel = host instanceof Panel ? host : new Window("palette", "RVS Adobe Bridge", undefined, { resizeable: true });
  var root = Folder(Folder.userData.fullName + "/RVSAdobeBridge/spool");
  var commands = Folder(root.fullName + "/commands");
  var results = Folder(root.fullName + "/results");
  var autoRun = panel.add("checkbox", undefined, "Auto-run (2s)");
  var runButton = panel.add("button", undefined, "Run next command");
  var current = panel.add("statictext", undefined, "Idle");
  var logBox = panel.add("edittext", undefined, "", { multiline: true, readonly: true, scrolling: true });
  logBox.preferredSize = [420, 160];
  function log(message) {
    var lines = logBox.text ? logBox.text.split("\n") : [];
    lines.push(new Date().toISOString() + " " + message);
    logBox.text = lines.slice(Math.max(0, lines.length - 100)).join("\n");
  }
  function atomicWrite(file, value) {
    var temporary = File(file.fullName + ".tmp");
    temporary.encoding = "UTF-8"; temporary.open("w"); temporary.write(JSON.stringify(value)); temporary.close();
    if (!temporary.rename(file.name)) throw new Error("atomic result rename failed");
  }
  function runNext() {
    if (!app.project.file || app.project.file.name.indexOf(".rvs-working-copy.aep") < 0) {
      log("Refused: open an .rvs-working-copy.aep file"); return;
    }
    if (!commands.exists) commands.create();
    if (!results.exists) results.create();
    var pending = commands.getFiles("*.pending.json");
    if (pending.length === 0) return;
    pending.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    var source = pending[0]; var running = File(source.fullName.replace(".pending.json", ".running.json"));
    if (!source.rename(running.name)) return;
    running.open("r"); var command = JSON.parse(running.read()); running.close();
    current.text = command.commandId + " RUNNING";
    var result;
    try {
      app.beginUndoGroup("RVS " + command.commandId);
      var payload = RVSDispatch(command);
      app.endUndoGroup();
      result = { version: 1, commandId: command.commandId, nonce: command.nonce, sceneDigest: command.sceneDigest,
        deviceId: command.deviceId, jobId: command.jobId,
        status: "SUCCEEDED", beforeDigest: command.sceneDigest, afterDigest: command.sceneDigest,
        changedFields: [], warnings: [], payload: payload };
    } catch (error) {
      try { app.endUndoGroup(); } catch (ignored) {}
      result = { version: 1, commandId: command.commandId, nonce: command.nonce, sceneDigest: command.sceneDigest,
        deviceId: command.deviceId, jobId: command.jobId,
        status: "FAILED", beforeDigest: command.sceneDigest, afterDigest: command.sceneDigest,
        changedFields: [], warnings: [String(error).slice(0, 500)], payload: {} };
    }
    atomicWrite(File(results.fullName + "/" + command.commandId + ".json"), result);
    running.remove(); current.text = command.commandId + " " + result.status; log(current.text);
  }
  runButton.onClick = runNext;
  host.RVSPoll = function () { if (autoRun.value) runNext(); app.scheduleTask("RVSPoll()", 2000, false); };
  app.scheduleTask("RVSPoll()", 2000, false);
  panel.layout.layout(true);
  if (panel instanceof Window) panel.show();
}(this));
