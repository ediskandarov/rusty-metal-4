#ifndef TM4_WEB_STACK_H
#define TM4_WEB_STACK_H
#include "tm4_scalar.h"
#include <LIBETC.H>
#include <emscripten/stack.h>
#define SCRATCHPAD_STACK_TOP_WORD_OFFSET 0xFC
#define SCRATCHPAD_STACK_THRESHOLD_BYTES 192
#define SCRATCHPAD_ADDRESS_MASK 0x1F000000u
#define StackIsScratchpad(stack) 0
#define StackScratchpadBelowThreshold(stack) 0
#define StackGetPointer(stack) ((stack) = (__typeof__(stack))emscripten_stack_get_current())
/* Scratch stack switching is a PS1 optimization; native calls keep the WASM stack. */
#define StackSetPointer(stack) ((void)(stack))
#define StackEnterScratchpad(saved) StackGetPointer(saved)
#define StackLeaveScratchpad(saved) ((void)(saved))
#endif
