# pi-dmail

D-Mail context checkpoint tool for [pi](https://pi.dev/).

## What it does

Inspired by Kimi Code's D-Mail (and Steins;Gate), pi-dmail lets the agent proactively manage its context window. When the agent realizes it has consumed too much context on irrelevant exploration or debugging, it can send a D-Mail back to an earlier checkpoint with a concise summary, effectively pruning the wasted context while preserving what it learned.

## How it works

```
Agent reads a huge file → most content irrelevant
  → send_dmail(checkpoint_before_read, "Only lines 200-250 (auth flow) matter")
  → Next turn: context reverts to before reading the file
  → Agent continues with only the useful context preserved
```

The filesystem is NOT reverted. Only the conversation context is folded. External state (files, git, etc.) remains exactly as the agent left it.

## Install

```bash
pi install npm:pi-dmail
/reload
```

## Usage

The agent calls two tools:

- `list_dmail_checkpoints` — show available checkpoint entry IDs (user and assistant messages)
- `send_dmail(entry_id, message)` — queue a D-Mail to revert to that checkpoint with the given summary

After `send_dmail`, the extension automatically commits the D-Mail on the next turn via the `/dmail-commit` command.

## When to use

- You read a large file and found 95% of it irrelevant → D-Mail back to before the read with the useful extract
- You searched the web and got massive results → D-Mail back with only the relevant findings
- You debugged for many turns and finally fixed the bug → D-Mail back to before debugging with the fix and what you learned
- You went down a wrong path and corrected course → D-Mail back to the right checkpoint

## License

MIT
