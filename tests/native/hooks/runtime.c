#include "port/web/overlays.h"
#include "src/main/object/private.h"
#include "tm4/main/geometry.h"
#include "tm4/main/math3d.h"
#include <emscripten.h>

EMSCRIPTEN_KEEPALIVE void WebTestInspectObjectCallbacks(void)
{
    EM_ASM({ tm4Port.testObjectCallbacks = []; });
    for (s32 i = 0; i < ObjectClassCount; ++i) {
        Tm4ObjectClass* object_class = &ObjectClasses[i];
        EM_ASM(
            {
                const name = UTF8ToString($0);
                const kinds = ([
                    'constructor', 'instance_constructor', 'process', 'display', 'destructor'
                ]);
                const pointers = ([ $1, $2, $3, $4, $5 ]);
                for (let index = 0; index < pointers.length; ++index) {
                    const pointer = pointers[index];
                    if (pointer)
                        tm4Port.testObjectCallbacks.push({
                            name : name,
                            kind : kinds[index],
                            pointer : pointer,
                            target : __indirect_function_table.get(pointer)
                        });
                }
            },
            object_class->name, object_class->constructor, object_class->instance_constructor,
            object_class->process, object_class->display, object_class->destructor);
        for (s32 j = 0; j <= i; ++j) {
            Tm4ObjectInteractionCallback callback
                = ObjectInteractionPairs[i * (i + 1) / 2 + j].callback;
            if (!callback)
                continue;
            EM_ASM(
                {
                    tm4Port.testObjectCallbacks.push({
                        name : UTF8ToString($0) + '/' + UTF8ToString($1),
                        kind : 'interaction',
                        pointer : $2,
                        target : __indirect_function_table.get($2)
                    });
                },
                object_class->name, ObjectClasses[j].name, callback);
        }
    }
    for (s32 list = 0; list < OBJECT_LIST_COUNT; ++list) {
        for (Tm4ObjectHeader* object = ObjectLists[list].first; object; object = object->next) {
            EM_ASM(
                {
                    const name = UTF8ToString($0) + '#' + $1;
                    const kinds = ([ 'process', 'display', 'destructor', 'interaction' ]);
                    const pointers = ([ $2, $3, $4, $5 ]);
                    for (let index = 0; index < pointers.length; ++index) {
                        const pointer = pointers[index];
                        if (pointer)
                            tm4Port.testObjectCallbacks.push({
                                name : name,
                                kind : kinds[index],
                                pointer : pointer,
                                target : __indirect_function_table.get(pointer)
                            });
                    }
                },
                object->name, object->serial, object->process, object->display, object->destructor,
                object->interact);
        }
    }
}

EMSCRIPTEN_KEEPALIVE void WebTestReadNativeModules(void)
{
    EM_ASM(
        {
            tm4Port.nativeModules = ({
                car : !!$0,
                menu : !!$1,
                crusher : !!$2,
                auger : !!$3,
                augerConstructor : !!$4,
                weapon : !!$5,
                weaponConstructor : !!$6
            });
        },
        WebNativeModuleLoaded("o_car.sym"), WebNativeModuleLoaded("menu.sym"),
        WebNativeModuleLoaded("c_crush.sym"), WebNativeModuleLoaded("c_auger.sym"),
        OSSymbolGetAddress("CarAugerClassConstructor"), WebNativeModuleLoaded("o_weap.sym"),
        OSSymbolGetAddress("WeaponClassConstructor"));
}

EMSCRIPTEN_KEEPALIVE long WebTestSquareRoot0(long value)
{
    return SquareRoot0(value);
}

EMSCRIPTEN_KEEPALIVE u32 WebTestSquareRootInt32(u32 value)
{
    return SquareRootInt32(value);
}

EMSCRIPTEN_KEEPALIVE u32 WebTestSquareRoot64Shifted(u32 high, u32 low, s32 shift)
{
    return SquareRoot64Shifted(high, low, shift);
}
