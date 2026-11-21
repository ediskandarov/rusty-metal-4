#include "port/web/subpixel.h"
#include "tm4/gpu.h"
#include "tm4/gte.h"
#include "tm4/main/render.h"
#include <stdlib.h>
#include <string.h>

struct Tm4HorizonResource {
    u8 gouraud_count, flat_count, textured_count, reserved03;
    CVECTOR color;
};

/* Horizon records carry four buffer/view packet slots after their vertices. */
typedef struct Tm4HorizonTexturedRecord {
    SVECTOR vertices[4];
    POLY_FT4 packets[4];
    u_long reservedc0;
} Tm4HorizonTexturedRecord;

typedef struct Tm4HorizonGouraudRecord {
    SVECTOR vertices[4];
    POLY_G4 packets[4];
} Tm4HorizonGouraudRecord;

typedef struct Tm4HorizonFlatRecord {
    SVECTOR vertices[4];
    POLY_F4 packets[4];
} Tm4HorizonFlatRecord;

static Tm4HorizonTexturedRecord* RenderHorizonTexturedRecords;
static Tm4HorizonGouraudRecord* RenderHorizonGouraudRecords;
static Tm4HorizonFlatRecord* RenderHorizonFlatRecords;
static Tm4HorizonResource horizon_header;
static Tm4HorizonResource* RenderHorizon = &horizon_header;

/* The file has four-byte PS1 tags; PsyZ keeps length and address separately. */
static const u8* read_packets(void* output, size_t packet_size, const u8* input)
{
    u8* destination = output;
    size_t payload_size = packet_size - sizeof(Tm4OrderingTag);
    for (int i = 0; i < 4; ++i) {
        setlen(destination, input[3]);
        termPrim(destination);
        memcpy(destination + sizeof(Tm4OrderingTag), input + 4, payload_size);
        input += payload_size + 4;
        destination += packet_size;
    }
    return input;
}

void RenderSetHorizon(Tm4HorizonResource* configuration)
{
    free(RenderHorizonGouraudRecords);
    free(RenderHorizonFlatRecords);
    free(RenderHorizonTexturedRecords);
    horizon_header = configuration ? *configuration : (Tm4HorizonResource) { 0 };
    const u8* cursor = configuration ? (const u8*)(configuration + 1) : NULL;
    RenderHorizonGouraudRecords
        = calloc(horizon_header.gouraud_count, sizeof(*RenderHorizonGouraudRecords));
    RenderHorizonFlatRecords = calloc(horizon_header.flat_count, sizeof(*RenderHorizonFlatRecords));
    RenderHorizonTexturedRecords
        = calloc(horizon_header.textured_count, sizeof(*RenderHorizonTexturedRecords));
    if ((horizon_header.gouraud_count && !RenderHorizonGouraudRecords)
        || (horizon_header.flat_count && !RenderHorizonFlatRecords)
        || (horizon_header.textured_count && !RenderHorizonTexturedRecords))
        abort();
    for (int i = 0; i < horizon_header.gouraud_count; ++i) {
        Tm4HorizonGouraudRecord* record = &RenderHorizonGouraudRecords[i];
        memcpy(record->vertices, cursor, sizeof(record->vertices));
        cursor = read_packets(
            record->packets, sizeof(record->packets[0]), cursor + sizeof(record->vertices));
    }
    for (int i = 0; i < horizon_header.flat_count; ++i) {
        Tm4HorizonFlatRecord* record = &RenderHorizonFlatRecords[i];
        memcpy(record->vertices, cursor, sizeof(record->vertices));
        cursor = read_packets(
            record->packets, sizeof(record->packets[0]), cursor + sizeof(record->vertices));
    }
    for (int i = 0; i < horizon_header.textured_count; ++i) {
        Tm4HorizonTexturedRecord* record = &RenderHorizonTexturedRecords[i];
        memcpy(record->vertices, cursor, sizeof(record->vertices));
        cursor = read_packets(
                     record->packets, sizeof(record->packets[0]), cursor + sizeof(record->vertices))
            + 4;
    }
}

void RenderGetBackgroundColor(u8* first, u8* second, u8* third)
{
    if (RenderHorizon->color.r || RenderHorizon->color.g || RenderHorizon->color.b) {
        *first = RenderHorizon->color.r;
        *second = RenderHorizon->color.g;
        *third = RenderHorizon->color.b;
    } else {
        *first = 50;
        *second = 54;
        *third = 55;
    }
}

static void record_horizon_packet(const void* packet, const SVECTOR vertices[4])
{
    const SVECTOR* corners[4] = { &vertices[0], &vertices[1], &vertices[2], &vertices[3] };
    WebSubpixelPacketQuad(packet, corners);
}

void RenderDrawHorizon(Tm4OrderingTag* ordering_table, MATRIX* world_to_camera, u8 buffer)
{
    MATRIX zero_translation;
    Tm4HorizonTexturedRecord* textured;
    Tm4HorizonGouraudRecord* gouraud;
    Tm4HorizonFlatRecord* flat;
    s32 i;
    register long ordering_depth;
    long first_screen_area;
    long second_screen_area;

    PushMatrix();
    zero_translation.t[0] = 0;
    zero_translation.t[1] = 0;
    zero_translation.t[2] = 0;
    SetTransMatrix(&zero_translation);
    for (textured = RenderHorizonTexturedRecords, i = 0; i < RenderHorizon->textured_count;
         ++i, ++textured) {
        POLY_FT4* packet = &textured->packets[buffer];
        gte_ldv3c(textured->vertices);
        gte_rtpt();
        GteAverageDepth3();
        gte_stsxy0(&packet->x0);
        gte_stsxy1(&packet->x1);
        gte_stsxy2(&packet->x2);
        GteReadDepth(ordering_depth);
        GteClip();
        GteReadClipArea(first_screen_area);
        gte_ldv0(&textured->vertices[3]);
        gte_rtps();
        GteClip();
        GteReadClipArea(second_screen_area);
        if ((second_screen_area <= 0 || first_screen_area > 0) && ordering_depth > 0) {
            gte_stsxy(&packet->x3);
            record_horizon_packet(packet, textured->vertices);
            addPrim(ordering_table, packet);
        }
    }
    if (world_to_camera->m[2][1] >= -3199) {
        for (gouraud = RenderHorizonGouraudRecords, i = 0; i < RenderHorizon->gouraud_count;
             ++i, ++gouraud) {
            POLY_G4* packet = &gouraud->packets[buffer];
            gte_ldv3c(gouraud->vertices);
            gte_rtpt();
            GteAverageDepth3();
            gte_stsxy0(&packet->x0);
            gte_stsxy1(&packet->x1);
            gte_stsxy2(&packet->x2);
            GteReadDepth(ordering_depth);
            GteClip();
            GteReadClipArea(first_screen_area);
            gte_ldv0(&gouraud->vertices[3]);
            gte_rtps();
            GteClip();
            GteReadClipArea(second_screen_area);
            if ((second_screen_area <= 0 || first_screen_area > 0) && ordering_depth > 0) {
                gte_stsxy(&packet->x3);
                record_horizon_packet(packet, gouraud->vertices);
                addPrim(ordering_table, packet);
            }
        }
    }
    for (flat = RenderHorizonFlatRecords, i = 0; i < RenderHorizon->flat_count; ++i, ++flat) {
        POLY_F4* packet = &flat->packets[buffer];
        gte_ldv3c(flat->vertices);
        gte_rtpt();
        GteAverageDepth3();
        gte_stsxy0(&packet->x0);
        gte_stsxy1(&packet->x1);
        gte_stsxy2(&packet->x2);
        GteReadDepth(ordering_depth);
        GteClip();
        GteReadClipArea(first_screen_area);
        gte_ldv0(&flat->vertices[3]);
        gte_rtps();
        GteClip();
        GteReadClipArea(second_screen_area);
        if ((second_screen_area <= 0 || first_screen_area > 0) && ordering_depth > 0) {
            gte_stsxy(&packet->x3);
            record_horizon_packet(packet, flat->vertices);
            addPrim(ordering_table, packet);
        }
    }
    PopMatrix();
}
