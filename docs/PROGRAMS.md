# Semantic Programs

A semantic program is a reusable cross-surface workflow.

It contains:

- a versioned JSON schema;
- typed parameters and defaults;
- browser and desktop steps;
- semantic target contracts;
- optional post-action verification.

It does not contain screenshots, coordinates, snapshot-qualified refs, arbitrary
JavaScript, shell commands, or headed-mode overrides.

## Lifecycle

```bash
nexcore program save ./examples/programs/browser-fill.json
nexcore program list
nexcore program run browser.fill '{"value":"Ada"}'
```

Programs are stored in `~/.nexcore/programs` by default. Override this with
`NEXCORE_PROGRAM_DIR`.

## Definition

```json
{
  "schema": "nexcore.program/v1",
  "name": "calculator.add",
  "version": "1.0.0",
  "description": "Enter two values and verify the display.",
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

Program names match `^[a-z0-9][a-z0-9._-]{1,80}$`. Programs contain 1-20
sequential steps and are limited to 256 KiB.

## Parameters

Supported types are `string`, `number`, and `boolean`.

```json
{
  "params": {
    "query": {
      "type": "string",
      "required": true,
      "description": "Text to type into the search box."
    },
    "limit": {
      "type": "number",
      "default": 20
    }
  }
}
```

Use `{{name}}` inside string values. A whole-value placeholder preserves the
parameter type. Unknown, missing, or incorrectly typed parameters fail before
any UI action.

## Targets

Portable semantic target:

```json
{ "role": "button", "name": "Save" }
```

Desktop contextual target:

```json
{
  "role": "button",
  "name": "Delete",
  "near": { "role": "row", "name": "Invoice 42" }
}
```

The runtime first resolves `near` to a qualified accessibility ref, then
searches for the target inside that subtree. Browser contextual targets are
rejected in v1 rather than silently ignoring context.

Browser selector:

```json
{ "selector": "#save" }
```

## Resolution ladder

Desktop:

1. exact role/name accessibility find;
2. named-context find;
3. compact scoped snapshot;
4. bounded full snapshot;
5. fail closed.

Browser:

1. explicit CSS selector;
2. semantic match in the active compact snapshot;
3. fail closed.

Screenshots and coordinates are never automatic program fallbacks.

## Verification

```json
{
  "expect": {
    "target": { "role": "textfield", "name": "Search" },
    "property": "value",
    "value": "Nexcore",
    "timeoutMs": 3000
  }
}
```

Browser supports `value` and `url`. Desktop initially supports `value`.

An action that may already have been delivered is not replayed automatically
when verification fails. Read the failure, repair the program or UI, then run
again intentionally.

## MCP

The same operations remain inside the single `computer` tool:

```json
{
  "mode": "program_run",
  "programName": "browser.fill",
  "params": { "value": "Ada" }
}
```

Use `mode: "program_save"` with a `program` object, or `mode: "program_list"`.
