(function (global) {
  // allow: SIZE_OK — one self-contained ES3 dispatcher is required by the AE ScriptUI runtime.
  var PROPERTY_IDS = { "ADBE Anchor Point": true, "ADBE Position": true, "ADBE Scale": true, "ADBE Rotate Z": true, "ADBE Opacity": true };
  var EFFECT_IDS = { "ADBE Drop Shadow": true };
  var EFFECT_TEMPLATES = { "drop-shadow-v1": true };
  var EXPRESSION_TEMPLATES = { "loop-cycle-v1": true };
  var MUTATIONS = {
    "adobe.composition.create_v1": true, "adobe.composition.update_v1": true,
    "adobe.layer.create_text_v1": true, "adobe.layer.create_shape_v1": true,
    "adobe.layer.create_solid_v1": true, "adobe.layer.create_camera_v1": true,
    "adobe.layer.create_null_v1": true, "adobe.layer.duplicate_v1": true,
    "adobe.layer.delete_v1": true, "adobe.layer.set_properties_v1": true,
    "adobe.layer.batch_set_properties_v1": true, "adobe.animation.set_keyframes_v1": true,
    "adobe.mask.set_v1": true, "adobe.effect.apply_v1": true,
    "adobe.effect.apply_template_v1": true, "adobe.expression.apply_template_v1": true,
    "adobe.expression.remove_v1": true, "adobe.rollback_v1": true
  };
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
  var STATE = { commands: {}, rollbackDigest: null, rollbackPath: null };
  var SHA_H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var SHA_K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  function fail(message) { throw new Error(message); }
  function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
  function isArray(value) { return Object.prototype.toString.call(value) === "[object Array]"; }
  function rotate(value, amount) { return value >>> amount | value << (32 - amount); }
  function sha256(value) {
    var text = unescape(encodeURIComponent(value)), words = [], bitLength = text.length * 8, i, j;
    text += "\x80";
    while (text.length % 64 !== 56) text += "\x00";
    for (i = 0; i < text.length; i += 1) words[i >> 2] = (words[i >> 2] || 0) | text.charCodeAt(i) << ((3 - i) % 4) * 8;
    words.push(Math.floor(bitLength / 4294967296));
    words.push(bitLength);
    var hash = SHA_H.slice(0);
    for (j = 0; j < words.length; j += 16) {
      var chunk = words.slice(j, j + 16), old = hash.slice(0), a, e, first, second, prior, recent;
      for (i = 0; i < 64; i += 1) {
        prior = chunk[i - 15]; recent = chunk[i - 2];
        if (i >= 16) chunk[i] = ((rotate(recent, 17) ^ rotate(recent, 19) ^ recent >>> 10) + chunk[i - 7] + (rotate(prior, 7) ^ rotate(prior, 18) ^ prior >>> 3) + chunk[i - 16]) | 0;
        a = hash[0]; e = hash[4];
        first = (hash[7] + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + SHA_K[i] + chunk[i]) | 0;
        second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]))) | 0;
        hash = [(first + second) | 0, hash[0], hash[1], hash[2], (hash[3] + first) | 0, hash[4], hash[5], hash[6]];
      }
      for (i = 0; i < 8; i += 1) hash[i] = (hash[i] + old[i]) | 0;
    }
    var result = "";
    for (i = 0; i < hash.length; i += 1) for (j = 3; j >= 0; j -= 1) result += ("0" + (hash[i] >> (j * 8) & 255).toString(16)).slice(-2);
    return result;
  }
  function stable(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (isArray(value)) {
      var values = [];
      for (var i = 0; i < value.length; i += 1) values.push(stable(value[i]));
      return "[" + values.join(",") + "]";
    }
    var keys = [], parts = [];
    for (var key in value) if (own(value, key)) keys.push(key);
    keys.sort();
    for (var j = 0; j < keys.length; j += 1) parts.push(JSON.stringify(keys[j]) + ":" + stable(value[keys[j]]));
    return "{" + parts.join(",") + "}";
  }
  function copyValue(value) {
    if (value === undefined) return null;
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
    if (isArray(value) || (typeof value !== "string" && typeof value.length === "number")) {
      var array = [];
      for (var i = 0; i < value.length; i += 1) array.push(copyValue(value[i]));
      return array;
    }
    if (typeof value === "object" && value.text !== undefined) return { text: String(value.text) };
    if (typeof value === "object") {
      var object = {};
      for (var key in value) if (own(value, key) && typeof value[key] !== "function") object[key] = copyValue(value[key]);
      return object;
    }
    return String(value);
  }
  function propertySnapshot(target, id, frameRate) {
    var property = target.property(id);
    if (!property) return null;
    var result = {};
    if (property.value !== undefined && property.value !== null) result.value = copyValue(property.value);
    if (property.expression !== undefined && property.expression !== "") result.expression = String(property.expression);
    var count = property.numKeys !== undefined ? property.numKeys : (property.keys ? property.keys.length : 0);
    if (count > 0) {
      result.keyframes = [];
      for (var i = 1; i <= count; i += 1) {
        var time = property.keyTime ? property.keyTime(i) : property.keys[i - 1].frameTime;
        result.keyframes.push({
          frame: Math.round(time * frameRate), time: time,
          value: copyValue(property.keyValue ? property.keyValue(i) : property.keys[i - 1].value),
          easing: property.keyEasing ? property.keyEasing(i) : (property.keys ? property.keys[i - 1].easing : "applied")
        });
      }
    }
    return result;
  }
  function layerSnapshot(value, frameRate) {
    var properties = {};
    for (var id in PROPERTY_IDS) if (own(PROPERTY_IDS, id)) {
      var property = propertySnapshot(value, id, frameRate);
      if (property && (property.value !== undefined || property.expression !== undefined || property.keyframes !== undefined)) properties[id] = property;
    }
    var effects = [], parade = value.property("ADBE Effect Parade");
    if (parade && parade.numProperties) for (var i = 1; i <= parade.numProperties; i += 1) effects.push(String(parade.property(i).name));
    var masks = [], maskParade = value.property("ADBE Mask Parade");
    if (maskParade && maskParade.numProperties) for (var j = 1; j <= maskParade.numProperties; j += 1) {
      var mask = maskParade.property(j), shape = mask.property("ADBE Mask Shape").value;
      masks.push({ mode: mask.rvsMode || "add", vertices: shape ? copyValue(shape.vertices) : [], closed: shape ? shape.closed === true : false });
    }
    return {
      layerHandle: "layer:" + value.id, name: String(value.name),
      kind: value.kind ? String(value.kind) : "layer",
      source: value.source !== undefined ? copyValue(value.source) : null,
      properties: properties, effects: effects, masks: masks
    };
  }
  function projectSnapshot() {
    var compositions = [];
    for (var i = 1; i <= app.project.numItems; i += 1) {
      var item = app.project.item(i);
      if (!(item instanceof CompItem)) continue;
      var layers = [];
      for (var j = 1; j <= item.numLayers; j += 1) layers.push(layerSnapshot(item.layer(j), item.frameRate));
      compositions.push({
        compHandle: "comp:" + item.id, name: String(item.name), width: item.width,
        height: item.height, durationSeconds: item.duration, frameRate: item.frameRate, layers: layers
      });
    }
    return { name: app.project.file ? String(app.project.file.name) : null, compositions: compositions };
  }
  function snapshotDigest() { return sha256(stable(projectSnapshot())); }
  function exactKeys(value, allowed, label) {
    if (!value || typeof value !== "object" || isArray(value)) fail("invalid " + label);
    for (var key in value) if (own(value, key) && !allowed[key]) fail("unknown " + label + " field: " + key);
  }
  function identifier(value, label) {
    if (typeof value !== "string" || value.length < 3 || value.length > 128 || !/^[A-Za-z0-9:._-]+$/.test(value)) fail("invalid " + label);
  }
  function digest(value, label) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid " + label);
  }
  function finite(value, label) {
    if (typeof value !== "number" || !isFinite(value)) fail("invalid numeric argument: " + label);
  }
  function finitePositive(value, label, maximum) {
    finite(value, label);
    if (value <= 0 || value > maximum) fail("invalid numeric argument: " + label);
  }
  function handle(value, prefix) {
    if (typeof value !== "string" || !(new RegExp("^" + prefix + ":[1-9][0-9]*$")).test(value)) fail("invalid " + prefix + "Handle");
  }
  function validatePropertyValue(value) {
    if (typeof value === "number") return finite(value, "property value");
    if (!isArray(value) || (value.length !== 2 && value.length !== 3)) fail("invalid property value");
    for (var i = 0; i < value.length; i += 1) finite(value[i], "property value");
  }
  function validateProperties(values) {
    exactKeys(values, PROPERTY_IDS, "properties");
    for (var key in values) if (own(values, key)) validatePropertyValue(values[key]);
  }
  function validateColor(value) {
    if (!isArray(value) || value.length !== 3) fail("invalid color");
    for (var i = 0; i < 3; i += 1) { finite(value[i], "color"); if (value[i] < 0 || value[i] > 1) fail("invalid color"); }
  }
  function validateCommand(command) {
    exactKeys(command, TOP_LEVEL_KEYS, "command");
    if (command.version !== 1 || command.projectHandle !== "project:working-copy" || !ARG_KEYS[command.tool]) fail("invalid command envelope");
    identifier(command.commandId, "commandId"); identifier(command.nonce, "nonce");
    identifier(command.deviceId, "deviceId"); identifier(command.jobId, "jobId"); digest(command.sceneDigest, "sceneDigest");
    var args = command.args;
    exactKeys(args, ARG_KEYS[command.tool], "tool argument");
    for (var required = 0; required < REQUIRED_KEYS[command.tool].length; required += 1)
      if (!own(args, REQUIRED_KEYS[command.tool][required])) fail("missing tool argument: " + REQUIRED_KEYS[command.tool][required]);
    if (args.compHandle !== undefined) handle(args.compHandle, "comp");
    if (args.layerHandle !== undefined) handle(args.layerHandle, "layer");
    if (args.expectedSceneDigest !== undefined) digest(args.expectedSceneDigest, "expectedSceneDigest");
    if (args.properties) validateProperties(args.properties);
    if (command.tool === "adobe.composition.create_v1" || command.tool === "adobe.composition.update_v1") {
      if (args.width !== undefined) { finitePositive(args.width, "width", 32768); if (Math.floor(args.width) !== args.width) fail("invalid width"); }
      if (args.height !== undefined) { finitePositive(args.height, "height", 32768); if (Math.floor(args.height) !== args.height) fail("invalid height"); }
      if (args.durationSeconds !== undefined) finitePositive(args.durationSeconds, "durationSeconds", 86400);
      if (args.frameRate !== undefined) finitePositive(args.frameRate, "frameRate", 240);
    }
    if (args.color) validateColor(args.color);
    if (args.layers) {
      if (!isArray(args.layers) || args.layers.length < 1 || args.layers.length > 100) fail("invalid batch layers");
      for (var i = 0; i < args.layers.length; i += 1) {
        exactKeys(args.layers[i], { layerHandle: true, properties: true }, "batch layer");
        handle(args.layers[i].layerHandle, "layer"); validateProperties(args.layers[i].properties);
      }
    }
    if (args.keyframes) {
      if (!isArray(args.keyframes) || args.keyframes.length < 1 || args.keyframes.length > 500) fail("invalid keyframes");
      for (var j = 0; j < args.keyframes.length; j += 1) {
        var frame = args.keyframes[j];
        exactKeys(frame, { property: true, frame: true, value: true, easing: true }, "keyframe");
        if (!PROPERTY_IDS[frame.property]) fail("unknown property: " + frame.property);
        finite(frame.frame, "frame");
        if (Math.floor(frame.frame) !== frame.frame || frame.frame < 0 || frame.frame > 21600000) fail("invalid keyframe frame");
        validatePropertyValue(frame.value);
        if (frame.easing !== "linear" && frame.easing !== "easeIn" && frame.easing !== "easeOut" && frame.easing !== "easeInOut") fail("invalid easing");
      }
    }
    if (command.tool === "adobe.mask.set_v1") {
      if (args.mode !== "add" && args.mode !== "subtract" && args.mode !== "intersect") fail("invalid mask mode");
      if (!isArray(args.vertices) || args.vertices.length < 3 || args.vertices.length > 500) fail("invalid vertices");
      for (var vertex = 0; vertex < args.vertices.length; vertex += 1) {
        if (!isArray(args.vertices[vertex]) || args.vertices[vertex].length !== 2) fail("invalid vertex");
        finite(args.vertices[vertex][0], "vertex"); finite(args.vertices[vertex][1], "vertex");
      }
    }
    if (command.tool === "adobe.effect.apply_v1" && !EFFECT_IDS[args.effectId]) fail("unapproved effectId");
    if (command.tool === "adobe.effect.apply_template_v1" && !EFFECT_TEMPLATES[args.templateId]) fail("unapproved effect templateId");
    if (command.tool === "adobe.expression.apply_template_v1" && !EXPRESSION_TEMPLATES[args.templateId]) fail("unapproved expression templateId");
    if ((command.tool === "adobe.expression.apply_template_v1" || command.tool === "adobe.expression.remove_v1") && !PROPERTY_IDS[args.propertyId]) fail("unknown property");
    if (command.tool === "adobe.render_upload_v1" && (typeof args.outputName !== "string" || args.outputName.length > 128 || !/^[A-Za-z0-9._-]+$/.test(args.outputName))) fail("invalid outputName");
  }
  function comp(value) {
    var id = Number(String(value).split(":")[1]);
    for (var i = 1; i <= app.project.numItems; i += 1) {
      var item = app.project.item(i);
      if (item instanceof CompItem && item.id === id) return item;
    }
    return fail("unknown compHandle");
  }
  function layer(args) {
    var target = comp(args.compHandle), id = Number(String(args.layerHandle).split(":")[1]);
    for (var i = 1; i <= target.numLayers; i += 1) if (target.layer(i).id === id) return target.layer(i);
    return fail("unknown layerHandle");
  }
  function findSnapshotLayer(compHandle, layerHandle) {
    var snapshot = projectSnapshot();
    for (var i = 0; i < snapshot.compositions.length; i += 1) if (snapshot.compositions[i].compHandle === compHandle)
      for (var j = 0; j < snapshot.compositions[i].layers.length; j += 1) if (snapshot.compositions[i].layers[j].layerHandle === layerHandle) return snapshot.compositions[i].layers[j];
    return fail("missing layer readback");
  }
  function findSnapshotComp(compHandle) {
    var snapshot = projectSnapshot();
    for (var i = 0; i < snapshot.compositions.length; i += 1)
      if (snapshot.compositions[i].compHandle === compHandle) return snapshot.compositions[i];
    return fail("missing composition readback");
  }
  function layerResult(value, compHandle) {
    return { layerHandle: "layer:" + value.id, name: String(value.name), readback: findSnapshotLayer(compHandle, "layer:" + value.id) };
  }
  function setProperties(target, values) {
    for (var key in values) if (own(values, key)) {
      var property = target.property(key);
      if (!property) fail("unknown property: " + key);
      property.setValue(values[key]);
    }
  }
  function propertyReadback(target, values) {
    var result = {};
    for (var key in values) if (own(values, key)) result[key] = copyValue(target.property(key).value);
    return result;
  }
  function createLayer(tool, args) {
    var target = comp(args.compHandle), created;
    if (tool === "adobe.layer.create_text_v1") created = target.layers.addText(args.text);
    else if (tool === "adobe.layer.create_solid_v1") created = target.layers.addSolid(args.color, "Solid", target.width, target.height, 1);
    else if (tool === "adobe.layer.create_camera_v1") created = target.layers.addCamera("Camera", [target.width / 2, target.height / 2]);
    else if (tool === "adobe.layer.create_null_v1") created = target.layers.addNull();
    else {
      created = target.layers.addShape();
      var vectors = created.property("ADBE Root Vectors Group");
      var shapeId = args.shape === "ellipse" ? "ADBE Vector Shape - Ellipse" : (args.shape === "polygon" ? "ADBE Vector Shape - Star" : "ADBE Vector Shape - Rect");
      vectors.addProperty(shapeId);
      var fill = vectors.addProperty("ADBE Vector Graphic - Fill");
      if (fill && fill.property("ADBE Vector Fill Color")) fill.property("ADBE Vector Fill Color").setValue(args.color);
      if (created.source !== undefined) created.source = { shape: args.shape, color: copyValue(args.color) };
    }
    return created;
  }
  function changedFields(command) {
    var a = command.args;
    if (command.tool === "adobe.composition.create_v1") return ["compositions"];
    if (command.tool === "adobe.composition.update_v1") {
      var compositionFields = [];
      if (a.width !== undefined) compositionFields.push("compositions." + a.compHandle + ".width");
      if (a.height !== undefined) compositionFields.push("compositions." + a.compHandle + ".height");
      if (a.durationSeconds !== undefined) compositionFields.push("compositions." + a.compHandle + ".durationSeconds");
      if (a.frameRate !== undefined) compositionFields.push("compositions." + a.compHandle + ".frameRate");
      return compositionFields;
    }
    if (/^adobe\.layer\.create_/.test(command.tool) || command.tool === "adobe.layer.duplicate_v1" || command.tool === "adobe.layer.delete_v1") return ["layers"];
    if (command.tool === "adobe.layer.set_properties_v1") {
      var fields = []; for (var property in a.properties) if (own(a.properties, property)) fields.push("layers." + a.layerHandle + ".properties." + property); return fields;
    }
    if (command.tool === "adobe.layer.batch_set_properties_v1") {
      var batch = [];
      for (var i = 0; i < a.layers.length; i += 1) for (var id in a.layers[i].properties) if (own(a.layers[i].properties, id)) batch.push("layers." + a.layers[i].layerHandle + ".properties." + id);
      return batch;
    }
    if (command.tool === "adobe.animation.set_keyframes_v1") return ["layers." + a.layerHandle + ".keyframes"];
    if (command.tool === "adobe.mask.set_v1") return ["layers." + a.layerHandle + ".mask"];
    if (command.tool === "adobe.effect.apply_v1" || command.tool === "adobe.effect.apply_template_v1") return ["layers." + a.layerHandle + ".effects"];
    if (command.tool === "adobe.expression.apply_template_v1" || command.tool === "adobe.expression.remove_v1") return ["layers." + a.layerHandle + ".expressions." + a.propertyId];
    if (command.tool === "adobe.command.cancel_v1") return ["commands." + a.targetCommandId + ".status"];
    if (command.tool === "adobe.rollback_v1") return ["project"];
    return [];
  }
  function captureRollback(beforeDigest) {
    if (STATE.rollbackDigest !== null) return;
    if (global.RVSProjectSnapshot) global.RVSProjectSnapshot.capture();
    else {
      if (!app.project.file || typeof File === "undefined") fail("working-copy snapshot unavailable");
      var source = app.project.file, snapshot = new File(source.fullName + ".rvs-rollback.aep");
      if (snapshot.exists) snapshot.remove();
      if (!source.copy(snapshot.fullName)) fail("working-copy snapshot failed");
      STATE.rollbackPath = snapshot.fullName;
    }
    STATE.rollbackDigest = beforeDigest;
  }
  function restoreRollback(expectedDigest) {
    if (STATE.rollbackDigest === null && expectedDigest === snapshotDigest()) return;
    if (STATE.rollbackDigest === null || expectedDigest !== STATE.rollbackDigest) fail("rollback digest mismatch");
    if (global.RVSProjectSnapshot) global.RVSProjectSnapshot.restore();
    else {
      var working = app.project.file, snapshot = new File(STATE.rollbackPath);
      if (!working || !snapshot.exists) fail("working-copy snapshot missing");
      var workingPath = working.fullName;
      app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
      var target = new File(workingPath);
      if (target.exists && !target.remove()) fail("working-copy replace failed");
      if (!snapshot.copy(workingPath)) fail("working-copy restore failed");
      app.open(new File(workingPath));
      snapshot.remove();
    }
  }
  function executePayload(command) {
    var a = command.args;
    switch (command.tool) {
      case "adobe.project.get_v1": return { name: app.project.file ? String(app.project.file.name) : null, itemCount: app.project.numItems, readback: projectSnapshot() };
      case "adobe.composition.list_v1":
        var compositions = [], snapshot = projectSnapshot();
        for (var i = 0; i < snapshot.compositions.length; i += 1) compositions.push({ compHandle: snapshot.compositions[i].compHandle, name: snapshot.compositions[i].name });
        return { compositions: compositions, readback: snapshot.compositions };
      case "adobe.composition.create_v1":
        var created = app.project.items.addComp(a.name, a.width, a.height, 1, a.durationSeconds, a.frameRate);
        return { compHandle: "comp:" + created.id, readback: projectSnapshot().compositions[projectSnapshot().compositions.length - 1] };
      case "adobe.composition.update_v1":
        var updated = comp(a.compHandle);
        if (a.width !== undefined) updated.width = a.width; if (a.height !== undefined) updated.height = a.height;
        if (a.durationSeconds !== undefined) updated.duration = a.durationSeconds; if (a.frameRate !== undefined) updated.frameRate = a.frameRate;
        return { compHandle: a.compHandle, readback: findSnapshotComp(a.compHandle) };
      case "adobe.layer.get_v1": return layerResult(layer(a), a.compHandle);
      case "adobe.layer.create_text_v1": case "adobe.layer.create_shape_v1": case "adobe.layer.create_solid_v1": case "adobe.layer.create_camera_v1": case "adobe.layer.create_null_v1":
        return layerResult(createLayer(command.tool, a), a.compHandle);
      case "adobe.layer.duplicate_v1": return layerResult(layer(a).duplicate(), a.compHandle);
      case "adobe.layer.delete_v1": layer(a).remove(); return { readback: { deleted: true, layerHandle: a.layerHandle } };
      case "adobe.layer.set_properties_v1":
        var target = layer(a); setProperties(target, a.properties); return { readback: { properties: propertyReadback(target, a.properties) } };
      case "adobe.layer.batch_set_properties_v1":
        var targets = [];
        for (var j = 0; j < a.layers.length; j += 1) targets.push(layer({ compHandle: a.compHandle, layerHandle: a.layers[j].layerHandle }));
        var readbacks = [];
        for (var batchIndex = 0; batchIndex < targets.length; batchIndex += 1) {
          setProperties(targets[batchIndex], a.layers[batchIndex].properties);
          readbacks.push({ layerHandle: a.layers[batchIndex].layerHandle, properties: propertyReadback(targets[batchIndex], a.layers[batchIndex].properties) });
        }
        return { count: targets.length, readback: readbacks };
      case "adobe.animation.set_keyframes_v1":
        var animated = layer(a), properties = [], keyReadback = [];
        for (var keyIndex = 0; keyIndex < a.keyframes.length; keyIndex += 1) {
          var keyframe = a.keyframes[keyIndex], property = animated.property(keyframe.property);
          if (!property) fail("unknown property: " + keyframe.property);
          properties.push(property);
        }
        for (var k = 0; k < a.keyframes.length; k += 1) {
          var frame = a.keyframes[k], time = frame.frame / comp(a.compHandle).frameRate;
          properties[k].setValueAtTime(time, frame.value);
          if (properties[k].setTemporalEaseAtKey) properties[k].setTemporalEaseAtKey(properties[k].numKeys, frame.easing);
          keyReadback.push({ property: frame.property, frame: frame.frame, time: time, value: copyValue(properties[k].keyValue(properties[k].numKeys)), easing: properties[k].keyEasing ? properties[k].keyEasing(properties[k].numKeys) : frame.easing });
        }
        return { count: a.keyframes.length, readback: { keyframes: keyReadback } };
      case "adobe.mask.set_v1":
        var mask = layer(a).property("ADBE Mask Parade").addProperty("ADBE Mask Atom"), shape = new Shape();
        shape.vertices = a.vertices; shape.closed = true; mask.rvsMode = a.mode;
        mask.property("ADBE Mask Shape").setValue(shape);
        return { readback: { mode: mask.rvsMode, vertices: copyValue(mask.property("ADBE Mask Shape").value.vertices), closed: mask.property("ADBE Mask Shape").value.closed === true } };
      case "adobe.effect.apply_v1":
        var effect = layer(a).property("ADBE Effect Parade").addProperty(a.effectId);
        if (!effect) fail("effect unavailable");
        return { effectName: String(effect.name), readback: { effectName: String(effect.name) } };
      case "adobe.effect.apply_template_v1": return applyTemplate(layer(a), "effect", a.templateId, a);
      case "adobe.expression.apply_template_v1": return applyTemplate(layer(a), "expression", a.templateId, a);
      case "adobe.expression.remove_v1":
        var expressionProperty = layer(a).property(a.propertyId); expressionProperty.expression = "";
        return { readback: { propertyId: a.propertyId, expressionEnabled: expressionProperty.expression !== "" } };
      case "adobe.command.status_v1": return { commandId: a.targetCommandId, status: STATE.commands[a.targetCommandId] || "RUNNING" };
      case "adobe.command.cancel_v1": STATE.commands[a.targetCommandId] = "CANCELLED"; return { commandId: a.targetCommandId, cancelled: true, status: "CANCELLED" };
      case "adobe.verify_v1":
        comp(a.compHandle); var actual = snapshotDigest();
        return { projectOpen: app.project.file !== null, expectedSceneDigest: a.expectedSceneDigest, actualSceneDigest: actual, verified: actual === a.expectedSceneDigest };
      case "adobe.render_upload_v1":
        comp(a.compHandle); return { queued: true, outputName: a.outputName, renderPlan: { compHandle: a.compHandle, projectDigest: snapshotDigest(), uploadByConnector: true } };
      case "adobe.rollback_v1": restoreRollback(a.expectedSceneDigest); return { rolledBack: true, restoredSceneDigest: snapshotDigest() };
      default: return fail("unknown tool");
    }
  }
  function applyTemplate(target, kind, id, args) {
    if (kind === "expression" && id === "loop-cycle-v1") {
      var property = target.property(args.propertyId);
      if (!property) fail("unknown property");
      property.expression = "loopOut('cycle')";
      if (property.expression !== "loopOut('cycle')") fail("expression template readback mismatch");
      return { templateId: id, readback: { propertyId: args.propertyId, expressionTemplateId: id, expressionEnabled: true } };
    }
    if (kind === "effect" && id === "drop-shadow-v1") {
      var effect = target.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
      if (!effect) fail("approved effect unavailable");
      return { templateId: id, readback: { effectName: String(effect.name) } };
    }
    return fail("unapproved templateId");
  }
  function dispatch(command) {
    validateCommand(command);
    var before = snapshotDigest(), mutates = MUTATIONS[command.tool] === true;
    if (mutates && command.tool !== "adobe.rollback_v1") captureRollback(before);
    STATE.commands[command.commandId] = "RUNNING";
    var payload = executePayload(command), after = snapshotDigest();
    var status = command.tool === "adobe.command.cancel_v1" ? "CANCELLED" : "SUCCEEDED";
    STATE.commands[command.commandId] = status;
    return {
      version: 1, commandId: command.commandId, nonce: command.nonce,
      sceneDigest: command.sceneDigest, deviceId: command.deviceId, jobId: command.jobId,
      status: status, beforeDigest: before, afterDigest: after,
      changedFields: changedFields(command).slice(0, 500),
      warnings: payload.verified === false ? ["scene digest mismatch"] : [], payload: payload
    };
  }
  global.RVSProjectReadback = projectSnapshot;
  global.RVSProjectCanonical = function () { return stable(projectSnapshot()); };
  global.RVSSha256 = sha256;
  global.RVSDispatch = dispatch;
}(this));
