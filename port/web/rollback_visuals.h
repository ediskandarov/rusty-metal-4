#ifndef TM4_WEB_ROLLBACK_VISUALS_H
#define TM4_WEB_ROLLBACK_VISUALS_H

#include <LIBGTE.H>
typedef struct Car Car;
typedef struct Camera Camera;

void WebRollbackVisualsReset(void);
void WebRollbackVisualsRemember(double now);
void WebRollbackVisualsReconcile(double now);
void WebRollbackVisualsCut(const void* object);
int WebRollbackVisualsCar(const Car* car, MATRIX* draw, double now);
int WebRollbackVisualsCamera(const Camera* camera, MATRIX* draw, double now);

#endif
