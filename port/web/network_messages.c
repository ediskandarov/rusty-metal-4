#include "network_messages.h"
#include "checkpoint.h"
#include "net_match.h"
#include "tm4/main/sprintf.h"
#include <emscripten.h>
#include <string.h>

static struct {
    u32 tick;
    WebScreenMessageQueue queue;
} history[2 * WebCheckpointHistoryTicks + 1];
static WebScreenMessageQueue* predicted;
static WebScreenMessageQueue* confirmed_view;
static s32 message_limit;

void WebScreenMessagesReset(WebScreenMessageQueue* visible, s32 limit)
{
    memset(history, 0, sizeof(history));
    predicted = NULL;
    confirmed_view = visible;
    message_limit = limit;
}

void WebScreenBeginPredictedTick(u32 tick)
{
    size_t index = tick % ArrayCount(history);
    history[index].tick = tick;
    history[index].queue.count = 0;
    predicted = &history[index].queue;
}

void WebScreenFinishPredictedTick(void)
{
    predicted = NULL;
}

static void append_message(WebScreenMessageQueue* queue)
{
    if (queue->count == message_limit) {
        for (s32 i = 1; i < queue->count; ++i)
            strcpy(queue->messages[i - 1], queue->messages[i]);
        --queue->count;
        queue->timer = 60;
    } else if (!queue->count) {
        queue->timer = 60;
    }
}

void WebScreenMessageRegisterV(
    WebScreenMessageQueue* visible, const char* format, va_list arguments)
{
    WebScreenMessageQueue* queue = visible;
    if (WebNetRenderedPrediction()) {
        queue = predicted;
        if (!queue)
            return;
    }
    append_message(queue);
    FormatStringV(queue->messages[queue->count], format, arguments);
    ++queue->count;
}

EMSCRIPTEN_KEEPALIVE int WebNetConfirmPresentationTick(u32 tick)
{
    if (!WebNetRenderedPrediction() || !tick || WebNetReplaying())
        return 0;
    size_t index = tick % ArrayCount(history);
    if (history[index].tick != tick)
        return 0;
    history[index].tick = 0;
    WebScreenMessageQueue* confirmed = &history[index].queue;
    for (s32 i = 0; i < confirmed->count; ++i) {
        append_message(confirmed_view);
        strcpy(confirmed_view->messages[confirmed_view->count++], confirmed->messages[i]);
    }
    return confirmed->count;
}
