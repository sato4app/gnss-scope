// 「一覧」タブ：端末内（IndexedDB）に残っている測位データを**日ごとに**並べ、そこから持ち出す。
//   調査日  読込 / 出力（ZIP 1ファイル）/ 日ごと削除
//   下書き  保存（確定）/ 読込 / 削除
//   その他  読込（JSON / 出力ZIP の取込）、端末内のデータ量の警告
// 記録の収集そのもの（record → stop → save）は record-ui.js が持つ。
//
// 確定した地点は1行ずつ並べない。20地点×数日ぶんの行を畳んで「調査日」に集計し、
// 持ち出し（出力）と片付け（削除）も日単位で行う。1地点ずつ見たいときは読み込んで
// 解析・地図タブで切り替える（地点セレクタ＝js/loaded-picker.js）。
// 日の行に出す値は3段に分ける:
//   1段目 日付・地点数・下書き件数・書出済・読込中・取りこぼしの警告・2系統の内訳
//   2段目 測定区間・エポック数・生NMEA の量（surveySpanText / surveyDataText）
//   3段目 平均DRMS・写真枚数・データ量
//
// この一覧は session だけを読んで描く（実データ＝チャンクは結合しない）。開くたびに
// 結合していては待たされるため、集計に使う値は session.summary に持たせてある。
//
// 記録は下書きとして始まり、記録中もチャンクが追記される（js/recorder.js）。
// そのため「保存を押す前に落ちた」でも記録は残る。下書きだけは調査日の中に行として出し、
// そこから確定できるようにするのが回収経路になる。
// 停止処理が走らないまま落ちた下書きは集計値を持たないので、読込・確定のときに
// ここで組み立て直す（storage.js を accuracy.js に依存させないため）。
import {
  $, fmt, escapeMarkup, formatBytes, formatResult, sessionMeta, draftHeadText,
  pointSummaryText, pointDataText, lossWarnText, surveyDateText, surveySpanText, surveyDataText,
} from './view-utils.js';
import { buildWindow, groupBySurvey, nextPointNo, pointLabel, surveyIdOf, surveySummary } from './survey.js';
import { computeStaticStats, computeDeviceStats } from './accuracy.js';
import { buildSummary } from './recorder.js';
import { isConfirmed, isExported, sessionBytes } from './storage.js';
import { SERIES, STORAGE_LIMITS } from './constants.js';
import { importSessionFile } from './file-io.js';
import { exportPackage, importPackageFile } from './package-io.js';

// storage:      IndexedDB ラッパ
// recorder:     収集中の下書き id を見るためだけに使う（その行の操作を止める）
// onLoad:       読込データの差し替え通知（解析タブ・地図タブへ配る）
// getLoadedId:  現在の読込データの地点 id（読込中の調査日を示すため）
// getPendingId: 停止直後の未確定な記録の id（削除されたら record-ui へ知らせる）
// onPendingGone: その未確定な記録が一覧から消えたときの通知
export function initListUI({
  storage, recorder, onLoad, getLoadedId, getPendingId, onPendingGone,
}) {
  // 開いている調査日。refresh のたびに畳んでしまうと、操作するたびに開き直すことになる
  const openSurveys = new Set();
  let openInitialized = false;
  let busy = false; // 出力・取込の最中（二重に走らせない）

  // ---- 端末内のデータ量 ----
  // 記録は止めない（現場で測れなくなる方が困る）。しきい値を超えたら警告を出し続け、
  // 「WiFi のある所で書き出して消す」運用を促す。未書き出しぶんを併記するのは、
  // どれを消してよいかがその場で分かるようにするため。
  async function refreshStorageWarning() {
    const el = $('storage-warn');
    let usage;
    try {
      usage = await storage.getStorageUsage();
    } catch (e) {
      el.hidden = true;
      return;
    }
    const { warnBytes, maxBytes } = STORAGE_LIMITS;
    $('storage-status').textContent =
      `記録データ: 約 ${formatBytes(usage.total)} / 想定上限 ${formatBytes(maxBytes)}` +
      `（未書き出し 約 ${formatBytes(usage.unexported)}）`;
    if (usage.total < warnBytes) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.textContent =
      `⚠ 端末内のデータが 約 ${formatBytes(usage.total)}（想定上限 ${formatBytes(maxBytes)}）です。` +
      `未書き出し 約 ${formatBytes(usage.unexported)}。` +
      '調査日ごとに「📦 出力」で書き出してから、不要な調査日を削除してください。';
  }

  // ---- 下書きの確定 ----

  // その調査日の次の地点名（確定済みのみを見て採番する。下書きは番号を消費しない）
  async function defaultLabel(surveyId) {
    const siblings = (await storage.getSessionsBySurvey(surveyId)).filter(isConfirmed);
    return pointLabel(surveyId, nextPointNo(siblings, surveyId));
  }

  // 地点番号を採番して status を confirmed にする。実データには触らない。
  async function confirmDraft(session, label, memo) {
    if (!session) throw new Error('下書きが見つかりません');
    const point = (await storage.getPointsBySession(session.id))[0] || null;
    if (!point?.samples?.length) {
      alert('記録データが見つかりません');
      return null;
    }
    const surveyId = session.surveyId || surveyIdOf(session.createdAt);
    const siblings = (await storage.getSessionsBySurvey(surveyId)).filter(isConfirmed);
    const pointNo = nextPointNo(siblings, surveyId);
    const patch = { pointNo, label: label || pointLabel(surveyId, pointNo), memo };
    // 停止処理が走らないまま落ちた下書きは集計値を持たないので、ここで作る
    if (!session.summary?.stopReason) Object.assign(patch, rebuildStats(session, point));

    const next = await storage.confirmDraft(session.id, patch);
    if (!patch.stats) return { session: next, point };
    return { session: next, point: { ...point, stats: patch.stats, deviceStats: patch.deviceStats } };
  }

  // 落ちた下書きの集計をやり直す。storage.js を accuracy.js に依存させたくないので
  // 呼び出し側であるここで組み立てる（取込側の file-io.js も同じことをしている）。
  function rebuildStats(session, point) {
    const stats = computeStaticStats(point.samples);
    const deviceSamples = point.deviceSamples || [];
    const deviceStats = deviceSamples.length ? computeDeviceStats(deviceSamples, stats?.center || null) : null;
    const last = point.samples[point.samples.length - 1];
    const endedAt = session.endedAt ?? last?.recvAt ?? last?.t ?? session.createdAt;
    const window = buildWindow({ startedAt: session.createdAt, endedAt, samples: point.samples, deviceSamples });
    const summary = buildSummary({
      stats,
      deviceStats,
      stopReason: 'crashed',
      autoStop: session.summary?.autoStop,
      rxStats: session.summary?.rxStats ?? null,
      rawLines: session.summary?.rawLines ?? (point.rawNmea ? point.rawNmea.length : null),
      rawTruncated: session.summary?.rawTruncated,
    });
    return { stats, deviceStats, window, summary, endedAt };
  }

  // 表示用に集計値を補う（DB へは書かない）。落ちた下書きを読込・エクスポートするため。
  function withStats(session, point) {
    if (session.summary?.stopReason || !point?.samples?.length) return { session, point };
    const { stats, deviceStats, window, summary } = rebuildStats(session, point);
    return { session: { ...session, window, summary }, point: { ...point, stats, deviceStats } };
  }

  // 確定済み・読込済みの記録の結果テキスト（停止直後版と同じ並び）
  function savedText(session, point) {
    return formatResult({
      meta: sessionMeta(session),
      stats: point.stats,
      deviceStats: point.deviceStats,
      window: session.window,
      summary: session.summary,
    });
  }

  // ---- load ----
  // 読込中の記録を一覧で強調するため、onLoad → 一覧再描画の順で行う
  async function load(entry) {
    onLoad(entry);
    await refresh();
  }

  // 地点 id から読込データを組み立てて配る。
  // 調査日の「読込」・取込の直後・解析/地図タブの地点セレクタが、どれもここを通る。
  async function loadSession(id) {
    const session = await storage.getSession(id);
    if (!session) {
      alert('記録が見つかりません');
      return false;
    }
    const point = (await storage.getPointsBySession(id))[0];
    if (!point) {
      alert('記録データが見つかりません');
      return false;
    }
    await load(withStats(session, point));
    return true;
  }

  // その調査日の先頭（No.1）を読込データにする。地点行を畳んだので、
  // 端末内のデータへは「日から入って、あとは解析・地図タブで地点を選ぶ」経路になる。
  async function loadSurveyHead(surveyId) {
    const first = (await storage.getSessionsBySurvey(surveyId)).filter(isConfirmed)[0];
    if (first) return loadSession(first.id);
    await refresh();
    return false;
  }

  // ---- 取込（JSON / 出力ZIP） ----
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを続けて選べるようにする
    if (!file || busy) return;
    busy = true;
    setStatus(`読込中… ${file.name}`);
    try {
      // 出力ZIP（format 3）・単体JSON（1）・バンドルJSON（2）を同じ入口で受ける。
      // 既に持っている地点（調査日＋記録開始時刻が一致）は取り込まれずに返る。
      const { entries, skipped, surveyId } = /\.zip$/i.test(file.name)
        ? await importPackageFile(file, storage)
        : await importSessionFile(file, storage);
      // 取り込んだものをそのまま読込データにする。1地点ならその地点、日まるごとなら先頭（No.1）
      // から入り、他の地点は解析・地図タブのセレクタで選ぶ。全部重複でも日は分かるので開ける
      // ―― 手元にあるのに読めない、という行き止まりを作らない。
      if (entries.length === 1) await load(entries[0]);
      else if (surveyId) await loadSurveyHead(surveyId);
      else await refresh();
      await refreshStorageWarning();
      const dup = skipped ? `（重複 ${skipped} 地点はスキップ）` : '';
      const epochs = entries.reduce((n, x) => n + x.point.samples.length, 0);
      setStatus(
        entries.length
          ? `取り込みました: ${entries.length} 地点 / 合計 ${epochs} エポック${dup}`
          : `すべて取り込み済みでした${dup}`
      );
    } catch (err) {
      setStatus('');
      alert(`取り込みに失敗しました: ${err.message}`);
    } finally {
      busy = false;
    }
  });

  // 出力・取込の途中経過（進捗と結果を同じ場所に出す）
  function setStatus(text) {
    const el = $('list-status');
    el.hidden = !text;
    el.textContent = text || '';
  }

  // ---- 出力（ZIP 1ファイル） ----
  // 持ち出しは調査日まるごとで行う（1地点だけ書き出しても日は片付かない）。
  // ZIP の中身は kind によらず同じ構造なので、取り込む側の経路は1本で済む。
  async function runExport({ survey, sessions, kind }) {
    if (busy) return;
    busy = true;
    try {
      const result = await exportPackage({
        storage,
        survey,
        sessions,
        kind,
        includePhotos: $('list-export-photos').checked,
        onProgress: (done, total) => setStatus(`出力中… ${done}/${total} 地点`),
      });
      // 書き出した記録を残すのは調査日まるごとのときだけ（1地点では日は片付かない）
      if (kind === 'survey') await storage.markExported(survey.id);
      await refresh();
      await refreshStorageWarning();
      setStatus(`${result.filename} を出力しました（${result.counts.points} 地点 / 約 ${formatBytes(result.bytes)}）`);
    } catch (e) {
      setStatus('');
      alert(`出力に失敗しました: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  // 未確定の記録が一覧から消えたときの後始末（削除・確定で共用）
  function dropPendingIf(gone) {
    if (gone) onPendingGone();
  }

  // 下書きの行アクション（読込 / 削除 / 保存＝確定）
  async function runAction(act, session, li) {
    if (act === 'load') {
      await loadSession(session.id);
      return;
    }
    if (act === 'del') {
      if (!confirm('この下書きを削除しますか？')) return;
      dropPendingIf(session.id === getPendingId());
      await storage.deleteSession(session.id);
      if (session.id === getLoadedId()) await load(null);
      else await refresh();
      await refreshStorageWarning();
      return;
    }
    // 下書きの確定：その行に地点名・メモの入力欄を開く（再起動後の回収経路）
    if (act === 'confirm') {
      const form = li.querySelector('.draft-form');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('.draft-label').value = await defaultLabel(session.surveyId);
      return;
    }
    if (act === 'commit') {
      const form = li.querySelector('.draft-form');
      const entry = await confirmDraft(
        session,
        form.querySelector('.draft-label').value.trim(),
        form.querySelector('.draft-memo').value.trim()
      );
      if (!entry) return;
      dropPendingIf(session.id === getPendingId());
      await load(entry);
    }
  }

  // 調査日（1日ぶん）のアクション。20地点を1ファイルにまとめて持ち出すための入口。
  async function runSurveyAction(act, survey) {
    const sessions = await storage.getSessionsBySurvey(survey.id);
    // その日を解析・地図タブへ渡す。先頭の地点から入り、あとは向こうのセレクタで行き来する
    if (act === 'loadsurvey') {
      if (!sessions.some(isConfirmed)) {
        alert('この調査日には地点がありません（下書きはその行から読み込めます）');
        return;
      }
      await loadSurveyHead(survey.id);
      return;
    }
    if (act === 'delsurvey') {
      const drafts = sessions.filter((s) => !isConfirmed(s)).length;
      const what = `${sessions.length - drafts} 地点` + (drafts ? `と下書き ${drafts} 件` : '');
      if (!confirm(`「${survey.id}」の ${what} をまとめて削除しますか？`)) return;
      dropPendingIf(sessions.some((s) => s.id === getPendingId()));
      const loadedGone = sessions.some((s) => s.id === getLoadedId());
      await storage.deleteSurvey(survey.id);
      if (loadedGone) await load(null);
      else await refresh();
      await refreshStorageWarning();
      return;
    }
    if (act === 'export') {
      if (!sessions.some(isConfirmed)) {
        alert('この調査日には地点がありません（下書きは出力できません）');
        return;
      }
      await runExport({ survey, sessions, kind: 'survey' });
    }
  }

  // ---- 描画 ----
  // 並ぶのは調査日だけ。確定した地点はその日の集計に畳み、行としては出さない
  // （1地点ずつ見るのは解析・地図タブの仕事）。開いている調査日は開いたまま保つ。
  async function refresh() {
    const ul = $('session-list');
    ul.innerHTML = '';
    const sessions = await storage.getSessions();
    if (!sessions.length) {
      ul.innerHTML = '<li class="s-sub">記録はまだありません</li>';
      return;
    }
    const surveys = new Map((await storage.getSurveys()).map((s) => [s.id, s]));
    const loadedId = getLoadedId();
    const recordingId = recorder.currentId;

    const groups = groupBySurvey(sessions);
    if (!openInitialized) {
      openSurveys.add(groups[0].surveyId); // 初回は最新の調査日だけ開く
      openInitialized = true;
    }
    for (const group of groups) {
      const survey = surveys.get(group.surveyId) || { id: group.surveyId };
      const li = surveyRow(survey, group.sessions, loadedId);
      const pointList = li.querySelector('.point-list');
      // 行として残すのは下書きだけ（確定していない記録は集計に混ぜられないし、
      // ここから確定させるのが落ちたときの回収経路でもある）
      for (const session of group.sessions) {
        if (!isConfirmed(session)) pointList.appendChild(draftRow(session, loadedId, recordingId));
      }
      ul.appendChild(li);
    }
  }

  // 調査日1日ぶんの見出し＋集計＋日ごとの操作
  // loadedId: 読込中の地点。地点行を畳んだぶん、「今どの日を見ているか」はここに出す
  function surveyRow(survey, sessions, loadedId) {
    // 集計は確定済みのみ。下書きが混ざると平均DRMS も両系統カウントも歪む
    const confirmed = sessions.filter(isConfirmed);
    const draftCount = sessions.length - confirmed.length;
    const sum = surveySummary(confirmed);
    const bytes = sessions.reduce((n, x) => n + sessionBytes(x), 0);
    const loadedHere = sessions.find((x) => x.id === loadedId) || null;
    // 取りこぼしのある地点は日の行にまとめて出す（再測が要る日をここで拾えるようにする）。
    // 地点ごとの内訳は行に出す場所が無いので title に入れる。
    const warns = confirmed
      .map((x) => ({ no: x.pointNo, text: lossWarnText(x) }))
      .filter((x) => x.text);
    const li = document.createElement('li');
    li.className = 'survey';
    li.innerHTML = `
      <details${openSurveys.has(survey.id) ? ' open' : ''}>
        <summary>
          <span class="sv-date">${escapeMarkup(surveyDateText(survey.id))}</span>
          <span class="sv-count">${sum.points} 地点</span>
          ${draftCount ? `<span class="sv-draft">下書き ${draftCount}件</span>` : ''}
          ${isExported(survey) ? '<span class="sv-exported">書出済</span>' : ''}
          ${loadedHere ? `<span class="sv-loaded">読込中 ${escapeMarkup(loadedHere.pointNo ? `No.${loadedHere.pointNo}` : '下書き')}</span>` : ''}
          ${warns.length ? `<span class="sv-warn" title="${escapeMarkup(warns.map((x) => `No.${x.no} ${x.text}`).join('、'))}">⚠ ${warns.length}地点</span>` : ''}
          <span class="sv-pair">両系統 ${sum.both}${sum.gnssOnly ? ` / ${SERIES.gnss.label}のみ ${sum.gnssOnly}` : ''}${sum.deviceOnly ? ` / ${SERIES.device.label}のみ ${sum.deviceOnly}` : ''}</span>
        </summary>
        <div class="sv-sub">${escapeMarkup([surveySpanText(sum), surveyDataText(sum)].filter(Boolean).join('　'))}</div>
        <div class="sv-sub">平均DRMS: ${SERIES.gnss.label} ${fmt(sum.avgDrms, 2, 'm')} / ${SERIES.device.label} ${fmt(sum.avgDeviceDrms, 2, 'm')}${sum.photos ? `　📷${sum.photos}枚` : ''}　データ量 約 ${formatBytes(bytes)}</div>
        <div class="s-actions sv-actions">
          <button class="btn" data-sact="loadsurvey">読込</button>
          <button class="btn primary" data-sact="export">📦 出力</button>
          <button class="btn danger" data-sact="delsurvey">日ごと削除</button>
        </div>
        <ul class="point-list"></ul>
      </details>`;
    const details = li.querySelector('details');
    details.addEventListener('toggle', () => {
      if (details.open) openSurveys.add(survey.id);
      else openSurveys.delete(survey.id);
    });
    li.querySelector('.sv-actions').addEventListener('click', (ev) => {
      const act = ev.target.dataset?.sact;
      if (act) runSurveyAction(act, survey);
    });
    return li;
  }

  // 下書きの行に共通の中身（3段のテキスト）と、クリックの取り回し
  function buildRow(session, loadedId, headHtml, actionsHtml, extraHtml = '') {
    const li = document.createElement('li');
    if (session.id === loadedId) li.classList.add('loaded');
    li.innerHTML = `
      <div class="s-head">${headHtml}</div>
      <div class="s-sub">${escapeMarkup(pointSummaryText(session))}</div>
      <div class="s-sub s-pair">${escapeMarkup(pointDataText(session, sessionBytes(session)))}</div>
      <div class="s-actions">${actionsHtml}</div>
      ${extraHtml}`;
    li.addEventListener('click', (ev) => {
      const act = ev.target.dataset?.act;
      if (act) runAction(act, session, li);
    });
    return li;
  }

  // 下書きの行。出力は出さない（確定してから持ち出す）。
  // 収集中の下書きは操作させない（自分が今書いている先なので）。
  function draftRow(session, loadedId, recordingId) {
    const recording = session.id === recordingId;
    const head =
      `<span class="s-type ${recording ? 'recording' : 'draft'}">${recording ? '記録中' : '下書き'}</span>` +
      `<span class="s-label">${escapeMarkup(recording ? '収集中…' : draftHeadText(session))}</span>`;
    if (recording) return buildRow(session, loadedId, head, '');
    const actions = `
      <button class="btn primary" data-act="confirm">保存</button>
      <button class="btn" data-act="load">読込</button>
      <button class="btn danger" data-act="del">削除</button>`;
    const form = `
      <div class="rec-form draft-form" hidden>
        <input type="text" class="draft-label" placeholder="地点名">
        <input type="text" class="draft-memo" placeholder="メモ（任意）">
        <button class="btn primary" data-act="commit">確定</button>
      </div>`;
    return buildRow(session, loadedId, head, actions, form);
  }

  refresh();
  refreshStorageWarning();

  return { refresh, refreshStorageWarning, load, loadSession, confirmDraft, defaultLabel, savedText };
}
