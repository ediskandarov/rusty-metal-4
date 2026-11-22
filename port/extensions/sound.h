#ifndef RM4_SOUND_H
#define RM4_SOUND_H

/* Optional soundEmitter constructor flag. Use the snapshotted effect RNG for
   pitch variation without advancing gameplay randomness. Not stored in emitters. */
enum { RM4_SOUND_EFFECT_RANDOM = 1u << 5 };

#endif
