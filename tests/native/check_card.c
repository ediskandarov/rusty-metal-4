/* Run in WASM/Node. InitCARD restarts the driver, not the virtual card image. */
#include <assert.h>
#include <emscripten.h>
#include <libapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void WebCardFlush(void);

int main(int argc, char** argv)
{
    int storage_available = argc > 1 ? atoi(argv[1]) : 0;
    EM_ASM(
        {
        globalThis.cardStorage = ({ available : !!$0, saved : null, writes : 0 });
            globalThis.localStorage = ({
                getItem(key) {
                    if (!cardStorage.available)
                        throw new Error('Storage disabled for this test');
                    return cardStorage.saved;
                },
                setItem(key, value) {
        if (!cardStorage.available)
            throw new Error('Storage disabled for this test');
        cardStorage.saved = value;
        cardStorage.writes++;
                }
});
},
        storage_available);
unsigned char before[128], after[128];
for (int i = 0; i < sizeof(before); ++i)
    before[i] = i ^ 0x5a;
InitCARD(0);
assert(StartCARD());
assert(_card_status(0) == 1);
assert(_card_read(0, 0, after));
assert(after[0] == 'M' && after[1] == 'C');
assert(_card_write(0, 64, before));
WebCardFlush();
assert(EM_ASM_INT({ return cardStorage.writes; }) == storage_available);
assert(StopCARD());
assert(!_card_read(0, 64, after));
InitCARD(0);
assert(StartCARD());
assert(_card_read(0, 64, after));
assert(!memcmp(before, after, sizeof(before)));
before[4]++;
assert(_card_write(0, 64, before));
/* Restart before flushing: an older persistent snapshot must not replace RAM. */
assert(StopCARD());
InitCARD(0);
assert(StartCARD());
assert(_card_read(0, 64, after));
assert(!memcmp(before, after, sizeof(before)));
WebCardFlush();
if (storage_available) {
    assert(EM_ASM_INT({ return cardStorage.writes; }) == 2);
    assert(EM_ASM_INT({ return atob(cardStorage.saved).length; }) == 128 * 1024);
}
assert(!_card_read(0, 1024, after));
assert(!_card_write(1, 64, before));
printf("PASS memory card restarts preserve session data (persistent storage: %d)\n",
    storage_available);
return 0;
}
