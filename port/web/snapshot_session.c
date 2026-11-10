#include "snapshot_session.h"

#include "interpolation.h"
#include "src/main/object/private.h"
#include "src/modules/car/private.h"
#include "tm4/main/game.h"
#include "tm4/main/main.h"
#include "tm4/main/pad.h"
#include "tm4/main/system.h"

#include <stdint.h>
#include <string.h>

enum {
    SessionVersion = 1,
    Players = 2,
    MaxSquares = 4096,
    MaxObjects = 4096,
    MaxDevices = 64,
    RegistryDepth = 16,
};

typedef struct {
    u32 car, camera;
    s32 lives, wins, losses, eliminated, camera_distance_preset;
    PadCache input;
} PlayerRecord;

typedef struct {
    u32 object;
    s16 car_index;
    s16 weapon_index;
} DeviceRecord;

typedef struct {
    u32 object;
    s16 node, unknown06;
} HealthRecord;

typedef struct {
    u32 display, interaction, active_next;
} SquareRecord;

typedef struct {
    u32 version, tick, serial, random, effect_random;
    u16 path_generation, random_generation, health_generation;
    u8 registry_depth, device_count, health_count;
    u16 registry_path[RegistryDepth];
    u32 lists[OBJECT_LIST_COUNT], active_cells;
    u32 squares, gte_length;
    u8 gte[256];
    u32 car_order[Players];
    PlayerRecord players[Players];
    s32 games_completed, deathmatch_winner, deathmatch_finished;
    s32 deathmatch_next_mode, deathmatch_accept_input, deathmatch_rounds;
    DeviceRecord devices[MaxDevices];
    HealthRecord health[ArrayCount(CarHealthPickups)];
} SessionRecord;

u32 WebCheckpointGteCapture(void* output, u32 capacity);
void WebCheckpointGteRestore(const void* input);
void WebCheckpointSetRandomState(u32 random, u32 effects);

static int supported_session(void)
{
    return GameInfo.active && GameInfo.mode == GAME_MODE_PLAY && !GameInfo.next_mode
        && !GameInfo.pause_player && GameInfo.game_type == GAME_TYPE_DEATHMATCH
        && GameInfo.world_name && !strcmp(GameInfo.world_name, "Construction Yard")
        && GameInfo.player_car_count == Players && !GameInfo.computer_count
        && GameInfo.active_player_count == Players && GameInfo.car_count == Players
        && GameInfo.players[0].car && GameInfo.players[1].car && WorldSquares
        && GameInfo.players[0].car->character_name && GameInfo.players[1].car->character_name
        && !strcmp(GameInfo.players[0].car->character_name, "Orbital")
        && !strcmp(GameInfo.players[1].car->character_name, "Pizza Boy");
}

static s32 square_count(void)
{
    const s32* count = RegGetFileDataS("/world/squares/numSquares");
    return count && *count > 0 && *count <= MaxSquares ? *count : 0;
}

static int registry_path(
    RegistryDirectory* directory, RegistryDirectory* target, u16* path, int depth)
{
    if (directory == target)
        return depth;
    if (!directory || depth == RegistryDepth)
        return -1;
    s32 count = RegGetNumberOfDirectoriesP(directory);
    if (count < 0 || count > UINT16_MAX)
        return -1;
    for (s32 i = 0; i < count; ++i) {
        RegistryDirectory* child = RegGetDirectoryPtrPN(directory, i);
        int found = registry_path(child, target, path, depth + 1);
        if (found >= 0) {
            path[depth] = i;
            return found;
        }
    }
    return -1;
}

static u32 square_handle(const Tm4WorldSquare* cell, u32 count)
{
    if (!cell)
        return 0;
    const uintptr_t offset = (uintptr_t)cell - (uintptr_t)WorldSquares;
    if (offset % sizeof(*cell) || offset / sizeof(*cell) >= count)
        return UINT32_MAX;
    return offset / sizeof(*cell) + 1;
}

static u32 object_handle(const Tm4ObjectHeader* object)
{
    return WebSnapshotLiveHandle(object ? ObjectGetPayload(object) : NULL);
}

static int device_weapon(DeviceRecord* record, const CarWeaponInstance* weapon)
{
    for (s32 i = 0; i < Players; ++i) {
        for (s32 j = 0; j < CarWeaponCount; ++j) {
            if (weapon == &GameInfo.cars[i]->weapons[j]) {
                record->car_index = i;
                record->weapon_index = j;
                return 1;
            }
        }
    }
    return 0;
}

static int save_devices(SessionRecord* record)
{
    for (const CarDetonationNode* node = CarDetonationDevices; node; node = node->next) {
        if (record->device_count == MaxDevices)
            return 0;
        DeviceRecord* device = &record->devices[record->device_count++];
        device->object = WebSnapshotLiveHandle(node->object);
        if (!device->object || device->object == UINT32_MAX || !device_weapon(device, node->weapon))
            return 0;
    }
    return 1;
}

u32 WebSnapshotSessionCapture(u8* output, u32 capacity)
{
    if (!supported_session() || !output || capacity < sizeof(SessionRecord))
        return 0;
    SessionRecord record;
    memset(&record, 0, sizeof(record));
    record.version = SessionVersion;
    record.squares = square_count();
    const u32 length = sizeof(record) + record.squares * sizeof(SquareRecord);
    if (!record.squares || length > capacity || !save_devices(&record) || CarHealthPickupCount < 0
        || CarHealthPickupCount > ArrayCount(record.health))
        return 0;
    int depth = registry_path(
        RegGetDirectoryPtrS("/"), RegGetCurrentDirectoryPtr(), record.registry_path, 0);
    record.gte_length = WebCheckpointGteCapture(record.gte, sizeof(record.gte));
    if (depth < 0 || !record.gte_length)
        return 0;
    record.registry_depth = depth;
    record.tick = MainFrameCount;
    record.serial = ObjectNextSerial;
    record.random = randseed();
    record.effect_random = WebRenderEffectRandomState();
    record.path_generation = CarPathSearchGeneration;
    record.random_generation = CarRandomSearchGeneration[0];
    record.health_generation = CarHealthSearchGeneration;
    record.games_completed = GameInfo.games_completed;
    record.deathmatch_winner = GameInfo.deathmatch_winner;
    record.deathmatch_finished = GameInfo.deathmatch_finished;
    record.deathmatch_next_mode = GameInfo.deathmatch_next_mode;
    record.deathmatch_accept_input = GameInfo.deathmatch_accept_input;
    record.deathmatch_rounds = GameInfo.deathmatch_rounds;
    record.active_cells = square_handle(ObjectActiveInteractionCells, record.squares);
    for (u32 i = 0; i < Players; ++i) {
        const Tm4GamePlayer* player = &GameInfo.players[i];
        record.car_order[i] = WebSnapshotLiveHandle(GameInfo.cars[i]);
        record.players[i] = (PlayerRecord) {
            .car = WebSnapshotLiveHandle(player->car),
            .camera = WebSnapshotLiveHandle(player->camera),
            .lives = player->lives,
            .wins = player->wins,
            .losses = player->losses,
            .eliminated = player->eliminated,
            .camera_distance_preset = player->camera_distance_preset,
            .input = PadJpad[i],
        };
    }
    for (unsigned i = 0; i < OBJECT_LIST_COUNT; ++i)
        record.lists[i] = object_handle(ObjectLists[i].first);
    record.health_count = CarHealthPickupCount;
    for (u32 i = 0; i < record.health_count; ++i) {
        const CarAiHealthEntry* health = &CarHealthPickups[i];
        record.health[i] = (HealthRecord) { WebSnapshotLiveHandle(health->object), health->node,
            health->unknown06 };
    }
    for (u32 i = 0; i < record.squares; ++i) {
        const Tm4WorldSquare* square = &WorldSquares[i];
        const SquareRecord cell = {
            object_handle(square->display_objects),
            object_handle(square->interaction_objects),
            square_handle(square->active_next, record.squares),
        };
        if (cell.display == UINT32_MAX || cell.interaction == UINT32_MAX
            || cell.active_next == UINT32_MAX)
            return 0;
        memcpy(output + sizeof(record) + i * sizeof(cell), &cell, sizeof(cell));
    }
    memcpy(output, &record, sizeof(record));
    return length;
}

static Tm4ObjectHeader* find_header(WebSnapshotFindObject* find_object, u32 handle)
{
    void* payload = handle ? find_object(handle) : NULL;
    return payload ? ObjectGetHeader(payload) : NULL;
}

static void* find_class(WebSnapshotFindObject* find_object, u32 handle, const char* name)
{
    Tm4ObjectHeader* object = find_header(find_object, handle);
    return object && !strcmp(object->name, name) ? ObjectGetPayload(object) : NULL;
}

static int validate_grid_chain(Tm4ObjectHeader* head, const Tm4WorldSquare* square, int interaction)
{
    u32 count = 0;
    for (const Tm4ObjectHeader* object = head; object;
         object = interaction ? object->next_interaction : object->next_display) {
        if (++count > MaxObjects || (interaction ? !object->interaction_enabled : !object->display)
            || WorldFindSquare(object->position.vx, object->position.vz) != square)
            return 0;
    }
    return 1;
}

static SquareRecord read_square(const u8* input, u32 index)
{
    SquareRecord cell;
    memcpy(&cell, input + index * sizeof(cell), sizeof(cell));
    return cell;
}

static int validate_grid(
    const u8* input, const SessionRecord* record, WebSnapshotFindObject* find_object)
{
    u32 active = 0;
    for (u32 i = 0; i < record->squares; ++i) {
        const SquareRecord cell = read_square(input, i);
        Tm4ObjectHeader* display = find_header(find_object, cell.display);
        Tm4ObjectHeader* interaction = find_header(find_object, cell.interaction);
        if (cell.active_next > record->squares || (cell.display && !display)
            || (cell.interaction && !interaction) || (!interaction && cell.active_next)
            || !validate_grid_chain(display, &WorldSquares[i], 0)
            || !validate_grid_chain(interaction, &WorldSquares[i], 1))
            return 0;
        active += interaction != NULL;
    }
    for (u32 i = record->active_cells; i;) {
        if (!active-- || i > record->squares)
            return 0;
        const SquareRecord cell = read_square(input, i - 1);
        if (!cell.interaction)
            return 0;
        i = cell.active_next;
    }
    return active == 0;
}

static void free_devices(CarDetonationNode* devices)
{
    while (devices) {
        CarDetonationNode* next = devices->next;
        MemFree(devices);
        devices = next;
    }
}

int WebSnapshotSessionRestore(const u8* input, u32 length, WebSnapshotFindObject* find_object)
{
    SessionRecord record;
    if (!supported_session() || !input || length < sizeof(record) || !find_object)
        return 0;
    memcpy(&record, input, sizeof(record));
    u8 current_gte[sizeof(record.gte)];
    if (record.version != SessionVersion || !record.serial || record.tick >= INT32_MAX
        || record.registry_depth > RegistryDepth || record.device_count > MaxDevices
        || record.health_count > ArrayCount(record.health) || !record.squares
        || record.squares != square_count()
        || length != sizeof(record) + record.squares * sizeof(SquareRecord) || !record.gte_length
        || record.gte_length != WebCheckpointGteCapture(current_gte, sizeof(current_gte)))
        return 0;
    RegistryDirectory* directory = RegGetDirectoryPtrS("/");
    for (u32 i = 0; directory && i < record.registry_depth; ++i) {
        if (record.registry_path[i] >= RegGetNumberOfDirectoriesP(directory))
            return 0;
        directory = RegGetDirectoryPtrPN(directory, record.registry_path[i]);
    }
    if (!directory)
        return 0;
    Car* cars[Players];
    Car* player_cars[Players];
    Camera* cameras[Players];
    for (u32 i = 0; i < Players; ++i) {
        cars[i] = find_class(find_object, record.car_order[i], "car");
        player_cars[i] = find_class(find_object, record.players[i].car, "car");
        cameras[i] = find_class(find_object, record.players[i].camera, "camera");
        if (!cars[i] || !player_cars[i] || !cameras[i] || player_cars[i]->controller_index != i
            || record.players[i].eliminated || record.players[i].input.has_analog > 1
            || (u32)record.players[i].camera_distance_preset >= 3)
            return 0;
    }
    if (cars[0] == cars[1] || cameras[0] == cameras[1]
        || (cars[0] != player_cars[0] && cars[0] != player_cars[1])
        || (cars[1] != player_cars[0] && cars[1] != player_cars[1]))
        return 0;
    Tm4ObjectHeader* lists[OBJECT_LIST_COUNT];
    u32 objects = 0;
    for (u32 i = 0; i < OBJECT_LIST_COUNT; ++i) {
        lists[i] = find_header(find_object, record.lists[i]);
        if (record.lists[i] && !lists[i])
            return 0;
        Tm4ObjectHeader* previous = NULL;
        for (Tm4ObjectHeader* object = lists[i]; object; object = object->next) {
            u32 list = 1;
            while (list < OBJECT_LIST_COUNT && strcmp(object->name, ObjectLists[list].name))
                ++list;
            if (list == OBJECT_LIST_COUNT)
                list = OBJECT_LIST_DEFAULT;
            if (++objects > MaxObjects || list != i || object->previous != previous
                || (u32)object->serial >= record.serial)
                return 0;
            u32 ancestors = 0;
            for (const Tm4ObjectHeader* parent = object; parent->owner;) {
                parent = ObjectGetHeader(parent->owner);
                if (parent == object || ++ancestors > MaxObjects)
                    return 0;
            }
            previous = object;
        }
    }
    input += sizeof(record);
    if (!validate_grid(input, &record, find_object))
        return 0;
    CarAiHealthEntry health[ArrayCount(CarHealthPickups)] = { 0 };
    for (u32 i = 0; i < record.health_count; ++i) {
        const HealthRecord* saved = &record.health[i];
        health[i].object = find_class(find_object, saved->object, "powerup");
        if (!health[i].object)
            return 0;
        health[i].node = saved->node;
        health[i].unknown06 = saved->unknown06;
    }

    CarDetonationNode* devices = NULL;
    CarDetonationNode** tail = &devices;
    for (u32 i = 0; i < record.device_count; ++i) {
        const DeviceRecord* saved = &record.devices[i];
        void* object = saved->object ? find_object(saved->object) : NULL;
        if (!object || saved->car_index < 0 || saved->car_index >= Players
            || saved->weapon_index < 0 || saved->weapon_index >= CarWeaponCount) {
            free_devices(devices);
            return 0;
        }
        CarDetonationNode* node = MemAlloc(sizeof(*node));
        if (!node) {
            free_devices(devices);
            return 0;
        }
        *node = (CarDetonationNode) { .object = object,
            .weapon = &cars[saved->car_index]->weapons[saved->weapon_index] };
        *tail = node;
        tail = &node->next;
    }

    free_devices(CarDetonationDevices);
    CarDetonationDevices = devices;
    CarHealthPickupCount = record.health_count;
    memcpy(CarHealthPickups, health, sizeof(health));
    CarPathSearchGeneration = record.path_generation;
    CarRandomSearchGeneration[0] = record.random_generation;
    CarHealthSearchGeneration = record.health_generation;
    for (u32 i = 0; i < OBJECT_LIST_COUNT; ++i)
        ObjectLists[i].first = lists[i];
    for (u32 i = 0; i < record.squares; ++i) {
        const SquareRecord cell = read_square(input, i);
        WorldSquares[i].display_objects = find_header(find_object, cell.display);
        WorldSquares[i].interaction_objects = find_header(find_object, cell.interaction);
        WorldSquares[i].active_next = cell.active_next ? &WorldSquares[cell.active_next - 1] : NULL;
    }
    ObjectActiveInteractionCells
        = record.active_cells ? &WorldSquares[record.active_cells - 1] : NULL;
    for (u32 i = 0; i < Players; ++i) {
        const PlayerRecord* player = &record.players[i];
        GameInfo.cars[i] = cars[i];
        GameInfo.players[i].car = player_cars[i];
        GameInfo.players[i].camera = cameras[i];
        GameInfo.players[i].lives = player->lives;
        GameInfo.players[i].wins = player->wins;
        GameInfo.players[i].losses = player->losses;
        GameInfo.players[i].eliminated = player->eliminated;
        GameInfo.players[i].camera_distance_preset = player->camera_distance_preset;
        PadJpad[i] = player->input;
    }
    GameInfo.games_completed = record.games_completed;
    GameInfo.deathmatch_winner = record.deathmatch_winner;
    GameInfo.deathmatch_finished = record.deathmatch_finished;
    GameInfo.deathmatch_next_mode = record.deathmatch_next_mode;
    GameInfo.deathmatch_accept_input = record.deathmatch_accept_input;
    GameInfo.deathmatch_rounds = record.deathmatch_rounds;
    RegChangeCurrentDirectoryP(directory);
    ObjectNextSerial = record.serial;
    MainFrameCount = record.tick;
    WebCheckpointGteRestore(record.gte);
    WebCheckpointSetRandomState(record.random, record.effect_random);
    return 1;
}
