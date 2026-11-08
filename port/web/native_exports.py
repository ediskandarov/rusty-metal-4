#!/usr/bin/env python3
"""Bind original overlay exports to typed definitions in the native build."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2] / "game"
sys.path.insert(0, str(ROOT / 'tools'))
from overlay_pic import PIC


# MENU and CAR exported the same spelling from separate images.
# The recovered source gives the menu implementation its own C name.
ALIASES = {"menu": {"CarRelocateBitStuff": "MenuRelocateCarTextures"}}
# These exports belonged to separate original images and must keep separate state.
TREAD_EXPORTS = {"TreadPolysClassConstructor", "TreadPolysClassDestructor",
                 "TreadPolysConstructor", "TreadPolysDestructor", "TreadPolysProcess"}
for module in ("c_tank", "c_minion", "c_crush"):
    ALIASES[f"cars/{module}"] = {
        name: f"Web_cars_{module}_{name}" for name in TREAD_EXPORTS}

UNAVAILABLE = {"menu": {
    "MenuMain": "Blocking PS1 loop; browser menu is driven by bootstrap.c",
    "MenuSave": "Blocking PS1 loop; bootstrap.c enters MenuScreenSaveTournament",
}}


def identifier(text):
    return re.sub(r'[^a-zA-Z0-9_]', '_', text)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_text() != text:
        path.write_text(text)


def plan(args):
    root = getattr(args, "game_root", ROOT)
    originals = getattr(args, "originals", ROOT.parent / "orig/modules")
    modules = {}
    for filename, container in [('config/game/modules.json', 'GAME'), ('config/overlays.json', None)]:
        for name, info in json.loads((root / filename).read_text()).items():
            modules[info.get('source', name)] = {
                'original': str(originals / (container or info['container']) / info['resource']),
                'shared_sources': list(info.get('unit_sources', {}).values())
            }
    sources = [Path(s) for s in args.sources.read_text().splitlines() if s]
    units = []
    selected = {}
    selected_modules = {s.parent.relative_to(root / 'src/modules').as_posix() for s in sources}
    selected_modules.intersection_update(modules)
    missing_modules = sorted(modules.keys() - selected_modules)
    if missing_modules:
        raise ValueError('Modules missing from native build: ' + ', '.join(missing_modules))
    for source in sources:
        relative = source.relative_to(root / 'src/modules')
        module = relative.parent.as_posix()
        owners = [module] if module in modules else sorted(
            name for name in selected_modules
            if source.relative_to(root).as_posix() in modules[name]['shared_sources'])
        if not owners:
            raise ValueError(f'No original module for {source}')
        for owner in owners:
            if owner not in selected:
                info = modules[owner]
                pic = PIC(Path(info['original']).read_bytes())
                exports = pic.exports
                # Import resolver trampolines are local to each original loaded image.
                selected[owner] = {'original': info['original'], 'image_name': pic.debug_name, 'exports': sorted({
                    e['name'] for e in exports
                    if not e['name'].startswith(('OSRegister', 'use_OSRegister'))})}
        units.append({'source': str(source), 'module': owners[0], 'modules': owners,
                      'id': 'WebExports_' + identifier(relative.with_suffix('').as_posix())})
    manifest = {'modules': selected, 'units': units}
    write(args.output / 'manifest.json', json.dumps(manifest, indent=2) + '\n')
    write(args.output / 'sources.cmake', '\n'.join(
        f'tm4_export_source("{u["source"]}" "{u["id"]}" "{";".join(selected[m]["original"] for m in u["modules"])}")'
        for u in units) + '\n')


def definitions(ast):
    # Only file-scope definitions, never declarations or function-local variables.
    for node in ast.get('inner', []):
        if node['kind'] == 'FunctionDecl':
            if any(child['kind'] == 'CompoundStmt' for child in node.get('inner', [])):
                yield node['name']
        elif node['kind'] == 'VarDecl':
            if node.get('storageClass') != 'extern' or 'init' in node:
                yield node['name']


def generate(args):
    manifest = json.loads(args.manifest.read_text())
    unit = next(u for u in manifest['units'] if u['id'] == args.unit)
    exports = set().union(*(manifest['modules'][m]['exports'] for m in unit['modules']))
    command = args.compiler
    if command[0] == '--':
        command = command[1:]
    result = subprocess.run(command + ['-fsyntax-only', '-Xclang', '-ast-dump=json',
        '-MMD', '-MF', str(args.output) + '.d', '-MT', str(args.output), unit['source']],
        stdout=subprocess.PIPE, text=True, check=True)
    defined = set(definitions(json.loads(result.stdout)))
    aliases = ALIASES.get(unit["module"], {})
    names = sorted(name for name in exports if aliases.get(name, name) in defined
                   and name not in UNAVAILABLE.get(unit["module"], {}))
    # Include the owning source so C sees the real signature and private data types.
    # Do not invent untyped extern declarations for WASM function-table entries.
    code = [f'#include {json.dumps(unit["source"])}', '#include "tm4/main/os.h"',
            '#include <strings.h>', f'OSWord {unit["id"]}(const char* name)', '{']
    for name in names:
        code += [f'    if (!strcasecmp(name, "{name}"))', f'        return (OSWord)&{aliases.get(name, name)};']
    code += ['    return 0;', '}']
    write(args.output, '\n'.join(code) + '\n')
    write(args.output.with_suffix('.json'), json.dumps({'module': unit['module'],
        'source': unit['source'], 'exports': names}, indent=2) + '\n')
    # Refresh output even if only an included header changed (avoid perpetual rebuilds).
    args.output.touch()


def check(args):
    manifest = json.loads(args.manifest.read_text())
    found = {module: set() for module in manifest['modules']}
    active = []
    owners = {}
    for unit in manifest['units']:
        info = json.loads((args.manifest.parent / (unit['id'] + '.json')).read_text())
        if info['exports']:
            active.append(unit)
        for name in info['exports']:
            owners.setdefault(name.lower(), []).append(unit['module'])
        for module in unit.get('modules', [unit['module']]):
            module_exports = set(info['exports']).intersection(manifest['modules'][module]['exports'])
            overlap = found[module].intersection(module_exports)
            if overlap:
                raise ValueError(f'Duplicate native definitions: {overlap}')
            found[module].update(module_exports)
    missing = {}
    for module, info in manifest['modules'].items():
        unavailable = UNAVAILABLE.get(module, {})
        absent = sorted(set(info['exports']) - found[module] - unavailable.keys())
        print(f'{module}: {len(found[module])}/{len(info["exports"])} native exports')
        for name, reason in unavailable.items():
            print(f'  unavailable: {name}: {reason}')
        if absent:
            missing[module] = absent
    if missing:
        raise ValueError('Missing native exports: ' + json.dumps(missing, indent=2))
    collisions = {name: modules for name, modules in owners.items() if len(modules) > 1}
    for name, modules in collisions.items():
        if name == 'carrelocatebitstuff' and set(modules) == {'car', 'menu'}:
            continue
        if name in {n.lower() for n in TREAD_EXPORTS} and set(modules) <= {
                'cars/c_tank', 'cars/c_minion', 'cars/c_crush'}:
            continue
        raise ValueError(f'Unresolved cross-module export names: {name}: {modules}')
    code = ['#include "tm4/main/os.h"', '#include <strings.h>',
            'int WebNativeModuleLoaded(const char* image_name);']
    code += [f'OSWord {u["id"]}(const char* name);' for u in active]
    code += ['OSWord WebNativeModuleExport(const char* module, const char* name)',
             '{', '    OSWord result;']
    for unit in active:
        condition = ' || '.join(f'!strcasecmp(module, "{m}")'
                                for m in unit.get('modules', [unit['module']]))
        code += [f'    if ({condition}) {{',
                 f'        result = {unit["id"]}(name);',
                 '        if (result)', '            return result;', '    }']
    code += ['    return 0;', '}', 'OSWord WebNativeExport(const char* name)',
             '{', '    OSWord result;']
    for name in sorted(set(collisions) - {'carrelocatebitstuff'}):
        code += [f'    if (!strcasecmp(name, "{name}"))', '        return 0;']
    if 'carrelocatebitstuff' in collisions:
        # The menu and the loaded game own separate implementations of this export.
        code += ['    if (!strcasecmp(name, "CarRelocateBitStuff")) {',
                 '        if (WebNativeModuleLoaded("o_car.sym"))',
                 '            return WebNativeModuleExport("car", name);',
                 '        if (WebNativeModuleLoaded("menu.sym"))',
                 '            return WebNativeModuleExport("menu", name);',
                 '        return 0;', '    }']
    for unit in active:
        condition = ' || '.join(
            f'WebNativeModuleLoaded({json.dumps(manifest["modules"][m].get("image_name", m))})'
            for m in unit.get('modules', [unit['module']]))
        code += [f'    if ({condition}) {{', f'        result = {unit["id"]}(name);',
                 '        if (result)', '            return result;', '    }']
    code += ['    return 0;', '}']
    write(args.manifest.parent / 'registry.c', '\n'.join(code) + '\n')
    args.stamp.write_text('All required overlay exports have native definitions; explicit unavailable entries reported.\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('plan')
    p.add_argument('--sources', type=Path, required=True)
    p.add_argument('--game-root', type=Path, default=ROOT)
    p.add_argument('--originals', type=Path, default=ROOT.parent / 'orig/modules')
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('generate')
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--unit', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('compiler', nargs=argparse.REMAINDER)
    p = sub.add_parser('check')
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--stamp', type=Path, required=True)
    args = parser.parse_args()
    {'plan': plan, 'generate': generate, 'check': check}[args.action](args)


if __name__ == '__main__':
    main()
