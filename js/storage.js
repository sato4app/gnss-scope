// IndexedDB ラッパ（端末内のみ・オフライン完結。サーバ同期なし）。
// ストア構成:
//   sessions: 記録セッションのメタ（id, type: 'record', label, createdAt, 集計サマリ）
//   points:   記録地点（sessionId 紐付け。中心＋集計＋生エポック群を1レコードに持つ）
//   settings: UERE・既定収集時間/点数・地図種別・軌跡 ON/OFF など
const DB_NAME = 'gnssScopeDB';
const DB_VERSION = 1;

function reqToPromise(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export class Storage {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('points')) {
          const s = db.createObjectStore('points', { keyPath: 'id' });
          s.createIndex('bySession', 'sessionId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  // ---- sessions ----
  async putSession(session) {
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(session);
    await txDone(tx);
    return session;
  }

  async getSessions() {
    const all = await reqToPromise(this.db.transaction('sessions').objectStore('sessions').getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // セッションと紐付く地点をまとめて削除
  async deleteSession(id) {
    const points = await this.getPointsBySession(id);
    const tx = this.db.transaction(['sessions', 'points'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const ps = tx.objectStore('points');
    for (const p of points) ps.delete(p.id);
    await txDone(tx);
  }

  // ---- points ----
  async putPoint(point) {
    const tx = this.db.transaction('points', 'readwrite');
    tx.objectStore('points').put(point);
    await txDone(tx);
    return point;
  }

  async getPointsBySession(sessionId) {
    const idx = this.db.transaction('points').objectStore('points').index('bySession');
    return reqToPromise(idx.getAll(sessionId));
  }

  // ---- settings ----
  async getSetting(key, defaultValue = null) {
    const rec = await reqToPromise(this.db.transaction('settings').objectStore('settings').get(key));
    return rec ? rec.value : defaultValue;
  }

  async setSetting(key, value) {
    const tx = this.db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ key, value });
    await txDone(tx);
  }
}
