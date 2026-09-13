/* ============================================================================
 * engine.js —— 类 Excel 公式引擎
 * 支持：单元格引用（B4 / $B$4 / 跨表 '利润表'!B4）、区域（B4:D4）、
 *      加减乘除与幂运算、括号、比较运算、百分号、以及常用财务函数。
 * 无任何外部依赖，可直接以 file:// 打开。
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* 一个区域最多展开多少格。求值器和引用扫描器共用这一个数——
     以前只有求值器有上限，refsOf() 在每次键入时都把 SUM(A1:Z500) 整个展开成
     13,000 条引用，用户还没按回车页面就先卡住了。 */
  const MAX_RANGE_CELLS = 4000;

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

  /* 中文输入法下最高频的意外：全角符号。＝（），：等在公式里永远是笔误，
     直接归一化成半角，不用让学员为输入法的事卡住。
     引号内的内容（表名、字符串）要原样保留——表名里带全角括号是合法的。 */
  const FULLWIDTH = {
    '＝': '=', '（': '(', '）': ')', '，': ',', '：': ':', '！': '!', '＄': '$',
    '＋': '+', '－': '-', '−': '-', '—': '-', '＊': '*', '／': '/', '÷': '/',
    '＾': '^', '＜': '<', '＞': '>', '％': '%', '＆': '&', '。': '.', '、': ',',
    '～': '~', '｜': '|'
  };
  /* 弯引号一律先转直引号——它们在任何位置都只可能是引号 */
  function straightenQuotes(s) {
    return s.replace(/[\u2018\u2019\uFF07]/g, "'").replace(/[\u201C\u201D\uFF02]/g, '"');
  }
  /* 全角数字与字母也一并转半角 */
  function narrowAlnum(ch) {
    const c = ch.charCodeAt(0);
    if (c >= 0xFF10 && c <= 0xFF19) return String.fromCharCode(c - 0xFEE0); // ０-９
    if (c >= 0xFF21 && c <= 0xFF3A) return String.fromCharCode(c - 0xFEE0); // Ａ-Ｚ
    if (c >= 0xFF41 && c <= 0xFF5A) return String.fromCharCode(c - 0xFEE0); // ａ-ｚ
    return null;
  }
  function normalizeFullwidth(src) {
    const s = straightenQuotes(String(src));
    let out = '', quote = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {                       // 引号内原样保留
        out += ch;
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
      const alnum = narrowAlnum(ch);
      out += (FULLWIDTH[ch] !== undefined ? FULLWIDTH[ch] : (alnum !== null ? alnum : ch));
    }
    return out;
  }

  function tokenize(src) {
    const s = normalizeFullwidth(src);
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

      throw new Error('无法识别的符号「' + c + '」。如果它看起来和键盘上的一样，'
        + '多半是输入法打成了全角——把输入法切到英文半角再试。');
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
    /* 没有正负交替就不存在 IRR。全零现金流以前会二分出一个 -99.99% 的假解。 */
    const hasPos = flows.some(function (x) { return x > 0; });
    const hasNeg = flows.some(function (x) { return x < 0; });
    if (!hasPos || !hasNeg) throw new Error('IRR 无解：现金流需要有正有负');
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

  /* XIRR：按实际日期折算（Excel 口径：按 365 天年化）。
     以前直接调 irr()，日期参数根本没读——两笔间隔两年的现金流算出的是一年的收益率。 */
  function xirr(flows, dates, guess) {
    if (flows.length !== dates.length || flows.length < 2) throw new Error('XIRR：现金流与日期数量不一致');
    const hasPos = flows.some(function (x) { return x > 0; });
    const hasNeg = flows.some(function (x) { return x < 0; });
    if (!hasPos || !hasNeg) throw new Error('XIRR 无解：现金流需要有正有负');
    const d0 = dates[0];
    const f = function (r) {
      let s = 0;
      for (let i = 0; i < flows.length; i++) s += flows[i] / Math.pow(1 + r, (dates[i] - d0) / 365);
      return s;
    };
    let lo = -0.9999, hi = 10, flo = f(lo), fhi = f(hi);
    if (flo * fhi > 0) {
      let r = (guess === undefined ? 0.1 : guess);
      for (let k = 0; k < 100; k++) {
        const v = f(r), d = (f(r + 1e-6) - v) / 1e-6;
        if (!isFinite(d) || Math.abs(d) < 1e-12) break;
        const nr = r - v / d;
        if (!isFinite(nr)) break;
        if (Math.abs(nr - r) < 1e-10) return nr;
        r = Math.max(nr, -0.9999);
      }
      throw new Error('XIRR 无解');
    }
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
      if (hi - lo < 1e-12) break;
    }
    return (lo + hi) / 2;
  }

  /* Excel 的 ROUND 是「四舍五入、远离零」：ROUND(-1.5,0) = -2。
     JS 的 Math.round 是「向正无穷」：Math.round(-1.5) = -1。差在负数的 .5 上。 */
  function roundHalfAway(x, d) {
    const f = Math.pow(10, d);
    const s = x < 0 ? -1 : 1;
    /* 先加一个极小量再取整，避免 1.005*100 = 100.49999 这种二进制表示误差 */
    return s * Math.round(Math.abs(x) * f + 1e-9) / f;
  }

  /* 年金类函数的 Excel 口径：pv·(1+r)^n + pmt·(1+r·type)·((1+r)^n − 1)/r + fv = 0
     type = 0 期末付（默认），1 期初付。以前 PV 不收 fv 和 type、PMT/FV 不收 type，
     多出来的参数被静默忽略，算出一个看起来正常但错的数。 */
  function annuity(r, n, pmt, pv, fv, type) {
    if (r === 0) return { pmt: -(pv + fv) / n, pv: -(fv + pmt * n), fv: -(pv + pmt * n) };
    const g = Math.pow(1 + r, n), k = 1 + r * type;
    return {
      pmt: -(pv * g + fv) * r / (k * (g - 1)),
      pv: -(fv + pmt * k * (g - 1) / r) / g,
      fv: -(pv * g + pmt * k * (g - 1) / r)
    };
  }
  /* 比较运算的 Excel 口径：都是数按数比；有文本按文本比（不区分大小写）；
     数和文本混比时数永远小于文本。以前一律 num() 后比，"a"="b" 变成 0=0 → 真。 */
  function isTextVal(x) { return typeof x === 'string' && x !== '' && isNaN(parseFloat(x)); }
  function cmp(a, b) {
    if (a && a.__range) a = num(a);
    if (b && b.__range) b = num(b);
    const ta = isTextVal(a), tb = isTextVal(b);
    if (ta && tb) { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); return x < y ? -1 : (x > y ? 1 : 0); }
    if (ta) return 1;   // 文本 > 数
    if (tb) return -1;
    const x = num(a), y = num(b);
    return x < y ? -1 : (x > y ? 1 : 0);
  }
  function argAt(a, i, dflt) { return a.length > i && a[i] !== undefined && a[i] !== '' ? num(a[i]) : dflt; }

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
    ROUND: (a) => roundHalfAway(num(a[0]), a.length > 1 ? num(a[1]) : 0),
    ROUNDUP: (a) => { const d = a.length > 1 ? num(a[1]) : 0; const f = Math.pow(10, d); const x = num(a[0]); return (x < 0 ? -1 : 1) * Math.ceil(Math.abs(x) * f) / f; },
    ROUNDDOWN: (a) => { const d = a.length > 1 ? num(a[1]) : 0; const f = Math.pow(10, d); const x = num(a[0]); return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * f) / f; },
    INT: (a) => Math.floor(num(a[0])),
    IF: (a) => (num(a[0]) !== 0 ? a[1] : (a.length > 2 ? a[2] : 0)),
    IFERROR: (a) => a[0],   // 实际在 evaluate 里惰性处理；这里只是让函数名可被识别
    AND: (a) => (nums(a).every((x) => x !== 0) ? 1 : 0),
    OR: (a) => (nums(a).some((x) => x !== 0) ? 1 : 0),
    NOT: (a) => (num(a[0]) === 0 ? 1 : 0),
    SUMPRODUCT: (a) => {
      const cols = a.map((x) => (x && x.__range ? x.values.map(num) : [num(x)]));
      const n = cols[0].length;
      /* Excel 要求所有区域维度一致，否则 #VALUE!。以前长度不齐时拿首元素补位继续算，
         结果看起来正常，其实是错的。 */
      for (let j = 1; j < cols.length; j++) {
        if (cols[j].length !== n) throw new Error('SUMPRODUCT：各区域大小必须一致（' + n + ' 对 ' + cols[j].length + '）');
      }
      let s = 0;
      for (let i = 0; i < n; i++) { let pr = 1; for (let j = 0; j < cols.length; j++) pr *= cols[j][i]; s += pr; }
      return s;
    },
    NPV: (a) => npv(num(a[0]), nums(a.slice(1))),
    IRR: (a) => irr(nums([a[0]]), a.length > 1 ? num(a[1]) : undefined),
    XIRR: (a) => xirr(nums([a[0]]), nums([a[1]]), a.length > 2 ? num(a[2]) : undefined),
    PMT: (a) => annuity(num(a[0]), num(a[1]), 0, num(a[2]), argAt(a, 3, 0), argAt(a, 4, 0)).pmt,
    PV: (a) => annuity(num(a[0]), num(a[1]), num(a[2]), 0, argAt(a, 3, 0), argAt(a, 4, 0)).pv,
    FV: (a) => annuity(num(a[0]), num(a[1]), num(a[2]), argAt(a, 3, 0), 0, argAt(a, 4, 0)).fv,
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
          if ((c2 - c1 + 1) * (r2 - r1 + 1) > MAX_RANGE_CELLS) throw new Error('区域太大（最多 ' + MAX_RANGE_CELLS + ' 格）');
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
            case '=': return cmp(a, b) === 0 ? 1 : 0;
            case '<>': return cmp(a, b) !== 0 ? 1 : 0;
            case '<': return cmp(a, b) < 0 ? 1 : 0;
            case '>': return cmp(a, b) > 0 ? 1 : 0;
            case '<=': return cmp(a, b) <= 0 ? 1 : 0;
            case '>=': return cmp(a, b) >= 0 ? 1 : 0;
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
          const v = (r && r.__range) ? num(r) : r;
          /* SQRT(-1)、LN(0) 这类结果是 NaN / ±Infinity，不抛错的话 IFERROR 接不住，
             还会一路传成「看起来是个数」的东西。Excel 里它们是 #NUM!。 */
          if (typeof v === 'number' && !isFinite(v)) throw new Error(node.name + '() 结果无效（#NUM!）');
          return v;
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
        let raw = String(cell.raw === undefined || cell.raw === null ? '' : cell.raw).trim();
        /* 开头的全角等号在这里就要转掉：下面是按 raw[0] === '=' 判断是不是公式的，
           tokenize 里的归一化来得太晚，＝B3 会被当成普通文本走到比较运算符那条路上去。 */
        if (raw[0] === '＝') raw = '=' + raw.slice(1);
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
  /* --------------------------------------------------------------------------
   * makeGetter —— 把「模型定义 + 用户输入」包成 Workbook 需要的取值函数。
   *
   * 关键在于**引用不到就报错，而不是当成 0**。
   * 写错表名、或写了超出范围的行号，公式语法完全合法、也算得出一个数，
   * 但那个数是假的——这是学员最难自己发现的一类错。宁可直接报错。
   *
   * 注意：分节标题行、空行里的空格仍然返回 0——那是合法的，
   * SUM(B3:B10) 跨过一个小标题行是正常写法。
   *
   * opts（等价性判定用，见 grade.js）：
   *   perturb(sheetName, col, row, v) -> v'
   *     只作用在 given 格上。把真实数据换成一组「平行世界」的数据，
   *     用来看某一格到底是从上游算出来的，还是写死的常数。
   *   userOnly: 'sheet!ADDR'
   *     只有这一格取用户输入，其余 input 格一律取参考公式。
   *     作用是把每一格隔离开判定：上游填错不该连累下游那格的对错。
   *   override: { 'sheet!ADDR': 数值 }
   *     把指定格子直接钉成某个值，覆盖它原本的公式。
   *     用来单独戳一格看下游反应，perturb 做不到这件事——
   *     恒等式（资产=负债+权益）对所有 given 的等比扰动都免疫。
   * ------------------------------------------------------------------------*/
  function makeGetter(model, inputs, useSolution, opts) {
    const map = {}, names = [];
    (model.sheets || []).forEach(function (s) { map[s.name] = s; names.push(s.name); });
    inputs = inputs || {};
    opts = opts || {};
    const perturb = opts.perturb || null;
    const userOnly = opts.userOnly || null;
    const override = opts.override || null;

    return function (sheetName, col, row) {
      const sh = map[sheetName];
      if (!sh) {
        throw new Error('找不到名为「' + sheetName + '」的表。本模型的表是：' +
          names.join('、') + '。表名要一字不差（含标点）。');
      }
      if (row === 1) return { kind: 'text', raw: sh.header[col] || '' };

      const maxRow = (sh.rows || []).length + 1;
      if (row < 1 || row > maxRow) {
        throw new Error('「' + sheetName + '」没有第 ' + row + ' 行（这张表到第 ' + maxRow + ' 行为止）。');
      }
      const maxCol = (sh.header || []).length - 1;
      if (col < 0 || col > maxCol) {
        throw new Error('「' + sheetName + '」没有 ' + idxToCol(col) + ' 列（这张表到 ' + idxToCol(maxCol) + ' 列为止）。');
      }

      const r = sh.rows[row - 2];
      if (!r) return { kind: 'number', raw: 0 };
      if (col === 0) return { kind: 'text', raw: r.label || '' };
      const c = (r.cells || [])[col - 1];
      if (!c) return { kind: 'number', raw: 0 };        // 分节行/空行里的空格，合法
      if (override) {
        const ok = sheetName + '!' + addr(col, row);
        if (ok in override) return { kind: 'number', raw: override[ok] };
      }
      if (c.kind === 'given') {
        return { kind: 'number', raw: perturb ? perturb(sheetName, col, row, c.v) : c.v };
      }
      if (c.kind === 'calc') return { kind: 'formula', raw: c.f };
      if (c.kind === 'text') return { kind: 'text', raw: c.t };
      if (c.kind === 'input') {
        const key = sheetName + '!' + addr(col, row);
        const useUser = userOnly ? (key === userOnly) : !useSolution;
        if (!useUser) return { kind: 'formula', raw: c.sol };
        return { kind: 'formula', raw: inputs[key] || '' };
      }
      return { kind: 'number', raw: 0 };
    };
  }

  /* 输入分类：这一格的原始输入到底是公式、数字还是文本。
     规则必须和 Workbook.get 完全一致——导出以前自己用「首字符是不是 =」加
     parseFloat 另猜一套，于是 ＝B3-B6 导成了文本、100+23 导成了 100。
     求值和导出共用这一个函数，就不可能再分叉。 */
  const FUNC_ALIAS = { AVG: 'AVERAGE' };
  function classifyInput(raw) {
    let s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (s[0] === '＝') s = '=' + s.slice(1);
    if (s === '') return { kind: 'empty' };
    if (s[0] === '=') return { kind: 'formula', src: s.slice(1) };
    const cleaned = s.replace(/,/g, '');
    if (/^-?\d*\.?\d+%$/.test(cleaned)) return { kind: 'number', value: parseFloat(cleaned) / 100 };
    if (/^-?\d*\.?\d+([eE][+-]?\d+)?$/.test(cleaned)) return { kind: 'number', value: parseFloat(cleaned) };
    /* 不带等号的表达式（100+23、B3-B6）引擎照样当公式算，导出也得当公式 */
    return { kind: 'formula', src: s };
  }
  /* 把公式整理成 Excel 能直接认的样子：全角转半角、别名换正名。
     引号内原样保留（表名里允许全角括号）。 */
  function canonicalFormula(src) {
    let s = normalizeFullwidth(String(src));
    Object.keys(FUNC_ALIAS).forEach(function (k) {
      s = s.replace(new RegExp('(^|[^A-Za-z0-9_])' + k + '\\s*\\(', 'gi'), '$1' + FUNC_ALIAS[k] + '(');
    });
    return s;
  }

  global.FML = {
    classifyInput: classifyInput,
    canonicalFormula: canonicalFormula,
    MAX_RANGE_CELLS: MAX_RANGE_CELLS,
    makeGetter: makeGetter,
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
              if ((c2 - c1 + 1) * (r2 - r1 + 1) > MAX_RANGE_CELLS) {
                /* 超限只记两个角，不展开。真正求值时会报「区域太大」，这里不用重复 */
                out.push(sh + '!' + addr(c1, r1)); out.push(sh + '!' + addr(c2, r2));
              } else {
                for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(sh + '!' + addr(c, r));
              }
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
