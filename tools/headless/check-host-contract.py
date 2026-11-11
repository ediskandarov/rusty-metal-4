"""Require explicit diagnostics for missing standalone host capabilities."""
import sys
import tempfile
from pathlib import Path

import wasmtime

engine = wasmtime.Engine()
module = wasmtime.Module.from_file(engine, sys.argv[1])
operations = [
    "EM_ASM",
    "EM_ASM_INT",
    "EM_ASM_DOUBLE",
    "headless_required_js",
    "emscripten_get_now",
    "emscripten_set_interval",
    "emscripten_sleep",
    "emscripten_set_main_loop",
    "Psyz_OsNowUs",
]
with tempfile.TemporaryDirectory(prefix="tm4-headless-contract-") as directory:
    for kind, operation in enumerate(operations):
        linker = wasmtime.Linker(engine)
        linker.define_wasi()
        store = wasmtime.Store(engine)
        wasi = wasmtime.WasiConfig()
        diagnostics = Path(directory, f"probe-{kind}.log")
        wasi.stderr_file = str(diagnostics)
        store.set_wasi(wasi)
        exports = linker.instantiate(store, module).exports(store)
        exports["_initialize"](store)
        try:
            exports["HeadlessTestRequiredHost"](store, kind)
        except (wasmtime.Trap, wasmtime.ExitTrap):
            pass
        else:
            raise AssertionError(f"{operation} silently returned")
        message = diagnostics.read_text()
        assert f"Required host capability unavailable: {operation} at " in message, message
        print(f"Rejected {operation} with a source location")
