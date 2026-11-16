# Compile each overlay source with a generated, typed export accessor in its own TU.
set(TM4_EXPORT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/native-exports")
set(TM4_EXPORT_TOOL "${TM4_ROOT}/tools/prepare/exports.js")
set(TM4_EXPORT_DEPENDENCIES "${TM4_EXPORT_TOOL}"
    "${TM4_ROOT}/tools/exports/model.js" "${TM4_ROOT}/tools/exports/templates.js"
    "${TM4_ROOT}/tools/common.js")
get_target_property(TM4_CORE_SOURCES tm4_core SOURCES)
set(TM4_EXPORT_INPUTS)
foreach(source IN LISTS TM4_CORE_SOURCES)
    if(source MATCHES "/src/modules/.*\\.c$")
        list(APPEND TM4_EXPORT_INPUTS "${source}")
    endif()
endforeach()
list(JOIN TM4_EXPORT_INPUTS "\n" TM4_EXPORT_INPUT_TEXT)
file(WRITE "${TM4_EXPORT_DIRECTORY}/inputs.txt" "${TM4_EXPORT_INPUT_TEXT}\n")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    ${TM4_EXPORT_DEPENDENCIES} "${TM4_ROOT}/config/exports.json" "${TM4_ROOT}/game/config/game/modules.json" "${TM4_ROOT}/game/config/overlays.json")
execute_process(COMMAND "${BUN_EXECUTABLE}" "${TM4_EXPORT_TOOL}" plan
    --sources "${TM4_EXPORT_DIRECTORY}/inputs.txt" --output "${TM4_EXPORT_DIRECTORY}"
    --game-root "${TM4_GAME_ROOT}"
    COMMAND_ERROR_IS_FATAL ANY)

function(tm4_export_source source unit modules)
    set(output "${TM4_EXPORT_DIRECTORY}/${unit}.c")
    get_source_file_property(definitions "${source}" COMPILE_DEFINITIONS)
    set(definition_flags)
    if(definitions)
        foreach(definition IN LISTS definitions)
            list(APPEND definition_flags "-D${definition}")
        endforeach()
        set_source_files_properties("${output}" PROPERTIES COMPILE_DEFINITIONS "${definitions}")
    endif()
    add_custom_command(OUTPUT "${output}"
        BYPRODUCTS "${TM4_EXPORT_DIRECTORY}/${unit}.json"
        COMMAND "${BUN_EXECUTABLE}" "${TM4_EXPORT_TOOL}" generate
            --manifest "${TM4_EXPORT_DIRECTORY}/manifest.json" --unit "${unit}" --output "${output}"
            -- "${CMAKE_C_COMPILER}" -std=gnu11 -pthread
            "$<TARGET_PROPERTY:tm4_core,COMPILE_OPTIONS>"
            "-D$<JOIN:$<TARGET_PROPERTY:tm4_core,COMPILE_DEFINITIONS>,;-D>" ${definition_flags}
            "-I$<JOIN:${TM4_GAME_INCLUDE_DIRECTORIES},;-I>" -isystem "${TM4_SDK_ALIASES}"
            -isystem "${TM4_ROOT}/external/psyz/psyz/include"
        DEPENDS "${source}" "${TM4_ROOT}/config/exports.json" ${TM4_EXPORT_DEPENDENCIES}
            "${TM4_EXPORT_DIRECTORY}/manifest.json"
        DEPFILE "${output}.d" COMMAND_EXPAND_LISTS VERBATIM)
    set_property(GLOBAL APPEND PROPERTY TM4_GENERATED_EXPORT_SOURCES "${output}")
    foreach(module IN LISTS modules)
        string(REPLACE "/" "_" module_id "${module}")
        set_property(GLOBAL APPEND PROPERTY TM4_DYNAMIC_${module_id}_SOURCES "${output}")
    endforeach()
endfunction()
function(tm4_dynamic_module module image_name)
    string(REPLACE "/" "_" module_id "${module}")
    string(REPLACE ".sym" "" output_name "${image_name}")
    get_property(sources GLOBAL PROPERTY TM4_DYNAMIC_${module_id}_SOURCES)
    set(entry "${TM4_EXPORT_DIRECTORY}/${module_id}.c")
    set_property(GLOBAL APPEND PROPERTY TM4_DYNAMIC_ENTRIES "${entry}")
    set_source_files_properties("${entry}" PROPERTIES GENERATED TRUE)
    if(EXISTS "${TM4_WEB}/overlays/${module}.c")
        list(REMOVE_ITEM TM4_CORE_SOURCES "${TM4_WEB}/overlays/${module}.c")
        set(TM4_CORE_SOURCES "${TM4_CORE_SOURCES}" PARENT_SCOPE)
        list(APPEND sources "${TM4_WEB}/overlays/${module}.c")
    endif()
    if(EXISTS "${TM4_ROOT}/port/modules/${module}/snapshot.c")
        list(APPEND sources "${TM4_ROOT}/port/modules/${module}/snapshot.c")
    endif()
    add_library(tm4_module_${module_id} MODULE ${sources} "${entry}")
    target_include_directories(tm4_module_${module_id} PRIVATE "$<TARGET_PROPERTY:tm4_core,INCLUDE_DIRECTORIES>")
    target_compile_definitions(tm4_module_${module_id} PRIVATE "$<TARGET_PROPERTY:tm4_core,COMPILE_DEFINITIONS>")
    target_compile_options(tm4_module_${module_id} PRIVATE "$<TARGET_PROPERTY:tm4_core,COMPILE_OPTIONS>" -fPIC -fvisibility=hidden)
    # Menu previews and loading callbacks wait for presentation; simulation modules never suspend.
    set(asyncify 0)
    if(module STREQUAL "menu" AND NOT TM4_STANDALONE)
        set(asyncify 1)
        target_link_options(tm4_module_${module_id} PRIVATE "-sASYNCIFY_IMPORTS=VSync,LoadingDisplay,CDLoadFileLocSize,RegAddReg")
    endif()
    target_link_options(tm4_module_${module_id} PRIVATE -sSIDE_MODULE=2 -sASYNCIFY=${asyncify} -sEXPORTED_FUNCTIONS=_Tm4ModuleExport)
    if(NOT TM4_STANDALONE)
        target_link_options(tm4_module_${module_id} PRIVATE -pthread)
    endif()
    foreach(symbol SquareRoot0 Psyz_CdPullSamples InitCARD StartCARD StopCARD _card_status _card_read _card_write Draw_PushPrim)
        target_compile_definitions(tm4_module_${module_id} PRIVATE "${symbol}=__wrap_${symbol}")
    endforeach()
    set_target_properties(tm4_module_${module_id} PROPERTIES PREFIX "" OUTPUT_NAME "${output_name}" SUFFIX ".wasm" LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/site/modules")
    set_property(GLOBAL APPEND PROPERTY TM4_DYNAMIC_TARGETS tm4_module_${module_id})
    set_property(GLOBAL APPEND PROPERTY TM4_DYNAMIC_FILES "$<TARGET_FILE:tm4_module_${module_id}>")
endfunction()
target_link_options(tm4_web PRIVATE -sMAIN_MODULE=2)
include("${TM4_EXPORT_DIRECTORY}/sources.cmake")
get_property(TM4_GENERATED_EXPORT_SOURCES GLOBAL PROPERTY TM4_GENERATED_EXPORT_SOURCES)
list(REMOVE_ITEM TM4_CORE_SOURCES ${TM4_EXPORT_INPUTS})
set_property(TARGET tm4_core PROPERTY SOURCES "${TM4_CORE_SOURCES}")
target_sources(tm4_core PRIVATE "${TM4_EXPORT_DIRECTORY}/registry.c")
get_property(TM4_DYNAMIC_ENTRIES GLOBAL PROPERTY TM4_DYNAMIC_ENTRIES)
add_custom_command(OUTPUT "${TM4_EXPORT_DIRECTORY}/checked.stamp" "${TM4_EXPORT_DIRECTORY}/registry.c" ${TM4_DYNAMIC_ENTRIES}
    COMMAND "${BUN_EXECUTABLE}" "${TM4_EXPORT_TOOL}" check
        --manifest "${TM4_EXPORT_DIRECTORY}/manifest.json"
        --stamp "${TM4_EXPORT_DIRECTORY}/checked.stamp"
    DEPENDS ${TM4_GENERATED_EXPORT_SOURCES} ${TM4_EXPORT_DEPENDENCIES}
        "${TM4_EXPORT_DIRECTORY}/manifest.json" VERBATIM)
add_custom_target(tm4_native_exports DEPENDS "${TM4_EXPORT_DIRECTORY}/checked.stamp")
add_dependencies(tm4_web tm4_native_exports)

get_property(TM4_DYNAMIC_TARGETS GLOBAL PROPERTY TM4_DYNAMIC_TARGETS)
get_property(TM4_DYNAMIC_FILES GLOBAL PROPERTY TM4_DYNAMIC_FILES)
add_dependencies(tm4_core tm4_native_exports)
foreach(target IN LISTS TM4_DYNAMIC_TARGETS)
    add_dependencies(${target} tm4_native_exports)
endforeach()
set(module_imports "${TM4_EXPORT_DIRECTORY}/module-imports.rsp")
add_custom_command(OUTPUT "${module_imports}"
    COMMAND "${BUN_EXECUTABLE}" "${TM4_ROOT}/tools/prepare/module-imports.js" "${module_imports}" ${TM4_DYNAMIC_FILES}
    DEPENDS ${TM4_DYNAMIC_TARGETS} "${TM4_ROOT}/tools/prepare/module-imports.js" VERBATIM)
add_custom_target(tm4_module_imports DEPENDS "${module_imports}")
add_dependencies(tm4_web tm4_module_imports)
target_link_options(tm4_web PRIVATE "@${module_imports}")
set_property(TARGET tm4_web APPEND PROPERTY LINK_DEPENDS "${module_imports}")
target_include_directories(tm4_web PRIVATE "${TM4_EXPORT_DIRECTORY}")
