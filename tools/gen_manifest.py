"""
扫描 assets/production_sheets/<主题>/<分类>/<名称>__<宽>x<高>.png
生成 assets/manifest.json 供网页装饰游戏读取。

用法：
    python tools/gen_manifest.py
    python tools/gen_manifest.py --out assets/manifest.sample.json --only-themes 示例主题   # 生成公开demo用的精简清单

命名约定（新增素材必须遵守）：
    assets/production_sheets/主题名/分类/物件名__宽x高.png
    - 主题名：任意文件夹名，如 "少林寺"、"8090后网吧"，对应左侧主题筛选。
    - 分类：floor | wall | furniture | prop | decor 五选一（决定图层顺序，见 README）。
    - 物件名__宽x高：用两个下划线分隔名称和尺寸，尺寸必须是 64 的整数倍，如 "长椅__128x64.png"。
    - 图片必须是带透明通道(RGBA)的 PNG，背景透明。
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "assets", "production_sheets")

GRID_UNIT = 64
VALID_CATEGORIES = {"floor", "wall", "furniture", "prop", "decor"}
NAME_RE = re.compile(r"^(?P<name>.+)__(?P<w>\d+)x(?P<h>\d+)\.png$", re.IGNORECASE)

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def warn(msg):
    print(f"[警告] {msg}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "assets", "manifest.json"),
                     help="输出路径，默认 assets/manifest.json")
    ap.add_argument("--only-themes", default="",
                     help="逗号分隔的主题白名单，只打包这些主题（用于生成不含真实素材的公开demo清单）")
    args = ap.parse_args()
    out_file = os.path.abspath(args.out)
    only_themes = {t.strip() for t in args.only_themes.split(",") if t.strip()}

    items = []
    if not os.path.isdir(SRC_DIR):
        warn(f"素材目录不存在: {SRC_DIR}")
        return

    for theme in sorted(os.listdir(SRC_DIR)):
        if only_themes and theme not in only_themes:
            continue
        theme_dir = os.path.join(SRC_DIR, theme)
        if not os.path.isdir(theme_dir):
            continue
        for category in sorted(os.listdir(theme_dir)):
            cat_dir = os.path.join(theme_dir, category)
            if not os.path.isdir(cat_dir):
                continue
            if category not in VALID_CATEGORIES:
                warn(f"跳过未知分类目录: {theme}/{category}（允许值: {sorted(VALID_CATEGORIES)}）")
                continue
            for fname in sorted(os.listdir(cat_dir)):
                if not fname.lower().endswith(".png"):
                    continue
                m = NAME_RE.match(fname)
                fpath = os.path.join(cat_dir, fname)
                rel_path = os.path.relpath(fpath, ROOT).replace(os.sep, "/")
                if not m:
                    warn(f"文件名不符合 名称__宽x高.png 规范，已跳过: {rel_path}")
                    continue
                name = m.group("name")
                w, h = int(m.group("w")), int(m.group("h"))

                if HAS_PIL:
                    try:
                        with Image.open(fpath) as im:
                            if im.mode != "RGBA" or im.getchannel("A").getextrema() == (255, 255):
                                warn(f"图片可能没有透明背景（非RGBA或无透明像素）: {rel_path}")
                            real_w, real_h = im.size
                            if (real_w, real_h) != (w, h):
                                warn(f"文件名标注尺寸({w}x{h})与实际像素尺寸({real_w}x{real_h})不一致: {rel_path}")
                    except Exception as e:
                        warn(f"无法读取图片 {rel_path}: {e}")

                if w % GRID_UNIT or h % GRID_UNIT:
                    warn(f"尺寸不是 {GRID_UNIT}px 的整数倍，摆放时会有非整格误差: {rel_path}")

                items.append({
                    "id": f"{theme}/{category}/{name}",
                    "theme": theme,
                    "category": category,
                    "name": name,
                    "file": rel_path,
                    "w": w,
                    "h": h,
                    "gridW": max(1, round(w / GRID_UNIT)),
                    "gridH": max(1, round(h / GRID_UNIT)),
                })

    valid_ids = {i["id"] for i in items}
    layouts = []
    for theme in sorted(os.listdir(SRC_DIR)):
        if only_themes and theme not in only_themes:
            continue
        layouts_path = os.path.join(SRC_DIR, theme, "layouts.json")
        if not os.path.isfile(layouts_path):
            continue
        with open(layouts_path, "r", encoding="utf-8") as f:
            theme_layouts = json.load(f)
        for level in theme_layouts:
            level_items = []
            for it in level.get("items", []):
                if it["assetId"] not in valid_ids:
                    warn(f"关卡 {theme}/{level['sheetId']} 引用了不存在的素材: {it['assetId']}（可能已被删除或改名）")
                    continue
                level_items.append(it)
            level["items"] = level_items
            layouts.append(level)

    theme_extras = {}
    for theme in sorted(os.listdir(SRC_DIR)):
        if only_themes and theme not in only_themes:
            continue
        theme_dir = os.path.join(SRC_DIR, theme)
        if not os.path.isdir(theme_dir):
            continue
        extras = {}
        for kind in ("background", "inspiration"):
            fpath = os.path.join(theme_dir, f"{kind}.png")
            if os.path.isfile(fpath):
                entry = {"file": os.path.relpath(fpath, ROOT).replace(os.sep, "/")}
                if HAS_PIL:
                    try:
                        with Image.open(fpath) as im:
                            entry["w"], entry["h"] = im.size
                    except Exception as e:
                        warn(f"无法读取 {fpath}: {e}")
                extras[kind] = entry
        if extras:
            theme_extras[theme] = extras

    manifest = {"gridUnit": GRID_UNIT, "items": items, "layouts": layouts, "themeExtras": theme_extras}
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(f"已生成 {out_file}，共 {len(items)} 个素材，{len(layouts)} 个可还原关卡。")


if __name__ == "__main__":
    main()
