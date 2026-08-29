(function (global) {
  var PROPERTY_IDS = { "ADBE Anchor Point": true, "ADBE Position": true, "ADBE Scale": true, "ADBE Rotate Z": true, "ADBE Opacity": true };
  var EFFECT_IDS = { "ADBE Drop Shadow": true };
  var EFFECT_TEMPLATES = { "drop-shadow-v1": true };
  var EXPRESSION_TEMPLATES = { "loop-cycle-v1": true };
  function fail(message) { throw new Error(message); }
  function validateProperties(values) {
    for (var key in values) if (values.hasOwnProperty(key) && !PROPERTY_IDS[key]) fail("unknown property: " + key);
  }
  function validateCommand(command) {
    var args = command.args;
    if (args.properties) validateProperties(args.properties);
    if (args.layers) for (var i = 0; i < args.layers.length; i += 1) validateProperties(args.layers[i].properties);
    if (args.keyframes) for (var j = 0; j < args.keyframes.length; j += 1) if (!PROPERTY_IDS[args.keyframes[j].property]) fail("unknown property: " + args.keyframes[j].property);
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
    if (tool === "adobe.layer.create_solid_v1") return target.layers.addSolid(args.color, args.name, args.width, args.height, 1);
    if (tool === "adobe.layer.create_camera_v1") return target.layers.addCamera(args.name, [target.width / 2, target.height / 2]);
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
      case "adobe.composition.update_v1": setProperties(comp(a.compHandle), a.properties); return { compHandle: a.compHandle };
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
        var shape = new Shape(); shape.vertices = a.mask.vertices; shape.closed = true;
        mask.property("ADBE Mask Shape").setValue(shape); return {};
      case "adobe.effect.apply_v1":
        var effect = layer(a).property("ADBE Effect Parade").addProperty(a.effectId);
        if (!effect) fail("effect unavailable"); return { effectName: effect.name };
      case "adobe.effect.apply_template_v1": return applyTemplate(layer(a), "effect", a.templateId, a.parameters);
      case "adobe.expression.apply_template_v1": return applyTemplate(layer(a), "expression", a.templateId, a.parameters);
      case "adobe.expression.remove_v1": layer(a).property(a.propertyId).expression = ""; return {};
      case "adobe.command.status_v1": return { commandId: a.commandId, status: "RUNNING" };
      case "adobe.command.cancel_v1": return { commandId: a.commandId, cancelled: false };
      case "adobe.verify_v1": return { projectOpen: app.project.file !== null, expectedSceneDigest: a.expectedSceneDigest };
      case "adobe.render_upload_v1": return { queued: true, outputName: a.outputName };
      case "adobe.rollback_v1": app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); return { rolledBack: true };
      default: return fail("unknown tool");
    }
  }
  function applyTemplate(target, kind, id, parameters) {
    if (kind === "expression" && id === "loop-cycle-v1") {
      target.property(parameters.property).expression = "loopOut('cycle')";
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
