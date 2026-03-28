cmake_minimum_required(VERSION 3.16)
project(codex_provider VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# _GNU_SOURCE for strptime/timegm on glibc
add_definitions(-D_GNU_SOURCE)

# Strict warnings
add_compile_options(-Wall -Wextra -Werror -Wpedantic)

# Default to hidden visibility — only CODEX_EXPORT symbols are public
set(CMAKE_C_VISIBILITY_PRESET hidden)

# --------------------------------------------------------------------------
# Find dependencies
# --------------------------------------------------------------------------

find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)

# cJSON: try pkg-config first, then find_library
find_package(PkgConfig QUIET)
if(PKG_CONFIG_FOUND)
    pkg_check_modules(CJSON QUIET libcjson)
endif()
if(NOT CJSON_FOUND)
    find_library(CJSON_LIBRARIES NAMES cjson)
    find_path(CJSON_INCLUDE_DIRS cjson/cJSON.h)
    if(CJSON_LIBRARIES AND CJSON_INCLUDE_DIRS)
        set(CJSON_FOUND TRUE)
    else()
        message(FATAL_ERROR "cJSON not found. Install libcjson-dev.")
    endif()
endif()

# --------------------------------------------------------------------------
# Shared library target
# --------------------------------------------------------------------------

set(SOURCES
    src/provider.c
    src/originator.c
    src/jwt.c
    src/storage.c
    src/auth.c
    src/transform.c
    src/stream.c
    src/transport.c
    src/quota.c
)

add_library(codex_provider SHARED ${SOURCES})

target_include_directories(codex_provider
    PUBLIC  include
    PRIVATE ${CJSON_INCLUDE_DIRS}
)

target_link_libraries(codex_provider
    PRIVATE
        CURL::libcurl
        OpenSSL::SSL
        OpenSSL::Crypto
        ${CJSON_LIBRARIES}
)

# Set output name without 'lib' prefix on all platforms for FFI simplicity
set_target_properties(codex_provider PROPERTIES
    PREFIX ""
    OUTPUT_NAME "codex_provider"
    VERSION ${PROJECT_VERSION}
    SOVERSION 1
)

# --------------------------------------------------------------------------
# CLI executable target (stdio bridge: stdin JSON → stdout JSONL)
# --------------------------------------------------------------------------

# The executable links the same object files as the library (minus provider.c
# lifecycle which main.c replaces for the standalone case). For simplicity,
# we link the shared library + main.c — the library exports what main needs.
set(CLI_SOURCES
    src/main.c
    src/originator.c
    src/transform.c
    src/stream.c
)

add_executable(codex-provider ${CLI_SOURCES})

target_include_directories(codex-provider
    PRIVATE include
    PRIVATE ${CJSON_INCLUDE_DIRS}
)

target_link_libraries(codex-provider
    PRIVATE
        CURL::libcurl
        ${CJSON_LIBRARIES}
)

# --------------------------------------------------------------------------
# Install
# --------------------------------------------------------------------------

include(GNUInstallDirs)

install(TARGETS codex_provider codex-provider
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

install(FILES include/codex_provider.h
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)

# --------------------------------------------------------------------------
# Build info
# --------------------------------------------------------------------------

message(STATUS "codex_provider ${PROJECT_VERSION}")
message(STATUS "  C standard: C${CMAKE_C_STANDARD}")
message(STATUS "  CURL: ${CURL_VERSION_STRING}")
message(STATUS "  OpenSSL: ${OPENSSL_VERSION}")
message(STATUS "  cJSON: ${CJSON_LIBRARIES}")
