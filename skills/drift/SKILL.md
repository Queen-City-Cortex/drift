---
name: drift
description: Use in a repo that has .drift/config, for any change to the fork and for syncing it with upstream. Also use when asked to set up drift on a fork.
---

`drift` is `${CLAUDE_PLUGIN_ROOT}/bin/drift`. It prints JSON. Exit codes: 0 ok, 1 refused or red, 2 conflict for you to resolve, 3 held for review.

## Changing the fork

Every commit ahead of upstream is a mod. Make the change, then `drift mod commit -m <subject> --check <check> --request-file -` with the user's request on stdin, quoted verbatim (for a multi-turn ask, the final resolved ask in their words). A refinement of an existing mod is `drift mod amend NNN`, never a new mod.

The check is a command that fails without the mod. Prefer a test you add. For an app with nothing to test, use `launch` (starts the app, requires it to stay up). `build` is the last resort; those mods are unverified and unattended syncs hold them.

## Syncing

`drift sync start` → on exit 2, resolve the conflict in the worktree it names → `drift sync continue` → repeat → `drift verify` → `drift sync finish`.

On conflict, resolve to satisfy the mod's request against the new upstream, not to preserve the old diff.

When verify fails, fix it in the worktree and run `drift sync fixup NNN` for the mod at fault. When verify says `next: abort`, run `drift sync abort`. Abort is always safe.

When running unattended, pass `--unattended`. Exit 3 means the sync is held: stop and point the user at the report. They decide with `drift sync accept` or `drift sync discard`.

After finish, abort or hold, tell the user the outcome against each mod's request, using the report.

## Setting up

`drift init --upstream <url> --build <cmd> [--test <cmd>] [--install <cmd>]`. If it lists `unadopted` commits, read each one and run `drift adopt <sha> --request-file - --check <check>`, with the request written as what the user most likely asked for. Shas change after each adopt; use the list it returns.
