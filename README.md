# drift

Keep a personal fork current with upstream releases while carrying your own agent-made modifications.

drift is a Claude Code plugin: a short skill plus a CLI of deterministic primitives. The agent is the outer loop; the CLI holds no judgment. Requires Node 22.18+ (it runs its TypeScript directly) and git.

## Model

- **Mods.** In a drift repo (`.drift/config` exists), every commit ahead of upstream is a mod: a commit with a `Mod: NNN` trailer and `.drift/mods/NNN.md` holding the user's `request` (verbatim) and a `check`. A check is a shell command, `build` (unverified), or `launch [cmd]` (start, wait, require alive, kill).
- **Stack.** The bottom commit (`Drift: init` trailer) holds `.drift/config`; its parent is the pinned upstream commit. Mods sit above it.
- **Sync** rebuilds the stack onto the newest upstream release tag in a separate worktree, so your checkout is untouched until `finish`. The outcome is binary: fully on the new upstream, green and installed, or exactly where you were, with a report.

## Commands

```
drift init --upstream <url> --build <cmd> [--test <cmd>] [--install <cmd>] [--launch <cmd>]
drift adopt <sha> --request-file - --check <check>      # back-fill intent for an existing commit
drift mod commit -m <subject> --request-file - --check <check>
drift mod amend <NNN> [--request-file -] [--check <check>]
drift config <key> <value>
drift status
drift sync start [--to <tag>] [--without NNN,...] [--unattended]
drift sync continue                                      # after resolving a conflict
drift sync fixup <NNN>                                   # fold worktree edits into mod NNN (restores it if absorbed)
drift verify                                             # build, upstream tests, each mod's check
drift sync finish [--unattended]
drift sync accept | discard                              # for a held sync
drift sync abort
drift report
```

Exit codes: 0 ok, 1 refused or red, 2 conflict to resolve, 3 held for review.

## Sync, in order

1. `sync start` checks the tree is clean and every commit is a mod, fetches upstream tags into `refs/drift/upstream/*`, records `refs/drift/checkpoint`, and cherry-picks the stack onto the target in the sync worktree. On conflict it exits 2 with `{mod, intent_path, conflicted_files, from, to, worktree}`.
2. `sync continue` refuses while conflict markers remain, records what the agent wrote (the diff from the conflicted tree to the resolution), and carries on.
3. If a mod applies cleanly and upstream already contains its change, it is reported as **absorbed** and dropped (kept at `refs/drift/absorbed/NNN`). An agent-resolved mod is never treated as absorbed.
4. `verify` runs build, upstream tests and each mod's check. A failing unit gets two agent attempts (`sync fixup`); after that verify says `next: abort`.
5. `sync finish` refuses unless the current stack is verified green. It moves your branch, runs build and install in your checkout, and restores the old state if install fails.

## Unattended runs and holds

With `--unattended`, a clean rebase with a green verify always finishes. A mod the agent had to touch is **held** when:

- its check is only `build` or `launch` (`unattended.resolved_unverified: hold | finish`), or
- it is flagged (`unattended.flagged: hold | finish`).

A held sync is staged, not aborted: the result is at `refs/drift/pending`, the built worktree is kept, and the report includes exactly the hunks the agent wrote. `sync accept` installs it; `sync discard` drops it.

## Flags in the report

The report is written against each mod's request and flags two things that make a green verify weaker evidence:

- **Overrides upstream:** the mod replaces lines upstream changed in this release (by `git blame` over `from..to` on the lines the rebuilt mod deletes).
- **Rewrites upstream tests:** the mod changes or deletes upstream-authored lines in test files (globs in `tests`, with sensible defaults).

## Config (`.drift/config`, JSON)

`upstream`, `remote`, `track` (`tags` or a branch), `tagPattern`, `prerelease`, `pinned` (rewritten by every finished sync), `build`, `test`, `install`, `launch`, `launchWait`, `tests`, `worktree`, `unattended`.

## Development

```
npm install
npm test
```
