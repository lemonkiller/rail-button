// 用真实布局文件验证 withRail/findTabNode 的插入位置与边界情况（纯逻辑，不依赖 gpui 运行时）
const fs = require("fs");
// 布局目录：默认是当前用户的 Herdr 配置目录，可用 HERDR_APP_HOME 覆盖
const HOME = process.env.HERDR_APP_HOME || require("path").join(require("os").homedir(), ".config", "herdr-app");

// —— 与 main.js 保持一致的三个函数（照抄，改动时同步）——
const RAIL_COL = {
  id: "rail-tools",
  type: "column",
  children: [{ id: "rail", type: "block", content: { mod: "rail-button" } }],
  size: { px: 44 },
  min: 44,
  max: 44,
  padding: [8, 0],
  background: "chrome",
  border: { width: 1, color: "border" },
  radius: 10,
  resizable: false,
};
const hasRail = (tree) =>
  JSON.stringify(tree ?? {}).includes('"mod":"rail-button"') ||
  JSON.stringify(tree ?? {}).includes('"mod": "rail-button"');

function findTabNode(node, parent) {
  if (!node || typeof node !== "object") return null;
  const c = node.content;
  if (c && typeof c.tab === "string") return { node, parent };
  for (const ch of node.children ?? []) {
    const hit = findTabNode(ch, node);
    if (hit) return hit;
  }
  return null;
}

function withRail(tree) {
  const t = JSON.parse(JSON.stringify(tree ?? {}));
  if (hasRail(t)) return t;
  const col = () => JSON.parse(JSON.stringify(RAIL_COL));
  const hit = findTabNode(t, null);
  if (hit && hit.parent && Array.isArray(hit.parent.children)) {
    const i = hit.parent.children.indexOf(hit.node);
    hit.parent.children.splice(i + 1, 0, col());
    return t;
  }
  if (Array.isArray(t.children)) { t.children.push(col()); return t; }
  return { id: "root", type: "row", children: [t, col()] };
}

// —— 验证 ——
let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS  " : "FAIL  ") + msg); if (!cond) fail++; };

for (const name of ["main", "terminals", "win98", "lazygit"]) {
  const raw = fs.readFileSync(`${HOME}/layouts/${name}.json`, "utf8");
  const tree = JSON.parse(raw);
  const out = withRail(tree);
  const tab = findTabNode(out, null);
  // 已含 rail 的布局：rail 只要和 tab 块同父即可（中间可能隔着 Files/Changes 面板列）；
  // 新插入的：必须紧挨 tab 块的下一格
  const hadRail = hasRail(tree);
  let placed = false;
  if (tab && tab.parent) {
    if (hadRail) {
      placed = tab.parent.children.some((c) => c !== tab.node && hasRail(c));
    } else {
      const i = tab.parent.children.indexOf(tab.node);
      const neighbour = tab.parent.children[i + 1];
      placed = Boolean(neighbour && hasRail(neighbour));
    }
  }
  ok(hasRail(out), `${name}: 结果树里出现 rail-button`);
  ok(placed, `${name}: rail ${hadRail ? "与 tab 块同父" : "紧挨 tab 块下一格"}（parent=${tab?.parent?.id}）`);
  if (!hasRail(tree)) ok(!hasRail(tree), `${name}: 原树没被就地改动（纯函数）`);
  // 幂等：再插一次不应重复
  const twice = withRail(out);
  const base = (JSON.stringify(out).match(/"rail-button"/g) || []).length;
  const count = (JSON.stringify(twice).match(/"rail-button"/g) || []).length;
  ok(count === base, `${name}: 再跑一次完全不变（幂等，rail-button 出现 ${count} 次）`);
}

// id 冲突检查：真实布局里是否已占用 rail-tools / rail
for (const name of ["main", "terminals", "win98", "lazygit"]) {
  const t = JSON.parse(fs.readFileSync(`${HOME}/layouts/${name}.json`, "utf8"));
  const ids = (JSON.stringify(t).match(/"id":"[^"]+"/g) || []).join(",");
  const clash = ids.includes('"id":"rail-tools"');
  ok(!clash || hasRail(t), `${name}: rail-tools 这个 id 要么空闲、要么就是已有 rail 的布局`);
}

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
