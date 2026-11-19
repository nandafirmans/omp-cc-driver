# omp-claude-code

omp provider that runs the official `claude` CLI in headless mode (`claude -p --output-format stream-json`).

## Install

    omp plugin install https://github.com/nandafirmans/omp-claude-code

Then `omp --model claude-code/opus` (also `fable`, `sonnet`, `haiku`, or pinned ids like `claude-sonnet-5-5`). The model list and per-model effort levels are a static table (Claude Code has no list command); update it when new models ship.

## Compliance design

- Auth is whatever `claude` is logged into. Credentials are never read, copied or forwarded; no direct API calls.
- `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH*` env vars are stripped from the child.
- One prompt = one child process, max 2 concurrent. No retries: Claude Code retries transient failures itself, and error text is worded so omp's own auto-retry does not re-launch `claude` (raw details go to the omp log).
- Claude Code owns its tool loop; omp tools are not exposed to it.

Anthropic's policy on subscription use in third-party tools can change; check current terms.

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `OMP_CLAUDE_BIN` | `claude` | CLI path |
| `OMP_CLAUDE_PERMISSION_MODE` | `acceptEdits` | `--permission-mode` for the child |
| `OMP_CLAUDE_MAX_CONCURRENT` | `2` | parallel child processes |

## Limits

After an omp restart the first turn replays the earlier chat as plain text (no tool calls).
