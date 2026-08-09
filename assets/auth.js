/* ============================================================================
 * auth.js —— 极简 Supabase 客户端（认证 + 数据），零依赖
 *
 * 为什么不用官方 SDK：官方 SDK 100KB 起步、要从 CDN 加载，而这个站的整个卖点
 * 就是「一个文件、零依赖、丢哪都能跑」。Supabase 的认证（GoTrue）和数据
 * （PostgREST）都是普通 REST 接口，自己写两百行就够，还能继续单文件打包。
 *
 * 没配 config.js 时 Auth.enabled() 返回 false，整个站退回纯本地模式。
 *
 * 密码只在注册/登录这两个请求里出现，从不落盘；本地只存 Supabase 返回的
 * access_token / refresh_token。
 * ==========================================================================*/
(function (global) {
  'use strict';

  const SESSION_KEY = 'finmodel-lab.session.v1';
  const Auth = {};
  const listeners = [];

  let session = null;   // { access_token, refresh_token, expires_at, user }
  let profile = null;   // { id, nickname, email, is_admin }

  function cfg() {
    const c = global.FML_CONFIG || {};
    return { url: (c.SUPABASE_URL || '').replace(/\/+$/, ''), key: c.SUPABASE_ANON_KEY || '' };
  }

  Auth.enabled = function () { const c = cfg(); return !!(c.url && c.key); };

  /* ------------------------------------------------------------ 会话存取 */
  function loadSession() {
    try {
      const raw = global.localStorage.getItem(SESSION_KEY);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) { session = null; }
    return session;
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) global.localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else global.localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* 隐私模式下写不进去，不影响当次会话 */ }
  }

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(Auth.user(), profile); } catch (e) { console.warn('auth 监听器出错', e); }
    });
  }

  Auth.onChange = function (fn) { listeners.push(fn); return function () {
    const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1);
  }; };

  Auth.user = function () { return session && session.user ? session.user : null; };
  Auth.profile = function () { return profile; };
  Auth.isAdmin = function () { return !!(profile && profile.is_admin); };

  /* ------------------------------------------------------------ 请求封装 */
  function toError(status, body) {
    const msg = (body && (body.error_description || body.msg || body.message || body.error)) || '';
    const e = new Error(translate(status, msg));
    e.status = status; e.raw = msg;
    return e;
  }

  /* Supabase 的报错是英文的，翻成学员看得懂的话 */
  function translate(status, msg) {
    const m = String(msg || '').toLowerCase();
    if (m.includes('invalid login credentials')) return '邮箱或密码不对';
    if (m.includes('email not confirmed')) return '邮箱还没验证，请先去收件箱点验证链接';
    if (m.includes('user already registered') || m.includes('already been registered')) return '这个邮箱已经注册过了，直接登录就行';
    if (m.includes('password should be at least')) return '密码太短了，至少 6 位';
    if (m.includes('unable to validate email') || m.includes('invalid format')) return '邮箱格式不对';
    if (m.includes('rate limit') || status === 429) return '操作太频繁，等一会儿再试';
    if (m.includes('signups not allowed')) return '这个站点暂时关闭了注册';
    if (status === 0) return '连不上服务器，检查一下网络';
    return msg || ('请求失败（' + status + '）');
  }

  function req(path, opts) {
    const c = cfg();
    opts = opts || {};
    const headers = Object.assign({
      'apikey': c.key,
      'Content-Type': 'application/json'
    }, opts.headers || {});
    if (opts.auth !== false && session && session.access_token) {
      headers['Authorization'] = 'Bearer ' + session.access_token;
    } else if (opts.auth !== false) {
      headers['Authorization'] = 'Bearer ' + c.key;
    }
    return global.fetch(c.url + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      /* keepalive：页面正在关闭时请求也能发完，且能带上 Authorization 头
         （sendBeacon 带不了自定义头，对需要 JWT 的接口没用） */
      keepalive: !!opts.keepalive
    }).then(function (r) {
      const ct = r.headers.get('content-type') || '';
      const p = ct.indexOf('json') >= 0 ? r.json().catch(function () { return null; }) : r.text();
      return p.then(function (body) {
        if (!r.ok) throw toError(r.status, body);
        return body;
      });
    }, function () { throw toError(0, ''); });
  }

  /* access_token 过期前 60 秒就换新的 */
  function ensureFresh() {
    if (!session) return Promise.resolve(null);
    const exp = session.expires_at || 0;
    if (Date.now() / 1000 < exp - 60) return Promise.resolve(session);
    if (!session.refresh_token) return Promise.resolve(session);
    return req('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', auth: false, body: { refresh_token: session.refresh_token }
    }).then(function (d) {
      saveSession(normalize(d));
      return session;
    }).catch(function () {
      saveSession(null); profile = null; emit();
      return null;
    });
  }
  Auth.ensureFresh = ensureFresh;

  function normalize(d) {
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: d.expires_at || (Math.floor(Date.now() / 1000) + (d.expires_in || 3600)),
      user: d.user || null
    };
  }

  /* ------------------------------------------------------------ 资料 */
  function fetchProfile() {
    const u = Auth.user();
    if (!u) { profile = null; return Promise.resolve(null); }
    return req('/rest/v1/profiles?select=id,nickname,email,is_admin&id=eq.' + encodeURIComponent(u.id))
      .then(function (rows) {
        profile = (rows && rows[0]) || null;
        return profile;
      })
      .catch(function () { profile = null; return null; });
  }
  Auth.refreshProfile = fetchProfile;

  /* ------------------------------------------------------------ 对外动作 */

  /** 注册。Supabase 若开了邮箱验证，这里不会直接给出会话。 */
  Auth.signUp = function (email, password, nickname) {
    return req('/auth/v1/signup', {
      method: 'POST', auth: false,
      body: { email: email, password: password, data: { nickname: nickname } }
    }).then(function (d) {
      if (d && d.access_token) {          // 关掉邮箱验证时会直接返回会话
        saveSession(normalize(d));
        return fetchProfile().then(function () { emit(); return { signedIn: true }; });
      }
      return { signedIn: false };        // 需要先去邮箱点验证链接
    });
  };

  Auth.signIn = function (email, password) {
    return req('/auth/v1/token?grant_type=password', {
      method: 'POST', auth: false, body: { email: email, password: password }
    }).then(function (d) {
      saveSession(normalize(d));
      return fetchProfile().then(function () { emit(); return Auth.user(); });
    });
  };

  Auth.signOut = function () {
    const had = !!session;
    const p = had ? req('/auth/v1/logout', { method: 'POST' }).catch(function () {}) : Promise.resolve();
    return p.then(function () {
      saveSession(null); profile = null; emit();
    });
  };

  Auth.resetPassword = function (email) {
    return req('/auth/v1/recover', {
      method: 'POST', auth: false,
      body: { email: email, redirect_to: global.location.origin + global.location.pathname }
    });
  };

  Auth.updateNickname = function (nickname) {
    const u = Auth.user();
    if (!u) return Promise.reject(new Error('还没登录'));
    return ensureFresh().then(function () {
      return req('/rest/v1/profiles?id=eq.' + encodeURIComponent(u.id), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: { nickname: nickname }
      });
    }).then(function (rows) {
      if (rows && rows[0]) profile = rows[0];
      emit();
      return profile;
    });
  };

  /* ------------------------------------------------------------ 进度读写 */

  Auth.loadProgress = function () {
    const u = Auth.user();
    if (!u) return Promise.resolve(null);
    return ensureFresh().then(function () {
      return req('/rest/v1/progress?select=state,updated_at&user_id=eq.' + encodeURIComponent(u.id));
    }).then(function (rows) { return (rows && rows[0]) || null; });
  };

  /** upsert：第一次登录时行可能还不存在（触发器没跑成功也能兜住） */
  Auth.saveProgress = function (state, summary, keepalive) {
    const u = Auth.user();
    if (!u) return Promise.reject(new Error('还没登录'));
    /* 页面关闭时来不及做 token 刷新，直接用现有 token 发出去 */
    const pre = keepalive ? Promise.resolve() : ensureFresh();
    return pre.then(function () {
      return req('/rest/v1/progress', {
        method: 'POST',
        keepalive: !!keepalive,
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: [{
          user_id: u.id,
          state: state,
          models_started: summary.started,
          models_completed: summary.completed,
          correct_cells: summary.correctCells,
          total_seconds: Math.round(summary.seconds || 0),
          updated_at: new Date().toISOString()
        }]
      });
    });
  };

  /** 班级看板：只有 is_admin 的账号能读到别人的行（由数据库策略保证，不是前端判断） */
  Auth.loadClassBoard = function () {
    return ensureFresh().then(function () {
      return req('/rest/v1/progress?select=user_id,models_started,models_completed,correct_cells,total_seconds,updated_at,profiles(nickname,email,created_at)&order=updated_at.desc');
    });
  };

  /* ------------------------------------------------------------ 启动 */
  Auth.init = function () {
    if (!Auth.enabled()) return Promise.resolve(null);
    loadSession();
    if (!session) return Promise.resolve(null);
    return ensureFresh().then(function (s) {
      if (!s) return null;
      return fetchProfile().then(function () { emit(); return Auth.user(); });
    });
  };

  global.Auth = Auth;
})(window);
