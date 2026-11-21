#ifndef RM4_TELEPORT_RUNTIME_H
#define RM4_TELEPORT_RUNTIME_H

#include "teleport.h"
struct RegistryDirectory;
void WebTeleportLoad(void);
void WebTeleportUnload(void);
/* 1 = stock render, 0 = none/custom (see output), -1 = invalid resource. */
int WebTeleportAppearance(struct RegistryDirectory* registry, const char** custom);
/* Attach only after the portal has initialized successfully. */
int WebTeleportAttachAppearance(
    void* portal, const char* custom, const Rm4TeleportAppearanceContext* context);

#endif
