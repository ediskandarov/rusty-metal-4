/* Run with WASM ASAN: teardown may free a target before its attacker's destructor. */
#include "src/modules/car/private.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

Tm4GameInfo GameInfo;

int main(void)
{
    Car attacker = { 0 }, first = { 0 }, second = { 0 };
    s32 attacker_damage[4];
    attacker.ai.attacker_damage = attacker_damage;
    GameInfo.entrant_count = ArrayCount(attacker_damage);
    GameInfo.car_count = 2;
    GameInfo.cars[0] = &first;
    GameInfo.cars[1] = &second;
    first.ai.selected_node = 17;
    second.ai.selected_node = 23;
    second.ai.targeting_count = 8;
    memset(attacker_damage, 0x55, sizeof(attacker_damage));

    CarAiSetTarget(&attacker, &first, NULL);
    assert(attacker.ai.target == &first && first.ai.targeting_count == 1);
    assert(attacker.ai.target_previous_node == 17);
    for (int i = 0; i < GameInfo.entrant_count; ++i)
        assert(attacker.ai.attacker_damage[i] == 0);

    CarAiSetTarget(&attacker, &second, NULL);
    assert(first.ai.targeting_count == 0 && second.ai.targeting_count == 9);
    assert(attacker.ai.target_previous_node == 23);
    CarAiSetTarget(&attacker, &second, NULL);
    assert(second.ai.targeting_count == 9);
    CarAiSetTarget(&attacker, NULL, NULL);
    assert(second.ai.targeting_count == 8);
    assert(!attacker.ai.target && attacker.ai.target_previous_node == CAR_AI_NO_NODE);

    Car* destroyed = calloc(1, sizeof(*destroyed));
    assert(destroyed);
    GameInfo.cars[GameInfo.car_count++] = destroyed;
    CarAiSetTarget(&attacker, destroyed, NULL);
    assert(destroyed->ai.targeting_count == 1);
    /* Remove registration before releasing storage, as CarDestructor does. */
    GameInfo.cars[--GameInfo.car_count] = NULL;
    free(destroyed);
    CarAiSetTarget(&attacker, &second, NULL);
    assert(attacker.ai.target == &second && second.ai.targeting_count == 9);
    CarAiSetTarget(&attacker, NULL, NULL);
    assert(second.ai.targeting_count == 8);
    puts("PASS AI target counts and cleanup after target destruction");
    return 0;
}
