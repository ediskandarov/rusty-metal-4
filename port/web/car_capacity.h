#ifndef TM4_WEB_CAR_CAPACITY_H
#define TM4_WEB_CAR_CAPACITY_H

#ifndef TM4_EXPERIMENTAL_EXTENDED_VRAM
#define TM4_EXPERIMENTAL_EXTENDED_VRAM 0
#endif

/* Storage limits are independent of the eight network participant seats. */
enum {
    TM4_MAX_ENTRANTS = 10,
    TM4_MAX_LIVE_CARS = 10,
    TM4_CAR_ATLAS_COUNT = TM4_EXPERIMENTAL_EXTENDED_VRAM ? 10 : 8,
};

#endif
