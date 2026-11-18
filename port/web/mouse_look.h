#ifndef TM4_WEB_MOUSE_LOOK_H
#define TM4_WEB_MOUSE_LOOK_H

typedef struct Camera Camera;
typedef struct Tm4GamePlayer Tm4GamePlayer;

Camera* WebMouseLookCamera(const Tm4GamePlayer* player, Camera* camera, Camera* pose);
void WebMouseLookReset(void);

#endif
