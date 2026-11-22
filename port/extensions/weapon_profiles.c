#include "weapon_profiles.h"
#include "src/modules/car/private.h"
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

/* The original disc encodes AI weights as positional byte arrays. This table is
 * only the decoder for that resource format, never an inventory layout. */
static const char* stock_ai_names[] = { "Special", "Fire", "Power", "Homing", "Napalm", "Mortar",
    "Speed", "Rain", "Remote", "Ricochet", "MIRV", "Lightning", "Proximity", "Freeze", "Autolob",
    "FreezeRemote", "Massive", "Rain2", "Level3", "Level4" };

typedef struct {
    CarWeaponDescriptor weapon;
} WeaponProfile;
static WeaponProfile* profiles;
static s32 profile_count;
static CarWeaponAiCategory* ai_categories;
static s32 ai_category_count;
static s32 role_indices[4];

static void profile_error(const char* profile, const char* field, const char* reason)
{
    fprintf(stderr, "Weapon profile %s / %s: %s\n", profile, field, reason);
    abort();
}

static RegistryFile* profile_file(RegistryDirectory* resource, const char* key, int defaults)
{
    RegistryFile* file = resource ? RegGetFilePtrPS(resource, (char*)key) : NULL;
    if (!file && defaults) {
        RegistryDirectory* fallback = RegGetDirectoryPtrPS(CarClassDirectory, "weapon/default");
        file = fallback ? RegGetFilePtrPS(fallback, (char*)key) : NULL;
    }
    return file;
}

static const char* profile_string(RegistryDirectory* resource, const char* id, const char* key)
{
    RegistryFile* file = profile_file(resource, key, 0);
    if (!file)
        return NULL;
    if (RegGetFileTypeP(file) != REG_FILE_TYPE_STRING)
        profile_error(id, key, "expected a string");
    const char* value = RegGetFileDataP(file);
    if (!value || !*value)
        profile_error(id, key, "empty string");
    return value;
}

static s32 profile_number(RegistryDirectory* resource, const char* id, const char* key,
    int defaults, s32 fallback, s32 min, s32 max)
{
    RegistryFile* file = profile_file(resource, key, defaults);
    if (!file)
        return fallback;
    s32 type = RegGetFileTypeP(file);
    if (type != REG_FILE_TYPE_LONG && type != 11 && type != 13)
        profile_error(id, key, "expected a numeric scalar");
    /* Boolean resources store a byte; LONG and FIXED_POINT store a word. */
    const void* data = RegGetFileDataP(file);
    s32 value = type == 11 ? *(const u8*)data : *(const s32*)data;
    if (value < min || value > max)
        profile_error(id, key, "value out of range");
    return value;
}

const u8* CarWeaponReadAiWeights(RegistryDirectory* directory, const char* id)
{
    RegistryFile* file = directory ? RegGetFilePtrPS(directory, (char*)id) : NULL;
    if (!file)
        return NULL;
    if (RegGetFileTypeP(file) != 18 || RegGetFileArraySizeP(file) != 12)
        profile_error(id, "ai/weaponWeights", "expected an array of 12 bytes");
    return RegGetFileDataP(file);
}

static u32 profile_hash(u32 hash, const char* value)
{
    for (const u8* byte = (const u8*)value; *byte; ++byte) {
        hash ^= *byte;
        hash *= 16777619u;
    }
    return (hash ^ 0xffu) * 16777619u;
}

static int profile_compare(const void* a, const void* b)
{
    return strcasecmp(((const WeaponProfile*)a)->weapon.id, ((const WeaponProfile*)b)->weapon.id);
}

static WeaponProfile* find_profile(const char* id)
{
    for (s32 i = 0; i < profile_count; ++i)
        if (!strcasecmp(profiles[i].weapon.id, id))
            return &profiles[i];
    return NULL;
}

/* Built-in categories adapt the original 20-column resource tables. Mods add
 * named categories; neither their number nor their IDs are inventory slots. */
static const char* stock_ai_categories[] = { "special", "fire", "power", "homing", "napalm",
    "mortar", "speed", "rain", "remote", "ricochet", "mirv", "lightning", "proximity", "freeze",
    "autolob", "freezeRemote", "massive", "rain2", "level3", "level4" };

static CarWeaponAiCategory* find_ai_category(const char* id)
{
    for (s32 i = 0; id && i < ai_category_count; ++i)
        if (!strcasecmp(ai_categories[i].id, id))
            return &ai_categories[i];
    return NULL;
}

static s32 category_directory_count(RegistryDirectory* root)
{
    return root ? RegGetNumberOfDirectoriesP(root) : 0;
}

static void read_ai_categories(RegistryDirectory* root)
{
    for (s32 i = 0; i < category_directory_count(root); ++i) {
        const char* id = RegGetDirectoryNamePN(root, i);
        RegistryDirectory* entry = RegGetDirectoryPtrPN(root, i);
        if (find_ai_category(id))
            profile_error(id, "aiCategory", "duplicate AI category");
        const u8* weights = CarWeaponReadAiWeights(entry, "defaultWeights");
        if (!weights)
            profile_error(id, "defaultWeights", "required for an AI category");
        CarWeaponAiCategory* category = &ai_categories[ai_category_count++];
        category->id = id;
        category->stock_index = -1;
        memcpy(category->default_weights, weights, sizeof(category->default_weights));
    }
}

static void load_ai_categories(void)
{
    RegistryDirectory* root = RegGetDirectoryPtrS("/weaponAiCategories");
    RegistryDirectory* packs = RegGetDirectoryPtrS("/resourcePacks");
    s32 count = ArrayCount(stock_ai_categories) + category_directory_count(root);
    for (s32 i = 0; i < category_directory_count(packs); ++i) {
        RegistryDirectory* pack = RegGetDirectoryPtrPN(packs, i);
        count += category_directory_count(RegGetDirectoryPtrPS(pack, "weaponAiCategories"));
        if (count > 1024)
            profile_error("registry", "aiCategory", "resource limit exceeded");
    }
    if (count > 1024)
        profile_error("registry", "aiCategory", "resource limit exceeded");
    ai_categories = MemCalloc(count, sizeof(*ai_categories));
    if (!ai_categories)
        profile_error("registry", "aiCategory", "out of memory");
    for (s32 i = 0; i < (s32)ArrayCount(stock_ai_categories); ++i) {
        CarWeaponAiCategory* category = &ai_categories[ai_category_count++];
        category->id = stock_ai_categories[i];
        category->stock_index = i;
        /* Stock categories read car preferences through the disc adapter. */
    }
    read_ai_categories(root);
    for (s32 i = 0; i < category_directory_count(packs); ++i)
        read_ai_categories(
            RegGetDirectoryPtrPS(RegGetDirectoryPtrPN(packs, i), "weaponAiCategories"));
    RegistryDirectory* world = RegGetDirectoryPtrS("/world/ai/weaponWeights");
    for (s32 i = 0; i < ai_category_count; ++i)
        ai_categories[i].world_weights = CarWeaponReadAiWeights(world, ai_categories[i].id);
}

static void read_profile(
    WeaponProfile* output, RegistryDirectory* resource, const char* id, int stock)
{
    CarWeaponDescriptor* weapon = &output->weapon;
    memset(weapon, 0, sizeof(*weapon));
    weapon->id = id;
    weapon->name = (char*)id;
    weapon->resource = resource;
    weapon->hud_name = (char*)profile_string(resource, id, "hudName");
    if (!weapon->hud_name)
        weapon->hud_name = weapon->name;
    weapon->model = profile_string(resource, id, "model");
    const char* role = profile_string(resource, id, "role");
    if (stock && !role) {
        if (!strcasecmp(id, "Special"))
            role = "special";
        if (!strcasecmp(id, "Freeze"))
            role = "freeze";
        if (!strcasecmp(id, "Massive"))
            role = "massive";
    }
    weapon->role = CarWeaponOrdinary;
    if (role) {
        if (!strcmp(role, "special"))
            weapon->role = CarWeaponSpecial;
        else if (!strcmp(role, "freeze"))
            weapon->role = CarWeaponFreeze;
        else if (!strcmp(role, "massive"))
            weapon->role = CarWeaponMassive;
        else
            profile_error(id, "role", "unknown role");
    }
    weapon->initial = profile_number(resource, id, "initial", stock, 0, 0, SHRT_MAX);
    weapon->maximum = profile_number(resource, id, "max", stock, 99, 0, SHRT_MAX);
    if (weapon->initial > weapon->maximum)
        profile_error(id, "initial", "exceeds maximum ammo");
    s32 delay = profile_number(
        resource, id, "delay", stock, ONE, 0, (SHRT_MAX * ONE - ONE / 2) / SIMULATION_FPS);
    weapon->delay = Q12MulRound(delay, SIMULATION_FPS);
    weapon->repeat = profile_number(resource, id, "repeat", stock, 0, 0, 1);
    weapon->detonate = profile_number(resource, id, "detonate", stock, 0, 0, 1);
    const char* launch = profile_string(resource, id, "launchFunc");
    char symbol[strlen(id) + sizeof("CarLaunch")];
    if (!launch && stock) {
        snprintf(symbol, sizeof(symbol), "CarLaunch%s", id);
        launch = symbol;
    }
    if (weapon->role != CarWeaponSpecial) {
        if (!launch || !(weapon->launch = (CarWeaponLaunch)OSSymbolGetAddress((char*)launch)))
            profile_error(id, "launchFunc", "missing launcher export");
    }
    const char* prepare = profile_string(resource, id, "prepareFunc");
    if (prepare) {
        CarWeaponPrepare configure = (void*)OSSymbolGetAddress((char*)prepare);
        if (!configure || !configure(resource, &weapon->launch_data))
            profile_error(id, "prepareFunc", "configuration rejected by launcher");
    }
    if (profile_file(resource, "aiProfile", 0) || profile_file(resource, "aiWeights", 0))
        profile_error(id, "aiCategory", "use an AI category instead of profile-local weights");
    const char* ai = profile_string(resource, id, "aiCategory");
    if (!ai && stock)
        for (s32 i = 0; i < (s32)ArrayCount(stock_ai_names); ++i)
            if (!strcasecmp(stock_ai_names[i], id))
                ai = stock_ai_categories[i];
    weapon->ai_category = find_ai_category(ai);
    if (!weapon->ai_category)
        profile_error(id, "aiCategory", "unknown or missing AI category");
    weapon->profile_key = profile_hash(2166136261u, id);
    weapon->profile_key = profile_hash(weapon->profile_key, launch ? launch : "special");
    weapon->profile_key = profile_hash(weapon->profile_key, weapon->ai_category->id);
    char parameters[128];
    snprintf(parameters, sizeof(parameters), "%d:%d:%d:%d:%d:%d", weapon->initial, weapon->maximum,
        weapon->delay, weapon->repeat, weapon->detonate, weapon->role);
    weapon->profile_key = profile_hash(weapon->profile_key, parameters);
    weapon->profile_key = profile_hash(weapon->profile_key, prepare ? prepare : "");
}

void CarWeaponClassConstructor(RegistryDirectory* directory)
{
    if (profiles)
        profile_error("registry", "lifecycle", "already frozen");
    load_ai_categories();
    CarWeaponDirectory = RegGetDirectoryPtrPS(directory, "weapon/list");
    RegistryDirectory* extra = RegGetDirectoryPtrS("/weaponProfiles");
    s32 stock_count = RegGetNumberOfDirectoriesP(CarWeaponDirectory);
    s32 extra_count = extra ? RegGetNumberOfDirectoriesP(extra) : 0;
    if (stock_count < 0 || extra_count < 0 || stock_count + extra_count > 1024)
        profile_error("registry", "count", "resource limit exceeded");
    profile_count = stock_count + extra_count;
    profiles = MemCalloc(profile_count, sizeof(*profiles));
    if (!profiles)
        profile_error("registry", "allocation", "out of memory");
    for (s32 i = 0; i < profile_count; ++i) {
        RegistryDirectory* parent = i < stock_count ? CarWeaponDirectory : extra;
        s32 index = i < stock_count ? i : i - stock_count;
        read_profile(&profiles[i], RegGetDirectoryPtrPN(parent, index),
            RegGetDirectoryNamePN(parent, index), i < stock_count);
    }
    qsort(profiles, profile_count, sizeof(*profiles), profile_compare);
    for (s32 i = 1; i < profile_count; ++i)
        if (!strcasecmp(profiles[i - 1].weapon.id, profiles[i].weapon.id))
            profile_error(profiles[i].weapon.id, "id", "duplicate profile");

    RegistryDirectory* arsenal = RegGetDirectoryPtrS("/world/arsenal");
    CarWeaponCount = arsenal ? RegGetNumberOfDirectoriesP(arsenal) : stock_count;
    if (CarWeaponCount < 1 || CarWeaponCount > CAR_ARSENAL_LIMIT)
        profile_error("arsenal", "count", "expected 1..20 entries");
    s32 order_indices[CAR_ARSENAL_LIMIT];
    memset(CarWeaponDescriptors, 0, sizeof(CarWeaponDescriptors));
    for (s32 i = 0; i < 4; ++i)
        role_indices[i] = -1;
    for (s32 i = 0; i < CarWeaponCount; ++i)
        order_indices[i] = -1;
    for (s32 i = 0; i < CarWeaponCount; ++i) {
        RegistryDirectory* entry = arsenal ? RegGetDirectoryPtrPN(arsenal, i) : NULL;
        const char* id = arsenal ? profile_string(entry, "arsenal", "profile")
                                 : RegGetDirectoryNamePN(CarWeaponDirectory, i);
        WeaponProfile* profile = id ? find_profile(id) : NULL;
        if (!profile)
            profile_error("arsenal", "profile", "unknown or missing profile");
        s32 order = arsenal ? profile_number(entry, id, "order", 0, -1, 0, CarWeaponCount - 1) : i;
        if (order < 0 || order_indices[order] != -1)
            profile_error(id, "order", "missing or duplicate arsenal position");
        order_indices[order] = i;
        CarWeaponDescriptors[i] = profile->weapon;
        CarWeaponDescriptors[i].initial = arsenal
            ? profile_number(
                  entry, id, "initial", 0, profile->weapon.initial, 0, profile->weapon.maximum)
            : profile->weapon.initial;
        for (s32 j = 0; j < i; ++j)
            if (!strcasecmp(CarWeaponDescriptors[j].id, id))
                profile_error(id, "arsenal", "profile selected twice");
        CarWeaponRole role = profile->weapon.role;
        if (role != CarWeaponOrdinary) {
            if (role_indices[role] != -1)
                profile_error(id, "role", "role selected twice");
            role_indices[role] = i;
        }
    }
    /* Explicit arsenal order controls both inventory and switching, independent
     * of MR directory enumeration. */
    CarWeaponDescriptor sorted[CAR_ARSENAL_LIMIT];
    for (s32 i = 0; i < CarWeaponCount; ++i)
        sorted[i] = CarWeaponDescriptors[order_indices[i]];
    memcpy(CarWeaponDescriptors, sorted, CarWeaponCount * sizeof(*sorted));
    for (s32 i = 0; i < 4; ++i)
        role_indices[i] = -1;
    for (s32 i = 0; i < CarWeaponCount; ++i) {
        CarWeaponRole role = CarWeaponDescriptors[i].role;
        if (role != CarWeaponOrdinary)
            role_indices[role] = i;
    }
    if (role_indices[CarWeaponSpecial] < 0)
        profile_error("arsenal", "special", "one vehicle special position is required");
    for (s32 i = 0; i < CarWeaponCount; ++i)
        for (s32 j = 0; j < i; ++j)
            if (CarWeaponDescriptors[i].profile_key == CarWeaponDescriptors[j].profile_key)
                profile_error(CarWeaponDescriptors[i].id, "identity", "profile key collision");
    CarDetonationDevices = NULL;
}

void CarWeaponClassDestructor(RegistryDirectory* directory)
{
    CarFreeDetonationDevices();
    MemFree(ai_categories);
    ai_categories = NULL;
    ai_category_count = 0;
    MemFree(profiles);
    profiles = NULL;
    profile_count = CarWeaponCount = 0;
    for (s32 i = 0; i < 4; ++i)
        role_indices[i] = -1;
}

s32 CarWeaponFindProfile(const char* id)
{
    for (s32 i = 0; id && i < CarWeaponCount; ++i)
        if (!strcasecmp(CarWeaponDescriptors[i].id, id))
            return i;
    return -1;
}
s32 CarWeaponRoleIndex(CarWeaponRole role)
{
    return role > CarWeaponOrdinary && role <= CarWeaponMassive ? role_indices[role] : -1;
}
CarWeaponInstance* CarWeaponForRole(Car* car, CarWeaponRole role)
{
    s32 index = CarWeaponRoleIndex(role);
    return car && car->weapons && index >= 0 ? &car->weapons[index] : NULL;
}
s32 CarWeaponAiWeight(const Car* car, s32 index, s32 sector)
{
    const CarWeaponInstance* weapon = &car->weapons[index];
    const CarWeaponAiCategory* category = weapon->descriptor->ai_category;
    const s32 stock = category->stock_index;
    const s32 car_weight = weapon->ai_weights ? weapon->ai_weights[sector]
        : stock >= 0 ? car->ai_config.sectors[sector].weapon_probabilities[stock]
                     : category->default_weights[sector];
    const s32 world_weight = category->world_weights ? category->world_weights[sector]
        : stock >= 0 ? aiWorldInfo.sectors[sector].weapon_probabilities[stock]
                     : 100;
    return car_weight * world_weight / 100;
}
s32 CarWeaponInventoryValid(const Car* car)
{
    for (s32 i = 0; i < CarWeaponCount; ++i)
        if (!car->weapons[i].descriptor
            || car->weapons[i].profile_key != CarWeaponDescriptors[i].profile_key
            || car->weapons[i].descriptor->profile_key != CarWeaponDescriptors[i].profile_key)
            return 0;
    return 1;
}
