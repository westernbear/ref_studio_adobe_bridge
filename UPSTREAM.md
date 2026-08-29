# Upstream reference

This implementation was independently adapted from the public behavior and tool surface of
`Dakkshin/after-effects-mcp` at commit `88d5fbf08b7ae9f015ee98e5f8c4904095cf8202`.

The upstream repository is not a runtime dependency, submodule, or vendored source. The RVS
bridge replaces its shared command/result files with per-command atomic spool files, restricts
execution to typed tools and approved templates, and binds every result to command, nonce,
scene digest, device, and job.
