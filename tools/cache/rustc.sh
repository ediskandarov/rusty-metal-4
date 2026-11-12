#!/bin/sh
# A worktree-specific path separates local crates; exec preserves Cargo's jobserver descriptors.
exec "$@"
