#!/usr/bin/env python3
"""把 index.html + assets + data 打包成一个自包含的单文件 HTML。

claude.ai 制品只接受一个文件，且 CSP 禁止任何外部请求，所以要把 CSS 和全部
脚本按 index.html 里的顺序内联进去。输出不带 <!doctype>/<html>/<head>/<body>
——制品发布时宿主会自己套壳。

用法：python3 build.py [输出路径]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT / "dist" / "finmodel-lab.html"

TAG = re.compile(
    r'<link[^>]+href="([^"]+\.css)"[^>]*>|<script[^>]+src="([^"]+\.js)"[^>]*>\s*</script>'
)
BODY = re.compile(r"<body>(.*?)</body>", re.S)


def build() -> str:
    index = (ROOT / "index.html").read_text(encoding="utf-8")

    title = re.search(r"<title>(.*?)</title>", index, re.S).group(1).strip()
    css_paths = [m.group(1) for m in TAG.finditer(index) if m.group(1)]
    js_paths = [m.group(2) for m in TAG.finditer(index) if m.group(2)]

    body = BODY.search(index).group(1)
    markup = "\n".join(
        ln.strip()
        for ln in TAG.sub("", body).splitlines()
        if ln.strip() and not ln.strip().startswith("<!--")
    )

    out = ['<meta charset="utf-8">', f"<title>{title}</title>"]

    for p in css_paths:
        out.append("<style>")
        out.append(read(p))
        out.append("</style>")

    out.append(markup)

    for p in js_paths:
        out.append("<script>")
        out.append(f"/* ===== {p} ===== */")
        out.append(read(p))
        out.append("</script>")

    return "\n".join(out) + "\n"


def read(rel: str) -> str:
    f = ROOT / rel
    if not f.exists():
        sys.exit(f"缺文件：{rel}")
    return f.read_text(encoding="utf-8").strip()


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    html = build()
    out.write_text(html, encoding="utf-8")
    print(f"{out}  {len(html.encode('utf-8')) / 1024:.0f} KB")
