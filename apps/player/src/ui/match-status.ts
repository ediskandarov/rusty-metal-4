import type { MatchStatus } from "@tm4/game-runtime/network/match";

export function matchStatus(status: HTMLElement): MatchStatus {
  return (state, message) => {
    if (status.dataset.matchState !== state) status.dataset.matchState = state;
    if (status.textContent !== message) status.textContent = message;
  };
}
