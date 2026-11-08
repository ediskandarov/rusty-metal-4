#include "loading.h"
#include "tm4/main/cd.h"
#include "tm4/main/image.h"
#include "tm4/main/loading.h"
#include "tm4/main/memory.h"
#include "tm4/main/system.h"
#include <emscripten.h>
#include <libetc.h>
#include <libgpu.h>
#include <stdio.h>
#include <stdlib.h>

/* MAIN supplies a TIM at (320, 0); the recovered loading UI copies it to the display. */
void WebLoadingBackground(const char* filename)
{
    void* image = CDLoadFile((char*)filename, NULL);
    if (!image) {
        fprintf(stderr, "Missing loading background: %s\n", filename);
        abort();
    }
    DrawSync(0);
    ClearVram(0, 0, 1024, 512, 0, 0, 0);
    LoadTIM(image);
    MemFree(image);
    LoadingInitializeDisplay();
    SetDispMask(1);
    EM_ASM(
        {
            tm4Port.screen = 'loading';
            tm4Port.loadingBackground = UTF8ToString($0);
            if (!tm4Port.loadingHistory)
                tm4Port.loadingHistory = [];
            tm4Port.loadingHistory.push(tm4Port.loadingBackground);
        },
        filename);
    // Present the copied background before resource loading replaces the display.
    DrawSync(0);
    VSync(0);
}
