/* Exercise the production queue in Wasm without loading game assets. */
#include "port/web/checkpoint.h"
#include "port/web/net_match.h"
#include "port/web/network_messages.h"
#include "tm4/main/sprintf.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static int predicting, replaying;

int WebNetRenderedPrediction(void) { return predicting; }
int WebNetReplaying(void) { return replaying; }
s32 FormatStringV(char* output, const char* format, va_list arguments)
{
    return vsprintf(output, format, arguments);
}

static void message(WebScreenMessageQueue* queue, const char* format, ...)
{
    va_list arguments;
    va_start(arguments, format);
    WebScreenMessageRegisterV(queue, format, arguments);
    va_end(arguments);
}

int main(void)
{
    WebScreenMessageQueue visible = { 0 }, other = { 0 };
    WebScreenMessagesReset(&visible, 3);
    message(&visible, "first %d", 1);
    assert(visible.count == 1 && visible.timer == 60);
    visible.timer = 17;
    message(&visible, "second");
    message(&visible, "third");
    assert(visible.timer == 17);
    message(&visible, "fourth");
    assert(visible.count == 3 && visible.timer == 60);
    assert(!strcmp(visible.messages[0], "second"));
    assert(!strcmp(visible.messages[2], "fourth"));
    message(&other, "other player");
    assert(other.count == 1 && visible.count == 3);

    visible.count = 0;
    WebScreenMessagesReset(&visible, 3);
    predicting = 1;
    message(&visible, "outside tick");
    assert(visible.count == 0);
    WebScreenBeginPredictedTick(10);
    message(&visible, "discarded prediction");
    WebScreenFinishPredictedTick();
    assert(visible.count == 0);

    /* Replaying a tick replaces its pending messages; replay never publishes. */
    replaying = 1;
    WebScreenBeginPredictedTick(10);
    message(&visible, "corrected %d", 10);
    WebScreenFinishPredictedTick();
    assert(WebNetConfirmPresentationTick(10) == 0 && visible.count == 0);
    replaying = 0;
    assert(WebNetConfirmPresentationTick(10) == 1);
    assert(!strcmp(visible.messages[0], "corrected 10"));
    assert(WebNetConfirmPresentationTick(10) == 0 && visible.count == 1);
    message(&visible, "after tick");
    assert(visible.count == 1);

    /* A replay with no messages also cancels the previous prediction. */
    WebScreenBeginPredictedTick(11);
    message(&visible, "will disappear");
    WebScreenFinishPredictedTick();
    WebScreenBeginPredictedTick(11);
    WebScreenFinishPredictedTick();
    assert(WebNetConfirmPresentationTick(11) == 0 && visible.count == 1);

    WebScreenBeginPredictedTick(12);
    message(&visible, "one");
    message(&visible, "two");
    message(&visible, "three");
    message(&visible, "four");
    WebScreenFinishPredictedTick();
    assert(WebNetConfirmPresentationTick(12) == 3);
    assert(visible.count == 3 && !strcmp(visible.messages[0], "two"));
    assert(!strcmp(visible.messages[2], "four"));

    /* Reused ring slots cannot publish messages under an old tick number. */
    WebScreenBeginPredictedTick(20);
    message(&visible, "expired");
    WebScreenFinishPredictedTick();
    u32 wrapped = 20 + 2 * WebCheckpointHistoryTicks + 1;
    WebScreenBeginPredictedTick(wrapped);
    message(&visible, "current");
    WebScreenFinishPredictedTick();
    assert(WebNetConfirmPresentationTick(20) == 0);
    predicting = 0;
    assert(WebNetConfirmPresentationTick(wrapped) == 0);
    predicting = 1;
    assert(WebNetConfirmPresentationTick(wrapped) == 1);
    assert(!strcmp(visible.messages[2], "current"));
    assert(WebNetConfirmPresentationTick(0) == 0);

    /* A new screen discards history and the active tick and rebinds delivery. */
    WebScreenBeginPredictedTick(50);
    message(&visible, "previous match");
    other.count = 0;
    WebScreenMessagesReset(&other, 1);
    message(&other, "no active tick");
    assert(other.count == 0 && WebNetConfirmPresentationTick(50) == 0);
    WebScreenBeginPredictedTick(51);
    message(&other, "first");
    message(&other, "last");
    WebScreenFinishPredictedTick();
    assert(WebNetConfirmPresentationTick(51) == 1);
    assert(other.count == 1 && !strcmp(other.messages[0], "last"));
    assert(!strcmp(visible.messages[2], "current"));
    predicting = 0;
    message(&other, "offline again");
    assert(other.count == 1 && other.timer == 60);
    assert(!strcmp(other.messages[0], "offline again"));
    puts("PASS: network messages, rollback, confirmation, history and screen reset");
    return 0;
}
