// 验证"自动恢复"的判定函数：只有前台是空闲 shell 的 pane 才允许往里打命令（纯逻辑，不依赖 gpui 运行时）
// 背景：重启机器、注销、核心重启后，核心用同地址、同目录补一个 shell，tab/pane/标签/cwd 都还在；
// 前台跑着别的程序时一律不碰，往别人的程序里打字是破坏行为。
// 判定用 panes()[i].program.shell，Herdr 自己的 spaces 侧栏判"这个 pane 是否在忙"用的也是它。

// —— 与 main.js 保持一致（照抄，改动时同步）——
function shouldRestore(pane) {
  return Boolean(pane) && pane.program?.shell === true;
}

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "PASS  " : "FAIL  ") + msg); if (!cond) fail++; };

// 正常的 shell pane：tab 还在，TUI 丢了，可以打命令
ok(shouldRestore({ pane: "p7", terminal: "t7", program: { key: "shell", shell: true } }), "前台是 shell → 恢复");
// TUI 还在跑：不碰
ok(!shouldRestore({ pane: "p9", terminal: "t9r", program: { key: "lazygit", shell: false } }), "前台是程序 → 不碰");
// agent 还在跑：不碰
ok(!shouldRestore({ pane: "p3", terminal: "t103", program: { key: "pi", shell: false, agent: true } }), "前台是 agent → 不碰");
// tab/pane 整个不在了（claimedPane 返回 null）
ok(!shouldRestore(null), "认领不到 pane → 不碰");
ok(!shouldRestore(undefined), "pane 不存在 → 不碰");
// program 缺失（数据还没到）：宁可不发
ok(!shouldRestore({ pane: "p5", terminal: "t5" }), "没有 program 信息 → 不碰");
ok(!shouldRestore({ pane: "p5", terminal: "t5", program: {} }), "program 里没有 shell 字段 → 不碰");
// mod pane（terminal 为 null，只有 pane 和 mod）：不是 shell，不碰
ok(!shouldRestore({ pane: "p8", terminal: null, mod: "files", program: { shell: false } }), "mod pane → 不碰");

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
