#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dlt_docs.py — DLT (DeepSeek Light Tool) 文档操作引擎。

由 DSH 永久插件 DLT 的 Host 半区通过钉死的 Python 解释器调用：
    python.exe dlt_docs.py            # 请求走 stdin，响应走 stdout
stdin : {"op": "<操作名>", "args": {...}}
stdout: {"ok": true, "data": {...}}  |  {"ok": false, "error": "..."}

设计要点
  * 只做「文档」这一件事：PDF / Word(.docx) / Excel(.xlsx) / CSV。
  * 所有写操作默认先备份（<原名>.bak-YYYYmmdd-HHMMSS.<ext>），除非 args.backup=false。
  * 依赖按需懒加载：缺哪个库只让用到它的 op 失败，不影响其它 op。
  * 页/行/列对外一律 1 基（1-based），与人类直觉一致；内部转换处已标注。
  * 结构化返回，不做花哨格式化——排版交给 DSH 的展示层。
"""

import csv
import io
import json
import os
import shutil
import subprocess
import sys
import time
import traceback

# ── 基础设施 ────────────────────────────────────────────────────────────────


def _setup_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, default=str))
    sys.stdout.write("\n")
    sys.stdout.flush()


def ok(data):
    emit({"ok": True, "data": data})


def fail(message):
    emit({"ok": False, "error": str(message)})


class DltError(Exception):
    pass


def arg(args, key, default=None, required=False):
    value = args.get(key, default)
    if required and (value is None or value == ""):
        raise DltError("缺少必填参数: " + key)
    return value


def existing(path):
    if not path:
        raise DltError("缺少路径")
    path = os.path.abspath(str(path))
    if not os.path.exists(path):
        raise DltError("文件不存在: " + path)
    return path


def ensure_parent(path):
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)


def backup(path, enabled=True):
    """写前备份；返回备份路径或 None。"""
    if not enabled or not os.path.exists(path):
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    root, ext = os.path.splitext(path)
    target = "%s.bak-%s%s" % (root, stamp, ext)
    n = 1
    while os.path.exists(target):
        target = "%s.bak-%s-%d%s" % (root, stamp, n, ext)
        n += 1
    shutil.copy2(path, target)
    return target


def resolve_out(path, source, args):
    """写目标：显式 out 优先；否则就地写（并备份）。"""
    out = arg(args, "out")
    in_place = not out
    target = os.path.abspath(out) if out else source
    ensure_parent(target)
    bkp = backup(target if not in_place else source, arg(args, "backup", True) is not False)
    return target, in_place, bkp


def lazy(module_name, hint):
    try:
        return __import__(module_name)
    except Exception as exc:  # pragma: no cover - 取决于运行环境
        raise DltError("缺少 Python 库 %s（%s）：%s" % (module_name, hint, exc))


def pymupdf():
    """PyMuPDF：新版叫 pymupdf，老版叫 fitz。"""
    try:
        import pymupdf  # type: ignore

        return pymupdf
    except Exception:
        return lazy("fitz", "pip install pymupdf")


def docx_module():
    return lazy("docx", "pip install python-docx")


def openpyxl_module():
    return lazy("openpyxl", "pip install openpyxl")


def pages_arg(args, total):
    """把 1 基的 pages 参数规整为 0 基索引列表。"""
    raw = args.get("pages")
    if raw is None:
        return list(range(total))
    if isinstance(raw, (int, str)):
        raw = [raw]
    picked = []
    for item in raw:
        if isinstance(item, str) and "-" in item:
            a, b = item.split("-", 1)
            picked.extend(range(int(a), int(b) + 1))
        else:
            picked.append(int(item))
    out = []
    for p in picked:
        idx = p - 1
        if idx < 0 or idx >= total:
            raise DltError("页码越界: %s（共 %d 页）" % (p, total))
        out.append(idx)
    return out


# ── PDF ─────────────────────────────────────────────────────────────────────


def _pdf_open(path):
    fitz = pymupdf()
    return fitz, fitz.open(path)


def op_pdf_info(args):
    path = existing(arg(args, "path", required=True))
    fitz, doc = _pdf_open(path)
    try:
        sizes = []
        for page in doc:
            sizes.append({"width": round(page.rect.width, 2), "height": round(page.rect.height, 2)})
        return {
            "format": "pdf",
            "path": path,
            "bytes": os.path.getsize(path),
            "pages": doc.page_count,
            "encrypted": bool(doc.is_encrypted),
            "metadata": {k: v for k, v in (doc.metadata or {}).items() if v},
            "toc": [{"level": t[0], "title": t[1], "page": t[2]} for t in (doc.get_toc() or [])],
            "pageSizes": sizes[:50],
        }
    finally:
        doc.close()


def op_pdf_read(args):
    path = existing(arg(args, "path", required=True))
    fitz, doc = _pdf_open(path)
    try:
        wanted = pages_arg(args, doc.page_count)
        mode = arg(args, "mode", "text")
        max_chars = int(arg(args, "maxCharsPerPage", 20000) or 20000)
        out = []
        for idx in wanted:
            page = doc.load_page(idx)
            text = page.get_text("text") or ""
            entry = {"page": idx + 1, "chars": len(text)}
            if len(text) > max_chars:
                entry["text"] = text[:max_chars]
                entry["truncated"] = True
            else:
                entry["text"] = text
            if mode in ("blocks", "full"):
                entry["blocks"] = [
                    {"type": b[6] if len(b) > 6 else 0, "bbox": [round(v, 1) for v in b[:4]], "text": (b[4] or "").strip()}
                    for b in page.get_text("blocks")
                ]
            if mode in ("images", "full"):
                entry["images"] = [
                    {"xref": i[0], "width": i[2], "height": i[3], "bpc": i[4], "colorspace": i[5]}
                    for i in page.get_images(full=True)
                ]
            out.append(entry)
        return {"format": "pdf", "path": path, "pages": doc.page_count, "returned": len(out), "content": out}
    finally:
        doc.close()


def op_pdf_render(args):
    path = existing(arg(args, "path", required=True))
    fitz, doc = _pdf_open(path)
    try:
        page_no = int(arg(args, "page", 1))
        if page_no < 1 or page_no > doc.page_count:
            raise DltError("页码越界: %d（共 %d 页）" % (page_no, doc.page_count))
        dpi = int(arg(args, "dpi", 150) or 150)
        out = arg(args, "out")
        if not out:
            root, _ = os.path.splitext(path)
            out = "%s.page%d.png" % (root, page_no)
        out = os.path.abspath(out)
        ensure_parent(out)
        page = doc.load_page(page_no - 1)
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        pix.save(out)
        stem = os.path.splitext(os.path.basename(path))[0]
        out_dir = os.path.dirname(out)
        for extra in (arg(args, "pages") or []):
            n = int(extra)
            if 1 <= n <= doc.page_count:
                p = doc.load_page(n - 1)
                p.get_pixmap(dpi=dpi, alpha=False).save(os.path.join(out_dir, "%s.page%d.png" % (stem, n)))
        return {
            "format": "pdf",
            "path": path,
            "page": page_no,
            "dpi": dpi,
            "image": out,
            "bytes": os.path.getsize(out),
            "width": pix.width,
            "height": pix.height,
        }
    finally:
        doc.close()


def _pdf_to_docx_builtin(path, out, args):
    """不依赖 pdf2docx 的 PDF → DOCX：用 pymupdf 取文本块与表格，再用 python-docx 落盘。

    保真度不如 pdf2docx（没有原始字体/精确排版），但胜在只依赖已装的 pymupdf + python-docx，
    所以 pdf2docx 缺失时这条路仍能让「PDF → 改文字 → 转回 PDF」跑通。
    """
    fitz = pymupdf()
    docx = docx_module()
    doc = fitz.open(path)
    document = docx.Document()
    try:
        first = int(arg(args, "firstPage", 0) or 0)
        last = arg(args, "lastPage")
        last_index = int(last) if last is not None else doc.page_count - 1
        for page_index in range(first, min(last_index + 1, doc.page_count)):
            if page_index > first:
                document.add_page_break()
            page = doc.load_page(page_index)

            tables = []
            try:
                for found in page.find_tables().tables:
                    data = found.extract()
                    if data:
                        tables.append((tuple(found.bbox), data))
            except Exception:
                tables = []

            def inside_table(bbox):
                for tbbox, _ in tables:
                    if (bbox[0] >= tbbox[0] - 2 and bbox[1] >= tbbox[1] - 2
                            and bbox[2] <= tbbox[2] + 2 and bbox[3] <= tbbox[3] + 2):
                        return True
                return False

            items = []
            for block in page.get_text("blocks"):
                if len(block) > 6 and block[6] != 0:
                    continue  # 图片块
                text = (block[4] or "").strip()
                if not text or inside_table(block[:4]):
                    continue
                items.append(("text", (block[1], block[0]), text))
            for tbbox, data in tables:
                items.append(("table", (tbbox[1], tbbox[0]), data))

            # 按「行」再按「列」排序：先粗分到 12pt 一档，避免同一行被拆开
            items.sort(key=lambda item: (round(item[1][0] / 12.0), item[1][1]))

            for kind, _key, payload in items:
                if kind == "text":
                    document.add_paragraph(payload)
                else:
                    rows = len(payload)
                    cols = max((len(r) for r in payload), default=1)
                    table = document.add_table(rows=rows, cols=cols)
                    try:
                        table.style = "Table Grid"
                    except Exception:
                        pass
                    for r, row in enumerate(payload):
                        for c, value in enumerate(row):
                            table.cell(r, c).text = "" if value is None else str(value)
        document.save(out)
    finally:
        doc.close()
    return out


def op_pdf_to_docx(args):
    path = existing(arg(args, "path", required=True))
    out = arg(args, "out")
    if not out:
        out = os.path.splitext(path)[0] + ".docx"
    out = os.path.abspath(out)
    ensure_parent(out)
    if os.path.exists(out):
        backup(out, arg(args, "backup", True) is not False)
    try:
        from pdf2docx import Converter  # type: ignore
    except Exception:
        _pdf_to_docx_builtin(path, out, args)
        return {"format": "docx", "path": out, "source": path, "engine": "pymupdf+python-docx（内置兜底）",
                "bytes": os.path.getsize(out) if os.path.exists(out) else 0}
    first = int(arg(args, "firstPage", 0) or 0)
    last = arg(args, "lastPage")
    cv = Converter(path)
    try:
        # 注意：pdf2docx 的 start/end 必须是整数，传 None 会在库内部 int(None) 崩掉，
        # 所以「从第 0 页开始」要不带参数调用，而不是 start=None。
        if last is None:
            if first == 0:
                cv.convert(out)
            else:
                cv.convert(out, start=first)
        else:
            cv.convert(out, start=first, end=int(last))
    finally:
        cv.close()
    return {"format": "docx", "path": out, "source": path, "engine": "pdf2docx",
            "bytes": os.path.getsize(out) if os.path.exists(out) else 0}


def op_pdf_to_html(args):
    """PDF → HTML。pages 省略时整篇；每页一个 <section>，保留基本版面换行。"""
    path = existing(arg(args, "path", required=True))
    fitz, doc = _pdf_open(path)
    try:
        wanted = pages_arg(args, doc.page_count)
        parts = [
            "<!doctype html><html><head><meta charset='utf-8'>",
            "<title>%s</title>" % os.path.basename(path),
            "<style>body{font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif;margin:32px;line-height:1.6}"
            ".pg{border-bottom:1px dashed #ccc;padding-bottom:18px;margin-bottom:18px}"
            "h3.pgno{color:#888;font-size:12px;font-weight:400}</style></head><body>",
        ]
        for idx in wanted:
            page = doc.load_page(idx)
            parts.append("<section class='pg'><h3 class='pgno'>page %d</h3>" % (idx + 1))
            parts.append(page.get_text("xhtml") or "")
            parts.append("</section>")
        parts.append("</body></html>")
        html = "".join(parts)
        out = arg(args, "out") or (os.path.splitext(path)[0] + ".html")
        out = os.path.abspath(out)
        ensure_parent(out)
        if os.path.exists(out):
            backup(out, arg(args, "backup", True) is not False)
        with io.open(out, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(html)
        return {"format": "html", "path": out, "source": path, "pages": len(wanted), "chars": len(html),
                "bytes": os.path.getsize(out)}
    finally:
        doc.close()


def op_html_to_pdf(args):
    """HTML 文件 → PDF，走 Edge 无头打印（由 Host 传入浏览器路径；这里只做文件校验与输出路径）。"""
    path = existing(arg(args, "path", required=True))
    out = arg(args, "out") or (os.path.splitext(path)[0] + ".pdf")
    out = os.path.abspath(out)
    ensure_parent(out)
    if os.path.exists(out):
        backup(out, arg(args, "backup", True) is not False)
    return {"format": "pdf", "path": out, "source": path, "pending": True}


def _watermark_on(fitz, doc, indexes, text, fontsize, opacity, angle, color):
    """水印：90 的整数倍走 insert_text(rotate=)，任意角度走 TextWriter + morph。

    PyMuPDF 的 insert_text 只接受 0/90/180/270，斜水印必须用 TextWriter 的仿射变换。
    字体按内容选：纯 ASCII 用内置 helv（不嵌字体），含中文才用 china-s —— 后者会把
    约 1.7MB 的 CJK 字体嵌进 PDF，没必要为英文水印付出这个代价。
    """
    needs_cjk = any(ord(ch) > 127 for ch in text)
    fontname = "china-s" if needs_cjk else "helv"
    drawn = 0
    for idx in indexes:
        page = doc.load_page(idx)
        rect = page.rect
        point = fitz.Point(rect.width * 0.12, rect.height * 0.62)
        normalized = angle % 360
        try:
            if normalized % 90 == 0:
                page.insert_text(
                    point, text, fontsize=fontsize, fontname=fontname,
                    color=color, rotate=int(normalized), fill_opacity=opacity, overlay=True,
                )
            else:
                writer = fitz.TextWriter(page.rect)
                writer.append(point, text, font=fitz.Font(fontname), fontsize=fontsize)
                writer.write_text(page, color=color, opacity=opacity,
                                  morph=(point, fitz.Matrix(angle)))
            drawn += 1
        except Exception:
            # 兜底：至少把文字水平打上去，不让整次编辑失败。
            page.insert_text(point, text, fontsize=fontsize, fontname=fontname,
                             color=color, fill_opacity=opacity, overlay=True)
            drawn += 1
    return drawn


def op_pdf_edit(args):
    """PDF 编辑：页级操作 + 文本查找替换 + 水印 + 元数据。"""
    path = existing(arg(args, "path", required=True))
    fitz, doc = _pdf_open(path)
    applied = []
    try:
        for item in (arg(args, "ops") or []):
            kind = item.get("op")
            if kind == "delete_pages":
                idxs = sorted(pages_arg(item, doc.page_count), reverse=True)
                for idx in idxs:
                    doc.delete_page(idx)
                applied.append({"op": kind, "pages": [i + 1 for i in idxs]})
            elif kind == "rotate":
                degrees = int(item.get("degrees", 90))
                for idx in pages_arg(item, doc.page_count):
                    page = doc.load_page(idx)
                    page.set_rotation((page.rotation + degrees) % 360)
                applied.append({"op": kind, "degrees": degrees})
            elif kind == "insert_pdf":
                src = existing(item.get("file"))
                at = int(item.get("at", doc.page_count + 1))
                other = fitz.open(src)
                try:
                    doc.insert_pdf(other, start_at=max(0, min(at - 1, doc.page_count)))
                finally:
                    other.close()
                applied.append({"op": kind, "file": src, "at": at})
            elif kind == "extract":
                idxs = pages_arg(item, doc.page_count)
                out = os.path.abspath(item.get("out") or (os.path.splitext(path)[0] + ".extract.pdf"))
                ensure_parent(out)
                if os.path.exists(out):
                    backup(out, item.get("backup", True) is not False)
                new = fitz.open()
                try:
                    for idx in idxs:
                        new.insert_pdf(doc, from_page=idx, to_page=idx)
                    new.save(out, garbage=3, deflate=True)
                finally:
                    new.close()
                applied.append({"op": kind, "pages": [i + 1 for i in idxs], "out": out})
            elif kind == "merge":
                for extra in (item.get("files") or []):
                    other = fitz.open(existing(extra))
                    try:
                        doc.insert_pdf(other)
                    finally:
                        other.close()
                applied.append({"op": kind, "files": item.get("files")})
            elif kind == "watermark":
                text = str(item.get("text", "DLT"))
                fontsize = float(item.get("fontSize", 48) or 48)
                opacity = float(item.get("opacity", 0.18) or 0.18)
                angle = float(item.get("angle", 45) or 45)
                color = tuple(item.get("color") or (0.5, 0.5, 0.5))
                drawn = _watermark_on(fitz, doc, pages_arg(item, doc.page_count), text, fontsize, opacity, angle, color)
                applied.append({"op": kind, "text": text, "angle": angle, "drawn": drawn})
            elif kind == "replace_text":
                find = str(item.get("find", ""))
                repl = str(item.get("replace", ""))
                if find == "":
                    raise DltError("replace_text 需要 find")
                hits = 0
                for idx in pages_arg(item, doc.page_count):
                    page = doc.load_page(idx)
                    areas = page.search_for(find)
                    if not areas:
                        continue
                    for quad in areas:
                        page.add_redact_annot(quad, text=repl, fontname="china-s", fontsize=item.get("fontSize", 11))
                    page.apply_redactions()
                    hits += len(areas)
                applied.append({"op": kind, "find": find, "replace": repl, "hits": hits})
            elif kind == "set_metadata":
                fields = item.get("fields") or {}
                meta = dict(doc.metadata or {})
                meta.update({k: str(v) for k, v in fields.items()})
                doc.set_metadata(meta)
                applied.append({"op": kind, "fields": fields})
            else:
                raise DltError("不支持的 PDF op: %s" % kind)

        target, in_place, bkp = resolve_out(None, path, args)
        # 统一写临时文件再原子替换：删页/插页后原文件结构已变，增量保存不可靠。
        tmp = target + ".dlt-tmp"
        doc.save(tmp, garbage=3, deflate=True)
        doc.close()
        os.replace(tmp, target)
        return {
            "format": "pdf", "path": target, "inPlace": in_place, "backup": bkp,
            "applied": applied, "bytes": os.path.getsize(target),
        }
    except Exception:
        doc.close()
        raise


def op_pdf_create(args):
    """用一组页面规格创建 PDF：文字 / 图片 / 空白。"""
    fitz = pymupdf()
    out = os.path.abspath(arg(args, "path", required=True))
    ensure_parent(out)
    if os.path.exists(out):
        backup(out, arg(args, "backup", True) is not False)
    doc = fitz.open()
    pages = arg(args, "pages") or [{"text": ""}]
    for spec in pages:
        if isinstance(spec, str):
            spec = {"text": spec}
        width = float(spec.get("width", 595) or 595)
        height = float(spec.get("height", 842) or 842)
        page = doc.new_page(width=width, height=height)
        if spec.get("image"):
            page.insert_image(fitz.Rect(0, 0, width, height), filename=existing(spec["image"]), keep_proportion=True)
        text = spec.get("text")
        if text:
            # 与水面印同理：纯 ASCII 用内置 helv，含中文才嵌 CJK 字体（省 1.7MB）。
            fontname = "china-s" if any(ord(ch) > 127 for ch in str(text)) else "helv"
            page.insert_textbox(
                fitz.Rect(48, 48, width - 48, height - 48), str(text),
                fontsize=float(spec.get("fontSize", 11) or 11), fontname=fontname, align=0,
            )
    doc.save(out, garbage=3, deflate=True)
    doc.close()
    return {"format": "pdf", "path": out, "pages": len(pages), "bytes": os.path.getsize(out)}


def _com_dispatch(prog_id):
    """新建一个**独立的** Office 自动化实例。

    用 DispatchEx 而不是 Dispatch/GetActiveObject，原因有两条（都踩过）：
      1. DispatchEx 强制起新进程，绝不会把用户正开着的 Word/Excel 窗口“接管”，
         也就不会出现“把用户窗口 Visible 改掉/Quit 掉用户文档”这类事故。
      2. win32com 默认走 IDispatch 动态绑定，不需要 Office 的 PIA 类型库；
         而 PowerShell 的 New-Object -ComObject 依赖类型库，在部分安装上会
         直接 TYPE_E_CANTLOADLIBRARY（0x80029C4A）。
    """
    try:
        import win32com.client  # type: ignore
    except Exception as exc:
        raise DltError("缺少 pywin32（pip install pywin32）：%s" % exc)
    return win32com.client.DispatchEx(prog_id)


def _pids_of(image):
    """列出某个镜像名的进程号（用于「只清理本函数自己新建的实例」）。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq " + image, "/FO", "CSV", "/NH"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=25,
        )
        pids = set()
        stem = image.split(".")[0].upper()
        for line in (out.stdout or "").splitlines():
            parts = [p.strip().strip('"') for p in line.split(",")]
            if len(parts) >= 2 and parts[0].upper().startswith(stem):
                try:
                    pids.add(int(parts[1]))
                except Exception:
                    pass
        return pids
    except Exception:
        return set()


def _reap(pids):
    """等一会儿；仍然存活的（=Quit 没生效的）才强杀。只碰我们自己新建的 PID。"""
    if not pids:
        return []
    time.sleep(1.5)
    reaped = []
    for pid in pids:
        try:
            probe = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"],
                                   capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=25)
            if str(pid) in (probe.stdout or ""):
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                               capture_output=True, text=True, timeout=25)
                reaped.append(pid)
        except Exception:
            pass
    return reaped


def _office_to_pdf(prog_id, image, source, out, exporter):
    """在**独立**的 Office 实例里把文档导出成 PDF。

    exporter(app) 负责打开文档并导出，返回需要 Close 的对象。
    """
    before = _pids_of(image)
    app = _com_dispatch(prog_id)
    created = _pids_of(image) - before
    doc = None
    try:
        try:
            app.Visible = False
        except Exception:
            pass
        try:
            app.DisplayAlerts = 0 if prog_id.startswith("Word") else False
        except Exception:
            pass
        doc = exporter(app)
    finally:
        if doc is not None:
            try:
                doc.Close(False)
            except Exception:
                pass
        try:
            app.Quit()
        except Exception:
            pass
        del doc, app
    reaped = _reap(created)
    if not os.path.exists(out):
        raise DltError("Office 没有生成 PDF: " + out)
    return reaped


def op_docx_to_pdf(args):
    """Word 文档 → PDF（Word COM，独立实例，保真最高）。"""
    path = existing(arg(args, "path", required=True))
    out = os.path.abspath(arg(args, "out") or (os.path.splitext(path)[0] + ".pdf"))
    ensure_parent(out)
    bkp = backup(out, arg(args, "backup", True) is not False) if os.path.exists(out) else None

    def exporter(app):
        # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
        doc = app.Documents.Open(path, False, True, False)
        doc.ExportAsFixedFormat(out, 17)  # 17 = wdExportFormatPDF
        return doc

    reaped = _office_to_pdf("Word.Application", "WINWORD.EXE", path, out, exporter)
    return {"format": "pdf", "path": out, "source": path, "bytes": os.path.getsize(out),
            "backup": bkp, "engine": "pywin32/Word", "reaped": reaped}


def op_xlsx_to_pdf(args):
    """Excel 工作簿 → PDF（Excel COM，独立实例）。"""
    path = existing(arg(args, "path", required=True))
    out = os.path.abspath(arg(args, "out") or (os.path.splitext(path)[0] + ".pdf"))
    ensure_parent(out)
    bkp = backup(out, arg(args, "backup", True) is not False) if os.path.exists(out) else None
    rng = arg(args, "range")

    def exporter(app):
        wb = app.Workbooks.Open(path, 0, True)  # UpdateLinks=0, ReadOnly
        if rng:
            wb.Worksheets(1).Range(str(rng)).ExportAsFixedFormat(0, out)  # 0 = xlTypePDF
        else:
            wb.ExportAsFixedFormat(0, out)
        return wb

    reaped = _office_to_pdf("Excel.Application", "EXCEL.EXE", path, out, exporter)
    return {"format": "pdf", "path": out, "source": path, "bytes": os.path.getsize(out),
            "backup": bkp, "engine": "pywin32/Excel", "reaped": reaped}


def op_pdf_convert_chain(args):
    """PDF → (docx|html) 编辑用的中间格式 → PDF。

    链一 word: pdf → docx（pdf2docx）→ 用户在 docx 上编辑 → docx → pdf（Word COM）
    链二 html: pdf → html（pymupdf）→ 在 html 上编辑 → html → pdf（Edge 无头，由 Host 执行）
    本函数只负责「准备中间文件」这一步，转换回 PDF 由 Host 编排。
    """
    chain = str(arg(args, "chain", "word"))
    if chain == "html":
        return op_pdf_to_html(args)
    return op_pdf_to_docx(args)


# ── Word (.docx) ────────────────────────────────────────────────────────────

_PARA_TYPES = {"Heading 1": "h1", "Heading 2": "h2", "Heading 3": "h3", "Heading 4": "h4", "Title": "title"}


def _docx_blocks(document):
    blocks = []
    for index, para in enumerate(document.paragraphs):
        text = para.text or ""
        style = (para.style.name if para.style is not None else "") or ""
        kind = _PARA_TYPES.get(style, "p")
        if text.strip() == "":
            continue
        blocks.append({"type": kind, "style": style, "index": index, "text": text})
    return blocks


def _docx_tables(document):
    tables = []
    for t_index, table in enumerate(document.tables):
        rows = []
        for row in table.rows:
            rows.append([cell.text or "" for cell in row.cells])
        tables.append({"index": t_index, "rows": len(table.rows), "cols": len(table.columns), "data": rows})
    return tables


def op_docx_info(args):
    path = existing(arg(args, "path", required=True))
    docx = docx_module()
    document = docx.Document(path)
    core = document.core_properties
    return {
        "format": "docx",
        "path": path,
        "bytes": os.path.getsize(path),
        "paragraphs": len(document.paragraphs),
        "nonEmptyParagraphs": len(_docx_blocks(document)),
        "tables": len(document.tables),
        "sections": len(document.sections),
        "properties": {
            "title": core.title or "", "author": core.author or "",
            "created": str(core.created or ""), "modified": str(core.modified or ""),
            "subject": core.subject or "", "comments": core.comments or "",
        },
        "stylesUsed": sorted({(p.style.name if p.style is not None else "") for p in document.paragraphs if p.style is not None}),
    }


def op_docx_read(args):
    path = existing(arg(args, "path", required=True))
    docx = docx_module()
    document = docx.Document(path)
    limit = int(arg(args, "maxParagraphs", 4000) or 4000)
    blocks = _docx_blocks(document)
    return {
        "format": "docx",
        "path": path,
        "paragraphs": len(document.paragraphs),
        "blocks": blocks[:limit],
        "truncated": len(blocks) > limit,
        "tables": _docx_tables(document) if arg(args, "tables", True) is not False else [],
    }


def _docx_replace_in_paragraph(para, find, repl):
    hit = 0
    for run in para.runs:
        if find in (run.text or ""):
            run.text = run.text.replace(find, repl)
            hit += 1
    if hit == 0 and find in (para.text or ""):
        # 跨 run 的情况：退化为整段重写（会丢该段局部格式，故计数标注）
        for run in list(para.runs)[1:]:
            run.text = ""
        if para.runs:
            para.runs[0].text = (para.text or "").replace(find, repl)
        hit += 1
    return hit


def op_docx_edit(args):
    path = existing(arg(args, "path", required=True))
    docx = docx_module()
    document = docx.Document(path)
    applied = []
    for item in (arg(args, "ops") or []):
        kind = item.get("op")
        if kind == "replace_text":
            find = str(item.get("find", ""))
            repl = str(item.get("replace", ""))
            if find == "":
                raise DltError("replace_text 需要 find")
            hits = 0
            for para in document.paragraphs:
                hits += _docx_replace_in_paragraph(para, find, repl)
            for table in document.tables:
                for row in table.rows:
                    for cell in row.cells:
                        for para in cell.paragraphs:
                            hits += _docx_replace_in_paragraph(para, find, repl)
            applied.append({"op": kind, "find": find, "replace": repl, "hits": hits})
        elif kind == "set_paragraph":
            index = int(item.get("index", -1))
            if index < 0 or index >= len(document.paragraphs):
                raise DltError("段落下标越界: %s" % index)
            para = document.paragraphs[index]
            text = str(item.get("text", ""))
            if para.runs:
                para.runs[0].text = text
                for run in list(para.runs)[1:]:
                    run.text = ""
            else:
                para.add_run(text)
            applied.append({"op": kind, "index": index})
        elif kind == "add_paragraph":
            text = str(item.get("text", ""))
            style = item.get("style")
            if style:
                document.add_paragraph(text, style=style)
            else:
                document.add_paragraph(text)
            applied.append({"op": kind, "text": text[:80]})
        elif kind == "delete_paragraph":
            index = int(item.get("index", -1))
            if index < 0 or index >= len(document.paragraphs):
                raise DltError("段落下标越界: %s" % index)
            para = document.paragraphs[index]
            element = para._element
            element.getparent().remove(element)
            applied.append({"op": kind, "index": index})
        elif kind == "add_table":
            rows = int(item.get("rows", len(item.get("data") or []) or 1))
            cols = int(item.get("cols", len((item.get("data") or [[]])[0]) or 1))
            table = document.add_table(rows=rows, cols=cols)
            style = item.get("style")
            if style:
                try:
                    table.style = style
                except Exception:
                    pass
            data = item.get("data") or []
            for r, row in enumerate(data):
                for c, value in enumerate(row):
                    if r < len(table.rows) and c < len(table.columns):
                        table.cell(r, c).text = "" if value is None else str(value)
            applied.append({"op": kind, "rows": rows, "cols": cols})
        elif kind == "set_cell":
            t = int(item.get("table", 0))
            r = int(item.get("row", 1)) - 1
            c = int(item.get("col", 1)) - 1
            if t < 0 or t >= len(document.tables):
                raise DltError("表格下标越界: %s" % t)
            table = document.tables[t]
            if r < 0 or r >= len(table.rows) or c < 0 or c >= len(table.columns):
                raise DltError("单元格越界: r%d c%d" % (r + 1, c + 1))
            table.cell(r, c).text = str(item.get("text", ""))
            applied.append({"op": kind, "table": t, "row": r + 1, "col": c + 1})
        elif kind == "add_table_row":
            t = int(item.get("table", 0))
            if t < 0 or t >= len(document.tables):
                raise DltError("表格下标越界: %s" % t)
            table = document.tables[t]
            row = table.add_row()
            for c, value in enumerate(item.get("data") or []):
                if c < len(row.cells):
                    row.cells[c].text = "" if value is None else str(value)
            applied.append({"op": kind, "table": t})
        else:
            raise DltError("不支持的 docx op: %s" % kind)

    target, in_place, bkp = resolve_out(None, path, args)
    document.save(target)
    return {"format": "docx", "path": target, "inPlace": in_place, "backup": bkp, "applied": applied,
            "bytes": os.path.getsize(target)}


def op_docx_create(args):
    docx = docx_module()
    from docx.shared import Pt  # type: ignore
    out = os.path.abspath(arg(args, "path", required=True))
    ensure_parent(out)
    if os.path.exists(out):
        backup(out, arg(args, "backup", True) is not False)
    document = docx.Document()
    title = arg(args, "title")
    if title:
        document.add_heading(str(title), level=0)
    for block in (arg(args, "blocks") or []):
        if isinstance(block, str):
            document.add_paragraph(block)
            continue
        kind = block.get("type", "p")
        if kind in ("h1", "h2", "h3", "h4"):
            document.add_heading(str(block.get("text", "")), level=int(kind[1]))
        elif kind == "table":
            data = block.get("data") or []
            rows = len(data) or 1
            cols = len(data[0]) if data else 1
            table = document.add_table(rows=rows, cols=cols)
            if block.get("style"):
                try:
                    table.style = block["style"]
                except Exception:
                    pass
            for r, row in enumerate(data):
                for c, value in enumerate(row):
                    table.cell(r, c).text = "" if value is None else str(value)
        elif kind == "pagebreak":
            document.add_page_break()
        else:
            para = document.add_paragraph(str(block.get("text", "")))
            for run in para.runs:
                if block.get("bold"):
                    run.bold = True
                if block.get("size"):
                    run.font.size = Pt(float(block["size"]))
    document.save(out)
    return {"format": "docx", "path": out, "blocks": len(arg(args, "blocks") or []), "bytes": os.path.getsize(out)}


# ── Excel (.xlsx) ───────────────────────────────────────────────────────────


def op_xlsx_info(args):
    path = existing(arg(args, "path", required=True))
    openpyxl = openpyxl_module()
    wb = openpyxl.load_workbook(path, data_only=False)
    try:
        return {
            "format": "xlsx", "path": path, "bytes": os.path.getsize(path),
            "sheets": [
                {"name": ws.title, "rows": ws.max_row, "cols": ws.max_column,
                 "hidden": bool(ws.sheet_state != "visible")}
                for ws in wb.worksheets
            ],
            "definedNames": sorted((wb.defined_names or {}).keys()) if wb.defined_names else [],
        }
    finally:
        wb.close()


def _xlsx_cell_value(value):
    if value is None:
        return None
    if isinstance(value, (int, float, bool, str)):
        return value
    return str(value)


def op_xlsx_read(args):
    path = existing(arg(args, "path", required=True))
    openpyxl = openpyxl_module()
    formulas = arg(args, "formulas", True) is not False
    wb = openpyxl.load_workbook(path, data_only=not formulas)
    try:
        sheets_arg = arg(args, "sheets")
        wanted = [str(s) for s in sheets_arg] if sheets_arg else [ws.title for ws in wb.worksheets]
        max_rows = int(arg(args, "maxRows", 500) or 500)
        max_cols = int(arg(args, "maxCols", 60) or 60)
        out = []
        for name in wanted:
            if name not in wb.sheetnames:
                raise DltError("工作表不存在: " + name)
            ws = wb[name]
            rng = arg(args, "range")
            if rng:
                cells = ws[rng]
                if not isinstance(cells, tuple):
                    cells = ((cells,),)
                elif cells and not isinstance(cells[0], tuple):
                    cells = (cells,)
                rows = [[_xlsx_cell_value(c.value) for c in row] for row in cells]
                out.append({"name": name, "range": rng, "rows": rows})
                continue
            rows = []
            for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, max_rows),
                                    max_col=min(ws.max_column, max_cols)):
                rows.append([_xlsx_cell_value(c.value) for c in row])
            out.append({
                "name": name, "totalRows": ws.max_row, "totalCols": ws.max_column,
                "truncated": ws.max_row > max_rows or ws.max_column > max_cols, "rows": rows,
            })
        return {"format": "xlsx", "path": path, "sheets": out}
    finally:
        wb.close()


def op_xlsx_edit(args):
    path = existing(arg(args, "path", required=True))
    openpyxl = openpyxl_module()
    wb = openpyxl.load_workbook(path, data_only=False)
    applied = []
    try:
        for item in (arg(args, "ops") or []):
            kind = item.get("op")
            sheet_name = item.get("sheet")
            ws = wb[sheet_name] if sheet_name else wb.active
            if kind == "set_cell":
                coord = str(item.get("cell", "")).upper()
                if not coord:
                    raise DltError("set_cell 需要 cell（如 B3）")
                ws[coord] = item.get("formula") if item.get("formula") else item.get("value")
                applied.append({"op": kind, "sheet": ws.title, "cell": coord})
            elif kind == "set_range":
                start = str(item.get("start", "A1"))
                data = item.get("data") or []
                for r, row in enumerate(data):
                    for c, value in enumerate(row):
                        ws.cell(row=ws[start].row + r, column=ws[start].column + c, value=value)
                applied.append({"op": kind, "sheet": ws.title, "start": start,
                                "rows": len(data), "cols": len(data[0]) if data else 0})
            elif kind == "append_row":
                ws.append(list(item.get("data") or []))
                applied.append({"op": kind, "sheet": ws.title, "at": ws.max_row})
            elif kind == "insert_row":
                ws.insert_rows(int(item.get("row", 1)))
                if item.get("data"):
                    for c, value in enumerate(item["data"]):
                        ws.cell(row=int(item.get("row", 1)), column=c + 1, value=value)
                applied.append({"op": kind, "sheet": ws.title, "row": item.get("row", 1)})
            elif kind == "delete_row":
                ws.delete_rows(int(item.get("row", 1)), int(item.get("count", 1) or 1))
                applied.append({"op": kind, "sheet": ws.title, "row": item.get("row", 1)})
            elif kind == "add_sheet":
                name = str(item.get("name", "Sheet"))
                if name in wb.sheetnames:
                    raise DltError("工作表已存在: " + name)
                wb.create_sheet(name)
                applied.append({"op": kind, "name": name})
            elif kind == "rename_sheet":
                ws.title = str(item.get("name", ws.title))
                applied.append({"op": kind, "name": ws.title})
            elif kind == "delete_sheet":
                if len(wb.sheetnames) <= 1:
                    raise DltError("至少要保留一个工作表")
                wb.remove(ws)
                applied.append({"op": kind, "name": sheet_name})
            elif kind == "set_number_format":
                rng = str(item.get("range", "A1"))
                for row in ws[rng] if isinstance(ws[rng], tuple) else ((ws[rng],),):
                    for cell in row:
                        cell.number_format = str(item.get("format", "General"))
                applied.append({"op": kind, "range": rng})
            elif kind == "set_column_width":
                for col, width in (item.get("widths") or {}).items():
                    ws.column_dimensions[str(col).upper()].width = float(width)
                applied.append({"op": kind, "widths": item.get("widths")})
            elif kind == "set_style":
                from openpyxl.styles import Alignment, Font, PatternFill  # 子模块需显式导入

                rng = str(item.get("range", "A1"))
                rows = ws[rng]
                if not isinstance(rows, tuple):
                    rows = ((rows,),)
                elif rows and not isinstance(rows[0], tuple):
                    rows = (rows,)
                for row in rows:
                    for cell in row:
                        if item.get("bold") is not None:
                            cell.font = Font(bold=bool(item["bold"]), color=item.get("color"),
                                             size=item.get("size"))
                        if item.get("fill"):
                            cell.fill = PatternFill("solid", fgColor=item["fill"])
                        if item.get("align"):
                            cell.alignment = Alignment(horizontal=str(item["align"]))
                applied.append({"op": kind, "range": rng})
            else:
                raise DltError("不支持的 xlsx op: %s" % kind)

        target, in_place, bkp = resolve_out(None, path, args)
        wb.save(target)
        return {"format": "xlsx", "path": target, "inPlace": in_place, "backup": bkp, "applied": applied,
                "bytes": os.path.getsize(target)}
    finally:
        try:
            wb.close()
        except Exception:
            pass


def op_xlsx_create(args):
    openpyxl = openpyxl_module()
    out = os.path.abspath(arg(args, "path", required=True))
    ensure_parent(out)
    if os.path.exists(out):
        backup(out, arg(args, "backup", True) is not False)
    wb = openpyxl.Workbook()
    default = wb.active
    sheets = arg(args, "sheets") or [{"name": "Sheet1", "rows": []}]
    for index, spec in enumerate(sheets):
        name = str(spec.get("name") or ("Sheet%d" % (index + 1)))
        ws = default if index == 0 else wb.create_sheet()
        ws.title = name
        for row in (spec.get("rows") or []):
            ws.append(list(row))
    if len(sheets) == 0:
        default.title = "Sheet1"
    wb.save(out)
    return {"format": "xlsx", "path": out, "sheets": [str(s.get("name")) for s in sheets],
            "bytes": os.path.getsize(out)}


# ── CSV ─────────────────────────────────────────────────────────────────────


def op_csv_read(args):
    path = existing(arg(args, "path", required=True))
    encoding = arg(args, "encoding", "utf-8-sig")
    with io.open(path, "r", encoding=encoding, newline="") as handle:
        try:
            dialect = csv.Sniffer().sniff(handle.read(4096))
        except Exception:
            dialect = csv.excel
        handle.seek(0)
        rows = list(csv.reader(handle, dialect))
    limit = int(arg(args, "maxRows", 2000) or 2000)
    return {"format": "csv", "path": path, "rows": len(rows),
            "truncated": len(rows) > limit, "data": rows[:limit]}


def op_csv_write(args):
    path = os.path.abspath(arg(args, "path", required=True))
    ensure_parent(path)
    bkp = backup(path, arg(args, "backup", True) is not False)
    rows = arg(args, "rows") or []
    encoding = arg(args, "encoding", "utf-8-sig")
    with io.open(path, "w", encoding=encoding, newline="") as handle:
        writer = csv.writer(handle)
        for row in rows:
            writer.writerow(row if isinstance(row, (list, tuple)) else [row])
    return {"format": "csv", "path": path, "rows": len(rows), "backup": bkp, "bytes": os.path.getsize(path)}


# ── 统一入口 ────────────────────────────────────────────────────────────────

OPERATIONS = {
    "info": lambda a: _dispatch_info(a),
    "read": lambda a: _dispatch_read(a),
    "edit": lambda a: _dispatch_edit(a),
    "create": lambda a: _dispatch_create(a),
    "convert": lambda a: _dispatch_convert(a),
    "render": lambda a: op_pdf_render(a),
}


def _kind_of(path):
    ext = os.path.splitext(str(path))[1].lower()
    if ext == ".pdf":
        return "pdf"
    if ext in (".docx", ".docm"):
        return "docx"
    if ext in (".xlsx", ".xlsm"):
        return "xlsx"
    if ext == ".csv":
        return "csv"
    if ext in (".html", ".htm"):
        return "html"
    if ext == ".doc":
        raise DltError("不支持旧版二进制 .doc，请先另存为 .docx（可用 Word 打开后另存）")
    if ext == ".xls":
        raise DltError("不支持旧版二进制 .xls，请先另存为 .xlsx")
    raise DltError("不支持的文档类型: " + ext)


def _dispatch_info(a):
    kind = _kind_of(arg(a, "path", required=True))
    return {"pdf": op_pdf_info, "docx": op_docx_info, "xlsx": op_xlsx_info}[kind](a)


def _dispatch_read(a):
    kind = _kind_of(arg(a, "path", required=True))
    if kind == "csv":
        return op_csv_read(a)
    return {"pdf": op_pdf_read, "docx": op_docx_read, "xlsx": op_xlsx_read}[kind](a)


def _dispatch_edit(a):
    kind = _kind_of(arg(a, "path", required=True))
    if kind == "csv":
        return op_csv_write(a)
    return {"pdf": op_pdf_edit, "docx": op_docx_edit, "xlsx": op_xlsx_edit}[kind](a)


def _dispatch_create(a):
    kind = str(arg(a, "kind", "") or "")
    path = arg(a, "path", required=True)
    if not kind:
        kind = _kind_of(path)
    return {"pdf": op_pdf_create, "docx": op_docx_create, "xlsx": op_xlsx_create, "csv": op_csv_write}[kind](a)


def _dispatch_convert(a):
    target = str(arg(a, "to", "") or "").lower()
    if target == "docx":
        return op_pdf_to_docx(a)
    if target == "html":
        return op_pdf_to_html(a)
    if target == "pdf":
        # Office 文档 → PDF 走 COM（独立实例）；HTML → PDF 由 Host 用 Edge 无头打印。
        kind = _kind_of(arg(a, "path", required=True))
        if kind == "docx":
            return op_docx_to_pdf(a)
        if kind == "xlsx":
            return op_xlsx_to_pdf(a)
        if kind == "html":
            return op_html_to_pdf(a)
        raise DltError("不支持 %s → pdf（PDF→PDF 无意义）" % kind)
    if target in ("pdfchain", "chain"):
        return op_pdf_convert_chain(a)
    raise DltError("不支持的转换目标: " + target)


def main():
    _setup_stdio()
    raw = sys.stdin.read()
    if not raw.strip():
        fail("空请求")
        return
    try:
        request = json.loads(raw)
    except Exception as exc:
        fail("请求不是合法 JSON: %s" % exc)
        return
    op = str(request.get("op", ""))
    args = request.get("args") or {}
    handler = OPERATIONS.get(op)
    if handler is None:
        fail("未知操作: %s（可用: %s）" % (op, ", ".join(sorted(OPERATIONS))))
        return
    try:
        ok(handler(args))
    except DltError as exc:
        fail(exc)
    except Exception as exc:  # noqa: BLE001 - 顶层兜底，保证始终有 JSON 输出
        fail("%s: %s\n%s" % (type(exc).__name__, exc, traceback.format_exc(limit=3)))


if __name__ == "__main__":
    main()
