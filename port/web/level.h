#ifndef TM4_WEB_LEVEL_H
#define TM4_WEB_LEVEL_H
void WebLoadArchiveAt(const char* path, char* registration, char* destination);
void WebLoadArchive(const char* path, char* registration);
void WebReturnToMenu(void);
void WebLeaveMenu(void);
void WebLevelStart(void);
void WebLevelFrame(void);
void WebLevelNetworkStep(void);
void WebLevelStop(void);
int WebLevelActive(void);
int WebLevelCheckpointActive(void);
#endif
