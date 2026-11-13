# Network recovery simplification

Reviewed 2026-11-13, including the uncommitted browser suspension and prediction-window recovery changes.

The new recovery triggers reuse the existing server snapshot, bounded catch-up and Lightyear handoff. There is no second snapshot recovery implementation to remove. The main complexity is coordination in `packages/game-runtime/src/network/match.ts`.

## Priorities

1. **Consolidate recovery state.** Replace the related `recovery`, `resume`, `resumePending`, `suspended`, `connecting` and `predictionStarted` flags with explicit lifecycle stages and owned attempt data. Keep cancellation and stale-callback protection. Preserve the protocol and recovery behavior; no state-machine library is needed.
2. **Separate diagnostics from control.** Move the retarget attempt counter out of `diagnostics`. Reading diagnostics must not prevent recovery. Diagnostics should report operational state, not own it.
3. **Unify reconnect policy.** Hidden tabs, event-loop stalls and expired prediction history already resume through a snapshot. Ordinary transport loss still ends the session. Consider routing transient transport failures through the same bounded recovery policy, while keeping simulation divergence and unsupported state fatal. The manual reconnect button remains useful until then.
4. **Remove duplicate shape validation.** Zod already validates integer ranges, byte arrays and block sizes at the client boundary. Remove redundant checks in message handlers where that boundary is guaranteed. Preserve sequencing, attempt identity, checksums and lifecycle-dependent checks.
5. **Remove the residual transport facade.** `packages/game-runtime/src/network/transport.ts` re-exports the Lightyear client and exposes `tm4Network` globally for a browser test. Import the client directly in production and separate test access.

## Keep these distinctions

- Lightyear rollback corrects recent prediction; portable snapshots recover clients after longer absences.
- `SnapshotReplay` applies the bounded interval after a snapshot. It is not the removed replay-from-zero mode.
- Room subscriptions recover room membership and configuration; match connections recover simulation. Their reconnect loops have different responsibilities.
- The server journal supplies catch-up ticks as well as diagnostic history.

## Verification for lifecycle changes

- Hidden-tab and page-cache return retain the same player slot.
- A long event-loop pause is intercepted before stale prediction advances.
- Expired history and clock shifts recover through a server snapshot.
- Leaving the room cancels pending reconnect, download and replay work.
- Callbacks from superseded connections cannot affect the current attempt.
- Real simulation divergence remains fatal.
- Browser recovery continues with server-matching confirmed ticks.
