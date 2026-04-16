const { readFileSync, writeFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const corePath = path.join(__dirname, "..", "vendor", "live2d", "live2dcubismcore.js");
const rawSrc = readFileSync(corePath, "utf8");
const src = rawSrc.replace(
    "var _em = _em_module();",
    "var _em = _em_module(); globalThis.__live2d_em = _em;",
);

const sandbox = {
    module: { exports: {} }, exports: {}, require,
    __dirname: path.dirname(corePath), __filename: corePath,
    Buffer, process,
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

async function main() {
    const start = Date.now();
    while (Object.keys(_em.asm).length === 0) {
        if (Date.now() - start > 5000) throw new Error("WASM init timeout");
        await new Promise((r) => setImmediate(r));
    }

    const mocBytes = readFileSync("c:/Users/aleck/Documents/Sarxina/Assets/Model/Sarxina/Sarxina.moc3");
    const moc = Live2DCubismCore.Moc.fromArrayBuffer(new Uint8Array(mocBytes).buffer);
    const model = Live2DCubismCore.Model.fromMoc(moc);

    const partIds = [...model.parts.ids];
    const partParents = [...model.parts.parentIndices];
    const drawableIds = [...model.drawables.ids];
    const drawableParents = [...model.drawables.parentPartIndices];

    // Group drawables by their parent part
    const drawablesByPart = Array(partIds.length).fill(null).map(() => []);
    drawableParents.forEach((partIdx, drawIdx) => {
        if (partIdx >= 0 && partIdx < partIds.length) {
            drawablesByPart[partIdx].push(drawableIds[drawIdx]);
        }
    });

    // Find children of each part (for tree walking)
    const childrenOfPart = Array(partIds.length).fill(null).map(() => []);
    partParents.forEach((parentIdx, partIdx) => {
        if (parentIdx >= 0 && parentIdx < partIds.length) {
            childrenOfPart[parentIdx].push(partIdx);
        }
    });

    // Print top-level parts (those with parent index -1) and their drawable counts
    console.log("=== Top-level parts (root nodes of the tree) ===");
    const roots = partIds.map((_, i) => i).filter((i) => partParents[i] < 0);
    console.log(`${roots.length} root parts:\n`);

    function countDrawablesRecursive(partIdx) {
        let count = drawablesByPart[partIdx].length;
        for (const c of childrenOfPart[partIdx]) count += countDrawablesRecursive(c);
        return count;
    }

    function printTree(partIdx, depth) {
        const direct = drawablesByPart[partIdx].length;
        const total = countDrawablesRecursive(partIdx);
        const directChildren = childrenOfPart[partIdx].length;
        console.log(`${"  ".repeat(depth)}${partIds[partIdx]}  [direct=${direct}, total=${total}, child_parts=${directChildren}]`);
    }

    for (const r of roots) printTree(r, 0);

    // Save full tree to JSON for later inspection
    const tree = roots.map(function build(idx) {
        return {
            id: partIds[idx],
            directDrawables: drawablesByPart[idx].length,
            totalDrawables: countDrawablesRecursive(idx),
            children: childrenOfPart[idx].map(build),
            drawables: drawablesByPart[idx],
        };
    });
    writeFileSync("hierarchy.json", JSON.stringify(tree, null, 2));
    console.log("\nFull tree written to hierarchy.json");
    console.log(`Total parts: ${partIds.length}, total drawables: ${drawableIds.length}, parts with no parent: ${roots.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
