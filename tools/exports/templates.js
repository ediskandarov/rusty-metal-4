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

function lookup(condition, unit) {
  return `    if (${condition}) {
        result = ${unit.id}(name);
        if (result)
            return result;
    }`;
}

export function renderRegistry(manifest, { activeUnits, collisions }) {
  const declarations = [];
  const moduleLookups = [];
  const loadedLookups = [];
  for (const unit of activeUnits) {
    declarations.push(`OSWord ${unit.id}(const char* name);`);
    const matchesModule = unit.modules.map(
      (module) => `!strcasecmp(module, ${JSON.stringify(module)})`,
    );
    const moduleLoaded = unit.modules.map((module) => {
      const imageName = manifest.modules[module].image_name;
      return `WebNativeModuleLoaded(${JSON.stringify(imageName)})`;
    });
    moduleLookups.push(lookup(matchesModule.join(" || "), unit));
    loadedLookups.push(lookup(moduleLoaded.join(" || "), unit));
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
${declarations.join("\n")}

OSWord WebNativeModuleExport(const char* module, const char* name)
{
    OSWord result;
${moduleLookups.join("\n")}
    return 0;
}

OSWord WebNativeExport(const char* name)
{
    OSWord result;
${collisionLookups.join("\n")}
${loadedLookups.join("\n")}
    return 0;
}
`;
}
