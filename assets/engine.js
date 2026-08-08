/* ============================================================================
 * engine.js —— 类 Excel 公式引擎
 * 支持：单元格引用（B4 / $B$4 / 跨表 '利润表'!B4）、区域（B4:D4）、
 *      加减乘除与幂运算、括号、比较运算、百分号、以及常用财务函数。
 * 无任何外部依赖，可直接以 file:// 打开。
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 列号转换 */
  function colToIdx(s) {
    let n = 0;
    const up = s.toUpperCase();
    for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
    return n - 1; // A -> 0
  }
  function idxToCol(i) {
    let s = '', n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function addr(col, row) { return idxToCol(col) + row; }

  /* ------------------------------------------------------------------ 词法 */
  const RE_REF = /^\$?([A-Za-z]{1,2})\$?([0-9]{1,5})/;
  const RE_WORD = /[A-Za-z0-9_.一-龥]/;

  function tokenize(src) {
    const s = String(src);
    const out = [];
    let i = 0;
    const isDigit = (c) => c >= '0' && c <= '9';

    while (i < s.length) {
      const c = s[i];

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

      /* 数字（支持 1.2e3 与尾随 %） */
      if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
        let j = i;
        while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
        if (s[j] === 'e' || s[j] === 'E') {
          let k = j + 1;
          if (s[k] === '+' || s[k] === '-') k++;
          if (isDigit(s[k])) { j = k; while (j < s.length && isDigit(s[j])) j++; }
        }
        let num = parseFloat(s.slice(i, j));
        if (isNaN(num)) throw new Error('数字格式有误：' + s.slice(i, j));
        if (s[j] === '%') { num = num / 100; j++; }
        out.push({ t: 'num', v: num });
        i = j; continue;
      }

      /* 字符串字面量 */
      if (c === '"') {
        let j = i + 1, buf = '';
        while (j < s.length && s[j] !== '"') { buf += s[j]; j++; }
        if (j >= s.length) throw new Error('引号没有闭合');
        out.push({ t: 'str', v: buf });
        i = j + 1; continue;
      }

      /* 带引号的表名： '资产负债表'!B4 */
      if (c === "'") {
        let j = i + 1, buf = '';
        while (j < s.length && s[j] !== "'") { buf += s[j]; j++; }
        if (s[j] !== "'") throw new Error('表名的引号没有闭合');
        j++;
        if (s[j] !== '!') throw new Error("表名后面需要一个 ! ，例如 '利润表'!B4");
        out.push({ t: 'sheet', v: buf });
        i = j + 1; continue;
      }

      /* 单元格引用（优先于标识符） */
      if (c === '$' || /[A-Za-z]/.test(c)) {
        const m = RE_REF.exec(s.slice(i));
        if (m) {
          const after = s[i + m[0].length];
          if (!after || !(RE_WORD.test(after) || after === '!' || after === '(')) {
            out.push({ t: 'ref', col: colToIdx(m[1]), row: parseInt(m[2], 10) });
            i += m[0].length; continue;
          }
        }
      }

      /* 标识符：函数名 / 表名 / 布尔值 */
      if (/[A-Za-z_一-龥]/.test(c)) {
        let j = i;
        while (j < s.length && RE_WORD.test(s[j])) j++;
        const word = s.slice(i, j);
        if (s[j] === '!') { out.push({ t: 'sheet', v: word }); i = j + 1; continue; }
        if (s[j] === '(') { out.push({ t: 'func', v: word.toUpperCase() }); i = j; continue; }
        const up = word.toUpperCase();
        if (up === 'TRUE') { out.push({ t: 'num', v: 1 }); i = j; continue; }
        if (up === 'FALSE') { out.push({ t: 'num', v: 0 }); i = j; continue; }
        throw new Error('看不懂的内容：' + word + '（单元格引用要写成 B4 这样的形式）');
      }

      /* 运算符 */
      const two = s.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/^&=<>(),:'.indexOf(c) >= 0) { out.push({ t: 'op', v: c }); i++; continue; }

      throw new Error('无法识别的符号：' + c);
    }
    return out;
  }

  /* ------------------------------------------------------------------ 语法 */
  function parse(tokens) {
    let p = 0;
    const peek = () => tokens[p];
    const isOp = (v) => tokens[p] && tokens[p].t === 'op' && tokens[p].v === v;

    function expect(v) {
      if (!isOp(v)) throw new Error('公式不完整，缺少 " ' + v + ' "');
      p++;
    }

    function parseExpr() { return parseCompare(); }

    function parseCompare() {
      let l = parseAdd();
      while (peek() && peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].indexOf(peek().v) >= 0) {
        const op = tokens[p++].v;
        l = { n: 'bin', op: op, l: l, r: parseAdd() };
      }
      return l;
    }
    function parseAdd() {
      let l = parseMul();
      while (isOp('+') || isOp('-')) { const op = tokens[p++].v; l = { n: 'bin', op: op, l: l, r: parseMul() }; }
      return l;
    }
    function parseMul() {
      let l = parseUnary();
      while (isOp('*') || isOp('/')) { const op = tokens[p++].v; l = { n: 'bin', op: op, l: l, r: parseUnary() }; }
      return l;
    }
    function parseUnary() {
      if (isOp('-')) { p++; return { n: 'neg', e: parseUnary() }; }
      if (isOp('+')) { p++; return parseUnary(); }
      return parsePow();
    }
    function parsePow() {
      let l = parsePrimary();
      if (isOp('^')) { p++; return { n: 'bin', op: '^', l: l, r: parseUnary() }; }
      return l;
    }
    function parseRefTail(sheet) {
      const t = tokens[p];
      if (!t || t.t !== 'ref') throw new Error('表名后面要跟单元格，例如 利润表!B4');
      p++;
      if (isOp(':')) {
        p++;
        const t2 = tokens[p];
        if (!t2 || t2.t !== 'ref') throw new Error('区域写法有误，例如 B4:D4');
        p++;
        return { n: 'range', sheet: sheet, a: t, b: t2 };
      }
      return { n: 'ref', sheet: sheet, col: t.col, row: t.row };
    }
    function parsePrimary() {
      const t = peek();
      if (!t) throw new Error('公式写到一半就结束了');
      if (t.t === 'num') { p++; return { n: 'num', v: t.v }; }
      if (t.t === 'str') { p++; return { n: 'str', v: t.v }; }
      if (t.t === 'sheet') { p++; return parseRefTail(t.v); }
      if (t.t === 'ref') { return parseRefTail(null); }
      if (t.t === 'func') {
        const name = t.v; p++;
        expect('(');
        const args = [];
        if (!isOp(')')) {
          args.push(parseExpr());
          while (isOp(',')) { p++; args.push(parseExpr()); }
        }
        expect(')');
        return { n: 'call', name: name, args: args };
      }
      if (isOp('(')) { p++; const e = parseExpr(); expect(')'); return e; }
      throw new Error('这里不该出现 "' + (t.v !== undefined ? t.v : '?') + '"');
    }

    const ast = parseExpr();
    if (p < tokens.length) throw new Error('公式末尾还有多余内容');
    return ast;
  }

  const astCache = Object.create(null);
  function compile(src) {
    if (astCache[src]) return astCache[src];
    const ast = parse(tokenize(src));
    astCache[src] = ast;
    return ast;
  }

  /* ------------------------------------------------------------------ 函数库 */
  function flat(args) {
    const out = [];
    (function walk(a) {
      if (a === null || a === undefined) return;
      if (Array.isArray(a)) { a.forEach(walk); return; }
      if (typeof a === 'object' && a.__range) { a.values.forEach(walk); return; }
      out.push(a);
    })(args);
    return out;
  }
  function nums(args) {
    return flat(args).filter(function (x) { return typeof x === 'number' && isFinite(x); });
  }
  function num(x) {
    if (typeof x === 'number') return x;
    if (x === null || x === undefined || x === '') return 0;
    if (typeof x === 'object' && x.__range) { const f = nums([x]); return f.length ? f[0] : 0; }
    const v = parseFloat(x);
    return isNaN(v) ? 0 : v;
  }

  function npv(rate, flows) {
    let s = 0;
    for (let i = 0; i < flows.length; i++) s += flows[i] / Math.pow(1 + rate, i + 1);
    return s;
  }
  function irr(flows, guess) {
    const f = function (r) { let s = 0; for (let i = 0; i < flows.length; i++) s += flows[i] / Math.pow(1 + r, i); return s; };
    let lo = -0.9999, hi = 10;
    let flo = f(lo), fhi = f(hi);
    if (flo * fhi > 0) {
      // 牛顿法兜底
      let r = (guess === undefined ? 0.1 : guess);
      for (let k = 0; k < 100; k++) {
        const v = f(r);
        const d = (f(r + 1e-6) - v) / 1e-6;
        if (!isFinite(d) || Math.abs(d) < 1e-12) break;
        const nr = r - v / d;
        if (!isFinite(nr)) break;
        if (Math.abs(nr - r) < 1e-10) return nr;
        r = Math.max(nr, -0.9999);
      }
      throw new Error('IRR 无解：现金流需要有正有负');
    }
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      if (hi - lo < 1e-12) break;
    }
    return (lo + hi) / 2;
  }

  const FUNCS = {
    SUM: (a) => nums(a).reduce((x, y) => x + y, 0),
    PRODUCT: (a) => nums(a).reduce((x, y) => x * y, 1),
    AVERAGE: (a) => { const v = nums(a); if (!v.length) throw new Error('AVERAGE 没有可用数字'); return v.reduce((x, y) => x + y, 0) / v.length; },
    AVG: (a) => FUNCS.AVERAGE(a),
    MEDIAN: (a) => { const v = nums(a).sort((x, y) => x - y); if (!v.length) throw new Error('MEDIAN 没有可用数字'); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; },
    MIN: (a) => { const v = nums(a); return v.length ? Math.min.apply(null, v) : 0; },
    MAX: (a) => { const v = nums(a); return v.length ? Math.max.apply(null, v) : 0; },
    COUNT: (a) => nums(a).length,
    ABS: (a) => Math.abs(num(a[0])),
    SIGN: (a) => Math.sign(num(a[0])),
    SQRT: (a) => Math.sqrt(num(a[0])),
    EXP: (a) => Math.exp(num(a[0])),
    LN: (a) => Math.log(num(a[0])),
    LOG: (a) => (a.length > 1 ? Math.log(num(a[0])) / Math.log(num(a[1])) : Math.log10(num(a[0]))),
    POWER: (a) => Math.pow(num(a[0]), num(a[1])),
    ROUND: (a) => { const d = a.length > 1 ? num(a[1]) : 0; const f = Math.pow(10, d); return Math.round(num(a[0]) * f) / f; },
    ROUNDUP: (a) => { const d = a.length > 1 ? num(a[1]) : 0; const f = Math.pow(10, d); const x = num(a[0]); return (x < 0 ? -1 : 1) * Math.ceil(Math.abs(x) * f) / f; },
    ROUNDDOWN: (a) => { const d = a.length > 1 ? num(a[1]) : 0; const f = Math.pow(10, d); const x = num(a[0]); return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * f) / f; },
    INT: (a) => Math.floor(num(a[0])),
    IF: (a) => (num(a[0]) !== 0 ? a[1] : (a.length > 2 ? a[2] : 0)),
    IFERROR: (a) => a[0],
    AND: (a) => (nums(a).every((x) => x !== 0) ? 1 : 0),
    OR: (a) => (nums(a).some((x) => x !== 0) ? 1 : 0),
    NOT: (a) => (num(a[0]) === 0 ? 1 : 0),
    SUMPRODUCT: (a) => {
      const cols = a.map((x) => (x && x.__range ? x.values.map(num) : [num(x)]));
      const n = Math.max.apply(null, cols.map((c) => c.length));
      let s = 0;
      for (let i = 0; i < n; i++) { let pr = 1; for (let j = 0; j < cols.length; j++) pr *= (cols[j][i] !== undefined ? cols[j][i] : cols[j][0]); s += pr; }
      return s;
    },
    NPV: (a) => npv(num(a[0]), nums(a.slice(1))),
    IRR: (a) => irr(nums([a[0]]), a.length > 1 ? num(a[1]) : undefined),
    XIRR: (a) => irr(nums([a[0]])),
    PMT: (a) => { const r = num(a[0]), n = num(a[1]), pv = num(a[2]); if (r === 0) return -pv / n; return -(pv * r) / (1 - Math.pow(1 + r, -n)); },
    PV: (a) => { const r = num(a[0]), n = num(a[1]), pmt = num(a[2]); if (r === 0) return -pmt * n; return -pmt * (1 - Math.pow(1 + r, -n)) / r; },
    FV: (a) => { const r = num(a[0]), n = num(a[1]), pmt = num(a[2]), pv = a.length > 3 ? num(a[3]) : 0; if (r === 0) return -(pv + pmt * n); return -(pv * Math.pow(1 + r, n) + pmt * (Math.pow(1 + r, n) - 1) / r); },
    ISNUMBER: (a) => (typeof a[0] === 'number' && isFinite(a[0]) ? 1 : 0)
  };

  /* ------------------------------------------------------------------ 求值 */
  function evaluate(ast, ctx) {
    function ev(node) {
      switch (node.n) {
        case 'num': return node.v;
        case 'str': return node.v;
        case 'neg': return -num(ev(node.e));
        case 'ref': return ctx.get(node.sheet || ctx.sheet, node.col, node.row);
        case 'range': {
          const sh = node.sheet || ctx.sheet;
          const c1 = Math.min(node.a.col, node.b.col), c2 = Math.max(node.a.col, node.b.col);
          const r1 = Math.min(node.a.row, node.b.row), r2 = Math.max(node.a.row, node.b.row);
          if ((c2 - c1 + 1) * (r2 - r1 + 1) > 4000) throw new Error('区域太大');
          const vals = [];
          for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) vals.push(ctx.get(sh, c, r));
          return { __range: true, values: vals };
        }
        case 'bin': {
          const op = node.op;
          if (op === '&') return String(ev(node.l)) + String(ev(node.r));
          const a = ev(node.l), b = ev(node.r);
          switch (op) {
            case '+': return num(a) + num(b);
            case '-': return num(a) - num(b);
            case '*': return num(a) * num(b);
            case '/': {
              const d = num(b);
              if (d === 0) throw new Error('除数为 0');
              return num(a) / d;
            }
            case '^': return Math.pow(num(a), num(b));
            case '=': return (num(a) === num(b)) ? 1 : 0;
            case '<>': return (num(a) !== num(b)) ? 1 : 0;
            case '<': return num(a) < num(b) ? 1 : 0;
            case '>': return num(a) > num(b) ? 1 : 0;
            case '<=': return num(a) <= num(b) ? 1 : 0;
            case '>=': return num(a) >= num(b) ? 1 : 0;
          }
          throw new Error('不支持的运算符 ' + op);
        }
        case 'call': {
          const fn = FUNCS[node.name];
          if (!fn) throw new Error('不支持的函数：' + node.name + '()');
          if (node.name === 'IF') {
            const cond = num(ev(node.args[0]));
            if (cond !== 0) return ev(node.args[1]);
            return node.args.length > 2 ? ev(node.args[2]) : 0;
          }
          if (node.name === 'IFERROR') {
            try { return ev(node.args[0]); } catch (e) { return node.args.length > 1 ? ev(node.args[1]) : 0; }
          }
          const args = node.args.map(ev);
          const r = fn(args);
          return (r && r.__range) ? num(r) : r;
        }
      }
      throw new Error('公式结构异常');
    }
    const v = ev(ast);
    return (v && v.__range) ? num(v) : v;
  }

  /* ==========================================================================
   * Workbook —— 把「模型定义 + 用户输入」变成一张可求值的工作簿
   * ========================================================================*/
  function Workbook(model, getRaw) {
    this.model = model;
    this.getRaw = getRaw;           // (sheetName, colIdx, rowNum) -> {kind, raw}
    this.cache = Object.create(null);
    this.stack = Object.create(null);
    this.sheetByName = Object.create(null);
    (model.sheets || []).forEach((s) => { this.sheetByName[s.name] = s; });
  }

  Workbook.prototype.reset = function () {
    this.cache = Object.create(null);
    this.stack = Object.create(null);
  };

  Workbook.prototype.get = function (sheetName, col, row) {
    const key = sheetName + '!' + col + ':' + row;
    if (key in this.cache) {
      const c = this.cache[key];
      if (c && c.__err) throw new Error(c.msg);
      return c;
    }
    if (this.stack[key]) throw new Error('循环引用：' + sheetName + '!' + addr(col, row));
    this.stack[key] = true;
    let out;
    try {
      const cell = this.getRaw(sheetName, col, row);
      if (!cell) out = 0;
      else if (cell.kind === 'text') out = cell.raw;
      else if (cell.kind === 'number') out = cell.raw;
      else {
        const raw = String(cell.raw === undefined || cell.raw === null ? '' : cell.raw).trim();
        if (raw === '') out = 0;
        else if (raw[0] === '=') out = evaluate(compile(raw.slice(1)), { sheet: sheetName, get: this.get.bind(this) });
        else {
          const cleaned = raw.replace(/,/g, '');
          if (/^-?\d*\.?\d+%$/.test(cleaned)) out = parseFloat(cleaned) / 100;
          else if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(cleaned)) out = parseFloat(cleaned);
          else out = evaluate(compile(raw), { sheet: sheetName, get: this.get.bind(this) });
        }
      }
      this.cache[key] = out;
    } catch (e) {
      this.cache[key] = { __err: true, msg: e.message };
      delete this.stack[key];
      throw e;
    }
    delete this.stack[key];
    return out;
  };

  Workbook.prototype.tryGet = function (sheetName, col, row) {
    try { return { ok: true, v: this.get(sheetName, col, row) }; }
    catch (e) { return { ok: false, err: e.message }; }
  };

  /* ==========================================================================
   * 引用扫描与公式平移（拖拽填充 / 复制粘贴用）
   * $ 锁定的部分不平移，与 Excel 一致。
   * ========================================================================*/
  const RE_REF_ABS = /^(\$?)([A-Za-z]{1,2})(\$?)([0-9]{1,5})/;

  function scanRefs(src) {
    const s = String(src);
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') { let j = i + 1; while (j < s.length && s[j] !== '"') j++; i = j + 1; continue; }
      if (c === "'") { let j = i + 1; while (j < s.length && s[j] !== "'") j++; i = j + 1; continue; }
      if (c === '$' || /[A-Za-z]/.test(c)) {
        const m = RE_REF_ABS.exec(s.slice(i));
        if (m) {
          const end = i + m[0].length;
          const before = s[i - 1];
          const after = s[end];
          const okBefore = !before || !/[A-Za-z0-9_.一-龥$]/.test(before);
          const okAfter = !after || !(/[A-Za-z0-9_.一-龥]/.test(after) || after === '!' || after === '(');
          if (okBefore && okAfter) {
            out.push({
              start: i, end: end,
              absCol: m[1] === '$', col: colToIdx(m[2]),
              absRow: m[3] === '$', row: parseInt(m[4], 10)
            });
            i = end; continue;
          }
        }
      }
      i++;
    }
    return out;
  }

  /** 把公式里的相对引用整体平移 dCol 列、dRow 行 */
  function translate(src, dCol, dRow) {
    const s = String(src);
    if (!s || s[0] !== '=') return s;
    if (!dCol && !dRow) return s;
    const refs = scanRefs(s);
    let out = s;
    for (let k = refs.length - 1; k >= 0; k--) {
      const r = refs[k];
      const nc = r.absCol ? r.col : r.col + dCol;
      const nr = r.absRow ? r.row : r.row + dRow;
      const txt = (nc < 0 || nr < 1)
        ? '#REF!'
        : (r.absCol ? '$' : '') + idxToCol(nc) + (r.absRow ? '$' : '') + nr;
      out = out.slice(0, r.start) + txt + out.slice(r.end);
    }
    return out;
  }

  /* ------------------------------------------------------------------ 导出 */
  global.FML = {
    scanRefs: scanRefs,
    translate: translate,
    colToIdx: colToIdx,
    idxToCol: idxToCol,
    addr: addr,
    tokenize: tokenize,
    compile: compile,
    evaluate: evaluate,
    Workbook: Workbook,
    FUNCS: FUNCS,
    /* 提取公式里引用到的单元格地址（用于高亮） */
    refsOf: function (src, curSheet) {
      const out = [];
      try {
        const toks = tokenize(src);
        let sheet = null;
        for (let i = 0; i < toks.length; i++) {
          const t = toks[i];
          if (t.t === 'sheet') { sheet = t.v; continue; }
          if (t.t === 'ref') {
            const sh = sheet || curSheet;
            if (toks[i + 1] && toks[i + 1].t === 'op' && toks[i + 1].v === ':' && toks[i + 2] && toks[i + 2].t === 'ref') {
              const b = toks[i + 2];
              const c1 = Math.min(t.col, b.col), c2 = Math.max(t.col, b.col);
              const r1 = Math.min(t.row, b.row), r2 = Math.max(t.row, b.row);
              for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(sh + '!' + addr(c, r));
              i += 2;
            } else {
              out.push(sh + '!' + addr(t.col, t.row));
            }
            sheet = null;
          }
        }
      } catch (e) { /* 输入过程中语法不完整属正常 */ }
      return out;
    }
  };
})(window);
