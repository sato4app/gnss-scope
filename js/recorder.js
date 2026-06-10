// 受信した生の行を IndexedDB に収録する。
// 再生時は loadLines() で取り出し、同じパーサ／集約器に流せば再解析できる。
const DB_NAME = 'gnssMonitorDB';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('lines')) {
        const s = db.createObjectStore('lines', { keyPath: 'seq', autoIncrement: true });
        s.createIndex('bySession', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export class Recorder {
  constructor() {
    this.db = null;
    this.sessionId = null;
    this.count = 0;
  }

  async init() {
    if (!this.db) this.db = await openDB();
    return this.db;
  }

  async startSession(meta = {}) {
    await this.init();
    this.sessionId = `s_${Date.now()}`;
    this.count = 0;
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put({
      id: this.sessionId,
      startedAt: Date.now(),
      note: meta.note || '',
      ...meta,
    });
    return this.sessionId;
  }

  // 収録中のみ、生の1行を記録する
  record(line) {
    if (!this.sessionId || !this.db) return;
    const tx = this.db.transaction('lines', 'readwrite');
    tx.objectStore('lines').add({ sessionId: this.sessionId, t: Date.now(), line });
    this.count++;
  }

  async stopSession() {
    if (!this.sessionId) return;
    const id = this.sessionId;
    const tx = this.db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const rec = await reqToPromise(store.get(id));
    if (rec) {
      rec.endedAt = Date.now();
      rec.lineCount = this.count;
      store.put(rec);
    }
    this.sessionId = null;
  }

  async listSessions() {
    await this.init();
    return reqToPromise(this.db.transaction('sessions').objectStore('sessions').getAll());
  }

  // 再生用：あるセッションの生行を時刻順で取得
  async loadLines(sessionId) {
    await this.init();
    const idx = this.db.transaction('lines').objectStore('lines').index('bySession');
    const lines = await reqToPromise(idx.getAll(sessionId));
    return lines.sort((a, b) => a.t - b.t);
  }
}
