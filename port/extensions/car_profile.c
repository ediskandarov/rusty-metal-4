#include "car_profile.h"
#include <stdio.h>
#include <string.h>

static void invalid(Rm4CarProfileReader* reader, char* key)
{
    fprintf(stderr, "Invalid car profile field: %s\n", key);
    reader->valid = 0;
}
char* WebCarProfileString(Rm4CarProfileReader* reader, char* key, int required)
{
    if (!reader->valid || !reader->resource)
        return NULL;
    RegistryDirectory* profile = reader->resource;
    if (RegGetDirectoryPtrPS(profile, key)) {
        invalid(reader, key);
        return NULL;
    }
    RegistryFile* file = RegGetFilePtrPS(profile, key);
    if (!file) {
        if (required)
            invalid(reader, key);
        return NULL;
    }
    char* text = RegGetFileDataP(file);
    u32 size = RegGetFileByteSizeP(file);
    if (RegGetFileTypeP(file) != REG_FILE_TYPE_STRING || !text || size < 2 || !text[0]
        || !memchr(text, 0, size)) {
        invalid(reader, key);
        return NULL;
    }
    return text;
}
Rm4CarProfileReader WebCarProfileOpen(char* binding)
{
    Rm4CarProfileReader reader = { NULL, 1 };
    if (RegGetFilePtrS(binding)) {
        invalid(&reader, binding);
        return reader;
    }
    reader.resource = RegGetDirectoryPtrS(binding);
    if (!reader.resource)
        return reader;
    char* path = WebCarProfileString(&reader, "profile", 1);
    if (!path || path[0] != '/' || !(reader.resource = RegGetDirectoryPtrS(path))) {
        invalid(&reader, binding);
        reader.resource = NULL;
    }
    return reader;
}
s32 WebCarProfileNumber(Rm4CarProfileReader* reader, char* key, s32 fallback, s32 min, s32 max)
{
    if (!reader->valid || !reader->resource)
        return fallback;
    RegistryDirectory* profile = reader->resource;
    if (RegGetDirectoryPtrPS(profile, key)) {
        invalid(reader, key);
        return fallback;
    }
    RegistryFile* file = RegGetFilePtrPS(profile, key);
    if (!file)
        return fallback;
    if (RegGetFileTypeP(file) != REG_FILE_TYPE_LONG || RegGetFileByteSizeP(file) != 4
        || RegGetFileArraySizeP(file) != 1 || !RegGetFileDataP(file)) {
        invalid(reader, key);
        return fallback;
    }
    s32 value = *(s32*)RegGetFileDataP(file);
    if (value < min || value > max) {
        invalid(reader, key);
        return fallback;
    }
    return value;
}
