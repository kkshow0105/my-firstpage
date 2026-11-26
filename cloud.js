/* Only the project's publishable key belongs in the PWA. */
const LEDGER_API = 'https://xhknatnpardduwzbvrih.supabase.co';
const LEDGER_PUBLISHABLE_KEY = 'sb_publishable__ZoXRhw5WbM1NijGbojSYw_8m8LEDaC';
const LEDGER_SESSION = 'dual_table_cloud_session_v1';
const LEDGER_ACCOUNT = 'dual_table_cloud_account_v1:';
const LEDGER_SELECTION = 'dual_table_cloud_trip_v1:';
const LEDGER_WORKER_POLICY = 'ledger-static-only-v3';
const ledgerUuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const ledgerVersion = value => Number.isSafeInteger(value) && value >= 0;
const ledgerTripId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);

async function ledgerDigest(trips) {
  // PostgreSQL JSONB changes object key order. Array order and all values are significant.
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(trips)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

class LedgerApiError extends Error {
  constructor(status, code) {
    super('云端请求失败');
    this.status = status;
    this.code = code;
  }
}

class CloudLedgerSync {
  constructor(ui) {
    this.ui = ui;
    this.context = null;
    this.verifiedWorker = null;
    this.checkingWorker = null;
    this.workerRetry = null;
    this.message = '';
  }

  start() {
    this.adoptSession();
    if (!this.context) this.ui.onAccount(null);
    navigator.serviceWorker?.addEventListener('controllerchange', () => this.checkWorker());
    window.addEventListener('storage', event => {
      if (event.storageArea !== localStorage) return;
      if (event.key === LEDGER_SESSION || event.key === null) this.adoptSession();
      const context = this.context;
      if (context && (event.key === this.key(context) || event.key === null)) {
        if (context.writer && localStorage.getItem(this.key(context)) !== context.raw) {
          context.error = '账号缓存已被其他窗口更改。请刷新核对，未确认的提交已暂停。';
          context.blocked = true;
          this.ui.onStatus();
        } else if (!context.writer && this.workerReady) this.loadRecord(context);
      }
    });
    window.addEventListener('online', () => { this.checkWorker(); this.schedule(); this.ui.onStatus(); });
    window.addEventListener('offline', () => {
      if (this.context) this.context.confirmed = false;
      this.ui.onStatus();
    });
    window.addEventListener('focus', () => { this.adoptSession(); this.checkWorker(); this.schedule(); });
    window.addEventListener('pageshow', event => {
      if (event.persisted) { this.adoptSession(); this.checkWorker(); this.schedule(); }
    });
    // A hidden iOS PWA can be suspended. Reopening or becoming visible also triggers a check.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { this.adoptSession(); this.checkWorker(); this.schedule(); }
    });
    setInterval(() => { if (!document.hidden) { this.checkWorker(); this.schedule(); } }, 20000);
    this.checkWorker();
  }

  get workerReady() {
    return !!navigator.locks && !!this.verifiedWorker &&
      this.verifiedWorker === navigator.serviceWorker?.controller && this.verifiedWorker.state === 'activated';
  }

  async checkWorker() {
    clearTimeout(this.workerRetry);
    const controller = navigator.serviceWorker?.controller;
    if (this.workerReady) {
      if (this.context) this.requestWriter(this.context);
      return;
    }
    this.verifiedWorker = null;
    if (!controller || !navigator.locks || this.checkingWorker === controller) {
      this.ui.onStatus();
      return;
    }
    if (controller.state !== 'activated') {
      controller.addEventListener('statechange', () => this.checkWorker(), { once: true });
      return;
    }
    this.checkingWorker = controller;
    const verified = await new Promise(resolve => {
      const channel = new MessageChannel();
      const finish = supported => { clearTimeout(timer); channel.port1.close(); resolve(supported); };
      const timer = setTimeout(() => finish(false), 1000);
      channel.port1.onmessage = event => finish(event.data === LEDGER_WORKER_POLICY);
      try { controller.postMessage({ type: 'LEDGER_CHECK_NETWORK_POLICY' }, [channel.port2]); }
      catch { finish(false); }
    });
    if (this.checkingWorker !== controller) return;
    this.checkingWorker = null;
    if (verified && controller === navigator.serviceWorker?.controller) {
      this.verifiedWorker = controller;
      if (this.context) this.requestWriter(this.context);
    } else if (controller === navigator.serviceWorker?.controller) {
      // A newly started worker can take longer to answer than one foreground probe.
      this.workerRetry = setTimeout(() => this.checkWorker(), 2500);
    }
    this.ui.onStatus();
  }

  session() {
    try {
      const value = JSON.parse(localStorage.getItem(LEDGER_SESSION));
      if (value && ledgerUuid(value.userId) && ledgerUuid(value.loginId) && typeof value.email === 'string' &&
          typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' &&
          Number.isFinite(value.expiresAt)) return value;
    } catch {}
    return null;
  }

  adoptSession() {
    const session = this.session();
    const previous = this.context;
    if (session?.loginId === previous?.session.loginId && session?.userId === previous?.session.userId) return;
    if (previous) {
      previous.abort.abort();
      clearTimeout(previous.timer);
    }
    const context = session && { session, abort: new AbortController(), record: null, raw: null,
      writer: false, waitingWriter: false, busy: false, blocked: false, confirmed: false, error: '', retry: 0, timer: null };
    this.context = context;
    this.ui.onAccount(context);
    if (context && this.workerReady) this.requestWriter(context);
    this.ui.onStatus();
  }

  isCurrent(context) {
    if (!context || this.context !== context || context.abort.signal.aborted) return false;
    const session = this.session();
    return session?.loginId === context.session.loginId && session?.userId === context.session.userId;
  }

  key(context) { return LEDGER_ACCOUNT + context.session.userId; }

  selection() {
    try { return this.context ? localStorage.getItem(LEDGER_SELECTION + this.context.session.userId) : null; }
    catch { return null; }
  }

  selectTrip(id) {
    if (!this.context || !this.isCurrent(this.context)) return false;
    try { localStorage.setItem(LEDGER_SELECTION + this.context.session.userId, id); return true; }
    catch { return false; }
  }

  loadRecord(context) {
    if (!this.isCurrent(context) || !this.workerReady) return;
    try {
      const raw = localStorage.getItem(this.key(context));
      const record = raw === null ? null : JSON.parse(raw);
      if (record) {
        if (record.format !== 1 || record.userId !== context.session.userId || !ledgerVersion(record.base) ||
            typeof record.dirty !== 'boolean' || typeof record.conflict !== 'boolean' ||
            !Array.isArray(record.deletedIds) || !record.deletedIds.every(ledgerTripId) ||
            !Array.isArray(record.restoreIds) || !record.restoreIds.every(ledgerTripId)) throw Error();
        record.book = this.ui.validateBook(record.book);
        if (record.initialImport !== undefined) {
          const receipt = record.initialImport;
          if (!/^[a-f0-9]{64}$/.test(receipt?.digest) || !['checking','verified','different'].includes(receipt.status) ||
              (receipt.status === 'checking' && (record.dirty || ![0, 1].includes(record.base) ||
              (record.base === 0) !== (record.flight !== null))) ||
              (receipt.status === 'different' && !record.conflict)) throw Error();
        }
        if (record.flight !== null) {
          const flight = JSON.parse(record.flight);
          if (!ledgerUuid(flight.p_commit_id) || flight.p_base_version !== record.base ||
              !Array.isArray(flight.p_trips) || !Array.isArray(flight.p_restore_trip_ids) ||
              !flight.p_restore_trip_ids.every(ledgerTripId)) throw Error();
          this.ui.validateTrips(flight.p_trips);
        }
      } else if (raw !== null) throw Error();
      const changed = context.record?.book.commitId !== record?.book.commitId;
      context.record = record;
      context.raw = raw;
      if (changed || !record) this.ui.onBook(record?.book ?? null);
    } catch {
      context.record = null;
      context.blocked = true;
      context.raw = null;
      context.error = '本机云端缓存无法读取。请先导出原始缓存，系统已停止同步。';
      this.ui.onBook(null);
    }
    this.ui.onStatus();
  }

  requestWriter(context) {
    if (context.waitingWriter || context.blocked || !this.isCurrent(context)) return;
    context.waitingWriter = true;
    this.loadRecord(context);
    if (context.blocked) return;
    // Hold an exclusive lease across synchronous saves and async uploads. Another tab can
    // read this account, but cannot race the snapshot/outbox write.
    navigator.locks.request(this.key(context), { signal: context.abort.signal }, async () => {
      if (!this.isCurrent(context)) return;
      const released = new Promise(resolve => context.abort.signal.addEventListener('abort', resolve, { once: true }));
      context.writer = true;
      if (this.workerReady) this.loadRecord(context);
      this.ui.onStatus();
      this.schedule();
      await released;
    }).catch(() => {
      if (!this.isCurrent(context)) return;
      context.error = '无法取得此账号的本机同步权限。请刷新后重试。';
      context.blocked = true;
      this.ui.onStatus();
    });
  }

  putRecord(context, record) {
    if (!this.isCurrent(context) || !context.writer || context.blocked) throw Error('账号或窗口已变化');
    if (localStorage.getItem(this.key(context)) !== context.raw) throw Error('本机云端账本已变化，请刷新核对');
    const raw = JSON.stringify(record);
    localStorage.setItem(this.key(context), raw);
    context.record = record;
    context.raw = raw;
  }

  get canWrite() {
    const c = this.context;
    return !!c && this.isCurrent(c) && this.workerReady && c.writer && !!c.record && !c.blocked &&
      !['checking','different'].includes(c.record.initialImport?.status);
  }

  get canRestore() {
    const c = this.context;
    return this.canWrite && navigator.onLine && !c.busy && !this.pending(c) && !c.record.conflict && !c.error;
  }

  pending(context = this.context) {
    const record = context?.record;
    return !!(record?.dirty || record?.flight || record?.initialImport?.status === 'checking');
  }

  get canImportLocal() {
    const c = this.context;
    return this.canRestore && c.confirmed && c.session.initialImport && c.record.base === 0 &&
      !c.record.initialImport && c.record.deletedIds.length === 0;
  }

  async stageLocalImport(source, stillSameSource) {
    const c = this.context;
    if (!this.canImportLocal) throw Error('当前账号未就绪或云端已有数据，已停止迁移。');
    const before = c.record;
    const book = this.ui.validateBook(source);
    const digest = await ledgerDigest(book.trips);
    const token = await this.token(c);
    const account = await this.api('/auth/v1/user', { method:'GET', token, signal:c.abort.signal });
    if (account?.id !== c.session.userId || account.app_metadata?.ledger_initial_import !== true)
      throw Error('当前账号未开通首次迁移权限。');
    const remote = await this.remote(c);
    if (remote.version !== 0 || remote.trips.length || remote.deletedTripIds.length)
      throw Error('云端已有数据，已停止迁移。请先核对当前账号。');
    if (!this.isCurrent(c) || before !== c.record || !this.canImportLocal || !stillSameSource())
      throw Error('账号、网络或本地账本已变化，请重新核对后确认。');
    const flight = JSON.stringify({ p_commit_id:crypto.randomUUID(), p_base_version:0,
      p_trips:book.trips, p_restore_trip_ids:[] });
    // The frozen request and source copy are persisted together before any write RPC.
    this.putRecord(c, { ...before, book, flight, initialImport:{ status:'checking', digest } });
    this.ui.onBook(book);
    this.ui.onStatus();
    this.schedule();
  }

  saveBook(book, safetyBackup = null) {
    const c = this.context;
    if (!this.canWrite || (safetyBackup && !this.canRestore)) throw Error('云端账本暂不可写入或恢复');
    const current = c.record;
    const ids = new Set(book.trips.map(trip => trip.id));
    const restore = safetyBackup ? current.deletedIds.filter(id => ids.has(id)) : current.restoreIds.filter(id => ids.has(id));
    this.putRecord(c, { ...current, book, dirty: true, restoreIds: restore,
      safety: safetyBackup ?? current.safety });
    this.schedule();
    this.ui.onStatus();
  }

  async api(path, { token, body, signal, method = 'POST' } = {}) {
    if (!this.workerReady) throw Error('等待安全的 PWA 更新');
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 15000);
    try {
      const response = await fetch(LEDGER_API + path, {
        method, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: abort.signal,
        headers: { apikey: LEDGER_PUBLISHABLE_KEY, ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body)
      });
      if (response.status === 204) return null;
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new LedgerApiError(response.status, data?.error_code || data?.code);
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  makeSession(data, loginId) {
    if (!ledgerUuid(data?.user?.id) || typeof data.user.email !== 'string' ||
        typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw Error('登录响应不完整');
    return { userId: data.user.id, email: data.user.email, accessToken: data.access_token,
      refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000, loginId,
      initialImport: data.user.app_metadata?.ledger_initial_import === true };
  }

  async signIn(email, password) {
    if (!this.workerReady) throw Error('请先更新 PWA，等待新版本接管后再登录。');
    if (!navigator.onLine) throw Error('当前离线，请联网后登录。');
    return navigator.locks.request(LEDGER_SESSION, async () => {
      if (this.session()) { this.adoptSession(); return; }
      let data;
      try { data = await this.api('/auth/v1/token?grant_type=password', { body: { email, password } }); }
      catch (error) {
        if (error.status === 400 || error.status === 401) throw Error('邮箱或密码不正确，或账号尚未启用。');
        if (error.status === 429) throw Error('登录尝试过多，请稍后再试。');
        throw Error('暂时无法连接云端，请检查网络后重试。');
      }
      const session = this.makeSession(data, crypto.randomUUID());
      if (!this.workerReady) throw Error('PWA 控制状态已变化，请重新登录。');
      try { localStorage.setItem(LEDGER_SESSION, JSON.stringify(session)); }
      catch { throw Error('无法在此浏览器保存登录，请检查存储空间。'); }
      this.message = '';
      this.adoptSession();
    });
  }

  async signOut() {
    const previous = this.session();
    try { localStorage.removeItem(LEDGER_SESSION); }
    catch { throw Error('无法清除本机登录状态，请重试。'); }
    this.message = '已退出，账号的待同步修改仍保存在此设备。';
    this.adoptSession();
    // Do not revoke sessions on other devices. Local logout is durable even offline.
    if (previous && this.workerReady && navigator.onLine) {
      try { await this.api('/auth/v1/logout?scope=local', { token: previous.accessToken }); } catch {}
    }
  }

  async token(context, refreshFrom = null) {
    if (!this.isCurrent(context)) throw Error('账号已变化');
    const current = this.session();
    if (current.expiresAt > Date.now() + 30000 && current.accessToken !== refreshFrom) return current.accessToken;
    return navigator.locks.request(LEDGER_SESSION, { signal: context.abort.signal }, async () => {
      if (!this.isCurrent(context)) throw Error('账号已变化');
      const session = this.session();
      if (session.expiresAt > Date.now() + 30000 && session.accessToken !== refreshFrom) return session.accessToken;
      let data;
      try {
        data = await this.api('/auth/v1/token?grant_type=refresh_token', {
          signal: context.abort.signal, body: { refresh_token: session.refreshToken }
        });
      } catch (error) {
        if ([400, 401, 403].includes(error.status) && this.isCurrent(context)) {
          localStorage.removeItem(LEDGER_SESSION);
          this.message = '登录已过期，请重新登录。待同步账本仍保存在此设备。';
          this.adoptSession();
        }
        throw error;
      }
      const next = this.makeSession(data, session.loginId);
      if (!this.isCurrent(context) || next.userId !== session.userId) throw Error('账号已变化');
      localStorage.setItem(LEDGER_SESSION, JSON.stringify(next));
      return next.accessToken;
    });
  }

  async rpc(context, name, body) {
    const path = '/rest/v1/rpc/' + name;
    const token = await this.token(context);
    if (!this.isCurrent(context)) throw Error('账号已变化');
    try { return await this.api(path, { token, body, signal: context.abort.signal }); }
    catch (error) {
      if (error.status !== 401 || !this.isCurrent(context)) throw error;
      const renewed = await this.token(context, token);
      if (!this.isCurrent(context)) throw Error('账号已变化');
      return this.api(path, { token: renewed, body, signal: context.abort.signal });
    }
  }

  async remote(context) {
    const data = await this.rpc(context, 'read_ledger', {});
    if (!this.isCurrent(context) || data?.schemaVersion !== 1 || !ledgerVersion(data.version) ||
        !Array.isArray(data.trips) || !Array.isArray(data.deletedTripIds) ||
        !data.deletedTripIds.every(ledgerTripId) || (data.version === 0 && data.trips.length)) throw Error('无法校验云端账本');
    if (data.version !== 0) data.trips = this.ui.validateTrips(data.trips);
    return data;
  }

  async preview() {
    const context = this.context;
    if (!context || !this.isCurrent(context) || !this.workerReady || !navigator.onLine)
      throw Error('请联网并登录后查看云端账本。');
    return this.remote(context);
  }

  exportRaw() {
    return this.context && this.isCurrent(this.context) ? localStorage.getItem(this.key(this.context)) : null;
  }

  schedule(delay = 0) {
    const c = this.context;
    if (!c || c.busy || !c.writer || c.blocked || c.record?.conflict || !this.workerReady || !navigator.onLine) return;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => this.sync(c), delay);
  }

  async sync(c) {
    if (!this.isCurrent(c) || !this.workerReady || c.busy || !c.writer || c.blocked ||
        c.record?.conflict || !navigator.onLine) return;
    c.busy = true;
    c.error = '';
    this.ui.onStatus();
    let delay = 0;
    try {
      while (this.isCurrent(c) && this.workerReady && navigator.onLine) {
        const current = c.record;
        if (current?.dirty || current?.flight) {
          if (!current.flight) {
            const flight = JSON.stringify({ p_commit_id: crypto.randomUUID(), p_base_version: current.base,
              p_trips: current.book.trips, p_restore_trip_ids: current.restoreIds });
            this.putRecord(c, { ...current, flight, dirty: false, restoreIds: [] });
          }
          const sent = c.record.flight;
          const payload = JSON.parse(sent);
          const reply = await this.rpc(c, 'commit_ledger', sent);
          if (!this.isCurrent(c) || c.record.flight !== sent) return;
          if (!['applied','replayed'].includes(reply?.status) || reply.appliedVersion !== payload.p_base_version + 1 ||
              !ledgerVersion(reply.currentVersion) || reply.currentVersion < reply.appliedVersion) throw Error();
          const latest = c.record;
          const deleted = new Set(latest.deletedIds);
          payload.p_restore_trip_ids.forEach(id => deleted.delete(id));
          // Trips missing from the sent snapshot are discovered on the next clean pull.
          const conflict = latest.dirty && reply.currentVersion > reply.appliedVersion;
          this.putRecord(c, { ...latest, base: reply.appliedVersion, flight: null, deletedIds: [...deleted],
            conflict });
          if (conflict) return;
          if (latest.dirty) continue;
        }
        const remote = await this.remote(c);
        if (!this.isCurrent(c)) return;
        const saved = c.record;
        if (saved?.initialImport?.status === 'checking') {
          const matches = remote.version === 1 && !remote.deletedTripIds.length &&
            await ledgerDigest(remote.trips) === saved.initialImport.digest;
          if (!this.isCurrent(c) || c.record !== saved) return;
          this.putRecord(c, { ...saved, conflict:!matches,
            initialImport:{ ...saved.initialImport, status:matches?'verified':'different' } });
          c.confirmed = matches;
          return;
        }
        if (saved && remote.version < saved.base) throw Error('云端版本低于本机基准');
        if (this.pending(c)) {
          if (saved.base !== remote.version) {
            this.putRecord(c, { ...saved, conflict: true });
            return;
          }
          continue;
        }
        if (!saved || saved.base !== remote.version) {
          const book = this.ui.bookFromRemote(remote.trips, saved?.book);
          this.putRecord(c, { format: 1, userId: c.session.userId, book, base: remote.version,
            dirty: false, flight: null, conflict: false, restoreIds: [], deletedIds: remote.deletedTripIds,
            safety: saved?.safety ?? null, ...(saved?.initialImport ? { initialImport:saved.initialImport } : {}) });
          this.ui.onBook(book);
        } else if (JSON.stringify(saved.deletedIds) !== JSON.stringify(remote.deletedTripIds)) {
          this.putRecord(c, { ...saved, deletedIds: remote.deletedTripIds });
        }
        c.confirmed = true;
        c.retry = 0;
        return;
      }
    } catch (error) {
      if (!this.isCurrent(c)) return;
      if (error.status === 409 && c.record) {
        try { this.putRecord(c, { ...c.record, conflict: true }); }
        catch { c.error = '无法保存冲突标记，待同步请求仍保留。请先导出本地备份。'; c.blocked = true; }
      } else {
        c.error = error instanceof LedgerApiError && error.status < 500 && error.status !== 429
          ? '云端拒绝了本次同步。修改仍在本机，可导出备份。'
          : '暂时无法同步。已保存的修改仍在本机，请检查网络或存储空间。';
        delay = Math.min(30000, 2000 * 2 ** Math.min(c.retry++, 4));
      }
    } finally {
      c.busy = false;
      if (this.isCurrent(c)) {
        this.ui.onStatus();
        if (delay || (!c.error && this.pending(c))) this.schedule(delay);
      }
    }
  }
}
