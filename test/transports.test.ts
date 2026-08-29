import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { dispatchJsonRpc, relayRequest } from "../src/transport.js";

const request = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/list",
  params: {},
};

test("stdio and authenticated cloud relay produce the same golden response", async () => {
  const direct = await dispatchJsonRpc(request);
  const body = JSON.stringify(request);
  const secret = "test-secret";
  const relayed = await relayRequest(
    body,
    createHmac("sha256", secret).update(body).digest("hex"),
    secret,
  );
  expect(relayed).toEqual(direct);
});
