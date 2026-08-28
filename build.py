#!/usr/bin/env python3
"""把 index.html + assets + data 打包成一个自包含的单文件 HTML。

claude.ai 制品只接受一个文件，且 CSP 禁止任何外部请求，所以要把 CSS 和全部
脚本按 index.html 里的顺序内联进去。

会产出两个文件：

  dist/finmodel-lab.html             制品版：不带 <!doctype>/<html>/<head>/<body>，
                                     发布成 claude.ai 制品时宿主会自己套壳
  dist/finmodel-lab-standalone.html  独立版：带完整外壳，双击就能用，
                                     可以直接发给别人（微信、邮件、U 盘都行）

两个版本的实际内容完全一样。独立版之所以要单独出一个，是因为少了
<!doctype> 浏览器会进入怪异模式，部分布局会走老式盒模型。

用法：python3 build.py [制品版输出路径]
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


def wrap_standalone(fragment: str) -> str:
    """给制品版套上完整外壳，得到一个能双击打开的独立文件。

    制品版本身已经带了 <meta charset> 和 <title>，直接搬进 <head> 即可；
    额外补的只有 doctype、lang、viewport —— 少了 viewport 手机上会按
    980px 视口缩放，整站字小到看不清。"""
    head, sep, rest = fragment.partition("</title>")
    if not sep:
        head, rest = "", fragment
    else:
        head += sep
    return (
        "<!doctype html>\n"
        '<html lang="zh-CN">\n<head>\n'
        f"{head}\n"
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        "</head>\n<body>\n"
        f"{rest.lstrip()}"
        "\n</body>\n</html>\n"
    )


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    out.parent.mkdir(parents=True, exist_ok=True)
    html = build()
    out.write_text(html, encoding="utf-8")
    print(f"{out}  {len(html.encode('utf-8')) / 1024:.0f} KB")

    alone = out.with_name(out.stem + "-standalone" + out.suffix)
    alone_html = wrap_standalone(html)
    alone.write_text(alone_html, encoding="utf-8")
    print(f"{alone}  {len(alone_html.encode('utf-8')) / 1024:.0f} KB")
