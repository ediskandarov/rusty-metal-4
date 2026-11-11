/* A deterministic input tape and existing diagnostic placements, shared by both hosts. */
function fixtureAction(tick) {
  if (tick === 60) return ["_WebTestPlaceWeaponTarget", 128];
  if (tick === 110) return ["_WebTestPlaceWeaponTarget", 500];
  if (tick === 220) return ["_WebTestApproachCrane", 0];
  return null;
}
function fixtureCommands(tick) {
  const steering = tick % 64 < 32 ? 0x8000 : 0x2000;
  const first =
    tick < 56
      ? 0x40 | steering
      : tick >= 220
        ? 0x2000
        : tick >= 64
          ? 0x2 | (tick % 12 === 0 ? 0x1 : 0)
          : 0;
  const second = tick < 56 ? 0x40 | (steering ^ 0xa000) : tick >= 150 ? 0x40 | steering | 0x2 : 0;
  return [{ buttons: first }, { buttons: second }];
}
module.exports = { fixtureAction, fixtureCommands };
