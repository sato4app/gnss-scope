// IndexedDB ラッパ（端末内のみ・オフライン完結。サーバ同期なし）。
// ストア構成は「調査日 → 地点 → 実データ」のツリー（js/survey.js のコメント参照）:
//   surveys:  1日の調査（id='yyyy-mm-dd'。ツリーの根。ラベル・メモを付けられる）
//   sessions: 記録した地点のメタ（surveyId + pointNo で根に紐付く。window に2系統の測定区間）
//   points:   地点の集計値（stats のみ。実データ配列は持たない）
//   chunks:   地点の実データ（記録中に 5 エポックずつ追記される。samples/rawNmea/deviceSamples）
//   settings: 端末の状態のみ（tileCacheMeta = 事前DLしたタイルの版・種別・日時）。
//             設定タブの値は永続化しない（既定値は js/constants.js）
// 2系統を同じ chunk に入れるので、「どの NMEA とどの Android データが対か」は
// 構造上ずれない。時間が本当に重なっているかは session.window.overlap で検証する。
//
// 記録は「下書き（status:'draft'）」として始まり、記録中はチャンクが追記される。
// 「保存」で確定（status:'confirmed'）し、そこで初めて地点番号が振られる。
// 停止を待たずに書くので、アプリが落ちても直近フラッシュまでは残る（docs/design-202607.md 3.）。
import { surveyIdOf } from './survey.js';

const DB_NAME = 'gnssScopeDB';
// v3: chunks ストアを追加し、実データを points から分離。
//     v2 以前のデータは移行せず作り直す（開発中のデータしか無いため。移行コードを持たない）。
const DB_VERSION = 3;

// 確定済み（＝地点として数える）か。下書きは集計・エクスポートの対象外。
export const isConfirmed = (session) => session?.status !== 'draft';

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
    // 他タブに開かれてアップグレードできないときの案内（app.js が表示に使う）
    this.onBlocked = null;
  }

  async init() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // 既存ストアは全部捨てて作り直す（v2 以前のデータは移行しない）
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
        db.createObjectStore('surveys', { keyPath: 'id' });
        db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('bySurvey', 'surveyId');
        db.createObjectStore('points', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
        db.createObjectStore('chunks', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
        db.createObjectStore('settings', { keyPath: 'key' });
      };
      // 旧版を開いたままのタブがあるとアップグレードが進まない。案内するしかない。
      req.onblocked = () => this.onBlocked?.();
      req.onsuccess = () => {
        // 次回以降のアップグレードを自分がブロックしないよう、要求が来たら接続を閉じる
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
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

  // 記録開始時と確定時に呼ぶ。無ければ作り、あれば updatedAt だけ進める（ラベル・メモは残す）。
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

  // 調査日ぶんの { session, point } を地点番号順にまとめて取り出す（バンドル出力用）。
  // 下書きは出さない（確定してから持ち出す）。
  async getSurveyEntries(surveyId) {
    const sessions = (await this.getSessionsBySurvey(surveyId)).filter(isConfirmed);
    const entries = [];
    for (const session of sessions) {
      entries.push({ session, point: (await this.getPointsBySession(session.id))[0] || null });
    }
    return entries;
  }

  // 調査日を丸ごと削除（配下の地点・実データもまとめて消す）
  async deleteSurvey(surveyId) {
    const sessions = await this.getSessionsBySurvey(surveyId);
    for (const s of sessions) await this.deleteSession(s.id, { keepSurvey: true });

    const tx = this.db.transaction('surveys', 'readwrite');
    tx.objectStore('surveys').delete(surveyId);
    await txDone(tx);
  }

  // ---- sessions（地点） ----

  async putSession(session) {
    const tx = this.db.transaction('sessions', 'readwrite');
    tx.objectStore('sessions').put(session);
    await txDone(tx);
    return session;
  }

  async getSession(id) {
    return reqToPromise(this.db.transaction('sessions').objectStore('sessions').get(id));
  }

  async getSessions() {
    const all = await reqToPromise(this.db.transaction('sessions').objectStore('sessions').getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  // セッションと紐付く地点・実データをまとめて削除する。
  // その調査日が空になったら根（surveys）も片付ける。
  async deleteSession(id, { keepSurvey = false } = {}) {
    const session = await this.getSession(id);
    const points = await this.getPointRecords(id);
    const chunks = await this.getChunkKeys(id);

    const tx = this.db.transaction(['sessions', 'points', 'chunks'], 'readwrite');
    tx.objectStore('sessions').delete(id);
    const ps = tx.objectStore('points');
    for (const p of points) ps.delete(p.id);
    const cs = tx.objectStore('chunks');
    for (const key of chunks) cs.delete(key);
    await txDone(tx);

    if (keepSurvey) return;
    const surveyId = session?.surveyId || (session ? surveyIdOf(session.createdAt) : null);
    if (surveyId && !(await this.getSessionsBySurvey(surveyId)).length) {
      const t = this.db.transaction('surveys', 'readwrite');
      t.objectStore('surveys').delete(surveyId);
      await txDone(t);
    }
  }

  // ---- 下書き（記録開始 → 追記 → 停止 → 確定） ----

  // 記録開始時に空の下書きを作る。先に親を作るので孤児チャンクが発生しない。
  // 失敗したら記録を始めない（呼び出し側で握る）。
  // 根・枝・葉を 1 トランザクションで書き、途中で失敗して根だけ残る状態を作らない。
  async createDraft({ id, startedAt, surveyId }) {
    const existing = await this.getSurvey(surveyId);
    const survey = existing
      ? { ...existing, updatedAt: Date.now() }
      : { id: surveyId, label: surveyId, memo: '', createdAt: startedAt, updatedAt: Date.now() };
    const session = {
      id,
      type: 'record',
      status: 'draft',
      surveyId,
      pointNo: null, // 採番は確定時。下書きは番号を消費しない
      label: '',
      memo: '',
      createdAt: startedAt,
      summary: { count: 0, rawLines: null },
    };
    const point = { id: `${id}_p`, sessionId: id, surveyId, pointNo: null, kind: 'record' };

    const tx = this.db.transaction(['surveys', 'sessions', 'points'], 'readwrite');
    tx.objectStore('surveys').put(survey);
    tx.objectStore('sessions').put(session);
    tx.objectStore('points').put(point);
    await txDone(tx);
    return { session, point };
  }

  // 記録中の追記（5 エポックごと）。チャンクの put と、一覧に出す進捗の更新を
  // 同じトランザクションで行う。既存チャンクは読まない・書き直さない（追記のみ）。
  async appendChunk(sessionId, seq, data, progress) {
    const tx = this.db.transaction(['chunks', 'sessions'], 'readwrite');
    tx.objectStore('chunks').put({ id: `${sessionId}_${seq}`, sessionId, seq, ...data });
    const sessions = tx.objectStore('sessions');
    sessions.get(sessionId).onsuccess = (e) => {
      const session = e.target.result;
      // 停止せずに落ちた記録でも「どこまで録れているか」が一覧に出るようにする
      if (session) sessions.put({ ...session, ...progress, summary: { ...session.summary, ...progress.summary } });
    };
    await txDone(tx);
  }

  // 停止時。集計値とメタだけを書く（実データはチャンクに入っているので触らない）。
  async finishDraft(sessionId, { stats, deviceStats, summary, window, endedAt }) {
    const session = await this.getSession(sessionId);
    if (!session) return null;
    const points = await this.getPointRecords(sessionId);

    const tx = this.db.transaction(['sessions', 'points'], 'readwrite');
    const next = { ...session, endedAt, window, summary };
    tx.objectStore('sessions').put(next);
    const ps = tx.objectStore('points');
    for (const p of points) ps.put({ ...p, stats, ...(deviceStats ? { deviceStats } : {}) });
    await txDone(tx);
    return next;
  }

  // 「保存」＝確定。地点番号・地点名・メモを付けて status を confirmed にする。
  // チャンク（実データ）には触らない。
  // stats / deviceStats は、集計値を持たない下書き（落ちた記録）を確定するときだけ渡る。
  async confirmDraft(sessionId, { stats, deviceStats, ...patch }) {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error('下書きが見つかりません');
    const points = await this.getPointRecords(sessionId);
    const next = { ...session, ...patch, status: 'confirmed', confirmedAt: Date.now() };

    const tx = this.db.transaction(['sessions', 'points'], 'readwrite');
    tx.objectStore('sessions').put(next);
    const ps = tx.objectStore('points');
    // 葉にも地点番号を複写する（point 単体を取り出しても地点が分かるように）
    for (const p of points) {
      ps.put({ ...p, pointNo: next.pointNo, ...(stats ? { stats } : {}), ...(deviceStats ? { deviceStats } : {}) });
    }
    await txDone(tx);
    await this.ensureSurvey(next.surveyId, next.createdAt);
    return next;
  }

  // 起動時の掃除：中身の無い下書きを消す。
  // 記録開始で下書きを作る以上、最初のフラッシュ前に落ちれば空の下書きが残る。
  // 「停止処理が走っていない」かつ「チャンクが0件」＝復元できるものが無いときだけ消す。
  async cleanupEmptyDrafts() {
    const sessions = await this.getSessions();
    let removed = 0;
    for (const s of sessions) {
      if (isConfirmed(s) || s.summary?.stopReason) continue;
      if ((await this.getChunkKeys(s.id)).length) continue;
      await this.deleteSession(s.id);
      removed++;
    }
    return removed;
  }

  // ---- points / chunks（実データ） ----

  // 集計値だけの point レコード（チャンクを結合しない生の形）
  async getPointRecords(sessionId) {
    const idx = this.db.transaction('points').objectStore('points').index('bySession');
    return reqToPromise(idx.getAll(sessionId));
  }

  async getChunkKeys(sessionId) {
    const idx = this.db.transaction('chunks').objectStore('chunks').index('bySession');
    return reqToPromise(idx.getAllKeys(sessionId));
  }

  // 地点の実データを取り出す。チャンクを seq 順に結合し、従来と同じ形の point を返すので
  // 解析タブ・地図・エクスポートの呼び出し側は結合を意識しなくてよい。
  async getPointsBySession(sessionId) {
    const points = await this.getPointRecords(sessionId);
    if (!points.length) return [];
    const idx = this.db.transaction('chunks').objectStore('chunks').index('bySession');
    const chunks = (await reqToPromise(idx.getAll(sessionId))).sort((a, b) => a.seq - b.seq);

    const samples = [];
    const rawNmea = [];
    const deviceSamples = [];
    let hasRaw = false;
    for (const c of chunks) {
      if (c.samples) samples.push(...c.samples);
      if (c.deviceSamples) deviceSamples.push(...c.deviceSamples);
      // 生NMEA を取っていない記録では rawNmea を null のままにする（空配列と区別する）
      if (c.rawNmea) {
        hasRaw = true;
        rawNmea.push(...c.rawNmea);
      }
    }

    const point = { ...points[0], samples };
    if (hasRaw) point.rawNmea = rawNmea;
    if (deviceSamples.length) point.deviceSamples = deviceSamples;
    return [point, ...points.slice(1)];
  }

  // 取込（JSON）用：実データを 1 チャンクとして入れる。読み出し経路を 1 本にするため。
  async putImported(session, point, data) {
    const tx = this.db.transaction(['sessions', 'points', 'chunks'], 'readwrite');
    tx.objectStore('sessions').put(session);
    tx.objectStore('points').put(point);
    tx.objectStore('chunks').put({ id: `${session.id}_0`, sessionId: session.id, seq: 0, ...data });
    await txDone(tx);
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
