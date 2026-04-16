import { analyzeMeshHierarchy } from "../dist/live2d/index.js";

const h = await analyzeMeshHierarchy("c:/Users/aleck/Documents/Sarxina/Assets/Model/Sarxina/Sarxina.moc3");

console.log("totalParts:    ", h.totalParts);
console.log("totalDrawables:", h.totalDrawables);
console.log("maxDepth:      ", h.maxDepth);
console.log("recommendedLevel:", h.recommendedLevel);
console.log("granularityLevels:");
for (const [lv, count] of h.granularityLevels) {
    const marker = lv === h.recommendedLevel ? " ← recommended" : "";
    console.log(`  level ${lv}: ${count} buyable units${marker}`);
}

const recommended = h.getGroupsAtLevel(h.recommendedLevel);
console.log(`\nGroups at recommended level (${recommended.length} units):`);
for (const g of recommended.slice(0, 10)) {
    console.log(`  ${g.id} → ${g.meshIds.length} meshes`);
}
if (recommended.length > 10) console.log(`  ...and ${recommended.length - 10} more`);
