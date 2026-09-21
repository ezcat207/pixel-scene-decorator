"""
命令行版"素材拆分器"——跟 splitter/splitter.js 用的是同一套连通域算法，
用于批量处理、或者在没有浏览器交互场景下直接出结果。

同时会记录每个物件在原图里的位置，写进 assets/production_sheets/<主题>/layouts.json，
供网页装饰游戏的"一键拼回去"关卡功能使用；并把原图复制一份到 assets/reference_sheets/
下，作为拼图时的半透明参考底图。

用法：
    python tools/auto_slice.py <sheet.png> <主题名> <关卡名sheetId> [--category furniture]
        [--min-area 64] [--padding 8] [--snap 64] [--out-prefix 物件] [--names 名字1,名字2,...]

产出：
    assets/production_sheets/<主题名>/<category>/<out-prefix><序号>__WxH.png
    assets/production_sheets/<主题名>/layouts.json   （追加一条关卡记录）
    assets/reference_sheets/<主题名>/<关卡名>.png     （原图参考底图）
"""
import argparse
import json
import os
import shutil

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class UnionFind:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def foreground_mask(im):
    arr = np.array(im.convert("RGBA"))
    alpha = arr[:, :, 3]
    if alpha.min() < 250:
        return alpha > 10
    h, w = alpha.shape
    corners = np.array([arr[0, 0, :3], arr[0, w - 1, :3], arr[h - 1, 0, :3], arr[h - 1, w - 1, :3]], dtype=float)
    bg = corners.mean(axis=0)
    dist = np.linalg.norm(arr[:, :, :3].astype(float) - bg, axis=2)
    return dist > 40


def dilate(mask, radius):
    """可分离膨胀（先横向再纵向），用于把同一个图标里断开的笔画/线条重新连成一整块，
    半径要小于图标之间的真实间距，否则会把相邻的不同物件也粘在一起。"""
    if radius <= 0:
        return mask
    h, w = mask.shape
    out = mask.copy()
    padded = np.zeros(w + 2 * radius, dtype=bool)
    tmp = np.zeros_like(mask)
    for y in range(h):
        padded[:] = False
        padded[radius:radius + w] = out[y]
        row = np.zeros(w, dtype=bool)
        for d in range(-radius, radius + 1):
            row |= padded[radius + d: radius + d + w]
        tmp[y] = row
    out = tmp
    padded_col = np.zeros(h + 2 * radius, dtype=bool)
    tmp2 = np.zeros_like(mask)
    for x in range(w):
        padded_col[:] = False
        padded_col[radius:radius + h] = out[:, x]
        col = np.zeros(h, dtype=bool)
        for d in range(-radius, radius + 1):
            col |= padded_col[radius + d: radius + d + h]
        tmp2[:, x] = col
    return tmp2


def connected_components(mask, merge_radius=0):
    """基于行游程 + 并查集的连通域检测。
    分组用 dilate(mask, merge_radius) 之后的宽松版本(把断开的笔画连起来判定是不是同一个物件)，
    但包围盒/面积统计仍然只用原始 mask 的像素，避免因为膨胀而把裁剪范围放大。
    返回 [(minx,maxx,miny,maxy,area), ...]"""
    h, w = mask.shape
    group_mask = dilate(mask, merge_radius) if merge_radius > 0 else mask

    uf = UnionFind()
    uid_counter = 0
    uid_info = {}  # uid -> [minx,maxx,miny,maxy,area]  (基于原始 mask 像素)

    prev_runs = []
    for y in range(h):
        grow = group_mask[y]
        orow = mask[y]
        runs = []
        x = 0
        while x < w:
            if grow[x]:
                x0 = x
                while x < w and grow[x]:
                    x += 1
                # 在这段"分组游程"里，只统计原始前景像素的紧致包围盒
                seg = orow[x0:x]
                if seg.any():
                    idxs = np.nonzero(seg)[0]
                    real_min = x0 + int(idxs[0])
                    real_max = x0 + int(idxs[-1])
                    area = int(seg.sum())
                    uid = uid_counter
                    uid_counter += 1
                    uid_info[uid] = [real_min, real_max, y, y, area]
                    runs.append((x0, x - 1, uid))
            else:
                x += 1
        for (s, e, uid) in runs:
            for (ps, pe, puid) in prev_runs:
                if s <= pe and ps <= e:
                    uf.union(uid, puid)
        prev_runs = runs

    groups = {}
    for uid, (minx, maxx, miny, maxy, area) in uid_info.items():
        root = uf.find(uid)
        if root not in groups:
            groups[root] = [minx, maxx, miny, maxy, area]
        else:
            g = groups[root]
            g[0] = min(g[0], minx); g[1] = max(g[1], maxx)
            g[2] = min(g[2], miny); g[3] = max(g[3], maxy)
            g[4] += area

    return list(groups.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("theme")
    ap.add_argument("sheet_id", help="这一张原图的关卡名，比如 '餐台'")
    ap.add_argument("--category", default="furniture", choices=["floor", "wall", "furniture", "prop", "decor"])
    ap.add_argument("--min-area", type=int, default=64)
    ap.add_argument("--padding", type=int, default=8)
    ap.add_argument("--snap", type=int, default=64)
    ap.add_argument("--merge-radius", type=int, default=0,
                     help="线稿/描边风格的图标笔画会断开，调大这个值(如6-10)把同一个图标的碎片重新粘合成一个连通域；"
                          "必须小于物件之间的真实间距，否则会把相邻物件也粘在一起")
    ap.add_argument("--out-prefix", default="物件")
    ap.add_argument("--names", default="", help="逗号分隔的物件名列表，按检测顺序(从上到下从左到右)对应；不填则用 out-prefix+序号")
    args = ap.parse_args()

    im = Image.open(args.sheet).convert("RGBA")
    mask = foreground_mask(im)
    boxes = connected_components(mask, merge_radius=args.merge_radius)
    boxes = [b for b in boxes if b[4] >= args.min_area]
    boxes.sort(key=lambda b: (b[2], b[0]))

    out_dir = os.path.join(ROOT, "assets", "production_sheets", args.theme, args.category)
    os.makedirs(out_dir, exist_ok=True)

    names = [n.strip() for n in args.names.split(",") if n.strip()]

    w_img, h_img = im.size
    saved = []
    layout_items = []
    for i, (minx, maxx, miny, maxy, area) in enumerate(boxes, 1):
        x0 = max(0, minx - args.padding)
        y0 = max(0, miny - args.padding)
        x1 = min(w_img - 1, maxx + args.padding)
        y1 = min(h_img - 1, maxy + args.padding)
        crop = im.crop((x0, y0, x1 + 1, y1 + 1))
        cw, ch = crop.size
        if args.snap > 0:
            canvas_w = -(-cw // args.snap) * args.snap
            canvas_h = -(-ch // args.snap) * args.snap
        else:
            canvas_w, canvas_h = cw, ch
        off_x = (canvas_w - cw) // 2
        off_y = (canvas_h - ch) // 2
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
        canvas.paste(crop, (off_x, off_y), crop)

        item_name = names[i - 1] if i - 1 < len(names) else f"{args.out_prefix}{i:02d}"
        fname = f"{item_name}__{canvas_w}x{canvas_h}.png"
        canvas.save(os.path.join(out_dir, fname))
        saved.append((fname, canvas_w, canvas_h, area))

        # 还原用的放置坐标：让裁剪出来的实际内容(crop)落回原图里的原始位置，
        # 画布因为补齐网格而多出来的留白部分自然地在四周溢出（透明，不影响观感）。
        place_x = x0 - off_x
        place_y = y0 - off_y
        layout_items.append({
            "assetId": f"{args.theme}/{args.category}/{item_name}",
            "file": f"assets/production_sheets/{args.theme}/{args.category}/{fname}",
            "x": place_x, "y": place_y, "w": canvas_w, "h": canvas_h,
        })

    theme_dir = os.path.join(ROOT, "assets", "production_sheets", args.theme)
    layouts_path = os.path.join(theme_dir, "layouts.json")
    layouts = []
    if os.path.exists(layouts_path):
        with open(layouts_path, "r", encoding="utf-8") as f:
            layouts = json.load(f)
    layouts = [l for l in layouts if l.get("sheetId") != args.sheet_id]  # 重跑时替换旧记录
    layouts.append({
        "sheetId": args.sheet_id,
        "theme": args.theme,
        "sourceWidth": w_img,
        "sourceHeight": h_img,
        "referenceImage": f"assets/reference_sheets/{args.theme}/{args.sheet_id}.png",
        "items": layout_items,
    })
    with open(layouts_path, "w", encoding="utf-8") as f:
        json.dump(layouts, f, ensure_ascii=False, indent=2)

    ref_dir = os.path.join(ROOT, "assets", "reference_sheets", args.theme)
    os.makedirs(ref_dir, exist_ok=True)
    shutil.copyfile(args.sheet, os.path.join(ref_dir, f"{args.sheet_id}.png"))

    print(f"检测到 {len(boxes)} 个连通域，已保存到 {out_dir}")
    for name, w, h, area in saved:
        print(f"  {name}  面积={area}")
    print(f"关卡记录已写入 {layouts_path}（sheetId={args.sheet_id}）")


if __name__ == "__main__":
    main()
