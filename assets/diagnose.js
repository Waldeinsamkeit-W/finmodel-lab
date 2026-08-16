/* ============================================================================
 * diagnose.js —— 答错诊断
 *
 * 设计原则：不逐格人工标注错误原因，而是从「你的值 vs 参考值」和
 * 「你的公式 vs 参考公式」自动推断最可能的错法。这样 1,800 多个单元格
 * 全部自动获得诊断，且新增模型不需要额外写任何东西。
 *
 * 覆盖的错法按可信度从高到低排列，只报最靠谱的两三条。
 * ==========================================================================*/
(function (global) {
  'use strict';
  const FML = global.FML;

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function near(a, b, rel) {
    if (!isNum(a) || !isNum(b)) return false;
    return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * (rel === undefined ? 0.002 : rel));
  }

  const Diag = {};

  /**
   * @param c {
   *   sheetName, label, userRaw, userVal, solRaw, solVal,
   *   evalIn(formula) -> number|null   // 在用户工作簿里试算一条公式
   * }
   * @returns [{t, d}]  最多 3 条
   */
  Diag.analyze = function (c) {
    const u = c.userVal, s = c.solVal;
    const label = c.label || '';
    const out = [];
    const push = (t, d) => { if (out.length < 3 && !out.some(x => x.t === t)) out.push({ t: t, d: d }); };

    /* ---------- 0. 公式本身报错 ---------- */
    if (c.userErr) {
      push('公式算不出来', c.userErr + '。先把这一格的语法修对，再看结果对不对。');
      return out;
    }

    /* ---------- 0.5 数对了，但不是算出来的 ----------
       这两种情况下面的值层面诊断全都不适用（值本来就是对的），直接返回。 */
    if (c.verdict === 'const') {
      push('这一格是写死的，不是算出来的',
        '数字确实等于参考答案，但你把它直接敲进去了，没有引用任何单元格。' +
        '把上游数据换一组，这一格不会跟着变——那就不是模型，是一张截图。' +
        '模型的价值就在于改一个假设、全表跟着动。请改成从上游格子推出来的公式。');
      return out;
    }
    if (c.verdict === 'nonequiv') {
      push('结果对，但公式和参考答案不等价',
        '在当前这组数据下你算出了正确的数，但把上游数据换一组，你的公式给出 ' +
        (isNum(c.yourVal) ? fmtNum(c.yourVal) : '算不出来') +
        '，参考答案给出 ' + (isNum(c.refVal) ? fmtNum(c.refVal) : '—') + '。' +
        '说明这个数是当前数据下的巧合——比如误用了某个碰巧相等的科目，' +
        '或者少乘了一个当前恰好等于 1 的系数。检查一下这一格到底引用了哪几个格子。');
      return out;
    }

    /* ---------- 0.8 出界：这个数在业务上就不可能 ----------
       排在值层面诊断之前，因为它比「你的结果是参考答案的 2 倍」更根本：
       那些诊断在告诉你算错了哪一步，这一条在告诉你这个数根本不成立。 */
    const bd = c.bounds;
    if (bd && isNum(u)) {
      const lo = (bd[0] === null || bd[0] === undefined) ? -Infinity : bd[0];
      const hi = (bd[1] === null || bd[1] === undefined) ? Infinity : bd[1];
      if (u < lo || u > hi) {
        /* 用这一格自己的显示格式写边界。百分比格里说「不能超过 1」会把人绕晕，
           要说的是「不能超过 100%」——学生看到的就是百分号。 */
        const f = c.fmtVal || fmtNum;
        push('这个数超出了它可能的范围',
          '你算出 ' + f(u) + '，但这一格的取值只可能落在 ' +
          (lo === -Infinity ? '（无下限）' : f(lo)) + ' 到 ' +
          (hi === Infinity ? '（无上限）' : f(hi)) + ' 之间。' +
          (c.boundsNote ? c.boundsNote : '先想清楚这个量的定义，再回头看公式。'));
      }
    }

    /* ---------- 1. 校验行专属：它不为 0 说明错在上游 ---------- */
    if (/校验|差额|平衡/.test(label) && isNum(s) && Math.abs(s) < 1e-6 && isNum(u) && Math.abs(u) > 1e-6) {
      push('校验没通过，但问题多半不在这一格',
        '这是一条校验行，参考答案是 0。你算出 ' + fmtNum(u) + '，说明它引用的那几行里有一个是错的。' +
        '与其改这一格，不如回去逐行检查被校验的项目——这正是校验行存在的意义。');
    }

    /* ---------- 2. 值层面的经典错法 ---------- */
    if (isNum(u) && isNum(s)) {
      if (s !== 0 && near(u, -s)) {
        push('符号反了',
          '你的结果正好是参考答案的相反数。最高频的三个来源：' +
          '① 营运资本变动——资产增加是现金流出（负），负债增加是现金流入（正）；' +
          '② 减项忘了带负号，导致后面用 SUM 加总时方向错了；' +
          '③ 括号位置，比如 =-(C5-B5) 写成了 =-C5-B5。');
      } else if (s !== 0 && near(u, s * 100)) {
        push('放大了 100 倍',
          '通常是百分数和小数混用：15% 要写成 0.15 或 15%，直接写 15 就大了 100 倍。' +
          '也可能这一行要的是比率（0.15），你却按「百分点」乘了 100。');
      } else if (s !== 0 && near(u, s / 100)) {
        push('缩小了 100 倍',
          '如果这一行的名字里带「百分点」或「bp」，说明它要的是差值 ×100（或 ×10000），你少乘了。' +
          '反过来，如果要的是比率，就不该再乘。看清楚行名的单位。');
      } else if (s !== 0 && u !== 0 && near(u, 1 / s)) {
        push('算成倒数了', '分子分母写反。检查一下这一行到底是「A ÷ B」还是「B ÷ A」——比如周转率和周转天数、P/E 和收益率。');
      } else if (near(u, s + 1)) {
        push('忘了减 1', '同比增速 = 本期 ÷ 上期 − 1。你算出来的是「本期 ÷ 上期」这个比值本身。');
      } else if (near(u, s - 1)) {
        push('多减了 1', '这一行要的是比值本身（比如倍数、指数），不是增速，不需要减 1。');
      } else if (s !== 0 && near(u, s * 365)) {
        push('少除了 365', '周转天数换算成金额时要 ÷ 365；反过来算天数时要 ×365。检查一下方向。');
      } else if (s !== 0 && near(u, s / 365)) {
        push('少乘了 365', '周转天数 = 余额 ÷ 流量 × 365。你少了最后这一步。');
      }
    }

    /* ---------- 3. 引用整体挪错了一格（用参考公式平移后重算比对） ---------- */
    if (c.solRaw && String(c.solRaw)[0] === '=' && c.evalIn && !out.length) {
      const shifts = [
        [1, 0, '右边一列', '你多半用了下一期的数'],
        [-1, 0, '左边一列', '你多半用了上一期的数'],
        [0, 1, '下面一行', '行号大了一行'],
        [0, -1, '上面一行', '行号小了一行'],
        [0, 2, '下面两行', '行号大了两行'],
        [0, -2, '上面两行', '行号小了两行']
      ];
      for (let i = 0; i < shifts.length; i++) {
        const sh = shifts[i];
        try {
          const v = c.evalIn(FML.translate(String(c.solRaw), sh[0], sh[1]));
          if (isNum(v) && near(u, v) && !near(v, s)) {
            push('引用挪错了位置',
              '你的结果正好等于把参考公式整体挪到' + sh[2] + '算出来的值——' + sh[3] + '。' +
              '注意分节标题行和空行也各占一个行号，很容易数错一格。');
            break;
          }
        } catch (e) { /* 平移后可能越界，忽略 */ }
      }
    }

    /* ---------- 4. 分母用错（在同表里找一个能解释差异的单元格） ---------- */
    if (isNum(u) && isNum(s) && u !== 0 && s !== 0 && c.scanRatio && !out.length) {
      const hit = c.scanRatio(s / u);   // 找一个单元格 X 使得 用户值 × (X/正确分母) = 参考值
      if (hit) {
        push('分母可能用错了',
          '你的结果和参考答案差了一个 ' + hit + ' 的比例。最常见的是把「营业总收入」和「营业收入」搞混，' +
          '或者算分部占比时分母用了合计以外的数。');
      }
    }

    /* ---------- 5. 引用集合对比（兜底，信息量最低所以放最后） ---------- */
    if (c.userRaw && String(c.userRaw)[0] === '=' && c.solRaw && String(c.solRaw)[0] === '=' && out.length < 2) {
      const ur = FML.refsOf(String(c.userRaw).slice(1), c.sheetName);
      const sr = FML.refsOf(String(c.solRaw).slice(1), c.sheetName);
      const short = (a) => a.map(x => x.indexOf('!') >= 0 && x.split('!')[0] === c.sheetName ? x.split('!')[1] : x);
      const uu = short(ur), ss = short(sr);
      const extra = uu.filter(x => ss.indexOf(x) < 0);
      const missing = ss.filter(x => uu.indexOf(x) < 0);
      if (extra.length || missing.length) {
        push('引用的单元格和参考答案不一致',
          (extra.length ? '你引用了 ' + extra.slice(0, 4).join('、') + (extra.length > 4 ? ' 等' : '') + '；' : '') +
          (missing.length ? '参考答案用到的是 ' + missing.slice(0, 4).join('、') + (missing.length > 4 ? ' 等' : '') + '。' : '') +
          ' 公式可以有多种写法，但如果引用的来源都不一样，多半是理解错了这一行的定义。');
      }
    }

    /* ---------- 6. 硬写数字 ---------- */
    if (c.userRaw && String(c.userRaw)[0] !== '=' && String(c.userRaw).trim() !== '') {
      push('这一格是直接写死的数字',
        '算错了正好说明硬写的风险：数字写死之后，上游一改就对不上，而且看不出它是怎么来的。' +
        '建议改成引用其他单元格的公式。');
    }

    if (!out.length) {
      push('结果和参考答案对不上',
        '你算出 ' + fmtNum(u) + '，参考答案是 ' + fmtNum(s) + '。' +
        '先确认这一行的定义（看行名和单位），再检查引用的每一格是不是你想要的那一格。' +
        '还不行就点「显示参考公式」，对照着看差在哪。');
    }
    return out;
  };

  function fmtNum(v) {
    if (!isNum(v)) return String(v);
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (a >= 1) return v.toFixed(2);
    return v.toFixed(4);
  }

  global.Diag = Diag;
})(window);
