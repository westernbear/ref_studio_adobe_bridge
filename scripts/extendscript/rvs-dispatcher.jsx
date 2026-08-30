(function (global) {
  var PROPERTY_IDS = { "ADBE Anchor Point": true, "ADBE Position": true, "ADBE Scale": true, "ADBE Rotate Z": true, "ADBE Opacity": true };
  var EFFECT_IDS = { "ADBE Drop Shadow": true };
  var EFFECT_TEMPLATES = { "drop-shadow-v1": true };
  var EXPRESSION_TEMPLATES = { "loop-cycle-v1": true };
  var TOP_LEVEL_KEYS = { version: true, commandId: true, nonce: true, sceneDigest: true, deviceId: true, jobId: true, projectHandle: true, tool: true, args: true };
  var ARG_KEYS = {
    "adobe.project.get_v1": {}, "adobe.composition.list_v1": {},
    "adobe.composition.create_v1": { name: true, width: true, height: true, durationSeconds: true, frameRate: true },
    "adobe.composition.update_v1": { compHandle: true, width: true, height: true, durationSeconds: true, frameRate: true },
    "adobe.layer.get_v1": { compHandle: true, layerHandle: true },
    "adobe.layer.create_text_v1": { compHandle: true, text: true },
    "adobe.layer.create_shape_v1": { compHandle: true, shape: true, color: true },
    "adobe.layer.create_solid_v1": { compHandle: true, color: true },
    "adobe.layer.create_camera_v1": { compHandle: true }, "adobe.layer.create_null_v1": { compHandle: true },
    "adobe.layer.duplicate_v1": { compHandle: true, layerHandle: true }, "adobe.layer.delete_v1": { compHandle: true, layerHandle: true },
    "adobe.layer.set_properties_v1": { compHandle: true, layerHandle: true, properties: true },
    "adobe.layer.batch_set_properties_v1": { compHandle: true, layers: true },
    "adobe.animation.set_keyframes_v1": { compHandle: true, layerHandle: true, keyframes: true },
    "adobe.mask.set_v1": { compHandle: true, layerHandle: true, mode: true, vertices: true },
    "adobe.effect.apply_v1": { compHandle: true, layerHandle: true, effectId: true },
    "adobe.effect.apply_template_v1": { compHandle: true, layerHandle: true, templateId: true },
    "adobe.expression.apply_template_v1": { compHandle: true, layerHandle: true, templateId: true, propertyId: true },
    "adobe.expression.remove_v1": { compHandle: true, layerHandle: true, propertyId: true },
    "adobe.command.status_v1": { targetCommandId: true }, "adobe.command.cancel_v1": { targetCommandId: true },
    "adobe.verify_v1": { compHandle: true, expectedSceneDigest: true },
    "adobe.render_upload_v1": { compHandle: true, outputName: true }, "adobe.rollback_v1": { expectedSceneDigest: true }
  };
  var REQUIRED_KEYS = {
    "adobe.project.get_v1": [], "adobe.composition.list_v1": [],
    "adobe.composition.create_v1": ["name", "width", "height", "durationSeconds", "frameRate"],
    "adobe.composition.update_v1": ["compHandle"], "adobe.layer.get_v1": ["compHandle", "layerHandle"],
    "adobe.layer.create_text_v1": ["compHandle", "text"], "adobe.layer.create_shape_v1": ["compHandle", "shape", "color"],
    "adobe.layer.create_solid_v1": ["compHandle", "color"], "adobe.layer.create_camera_v1": ["compHandle"], "adobe.layer.create_null_v1": ["compHandle"],
    "adobe.layer.duplicate_v1": ["compHandle", "layerHandle"], "adobe.layer.delete_v1": ["compHandle", "layerHandle"],
    "adobe.layer.set_properties_v1": ["compHandle", "layerHandle", "properties"], "adobe.layer.batch_set_properties_v1": ["compHandle", "layers"],
    "adobe.animation.set_keyframes_v1": ["compHandle", "layerHandle", "keyframes"], "adobe.mask.set_v1": ["compHandle", "layerHandle", "mode", "vertices"],
    "adobe.effect.apply_v1": ["compHandle", "layerHandle", "effectId"], "adobe.effect.apply_template_v1": ["compHandle", "layerHandle", "templateId"],
    "adobe.expression.apply_template_v1": ["compHandle", "layerHandle", "templateId", "propertyId"], "adobe.expression.remove_v1": ["compHandle", "layerHandle", "propertyId"],
    "adobe.command.status_v1": ["targetCommandId"], "adobe.command.cancel_v1": ["targetCommandId"],
    "adobe.verify_v1": ["compHandle", "expectedSceneDigest"], "adobe.render_upload_v1": ["compHandle", "outputName"], "adobe.rollback_v1": ["expectedSceneDigest"]
  };
  function fail(message) { throw new Error(message); }
  function validateProperties(values) {
    for (var key in values) if (values.hasOwnProperty(key) && !PROPERTY_IDS[key]) fail("unknown property: " + key);
  }
  function finitePositive(value, name) {
    if (typeof value !== "number" || !isFinite(value) || value <= 0) fail("invalid numeric argument: " + name);
  }
  function exactKeys(value, allowed, label) {
    for (var key in value) if (value.hasOwnProperty(key) && !allowed[key]) fail("unknown " + label + " field: " + key);
  }
  function validateCommand(command) {
    for (var field in command) if (command.hasOwnProperty(field) && !TOP_LEVEL_KEYS[field]) fail("unknown command field: " + field);
    if (command.version !== 1 || command.projectHandle !== "project:working-copy" || !ARG_KEYS[command.tool]) fail("invalid command envelope");
    if (typeof command.nonce !== "string" || !command.nonce || typeof command.deviceId !== "string" || !command.deviceId || typeof command.jobId !== "string" || !command.jobId) fail("missing command binding");
    var args = command.args;
    for (var arg in args) if (args.hasOwnProperty(arg) && !ARG_KEYS[command.tool][arg]) fail("unknown tool argument: " + arg);
    for (var required = 0; required < REQUIRED_KEYS[command.tool].length; required += 1)
      if (!args.hasOwnProperty(REQUIRED_KEYS[command.tool][required])) fail("missing tool argument: " + REQUIRED_KEYS[command.tool][required]);
    if (args.properties) validateProperties(args.properties);
    if (args.layers) for (var i = 0; i < args.layers.length; i += 1) validateProperties(args.layers[i].properties);
    if (args.keyframes) for (var j = 0; j < args.keyframes.length; j += 1) if (!PROPERTY_IDS[args.keyframes[j].property]) fail("unknown property: " + args.keyframes[j].property);
    if (command.tool === "adobe.composition.create_v1") {
      finitePositive(args.width, "width"); finitePositive(args.height, "height");
      finitePositive(args.durationSeconds, "durationSeconds"); finitePositive(args.frameRate, "frameRate");
    }
    if (command.tool === "adobe.composition.update_v1") {
      if (args.width !== undefined) finitePositive(args.width, "width");
      if (args.height !== undefined) finitePositive(args.height, "height");
      if (args.durationSeconds !== undefined) finitePositive(args.durationSeconds, "durationSeconds");
      if (args.frameRate !== undefined) finitePositive(args.frameRate, "frameRate");
    }
    if (command.tool === "adobe.mask.set_v1" && args.mode !== "add" && args.mode !== "subtract" && args.mode !== "intersect") fail("invalid mask mode");
    if (args.layers) for (var layerIndex = 0; layerIndex < args.layers.length; layerIndex += 1)
      exactKeys(args.layers[layerIndex], { layerHandle: true, properties: true }, "batch layer");
    if (args.keyframes) for (var keyframeIndex = 0; keyframeIndex < args.keyframes.length; keyframeIndex += 1)
      exactKeys(args.keyframes[keyframeIndex], { property: true, frame: true, value: true, easing: true }, "keyframe");
    if (command.tool === "adobe.effect.apply_v1" && !EFFECT_IDS[args.effectId]) fail("unapproved effectId");
    if (command.tool === "adobe.effect.apply_template_v1" && !EFFECT_TEMPLATES[args.templateId]) fail("unapproved effect templateId");
    if (command.tool === "adobe.expression.apply_template_v1" && !EXPRESSION_TEMPLATES[args.templateId]) fail("unapproved expression templateId");
  }
  function comp(handle) {
    var id = Number(String(handle).split(":")[1]);
    for (var i = 1; i <= app.project.numItems; i += 1) {
      var item = app.project.item(i);
      if (item instanceof CompItem && item.id === id) return item;
    }
    return fail("unknown compHandle");
  }
  function layer(args) {
    var target = comp(args.compHandle);
    var id = Number(String(args.layerHandle).split(":")[1]);
    for (var i = 1; i <= target.numLayers; i += 1) if (target.layer(i).id === id) return target.layer(i);
    return fail("unknown layerHandle");
  }
  function layerResult(value) { return { layerHandle: "layer:" + value.id, name: value.name }; }
  function setProperties(target, values) {
    for (var key in values) {
      if (!values.hasOwnProperty(key)) continue;
      var property = target.property(key);
      if (!property) fail("unknown property: " + key);
      property.setValue(values[key]);
    }
  }
  function createLayer(tool, args) {
    var target = comp(args.compHandle);
    if (tool === "adobe.layer.create_text_v1") return target.layers.addText(args.text || "");
    if (tool === "adobe.layer.create_solid_v1") return target.layers.addSolid(args.color, "Solid", target.width, target.height, 1);
    if (tool === "adobe.layer.create_camera_v1") return target.layers.addCamera("Camera", [target.width / 2, target.height / 2]);
    if (tool === "adobe.layer.create_null_v1") return target.layers.addNull();
    var shapeLayer = target.layers.addShape();
    shapeLayer.name = args.name || "Shape";
    var vectors = shapeLayer.property("ADBE Root Vectors Group");
    vectors.addProperty(args.shape === "ellipse" ? "ADBE Vector Shape - Ellipse" : "ADBE Vector Shape - Rect");
    return shapeLayer;
  }
  function execute(command) {
    validateCommand(command);
    var a = command.args;
    switch (command.tool) {
      case "adobe.project.get_v1": return { name: app.project.file ? app.project.file.name : null, itemCount: app.project.numItems };
      case "adobe.composition.list_v1":
        var compositions = [];
        for (var i = 1; i <= app.project.numItems; i += 1) if (app.project.item(i) instanceof CompItem) compositions.push({ compHandle: "comp:" + app.project.item(i).id, name: app.project.item(i).name });
        return { compositions: compositions };
      case "adobe.composition.create_v1":
        var created = app.project.items.addComp(a.name, a.width, a.height, 1, a.durationSeconds, a.frameRate);
        return { compHandle: "comp:" + created.id };
      case "adobe.composition.update_v1":
        var updated = comp(a.compHandle);
        if (a.width !== undefined) updated.width = a.width;
        if (a.height !== undefined) updated.height = a.height;
        if (a.durationSeconds !== undefined) updated.duration = a.durationSeconds;
        if (a.frameRate !== undefined) updated.frameRate = a.frameRate;
        return { compHandle: a.compHandle };
      case "adobe.layer.get_v1": return layerResult(layer(a));
      case "adobe.layer.create_text_v1":
      case "adobe.layer.create_shape_v1":
      case "adobe.layer.create_solid_v1":
      case "adobe.layer.create_camera_v1":
      case "adobe.layer.create_null_v1": return layerResult(createLayer(command.tool, a));
      case "adobe.layer.duplicate_v1": return layerResult(layer(a).duplicate());
      case "adobe.layer.delete_v1": layer(a).remove(); return {};
      case "adobe.layer.set_properties_v1": setProperties(layer(a), a.properties); return {};
      case "adobe.layer.batch_set_properties_v1":
        for (var j = 0; j < a.layers.length; j += 1) setProperties(layer({ compHandle: a.compHandle, layerHandle: a.layers[j].layerHandle }), a.layers[j].properties);
        return { count: a.layers.length };
      case "adobe.animation.set_keyframes_v1":
        var animated = layer(a);
        for (var k = 0; k < a.keyframes.length; k += 1) {
          var frame = a.keyframes[k];
          var prop = animated.property(frame.property);
          if (!prop) fail("unknown property: " + frame.property);
          prop.setValueAtTime(frame.frame / comp(a.compHandle).frameRate, frame.value);
        }
        return { count: a.keyframes.length };
      case "adobe.mask.set_v1":
        var mask = layer(a).property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var shape = new Shape(); shape.vertices = a.vertices; shape.closed = true;
        mask.property("ADBE Mask Shape").setValue(shape); return {};
      case "adobe.effect.apply_v1":
        var effect = layer(a).property("ADBE Effect Parade").addProperty(a.effectId);
        if (!effect) fail("effect unavailable"); return { effectName: effect.name };
      case "adobe.effect.apply_template_v1": return applyTemplate(layer(a), "effect", a.templateId, a.parameters);
      case "adobe.expression.apply_template_v1": return applyTemplate(layer(a), "expression", a.templateId, { propertyId: a.propertyId });
      case "adobe.expression.remove_v1": layer(a).property(a.propertyId).expression = ""; return {};
      case "adobe.command.status_v1": return { commandId: a.targetCommandId, status: "RUNNING" };
      case "adobe.command.cancel_v1": return { commandId: a.targetCommandId, cancelled: false };
      case "adobe.verify_v1": return { projectOpen: app.project.file !== null, expectedSceneDigest: a.expectedSceneDigest };
      case "adobe.render_upload_v1": return { queued: true, outputName: a.outputName };
      case "adobe.rollback_v1": app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); return { rolledBack: true };
      default: return fail("unknown tool");
    }
  }
  function applyTemplate(target, kind, id, parameters) {
    if (kind === "expression" && id === "loop-cycle-v1") {
      target.property(parameters.propertyId).expression = "loopOut('cycle')";
      return { templateId: id };
    }
    if (kind === "effect" && id === "drop-shadow-v1") {
      var effect = target.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
      if (!effect) fail("approved effect unavailable");
      return { templateId: id };
    }
    return fail("unapproved templateId");
  }
  global.RVSDispatch = execute;
}(this));
