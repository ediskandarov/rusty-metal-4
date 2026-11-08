/* Original menu reads raw PS1 memory-card sectors. PsyZ's file-level card API
 * does not supply them; keep one real 128 KiB image in browser storage. */
#include <emscripten.h>
#include <libapi.h>
#include <string.h>

static unsigned char image[1024 * 128];
static int initialized, started, dirty;

EM_JS(int, load_card, (unsigned char* data, int size), {
    try {
        const saved = localStorage.getItem('tm4.memory-card.0');
        if (!saved)
            return 0;
        const bytes = atob(saved);
        if (bytes.length != size)
            return 0;
        for (let i = 0; i < size; ++i)
            HEAPU8[data + i] = bytes.charCodeAt(i);
        return 1;
    } catch (error) {
        console.warn('Memory card storage unavailable:', error);
        return 0;
    }
});

EM_JS(void, save_card, (const unsigned char* data, int size), {
    try {
        let bytes = '';
        for (let i = 0; i < size; i += 8192)
            bytes += String.fromCharCode(
                ... HEAPU8.subarray(data + i, data + Math.min(size, i + 8192)));
        localStorage.setItem('tm4.memory-card.0', btoa(bytes));
    } catch (error) {
        console.warn('Cannot persist memory card:', error);
    }
});

void __wrap_InitCARD(long value)
{
    if (initialized)
        return;
    initialized = 1;
    if (load_card(image, sizeof(image)))
        return;
    memset(image, 0, sizeof(image));
    image[0] = 'M';
    image[1] = 'C';
    image[127] = 'M' ^ 'C';
    memcpy(image + 63 * 128, image, 128);
    for (int sector = 1; sector <= 15; ++sector) {
        unsigned char* frame = image + sector * 128;
        frame[0] = 0xa0;
        frame[8] = frame[9] = 0xff;
        frame[127] = 0xa0;
    }
    for (int sector = 16; sector <= 35; ++sector) {
        unsigned char* frame = image + sector * 128;
        memset(frame, 0xff, 4);
        frame[8] = frame[9] = 0xff;
    }
}
long __wrap_StartCARD(void)
{
    started = 1;
    return 1;
}
long __wrap_StopCARD(void)
{
    started = 0;
    return 1;
}
long __wrap__card_status(long drive)
{
    return started && drive == 0 ? 1 : 3;
}
long __wrap__card_read(long channel, long sector, unsigned char* output)
{
    if (!started || channel || sector < 0 || sector >= 1024)
        return 0;
    memcpy(output, image + sector * 128, 128);
    return 1;
}
long __wrap__card_write(long channel, long sector, unsigned char* input)
{
    if (!started || channel || sector < 0 || sector >= 1024)
        return 0;
    memcpy(image + sector * 128, input, 128);
    dirty = 1;
    return 1;
}
void WebCardFlush(void)
{
    if (dirty) {
        save_card(image, sizeof(image));
        dirty = 0;
    }
}
