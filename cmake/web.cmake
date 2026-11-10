set(TM4_ROOT "${CMAKE_CURRENT_SOURCE_DIR}")
set(TM4_WEB "${TM4_ROOT}/port/web")
find_program(BUN_EXECUTABLE bun REQUIRED)
set(TM4_GAME_ROOT "${CMAKE_CURRENT_BINARY_DIR}/game")
file(GLOB TM4_GAME_PATCHES CONFIGURE_DEPENDS "${TM4_ROOT}/patches/game/*.patch")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${TM4_ROOT}/tools/prepare/game.js" ${TM4_GAME_PATCHES})
execute_process(COMMAND "${BUN_EXECUTABLE}" "${TM4_ROOT}/tools/prepare/game.js"
    --output "${TM4_GAME_ROOT}" COMMAND_ERROR_IS_FATAL ANY)
add_subdirectory("${TM4_ROOT}/external/psyz/psyz" psyz EXCLUDE_FROM_ALL)

function(tm4_web_configure_target target)
    psyz_web_configure_target(${target} ${ARGN})
    get_target_property(sources ${target} SOURCES)
    list(FILTER sources EXCLUDE REGEX "/web/web_timing[.]c$")
    set_property(TARGET ${target} PROPERTY SOURCES "${sources}")
    target_sources(${target} PRIVATE "${TM4_PSYZ_RUNTIME}/web/web_timing.c")
    if(target STREQUAL "tm4_web")
        get_target_property(options ${target} LINK_OPTIONS)
        list(FILTER options EXCLUDE REGEX "^--shell-file=")
        set_property(TARGET ${target} PROPERTY LINK_OPTIONS "${options}")
        set_target_properties(${target} PROPERTIES OUTPUT_NAME "${target}" SUFFIX ".js")
    endif()
endfunction()
file(GLOB TM4_MENU_SOURCES CONFIGURE_DEPENDS "${TM4_GAME_ROOT}/src/modules/menu/*.c")
file(GLOB TM4_CAR_SOURCES CONFIGURE_DEPENDS "${TM4_GAME_ROOT}/src/modules/car/*.c")
add_library(tm4_core STATIC
    "${TM4_WEB}/memory.c"
    "${TM4_GAME_ROOT}/src/main/registry.c"
    "${TM4_GAME_ROOT}/src/main/image.c"
    "${TM4_GAME_ROOT}/src/main/font.c"
    "${TM4_GAME_ROOT}/src/main/game_state.c"
    "${TM4_GAME_ROOT}/src/main/game.c"
    "${TM4_GAME_ROOT}/src/main/tournament.c"
    "${TM4_GAME_ROOT}/src/main/deathmatch.c"
    "${TM4_GAME_ROOT}/src/main/system.c"
    "${TM4_GAME_ROOT}/src/main/easteregg.c"
    "${TM4_GAME_ROOT}/src/main/loadfiles.c"
    "${TM4_GAME_ROOT}/src/main/loading.c"
    "${TM4_GAME_ROOT}/src/main/screen.c"
    "${TM4_GAME_ROOT}/src/main/sprintf.c"
    "${TM4_GAME_ROOT}/src/main/carresources.c"
    "${TM4_GAME_ROOT}/src/main/world.c"
    "${TM4_GAME_ROOT}/src/main/geometry/geometry.c"
    "${TM4_GAME_ROOT}/src/main/geometry/box.c"
    "${TM4_GAME_ROOT}/src/main/geometry/polyhedron.c"
    "${TM4_GAME_ROOT}/src/main/math3d_native.c"
    "${TM4_GAME_ROOT}/src/main/horizon.c"
    "${TM4_GAME_ROOT}/src/main/pause.c"
    "${TM4_GAME_ROOT}/src/main/render.c"
    "${TM4_GAME_ROOT}/src/main/sync.c"
    "${TM4_GAME_ROOT}/src/main/render_scene.c"
    "${TM4_GAME_ROOT}/src/main/render_layout.c"
    "${TM4_GAME_ROOT}/src/main/object/directory.c"
    "${TM4_GAME_ROOT}/src/main/object/classes.c"
    "${TM4_GAME_ROOT}/src/main/object/data.c"
    "${TM4_GAME_ROOT}/src/main/object/grid.c"
    "${TM4_GAME_ROOT}/src/main/object/interaction.c"
    "${TM4_GAME_ROOT}/src/main/object/list.c"
    "${TM4_GAME_ROOT}/src/main/object/object.c"
    "${TM4_GAME_ROOT}/src/main/sound.c"
    "${TM4_GAME_ROOT}/src/main/redbook.c"
    "${TM4_GAME_ROOT}/src/modules/sound/data.c"
    "${TM4_GAME_ROOT}/src/modules/sound/sound.c"
    "${TM4_GAME_ROOT}/src/modules/camera/camera.c"
    "${TM4_GAME_ROOT}/src/modules/camera/data.c"
    ${TM4_CAR_SOURCES}
    ${TM4_MENU_SOURCES})
target_link_libraries(tm4_core PUBLIC psyz)
set(TM4_GAME_INCLUDE_DIRECTORIES
    "${TM4_ROOT}"
    "${TM4_GAME_ROOT}"
    "${TM4_GAME_ROOT}/include"
    "${TM4_ROOT}/platform/web"
    "${TM4_ROOT}/platform/psyz")
target_include_directories(tm4_core PUBLIC ${TM4_GAME_INCLUDE_DIRECTORIES})
# Keep the pinned dependency untouched; local backend fixes are reviewable patches.
set(TM4_PSYZ_RUNTIME "${CMAKE_CURRENT_BINARY_DIR}/psyz-runtime")
file(GLOB TM4_PSYZ_PATCHES CONFIGURE_DEPENDS "${TM4_ROOT}/port/psyz/patches/*.patch")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${TM4_ROOT}/tools/prepare/psyz.js" ${TM4_PSYZ_PATCHES})
execute_process(COMMAND "${BUN_EXECUTABLE}" "${TM4_ROOT}/tools/prepare/psyz.js"
    --source "${TM4_ROOT}/external/psyz/psyz/src" --output "${TM4_PSYZ_RUNTIME}"
    COMMAND_ERROR_IS_FATAL ANY)
get_target_property(TM4_PSYZ_SOURCES psyz SOURCES)
list(REMOVE_ITEM TM4_PSYZ_SOURCES src/platform/sdl3_gl.c src/psyz/libgpu.c src/psyz/libapi.c src/psyz/libgte.c)
set_property(TARGET psyz PROPERTY SOURCES "${TM4_PSYZ_SOURCES}")
target_sources(psyz PRIVATE "${TM4_PSYZ_RUNTIME}/platform/sdl3_gl.c"
    "${TM4_PSYZ_RUNTIME}/psyz/libgpu.c"
    "${TM4_PSYZ_RUNTIME}/psyz/libapi.c" "${TM4_PSYZ_RUNTIME}/psyz/libgte.c")
target_include_directories(psyz PRIVATE "${TM4_ROOT}/port/psyz")
set(TM4_SDK_ALIASES "${CMAKE_CURRENT_BINARY_DIR}/sdk-includes")
file(GLOB TM4_PSYZ_HEADERS CONFIGURE_DEPENDS "${TM4_ROOT}/external/psyz/psyz/include/*.h")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${TM4_ROOT}/tools/prepare/includes.js")
execute_process(
    COMMAND "${BUN_EXECUTABLE}" "${TM4_ROOT}/tools/prepare/includes.js"
        --sdk "${TM4_ROOT}/external/psyz/psyz/include" --output "${TM4_SDK_ALIASES}"
    COMMAND_ERROR_IS_FATAL ANY)
target_include_directories(tm4_core SYSTEM BEFORE PUBLIC
    "${TM4_SDK_ALIASES}" "${TM4_ROOT}/external/psyz/psyz/include")
# Both SDK spellings are intentional; macOS also resolves lowercase to uppercase aliases.
target_compile_options(tm4_core PUBLIC -Wno-nonportable-include-path)
target_compile_options(tm4_core PRIVATE -Wno-error=incompatible-pointer-types -include "${TM4_WEB}/../psyz/sdk.h" -funsigned-char -fwrapv -fno-strict-aliasing -sUSE_ZLIB=1)
# Overlay import slots were private to each loaded PS1 image.
function(tm4_add_overlay name)
    string(MAKE_C_IDENTIFIER "${name}" symbol_prefix)
    if(ARGN)
        set(sources)
        foreach(file IN LISTS ARGN)
            list(APPEND sources "${TM4_GAME_ROOT}/src/modules/${name}/${file}.c")
        endforeach()
    else()
        file(GLOB sources CONFIGURE_DEPENDS "${TM4_GAME_ROOT}/src/modules/${name}/*.c")
    endif()
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${sources})
    set(bindings)
    foreach(source IN LISTS sources)
        file(READ "${source}" text)
        string(REGEX MATCHALL "(Text[A-Z][A-Za-z0-9_]*|Import_[A-Za-z0-9_]+|ImportName_[A-Za-z0-9_]+|use_OSRegister[A-Za-z0-9_]+|OSRegister[A-Za-z0-9_]+)" names "${text}")
        foreach(symbol IN LISTS names)
            list(APPEND bindings "${symbol}=Web_${symbol_prefix}_${symbol}")
        endforeach()
    endforeach()
    if(name MATCHES "^cars/c_(slam|trash|crush)$")
        # Resource keys were private to each original overlay image.
        foreach(symbol DamageKey SlamsKey ActiveSlamsKey MaximumAngleKey ShovelPointKey
                UpVelocityKey DownVelocityKey KillMessage LargeCollisionSound SoundClassName
                SmallCollisionSound SpecialLoopName ShovelGroupName)
            list(APPEND bindings "${symbol}=Web_${symbol_prefix}_${symbol}")
        endforeach()
    endif()
    if(name MATCHES "^cars/c_(tank|minion|crush)$")
        foreach(symbol TreadPixelsKey ResolutionDirectoryName FaceListKey GroupsDirectoryName
                LeftTreadName RightTreadName LeftTreadCount RightTreadCount LeftTreadFaces
                RightTreadFaces TreadTexturePixels TreadPolysClassConstructor TreadPolysClassDestructor
                TreadPolysConstructor TreadPolysDestructor TreadPolysProcess TreadPolysAnimate)
            list(APPEND bindings "${symbol}=Web_${symbol_prefix}_${symbol}")
        endforeach()
    endif()
    list(REMOVE_DUPLICATES bindings)
    if(EXISTS "${TM4_WEB}/overlays/${name}.c")
        list(APPEND sources "${TM4_WEB}/overlays/${name}.c")
    endif()
    set_source_files_properties(${sources} PROPERTIES COMPILE_DEFINITIONS "${bindings}")
    target_sources(tm4_core PRIVATE ${sources})
endfunction()
target_sources(tm4_core PRIVATE "${TM4_GAME_ROOT}/src/main/card.c")
set_source_files_properties("${TM4_GAME_ROOT}/src/main/card.c" PROPERTIES COMPILE_DEFINITIONS "TM4_CARD_FUNCTION=0x80039AE8")
set_source_files_properties("${TM4_GAME_ROOT}/src/main/sprintf.c" PROPERTIES COMPILE_DEFINITIONS "TM4_SPRINTF_FUNCTION=0x80034674")
tm4_add_overlay(weap)
tm4_add_overlay(carprt)
tm4_add_overlay(afc)
tm4_add_overlay(power)
tm4_add_overlay(timer)
tm4_add_overlay(bullet)
tm4_add_overlay(ray)
tm4_add_overlay(fire)
tm4_add_overlay(firing)
tm4_add_overlay(lightn)
tm4_add_overlay(light)
tm4_add_overlay(tele)
tm4_add_overlay(jumppad)
tm4_add_overlay(conveyer)
tm4_add_overlay(jumbo)
tm4_add_overlay(destry)
tm4_add_overlay(frag)
tm4_add_overlay(anim)
tm4_add_overlay(cars/c_pirate)
tm4_add_overlay(cars/auger)
tm4_add_overlay(cars/c_toy)
tm4_add_overlay(cars/c_stooth)
tm4_add_overlay(cars/c_tank)
tm4_add_overlay(cars/c_minion)
tm4_add_overlay(cars/c_slam)
tm4_add_overlay(cars/c_trash)
tm4_add_overlay(cars/c_crush)
tm4_add_overlay(expl)
tm4_add_overlay(interact data imports collision interact damage fragments)
tm4_add_overlay(levels/w_yard)
# Native levels share pathing.c and its registry key instead of separate image copies.
tm4_add_overlay(levels/w_neon beam collision data game_data imports state train ufo)
tm4_add_overlay(levels/w_carni coaster collision data game_data imports state)
tm4_add_overlay(levels/w_oil data game_data helicopter imports state)
target_sources(tm4_core PRIVATE "${TM4_GAME_ROOT}/src/modules/levels/pathing.c")
target_sources(tm4_core PRIVATE "${TM4_GAME_ROOT}/src/main/card_animation.c"
    "${TM4_GAME_ROOT}/src/main/registry_helpers.c")

add_executable(tm4_web
    "${TM4_WEB}/bootstrap.c"
    "${TM4_WEB}/cheats.c"
    "${TM4_WEB}/loading.c"
    "${TM4_WEB}/sqrt.c"
    "${TM4_WEB}/render_sync.c"
    "${TM4_WEB}/interpolation.c"
    "${TM4_WEB}/subpixel.c"
    "${TM4_WEB}/level.c"
    "${TM4_WEB}/net_match.c"
    "${TM4_WEB}/checkpoint.c"
    "${TM4_WEB}/net_state.c"
    "${TM4_WEB}/net_state_cars.c"
    "${TM4_WEB}/net_state_objects.c"
    "${TM4_WEB}/car.c"
    "${TM4_WEB}/menu_runtime.c"
    "${TM4_WEB}/car_exports.c"
    "${TM4_WEB}/native_modules.c"
    "${TM4_WEB}/music.c"
    "${TM4_WEB}/movie.c"
    "${TM4_WEB}/../psyz/cd.c"
    "${TM4_WEB}/../psyz/pad.c"
    "${TM4_WEB}/../psyz/pad_vibration.c"
    "${TM4_WEB}/../psyz/card.c"
    "${TM4_WEB}/../psyz/spu.c"
    "${TM4_WEB}/../psyz/gpu.c"
    "${TM4_WEB}/../psyz/math.c"
    "${TM4_WEB}/../psyz/kernel.c")
target_compile_definitions(tm4_web PRIVATE TM4_WEB_SUBPIXEL=1)
option(TM4_WEB_TEST_HOOKS "Expose browser integration-test entry points" OFF)
if(TM4_WEB_TEST_HOOKS)
    target_sources(tm4_web PRIVATE "${TM4_WEB}/test_hooks.c")
    target_compile_definitions(tm4_web PRIVATE TM4_WEB_TEST_HOOKS=1)
endif()
target_link_libraries(tm4_web PRIVATE tm4_core psyz)
target_link_options(tm4_web PRIVATE -sUSE_ZLIB=1 -sASSERTIONS=1 -Wl,--error-limit=0
    -sPTHREAD_POOL_SIZE=2 -sINITIAL_MEMORY=67108864 "-sEXPORTED_FUNCTIONS=_main,_malloc" "-sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall")
tm4_web_configure_target(tm4_web OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site")
target_compile_definitions(tm4_web PRIVATE TM4_WEB_CONTROLS=1)
psyz_title(tm4_web "TM4 Rewired")

foreach(symbol SquareRoot0 Psyz_CdPullSamples InitCARD StartCARD StopCARD _card_status _card_read _card_write Draw_PushPrim)
    target_link_options(tm4_web PRIVATE "-Wl,--wrap=${symbol}")
endforeach()

include("${TM4_ROOT}/cmake/native-exports.cmake")

set_source_files_properties("${TM4_GAME_ROOT}/src/main/redbook.c" PROPERTIES COMPILE_DEFINITIONS
    "CdGetToc=WebMusicGetToc;CdControl=WebMusicControl;CdControlB=WebMusicControlB;CdReadyCallback=WebMusicReadyCallback")

# Small asset-free test using the actual WebGL backend and VRAM readback.
add_executable(tm4_gpu_mask_check EXCLUDE_FROM_ALL "${TM4_ROOT}/tests/native/check_gpu_mask.c")
target_include_directories(tm4_gpu_mask_check PRIVATE "${TM4_ROOT}")
target_link_libraries(tm4_gpu_mask_check PRIVATE psyz)
target_link_options(tm4_gpu_mask_check PRIVATE -sASSERTIONS=1 -sPTHREAD_POOL_SIZE=2)
tm4_web_configure_target(tm4_gpu_mask_check
    OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site/gpu-mask-check")

add_executable(tm4_display_check EXCLUDE_FROM_ALL "${TM4_ROOT}/tests/native/check_display.c")
target_link_libraries(tm4_display_check PRIVATE psyz)
target_link_options(tm4_display_check PRIVATE -sASSERTIONS=1 -sPTHREAD_POOL_SIZE=2)
tm4_web_configure_target(tm4_display_check
    OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site/display-check")

# Exact-size vertex allocations exercise partial RTPT batches under ASAN.
add_executable(tm4_gte_batches_check EXCLUDE_FROM_ALL "${TM4_ROOT}/tests/native/check_gte_batches.c")
target_include_directories(tm4_gte_batches_check PRIVATE ${TM4_GAME_INCLUDE_DIRECTORIES})
target_link_libraries(tm4_gte_batches_check PRIVATE psyz)
target_link_options(tm4_gte_batches_check PRIVATE -sASSERTIONS=1 -sPTHREAD_POOL_SIZE=2)
tm4_web_configure_target(tm4_gte_batches_check
    OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site/gte-batches-check")
