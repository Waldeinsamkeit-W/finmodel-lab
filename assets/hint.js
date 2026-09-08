/* ============================================================================
 * hint.js —— 三级提示
 *
 * 旧版只有一个「提示」按钮，点下去侧栏直接显示完整参考公式，而且**不做任何记录**。
 * 于是学员看完公式自己敲一遍，系统认为他独立完成了，进度照样 100%。
 * 那让完成度这个数字失去了意义，也让「提示」变成了变相的答案按钮。
 *
 * 现在分三级，每一级都记录，逐级给出更多信息：
 *
 *   1 级 · 这一格在干什么   —— 所属小节、单位、参考答案用到几个格子（不说是哪些）
 *   2 级 · 该引用哪些数     —— 列出参考答案引用的行（用行标签，不给地址运算）
 *   3 级 · 公式骨架         —— 保留运算结构，把每个引用换成 ___
 *
 * 再往后才是「查看答案」，那是另一个按钮，并且要二次确认。
 *
 * 关键设计：**三级全部自动生成，不需要给任何一格写提示文案。**
 * 3,765 个作答格如果要人工写三段提示，那是上万段文案，永远写不完；
 * 而且会违背 diagnose.js 立的规矩——新增模型不需要额外写任何东西。
 * ==========================================================================*/
(function (global) {
  'use strict';

  const FML = global.FML;
  const Hint = {};

  Hint.MAX = 3;

  /* 单元格引用（含跨表的 '表名'!B12 和区域 B3:D3）。
     函数名不会误命中：SUM / IF 后面没有数字。 */
  const REF = /(?:'[^']*'|[A-Za-z_一-龥][\w.一-龥]*)!\$?[A-Za-z]{1,2}\$?\d{1,5}(?:\s*:\s*\$?[A-Za-z]{1,2}\$?\d{1,5})?|\$?[A-Za-z]{1,2}\$?\d{1,5}(?:\s*:\s*\$?[A-Za-z]{1,2}\$?\d{1,5})?/g;

  function stripEq(s) {
    return String(s === undefined || s === null ? '' : s).trim().replace(/^[=＝]/, '');
  }

  /* 参考公式引用到的格子，去重后保留出现顺序 */
  function refsOf(sol, sheetName) {
    const out = [], seen = Object.create(null);
    FML.refsOf(stripEq(sol), sheetName).forEach(function (r) {
      if (!seen[r]) { seen[r] = 1; out.push(r); }
    });
    return out;
  }

  /* 'sheet!B12' -> 那一行的标签 */
  function labelOf(model, ref) {
    const i = ref.lastIndexOf('!');
    if (i < 0) return ref;
    const sheetName = ref.slice(0, i);
    const m = /^([A-Za-z]{1,2})(\d{1,5})$/.exec(ref.slice(i + 1));
    if (!m) return ref;
    const sh = (model.sheets || []).filter(function (s) { return s.name === sheetName; })[0];
    if (!sh) return ref;
    const row = parseInt(m[2], 10);
    if (row === 1) return sheetName + ' 表头「' + (sh.header[FML.colToIdx(m[1])] || '') + '」';
    const r = (sh.rows || [])[row - 2];
    if (!r || !r.label) return ref;
    return r.label;
  }

  /* 这一格所属的小节标题：往上找最近的 SEC 行 */
  function sectionOf(sheet, row) {
    for (let i = row - 2; i >= 0; i--) {
      const r = (sheet.rows || [])[i];
      if (r && r.style === 'sec' && r.label) return r.label;
    }
    return null;
  }

  /* 模型的操作步骤里有没有点名这一格。
     两种写法都要认：小模型的步骤写「第 12 行」「第 9–11 行」，按行号匹配；
     大模型（⭐ 完整案例）的步骤写「第 4 张表：勾稽桥」，按表序号匹配。
     只认行号的话，1 级提示在最难的模型上覆盖率不到一半——越难的越薄，正好反了。
     行号更具体，先试行号；没有再退到表序号。 */
  const RE_ROW   = /第\s*(\d{1,3})\s*(?:[–—-]\s*(\d{1,3})\s*)?行/g;
  const RE_SHEET = /第\s*(\d{1,2})\s*(?:[–—-]\s*(\d{1,2})\s*)?张表/g;

  function inRange(n, m) {
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    return n >= Math.min(a, b) && n <= Math.max(a, b);
  }

  function stepFor(model, sheetNo, row, sheetName) {
    const steps = model.steps || [];
    /* 先按行号；标题和正文都看，有的模型把行号写在标题里 */
    for (let i = 0; i < steps.length; i++) {
      const txt = String(steps[i].t || '') + ' ' + String(steps[i].d || '');
      let m; RE_ROW.lastIndex = 0;
      while ((m = RE_ROW.exec(txt)) !== null) if (inRange(row, m)) return steps[i];
    }
    /* 再按表序号 */
    for (let i = 0; i < steps.length; i++) {
      const txt = String(steps[i].t || '') + ' ' + String(steps[i].d || '');
      let m; RE_SHEET.lastIndex = 0;
      while ((m = RE_SHEET.exec(txt)) !== null) if (inRange(sheetNo, m)) return steps[i];
    }
    /* 最后按表名。第三种写法：「做利润表」「搭「来源与用途」」「看「假设」这张表」。
       标题里出现表名就认（标题短而刻意）；正文只认带「」引号的，
       否则「教学假设」这种散文会把名叫「假设」的表匹配到一堆无关步骤上。 */
    if (sheetName) {
      const quoted = '「' + sheetName + '」';
      for (let i = 0; i < steps.length; i++) {
        if (String(steps[i].t || '').indexOf(sheetName) >= 0) return steps[i];
      }
      for (let i = 0; i < steps.length; i++) {
        if (String(steps[i].d || '').indexOf(quoted) >= 0) return steps[i];
      }
    }
    return null;
  }

  /** 公式骨架：保留运算结构，引用换成 ___ */
  Hint.skeleton = function (sol) {
    const s = stripEq(sol);
    if (!s) return '';
    return '=' + s.replace(REF, '___');
  };

  /**
   * 生成某一级提示。
   * @returns { tier, title, body, refs?, skeleton? } 或 null
   */
  Hint.of = function (model, sheet, col, row, tier) {
    const r = (sheet.rows || [])[row - 2];
    const def = r && (r.cells || [])[col - 1];
    if (!def || def.kind !== 'input') return null;

    const refs = refsOf(def.sol, sheet.name);

    if (tier === 1) {
      const sec = sectionOf(sheet, row);
      const sheetNo = (model.sheets || []).indexOf(sheet) + 1;
      const st = stepFor(model, sheetNo, row, sheet.name);
      const bits = [];
      if (sec) bits.push('这一格属于「' + sec + '」。');
      if (r.note) bits.push(r.note + '。');
      bits.push(refs.length
        ? '参考答案用到了 ' + refs.length + ' 个格子的数据——先想清楚是哪几个，再动手。'
        : '参考答案是一个直接填入的假设值，不需要引用别的格子。');
      if (sheet.unit) bits.push('单位：' + sheet.unit + '。');
      return {
        tier: 1, title: '这一格在干什么',
        body: bits.join(''),
        step: st ? (st.t + '：' + st.d) : null
      };
    }

    if (tier === 2) {
      if (!refs.length) {
        return { tier: 2, title: '该引用哪些数', body: '这一格不引用任何其它格子，直接填入题目给定的假设值即可。' };
      }
      return {
        tier: 2, title: '该引用哪些数',
        body: '参考答案用到了下面这些行。怎么组合起来还是你自己想——',
        refs: refs.map(function (ref) {
          const cross = ref.slice(0, ref.lastIndexOf('!')) !== sheet.name;
          return { ref: ref, label: labelOf(model, ref), cross: cross };
        })
      };
    }

    if (tier === 3) {
      return {
        tier: 3, title: '公式骨架',
        body: '运算结构在这里了，每个 ___ 是一个你要自己填的引用：',
        skeleton: Hint.skeleton(def.sol)
      };
    }
    return null;
  };

  global.Hint = Hint;
})(window);
