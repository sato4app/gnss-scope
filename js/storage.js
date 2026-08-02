// IndexedDB ラッパ（端末内のみ・オフライン完結。サーバ同期なし）。
// ストア構成は「調査日 → 地点 → 実データ」のツリー（js/survey.js のコメント参照）:
//   surveys:  1日の調査（id='yyyy-mm-dd'。ツリーの根。ラベル・メモを付けられる）
//   sessions: 記録した地点のメタ（surveyId + pointNo で根に紐付く。window に2系統の測定区間）
//   points:   地点の実データ（M10S の samples[]/rawNmea[] と Android の deviceSamples[] を同じ1レコードに持つ）
//   settings: 端末の状態のみ（tileCacheMeta = 事前DLしたタイルの版・種別・日時）。
//             設定タブの値は永続化しない（既定値は js/constants.js）
// 2系統を同じ point に入れるので、「どの NMEA とどの Android データが対" になるか」は
// 構造上ずれない。時間が本当に重なっているかは session.window.overlap で検証する。
import { assignSurveyKeys, surveyIdOf } from './survey.js';

const DB_NAME = 'gnssScopeDB';
// v2: surveys ストア・sessions の bySurvey インデックス・surveyId/pointNo の採番を追加
const DB_VERSION = 2;

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

// v1（surveys なし・地点番号なし）→ v2 の移行。versionchange トランザクション内で完結させる。
// 既存の記録にも createdAt のローカル日付から surveyId / pointNo を振り、
// 調査日でまとめた一覧・エクスポートが過去データにもそのまま使えるようにする。
function migrateToV2(db, tx) {
  if (!db.objectStoreNames.contains('surveys')) {
    db.createObjectStore('surveys', { keyPath: 'id' });
  }
  const sessions = tx.objectStore('sessions');
  if (!sessions.indexNames.contains('bySurvey')) {
    sessions.createIndex('bySurvey', 'surveyId');
  }

  sessions.getAll().onsuccess = (e) => {
    const all = e.target.result || [];
    if (!all.length) return;
    const byId = new Map(all.map((s) => [s.id, s]));
    const points = tx.objectStore('points');
    const surveys = tx.objectStore('surveys');
    const firstOfDay = new Map();

    for (const { id, surveyId, pointNo } of assignSurveyKeys(all)) {
      const session = byId.get(id);
      sessions.put({ ...session, surveyId, pointNo });
      // 葉にも複写する（point 単体を取り出しても地点が分かるように）
      points.index('bySession').getAll(id).onsuccess = (pe) => {
        for (const p of pe.target.result || []) points.put({ ...p, surveyId, pointNo });
      };
      const known = firstOfDay.get(surveyId);
      if (known == null || session.createdAt < known) firstOfDay.set(surveyId, session.createdAt);
    }

    for (const [surveyId, createdAt] of firstOfDay) {
      surveys.put({ id: surveyId, label: surveyId, memo: '', createdAt, updatedAt: Date.now() });
    }
  };
}

export class Storage {
  constructor() {
    this.db = null;
  }

  async init() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
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
        if (event.oldVersion < 2) migrateToV2(db, req.transaction);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  // ---- surveys（調査日 = ツリーの根） ----

  async putSurvey(survey) {
    const tx = this.db.transaction('surveys', 'readwrite');
    tx.objectStore('surveys').put(survey);
    await txDone(tx);
    return survey;
  }

  async getSurvey(id) {
    return reqToPromise(this.db.transaction('surveys').objectStore('surveys').get(id));
  }

  // 新しい調査日が先
  async getSurveys() {
    const all = await reqToPromise(this.db.transaction('surveys').objectStore('surveys').getAll());
    return all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }

  // 地点の保存時に呼ぶ。無ければ作り、あれば updatedAt だけ進める（ラベル・メモは残す）。
  async ensureSurvey(surveyId, createdAt = Date.now()) {
    const existing = await this.getSurvey(surveyId);
    const survey = existing
      ? { ...existing, updatedAt: Date.now() }
      : { id: surveyId, label: surveyId, memo: '', createdAt, updatedAt: Date.now() };
    await this.putSurvey(survey);
    return survey;
  }

  async getSessionsBySurvey(surveyId) {
    const idx = this.db.transaction('sessions').objectStore('sessions').index('bySurvey');
    const list = await reqToPromise(idx.getAll(surveyId));
    return list.sort((a, b) => (a.pointNo ?? 0) - (b.pointNo ?? 0) || a.createdAt - b.createdAt);
  }

  // 調査日ぶんの { session, point } を地点番号順にまとめて取り出す（バンドル出力用）
  async getSurveyEntries(surveyId) {
    const sessions = await this.getSessionsBySurvey(surveyId);
    const entries = [];
    for (const session of sessions) {
      entries.push({ session, point: (await this.getPointsBySession(session.id))[0] || null });
    }
    return entries;
  }

  // 調査日を丸ごと削除（配下の地点・実データもまとめて消す）
  async deleteSurvey(surveyId) {
    const sessions = await this.getSessionsBySurvey(surveyId);
    const points = [];
    for (const s of sessions) points.push(...(await this.getPointsBySession(s.id)));

    const tx = this.db.transaction(['surveys', 'sessions', 'points'], 'readwrite');
    tx.objectStore('surveys').delete(surveyId);
    const ss = tx.objectStore('sessions');
    for (const s of sessions) ss.delete(s.id);
    const ps = tx.objectStore('points');
    for (const p of points) ps.delete(p.id);
    await txDone(tx);
  }

  // ---- sessions（地点） ----

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

  // セッションと紐付く地点をまとめて削除する。
  // その調査日が空になったら根（surveys）も片付ける。
  async deleteSession(id) {
    const session = await reqToPromise(this.db.transaction('sessions').objectStore('sessions').get(id));
    const points = await this.getPointsBySession(id);
    const tx = this.db.transaction(['sessions', 'points'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const ps = tx.objectStore('points');
    for (const p of points) ps.delete(p.id);
    await txDone(tx);

    const surveyId = session?.surveyId || (session ? surveyIdOf(session.createdAt) : null);
    if (surveyId && !(await this.getSessionsBySurvey(surveyId)).length) {
      const t = this.db.transaction('surveys', 'readwrite');
      t.objectStore('surveys').delete(surveyId);
      await txDone(t);
    }
  }

  // ---- points（実データ） ----

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
  // 設定タブの値ではなく、端末の状態（tileCacheMeta）の保存に使う。
  // 設定値の既定は js/constants.js にあり、永続化しない。
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
