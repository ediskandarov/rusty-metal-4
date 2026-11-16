#include "tournament_menu.h"
#include "port/web/module_import.h"
#include "src/modules/menu/private.h"
#include "tm4/main/game.h"
#include <emscripten.h>
#include <libetc.h>

static int active;
static char* confirmed_car;
static unsigned int selection_revision;
static MenuScreenEntry saved_screen;
static MenuChoiceRecord saved_choice;

static void process_selection(void)
{
    if (WEB_MODULE("menu", MenuReadPadButtons)(
            WEB_MODULE("menu", MenuPadPort), PADRup, MENU_PAD_PRESSED, 0)) {
        confirmed_car = NULL;
        ++selection_revision;
    } else if (WEB_MODULE("menu", MenuReadPadButtons)(
                   WEB_MODULE("menu", MenuPadPort), PADRdown, MENU_PAD_PRESSED, 0)) {
        int index = WEB_MODULE("menu", MenuFindCarByDirectoryName)(
            WEB_MODULE("menu", MenuGameState).character_names[0]);
        if (index >= 0) {
            confirmed_car = WEB_MODULE("menu", MenuGameState).character_names[0];
            ++selection_revision;
        }
    }
}

static void process_car(void)
{
    if (!confirmed_car)
        WEB_MODULE("menu", MenuProcessPlayerCarChooseCarChoice)();
}

/* Keep the native preview/selection path, but never enter its local-game transition. */
void WebTournamentMenuOpen(void)
{
    if (active)
        return;
    saved_screen = WEB_MODULE("menu", MenuScreenPlayerCar);
    saved_choice = WEB_MODULE("menu", MenuScreenPlayerCar).choices[0];
    active = 1;
    confirmed_car = NULL;
    ++selection_revision;
    WEB_MODULE("menu", MenuGameState).game_type = GAME_TYPE_TOURNAMENT;
    WEB_MODULE("menu", MenuGameState).resume_tournament = 0;
    WEB_MODULE("menu", MenuGameState).player_count = 1;
    WEB_MODULE("menu", MenuGameState).ally_count = 0;
    WEB_MODULE("menu", MenuGameState).extra_player_count = 0;
    WEB_MODULE("menu", MenuGameState).next_mode = 0;
    WEB_MODULE("menu", MenuCurrentPlayer) = 0;
    WEB_MODULE("menu", MenuPadPort) = WEB_MODULE("menu", MenuSavedPadPort) = 0;
    WEB_MODULE("menu", MenuResetPlayerCarSelections)();
    WEB_MODULE("menu", MenuScreenPlayerCar).count = 1;
    WEB_MODULE("menu", MenuScreenPlayerCar).selected = 0;
    WEB_MODULE("menu", MenuScreenPlayerCar).parent = NULL;
    WEB_MODULE("menu", MenuScreenPlayerCar).process = process_selection;
    WEB_MODULE("menu", MenuScreenPlayerCar).choices[0].next = NULL;
    WEB_MODULE("menu", MenuScreenPlayerCar).choices[0].process = process_car;
    WEB_MODULE("menu", MenuScreenPlayerCar).choices[0].hints
        = &WEB_MODULE("menu", MenuChangeBackDoneHints);
    WEB_MODULE("menu", MenuSwitchScreen)(&WEB_MODULE("menu", MenuScreenPlayerCar), 0);
}

void WebTournamentMenuClose(void)
{
    if (!active)
        return;
    WEB_MODULE("menu", MenuScreenPlayerCar) = saved_screen;
    WEB_MODULE("menu", MenuScreenPlayerCar).choices[0] = saved_choice;
    active = 0;
    confirmed_car = NULL;
}

int WebTournamentMenuActive(void) { return active; }

EMSCRIPTEN_KEEPALIVE const char* WebTournamentSelectedCar(void) { return confirmed_car; }

EMSCRIPTEN_KEEPALIVE unsigned int WebTournamentSelectionRevision(void)
{
    return selection_revision;
}
