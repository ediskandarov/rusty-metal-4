#ifndef RM4_MAP_SETTINGS_H
#define RM4_MAP_SETTINGS_H

#include "tm4/main/registry.h"
#include "tm4/main/world.h"

/* Read immutable MR configuration once, after world geometry is loaded. */
Tm4WorldSettings* WebMapSettingsLoad(RegistryDirectory* world, Tm4WorldSettings* defaults);

#endif
