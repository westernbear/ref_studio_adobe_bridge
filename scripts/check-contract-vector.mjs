import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const local = JSON.parse(
  await readFile(
    resolve(import.meta.dirname, "../contract/adobe-mcp-v1.json"),
    "utf8",
  ),
);
const canonical = JSON.parse(
  await readFile(
    resolve(
      import.meta.dirname,
      "../../../verification/contract/adobe-mcp-v1.json",
    ),
    "utf8",
  ),
);
if (JSON.stringify(local) !== JSON.stringify(canonical)) {
  process.stderr.write(
    "Adobe MCP golden vector drifted from the root canonical copy\n",
  );
  process.exitCode = 1;
}
