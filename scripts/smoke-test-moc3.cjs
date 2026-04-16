const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const corePath = path.join(__dirname, "..", "vendor", "live2d", "live2dcubismcore.js");
const rawSrc = readFileSync(corePath, "utf8");
const src = rawSrc.replace(
    "var _em = _em_module();",
    "var _em = _em_module(); globalThis.__live2d_em = _em;",
);
if (src === rawSrc) throw new Error("Patch point not found");

const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    __dirname: path.dirname(corePath),
    __filename: corePath,
    Buffer,
    process,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    WebAssembly, TextDecoder, TextEncoder, performance,
    crypto: globalThis.crypto,
};
sandbox.global = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: corePath });

const Live2DCubismCore = sandbox.Live2DCubismCore;
const _em = sandbox.__live2d_em;
console.log("_em.asm initially has:", Object.keys(_em.asm).length, "exports");
console.log("_em.calledRun:", _em.calledRun);

async function main() {
    // Poll until WASM exports show up
    const start = Date.now();
    while (Object.keys(_em.asm).length === 0) {
        if (Date.now() - start > 5000) throw new Error("WASM init timeout");
        await new Promise((r) => setImmediate(r));
    }
    console.log("WASM ready in", Date.now() - start, "ms.", Object.keys(_em.asm).length, "exports");

    const mocBytes = readFileSync("c:/Users/aleck/Documents/Sarxina/Assets/Model/Sarxina/Sarxina.moc3");
    const bytes = new Uint8Array(mocBytes).buffer;

    const moc = Live2DCubismCore.Moc.fromArrayBuffer(bytes);
    if (!moc) throw new Error("Moc.fromArrayBuffer returned null");
    const model = Live2DCubismCore.Model.fromMoc(moc);
    if (!model) throw new Error("Model.fromMoc returned null");

    console.log("Parts:      ", model.parts.count);
    console.log("Drawables:  ", model.drawables.count);
    console.log("Parameters: ", model.parameters.count);
    console.log("First 5 part IDs:    ", [...model.parts.ids].slice(0, 5));
    console.log("First 5 drawable IDs:", [...model.drawables.ids].slice(0, 5));
}
main().catch((e) => { console.error(e); process.exit(1); });
