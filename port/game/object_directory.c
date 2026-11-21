#include "tm4/main/object.h"
#include "tm4/main/registry.h"
#include <ctype.h>
#include <string.h>

void ObjectVisitDirectory(char* prefix, RegistryDirectory* directory, Tm4DirectoryVisitor visitor)
{
    s32 child_count = RegGetNumberOfDirectoriesP(directory);
    s32 i;
    for (i = 0; i < child_count; i++) {
        char* name = RegGetDirectoryNamePN(directory, i);
        if (name != NULL) {
            s32 path_length = strlen(prefix) + strlen(name) + 1;
            char path[path_length];
            RegistryDirectory* child;
            s32 uppercase_initial;
            strcpy(path, prefix);
            strcat(path, name);
            uppercase_initial = toupper(path[strlen(prefix)]);
            path[strlen(prefix)] = uppercase_initial;
            child = RegGetDirectoryPtrPN(directory, i);
            if (child == NULL)
                continue;
            if (visitor == NULL || visitor(path, child))
                ObjectVisitDirectory(path, child, visitor);
        }
    }
}

s32 ObjectDirectoryRecurse(Tm4DirectoryVisitor visitor)
{
    RegistryDirectory* directory = RegGetDirectoryPtrS("/objects");
    if (!directory)
        return 0;
    ObjectVisitDirectory("", directory, visitor);
    return 1;
}
