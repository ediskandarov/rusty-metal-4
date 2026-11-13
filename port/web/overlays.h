#ifndef TM4_WEB_OVERLAYS_H
#define TM4_WEB_OVERLAYS_H
#include "tm4/main/os.h"
void WebNativeModulesInitialize(void);
int WebNativeModuleLoaded(const char* image_name);
OSWord WebNativeExport(const char* name);
OSWord WebNativeModuleExport(const char* module, const char* name);
OSWord WebWeaponExport(const char* name);
OSWord WebInteractExport(const char* name);
OSWord WebCarpartExport(const char* name);
OSWord WebAfcExport(const char* name);
OSWord WebPowerExport(const char* name);
OSWord WebTimerExport(const char* name);
OSWord WebBulletExport(const char* name);
OSWord WebRayExport(const char* name);
OSWord WebFireExport(const char* name);
OSWord WebDestroyableExport(const char* name);
OSWord WebFragmentExport(const char* name);
OSWord WebTeleporterExport(const char* name);
OSWord WebJumppadExport(const char* name);
OSWord WebLightExport(const char* name);
OSWord WebLightningExport(const char* name);
OSWord WebFireRingExport(const char* name);
OSWord WebAnimExport(const char* name);
OSWord WebExplExport(const char* name);
OSWord WebPirateExport(const char* name);
OSWord WebAugerExport(const char* name);
void WebInteractCarWithPowerup(void* car, void* powerup);
OSWord WebYardExport(const char* name);
#endif

OSWord WebNeonExport(const char* name);

OSWord WebCarnivalExport(const char* name);
OSWord WebOilExport(const char* name);
