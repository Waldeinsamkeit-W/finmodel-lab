/* ============================================================================
 * sync.js —— 进度同步（本地优先，登录后才同步）
 *
 * 设计原则：**本地永远是主**。没登录、没网、Supabase 挂了，练习都照常，
 * 只是不同步而已。登录只是给本地进度加一个云端副本。
 *
 * 合并策略：**按模型逐个比 updatedAt，新的赢**。
 * 不做整份覆盖——那样在两台设备上分别练了不同模型时会丢掉一整份。
 * 同一个模型在两边都改过，只能二选一，取时间新的那份；这时会提示用户。
 * ==========================================================================*/
(function (global) {
  'use strict';

  const Sync = {};
  const PUSH_DEBOUNCE = 12000;   // 改完 12 秒没再动就推一次
  let lastPushedAt = 0;
  let timer = null;
  let pushing = false;
  let enabled = false;

  function log() { /* 需要排查时把下一行打开 */ /* console.log.apply(console, ['[sync]'].concat([].slice.call(arguments))); */ }

  /* ------------------------------------------------------------ 合并 */
  function mergeStates(local, remote) {
    const stat = { 用了云端: [], 用了本地: [], 新增: [] };
    if (!remote || !remote.models) return { state: local, stat: stat };

    const out = JSON.parse(JSON.stringify(local));
    if (!out.models) out.models = {};

    Object.keys(remote.models).forEach(function (id) {
      const r = remote.models[id];
      const l = out.models[id];
      if (!l) { out.models[id] = r; stat.新增.push(id); return; }
      const rt = r.updatedAt || 0, lt = l.updatedAt || 0;
      if (rt > lt) { out.models[id] = r; stat.用了云端.push(id); }
      else if (lt > rt) { stat.用了本地.push(id); }
    });

    out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
    if ((remote.updatedAt || 0) > (local.updatedAt || 0) && remote.last) out.last = remote.last;
    if (remote.prefs && (!out.prefs || (remote.updatedAt || 0) > (local.updatedAt || 0))) {
      out.prefs = Object.assign({}, out.prefs || {}, remote.prefs);
    }
    return { state: out, stat: stat };
  }
  Sync.mergeStates = mergeStates;   // 导出便于测试

  /* ------------------------------------------------------------ 拉 + 合并 */
  Sync.pullAndMerge = function () {
    if (!global.Auth || !global.Auth.user()) return Promise.resolve(null);
    return global.Auth.loadProgress().then(function (row) {
      const local = global.Store.all();
      const remote = row && row.state && row.state.models ? row.state : null;
      if (!remote) { log('云端还没有进度，直接推本地'); return Sync.push(true).then(function () { return { 首次上传: true }; }); }

      const m = mergeStates(local, remote);
      global.Store.importJSON(JSON.stringify(m.state));
      lastPushedAt = 0;                 // 合并结果要推回去
      return Sync.push(true).then(function () { return m.stat; });
    });
  };

  /* ------------------------------------------------------------ 推 */
  Sync.push = function (force) {
    if (!global.Auth || !global.Auth.user()) return Promise.resolve(false);
    if (pushing) return Promise.resolve(false);
    const st = global.Store.all();
    if (!force && (st.updatedAt || 0) <= lastPushedAt) return Promise.resolve(false);

    pushing = true;
    const stamp = st.updatedAt || Date.now();
    return global.Auth.saveProgress(st, global.Store.summary())
      .then(function () { lastPushedAt = stamp; log('已推送'); return true; })
      .catch(function (e) { log('推送失败', e.message); return false; })
      .then(function (r) { pushing = false; return r; });
  };

  function schedule() {
    if (!enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; Sync.push(false); }, PUSH_DEBOUNCE);
  }

  /* Store 没有变更事件，与其去改它，不如定期看 updatedAt 有没有动。
     省事、也不会因为漏挂钩子而丢同步。 */
  function watch() {
    let seen = (global.Store.all().updatedAt) || 0;
    setInterval(function () {
      if (!enabled) return;
      const now = global.Store.all().updatedAt || 0;
      if (now !== seen) { seen = now; schedule(); }
    }, 3000);
  }

  /* ------------------------------------------------------------ 启动 */
  Sync.start = function () {
    if (!global.Auth || !global.Auth.enabled()) return;
    watch();

    global.Auth.onChange(function (user) {
      enabled = !!user;
      if (!user) { lastPushedAt = 0; return; }
    });

    /* 切后台或关页面时尽量推一把 */
    global.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') Sync.push(false);
    });
    global.addEventListener('beforeunload', function () {
      if (!enabled) return;
      const st = global.Store.all();
      if ((st.updatedAt || 0) <= lastPushedAt) return;
      /* keepalive 请求在页面卸载后仍会发完，而且能带 Authorization 头。
         token 恰好过期的话这一次会丢，下次打开重新同步即可。 */
      try { global.Auth.saveProgress(st, global.Store.summary(), true); } catch (e) { /* 尽力而为 */ }
    });
  };

  global.Sync = Sync;
})(window);
