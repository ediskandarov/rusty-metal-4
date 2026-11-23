import { sameCompatibility } from "../../compatibility.ts";
import type { ModeRules } from "../rules-types.ts";
export const carSelectionRules = {
  choiceError(state, member, choice) {
    const host = state.members.find((entry) => entry.id === state.hostId);
    return choice.ready &&
      (!choice.car ||
        !choice.compatibility ||
        (host?.id !== member.id &&
          !sameCompatibility(choice.compatibility, host?.compatibility ?? null)))
      ? "Choose a car in the game with matching resources before confirming."
      : null;
  },
  choiceInvalidatesReady(state, member, choice) {
    return (
      member.id === state.hostId && !sameCompatibility(choice.compatibility, member.compatibility)
    );
  },
  preparationStarted() {
    /* Native Done remains valid while the host uploads resources. */
  },
  serverPrepared(state) {
    const match = state.match!;
    for (const member of state.members)
      if (
        !sameCompatibility(member.compatibility, match.compatibility) ||
        !member.car ||
        !match.cars.includes(member.car)
      )
        member.ready = false;
  },
} satisfies Pick<
  ModeRules,
  "choiceError" | "choiceInvalidatesReady" | "preparationStarted" | "serverPrepared"
>;
