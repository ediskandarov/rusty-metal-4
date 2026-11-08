#ifndef TM4_WEB_MOVIE_H
#define TM4_WEB_MOVIE_H
int WebMovieActive(void);
void WebMovieStart(const char* name, int allow_skip, void (*finished)(void));
void WebMovieFrame(void);
void WebMovieEnding(void (*finished)(void));
#ifdef TM4_WEB_TEST_HOOKS
void WebTestStartPendingMovie(void);
#endif
#endif
