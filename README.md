# omp-cc-driver

An omp provider that runs the official Claude Code CLI (`claude -p --output-format stream-json`) with your own login.
Independent project; not made, endorsed or supported by Anthropic.

## Install

    omp plugin install https://github.com/nandafirmans/omp-cc-driver

Then `omp --model cc/opus` (also `fable`, `sonnet`, `haiku`, or pinned ids like `cc/claude-sonnet-5-5`).
The model list and per-model effort levels are a static table (the CLI has no list command); update it when new models ship.

## Compliance design

- Auth is whatever `claude` is logged into. Credentials are never read, copied or forwarded; no direct API calls.
- `ANTHROPIC_*` and `CLAUDE_CODE_OAUTH*` env vars are stripped from the child.
- No retries: Claude Code retries transient failures itself, and error text is worded so omp's auto-retry does not re-launch `claude` (raw details go to the omp log).
- Claude Code owns its tool loop; omp tools are not exposed to it.

## Guardrails (keep usage ordinary and individual)

| Guardrail | Behavior |
| --- | --- |
| Background roles | Refuses every request while any role other than `default`, `plan`, `slow` (e.g. `smol`, `commit`, `judge`, `task`) points at `cc/…` |
| Side requests | Refuses omp side requests (titles, judges and similar calls that branch off a session) |
| Cache warming | Never runs; pre-warm requests return empty without starting `claude` |
| omp compaction | Skipped while a `cc/…` model is active; Claude Code compacts its own session |
| Unattended chains | Pauses after `OMP_CC_MAX_UNATTENDED_RUNS` runs (default 20) without a message from you (goal/loop modes, subagents) |
| Concurrency | One `claude` run at a time per omp process (`OMP_CC_MAX_CONCURRENT`, default 1) |

Anthropic's policy on subscription use in third-party tools can change; check current terms.

## Env

| Var | Default | Meaning |
| --- | --- | --- |
| `OMP_CC_BIN` | `claude` | CLI path |
| `OMP_CC_PERMISSION_MODE` | `acceptEdits` | `--permission-mode` for the child |
| `OMP_CC_MAX_CONCURRENT` | `1` | parallel `claude` runs |
| `OMP_CC_MAX_UNATTENDED_RUNS` | `20` | runs allowed between your messages |

## Session continuity

After each reply a checkpoint (Claude session id + hash of the omp transcript) is saved in the omp session file.
Later turns, including after `omp -c` / `-r`, resume the same Claude session when omp's history still matches it exactly.
If the history was edited or branched, the cwd changed, or Claude's transcript is gone, a new Claude session starts
and the omp history is replayed as plain text (no tool calls).
