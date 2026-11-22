# Sound sample banks

The sound loader fills the original SPU RAM from address `0x1010`. When a sample
no longer fits, `port/game/sound_samples.c` allocates another 512 KiB bank. Subsequent
samples share its remaining space. Maps and cars keep using ordinary VAB resources;
mods do not choose banks or manage their memory.

Each sample retains its bank and byte address. Program attributes use 16-bit sample
IDs; `0xffff` is the failed-upload sentinel. Individual samples must fit one bank,
contain at least 16 bytes and have the original eight-byte size alignment.

Psyz's existing ADPCM decoder, interpolation and envelopes are unchanged. Key-on
consumes a one-shot bank selection for that voice; an ordinary SDK key-on defaults
to SPU RAM. Banks increase available sample storage, not the 24 simultaneous voices.

Banks belong to the loaded sound resources, not individual emitters. Sound teardown
first stops bank-backed voices and clears pending selections under the audio lock,
then frees all extra banks and resets the upload cursor. Bank pointers never enter
snapshots. Rollback uses the existing sound-emitter identities and playback ledger;
it does not allocate or reload sample banks.
