#ifndef WEB_MODULE_IMAGE_H
#define WEB_MODULE_IMAGE_H
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* rm4.module is a Wasm custom section containing the stable registry image
 * name. */
static int module_leb(const uint8_t** cursor, const uint8_t* end, uint32_t* value)
{
    *value = 0;
    for (unsigned shift = 0; shift < 35 && *cursor < end; shift += 7) {
        uint8_t byte = *(*cursor)++;
        if (shift == 28 && byte > 15)
            return 0;
        *value |= (uint32_t)(byte & 127) << shift;
        if (!(byte & 128))
            return 1;
    }
    return 0;
}
static int WebModuleImageName(const void* data, size_t size, char name[128])
{
    const uint8_t* cursor = data;
    const uint8_t* end = cursor + size;
    int found = 0;
    if (size < 8 || memcmp(cursor, "\0asm\1\0\0\0", 8))
        return 0;
    cursor += 8;
    while (cursor < end) {
        uint8_t id = *cursor++;
        uint32_t length, key_length;
        if (!module_leb(&cursor, end, &length) || length > (size_t)(end - cursor))
            return 0;
        const uint8_t* next = cursor + length;
        if (!id) {
            if (!module_leb(&cursor, next, &key_length) || key_length > (size_t)(next - cursor))
                return 0;
            if (key_length == 10 && !memcmp(cursor, "rm4.module", 10)) {
                cursor += key_length;
                size_t count = next - cursor;
                if (found || count < 5 || count > 124 || memcmp(next - 4, ".sym", 4))
                    return 0;
                for (size_t i = 0; i < count - 4; ++i)
                    if (!((cursor[i] >= 'a' && cursor[i] <= 'z')
                            || (i && ((cursor[i] >= '0' && cursor[i] <= '9') || cursor[i] == '_'))))
                        return 0;
                memcpy(name, cursor, count);
                name[count] = 0;
                found = 1;
            }
        }
        cursor = next;
    }
    return found;
}
#endif
