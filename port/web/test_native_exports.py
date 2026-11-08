"""Checks for export selection and fail-closed coverage validation."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import native_exports as exports


class NativeExportsTest(unittest.TestCase):
    def test_compiler_definitions_not_prototypes_or_local_variables(self):
        result = subprocess.run(['clang', '-x', 'c', '-std=c11', '-fsyntax-only',
                                 '-Xclang', '-ast-dump=json', '-'],
            input='''
                extern int declared_data;
                int declared_function(int);
                int data[3];
                static int private_data;
                extern int defined_function(int argument) { int local; return argument; }
                static int private_function(void) { return 1; }
            ''', text=True, capture_output=True, check=True)
        names = set(exports.definitions(json.loads(result.stdout)))
        self.assertEqual(names, {'data', 'private_data', 'defined_function', 'private_function'})

    def fixture(self, path, required, units):
        manifest = {'modules': {module: {'exports': names} for module, names in required.items()},
                    'units': []}
        for index, (module, names) in enumerate(units):
            unit = {'id': f'Unit{index}', 'module': module, 'source': f'unit{index}.c'}
            manifest['units'].append(unit)
            (path / f'Unit{index}.json').write_text(json.dumps(dict(unit, exports=names)))
        (path / 'manifest.json').write_text(json.dumps(manifest))
        return SimpleNamespace(manifest=path / 'manifest.json', stamp=path / 'checked.stamp')

    def run_check(self, args):
        with contextlib.redirect_stdout(io.StringIO()):
            exports.check(args)

    def test_omitted_module_fails_before_export_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'config/game').mkdir(parents=True)
            (root / 'config/game/modules.json').write_text(json.dumps({
                'car': {'resource': 'Root/objects/o_car.mod'},
                'conveyer': {'resource': 'Root/objects/o_convey.mod'},
            }))
            (root / 'config/overlays.json').write_text('{}')
            sources = root / 'inputs.txt'
            sources.write_text(str(root / 'src/modules/car/car.c') + '\n')
            with patch.object(exports, 'ROOT', root):
                with self.assertRaisesRegex(ValueError, 'Modules missing from native build: conveyer'):
                    exports.plan(SimpleNamespace(sources=sources, output=root / 'generated'))
            self.assertFalse((root / 'generated/manifest.json').exists())

    def test_missing_export_fails_instead_of_silent_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.fixture(Path(tmp), {'weapon': ['Launch', 'Sizeof']},
                                [('weapon', ['Sizeof'])])
            with self.assertRaisesRegex(ValueError, 'Missing native exports'):
                self.run_check(args)
            self.assertFalse(args.stamp.exists())

    def test_duplicate_definition_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.fixture(Path(tmp), {'weapon': ['Launch']},
                                [('weapon', ['Launch']), ('weapon', ['Launch'])])
            with self.assertRaisesRegex(ValueError, 'Duplicate native definitions'):
                self.run_check(args)

    def test_unreviewed_cross_module_collision_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.fixture(Path(tmp), {'weapon': ['Launch'], 'car': ['Launch']},
                                [('weapon', ['Launch']), ('car', ['Launch'])])
            with self.assertRaisesRegex(ValueError, 'cross-module'):
                self.run_check(args)

    def test_unused_import_units_are_not_linked_by_empty_accessors(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            args = self.fixture(path, {'weapon': ['Launch', 'Sizeof']},
                                [('weapon', ['Launch', 'Sizeof']), ('weapon', [])])
            self.run_check(args)
            registry = (path / 'registry.c').read_text()
            self.assertIn('Unit0(name)', registry)
            self.assertNotIn('Unit1', registry)
            self.assertTrue(args.stamp.exists())

    def test_shared_definition_satisfies_both_original_modules(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            args = self.fixture(path, {'neon': ['Pathing'], 'oil': ['Pathing']},
                                [('neon', ['Pathing'])])
            manifest = json.loads(args.manifest.read_text())
            manifest['units'][0]['modules'] = ['neon', 'oil']
            args.manifest.write_text(json.dumps(manifest))
            self.run_check(args)
            registry = (path / 'registry.c').read_text()
            self.assertIn('!strcasecmp(module, "neon") || !strcasecmp(module, "oil")', registry)
            self.assertEqual(registry.count('OSWord Unit0('), 1)

    def test_tread_exports_require_module_qualified_lookup(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            required = {'cars/c_tank': ['TreadPolysProcess'], 'cars/c_minion': ['TreadPolysProcess']}
            args = self.fixture(path, required, [(m, n) for m, n in required.items()])
            self.run_check(args)
            registry = (path / 'registry.c').read_text()
            global_lookup = registry.split('OSWord WebNativeExport')[1]
            self.assertIn('if (!strcasecmp(name, "treadpolysprocess"))\n        return 0;', global_lookup)
            self.assertIn('!strcasecmp(module, "cars/c_tank")', registry)
            self.assertIn('!strcasecmp(module, "cars/c_minion")', registry)

    def test_global_exports_follow_module_load_and_unload(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            args = self.fixture(path, {'neon': ['Pathing'], 'oil': ['Pathing']},
                                [('neon', ['Pathing'])])
            manifest = json.loads(args.manifest.read_text())
            manifest['units'][0]['modules'] = ['neon', 'oil']
            args.manifest.write_text(json.dumps(manifest))
            self.run_check(args)
            (path / 'tm4/main').mkdir(parents=True)
            (path / 'tm4/main/os.h').write_text('typedef unsigned long OSWord;\n')
            (path / 'probe.c').write_text('''#include <assert.h>
#include <string.h>
#include "registry.c"
static const char* loaded;
int WebNativeModuleLoaded(const char* name) { return loaded && !strcmp(loaded, name); }
OSWord Unit0(const char* name) { return !strcmp(name, "Pathing") ? 42 : 0; }
int main(void) {
    assert(WebNativeExport("Pathing") == 0);
    loaded = "neon";
    assert(WebNativeExport("Pathing") == 42);
    loaded = "oil";
    assert(WebNativeExport("Pathing") == 42);
    loaded = 0;
    assert(WebNativeExport("Pathing") == 0);
    return 0;
}
''')
            subprocess.run(['clang', '-I', str(path), str(path / 'probe.c'),
                            '-o', str(path / 'probe')], check=True)
            subprocess.run([str(path / 'probe')], check=True)

    def test_only_documented_menu_entries_may_be_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            args = self.fixture(Path(tmp), {'menu': ['MenuMain', 'MenuSave', 'Other']},
                                [('menu', ['Other'])])
            self.run_check(args)
            self.assertTrue(args.stamp.exists())


if __name__ == '__main__':
    unittest.main()
