---
name: git-safety
description: Use before deleting branches or worktrees, rewriting remote history, or running any git command that discards work.
user-invocable: false
---

# Git safety

- Get explicit authorization before deleting worktrees or branches, enumerate what
  you will remove first, and verify the cleanup completed.
- Never force-push or rewrite a remote branch without the user's explicit
  authorization. Never rewrite a branch someone else may have based work on.
- Never `git stash` in a repository with worktrees: the stash list is shared across
  every worktree and a stray pop applies another worktree's work. Commit a
  work-in-progress commit instead.
- Never `reset --soft` onto a moved default branch to squash: it silently reverts
  work merged in the meantime. Merge the default branch in, then squash-merge.
- Remove only worktrees, branches and processes your own session created. Stop your
  own background work by task ID, never by a command-pattern `pkill`.
- Preserve unrelated dirty work. Stage by explicit path, not `git add -A`.
