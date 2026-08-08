/* ============================================================================
 * _inventory.js —— 数据盘点与跨模型一致性检查（开发期工具，不进打包）
 *
 * 解决的问题：报表数字写死在代码里，同一个数字往往出现在好几个模型里。
 * 明年年报出来更新数据时，改了一处忘了另一处，是最容易犯也最难发现的错。
 *
 * 两个函数：
 *   inventory(公司id?)  —— 列出每一个 given 数字在哪个模型、哪张表、哪一行、哪一列
 *   crossCheck()        —— 找出「同一家公司 + 同一个科目 + 同一年」但取值不同的地方
 *
 * 用法（页面控制台）：
 *   const s=document.createElement('script'); s.src='_inventory.js'; document.head.appendChild(s);
 *   crossCheck()            // 先看有没有对不上的
 *   inventory('inovance')   // 再看汇川的数字都散在哪
 *   copy(JSON.stringify(inventory(), null, 1))   // 需要的话整份拷出来
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* 标签里常见的修饰，比对前先去掉，避免「营业收入」和「　营业收入（年报真实）」被当成两个科目 */
  function normLabel(s) {
    return String(s || '')
      .replace(/[　\s]/g, '')
      .replace(/[（(].*?[)）]/g, '')
      .replace(/^[一二三四五六七八九十]+、/, '')
      .replace(/^[加减]：/, '')
      .replace(/[:：]$/, '')
      .trim();
  }

  /* 表头里像年份的列名：2024 / FY2024 / 2024A / 2025E */
  function yearOf(h) {
    const m = /(?:FY)?(19|20)\d{2}/.exec(String(h || ''));
    return m ? m[0].replace(/^FY/, '') : null;
  }

  function walk(fn) {
    global.DB.models.forEach(function (m) {
      (m.sheets || []).forEach(function (sh) {
        (sh.rows || []).forEach(function (r, ri) {
          const row = ri + 2;
          (r.cells || []).forEach(function (c, ci) {
            if (!c || c.kind !== 'given') return;
            const col = ci + 1;
            fn({
              model: m.id,
              company: m.companyId || null,
              sheet: sh.name,
              addr: global.FML.addr(col, row),
              row: row,
              header: (sh.header || [])[col] || '',
              year: yearOf((sh.header || [])[col]),
              label: r.label || '',
              key: normLabel(r.label),
              value: c.v,
              note: c.note || r.note || ''
            });
          });
        });
      });
    });
  }

  /* 教学假设不参与一致性比对——它们本来就允许各模型不同。
     除了 note 上标了的，还要按标签排除：比率、增速、倍数、折价这些本来就是各模型自己拍的。 */
  function isAssumption(rec) {
    if (/教学假设|教学示例|教学输入|约数|倒挤/.test(rec.note || '')) return true;
    return /率$|比$|增速|倍数|折价|系数|占比|天数|÷|\//.test(rec.key);
  }

  /* 「对账：年报披露值」「校验」这类标签在同一张表里会重复出现、指向不同科目，
     归一化之后会被误当成同一个科目，不参与比对。 */
  function isGenericLabel(k) {
    return /^(对账|校验|合计|小计|差额|其中)/.test(k) || k.length <= 2;
  }

  /* 年报数字本身就是四舍五入过的，1e-4 的相对差算同一个数 */
  function sameValue(a, b) {
    if (a === b) return true;
    const m = Math.max(Math.abs(a), Math.abs(b));
    return m > 0 && Math.abs(a - b) / m < 1e-4;
  }

  global.inventory = function (companyId) {
    const out = [];
    walk(function (rec) {
      if (companyId && rec.company !== companyId) return;
      out.push(rec);
    });
    out.sort(function (a, b) {
      return (a.company || '').localeCompare(b.company || '') ||
             a.key.localeCompare(b.key) ||
             String(a.year).localeCompare(String(b.year));
    });
    return out;
  };

  /* 同一家公司 + 同一个科目 + 同一年，跨模型取值必须一致。
     只比对「不同模型之间」——同一个模型内部同名标签重复出现，多半是一张表里放了
     两家公司（比如 yili-vs-moutai），按 companyId 归属会误判，这里不参与比对。 */
  global.crossCheck = function () {
    const buckets = {};
    walk(function (rec) {
      if (!rec.company || !rec.year) return;
      if (isAssumption(rec) || isGenericLabel(rec.key)) return;
      const k = rec.company + '|' + rec.key + '|' + rec.year;
      (buckets[k] = buckets[k] || []).push(rec);
    });

    const conflicts = [], agreed = [], rounding = [];
    Object.keys(buckets).forEach(function (k) {
      const g = buckets[k];
      const models = {};
      g.forEach(function (r) { models[r.model] = 1; });
      if (Object.keys(models).length < 2) return;          // 只出现在一个模型里，没得比

      const vals = [];
      g.forEach(function (r) { if (!vals.some(function (v) { return v === r.value; })) vals.push(r.value); });
      const entry = {
        company: g[0].company, item: g[0].key, year: g[0].year,
        values: vals,
        where: g.map(function (r) { return r.model + ' · ' + r.sheet + '!' + r.addr + ' = ' + r.value; })
      };
      if (vals.length === 1) { agreed.push(entry); return; }
      const allClose = vals.every(function (v) { return sameValue(v, vals[0]); });
      if (allClose) rounding.push(entry); else conflicts.push(entry);
    });

    return {
      检查了多少组: conflicts.length + agreed.length + rounding.length,
      完全一致: agreed.length,
      仅精度不同: rounding.length,
      冲突: conflicts.length,
      冲突明细: conflicts,
      精度差异: rounding.map(function (e) {
        return e.company + ' ' + e.year + ' ' + e.item + '：' + e.values.join(' vs ');
      }),
      被多个模型共用的数字: agreed.map(function (e) {
        return e.company + ' ' + e.year + ' ' + e.item + ' = ' + e.values[0] + '（' + e.where.length + ' 处）';
      })
    };
  };

  /* 按公司统计：更新某家公司的年报时，要动多少个地方 */
  global.updateScope = function () {
    const by = {};
    walk(function (rec) {
      if (!rec.company) return;
      const b = by[rec.company] = by[rec.company] || { 公司: rec.company, 硬编码数字: 0, 涉及模型: {}, 年份: {} };
      b.硬编码数字++;
      b.涉及模型[rec.model] = 1;
      if (rec.year) b.年份[rec.year] = 1;
    });
    return Object.keys(by).map(function (k) {
      const b = by[k];
      return {
        公司: k,
        硬编码数字: b.硬编码数字,
        涉及模型数: Object.keys(b.涉及模型).length,
        涉及模型: Object.keys(b.涉及模型),
        覆盖年份: Object.keys(b.年份).sort()
      };
    }).sort(function (a, b) { return b.硬编码数字 - a.硬编码数字; });
  };
})(window);
