---
name: github-commit-guidelines
description: Guidelines for committing code to GitHub from Claude Code. Use this skill whenever you are about to create a git commit, run `git commit`, push to a GitHub repository, or set up git in a repo — even if the user only says something like "commit this," "push my changes," or "save this to the repo." It ensures the git author identity is configured before committing and that commits are attributed to the developer, not to Claude.
---

# GitHub commit guidelines

Purpose: commits pushed from this environment must read, in `git log`, as the
developer's own work — not as authored by Claude. This skill runs a check
before any commit/push, not after.

## Procedure — run before `git commit`, `git push`, or `git init`

1. **Check the current identity.**
   ```
   git config user.name
   git config user.email
   ```
   If either is missing, generic, or anything resembling `Claude` /
   `noreply@anthropic.com` / `claude-code@…`, it needs to be fixed before
   committing — do not let a commit go out under that identity.

2. **Find the developer's real identity from repo history.**
   ```
   git log --format='%an <%ae>' | sort | uniq -c | sort -rn | head -5
   ```
   Use the most common (or most recent, if the repo is new/thin) human
   author found there as the identity to commit as. This is more reliable
   than guessing from the session's user-email context, since it's the
   identity the project's own history already uses.

3. **If there is no history to draw from** (brand-new repo, first commit
   ever), don't invent an identity — ask the user for the name/email they
   want commits attributed to, or use context explicitly given in the
   conversation (e.g. a stated user email). Never fall back to a Claude/
   Anthropic identity.

4. **Set the identity locally (not globally)**, so it's scoped to this repo:
   ```
   git config user.name  "<developer name>"
   git config user.email "<developer email>"
   ```

5. **If a commit already went out under the wrong identity** (e.g. it was
   made before this check ran), fix it rather than leaving it:
   - If unpushed, or pushed only to a throwaway/feature branch you control:
     `git commit --amend --reset-author --no-edit`, then push (force-with-lease
     if it was already pushed).
   - If it already landed on a shared branch (main) that others may have
     built on, don't silently rewrite it — flag it to the user instead of
     force-pushing history they might depend on.

6. **Keep the `Co-Authored-By: Claude ... <noreply@anthropic.com>` trailer**
   in the commit message body (per Claude Code's standard commit convention)
   — that's a separate, additive attribution and does not conflict with step
   4. The trailer says Claude assisted; the author/committer identity says
   whose repo and judgment it landed under.

7. **Verify before moving on:**
   ```
   git log -1 --format='author: %an <%ae>%ncommitter: %cn <%ce>'
   ```
   Confirm both lines show the developer, not Claude.
