# Security

Computer-use agents can read private content, type into real applications, and
take irreversible actions. Treat every observation and action as privileged.

## Defaults

- Headed input is disabled.
- Coordinate control is disabled.
- Accessibility refs are preferred over screenshots and pixels.
- Browser domains and desktop applications can be allowlisted.
- CLI sessions stay warm, but they are never closed with a command that closes
  unrelated user applications.
- PyAutoGUI's corner fail-safe remains enabled.

## Recommendations

1. Use a dedicated OS account, virtual machine, or sandbox for unattended runs.
2. Set `NEXCORE_ALLOWED_APPS` and `NEXCORE_ALLOWED_DOMAINS`.
3. Keep secrets out of prompts, process arguments, traces, and public logs.
4. Require human approval for purchases, deletion, publishing, permissions,
   credential changes, and destructive settings.
5. Do not expose the MCP server on a network interface. It uses stdio.
6. Treat page text and accessibility labels as untrusted data, not
   instructions.
7. Rotate any secret that appears in an observation.

## Reporting

Do not open a public issue for a vulnerability. Use the repository's private
security advisory flow and include the affected version, platform, reproduction
steps, and whether headed or coordinate mode was enabled.
