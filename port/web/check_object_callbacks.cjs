/* Validate registered WASM functions without invoking game callbacks. */
const assert = require('node:assert/strict');
module.exports = async function checkObjectCallbacks(page) {
    const result = await page.evaluate(() => {
        Module._WebTestInspectObjectCallbacks();
        // Importing a WASM function checks its exact type, unlike a JS wrapper.
        // These are the object engine's actual dispatch signatures.
        function signature(parameters, returnsWord) {
            const result = returnsWord ? [127] : [];
            return new WebAssembly.Module(new Uint8Array([
                0, 97, 115, 109, 1, 0, 0, 0,
                1, 4 + parameters + result.length, 1, 96, parameters,
                ...Array(parameters).fill(127), result.length, ...result,
                2, 14, 1, 3, 101, 110, 118, 6, 116, 97, 114, 103, 101, 116, 0, 0,
            ]));
        }
        const signatures = {
            constructor: signature(2, true), instance_constructor: signature(2, true),
            process: signature(1, false), display: signature(5, false),
            destructor: signature(1, false), interaction: signature(2, false),
        };
        return tm4Port.testObjectCallbacks.map(({name, kind, pointer, target}) => {
            try {
                new WebAssembly.Instance(signatures[kind], {env: {target}});
                return {name, kind, pointer, valid: true};
            } catch (error) {
                return {name, kind, pointer, valid: false, error: String(error)};
            }
        });
    });
    assert(result.length > 0, 'scene must register object callbacks');
    assert.deepEqual(result.filter(callback => !callback.valid), [], 'object callback ABI');
    const counts = Object.create(null);
    for (const {kind} of result) counts[kind] = (counts[kind] || 0) + 1;
    console.log('PASS class and live-object callback types', counts);
};
