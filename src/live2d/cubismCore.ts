import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as vm from "node:vm";

interface EmscriptenModule {
    asm: Record<string, unknown>;
}

export interface CubismMoc {
    [key: string]: unknown;
}

export interface CubismDrawables {
    readonly count: number;
    readonly ids: string[];
    readonly parentPartIndices: Int32Array;
}

export interface CubismParts {
    readonly count: number;
    readonly ids: string[];
    readonly parentIndices: Int32Array;
}

export interface CubismParameters {
    readonly count: number;
    readonly ids: string[];
}

export interface CubismModel {
    readonly parts: CubismParts;
    readonly drawables: CubismDrawables;
    readonly parameters: CubismParameters;
}

export interface CubismCoreNamespace {
    Moc: { fromArrayBuffer(buffer: ArrayBuffer): CubismMoc | null };
    Model: { fromMoc(moc: CubismMoc): CubismModel | null };
}

let loadedCorePromise: Promise<CubismCoreNamespace> | null = null;

/**
 * Load the Live2D Cubism Core WASM. The blob is shipped as a UMD wrapper
 * whose top-level `var Live2DCubismCore` and `var _em` only escape when run
 * outside a CommonJS module wrapper, so we evaluate it in a `vm` context and
 * patch the source to expose the Emscripten runtime handle.
 */
export async function loadCubismCore(): Promise<CubismCoreNamespace> {
    if (loadedCorePromise) return loadedCorePromise;
    loadedCorePromise = (async () => {
        const here = path.dirname(fileURLToPath(import.meta.url));
        // Compiled file lives at dist/live2d/cubismCore.js → ../../vendor/live2d/...
        const corePath = path.resolve(here, "..", "..", "vendor", "live2d", "live2dcubismcore.js");
        const rawSrc = readFileSync(corePath, "utf8");
        const src = rawSrc.replace(
            "var _em = _em_module();",
            "var _em = _em_module(); globalThis.__live2d_em = _em;",
        );
        if (src === rawSrc) {
            throw new Error("Cubism Core patch point not found — vendored blob layout may have changed");
        }

        const sandbox: Record<string, unknown> = {
            module: { exports: {} },
            exports: {},
            __dirname: path.dirname(corePath),
            __filename: corePath,
            Buffer,
            process,
            console: { log: () => {}, warn: () => {}, error: () => {} },
            setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
            TextDecoder, TextEncoder, performance,
            WebAssembly: (globalThis as { WebAssembly?: unknown }).WebAssembly,
            crypto: globalThis.crypto,
        };
        sandbox["global"] = sandbox;
        sandbox["globalThis"] = sandbox;

        vm.createContext(sandbox);
        vm.runInContext(src, sandbox as vm.Context, { filename: corePath });

        const ns = sandbox["Live2DCubismCore"] as CubismCoreNamespace | undefined;
        const em = sandbox["__live2d_em"] as EmscriptenModule | undefined;
        if (!ns?.Moc || !em) {
            throw new Error("Cubism Core failed to initialize");
        }

        // Wait for the WASM module's exports to populate. The Emscripten
        // `.then()` callback often never fires from inside a vm context, so
        // poll `_em.asm` instead.
        const start = Date.now();
        while (Object.keys(em.asm).length === 0) {
            if (Date.now() - start > 10000) {
                throw new Error("Cubism Core WASM init timed out after 10s");
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
        return ns;
    })();
    return loadedCorePromise;
}
