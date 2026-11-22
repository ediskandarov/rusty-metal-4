#ifndef RM4_WEAPON_PROFILES_H
#define RM4_WEAPON_PROFILES_H

#include "tm4_scalar.h"

struct Car;
struct CarWeaponInstance;
struct RegistryDirectory;

enum { CAR_ARSENAL_LIMIT = 20 };
typedef enum {
    CarWeaponOrdinary,
    CarWeaponSpecial,
    CarWeaponFreeze,
    CarWeaponMassive
} CarWeaponRole;
typedef s32 (*CarWeaponPrepare)(struct RegistryDirectory*, const void**);

typedef struct {
    const char* id;
    const u8* world_weights;
    s16 stock_index; /* Original disc-format decoder only; -1 for mod categories. */
    u8 default_weights[12];
} CarWeaponAiCategory;

/* Indices are local to the frozen map arsenal, never original weapon numbers. */
s32 CarWeaponFindProfile(const char* id);
s32 CarWeaponRoleIndex(CarWeaponRole role);
struct CarWeaponInstance* CarWeaponForRole(struct Car* car, CarWeaponRole role);
/* Raw car × world weight / 100, before per-sector normalization. */
s32 CarWeaponAiWeight(const struct Car* car, s32 index, s32 sector);
const u8* CarWeaponReadAiWeights(struct RegistryDirectory* directory, const char* id);
s32 CarWeaponInventoryValid(const struct Car* car);

#endif
