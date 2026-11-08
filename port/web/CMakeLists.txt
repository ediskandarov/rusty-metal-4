cmake_minimum_required(VERSION 3.21)
project(tm4_web C CXX)
if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with emcmake cmake; this port currently targets wasm32.")
endif()
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_EXTENSIONS ON)
add_compile_options(-pthread -ffunction-sections -fdata-sections)
add_link_options(-pthread)
set(SDL_PTHREADS ON CACHE BOOL "Enable PsyZ kernel synchronisation" FORCE)
get_filename_component(TM4_ROOT "../.." ABSOLUTE BASE_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
find_package(Python3 REQUIRED COMPONENTS Interpreter)
set(TM4_GAME_ROOT "${CMAKE_CURRENT_BINARY_DIR}/game")
file(GLOB TM4_GAME_PATCHES CONFIGURE_DEPENDS "${TM4_ROOT}/patches/game/*.patch")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${TM4_ROOT}/tools/prepare_game.py" ${TM4_GAME_PATCHES})
execute_process(COMMAND "${Python3_EXECUTABLE}" "${TM4_ROOT}/tools/prepare_game.py"
    --output "${TM4_GAME_ROOT}" COMMAND_ERROR_IS_FATAL ANY)
add_subdirectory("${TM4_ROOT}/external/psyz/psyz" psyz EXCLUDE_FROM_ALL)

function(tm4_web_configure_target target)
    psyz_web_configure_target(${target} ${ARGN})
    get_target_property(sources ${target} SOURCES)
    list(FILTER sources EXCLUDE REGEX "/web/web_timing[.]c$")
    set_property(TARGET ${target} PROPERTY SOURCES "${sources}")
    target_sources(${target} PRIVATE "${TM4_PSYZ_RUNTIME}/web/web_timing.c")
    get_target_property(options ${target} LINK_OPTIONS)
    list(FILTER options EXCLUDE REGEX "^--shell-file=")
    set_property(TARGET ${target} PROPERTY LINK_OPTIONS "${options}")
    target_link_options(${target} PRIVATE "--shell-file=${CMAKE_CURRENT_SOURCE_DIR}/shell.html")
    set_property(TARGET ${target} APPEND PROPERTY LINK_DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/shell.html")
endfunction()
file(GLOB TM4_MENU_SOURCES CONFIGURE_DEPENDS "${TM4_GAME_ROOT}/src/modules/menu/*.c")
file(GLOB TM4_CAR_SOURCES CONFIGURE_DEPENDS "${TM4_GAME_ROOT}/src/modules/car/*.c")
add_library(tm4_core STATIC
    "${CMAKE_CURRENT_SOURCE_DIR}/memory.c"
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
    "${TM4_ROOT}/port/psyz/prepare_runtime.py" ${TM4_PSYZ_PATCHES})
execute_process(COMMAND "${Python3_EXECUTABLE}" "${TM4_ROOT}/port/psyz/prepare_runtime.py"
    --source "${TM4_ROOT}/external/psyz/psyz/src" --output "${TM4_PSYZ_RUNTIME}"
    COMMAND_ERROR_IS_FATAL ANY)
get_target_property(TM4_PSYZ_SOURCES psyz SOURCES)
list(REMOVE_ITEM TM4_PSYZ_SOURCES src/platform/sdl3_gl.c src/psyz/libgpu.c)
set_property(TARGET psyz PROPERTY SOURCES "${TM4_PSYZ_SOURCES}")
target_sources(psyz PRIVATE "${TM4_PSYZ_RUNTIME}/platform/sdl3_gl.c"
    "${TM4_PSYZ_RUNTIME}/psyz/libgpu.c")
target_include_directories(psyz PRIVATE "${TM4_ROOT}/port/psyz")
set(TM4_SDK_ALIASES "${CMAKE_CURRENT_BINARY_DIR}/sdk-includes")
file(GLOB TM4_PSYZ_HEADERS CONFIGURE_DEPENDS "${TM4_ROOT}/external/psyz/psyz/include/*.h")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${TM4_ROOT}/port/psyz/prepare_includes.py")
execute_process(
    COMMAND "${Python3_EXECUTABLE}" "${TM4_ROOT}/port/psyz/prepare_includes.py"
        --sdk "${TM4_ROOT}/external/psyz/psyz/include" --output "${TM4_SDK_ALIASES}"
    COMMAND_ERROR_IS_FATAL ANY)
target_include_directories(tm4_core SYSTEM BEFORE PUBLIC
    "${TM4_SDK_ALIASES}" "${TM4_ROOT}/external/psyz/psyz/include")
# Both SDK spellings are intentional; macOS also resolves lowercase to uppercase aliases.
target_compile_options(tm4_core PUBLIC -Wno-nonportable-include-path)
target_compile_options(tm4_core PRIVATE -Wno-error=incompatible-pointer-types -include "${CMAKE_CURRENT_SOURCE_DIR}/../psyz/sdk.h" -funsigned-char -fwrapv -fno-strict-aliasing -sUSE_ZLIB=1)
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
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/overlays/${name}.c")
        list(APPEND sources "${CMAKE_CURRENT_SOURCE_DIR}/overlays/${name}.c")
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

add_executable(tm4_web bootstrap.c cheats.c loading.c sqrt.c render_sync.c interpolation.c subpixel.c level.c car.c menu_runtime.c car_exports.c native_modules.c music.c movie.c ../psyz/cd.c ../psyz/pad.c ../psyz/pad_vibration.c ../psyz/card.c ../psyz/spu.c ../psyz/gpu.c ../psyz/math.c ../psyz/kernel.c)
target_compile_definitions(tm4_web PRIVATE TM4_WEB_SUBPIXEL=1)
option(TM4_WEB_TEST_HOOKS "Expose browser integration-test entry points" OFF)
if(TM4_WEB_TEST_HOOKS)
    target_sources(tm4_web PRIVATE test_hooks.c)
    target_compile_definitions(tm4_web PRIVATE TM4_WEB_TEST_HOOKS=1)
endif()
target_link_libraries(tm4_web PRIVATE tm4_core psyz)
target_link_options(tm4_web PRIVATE -sUSE_ZLIB=1 -sASSERTIONS=1 -Wl,--error-limit=0
    -sPTHREAD_POOL_SIZE=2 -sINITIAL_MEMORY=67108864 "-sEXPORTED_FUNCTIONS=_main,_malloc")
set(TM4_DISC_TRACK "${TM4_ROOT}/disks/Twisted Metal 4/Twisted Metal 4 (Track 01).bin"
    CACHE FILEPATH "Original data track")
set(TM4_ASSET_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/assets/DATA")
set(TM4_ASSET_MANIFEST "${TM4_ASSET_DIRECTORY}/files.tsv")
add_custom_command(OUTPUT "${TM4_ASSET_MANIFEST}"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/prepare_assets.py"
        --track "${TM4_DISC_TRACK}" --output-directory "${TM4_ASSET_DIRECTORY}"
    DEPENDS "${TM4_DISC_TRACK}" "${CMAKE_CURRENT_SOURCE_DIR}/prepare_assets.py"
        "${TM4_GAME_ROOT}/tools/overlay_resources.py" VERBATIM)
add_custom_target(tm4_assets DEPENDS "${TM4_ASSET_MANIFEST}")
add_dependencies(tm4_web tm4_assets)
target_link_options(tm4_web PRIVATE "--preload-file=${TM4_ASSET_DIRECTORY}@/DATA")
set_property(TARGET tm4_web APPEND PROPERTY LINK_DEPENDS "${TM4_ASSET_MANIFEST}")
tm4_web_configure_target(tm4_web OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site")
target_compile_definitions(tm4_web PRIVATE TM4_WEB_CONTROLS=1)
# Keep settings assets next to the game shell in the served directory.
foreach(asset controls.css controls.js)
    configure_file("${CMAKE_CURRENT_SOURCE_DIR}/${asset}" "${CMAKE_CURRENT_BINARY_DIR}/site/${asset}" COPYONLY)
endforeach()
psyz_title(tm4_web "TM4 Rewired")

foreach(symbol SquareRoot0 Psyz_CdPullSamples InitCARD StartCARD StopCARD _card_status _card_read _card_write Draw_PushPrim)
    target_link_options(tm4_web PRIVATE "-Wl,--wrap=${symbol}")
endforeach()

include(native_exports.cmake)

set(TM4_DISC_CUE "${TM4_ROOT}/disks/Twisted Metal 4/Twisted Metal 4.cue"
    CACHE FILEPATH "Original mixed-mode disc CUE")
get_filename_component(TM4_DISC_DIRECTORY "${TM4_DISC_CUE}" DIRECTORY)
file(GLOB TM4_MUSIC_INPUTS CONFIGURE_DEPENDS "${TM4_DISC_DIRECTORY}/*.bin")
set(TM4_MUSIC_HEADER "${CMAKE_CURRENT_BINARY_DIR}/music_tracks.h")
add_custom_command(OUTPUT "${TM4_MUSIC_HEADER}"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/prepare_music.py"
        --cue "${TM4_DISC_CUE}" --output-directory "${CMAKE_CURRENT_BINARY_DIR}/site/audio"
        --header "${TM4_MUSIC_HEADER}"
    DEPENDS "${TM4_DISC_CUE}" ${TM4_MUSIC_INPUTS} "${CMAKE_CURRENT_SOURCE_DIR}/prepare_music.py"
    VERBATIM)
add_custom_target(tm4_music DEPENDS "${TM4_MUSIC_HEADER}")
add_dependencies(tm4_web tm4_music)
target_include_directories(tm4_web PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
set_source_files_properties("${TM4_GAME_ROOT}/src/main/redbook.c" PROPERTIES COMPILE_DEFINITIONS
    "CdGetToc=WebMusicGetToc;CdControl=WebMusicControl;CdControlB=WebMusicControlB;CdReadyCallback=WebMusicReadyCallback")

set(TM4_MOVIE_STAMP "${CMAKE_CURRENT_BINARY_DIR}/site/movies/prepared.txt")
add_custom_command(OUTPUT "${TM4_MOVIE_STAMP}"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/prepare_movies.py"
        --track "${TM4_DISC_TRACK}" --output-directory "${CMAKE_CURRENT_BINARY_DIR}/site/movies"
    DEPENDS "${TM4_DISC_TRACK}" "${CMAKE_CURRENT_SOURCE_DIR}/prepare_movies.py"
        "${TM4_GAME_ROOT}/tools/overlay_resources.py" VERBATIM)
add_custom_target(tm4_movies DEPENDS "${TM4_MOVIE_STAMP}")
add_dependencies(tm4_web tm4_movies)

# Small asset-free test using the actual WebGL backend and VRAM readback.
add_executable(tm4_gpu_mask_check EXCLUDE_FROM_ALL check_gpu_mask.c)
target_link_libraries(tm4_gpu_mask_check PRIVATE psyz)
target_link_options(tm4_gpu_mask_check PRIVATE -sASSERTIONS=1 -sPTHREAD_POOL_SIZE=2)
tm4_web_configure_target(tm4_gpu_mask_check
    OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site/gpu-mask-check")

add_executable(tm4_display_check EXCLUDE_FROM_ALL check_display.c)
target_link_libraries(tm4_display_check PRIVATE psyz)
target_link_options(tm4_display_check PRIVATE -sASSERTIONS=1 -sPTHREAD_POOL_SIZE=2)
tm4_web_configure_target(tm4_display_check
    OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site/display-check")

# Exact-size vertex allocations exercise partial RTPT batches under ASAN.
add_executable(tm4_gte_batches_check EXCLUDE_FROM_ALL check_gte_batches.c)
target_include_directories(tm4_gte_batches_check PRIVATE ${TM4_GAME_INCLUDE_DIRECTORIES})
target_link_libraries(tm4_gte_batches_check PRIVATE psyz)
target_link_options(tm4_gte_batches_check PRIVATE -sASSERTIONS=1 -sPTHREAD_POOL_SIZE=2)
tm4_web_configure_target(tm4_gte_batches_check
    OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site/gte-batches-check")
