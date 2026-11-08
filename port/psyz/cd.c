/* The original CD-facing API reads the browser's preloaded asset filesystem.
 * Locations retain their original disc sectors; they are never host pointers. */
#include "tm4/main/cd.h"
#include "tm4/main/memory.h"
#include <ctype.h>
#include <stdio.h>
#include <string.h>

static char current_directory[256] = "/DATA";
static char directories[16][256];
static unsigned directory_depth;

static int resolve_path(const char* name, char output[256])
{
    char joined[512];
    int length;
    if (!name)
        return 0;
    if (*name == '/' || *name == '\\')
        length = snprintf(joined, sizeof(joined), "%s", name);
    else
        length = snprintf(joined, sizeof(joined), "%s/%s", current_directory, name);
    if (length < 0 || length >= (int)sizeof(joined))
        return 0;
    unsigned used = 0;
    output[0] = 0;
    char* segment = joined;
    while (*segment) {
        while (*segment == '/' || *segment == '\\')
            segment++;
        char* end = segment;
        while (*end && *end != '/' && *end != '\\' && *end != ';')
            end++;
        unsigned count = end - segment;
        if (count == 2 && segment[0] == '.' && segment[1] == '.') {
            while (used && output[used - 1] != '/')
                used--;
            if (used)
                used--;
        } else if (count && !(count == 1 && *segment == '.')) {
            if (used + count + 1 >= 256)
                return 0;
            output[used++] = '/';
            for (unsigned i = 0; i < count; i++)
                output[used++] = toupper((unsigned char)segment[i]);
        }
        output[used] = 0;
        if (*end == ';')
            break;
        segment = end;
    }
    if (!used)
        strcpy(output, "/");
    return 1;
}

static int entry_for(const char* file, unsigned* sector, unsigned* size)
{
    char path[256], entry[256];
    if (!resolve_path(file, path))
        return 0;
    FILE* manifest = fopen("/DATA/files.tsv", "r");
    if (!manifest)
        return 0;
    unsigned lba, bytes;
    while (fscanf(manifest, "%u\t%u\t%255s", &lba, &bytes, entry) == 3) {
        if (!strcmp(entry, path)) {
            *sector = lba;
            *size = bytes;
            fclose(manifest);
            return 1;
        }
    }
    fclose(manifest);
    return 0;
}

static unsigned bcd(unsigned x)
{
    return (x / 10) * 16 + x % 10;
}
static unsigned unbcd(unsigned x)
{
    return (x >> 4) * 10 + (x & 15);
}

void CDInitialize(void)
{
    strcpy(current_directory, "/DATA");
    directory_depth = 0;
}
void CDSetCurrentDirectory(char* path)
{
    char resolved[256];
    if (resolve_path(path, resolved))
        strcpy(current_directory, resolved);
}
s32 CDPushDirectory(void)
{
    if (directory_depth == 16)
        return 0;
    strcpy(directories[directory_depth++], current_directory);
    return 1;
}
s32 CDPopDirectory(void)
{
    if (!directory_depth)
        return 0;
    strcpy(current_directory, directories[--directory_depth]);
    return 1;
}
s32 CDFileGetSizeAndLoc(const char* file, CdlLOC* location)
{
    unsigned sector, size;
    if (!entry_for(file, &sector, &size))
        return 0;
    sector += 150;
    if (location) {
        location->minute = bcd(sector / 4500);
        location->second = bcd(sector / 75 % 60);
        location->sector = bcd(sector % 75);
        location->track = 0;
    }
    return size;
}
s32 CDFileGetSize(const char* file)
{
    return CDFileGetSizeAndLoc(file, NULL);
}
s32 CDFileGetLoc(const char* file, CdlLOC* location)
{
    return CDFileGetSizeAndLoc(file, location) != 0;
}
s32 CDFileExists(const char* file)
{
    return CDFileGetSize(file) != 0;
}

static void* read_path(const char* path, u32 size, void* buffer, CDProgressCallback callback)
{
    FILE* file = fopen(path, "rb");
    if (!file)
        return NULL;
    int allocated = buffer == NULL;
    if (allocated)
        buffer = MemAlloc(size);
    if (!buffer) {
        fclose(file);
        return NULL;
    }
    if (callback)
        callback(0);
    if (fread(buffer, 1, size, file) != size) {
        fclose(file);
        if (allocated)
            MemFree(buffer);
        return NULL;
    }
    fclose(file);
    if (callback)
        callback(4096);
    return buffer;
}
void* CDLoadFile(char* name, CDProgressCallback callback)
{
    char path[256];
    s32 size = CDFileGetSize(name);
    if (size <= 0 || !resolve_path(name, path))
        return NULL;
    return read_path(path, size, NULL, callback);
}
void CDLoadFileNoAllocate(const char* name, void* buffer, CDProgressCallback callback)
{
    char path[256];
    s32 size = CDFileGetSize(name);
    if (buffer && size > 0 && resolve_path(name, path))
        read_path(path, size, buffer, callback);
}
void* CDLoadFileLocSize(
    const CdlLOC* location, u32 size, const void* file_context, CDProgressCallback callback)
{
    unsigned target = (unbcd(location->minute) * 60 + unbcd(location->second)) * 75
        + unbcd(location->sector) - 150;
    unsigned lba, bytes;
    char path[256];
    FILE* manifest = fopen("/DATA/files.tsv", "r");
    if (!manifest)
        return NULL;
    while (fscanf(manifest, "%u\t%u\t%255s", &lba, &bytes, path) == 3) {
        if (lba == target && size <= bytes) {
            fclose(manifest);
            return read_path(path, size, NULL, callback);
        }
    }
    fclose(manifest);
    return NULL;
}
/* All preloaded reads complete synchronously; there is no outstanding transfer. */
void CDLoadFileAsyncBreak(void)
{
}
