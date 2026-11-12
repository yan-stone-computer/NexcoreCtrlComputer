# Semantic Program Runtime

Status: proposed  
Target release: 0.2.0  
Date: 2026-11-12

## Problem

The 0.1.0 control plane removes backend differences, but an agent still sends
the same multi-step plan on every run. That is useful integration, not a new
capability. The expensive and brittle part remains:

- the model repeatedly plans the same workflow;
- transient accessibility refs cannot be reused between runs;
- browser and desktop orchestration lives in the agent prompt;
- action verification is optional rather than part of the reusable artifact;
- retry behavior is not attached to a portable workflow contract.

## Product Claim

Compile a workflow once into a cross-surface semantic UI program. The model
then calls one local program with parameters, while the runtime resolves
targets, applies safety policy, executes steps, verifies state, and returns only
the outcome.

A program stores intent and contracts, never screenshots, coordinates, or
snapshot-qualified refs.

## Goals

1. Run one semantic program across native apps and browser pages.
2. Reuse a program across runs and agents without model replanning.
3. Resolve targets locally through an adaptive perception ladder.
4. Make state verification and safe retry semantics part of the program.
5. Keep the public interface at one MCP tool.
6. Make stored programs portable JSON with explicit versioning.
7. Fail closed when a target is ambiguous or the UI cannot be verified.

## Non-Goals

- General-purpose UI rollback or compensation is not claimed.
- Natural-language planning is not embedded in the runtime.
- Screenshots and coordinates are not automatic fallbacks.
- Recording arbitrary desktop sessions into programs is deferred.
- Parallel step execution is deferred; v1 is sequential.
- A remote program registry or marketplace is out of scope.

## User Experience

Save a program:

```bash
nexcore program save ./examples/programs/calculator-add.json
```

List available programs:

```bash
nexcore program list
```

Run it once with locally resolved targets and verification:

```bash
nexcore program run calculator.add '{"app":"Calculator","a":"7","b":"5"}'
```

The model-facing invocation stays small:

```json
{
  "mode": "program_run",
  "program": "calculator.add",
  "params": {
    "app": "Calculator",
    "a": "7",
    "b": "5"
  }
}
```

## Program Format

```json
{
  "schema": "nexcore.program/v1",
  "name": "calculator.add",
  "version": "1.0.0",
  "description": "Enter two digits and verify the display.",
  "params": {
    "app": { "type": "string", "default": "Calculator" },
    "a": { "type": "string", "required": true },
    "b": { "type": "string", "required": true }
  },
  "steps": [
    {
      "act": {
        "surface": "desktop",
        "app": "{{app}}",
        "action": "click",
        "target": { "role": "button", "name": "{{a}}" }
      }
    },
    {
      "act": {
        "surface": "desktop",
        "app": "{{app}}",
        "action": "click",
        "target": { "role": "button", "name": "{{b}}" },
        "expect": {
          "target": { "role": "textfield", "name": "Display" },
          "property": "value",
          "value": "{{a}}{{b}}"
        }
      }
    }
  ]
}
```

### Target forms

Stored programs may use:

- `{ "role": "...", "name": "..." }` for portable semantic targeting;
- `{ "selector": "..." }` for browser CSS targeting;
- `{ "role": "...", "name": "...", "near": { "role": "...", "name": "..." } }`
  for contextual desktop targeting when implemented by the snapshot strategy.

Stored programs may not contain:

- snapshot-qualified refs such as `@sabc123:e4`;
- raw coordinates;
- `headed: true`;
- shell commands or arbitrary JavaScript.

The compiler rejects unsafe or non-portable fields.

## Compiler

`compileProgram(definition)` performs deterministic local validation and returns:

- normalized schema and version;
- normalized step array;
- typed parameter declarations;
- fully substituted `run` steps for the supplied parameters;
- a digest of the source program;
- validation notices for non-fatal choices.

Interpolation replaces `{{name}}` recursively in string values. Missing required
parameters, unknown placeholders, non-string placeholders in typed positions, or
unresolved placeholders fail compilation.

The compiled form is transient. Only the source program is persisted.

## Adaptive Perception Router

For a semantic target, resolution proceeds from cheapest and most precise to
broader observation:

1. **Exact semantic find**  
   Use the backend's `find` path when it can return one exact role/name match.
2. **Contextual region read**  
   Scope to a named ancestor or nearby row, then select the exact descendant.
3. **Compact scoped snapshot**  
   Read a bounded region and match locally.
4. **Bounded full snapshot**  
   Read the smallest complete tree allowed by the node budget.
5. **Fail closed**  
   Return `TARGET_NOT_FOUND` or `AMBIGUOUS_TARGET` with candidate evidence.

The router does not silently escalate to pixels or coordinates. A caller may
manually run an explicitly authorized fallback after inspecting the failure.

The router records the strategy used and its latency so repeated programs can
prefer the strategy that worked previously within the same process.

## State Contracts

An action can contain `expect`:

```json
{
  "target": { "role": "textfield", "name": "Display" },
  "property": "value",
  "value": "75",
  "timeoutMs": 3000
}
```

Supported browser properties include `value` and `url`. Desktop supports
properties exposed by the backend wait contract, initially `value`.

Failure semantics:

- `not_delivered` and target resolution failures may be retried through fresh
  semantic resolution;
- `delivered_unverified` may be observed again but is never replayed
  automatically;
- `delivered_verified` advances only when the program's independent `expect`
  passes;
- an unreadable postcondition returns `VERIFY_UNPROVEN`, not success.

## Runtime Flow

1. Load and parse the program.
2. Reject unsupported schema versions and unsafe fields.
3. Apply defaults and validate parameters.
4. Interpolate templates into a compiled step sequence.
5. Apply the existing app/domain allowlists to every step.
6. Resolve semantic targets through the adaptive router.
7. Execute one step.
8. Verify the declared postcondition.
9. Continue only after success.
10. Return the final verification plus compact step outcomes, omitting routine
    observations from the model-facing response.

On failure, return:

- failed step index;
- normalized error code;
- whether replay is safe;
- candidate targets for ambiguity;
- the smallest useful observation needed to repair the program.

## Storage

Default directory: `~/.nexcore/programs`.

Override: `NEXCORE_PROGRAM_DIR`.

Layout:

```text
programs/
  calculator.add.json
  invoice.download-and-open.json
```

Program names use lowercase letters, digits, dots, hyphens, and underscores.
Writes are atomic and limited to 256 KiB. Invalid JSON or an unsupported schema
is rejected before storage.

## Interfaces

### JavaScript

```js
await computer.saveProgram(definition);
await computer.listPrograms();
await computer.getProgram("calculator.add");
await computer.runProgram("calculator.add", { a: "7", b: "5" });
```

### CLI

```text
nexcore program save <file-or-json>
nexcore program list
nexcore program run <name> '<json-params>'
```

### MCP

The existing `computer` tool adds:

```text
program_save
program_list
program_run
```

`program_run` accepts `program` and `params`. These operations do not add new
MCP tools.

## Security

- Program files are untrusted input and are schema-validated.
- Stored programs cannot bypass headed or coordinate policy.
- App and domain allowlists still apply at execution time.
- Parameter values are never written into program files.
- Sensitive values should still avoid traces and screenshots.
- A program cannot reference another program by default in v1; composition is a
  later capability with explicit depth and cycle limits.

## Testing

Unit tests:

- valid compilation and recursive interpolation;
- default and required parameter handling;
- rejection of refs, coordinates, headed mode, and unknown fields;
- atomic storage, list, load, and malformed-file handling;
- MCP addition remains a single tool;
- compact result omits routine intermediate observations.

Live integration:

- a browser form program fills a field and verifies its value;
- a desktop program clicks a safe calculator key and verifies the display;
- a cross-surface program moves from a browser observation to a desktop
  observation without model re-entry.

Benchmark:

- compare bytes for the original multi-step JSON versus repeated
  `program_run(name, params)` invocations;
- report the measured result without equating bytes to provider billing.

## Rollout

1. Ship compiler, storage, runtime, CLI, and MCP in 0.2.0.
2. Keep 0.1.0 `observe`, `act`, `verify`, and `run` stable.
3. Document semantic programs as the main differentiation.
4. Add program recording only after authored programs are proven reliable.

## Acceptance Criteria

- A named program can be saved, listed, loaded, and executed through JS, CLI,
  and the single MCP tool.
- A program can include desktop and browser steps.
- Stored programs contain no coordinates, screenshots, or snapshot refs.
- Re-running a program does not require resending the step plan to the model.
- Ambiguous targets fail without acting.
- Post-delivery failures are not automatically replayed.
- Existing tests and CI remain green.
