// Emscripten PR #26155: https://github.com/emscripten-core/emscripten/pull/26155
// Keep pthread catch-up consistent with _dlsym_js when Asyncify wraps exports.
addToLibrary({
  _dlsym_catchup_js: (handle, symbolIndex) => {
    var lib = LDSO.loadedLibsByHandle[handle];
    var symDict = lib.exports;
    var symName = Object.keys(symDict)[symbolIndex];
    var sym = symDict[symName];
#if ASYNCIFY
    if (sym.orig) {
      sym = sym.orig;
    }
#endif
    return addFunction(sym, sym.sig);
  },
});
