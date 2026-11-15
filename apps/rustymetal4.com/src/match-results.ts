import { roomModes } from "./modes/index.ts";
import type { RoomState } from "./modes/types.ts";
import { roomMember } from "./state/room.ts";
export function renderMatchResults(state: RoomState) {
  const result = state.room?.result;
  const viewing = !!result && state.returnedResult !== result.matchId;
  document.getElementById("results-panel")!.hidden =
    !result || !roomMember(state) || state.departed || !!state.room?.closed;
  document.getElementById("return-to-room")!.hidden = !viewing;
  if (result) {
    // Results can remain visible after the host changes the next match's mode.
    const mode =
      result.completion.reasons === 4 || result.completion.reasons === 8
        ? roomModes.tournament
        : roomModes.ffa;
    const presentation = mode.results(result);
    document.getElementById("results-reason")!.textContent = presentation.summary;
    document.getElementById("results-rows")!.replaceChildren(
      ...presentation.rows.map(({ participant: row, outcome }) => {
        const tr = document.createElement("tr");
        tr.dataset.participant = row.identity.participant;
        tr.dataset.member = row.memberId;
        for (const value of [row.name, row.score.frags, row.score.deaths, outcome]) {
          const td = document.createElement("td");
          td.textContent = String(value);
          tr.append(td);
        }
        return tr;
      }),
    );
  }
  return viewing;
}
