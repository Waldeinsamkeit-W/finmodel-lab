/* ============================================================================
 * xlsx.js —— 导出真正的 .xlsx（ZIP + SheetML），不依赖任何库
 *
 * 用 stored（不压缩）方式写 ZIP，只需要自己实现 CRC32，几十行就够，
 * 生成的文件 Excel / WPS / Numbers 都能直接打开。
 *
 * 导出的是**公式**而不是计算结果——跨表引用、$ 锁定、SUM 区域全部保留，
 * 打开后 Excel 会自己重算。这样才能把练习成果真正带走。
 * ==========================================================================*/
(function (global) {
  'use strict';
  const FML = global.FML;

  /* ------------------------------------------------------------ CRC32 */
  let CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32(buf) {
    const t = crcTable();
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ------------------------------------------------------------ ZIP */
  function strBytes(s) { return new TextEncoder().encode(s); }

  function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    files.forEach(function (f) {
      const name = strBytes(f.name);
      const data = typeof f.data === 'string' ? strBytes(f.data) : f.data;
      const crc = crc32(data);
      const lh = new Uint8Array(30 + name.length);
      const dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);      // version
      dv.setUint16(6, 0, true);       // flags
      dv.setUint16(8, 0, true);       // method = stored
      dv.setUint16(10, 0, true);      // time
      dv.setUint16(12, 0x2100, true); // date (2000-01-01)
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);
      lh.set(name, 30);
      chunks.push(lh, data);

      const ch = new Uint8Array(46 + name.length);
      const cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x2100, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      central.push(ch);
      offset += lh.length + data.length;
    });
    let cdSize = 0;
    central.forEach(function (c) { cdSize += c.length; });
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const all = chunks.concat(central, [end]);
    let total = 0;
    all.forEach(function (a) { total += a.length; });
    const out = new Uint8Array(total);
    let p = 0;
    all.forEach(function (a) { out.set(a, p); p += a.length; });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ------------------------------------------------------------ XML */
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }
  /* Excel 的表名不允许 : \ / ? * [ ]，长度 ≤31 */
  function safeSheetName(n, used) {
    let s = String(n).replace(/[:\\\/\?\*\[\]]/g, '·').slice(0, 31) || 'Sheet';
    let base = s, i = 2;
    while (used[s]) { s = base.slice(0, 28) + '(' + i + ')'; i++; }
    used[s] = 1;
    return s;
  }

  /* 数字格式：和平台内的 fmt 对齐 */
  const NUMFMTS = [
    { id: 164, code: '#,##0' },
    { id: 165, code: '#,##0.0' },
    { id: 166, code: '#,##0.00' },
    { id: 167, code: '#,##0.000' },
    { id: 168, code: '#,##0.0000' },
    { id: 169, code: '0.0%' },
    { id: 170, code: '0.00%' },
    { id: 171, code: '0%' }
  ];
  /* styles.xml 里 cellXfs 的顺序 —— 索引就是 s= 的值 */
  const XF = [
    { fmt: 0, bold: 0, fill: 0 },   // 0 普通
    { fmt: 0, bold: 1, fill: 0 },   // 1 表头/合计（粗体）
    { fmt: 0, bold: 1, fill: 1 },   // 2 分节标题（灰底粗体）
    { fmt: 164, bold: 0, fill: 0 }, // 3 num0
    { fmt: 165, bold: 0, fill: 0 }, // 4 num1
    { fmt: 166, bold: 0, fill: 0 }, // 5 num2
    { fmt: 167, bold: 0, fill: 0 }, // 6 num3
    { fmt: 168, bold: 0, fill: 0 }, // 7 num4
    { fmt: 169, bold: 0, fill: 0 }, // 8 pct1
    { fmt: 170, bold: 0, fill: 0 }, // 9 pct2
    { fmt: 171, bold: 0, fill: 0 }, // 10 pct0
    { fmt: 164, bold: 1, fill: 0 }, // 11 num0 粗体
    { fmt: 166, bold: 1, fill: 0 }, // 12 num2 粗体
    { fmt: 0, bold: 0, fill: 2 },   // 13 待填写（浅蓝底）
    { fmt: 164, bold: 0, fill: 3 }  // 14 真实数据（浅黄底）
  ];
  function styleFor(fmt, bold) {
    const map = { num0: 3, num1: 4, num2: 5, num3: 6, num4: 7, pct1: 8, pct2: 9, pct0: 10 };
    if (bold) {
      if (fmt === 'num2') return 12;
      if (map[fmt] !== undefined) return 11;
      return 1;
    }
    return map[fmt] !== undefined ? map[fmt] : 0;
  }

  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="' + NUMFMTS.length + '">' +
      NUMFMTS.map(function (f) { return '<numFmt numFmtId="' + f.id + '" formatCode="' + esc(f.code) + '"/>'; }).join('') +
      '</numFmts>' +
      '<fonts count="2">' +
      '<font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
      '</fonts>' +
      '<fills count="4">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F0FE"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF7E0"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + XF.length + '">' +
      XF.map(function (x) {
        const fillId = x.fill === 0 ? 0 : (x.fill === 1 ? 1 : (x.fill === 2 ? 2 : 3));
        return '<xf numFmtId="' + x.fmt + '" fontId="' + (x.bold ? 1 : 0) + '" fillId="' + fillId +
          '" borderId="0" xfId="0"' + (x.fmt ? ' applyNumberFormat="1"' : '') +
          (x.bold ? ' applyFont="1"' : '') + (x.fill ? ' applyFill="1"' : '') + '/>';
      }).join('') +
      '</cellXfs></styleSheet>';
  }

  /* Excel 需要用单引号包住含中文/空格的表名 */
  function qSheet(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }

  /**
   * 把平台里的公式改写成 Excel 能认的：
   *   · 表名替换成导出后的安全表名并加引号
   *   · 其余语法（A1 引用、$、SUM、区域）本来就一致
   */
  function toExcelFormula(src, nameMap) {
    let s = String(src).replace(/^=/, '');
    Object.keys(nameMap).forEach(function (orig) {
      const safe = nameMap[orig];
      const q = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp("'" + q + "'!", 'g'), qSheet(safe) + '!');
      s = s.replace(new RegExp('(^|[^A-Za-z0-9_\'一-龥])' + q + '!', 'g'), '$1' + qSheet(safe) + '!');
    });
    return s;
  }

  /* ------------------------------------------------------------ 导出 */
  /**
   * @param model  模型定义
   * @param inputs 用户作答 {sheetName!ADDR: raw}
   * @param opts   {withAnswers:bool} 为 true 时把未作答的格填入参考公式
   */
  const Xlsx = {};
  Xlsx.exportModel = function (model, inputs, opts) {
    opts = opts || {};
    const used = {}, nameMap = {};
    model.sheets.forEach(function (sh) { nameMap[sh.name] = safeSheetName(sh.name, used); });

    const sheetXmls = model.sheets.map(function (sh) {
      const nCols = sh.header.length;
      let rows = '';

      /* 第 1 行：表头 */
      let r1 = '<row r="1">';
      for (let c = 0; c < nCols; c++) {
        r1 += '<c r="' + FML.idxToCol(c) + '1" t="inlineStr" s="1"><is><t>' + esc(sh.header[c]) + '</t></is></c>';
      }
      rows += r1 + '</row>';

      sh.rows.forEach(function (r, ri) {
        const rowNum = ri + 2;
        const isSec = r.style === 'sec';
        const isTot = r.style === 'tot';
        let x = '<row r="' + rowNum + '">';
        x += '<c r="A' + rowNum + '" t="inlineStr" s="' + (isSec ? 2 : (isTot ? 1 : 0)) + '"><is><t>' +
          esc(r.label + (r.note ? '（' + r.note + '）' : '')) + '</t></is></c>';
        for (let c = 1; c < nCols; c++) {
          const cell = (r.cells || [])[c - 1];
          const addr = FML.idxToCol(c) + rowNum;
          if (!cell || cell.kind === 'empty' || isSec || r.style === 'gap') continue;
          const fmt = cell.fmt || r.fmt;
          if (cell.kind === 'given') {
            x += '<c r="' + addr + '" s="' + (isTot ? styleFor(fmt, 1) : styleFor(fmt, 0)) + '"><v>' + cell.v + '</v></c>';
          } else if (cell.kind === 'calc') {
            x += '<c r="' + addr + '" s="' + styleFor(fmt, isTot) + '"><f>' + esc(toExcelFormula(cell.f, nameMap)) + '</f></c>';
          } else if (cell.kind === 'input') {
            let raw = inputs[sh.name + '!' + addr] || '';
            if (!raw && opts.withAnswers) raw = cell.sol;
            const st = raw ? styleFor(fmt, isTot) : 13;
            if (!raw) { x += '<c r="' + addr + '" s="' + st + '"/>'; }
            else if (String(raw)[0] === '=') {
              x += '<c r="' + addr + '" s="' + st + '"><f>' + esc(toExcelFormula(raw, nameMap)) + '</f></c>';
            } else {
              const n = parseFloat(String(raw).replace(/,/g, '').replace('%', ''));
              const v = /%\s*$/.test(String(raw)) ? n / 100 : n;
              if (isFinite(v)) x += '<c r="' + addr + '" s="' + st + '"><v>' + v + '</v></c>';
              else x += '<c r="' + addr + '" s="' + st + '" t="inlineStr"><is><t>' + esc(raw) + '</t></is></c>';
            }
          }
        }
        rows += x + '</row>';
      });

      const cols = '<cols><col min="1" max="1" width="46" customWidth="1"/>' +
        '<col min="2" max="' + Math.max(2, nCols) + '" width="15" customWidth="1"/></cols>';
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>' +
        cols + '<sheetData>' + rows + '</sheetData></worksheet>';
    });

    /* 说明页 */
    const co = (global.DB.companies || []).filter(function (x) { return x.id === model.companyId; })[0];
    const info = [
      ['模型', model.title],
      ['副标题', model.subtitle || ''],
      ['公司', co ? co.name + '（' + co.ticker + '）' : '通用案例'],
      ['难度 / 建议时长', ({ 1: '简单', 2: '中级', 3: '复杂' })[model.level] + ' / 约 ' + model.minutes + ' 分钟'],
      ['', ''],
      ['数据说明', model.dataNote || ''],
      ['', ''],
      ['做完之后应该看懂什么', '']
    ].concat((model.takeaways || []).map(function (t, i) { return [String(i + 1) + '.', t]; }))
      .concat([['', ''], ['导出说明',
        '本文件由 FinModel Lab 导出。浅蓝色单元格是练习中需要你填写的格子；' +
        '公式已按 Excel 语法改写，跨表引用、$ 锁定、SUM 区域都保留，打开后 Excel 会自动重算。' +
        '所有历史财务数据来自公司公开披露的年报 / 10-K，预测与假设已在表内标注，仅供学习使用，不构成投资建议。']]);

    let infoRows = '';
    info.forEach(function (p, i) {
      infoRows += '<row r="' + (i + 1) + '">' +
        '<c r="A' + (i + 1) + '" t="inlineStr" s="1"><is><t>' + esc(p[0]) + '</t></is></c>' +
        '<c r="B' + (i + 1) + '" t="inlineStr"><is><t>' + esc(p[1]) + '</t></is></c></row>';
    });
    const infoXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<cols><col min="1" max="1" width="22" customWidth="1"/><col min="2" max="2" width="110" customWidth="1"/></cols>' +
      '<sheetData>' + infoRows + '</sheetData></worksheet>';

    const allNames = ['说明'].concat(model.sheets.map(function (sh) { return nameMap[sh.name]; }));
    const allXmls = [infoXml].concat(sheetXmls);

    const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      allNames.map(function (n, i) {
        return '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') + '</sheets>' +
      '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>';

    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      allXmls.map(function (_, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (allXmls.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      allXmls.map(function (_, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';

    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    const files = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'xl/workbook.xml', data: wb },
      { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
      { name: 'xl/styles.xml', data: stylesXml() }
    ].concat(allXmls.map(function (x, i) {
      return { name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: x };
    }));

    return zip(files);
  };

  /* 返回 Promise<{ filename, size, renamed }>。保存通道见 save.js —— 制品页跑在
     sandbox iframe 里，页面自己发起的下载会被浏览器拦掉，必须走宿主通道。 */
  Xlsx.download = function (model, inputs, opts) {
    const blob = Xlsx.exportModel(model, inputs, opts);
    const name = global.Save.safeName(model.title) +
      ((opts && opts.withAnswers) ? '（含参考答案）' : '') + '.xlsx';
    return global.Save.file(blob, name);
  };

  global.Xlsx = Xlsx;
})(window);
