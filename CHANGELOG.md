# Changelog

## 0.6.0 - 2026-11-17

- Synchronized the public runtime with the NexcoreWork 2.5.9 computer-control kernel.
- Added explicit installed-software launch strategies for executable paths, `shell:AppsFolder` AUMIDs, and Windows-MCP fallback instead of guessing a desktop process name.
- Added window focus, resize, minimize, maximize, and restore actions to reusable semantic programs.
- Published TypeScript declarations for `createComputer`, policy, observation, action, program, and verification APIs.
- Replaced the legacy architecture figure with a control-plane diagram covering observation, target resolution, execution routing, verification, receipts, backends, and failure boundaries.
- Expanded the English and Chinese README with the 0.6 execution model, software launch path, program capabilities, and current verification status.

## 0.5.1 - 2026-11-17

- Added window-scoped visual frames with capture-bound coordinate mapping and stale-window bounds checks.
- Added atomic `paste` actions that click, set the clipboard, send one `Ctrl+V`, and verify the visual result.
- Fixed modifier arrays such as `["CTRL", "V"]` being delivered as separate keystrokes.
- Added natural `minimize`, `maximize`, and `restore` aliases for long agent runs.
- Filtered low-value menu and container nodes from visual candidates.

## 0.5.0 - 2026-11-16

- Added short-lived full-desktop visual frames with SHA-256 identity and active-window matching.
- Added DPI-safe grid and normalized coordinate mapping for visual pointer actions.
- Added accessible candidate marks and zoom regions that map back to the parent frame.
- Added click, double-click, right-click, and hover targets bound to a visual frame.
- Added compact MCP image previews while retaining the full-resolution source screenshot.
- Added `visual_changed` post-action verification for pixel-only surfaces.
- Added visual frame, coordinate mapping, expiry, stale-window, and pointer regression tests.

## 0.4.1 - 2026-11-15

- Added installed Start Menu software inventory with exact launch names and AUMIDs.
- Kept installed software separate from the running-app view.
- Added a software adapter registry for desktop, browser, vision, workflow, and CLI engines.
- Added per-software launch and control adapter hints.

## 0.4.0 - 2026-11-15

- Added optional Windows-MCP fallback for application launch, desktop snapshots, labels, input, and text waits.
- Added a layered backend order: agent-desktop first, Windows-MCP second, guarded PyAutoGUI last.
- Added desktop fallback tests and refreshed the architecture figure in a plain scientific style.

## 0.3.0 - 2026-11-15

- Added desktop inventory views for windows, apps, displays, notifications, and surfaces.
- Added stable action receipts, focus restoration/retry, window management, and clipboard controls.
- Added real accessible-text verification and semantic target resolution fallbacks.
- Fixed browser state leaking into later desktop inventory and window operations.
- Expanded live Windows coverage for browser-to-desktop switching and Calculator interaction.

## 0.2.0 - 2026-11-12

- Added compiled, parameterized, cross-surface semantic UI programs.
- Added atomic program storage and safe program validation.
- Added exact-find, contextual-find, selector, and snapshot resolution strategies.
- Added `program save`, `program list`, and `program run` to JS, CLI, and MCP.
- Added program replay and model-payload benchmarks.

## 0.1.0 - 2026-11-12

- Added accessibility-first desktop and browser observation.
- Added compact snapshots, stable refs, and changed-line output.
- Added one-tool MCP server and JSON CLI.
- Added verified click and URL/value postconditions.
- Added allowlists, headed-mode gating, and opt-in PyAutoGUI coordinates.
- Added real backend smoke coverage on Windows.
