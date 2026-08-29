# W4 verification evidence

| Criterion | Scenario and invocation | Binary observable | Artifact |
|---|---|---|---|
| Strict checks | `bun run check` | exit 0, 16 files checked | `check.log` |
| Golden and recovery tests | `bun test` | exit 0, 11 pass / 0 fail | `test.log` |
| Production bundle | `bun run build` | exit 0, `dist/cli.js` emitted | `build.log` |
| Local spool end to end | built `dist/cli.js enqueue`, then `once` | terminal `SUCCEEDED` result | `mcp-e2e/enqueue.json`, `mcp-e2e/result.json` |
| Original AEP preservation | SHA-256 before and after local execution | identical SHA-256 values | `mcp-e2e/original-before.sha256`, `mcp-e2e/original-after.sha256` |
| MCP stdio | SDK `Client` lists tools and calls `adobe.project.get_v1` | 25 tools and queued file asserted | `test.log`, test `MCP stdio lists tools and queues a bound command` |

Real After Effects was not installed in this environment. The ScriptUI/ExtendScript fixture contract is present, but AE readback for each mutation, rendering, crash inside AE, and AEP rollback remains an explicit beta gate.
