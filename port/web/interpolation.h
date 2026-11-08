#ifndef TM4_WEB_INTERPOLATION_H
#define TM4_WEB_INTERPOLATION_H

typedef struct Camera Camera;
typedef struct Car Car;

void WebInterpolationReset(void);
void WebInterpolationBeginStep(void);
void WebInterpolationFinishStep(void);
void WebInterpolationCutCamera(const Camera* camera);
void WebInterpolationCutCar(const Car* car);
void WebInterpolationBeginDraw(double fraction, int stepped);
void WebInterpolationEndDraw(void);
int WebInterpolationEnabled(void);
int WebInterpolationAdvanceDisplay(void);
Camera* WebInterpolationCamera(Camera* camera, Camera* pose);
Car* WebInterpolationCar(Car* car, Car* pose);
void WebInterpolationEndCarDraw(void);
const Car* WebInterpolationCarIdentity(const Car* car);

#endif
