#ifndef TM4_WEB_MUSIC_H
#define TM4_WEB_MUSIC_H
#include <libcd.h>
void WebMusicInitialize(void);
void WebMusicMovieMode(int enabled);
unsigned int WebMusicMovieSamples(int* ended);
int WebMusicGetToc(CdlLOC* toc);
int WebMusicControl(u_char command, u_char* parameter, u_char* result);
int WebMusicControlB(u_char command, u_char* parameter, u_char* result);
CdlCB WebMusicReadyCallback(CdlCB callback);
#endif
