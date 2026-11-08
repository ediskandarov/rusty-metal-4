# Compile each overlay source with a generated, typed export accessor in its own TU.
set(TM4_EXPORT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/native-exports")
set(TM4_EXPORT_TOOL "${CMAKE_CURRENT_SOURCE_DIR}/native_exports.py")
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
    "${TM4_EXPORT_TOOL}" "${TM4_ROOT}/game/config/game/modules.json" "${TM4_ROOT}/game/config/overlays.json")
execute_process(COMMAND "${Python3_EXECUTABLE}" "${TM4_EXPORT_TOOL}" plan
    --sources "${TM4_EXPORT_DIRECTORY}/inputs.txt" --output "${TM4_EXPORT_DIRECTORY}"
    --game-root "${TM4_GAME_ROOT}" --originals "${TM4_ROOT}/orig/modules"
    COMMAND_ERROR_IS_FATAL ANY)

function(tm4_export_source source unit original)
    set(output "${TM4_EXPORT_DIRECTORY}/${unit}.c")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${original}")
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
        COMMAND "${Python3_EXECUTABLE}" "${TM4_EXPORT_TOOL}" generate
            --manifest "${TM4_EXPORT_DIRECTORY}/manifest.json" --unit "${unit}" --output "${output}"
            -- "${CMAKE_C_COMPILER}" -std=gnu11 -pthread
            "$<TARGET_PROPERTY:tm4_core,COMPILE_OPTIONS>"
            "-D$<JOIN:$<TARGET_PROPERTY:tm4_core,COMPILE_DEFINITIONS>,;-D>" ${definition_flags}
            "-I$<JOIN:${TM4_GAME_INCLUDE_DIRECTORIES},;-I>" -isystem "${TM4_SDK_ALIASES}"
            -isystem "${TM4_ROOT}/external/psyz/psyz/include"
        DEPENDS "${source}" "${original}" "${TM4_EXPORT_TOOL}"
            "${TM4_ROOT}/game/tools/overlay_pic.py" "${TM4_ROOT}/game/tools/overlay_resources.py"
            "${TM4_EXPORT_DIRECTORY}/manifest.json"
        DEPFILE "${output}.d" COMMAND_EXPAND_LISTS VERBATIM)
    set_property(GLOBAL APPEND PROPERTY TM4_GENERATED_EXPORT_SOURCES "${output}")
endfunction()
include("${TM4_EXPORT_DIRECTORY}/sources.cmake")
get_property(TM4_GENERATED_EXPORT_SOURCES GLOBAL PROPERTY TM4_GENERATED_EXPORT_SOURCES)
list(REMOVE_ITEM TM4_CORE_SOURCES ${TM4_EXPORT_INPUTS})
set_property(TARGET tm4_core PROPERTY SOURCES "${TM4_CORE_SOURCES}")
target_sources(tm4_core PRIVATE ${TM4_GENERATED_EXPORT_SOURCES} "${TM4_EXPORT_DIRECTORY}/registry.c")
add_custom_command(OUTPUT "${TM4_EXPORT_DIRECTORY}/checked.stamp" "${TM4_EXPORT_DIRECTORY}/registry.c"
    COMMAND "${Python3_EXECUTABLE}" "${TM4_EXPORT_TOOL}" check
        --manifest "${TM4_EXPORT_DIRECTORY}/manifest.json"
        --stamp "${TM4_EXPORT_DIRECTORY}/checked.stamp"
    DEPENDS ${TM4_GENERATED_EXPORT_SOURCES} "${TM4_EXPORT_TOOL}"
        "${TM4_EXPORT_DIRECTORY}/manifest.json" VERBATIM)
add_custom_target(tm4_native_exports DEPENDS "${TM4_EXPORT_DIRECTORY}/checked.stamp")
add_dependencies(tm4_web tm4_native_exports)
