// 像素场景装饰工坊 —— 纯前端、无构建步骤。需要通过本地静态服务器打开（见 AGENTS.md）。
//
// 坐标模型：所有摆放物件用房间内的像素坐标(x,y)定位（左上角），不是格子坐标。
// GRID 只用来画参考网格线、以及"对齐网格"开启时的吸附单位。
// 有"关卡"数据的主题：房间尺寸 = 原图尺寸(px)，可以打乱/一键还原成原图布局。
// 没有关卡数据的主题：房间尺寸由顶部"房间尺寸"手动控制，自由摆放。

const CATEGORY_LABELS = { floor: "地板", wall: "墙体", furniture: "家具", prop: "道具", decor: "装饰" };
const CATEGORY_ORDER = ["floor", "wall", "furniture", "prop", "decor"];
// BHLHG04 同时包含完整餐桌和桌面/椅子等零件。MVP 先把明显的零件重复项留在
// 素材目录中但不放进调色板，避免用户误把“半张桌子”与完整桌子叠加使用。
const HIDDEN_MVP_ASSETS = new Set([
  ...[3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 16, 28, 29]
    .map(n => `八合里火锅/furniture/餐桌${String(n).padStart(2, "0")}`),
]);
const STORAGE_PREFIX = "decorator:layout:";
const DEFAULT_ROOM_COLS = 14, DEFAULT_ROOM_ROWS = 10;

let manifest = { gridUnit: 64, items: [], layouts: [] };
let GRID = 64;
let roomW = DEFAULT_ROOM_COLS * GRID, roomH = DEFAULT_ROOM_ROWS * GRID; // 当前房间像素尺寸
let currentTheme = null;
let currentCategory = "all";
let activeLevel = null; // manifest.layouts 里的一项，或 null = 自由摆放
let snapToGrid = true;
let placed = []; // {uid, assetId, x, y, flipped, order, manualFront, sheetKey}
let insertCounter = 0;
let selectedUid = null;

const el = (id) => document.getElementById(id);
const roomEl = el("room");
const paletteGrid = el("paletteGrid");
const themeSelect = el("themeSelect");
const categoryTabs = el("categoryTabs");
const itemToolbar = el("itemToolbar");
const levelPanel = el("levelPanel");
const levelSelect = el("levelSelect");

function assetById(id) { return manifest.items.find(i => i.id === id); }
function sheetKeyOf(level) { return `${level.theme}|${level.sheetId}`; }

async function loadManifest() {
  // 本地开发用完整的 manifest.json（真实素材，不进公开仓库）；
  // 公开部署里这个文件不存在，自动退回只含占位素材的 manifest.sample.json。
  let res;
  try {
    res = await fetch("assets/manifest.json", { cache: "no-store" });
    if (!res.ok) throw new Error("no local manifest");
  } catch {
    res = await fetch("assets/manifest.sample.json", { cache: "no-store" });
  }
  manifest = await res.json();
  GRID = manifest.gridUnit || 64;
  manifest.layouts = manifest.layouts || [];
  manifest.themeExtras = manifest.themeExtras || {};
  addReferenceLayouts();
}

function addReferenceLayouts() {
  const extras = manifest.themeExtras["森林动物"];
  if (!extras || !extras.background || extras.referenceLayout) return;
  const item = (n, x, y, flipped = false) => ({
    assetId: `森林动物/decor/动物组合${String(n).padStart(2, "0")}`,
    x, y, flipped,
  });
  extras.referenceLayout = {
    sheetId: "灵感参考布局",
    theme: "森林动物",
    sourceWidth: extras.background.w,
    sourceHeight: extras.background.h,
    referenceLayout: true,
    keepBackground: true,
    items: [
      item(1, 52, 210),
      item(2, 372, 120),
      item(3, 700, 180),
      item(4, 742, 690),
      item(5, 364, 886),
      item(6, 48, 666),
      item(7, 496, 586),
      item(8, 820, 450),
      item(9, 700, 992),
      item(10, 82, 1084),
      item(11, 500, 1080),
      item(12, 770, 1120),
    ],
  };

  const hotpot = manifest.themeExtras["八合里火锅"];
  if (hotpot && hotpot.background && !hotpot.referenceLayout) {
    const table = (assetId, x, y, instanceId) => ({ assetId, x, y, instanceId });
    hotpot.referenceLayout = {
      sheetId: "目标场景预设",
      theme: "八合里火锅",
      sourceWidth: hotpot.background.w,
      sourceHeight: hotpot.background.h,
      referenceLayout: true,
      keepBackground: true,
      referenceImage: hotpot.inspiration?.file,
      // 只放目标图中最重要的四张完整餐桌；背景已包含墙边柜台和冰箱。
      items: [
        table("八合里火锅/furniture/餐桌02", 116, 470, "top-left"),
        table("八合里火锅/furniture/餐桌10", 664, 470, "top-right"),
        table("八合里火锅/furniture/餐桌20", 116, 850, "bottom-left"),
        table("八合里火锅/furniture/餐桌02", 664, 850, "bottom-right"),
      ],
    };
  }

  // 迷你关卡：从一张空桌开始，把桌面上的小像素物件重新摆回去。
  // 这些物件原本来自“餐桌”素材表的独立连通域，不把复合餐桌当作零件使用。
  if (hotpot && hotpot.miniLevels === undefined) {
    const item = (assetId, x, y) => ({ assetId, x, y });
    hotpot.miniLevels = [{
      sheetId: "桌面小拼图",
      theme: "八合里火锅",
      sourceWidth: 640,
      sourceHeight: 512,
      referenceLayout: true,
      keepBackground: false,
      items: [
        item("八合里火锅/furniture/餐桌08", 128, 96),
        item("八合里火锅/furniture/餐桌17", 256, 188), // 空锅
        item("八合里火锅/furniture/餐桌18", 260, 186), // 锅底
        item("八合里火锅/furniture/餐桌19", 164, 206), // 小碟组合
        item("八合里火锅/furniture/餐桌21", 176, 132), // 小料
        item("八合里火锅/furniture/餐桌22", 362, 144), // 小碟
        item("八合里火锅/furniture/餐桌23", 316, 112), // 白菜与杯子
        item("八合里火锅/furniture/餐桌25", 352, 238), // 小料
        item("八合里火锅/furniture/餐桌26", 206, 246), // 杯子
        item("八合里火锅/furniture/餐桌27", 390, 204), // 茶壶
      ],
    }];
  }
}

function themes() {
  return [...new Set(manifest.items.map(i => i.theme))].sort();
}

function levelsForTheme(theme) {
  const levels = manifest.layouts.filter(l => l.theme === theme);
  // 森林动物不是从一张贴纸表切出来的拼图关卡，但它有一张灵感参考图。
  // 为它提供一个可编辑的“参考布局”，让一键拼好真正有内容可执行。
  const extras = (manifest.themeExtras || {})[theme];
  if (extras && extras.referenceLayout) levels.push(extras.referenceLayout);
  if (extras && extras.miniLevels) levels.push(...extras.miniLevels);
  return levels;
}

function buildThemeSelect() {
  themeSelect.innerHTML = "";
  for (const t of themes()) {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    themeSelect.appendChild(opt);
  }
  currentTheme = themeSelect.value = themes()[0] || null;
}

function buildCategoryTabs() {
  categoryTabs.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.textContent = "全部"; allBtn.dataset.cat = "all"; allBtn.classList.add("active");
  categoryTabs.appendChild(allBtn);
  for (const c of CATEGORY_ORDER) {
    const b = document.createElement("button");
    b.textContent = CATEGORY_LABELS[c]; b.dataset.cat = c;
    categoryTabs.appendChild(b);
  }
  categoryTabs.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    currentCategory = btn.dataset.cat;
    [...categoryTabs.children].forEach(c => c.classList.toggle("active", c === btn));
    renderPalette();
  });
}

function renderPalette() {
  paletteGrid.innerHTML = "";
  const list = manifest.items.filter(i =>
    i.theme === currentTheme && !HIDDEN_MVP_ASSETS.has(i.id) &&
    (currentCategory === "all" || i.category === currentCategory)
  );
  for (const item of list) {
    const card = document.createElement("div");
    card.className = "palette-item";
    card.innerHTML = `<img src="${item.file}" alt="${item.name}" draggable="false" loading="lazy" decoding="async">
      <div class="label">${item.name}</div>
      <div class="size">${item.w}×${item.h} · ${CATEGORY_LABELS[item.category]}</div>`;
    card.addEventListener("pointerdown", (e) => startPaletteDrag(e, item));
    paletteGrid.appendChild(card);
  }
  if (list.length === 0) {
    paletteGrid.innerHTML = `<p class="hint">这个分类下暂时没有素材。</p>`;
  }
}

function themeExtras() {
  return (manifest.themeExtras || {})[currentTheme] || null;
}

function refreshLevelPanel() {
  const levels = levelsForTheme(currentTheme);
  activeLevel = null;
  if (levels.length === 0) {
    levelPanel.hidden = true;
    el("refOverlayToggle").closest("label").hidden = false;
  } else {
    levelPanel.hidden = false;
    const hasReferenceLayout = levels.some(l => l.referenceLayout);
    levelPanel.querySelector("label").firstChild.textContent = hasReferenceLayout
      ? "预设布局"
      : "关卡（还原原图）";
    el("refOverlayToggle").closest("label").hidden = !levels.some(l => l.referenceImage);
    levelSelect.innerHTML = '<option value="">（自由摆放）</option>';
    for (const lvl of levels) {
      const opt = document.createElement("option");
      opt.value = lvl.sheetId; opt.textContent = lvl.sheetId;
      levelSelect.appendChild(opt);
    }
    levelSelect.value = "";
  }
  applyThemeDefaultRoomSize();
  renderInspiration();
}

function applyThemeDefaultRoomSize() {
  const extras = themeExtras();
  if (extras && extras.background) {
    roomW = extras.background.w;
    roomH = extras.background.h;
    sizeRoom();
  } else {
    setRoomSizeFromManualInputs();
  }
}

function renderInspiration() {
  const panel = el("inspirationPanel");
  const extras = themeExtras();
  if (extras && extras.inspiration) {
    panel.hidden = false;
    panel.querySelector("img").src = extras.inspiration.file;
  } else {
    panel.hidden = true;
  }
}

levelSelect.addEventListener("change", () => {
  const sheetId = levelSelect.value;
  if (!sheetId) {
    activeLevel = null;
    placed = placed.filter(p => !p.sheetKey); // 离开关卡时清掉关卡自带的物件，保留手动摆的
    applyThemeDefaultRoomSize();
    renderPlaced();
    return;
  }
  activeLevel = levelsForTheme(currentTheme).find(l => l.sheetId === sheetId);
  roomW = activeLevel.sourceWidth;
  roomH = activeLevel.sourceHeight;
  sizeRoom();
  if (activeLevel.referenceLayout) solveLevel();
  else shuffleLevel();
});

el("shuffleBtn").addEventListener("click", shuffleLevel);
el("solveBtn").addEventListener("click", solveLevel);
el("refOverlayToggle").addEventListener("change", renderPlaced);

function shuffleLevel() {
  if (!activeLevel) return;
  const key = sheetKeyOf(activeLevel);
  placed = placed.filter(p => p.sheetKey !== key);
  for (const it of activeLevel.items) {
    const maxX = Math.max(0, roomW - it.w);
    const maxY = Math.max(0, roomH - it.h);
    placed.push({
      uid: "p" + (++insertCounter),
      assetId: it.assetId,
      x: Math.random() * maxX, y: Math.random() * maxY,
      flipped: false, order: insertCounter, manualFront: false,
      sheetKey: key,
    });
  }
  selectedUid = null;
  renderPlaced();
}

function solveLevel() {
  if (!activeLevel) return;
  const key = sheetKeyOf(activeLevel);
  const layoutKey = (it) => `${it.assetId}#${it.instanceId || ""}`;
  const existing = new Map(placed.filter(p => p.sheetKey === key).map(p => [layoutKey(p), p]));
  for (const orig of activeLevel.items) {
    let p = existing.get(layoutKey(orig));
    if (!p) {
      p = {
        uid: "p" + (++insertCounter), assetId: orig.assetId,
        x: orig.x, y: orig.y, flipped: !!orig.flipped,
        order: insertCounter, manualFront: false, sheetKey: key,
        ...(orig.instanceId ? { instanceId: orig.instanceId } : {}),
      };
      placed.push(p);
    } else {
      p.x = orig.x; p.y = orig.y;
      if (orig.flipped !== undefined) p.flipped = !!orig.flipped;
    }
  }
  selectedUid = null;
  renderPlaced();
}

function setRoomSizeFromManualInputs() {
  roomW = (parseInt(el("roomCols").value, 10) || DEFAULT_ROOM_COLS) * GRID;
  roomH = (parseInt(el("roomRows").value, 10) || DEFAULT_ROOM_ROWS) * GRID;
  sizeRoom();
}

function sizeRoom() {
  roomEl.style.width = roomW + "px";
  roomEl.style.height = roomH + "px";
  roomEl.style.backgroundSize = `${GRID}px ${GRID}px`;
  const manualControlsDisabled = !!activeLevel || !!(themeExtras() && themeExtras().background);
  el("roomCols").disabled = manualControlsDisabled;
  el("roomRows").disabled = manualControlsDisabled;
  el("applyRoomSize").disabled = manualControlsDisabled;
}

function computeZ(p) {
  const catRank = CATEGORY_ORDER.indexOf(assetById(p.assetId)?.category ?? "prop");
  let z = catRank * 100000 + Math.round(p.y / 4) + (p.order % 100);
  if (p.manualFront) z += 10000000;
  return z;
}

function clampToRoom(w, h, x, y) {
  const maxX = Math.max(0, roomW - w);
  const maxY = Math.max(0, roomH - h);
  return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

function renderPlaced() {
  roomEl.innerHTML = "";

  const extras = themeExtras();
  if (extras && extras.background && (!activeLevel || activeLevel.keepBackground)) {
    const bg = document.createElement("img");
    bg.className = "room-background";
    bg.src = extras.background.file;
    bg.width = roomW; bg.height = roomH;
    roomEl.appendChild(bg);
  }

  if (activeLevel && activeLevel.referenceImage && el("refOverlayToggle").checked) {
    const ref = document.createElement("img");
    ref.className = "room-reference";
    ref.src = activeLevel.referenceImage;
    ref.width = roomW; ref.height = roomH;
    roomEl.appendChild(ref);
  }

  for (const p of placed) {
    const asset = assetById(p.assetId);
    if (!asset) continue;
    const node = document.createElement("div");
    node.className = "placed-item" + (p.uid === selectedUid ? " selected" : "") + (p.flipped ? " flipped" : "");
    node.style.left = p.x + "px";
    node.style.top = p.y + "px";
    node.style.width = asset.w + "px";
    node.style.height = asset.h + "px";
    node.style.zIndex = computeZ(p);
    node.dataset.uid = p.uid;
    node.innerHTML = `<img src="${asset.file}" alt="${asset.name}" draggable="false">`;
    node.addEventListener("pointerdown", (e) => startMoveDrag(e, p));
    roomEl.appendChild(node);
  }
  positionToolbar();
}

function positionToolbar() {
  itemToolbar.hidden = !selectedUid;
}

function maybeSnap(v) { return snapToGrid ? Math.round(v / GRID) * GRID : v; }

// ---- 从调色板拖出一个新物件 ----
function startPaletteDrag(e, asset) {
  e.preventDefault();
  const ghost = document.createElement("img");
  ghost.src = asset.file;
  ghost.style.cssText = `position:fixed;pointer-events:none;width:${asset.w}px;height:${asset.h}px;
    opacity:.85;z-index:9999;image-rendering:pixelated;`;
  document.body.appendChild(ghost);
  moveGhost(e, ghost, asset);

  const onMove = (ev) => moveGhost(ev, ghost, asset);
  const onUp = (ev) => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    ghost.remove();
    const roomRect = roomEl.getBoundingClientRect();
    if (ev.clientX < roomRect.left || ev.clientX > roomRect.right ||
        ev.clientY < roomRect.top || ev.clientY > roomRect.bottom) return;
    const rawX = maybeSnap(ev.clientX - roomRect.left - asset.w / 2);
    const rawY = maybeSnap(ev.clientY - roomRect.top - asset.h / 2);
    const { x, y } = clampToRoom(asset.w, asset.h, rawX, rawY);
    placed.push({
      uid: "p" + (++insertCounter),
      assetId: asset.id, x, y,
      flipped: false, order: insertCounter, manualFront: false,
      sheetKey: null,
    });
    selectedUid = placed[placed.length - 1].uid;
    renderPlaced();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp, { once: true });
}

function moveGhost(e, ghost, asset) {
  ghost.style.left = (e.clientX - asset.w / 2) + "px";
  ghost.style.top = (e.clientY - asset.h / 2) + "px";
}

// ---- 移动已放置的物件 ----
function startMoveDrag(e, p) {
  e.preventDefault();
  e.stopPropagation();
  selectedUid = p.uid;
  renderPlaced();
  const asset = assetById(p.assetId);
  const node = roomEl.querySelector(`[data-uid="${p.uid}"]`);
  node.classList.add("dragging");
  const startX = e.clientX, startY = e.clientY;
  const origX = p.x, origY = p.y;

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    const { x, y } = clampToRoom(asset.w, asset.h, maybeSnap(origX + dx), maybeSnap(origY + dy));
    node.style.left = x + "px";
    node.style.top = y + "px";
    p._pendingX = x; p._pendingY = y;
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    node.classList.remove("dragging");
    if (p._pendingX !== undefined) { p.x = p._pendingX; p.y = p._pendingY; }
    delete p._pendingX; delete p._pendingY;
    renderPlaced();
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp, { once: true });
}

function deleteSelected() {
  if (!selectedUid) return;
  placed = placed.filter(p => p.uid !== selectedUid);
  selectedUid = null;
  renderPlaced();
}

function flipSelected() {
  const p = placed.find(p => p.uid === selectedUid);
  if (p) { p.flipped = !p.flipped; renderPlaced(); }
}

function bringSelectedFront() {
  const p = placed.find(p => p.uid === selectedUid);
  if (p) { p.manualFront = true; p.order = ++insertCounter; renderPlaced(); }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    if (document.activeElement.tagName === "INPUT") return;
    deleteSelected();
  }
});
roomEl.addEventListener("pointerdown", (e) => {
  if (e.target === roomEl) { selectedUid = null; renderPlaced(); }
});

// ---- 保存 / 载入 / 导出 ----
function currentLayout() {
  return {
    roomW, roomH, gridUnit: GRID,
    theme: currentTheme, levelSheetId: activeLevel ? activeLevel.sheetId : null,
    items: placed.map(({ uid, ...rest }) => rest),
  };
}

function applyLayout(layout) {
  roomW = layout.roomW; roomH = layout.roomH;
  sizeRoom();
  placed = layout.items.map(it => ({ ...it, uid: "p" + (++insertCounter) }));
  selectedUid = null;
  renderPlaced();
}

function refreshSavedList() {
  const sel = el("loadSelect");
  sel.innerHTML = '<option value="">载入已保存布局…</option>';
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key.startsWith(STORAGE_PREFIX)) {
      const name = key.slice(STORAGE_PREFIX.length);
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    }
  }
}

el("saveLayoutBtn").addEventListener("click", () => {
  const name = prompt("给这个布局起个名字：", "我的场景");
  if (!name) return;
  localStorage.setItem(STORAGE_PREFIX + name, JSON.stringify(currentLayout()));
  refreshSavedList();
});

el("loadSelect").addEventListener("change", (e) => {
  const name = e.target.value;
  if (!name) return;
  const raw = localStorage.getItem(STORAGE_PREFIX + name);
  if (raw) applyLayout(JSON.parse(raw));
});

el("exportJsonBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(currentLayout(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "layout.json";
  a.click();
});

el("importJsonInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  applyLayout(JSON.parse(text));
});

el("clearBtn").addEventListener("click", () => {
  if (!confirm("确定清空当前房间的所有摆放？")) return;
  placed = []; selectedUid = null; renderPlaced();
});

el("snapToggle").addEventListener("change", (e) => { snapToGrid = e.target.checked; });
el("bringFrontBtn").addEventListener("click", bringSelectedFront);
el("flipBtn").addEventListener("click", flipSelected);
el("deleteItemBtn").addEventListener("click", deleteSelected);

el("applyRoomSize").addEventListener("click", () => {
  if (activeLevel || (themeExtras() && themeExtras().background)) return;
  setRoomSizeFromManualInputs();
  placed.forEach(p => {
    const asset = assetById(p.assetId);
    Object.assign(p, clampToRoom(asset.w, asset.h, p.x, p.y));
  });
  renderPlaced();
});

themeSelect.addEventListener("change", () => {
  currentTheme = themeSelect.value;
  renderPalette();
  refreshLevelPanel();
  renderPlaced();
});

el("exportPngBtn").addEventListener("click", exportPng);

function exportPng() {
  const canvas = el("exportCanvas");
  canvas.width = roomW;
  canvas.height = roomH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#2b2438";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const ordered = [...placed].sort((a, b) => computeZ(a) - computeZ(b));
  const imgs = ordered.map(p => {
    const asset = assetById(p.assetId);
    const img = new Image();
    img.src = asset.file;
    return { p, asset, img };
  });

  Promise.all(imgs.map(({ img }) => img.decode().catch(() => {}))).then(() => {
    for (const { p, asset, img } of imgs) {
      ctx.save();
      if (p.flipped) {
        ctx.translate(p.x + asset.w, p.y);
        ctx.scale(-1, 1);
        ctx.drawImage(img, 0, 0, asset.w, asset.h);
      } else {
        ctx.drawImage(img, p.x, p.y, asset.w, asset.h);
      }
      ctx.restore();
    }
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "scene.png";
      a.click();
    });
  });
}

async function init() {
  await loadManifest();
  buildThemeSelect();
  buildCategoryTabs();
  refreshLevelPanel();
  renderPalette();
  renderPlaced();
  refreshSavedList();
}

init();
