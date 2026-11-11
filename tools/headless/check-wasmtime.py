"""Direct Wasmtime/WASI parity check. No JavaScript runtime or browser is loaded."""
import base64
import json
import resource
import struct
import sys
import time
from pathlib import Path

import wasmtime

wasm_path, resources, reference_path, *output_path = sys.argv[1:]
reference = json.loads(Path(reference_path).read_text())
started = time.perf_counter()
engine = wasmtime.Engine()
module = wasmtime.Module.from_file(engine, wasm_path)
compiled_ms = (time.perf_counter() - started) * 1000
imports = [(entry.module, entry.name) for entry in module.imports]
assert all(namespace == "wasi_snapshot_preview1" for namespace, _ in imports), imports
linker = wasmtime.Linker(engine)
linker.define_wasi()
store = wasmtime.Store(engine)
wasi = wasmtime.WasiConfig()
wasi.inherit_stdout()
wasi.inherit_stderr()
wasi.preopen_dir(str(Path(resources, "DATA").resolve()), "/DATA", fs_mutable=False)
store.set_wasi(wasi)
instance = linker.instantiate(store, module)
exports = instance.exports(store)
memory = exports["memory"]


def call(name, *args):
    return exports[name](store, *args)


def read():
    length = call("HeadlessCapture")
    assert length > 0, f"Canonical capture refused at {call('HeadlessTick')}"
    offset = call("HeadlessCanonical")
    digest_at = call("HeadlessDigest")
    sections = list(struct.unpack("<5I", memory.read(store, digest_at, digest_at + 20)))
    canonical = bytes(memory.read(store, offset, offset + length))
    return call("HeadlessTick"), sections, canonical


comparisons = 0

def compare():
    global comparisons
    tick, sections, canonical = read()
    expected = reference["rows"][tick]
    digest = sections[0]
    for section in sections[1:]:
        digest = ((digest ^ section) * 16777619) & 0xFFFFFFFF
    assert digest == expected["digest"], f"Combined digest mismatch at {tick}"
    assert sections == expected["sections"], (tick, sections, expected["sections"])
    assert canonical == base64.b64decode(expected["canonical"]), f"Canonical mismatch at {tick}"
    comparisons += 1


def step(tick):
    entry = reference["tape"][tick]
    action = entry["action"]
    if action:
        assert call(action[0].removeprefix("_"), action[1])
    before = time.perf_counter()
    for slot, command in enumerate(entry["inputs"]):
        assert call("WebNetSetInput", tick, slot, command["buttons"], command.get("axes", 0), int(command.get("analog", False)))
    assert call("WebNetQueueTick", tick)
    return (time.perf_counter() - before) * 1000


call("_initialize")
assert call("HeadlessInitialize")
assert not call("HeadlessCapture"), "Capture accepted before a match"
assert call("WebNetRequestMatch", 2, 0, 12345, -1)
startup_ms = (time.perf_counter() - started) * 1000
compare()
step_ms = []
checkpoint_tick = 82
assert reference["events"][checkpoint_tick - 1]["live"], "Checkpoint fixture needs a live projectile"
checkpoint_bytes = 0
for tick in range(len(reference["rows"]) - 1):
    step_ms.append(step(tick))
    compare()
    if tick + 1 == checkpoint_tick:
        before = time.perf_counter()
        checkpoint_bytes = call("WebNetCaptureLocalCheckpoint")
        capture_ms = (time.perf_counter() - before) * 1000
        assert checkpoint_bytes > 0
replay = []
for repeat in range(3):
    before = time.perf_counter()
    assert call("WebNetRestoreLocalCheckpoint")
    restore_ms = (time.perf_counter() - before) * 1000
    compare()
    before = time.perf_counter()
    for tick in range(checkpoint_tick, len(reference["rows"]) - 1):
        step(tick)
        compare()
    replay.append({"restoreMs": restore_ms, "replayMs": (time.perf_counter() - before) * 1000})
    assert call("WebNetFinishLocalReplay")
call("WebNetCancelMatch")
assert not call("HeadlessCapture"), "Capture survived match teardown"
result = {
    "runtime": "Wasmtime Python 50.0.1", "python": sys.version, "platform": sys.platform,
    "wasm": wasm_path, "imports": imports, "ticks": len(step_ms), "canonicalComparisons": comparisons,
    "compileMs": compiled_ms, "startupMs": startup_ms,
    "stepMs": step_ms, "checkpointBytes": checkpoint_bytes, "captureMs": capture_ms, "replay": replay,
    "wasmMemoryBytes": memory.data_len(store), "processMaxRss": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
}
Path(output_path[0] if output_path else "build/wasmtime-result.json").write_text(json.dumps(result, indent=2))
result["stepMs"] = {"min": min(step_ms), "max": max(step_ms), "mean": sum(step_ms) / len(step_ms)}
print(json.dumps(result))
