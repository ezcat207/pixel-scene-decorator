// 素材拆分器：把一张"多物件贴纸表"PNG 自动切成独立透明 PNG。
// 纯前端连通域检测，不依赖任何外部服务。

const el = (id) => document.getElementById(id);
const dropZone = el("dropZone");
const fileInput = el("fileInput");
const resultGrid = el("resultGrid");
const workCanvas = el("workCanvas");

let sourceImage = null;
let sourceCanvas = null;
let items = []; // {id, canvas, w, h, name, category, include}
let dirHandle = null;

el("tolerance").addEventListener("input", (e) => el("toleranceVal").textContent = e.target.value);

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); });

async function loadFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  sourceImage = img;
  sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = img.width;
  sourceCanvas.height = img.height;
  sourceCanvas.getContext("2d").drawImage(img, 0, 0);
  el("sourceInfo").textContent = `已载入：${file.name} · ${img.width}×${img.height}`;
  el("detectBtn").disabled = false;
  items = [];
  renderResults();
}

el("detectBtn").addEventListener("click", detect);

function detect() {
  const ctx = sourceCanvas.getContext("2d");
  const { width: W, height: H } = sourceCanvas;
  const data = ctx.getImageData(0, 0, W, H).data;

  const hasAlpha = checkHasAlpha(data);
  const tolerance = parseInt(el("tolerance").value, 10);
  const minArea = parseInt(el("minArea").value, 10) || 1;
  const padding = parseInt(el("padding").value, 10) || 0;
  const snap = parseInt(el("snapMultiple").value, 10) || 0;

  let isForeground;
  if (hasAlpha) {
    isForeground = (i) => data[i * 4 + 3] > 10;
  } else {
    const bg = sampleCornerColor(data, W, H);
    const distThresh = tolerance * 3;
    isForeground = (i) => colorDistance(data, i, bg) > distThresh;
  }

  const labels = new Int32Array(W * H).fill(0);
  const boxes = [];
  const stack = new Int32Array(W * H);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (labels[idx] !== 0 || !isForeground(idx)) continue;
      const labelId = boxes.length + 1;
      let sp = 0;
      stack[sp++] = idx;
      labels[idx] = labelId;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      while (sp > 0) {
        const cur = stack[--sp];
        const cx = cur % W, cy = (cur / W) | 0;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        const neighbors = [
          [cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nIdx = ny * W + nx;
          if (labels[nIdx] === 0 && isForeground(nIdx)) {
            labels[nIdx] = labelId;
            stack[sp++] = nIdx;
          }
        }
      }
      boxes.push({ minX, maxX, minY, maxY, count });
    }
  }

  const defaultCategory = el("defaultCategory").value;
  items = boxes
    .filter(b => (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1) >= minArea && b.count >= minArea)
    .map((b, i) => buildItem(b, i, padding, snap, defaultCategory, W, H));

  renderResults();
}

function checkHasAlpha(data) {
  for (let i = 3; i < data.length; i += 4 * 97) { // 采样，不用逐像素扫全图
    if (data[i] < 250) return true;
  }
  return false;
}

function sampleCornerColor(data, W, H) {
  const idxs = [0, W - 1, (H - 1) * W, (H - 1) * W + (W - 1)];
  let r = 0, g = 0, b = 0;
  for (const idx of idxs) { r += data[idx * 4]; g += data[idx * 4 + 1]; b += data[idx * 4 + 2]; }
  return { r: r / 4, g: g / 4, b: b / 4 };
}

function colorDistance(data, i, bg) {
  const dr = data[i * 4] - bg.r, dg = data[i * 4 + 1] - bg.g, db = data[i * 4 + 2] - bg.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function buildItem(b, i, padding, snap, category, W, H) {
  const x0 = Math.max(0, b.minX - padding);
  const y0 = Math.max(0, b.minY - padding);
  const x1 = Math.min(W - 1, b.maxX + padding);
  const y1 = Math.min(H - 1, b.maxY + padding);
  const cropW = x1 - x0 + 1, cropH = y1 - y0 + 1;

  let canvasW = cropW, canvasH = cropH;
  if (snap > 0) {
    canvasW = Math.ceil(cropW / snap) * snap;
    canvasH = Math.ceil(cropH / snap) * snap;
  }
  const offX = Math.floor((canvasW - cropW) / 2);
  const offY = Math.floor((canvasH - cropH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sourceCanvas, x0, y0, cropW, cropH, offX, offY, cropW, cropH);

  return {
    id: "item" + i,
    canvas, w: canvasW, h: canvasH,
    name: `物件${String(i + 1).padStart(2, "0")}`,
    category, include: true,
  };
}

function renderResults() {
  resultGrid.innerHTML = "";
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "result-card" + (item.include ? "" : " excluded");
    card.appendChild(item.canvas);
    const dims = document.createElement("div");
    dims.className = "dims";
    dims.textContent = `${item.w}×${item.h}`;
    card.appendChild(dims);

    const nameRow = document.createElement("div");
    nameRow.className = "row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name;
    nameInput.addEventListener("input", () => item.name = nameInput.value);
    nameRow.appendChild(nameInput);
    card.appendChild(nameRow);

    const catRow = document.createElement("div");
    catRow.className = "row";
    const catSelect = document.createElement("select");
    for (const [v, label] of Object.entries({ floor: "地板", wall: "墙体", furniture: "家具", prop: "道具", decor: "装饰" })) {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = label;
      if (v === item.category) opt.selected = true;
      catSelect.appendChild(opt);
    }
    catSelect.addEventListener("change", () => item.category = catSelect.value);
    catRow.appendChild(catSelect);

    const includeLabel = document.createElement("label");
    includeLabel.style.display = "flex";
    includeLabel.style.alignItems = "center";
    includeLabel.style.gap = "4px";
    const includeCheckbox = document.createElement("input");
    includeCheckbox.type = "checkbox";
    includeCheckbox.checked = item.include;
    includeCheckbox.addEventListener("change", () => {
      item.include = includeCheckbox.checked;
      card.classList.toggle("excluded", !item.include);
    });
    includeLabel.appendChild(includeCheckbox);
    includeLabel.appendChild(document.createTextNode("保留"));
    catRow.appendChild(includeLabel);
    card.appendChild(catRow);

    resultGrid.appendChild(card);
  }
  el("exportBtn").disabled = items.length === 0;
}

el("pickDirBtn").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    el("dirStatus").textContent = "当前浏览器不支持直接写入文件夹（建议用 Chrome/Edge），导出会改用逐个下载。";
    return;
  }
  try {
    dirHandle = await window.showDirectoryPicker();
    el("dirStatus").textContent = `已选择目录：${dirHandle.name}（请选到 decorator-game/assets/production_sheets）`;
  } catch (e) { /* 用户取消 */ }
});

el("exportBtn").addEventListener("click", async () => {
  const theme = el("themeName").value.trim();
  if (!theme) { alert("请先填写主题名"); return; }
  const selected = items.filter(i => i.include);
  if (selected.length === 0) { alert("没有选中任何物件"); return; }

  if (dirHandle) {
    const themeDir = await dirHandle.getDirectoryHandle(theme, { create: true });
    for (const item of selected) {
      const catDir = await themeDir.getDirectoryHandle(item.category, { create: true });
      const blob = await canvasToBlob(item.canvas);
      const fileName = `${item.name}__${item.w}x${item.h}.png`;
      const fileHandle = await catDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
    }
    alert(`已写入 ${selected.length} 个文件到 ${theme}/，记得运行 tools/gen_manifest.py 刷新素材库。`);
  } else {
    for (const item of selected) {
      const blob = await canvasToBlob(item.canvas);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${item.name}__${item.w}x${item.h}.png`;
      a.click();
      await new Promise(r => setTimeout(r, 150));
    }
    alert(`已下载 ${selected.length} 个文件，请手动放进
      decorator-game/assets/production_sheets/${theme}/<分类>/ 对应目录，再运行 gen_manifest.py。`);
  }
});

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
