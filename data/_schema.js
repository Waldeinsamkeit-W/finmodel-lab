/* ============================================================================
 * _schema.js —— 数据结构与快捷构造函数
 *
 * 一张 sheet 的坐标约定（和 Excel 完全一致）：
 *   第 1 行 = 表头行；A 列 = 科目名称列；数据从 B 列、第 2 行开始。
 *   即 rows[0] 的第一个 cell 的地址是 B2。
 *
 * 单元格三种类型：
 *   G(v)      给定值（只读：历史披露数据、预测假设或构造数据，界面按 note / 表头 / dataNote 区分标注）
 *   I(sol)    需要作答的输入格；sol 是参考公式（引擎会用它算出标准答案）
 *   C(f)      模型自带的计算格（只读，用来把中间步骤先摆出来）
 * ==========================================================================*/
(function (global) {
  'use strict';

  /** 给定值，只读。是不是真实数据由模型 dataNote、行 note、列表头共同决定，见 grid.js givenTitle */
  function G(v, o) { const c = { kind: 'given', v: v }; return o ? Object.assign(c, o) : c; }

  /**
   * 输入格：sol 为参考公式（不带等号也可），tip 为提示。
   *
   * o.tol      单独放宽这一格的判定容差（默认 1e-6，见 grade.js）——
   *            只在源数据本身带舍入残差、等价公式也对不齐的时候才用。
   * o.bounds   [下限, 上限]，任一端可以写 null 表示不限。
   *            这不是评分标准，是诊断用的：学生填出界了先告诉他「这个数不可能」，
   *            比只说「和参考答案不一致」有用得多。概率填成 130%、
   *            税率填成 250% 属于物理上就不成立，不必等他去逐格比对。
   *            只给「出界即荒谬」的格子加，不要拿它表达「通常在什么区间」——
   *            那种判断随行业变化很大，做成硬提示一定会误伤。
   * o.boundsNote  出界时补一句为什么，写给学生看。
   */
  function I(sol, o) { const c = { kind: 'input', sol: sol }; return o ? Object.assign(c, o) : c; }

  /** 只读计算格 */
  function C(f, o) { const c = { kind: 'calc', f: f }; return o ? Object.assign(c, o) : c; }

  /** 空格 */
  function E() { return { kind: 'empty' }; }

  /** 文本格（只读，显示文字） */
  function T(s) { return { kind: 'text', t: s }; }

  /**
   * 一行
   * @param label 科目名
   * @param cells 单元格数组（对应 B、C、D…）
   * @param o     { fmt, style:'sec'|'tot'|'sub', indent, unit, note }
   */
  function R(label, cells, o) {
    const r = { label: label, cells: cells || [] };
    return o ? Object.assign(r, o) : r;
  }

  /** 分节标题行 */
  function SEC(label) { return { label: label, style: 'sec', cells: [] }; }

  /** 空行 */
  function GAP() { return { label: '', style: 'gap', cells: [] }; }

  global.S = { G: G, I: I, C: C, E: E, T: T, R: R, SEC: SEC, GAP: GAP };

  /* 全局注册表 */
  global.DB = global.DB || { industries: [], companies: [], models: [] };
  global.DB.addIndustry = function (x) { global.DB.industries.push(x); return x; };
  global.DB.addCompany = function (x) { global.DB.companies.push(x); return x; };
  global.DB.addModel = function (x) { global.DB.models.push(x); return x; };
})(window);
