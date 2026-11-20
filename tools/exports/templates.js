import { nativeName } from "./model.js";

export function renderAccessor(unit, names) {
  const lookups = names.map(
    (name) => `    if (!strcasecmp(name, ${JSON.stringify(name)}))
        return (OSWord)&${nativeName(unit.module, name)};`,
  );

  return `#include ${JSON.stringify(unit.source)}
#include "tm4/main/os.h"
#include <strings.h>

OSWord ${unit.id}(const char* name)
{
${lookups.join("\n")}
    return 0;
}
`;
}

export function renderRegistry(manifest, { collisions }) {
  const moduleLookups = [];
  const loadedLookups = [];
  for (const module of Object.keys(manifest.modules)) {
    const image = JSON.stringify(manifest.modules[module].image_name);
    moduleLookups.push(`    if (!strcasecmp(module, ${JSON.stringify(module)}))
        return WebDynamicModuleExport(${image}, name);`);
    loadedLookups.push(`    result = WebDynamicModuleExport(${image}, name);
    if (result) return result;`);
  }

  const collisionLookups = [];
  // Tread exports have independent state and require module-qualified lookup.
  for (const name of collisions.filter((name) => name !== "carrelocatebitstuff")) {
    collisionLookups.push(`    if (!strcasecmp(name, ${JSON.stringify(name)}))
        return 0;`);
  }
  if (collisions.includes("carrelocatebitstuff")) {
    collisionLookups.push(`    if (!strcasecmp(name, "CarRelocateBitStuff")) {
        if (WebNativeModuleLoaded("o_car.sym"))
            return WebNativeModuleExport("car", name);
        if (WebNativeModuleLoaded("menu.sym"))
            return WebNativeModuleExport("menu", name);
        return 0;
    }`);
  }

  return `#include "tm4/main/os.h"
#include <strings.h>

int WebNativeModuleLoaded(const char* image_name);
OSWord WebDynamicModuleExport(const char* image_name, const char* name);
OSWord WebResourceModuleExport(const char* name);

OSWord WebNativeModuleExport(const char* module, const char* name)
{
${moduleLookups.join("\n")}
    return WebDynamicModuleExport(module, name);
}

OSWord WebNativeExport(const char* name)
{
    OSWord result;
${collisionLookups.join("\n")}
${loadedLookups.join("\n")}
    return WebResourceModuleExport(name);
}
`;
}

export function renderModule(manifest, module, { activeUnits }) {
  const units = activeUnits.filter((unit) => unit.modules.includes(module));
  const adapter = {
    weap: "WebWeaponExport",
    interact: "WebInteractExport",
    carprt: "WebCarpartExport",
    afc: "WebAfcExport",
    power: "WebPowerExport",
    timer: "WebTimerExport",
    bullet: "WebBulletExport",
    ray: "WebRayExport",
    fire: "WebFireExport",
    firing: "WebFireRingExport",
    destry: "WebDestroyableExport",
    frag: "WebFragmentExport",
    tele: "WebTeleporterExport",
    jumppad: "WebJumppadExport",
    light: "WebLightExport",
    lightn: "WebLightningExport",
    anim: "WebAnimExport",
    expl: "WebExplExport",
    "cars/auger": "WebAugerExport",
    "cars/c_pirate": "WebPirateExport",
    "levels/w_yard": "WebYardExport",
    "levels/w_neon": "WebNeonExport",
    "levels/w_carni": "WebCarnivalExport",
    "levels/w_oil": "WebOilExport",
  }[module];
  const snapshot = module.startsWith("levels/");
  return `#include "tm4/main/os.h"
${snapshot ? '#include "port/web/snapshot_types.h"\n#include <string.h>\nextern const SnapshotType Tm4ModuleSnapshotTypes[];' : ""}
${adapter ? `OSWord ${adapter}(const char*);` : ""}
${units.map((unit) => `OSWord ${unit.id}(const char* name);`).join("\n")}
OSWord Tm4ModuleExport(const char* name) {
    OSWord result;
${snapshot ? '    if (!strcmp(name, "__rm4_snapshot_types")) return (OSWord)Tm4ModuleSnapshotTypes;' : ""}
${adapter ? `    result = ${adapter}(name); if (result) return result;` : ""}
${units
  .map(
    (unit) => `    result = ${unit.id}(name);
    if (result) return result;`,
  )
  .join("\n")}
    return 0;
}
`;
}
