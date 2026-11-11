#ifndef TM4_WEB_BROWSER_REPORT_H
#define TM4_WEB_BROWSER_REPORT_H
#include <emscripten.h>

/* Outgoing browser diagnostics/UI publications only: no inputs, C memory writes,
 * resource delivery or required host results. The standalone C API reads state directly. */
#ifdef TM4_STANDALONE
#define WEB_BROWSER_REPORT(...) ((void)0)
#else
#define WEB_BROWSER_REPORT EM_ASM
#endif
#endif
