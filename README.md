# RVS Adobe Bridge

Private local connector for typed motion-scene operations against an After Effects working copy.

## Run

```sh
bun install
RVS_ADOBE_SPOOL="$HOME/Library/Application Support/RVSAdobeBridge/spool" bun run src/cli.ts stdio
```

The connector exposes the versioned `adobe.*_v1` MCP tools over stdio. A cloud gateway may call
the same dispatcher only through the HMAC-authenticated relay seam. Cloud arguments cannot contain
local paths, upload URLs, access tokens, tenant/user identifiers, arbitrary scripts, raw expressions,
or preset paths.

Commands move atomically through `commands/<id>.pending.json` and `.running.json`; terminal results
land in `results/<id>.json`. The AE panel polls every 2 seconds and serially executes one mutation.

## Safety contract

- Open a job-specific file named as an RVS working copy. Never open the original AEP in the panel.
- Handles are local opaque `projectHandle`, `compHandle`, and `layerHandle` values.
- Install only a release whose two-file manifest has a valid release Ed25519 signature. The signed
  installer copies the fixed allowlist into AE's `Scripts/ScriptUI Panels` directory without a shell.
- `render_upload_v1` returns bounded metadata to the connector; credentials remain connector-local.

## Verification

`bun run check && bun test && bun run build`

The automated fixture proves the original AEP bytes remain unchanged. Real AE readback remains a
release gate: composition/layer/keyframe/mask/effect/render operations must be exercised on supported
AE versions before beta enrollment.
