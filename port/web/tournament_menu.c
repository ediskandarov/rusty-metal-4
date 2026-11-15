#include "tournament_menu.h"
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
    if (MenuReadPadButtons(MenuPadPort, PADRup, MENU_PAD_PRESSED, 0)) {
        confirmed_car = NULL;
        ++selection_revision;
    } else if (MenuReadPadButtons(MenuPadPort, PADRdown, MENU_PAD_PRESSED, 0)) {
        int index = MenuFindCarByDirectoryName(MenuGameState.character_names[0]);
        if (index >= 0) {
            confirmed_car = MenuGameState.character_names[0];
            ++selection_revision;
        }
    }
}

static void process_car(void)
{
    if (!confirmed_car)
        MenuProcessPlayerCarChooseCarChoice();
}

/* Keep the native preview/selection path, but never enter its local-game transition. */
void WebTournamentMenuOpen(void)
{
    if (active)
        return;
    saved_screen = MenuScreenPlayerCar;
    saved_choice = MenuScreenPlayerCar.choices[0];
    active = 1;
    confirmed_car = NULL;
    ++selection_revision;
    MenuGameState.game_type = GAME_TYPE_TOURNAMENT;
    MenuGameState.resume_tournament = 0;
    MenuGameState.player_count = 1;
    MenuGameState.ally_count = 0;
    MenuGameState.extra_player_count = 0;
    MenuGameState.next_mode = 0;
    MenuCurrentPlayer = 0;
    MenuPadPort = MenuSavedPadPort = 0;
    MenuResetPlayerCarSelections();
    MenuScreenPlayerCar.count = 1;
    MenuScreenPlayerCar.selected = 0;
    MenuScreenPlayerCar.parent = NULL;
    MenuScreenPlayerCar.process = process_selection;
    MenuScreenPlayerCar.choices[0].next = NULL;
    MenuScreenPlayerCar.choices[0].process = process_car;
    MenuScreenPlayerCar.choices[0].hints = &MenuChangeBackDoneHints;
    MenuSwitchScreen(&MenuScreenPlayerCar, 0);
}

void WebTournamentMenuClose(void)
{
    if (!active)
        return;
    MenuScreenPlayerCar = saved_screen;
    MenuScreenPlayerCar.choices[0] = saved_choice;
    active = 0;
    confirmed_car = NULL;
}

int WebTournamentMenuActive(void)
{
    return active;
}

EMSCRIPTEN_KEEPALIVE const char* WebTournamentSelectedCar(void)
{
    return confirmed_car;
}

EMSCRIPTEN_KEEPALIVE unsigned int WebTournamentSelectionRevision(void)
{
    return selection_revision;
}
