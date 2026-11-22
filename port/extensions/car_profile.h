#ifndef RM4_CAR_PROFILE_H
#define RM4_CAR_PROFILE_H
#include "tm4/main/registry.h"

/* An absent optional binding is valid with resource == NULL. Explicit malformed
   data invalidates the reader; callers fail car preparation without an abort. */
typedef struct {
    RegistryDirectory* resource;
    int valid;
} Rm4CarProfileReader;
Rm4CarProfileReader WebCarProfileOpen(char* binding);
char* WebCarProfileString(Rm4CarProfileReader* reader, char* key, int required);
s32 WebCarProfileNumber(Rm4CarProfileReader* reader, char* key, s32 fallback, s32 min, s32 max);
#endif
