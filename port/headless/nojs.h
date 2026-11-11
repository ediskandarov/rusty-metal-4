#ifndef TM4_HEADLESS_NOJS_H
#define TM4_HEADLESS_NOJS_H
#include <emscripten.h>
#include <emscripten/eventloop.h>
#include <stdlib.h>

_Noreturn void WebHeadlessRequireHost(const char* operation, const char* file, int line);
#undef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE
/* Only explicitly marked WEB_BROWSER_REPORT calls may be omitted. Any other
 * JavaScript interaction is a missing capability, including value-returning reads. */
#undef EM_ASM
#undef EM_ASM_INT
#undef EM_ASM_PTR
#undef EM_ASM_DOUBLE
#undef MAIN_THREAD_EM_ASM
#undef MAIN_THREAD_EM_ASM_INT
#undef MAIN_THREAD_EM_ASM_PTR
#undef MAIN_THREAD_EM_ASM_DOUBLE
#undef MAIN_THREAD_ASYNC_EM_ASM
#undef EM_ASM_
#undef EM_ASM_ARGS
#undef EM_ASM_INT_V
#undef EM_ASM_DOUBLE_V
#undef EM_JS
#undef EM_ASYNC_JS
#define EM_ASM(...) WebHeadlessRequireHost("EM_ASM", __FILE__, __LINE__)
#define EM_ASM_INT(...) (WebHeadlessRequireHost("EM_ASM_INT", __FILE__, __LINE__), 0)
#define EM_ASM_PTR(...) (WebHeadlessRequireHost("EM_ASM_PTR", __FILE__, __LINE__), (void*)0)
#define EM_ASM_DOUBLE(...) (WebHeadlessRequireHost("EM_ASM_DOUBLE", __FILE__, __LINE__), 0.0)
#define MAIN_THREAD_EM_ASM(...) EM_ASM(__VA_ARGS__)
#define MAIN_THREAD_EM_ASM_INT(...) EM_ASM_INT(__VA_ARGS__)
#define MAIN_THREAD_EM_ASM_PTR(...) EM_ASM_PTR(__VA_ARGS__)
#define MAIN_THREAD_EM_ASM_DOUBLE(...) EM_ASM_DOUBLE(__VA_ARGS__)
#define MAIN_THREAD_ASYNC_EM_ASM(...) EM_ASM(__VA_ARGS__)
#define EM_ASM_(...) EM_ASM_INT(__VA_ARGS__)
#define EM_ASM_ARGS(...) EM_ASM_INT(__VA_ARGS__)
#define EM_ASM_INT_V(...) EM_ASM_INT(__VA_ARGS__)
#define EM_ASM_DOUBLE_V(...) EM_ASM_DOUBLE(__VA_ARGS__)
#define EM_JS(result, name, args, ...)                                                             \
    result name args                                                                               \
    {                                                                                              \
        WebHeadlessRequireHost(#name, __FILE__, __LINE__);                                         \
    }
#define EM_ASYNC_JS(result, name, args, ...) EM_JS(result, name, args, __VA_ARGS__)
#endif
