#ifndef TM4_MODULE_IMPORT_H
#define TM4_MODULE_IMPORT_H
#include "tm4/main/os.h"

typedef struct {
    const char* module;
    const char* symbol;
    u32 generation;
    OSWord address;
} WebModuleImport;

OSWord WebResolveModuleImport(WebModuleImport* binding);

/* Keep the declaration's exact C type. A reload invalidates cached addresses. */
#define WEB_MODULE(module, symbol)                                                                 \
    (*(__typeof__(&symbol))({                                                                      \
        static WebModuleImport binding = { module, #symbol, 0, 0 };                                \
        WebResolveModuleImport(&binding);                                                          \
    }))
#endif
