addToLibrary({
#if ASYNCIFY == 1 && PTHREADS
  // Emscripten's pthread catch-up walks the DSO event list synchronously.
  // Suspending there leaves a loading entry that the next catch-up can reenter.
  _dlopen_js__deps: ['$dlopenInternal', '$Asyncify'],
  _dlopen_js__async: true,
  _dlopen_js: (handle) => {
    if (ENVIRONMENT_IS_PTHREAD) {
      return dlopenInternal(handle, { loadAsync: false });
    }
    return Asyncify.handleAsync(() => dlopenInternal(handle, { loadAsync: true }));
  },
#endif
  // Emscripten PR #26155: https://github.com/emscripten-core/emscripten/pull/26155
  // Keep pthread catch-up consistent with _dlsym_js when Asyncify wraps exports.
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
