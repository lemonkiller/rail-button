// rail-button: a sidebar button rail. Click a button to run its bound command in a new tab, click again to close it.
// Buttons are data (a command + a name); the + at the bottom adds one through a form, right-click a button to delete it.
// Icons are matched automatically: first look for mods/rail-button/icons/<first word of command>.svg, then herdr's icons/<first word>.svg,
// and fall back to a first-letter color block when neither exists. The user never picks an icon.
//
// Contract: a button owns at most one tab per space, and both open and close act only on the current space (2026-11-07 decision:
// the old "unique across the whole net" contract would claim a tab from another space and close it, which is not what is expected). Two layers enforce this:
// 1) Stable id: the button id is derived from the command (cmd_<first word>), so the shared record key stays stable and rebuilding the button never breaks the chain.
//    Record shape: rail.tab.<id> = { [spaceId]: { folder, tabId, at, failedAt? } }, keyed per space.
// 2) Label claiming: after settle, tag the terminal with rail=<id> (stored in the core of the machine it runs on, queryable across the net).
//    The local shared record is only a cache; when re-finding a tab only tabs in the current space count, and tabs in other spaces are never touched.
// 3) Tabs with named=false (their name has degraded to a positional number) are renamed back to the program name by the display guard -- cross-machine snapshot
//    write-back clobbers the named flag, and the guard makes the name heal within 5 seconds. Tabs the user named manually (named=true) are never touched.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  run, theme, shared, setShared, spaces, panes, terminals, focused, appHome, hc,
  props, openOverlay, closeOverlay, readTextFile, writeTextFile, notify,
} from "herdr";

const KEY = "rail.buttons";
const OWN_ICONS = "mods/rail-button/icons/";
const LIB_ICONS = "icons/";
const BUSY_MS = 6000;    // record exists but no tabId yet: wait at most this long
const GONE_MS = 1500;    // after opening, wait this long before checking whether the command exited immediately + fixing the name
const COOL_MS = 600;     // cooldown after closing, blocks "close and immediately reopen"
const DRAG_PX = 4;       // moving more than this many pixels while pressed counts as a drag, otherwise as a click (stops shaky hands from reordering)
const FAIL_COOL_MS = 2000; // cooldown after a confirmed failure, so clicking repeatedly shows the notification only once

const recKey = (id) => "rail.tab." + id;
const firstWord = (cmd) => (String(cmd ?? "").trim().split(/\s+/)[0] ?? "");
const stableId = (cmd) => "cmd_" + firstWord(cmd);

// Seed the original two buttons on first use; their icons are already copied into this mod's icons/
const SEED = [
  { id: "cmd_yazi", cmd: "yazi", title: "yazi" },
  { id: "cmd_lazygit", cmd: "lazygit", title: "lazygit" },
];

function buttons() {
  const v = shared(KEY);
  return Array.isArray(v) ? v : SEED;
}

function activeSpace() {
  return spaces().find((s) => s.active) ?? null;
}

function folderOf(space) {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || space?.folder || null;
}

// Find terminals tagged rail=<id> across the whole net (on any machine)
function railTerminals(b) {
  const out = [];
  for (const t of terminals()) {
    if (t.labels?.rail === b.id) out.push(t);
  }
  return out;
}

// terminal address -> owning tab id (through the pane mapping)
function tabOfTerminal(addr) {
  return panes().find((p) => p.terminal === addr)?.tab ?? null;
}

// Tag the terminal of a tab with the rail label. Remote calls go through hc exec --on and the core's built-in channel (does not depend on PATH);
// the address is stripped of its machine prefix because the target machine's hc only accepts bare local addresses. The receipt is written to tag.log for diagnostics.
function tagTerminal(b, tabId, space) {
  const pane = panes().find((p) => p.tab === tabId && p.terminal);
  if (!pane?.terminal) return;
  const addr = pane.terminal.split("/").pop();
  const machine = space?.machine;
  const args = machine ? ["exec", "--on", machine, "hc", "label", addr, "rail=" + b.id]
                       : ["label", addr, "rail=" + b.id];
  hc(args).then(async (r) => {
    const home = appHome().replace(/\\/g, "/");
    const old = await readTextFile(home + "/mods/rail-button/tag.log");
    const line = `${Date.now()} rail=${b.id} addr=${addr} on=${machine ?? "local"} code=${r.code} err=${String(r.stderr).slice(0, 100)}\n`;
    await writeTextFile(home + "/mods/rail-button/tag.log", (old ?? "") + line, old);
  }).catch(async (e) => {
    const home = appHome().replace(/\\/g, "/");
    const old = await readTextFile(home + "/mods/rail-button/tag.log");
    await writeTextFile(home + "/mods/rail-button/tag.log", (old ?? "") + `${Date.now()} FAIL rail=${b.id} ${e}\n`, old);
  });
}

// A button's tab: three-step resolution, all scoped to the current space -- shared record -> label claim (restoring the record on the way) -> none
// label claiming never searches the whole net: a same-labelled tab in another space counts as absent, otherwise clicking a button would claim and close another space's tab
function ourTab(b, space) {
  if (!space) return null;
  const key = recKey(b.id);
  const recs = shared(key) ?? {};
  const rec = recs[space.id];
  const tabs = space.tabs ?? [];
  if (rec?.tabId) {
    const hit = tabs.find((t) => t.id === rec.tabId);
    if (hit) return hit;
  }
  for (const t of railTerminals(b)) {
    const tabId = tabOfTerminal(t.address);
    if (!tabId) continue;
    const hit = tabs.find((x) => x.id === tabId);
    if (!hit) continue;
    const next = Object.assign({}, recs);
    next[space.id] = { folder: folderOf(space), tabId, at: Date.now() };
    setShared(key, next);
    return hit;
  }
  return null;
}

// Identify "this button's" tab among the candidates: the terminal argv contains the command's first word. When different buttons are clicked in
// quick succession, the previous button's tab can fall inside this call's candidate window and claiming "the last one" picks the wrong tab -- observed
// 2026-11-07 (the cmd_redi and cmd_backlog records pointed at the same tab, and the name flip-flopped between redi and backlog).
function pickMine(b, space, before) {
  const w = firstWord(b.cmd).toLowerCase();
  if (!w) return null;
  for (const t of (space?.tabs ?? [])) {
    if (before.has(t.id)) continue;
    const addr = panes().find((p) => p.tab === t.id && p.terminal)?.terminal;
    if (!addr) continue;
    const term = terminals().find((x) => x.address === addr);
    const haystack = ((term?.argv ?? []).join(" ") + " " + String(term?.name ?? "")).toLowerCase();
    if (haystack.includes(w)) return t;
  }
  return null;
}

// Current state of a button (current space only: an opening/failed cooldown in another space must not block clicks here)
function stateOf(b) {
  const space = activeSpace();
  const recs = space ? shared(recKey(b.id)) : null;
  const rec = recs ? recs[space.id] : null;
  const tab = ourTab(b, space);
  if (tab) return { kind: "open", tab, space };
  if (rec?.tabId && Date.now() - (rec.at ?? 0) < 2000) return { kind: "opening", space }; // just opened, outcome unknown (the command may exit immediately)
  if (rec?.failedAt && Date.now() - rec.failedAt < FAIL_COOL_MS) return { kind: "failed", space };
  if (rec && !rec.tabId && Date.now() < (rec.at ?? 0) + BUSY_MS) return { kind: "opening", space };
  return { kind: "closed", space };
}

// First-letter color block: the same name always gets the same color, and no file is needed
function letter(t, name) {
  const colors = ["ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6"];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % colors.length;
  const ch = (String(name).trim()[0] ?? "?").toUpperCase();
  return h_flex().size(16).flex_none().rounded(4).bg(t[colors[h]])
    .items_center().justify_center()
    .text_size(9.5).font_semibold().text_color(t.background).child(ch);
}

function button(t, id, text, primary, action) {
  return h_flex().id(id).h(32).px(14).items_center().rounded(8)
    .border_1().border_color(primary ? t.solid : t.input)
    .bg(primary ? t.solid : t.raised)
    .text_color(primary ? t.solid_foreground : t.foreground)
    .text_size(12.5).font_medium().cursor_pointer()
    .hover((s) => s.opacity(0.88)).on_click(action).child(text);
}

export default class RailButton extends View {
  init(_props, cx) {
    this.mode = props()?.mode ?? "rail";
    this.icons = {};
    this.loading = false;

    if (this.mode === "add") {
      this.cmd = "";
      this.name = "";
      this.cmdInput = InputState.new({ placeholder: "Command, for example lazygit or npm run dev" });
      this.nameInput = InputState.new({ placeholder: "Leave empty to use the command's first word" });
      this.cmdInput.on("change", (_e, cx) => { this.cmd = this.cmdInput.value(); cx.notify(); });
      this.nameInput.on("change", (_e, cx) => { this.name = this.nameInput.value(); cx.notify(); });
      this.cmdInput.on("submit", () => this.saveAdd());
      this.nameInput.on("submit", () => this.saveAdd());
      this.handle = cx.focus_handle();
      this.cmdInput.focus();
      cx.timer.after(600, () => this.cmdInput.focus());
      return;
    }

    if (this.mode === "remove") {
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }

    // the rail itself
    this.migrate();
    this.lockAt = 0;
    // Drag-reorder state: pressed = the button that was pressed, over = the current drop target, dragMoved = the threshold was crossed, pressPos = window coordinates at press time
    this.pressed = null;
    this.over = null;
    this.dragMoved = false;
    this.pressPos = null;
    cx.spawn(async (cx) => this.loadIcons(cx));
    this.watch(cx);
  }

  // Migrate buttons and records with old random ids to stable ids; migrate old single-record entries (with a spaceId field) to per-space keys (both one-shot and idempotent)
  migrate() {
    const list = buttons().slice();
    let changed = false;
    for (const b of list) {
      const nid = stableId(b.cmd);
      if (!nid || b.id === nid) continue;
      const old = shared(recKey(b.id));
      if (old && !shared(recKey(nid))) setShared(recKey(nid), old);
      setShared(recKey(b.id), null);
      b.id = nid;
      changed = true;
    }
    if (changed) setShared(KEY, list);
    for (const b of list) {
      const key = recKey(b.id);
      const rec = shared(key);
      if (rec && typeof rec === "object" && typeof rec.spaceId === "string") {
        const rest = {};
        for (const k of Object.keys(rec)) { if (k !== "spaceId") rest[k] = rec[k]; }
        const migrated = {};
        migrated[rec.spaceId] = rest;
        setShared(key, migrated);
      }
    }
  }

  // Icon auto-matching: this mod's icon directory first, then herdr's icon library, and null (first letter) when neither has it
  async loadIcons(cx) {
    if (this.loading) return;
    this.loading = true;
    const home = appHome().replace(/\\/g, "/");
    for (const b of buttons()) {
      const w = firstWord(b.cmd);
      if (!w || w in this.icons) continue;
      this.icons[w] = null;
      for (const path of [OWN_ICONS + w + ".svg", LIB_ICONS + w + ".svg"]) {
        const text = await readTextFile(home + "/" + path);
        if (text) { this.icons[w] = path; break; }
      }
    }
    this.loading = false;
    cx.notify();
  }

  // Two guard layers, sweeping every 5 seconds:
  // 1) the rail's own tabs: within a 60-second window after creation, restore the button name if it got clobbered; stop after the window.
  // 2) all numeric tabs: named=false means the name has degraded to a positional number (tabs the user named manually have named=true
  //    and are never touched); rename them back to the program name as herdr's display layer intends. No window limit, because cross-machine
  //    snapshot write-back can happen again at any time.
  // 3) multiple terminals with the same label in one space (leftovers of millisecond-level concurrent clicks): keep the earliest created and kill
  //    the rest; coexistence across spaces is legitimate, so nothing is killed there.
  watch(cx) {
    cx.timer.every(5000, (cx) => {
      // Guard 1: the rail's own tabs; restore the button name if it got clobbered within 60 seconds of creation; walk the per-space records one by one
      for (const b of buttons()) {
        const recs = shared(recKey(b.id)) || {};
        for (const sid of Object.keys(recs)) {
          const rec = recs[sid];
          if (!rec || !rec.tabId || Date.now() - (rec.at ?? 0) > 60000) continue;
          const sp = spaces().find((s) => s.id === sid);
          const tab = sp ? (sp.tabs || []).find((t) => t.id === rec.tabId) : null;
          if (tab && tab.name !== b.title) run("tab.rename", { id: rec.tabId, name: b.title });
        }
      }
      // Guard 2: rename named=false numeric tabs back to the program name; tabs the user named manually (named=true) are never touched
      const done = new Set();
      for (const p of panes()) {
        if (!p.terminal || !p.program?.name || done.has(p.tab)) continue;
        done.add(p.tab);
        const sp = spaces().find((s) => s.tabs.some((t) => t.id === p.tab));
        const tab = sp?.tabs.find((t) => t.id === p.tab);
        if (tab && !tab.named && tab.name !== p.program.name) {
          run("tab.rename", { id: p.tab, name: p.program.name });
        }
      }
      // Guard 3: multiple terminals with the same label in one space (leftovers of millisecond-level concurrent clicks); keep the earliest, kill the rest; coexistence across spaces is legitimate, so nothing is killed there
      const byRail = {};
      for (const t of terminals()) {
        const r = t.labels?.rail;
        if (!r) continue;
        const tabId = tabOfTerminal(t.address);
        let sid = "?";
        if (tabId) {
          const sp = spaces().find((s) => s.tabs.some((x) => x.id === tabId));
          if (sp) sid = sp.id;
        }
        if (!byRail[r]) byRail[r] = {};
        const g = byRail[r];
        (g[sid] = g[sid] || []).push(t);
      }
      for (const groups of Object.values(byRail)) {
        for (const list of Object.values(groups)) {
          if (list.length <= 1) continue;
          list.sort((a, b) => (a.created_ms ?? 0) - (b.created_ms ?? 0));
          for (const t of list.slice(1)) run("terminal.kill", { terminal: t.address });
        }
      }
    });
  }

  saveAdd() {
    const cmd = String(this.cmd ?? "").trim();
    if (!cmd) return;
    const nid = stableId(cmd);
    if (buttons().some((x) => x.id === nid)) {
      notify({ title: "A button for this command already exists", body: `${cmd} is already on the rail`, level: "warning", timeout: 4000 });
      closeOverlay(props().overlay);
      return;
    }
    const title = String(this.name ?? "").trim() || firstWord(cmd);
    const list = buttons().slice();
    list.push({ id: nid, cmd, title });
    setShared(KEY, list);
    closeOverlay(props().overlay);
  }

  doRemove(id) {
    const list = buttons().filter((x) => x.id !== id);
    setShared(KEY, list);
    setShared(recKey(id), null);
    closeOverlay(props().overlay);
  }

  // Release: if it was dragged and has a different drop target -> reorder; otherwise treat it as a click that toggles the tab. State is cleared either way.
  drop(cx) {
    const from = this.pressed;
    const over = this.over;
    const moved = this.dragMoved;
    this.pressed = null;
    this.over = null;
    this.dragMoved = false;
    this.pressPos = null;
    if (from === null) return;
    if (moved) {
      if (over && over !== from) this.reorder(from, over);
      cx.notify();
      return;
    }
    if (over === from) {
      const b = buttons().find((x) => x.id === from);
      if (b) this.toggle(b, cx);
    }
    cx.notify();
  }

  // Reorder: take the dragged button by id, insert it at the position the drop target button currently sits at, and write back to shared (order is render order).
  reorder(fromId, overId) {
    const list = buttons().slice();
    const a = list.findIndex((x) => x.id === fromId);
    const b = list.findIndex((x) => x.id === overId);
    if (a < 0 || b < 0 || a === b) return;
    const [moved] = list.splice(a, 1);
    list.splice(b, 0, moved);
    setShared(KEY, list);
  }

  toggle(b, cx) {
    // Same-frame rapid-click lock: writes to shared go through her process, so they cannot be expected to be visible in the same frame
    if (this.lockAt && Date.now() - this.lockAt < 350) return;
    this.lockAt = Date.now();
    const st = stateOf(b);
    if (st.kind === "opening" || st.kind === "failed") return; // opening or just failed: swallow the click
    if (!st.space) return;
    if (st.kind === "open") this.closing(b, st.tab, st.space.id, cx);
    else this.open(b, st.space, cx);
  }

  closing(b, tab, spaceId, cx) {
    // Keep the record for verification; a cross-machine close may fail silently, so retry up to 3 times starting at 600ms and clear the record only once the tab is confirmed gone
    // Only this space's record key is cleared; if another space also has this button's tab open, its record is untouched
    run("tab.close", { id: tab.id, confirmed: true });
    const tryClose = (cx, n) => {
      cx.timer.after(600 * n, (cx) => {
        const sp = spaces().find((s) => s.id === spaceId);
        const still = (sp?.tabs ?? []).find((t) => t.id === tab.id);
        const drop = () => {
          const recs = Object.assign({}, shared(recKey(b.id)));
          delete recs[spaceId];
          setShared(recKey(b.id), recs);
        };
        if (!still) { drop(); cx.notify(); return; }
        if (n < 3) { run("tab.close", { id: tab.id, confirmed: true }); tryClose(cx, n + 1); return; }
        drop();
        notify({ title: "Close failed", body: `The tab for ${b.title} cannot be closed, please close it manually`, level: "error", timeout: 5000 });
      });
    };
    tryClose(cx, 1);
  }

  open(b, space, cx) {
    const key = recKey(b.id);
    const folder = folderOf(space);
    if (!folder) return;
    const argv = String(b.cmd).trim().split(/\s+/).filter(Boolean);
    if (!argv.length) return;

    const before = new Set((space.tabs ?? []).map((t) => t.id));
    // Claim the slot first: every later click sees opening and will not open another tab
    setShared(key, Object.assign({}, shared(key), { [space.id]: { folder, tabId: null, at: Date.now() } }));
    run("tab.new", { name: b.title, folder, argv });

    const settle = (tabId, cx) => {
      setShared(key, Object.assign({}, shared(key), { [space.id]: { folder, tabId, at: Date.now() } }));
      run("tab.rename", { id: tabId, name: b.title }); // tab.new's name can be lost across machines, set it once more
      tagTerminal(b, tabId, space);                    // apply the rail label, the basis for claiming across the net
      cx.notify();
      // 1.5s later: no tab = the command did not start; name clobbered = set it again
      cx.timer.after(GONE_MS, (cx) => {
        const recs = shared(key);
        const rec = recs ? recs[space.id] : null;
        if (rec?.tabId !== tabId) return; // another action took over the state; do not report a false failure
        const sp = space;
        const tab = (sp?.tabs ?? []).find((t) => t.id === tabId);
        if (!tab) {
          setShared(key, Object.assign({}, shared(key), { [space.id]: { failedAt: Date.now() } }));
          notify({ title: "Command did not start", body: `${b.cmd} exited immediately: it may not be installed, or it may be a shell built-in (such as dir)`, level: "error", timeout: 5000 });
          cx.notify();
          return;
        }
        if (tab.name !== b.title) { run("tab.rename", { id: tabId, name: b.title }); cx.notify(); }
        // Re-apply the label: on the fast path the pane often does not exist yet when settle runs, so the first tagging attempt is a no-op; the tab is stable now, so apply it again idempotently
        tagTerminal(b, tabId, space);
      });
    };

    // Fast path: right after tab.new returns the new tab is usually already in spaces()
    const hit = pickMine(b, spaces().find((s) => s.id === space.id), before);
    if (hit) { settle(hit.id, cx); return; }

    // Fallback: short polling; exit as soon as someone writes a tabId, never create a duplicate
    cx.spawn(async (cx) => {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => cx.timer.after(80, r));
        const recs = shared(key);
        if (recs && recs[space.id] && recs[space.id].tabId) return;
        const hit = pickMine(b, spaces().find((s) => s.id === space.id), before);
        if (hit) { settle(hit.id, cx); return; }
      }
      setShared(key, Object.assign({}, shared(key), { [space.id]: { folder, tabId: null, at: 0 } }));
      cx.notify();
    });
  }

  // The sidebar body: a column of buttons with a + at the end
  rail(cx) {
    const t = theme();
    const list = buttons();
    const space = activeSpace();
    if (list.some((b) => !(firstWord(b.cmd) in this.icons))) this.loadIcons(cx);

    // Row: a left press records the position, moving beyond DRAG_PX starts a drag, releasing on a different target reorders; without a drag it counts as a click that toggles the tab.
    // While dragging: the dragged button is translucent and an accent line is drawn at the drop target's edge (the same feel as the official spaces sidebar).
    const fromIndex = this.pressed === null ? -1 : list.findIndex((x) => x.id === this.pressed);
    const row = (b) => {
      const recs = space ? shared(recKey(b.id)) : null;
      const rec = recs ? recs[space.id] : null;
      const tab = ourTab(b, space);
      const open = Boolean(tab);
      const opening = !open && rec && !rec.tabId && Date.now() < (rec.at ?? 0) + BUSY_MS;
      const failed = !open && Boolean(rec?.failedAt) && Date.now() - rec.failedAt < FAIL_COOL_MS;
      const path = this.icons[firstWord(b.cmd)];
      const i = list.findIndex((x) => x.id === b.id);
      const dragging = this.pressed === b.id && this.dragMoved;
      const dropAt = this.dragMoved && this.pressed !== null && this.over === b.id && this.over !== this.pressed;
      return h_flex().id("rb-" + b.id).size(30).flex_none().items_center().justify_center().rounded(7)
        .relative()
        .when(dragging, (el) => el.opacity(0.4))
        .when(dropAt, (el) => el.child(
          div().absolute().left(4).right(4).h(2).rounded(1).bg(t.accent)
            .when(fromIndex < i, (line) => line.bottom(-4))
            .when(fromIndex > i, (line) => line.top(-4))))
        .text_color(open ? t.accent : failed ? t.blocked : opening ? t.dim : t.muted)
        .when(open, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(b.title + (open ? ": click to close" : failed ? ": the command did not start, try again later or right-click to delete" : opening ? ": opening..." : ": click to open, hold and drag to reorder, right-click to delete"))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = b.id;
          this.over = b.id;
          this.dragMoved = false;
          this.pressPos = e.position ? { x: e.position.x, y: e.position.y } : null;
        })
        .on_mouse_move((e, cx) => {
          if (this.pressed === null) return;
          if (!this.dragMoved && this.pressPos && e.position) {
            const dx = e.position.x - this.pressPos.x;
            const dy = e.position.y - this.pressPos.y;
            if (dx * dx + dy * dy > DRAG_PX * DRAG_PX) this.dragMoved = true;
          }
          if (!this.dragMoved) return;
          if (this.over !== b.id) { this.over = b.id; cx.notify(); }
        })
        .on_mouse_up("left", (_e, cx) => this.drop(cx))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          this.pressed = null;
          this.over = null;
          this.dragMoved = false;
          openOverlay({ mod: "rail-button", kind: "dialog", width: 360, props: { mode: "remove", id: b.id } });
        })
        .child(path ? svg(path).size(16) : letter(t, b.title));
    };

    const add = h_flex().id("rb-add").size(30).flex_none().items_center().justify_center().rounded(7)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip("Add button")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => openOverlay({ mod: "rail-button", kind: "dialog", width: 420, props: { mode: "add" } }))
      .child(svg("mods/workspace-chrome/plus.svg").size(14));

    return v_flex().size_full().items_center().pt(6).gap(6).overflow_y_scrollbar()
      .on_mouse_up("left", (_e, cx) => this.drop(cx)) // releasing in the gap between buttons still lands the drop
      .on_mouse_down_out((_e, cx) => {                // pressing outside the rail: clear any leftover drag state
        this.pressed = null;
        this.over = null;
        this.dragMoved = false;
        this.pressPos = null;
        cx.notify();
      })
      .children(list.map(row))
      .child(add);
  }

  addForm() {
    const t = theme();
    const p = props() ?? {};
    const label = (text) => div().pt(14).pb(6).text_size(11.5).text_color(t.dim).child(text);
    const field = (state) => Input.new(state).h(36).px(10).rounded(9)
      .border_1().border_color(t.input).bg(t.background)
      .text_size(12.8).text_color(t.foreground);
    return v_flex().id("rb-add-form").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); }
      })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Add button"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Command"))
      .child(field(this.cmdInput))
      .child(label("Name"))
      .child(field(this.nameInput))
      .child(div().pt(6).text_size(11.5).text_color(t.dim).child("Leave empty to use the command's first word. The icon is matched automatically from the command name."))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button(t, "rb-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button(t, "rb-save", "Add", true, () => this.saveAdd())));
  }

  removeForm() {
    const t = theme();
    const p = props() ?? {};
    const b = buttons().find((x) => x.id === p.id);
    return v_flex().id("rb-remove-form").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "enter") { if (b) this.doRemove(p.id); else closeOverlay(p.overlay); cx.stop_propagation(); }
        else if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); }
      })
      .w_full().min_h(0).p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child(`Delete ${b ? b.title : "this button"}?`))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_size(12.5).text_color(t.muted).child(b ? `Command: ${b.cmd}` : "This button no longer exists"))
      .child(h_flex().justify_end().gap(8)
        .child(button(t, "rb-no", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button(t, "rb-yes", "Delete", true, () => (b ? this.doRemove(p.id) : closeOverlay(p.overlay)))));
  }

  render(cx) {
    if (this.mode === "add") return this.addForm();
    if (this.mode === "remove") return this.removeForm();
    return this.rail(cx);
  }
}
