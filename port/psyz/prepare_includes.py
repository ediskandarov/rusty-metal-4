#!/usr/bin/env python3
"""Generate PsyQ-spelled include aliases without changing PsyZ or game sources."""

import argparse
import json
from pathlib import Path

# These headers belong to the target C library, not PsyZ's libc compatibility layer.
C_HEADERS = (
    "assert.h", "ctype.h", "errno.h", "float.h", "limits.h", "math.h",
    "setjmp.h", "signal.h", "stdarg.h", "stddef.h", "stdint.h", "stdio.h",
    "stdlib.h", "string.h", "strings.h", "time.h", "sys/types.h",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sdk = args.sdk.resolve()
    aliases = {
        header.name.upper(): '#include ' + json.dumps(header.as_posix()) + '\n'
        for header in sdk.glob("*.h")
    }
    if "LIBGTE.H" not in aliases:
        parser.error("--sdk must contain PsyZ's libgte.h")
    # include_next avoids finding this same uppercase alias on case-insensitive disks.
    aliases.update({name.upper(): f"#include_next <{name}>\n" for name in C_HEADERS})
    # PsyQ splits declarations differently from the target C library and PsyZ.
    aliases.update({
        "RAND.H": "#include <stdlib.h>\n",
        "STRINGS.H": "#include <string.h>\n#include_next <strings.h>\n",
        "MEMORY.H": "#include <string.h>\n#include <strings.h>\n",
        "INLINE_C.H": "#include <LIBGTE.H>\n",
        "GTEMAC.H": "#include <LIBGTE.H>\n",
    })
    for name, content in sorted(aliases.items()):
        target = args.output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_text() != content:
            target.write_text(content)


if __name__ == "__main__":
    main()
