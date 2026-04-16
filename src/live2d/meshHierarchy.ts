import { readFileSync } from "node:fs";
import { loadCubismCore } from "./cubismCore.js";

export interface MeshGroup {
    /** Stable identifier — either a Live2D Part ID or an individual ArtMesh ID at the finest granularity. */
    readonly id: string;
    /** Live2D ArtMesh IDs that belong to this buyable unit. */
    readonly meshIds: readonly string[];
}

export interface MeshHierarchy {
    readonly totalParts: number;
    readonly totalDrawables: number;
    /** Deepest part-tree depth in this model (0 = roots have no children). */
    readonly maxDepth: number;
    /** Map of granularity level → number of buyable units at that level. */
    readonly granularityLevels: ReadonlyMap<number, number>;
    /** Granularity level whose buyable-unit count is closest to the target. */
    readonly recommendedLevel: number;
    /** All valid granularity levels (0 through maxDepth + 1, inclusive). */
    readonly availableLevels: readonly number[];
    /**
     * Return the buyable units at a given granularity level.
     * - Level N (0..maxDepth): expose parts at depth ≤ N. Parts whose children all live at depth > N
     *   become buyable units with all descendant ArtMeshes rolled up.
     * - Level maxDepth + 1: every individual ArtMesh is its own unit.
     */
    getGroupsAtLevel(level: number): MeshGroup[];
}

/**
 * Parse a `.moc3` file and analyse its part hierarchy.
 *
 * @param mocPath        Filesystem path to the `.moc3` file.
 * @param targetGroupCount  Group count used to recommend a default granularity (defaults to 30).
 */
export async function analyzeMeshHierarchy(
    mocPath: string,
    targetGroupCount = 30,
): Promise<MeshHierarchy> {
    const Live2DCubismCore = await loadCubismCore();
    const mocBytes = readFileSync(mocPath);
    const moc = Live2DCubismCore.Moc.fromArrayBuffer(new Uint8Array(mocBytes).buffer);
    if (!moc) throw new Error(`Cubism Core could not parse ${mocPath}`);
    const model = Live2DCubismCore.Model.fromMoc(moc);
    if (!model) throw new Error(`Cubism Core could not instantiate model from ${mocPath}`);

    const partIds: string[] = [...model.parts.ids];
    const partParents: number[] = [...model.parts.parentIndices];
    const drawableIds: string[] = [...model.drawables.ids];
    const drawableParents: number[] = [...model.drawables.parentPartIndices];

    // Memoised depth-of-part lookup.
    const partDepths = new Array<number>(partIds.length);
    const computeDepth = (i: number): number => {
        const memo = partDepths[i];
        if (memo !== undefined) return memo;
        const parent = partParents[i] ?? -1;
        const d = parent < 0 ? 0 : 1 + computeDepth(parent);
        partDepths[i] = d;
        return d;
    };
    for (let i = 0; i < partIds.length; i++) computeDepth(i);
    const maxDepth = partDepths.length === 0 ? 0 : Math.max(...partDepths);

    // childrenByPart[i] = indices of parts whose parent is i
    const childrenByPart: number[][] = partIds.map(() => []);
    for (let i = 0; i < partIds.length; i++) {
        const parent = partParents[i] ?? -1;
        if (parent >= 0) childrenByPart[parent]!.push(i);
    }

    // drawablesByPart[i] = drawable IDs directly assigned to part i
    const drawablesByPart: string[][] = partIds.map(() => []);
    for (let i = 0; i < drawableIds.length; i++) {
        const parent = drawableParents[i] ?? -1;
        if (parent >= 0 && parent < partIds.length) {
            drawablesByPart[parent]!.push(drawableIds[i]!);
        }
    }

    const allDescendantDrawables = (partIdx: number): string[] => {
        const out: string[] = [...drawablesByPart[partIdx]!];
        for (const child of childrenByPart[partIdx]!) {
            out.push(...allDescendantDrawables(child));
        }
        return out;
    };

    const finestLevel = maxDepth + 1;

    const getGroupsAtLevel = (level: number): MeshGroup[] => {
        if (level >= finestLevel) {
            return drawableIds.map((id) => ({ id, meshIds: [id] }));
        }
        if (level < 0) {
            throw new Error(`Granularity level must be ≥ 0, got ${level}`);
        }
        // A part is "buyable" at this level iff its depth ≤ level AND none of its
        // children have depth ≤ level (i.e. it's a leaf when the tree is truncated).
        const groups: MeshGroup[] = [];
        for (let i = 0; i < partIds.length; i++) {
            if (partDepths[i]! > level) continue;
            const hasShallowChild = childrenByPart[i]!.some(
                (childIdx) => partDepths[childIdx]! <= level,
            );
            if (hasShallowChild) continue;
            groups.push({ id: partIds[i]!, meshIds: allDescendantDrawables(i) });
        }
        return groups;
    };

    const granularityLevels = new Map<number, number>();
    const availableLevels: number[] = [];
    for (let lv = 0; lv <= finestLevel; lv++) {
        granularityLevels.set(lv, getGroupsAtLevel(lv).length);
        availableLevels.push(lv);
    }

    let recommendedLevel = 0;
    let bestDiff = Infinity;
    for (const [lv, count] of granularityLevels) {
        const diff = Math.abs(count - targetGroupCount);
        if (diff < bestDiff) {
            bestDiff = diff;
            recommendedLevel = lv;
        }
    }

    return {
        totalParts: partIds.length,
        totalDrawables: drawableIds.length,
        maxDepth,
        granularityLevels,
        recommendedLevel,
        availableLevels,
        getGroupsAtLevel,
    };
}
