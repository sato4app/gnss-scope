// 記録一覧（記録タブの下半分）：「調査日 → 地点」のツリー表示と、そこから伸びる操作。
//   地点     読込 / 編集（地点名・メモ・写真）/ CSV・GPX・NMEA・JSON 出力 / 削除
//   下書き   保存（確定）/ 読込 / 削除
//   調査日   対応表CSV（1行1地点で2系統を並べた表）/ バンドルJSON / 日ごと削除
//   その他   JSON 取込、端末内のデータ量の警告
// 記録の収集そのもの（record → stop → save）は record-ui.js が持つ。
//
// 記録は下書きとして始まり、記録中もチャンクが追記される（js/recorder.js）。
// そのため「保存を押す前に落ちた」でも記録は残る。一覧では下書きを調査日の先頭に出し、
// そこから確定できるようにするのが回収経路になる。
// 停止処理が走らないまま落ちた下書きは集計値を持たないので、読込・確定のときに
// ここで組み立て直す（storage.js を accuracy.js に依存させないため）。
import {
  $, fmt, escapeMarkup, formatBytes, formatResult, sessionMeta, sessionSubText,
  pairingSubText, draftHeadText,
} from './view-utils.js';
import { buildWindow, groupBySurvey, nextPointNo, pointLabel, surveyIdOf, surveySummary } from './survey.js';
import { computeStaticStats, computeDeviceStats } from './accuracy.js';
import { buildSummary } from './recorder.js';
import { isConfirmed, isExported, sessionBytes } from './storage.js';
import { SERIES, STORAGE_LIMITS } from './constants.js';
import {
  exportCSV, exportGPX, exportJSON, exportNMEA,
  exportSurveyCompareCSV, exportSurveyJSON, importSessionFile,
} from './file-io.js';

// storage:      IndexedDB ラッパ
// recorder:     収集中の下書き id を見るためだけに使う（その行の操作を止める）
// photos:       写真パネル（photo-ui.js）
// onLoad:       読込データの差し替え通知（解析タブ・地図タブへ配る）
// getLoadedId:  現在の読込データの地点 id（一覧で強調するため）
// getPendingId: 停止直後の未確定な記録の id（削除されたら record-ui へ知らせる）
// onPendingGone: その未確定な記録が一覧から消えたときの通知
export function initSessionListUI({
  storage, recorder, photos, onLoad, getLoadedId, getPendingId, onPendingGone,
}) {
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
      '調査日ごとに「📦 バンドルJSON」で書き出してから、不要な調査日を削除してください。';
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

  // ---- 取込 ----
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを続けて選べるようにする
    if (!file) return;
    try {
      // 単体・バンドル（調査日まるごと）どちらの JSON も同じ入口で受ける
      const entries = await importSessionFile(file, storage);
      await load(entries[entries.length - 1]);
      await refreshStorageWarning();
      const epochs = entries.reduce((n, x) => n + x.point.samples.length, 0);
      alert(`取り込みました: ${entries.length} 地点 / 合計 ${epochs} エポック`);
    } catch (err) {
      alert(`取り込みに失敗しました: ${err.message}`);
    }
  });

  // 未確定の記録が一覧から消えたときの後始末（削除・確定で共用）
  function dropPendingIf(gone) {
    if (gone) onPendingGone();
  }

  // 地点の行アクション（読込 / エクスポート / 削除 / 編集 / 下書きの確定）
  async function runAction(act, session, li) {
    if (act === 'load') {
      const point = (await storage.getPointsBySession(session.id))[0];
      if (!point) {
        alert('記録データが見つかりません');
        return;
      }
      await load(withStats(session, point));
      return;
    }
    if (act === 'del') {
      const what = isConfirmed(session) ? `「${session.label}」` : 'この下書き';
      if (!confirm(`${what}を削除しますか？`)) return;
      dropPendingIf(session.id === getPendingId());
      await storage.deleteSession(session.id);
      if (session.id === getLoadedId()) await load(null);
      else await refresh();
      await refreshStorageWarning();
      return;
    }
    // 確定済み地点の編集：地点名・メモ・写真をその行で直せるようにする
    if (act === 'edit') {
      const form = li.querySelector('.edit-form');
      form.hidden = !form.hidden;
      if (form.hidden) return;
      form.querySelector('.edit-label').value = session.label || '';
      form.querySelector('.edit-memo').value = session.memo || '';
      await renderRowPhotos(session, li);
      return;
    }
    if (act === 'save-edit') {
      const form = li.querySelector('.edit-form');
      const label = form.querySelector('.edit-label').value.trim();
      await storage.putSession({
        ...session,
        label: label || session.label,
        memo: form.querySelector('.edit-memo').value.trim(),
      });
      await refresh();
      return;
    }
    // 写真の増減では一覧を作り直さない（作り直すと開いている編集フォームが閉じてしまう）
    if (act === 'edit-photo') {
      if (!(await photos.pickAndAdd(session.id))) return;
      await renderRowPhotos(session, li);
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
      return;
    }
    const point = (await storage.getPointsBySession(session.id))[0] || null;
    const exporters = { csv: exportCSV, gpx: exportGPX, json: exportJSON, nmea: exportNMEA };
    try {
      exporters[act]?.(session, point);
    } catch (e) {
      alert(e.message);
    }
  }

  const renderRowPhotos = (session, li) =>
    photos.render(li.querySelector('.edit-photo-strip'), li.querySelector('.edit-photo-count'), session.id);

  // 調査日（1日ぶん）のアクション。20地点を1ファイルにまとめて持ち出すための入口。
  async function runSurveyAction(act, survey) {
    if (act === 'delsurvey') {
      const sessions = await storage.getSessionsBySurvey(survey.id);
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
    const entries = await storage.getSurveyEntries(survey.id);
    if (!entries.length) {
      alert('この調査日には地点がありません');
      return;
    }
    if (act === 'compare') {
      exportSurveyCompareCSV(survey, entries);
      return;
    }
    if (act === 'bundle') {
      exportSurveyJSON(survey, entries);
      // 書き出した記録を残す。容量警告の「未書き出しぶん」と一覧の表示に使う
      await storage.markExported(survey.id);
      await refresh();
      await refreshStorageWarning();
    }
  }

  // ---- 描画 ----
  // 調査日 → 地点 のツリー。地点の対応（NMEA / Android が揃っているか）も各行に出す。
  // 下書きは調査日の先頭に出る（pointNo が無いので既存の並びのまま先に来る）。
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

    for (const group of groupBySurvey(sessions)) {
      const survey = surveys.get(group.surveyId) || { id: group.surveyId, label: group.surveyId };
      const li = surveyRow(survey, group.sessions);
      const pointList = li.querySelector('.point-list');
      for (const session of group.sessions) {
        pointList.appendChild(
          isConfirmed(session) ? pointRow(session, loadedId) : draftRow(session, loadedId, recordingId)
        );
      }
      ul.appendChild(li);
    }
  }

  // 調査日1日ぶんの見出し＋集計＋日ごとの操作
  function surveyRow(survey, sessions) {
    // 集計は確定済みのみ。下書きが混ざると平均DRMS も両系統カウントも歪む
    const confirmed = sessions.filter(isConfirmed);
    const draftCount = sessions.length - confirmed.length;
    const sum = surveySummary(confirmed);
    const bytes = sessions.reduce((n, x) => n + sessionBytes(x), 0);
    const li = document.createElement('li');
    li.className = 'survey';
    li.innerHTML = `
      <details open>
        <summary>
          <span class="sv-date">${escapeMarkup(survey.id)}</span>
          <span class="sv-count">${sum.points} 地点</span>
          ${draftCount ? `<span class="sv-draft">下書き ${draftCount}件</span>` : ''}
          ${isExported(survey) ? '<span class="sv-exported">書出済</span>' : ''}
          <span class="sv-pair">両系統 ${sum.both}${sum.gnssOnly ? ` / ${SERIES.gnss.label}のみ ${sum.gnssOnly}` : ''}${sum.deviceOnly ? ` / ${SERIES.device.label}のみ ${sum.deviceOnly}` : ''}</span>
        </summary>
        <div class="sv-sub">平均DRMS: ${SERIES.gnss.label} ${fmt(sum.avgDrms, 2, ' m')} / ${SERIES.device.label} ${fmt(sum.avgDeviceDrms, 2, ' m')}　データ量 約 ${formatBytes(bytes)}</div>
        <div class="s-actions sv-actions">
          <button class="btn" data-sact="compare">📊 対応表CSV</button>
          <button class="btn" data-sact="bundle">📦 バンドルJSON</button>
          <button class="btn danger" data-sact="delsurvey">日ごと削除</button>
        </div>
        <ul class="point-list"></ul>
      </details>`;
    li.querySelector('.sv-actions').addEventListener('click', (ev) => {
      const act = ev.target.dataset?.sact;
      if (act) runSurveyAction(act, survey);
    });
    return li;
  }

  // 行に共通の中身（点数・DRMS・2系統の対応）と、クリックの取り回し
  function buildRow(session, loadedId, headHtml, actionsHtml, extraHtml = '') {
    const li = document.createElement('li');
    if (session.id === loadedId) li.classList.add('loaded');
    li.innerHTML = `
      <div class="s-head">${headHtml}</div>
      <div class="s-sub">${sessionSubText(session)}</div>
      <div class="s-sub s-pair">${pairingSubText(session)}</div>
      <div class="s-actions">${actionsHtml}</div>
      ${extraHtml}`;
    li.addEventListener('click', async (ev) => {
      const act = ev.target.dataset?.act;
      const photoId = ev.target.dataset?.photo;
      if (act) runAction(act, session, li);
      else if (photoId && (await photos.confirmDelete(session.id, photoId))) {
        await renderRowPhotos(session, li);
        await refreshStorageWarning();
      }
    });
    return li;
  }

  // 1地点ぶんの行（確定済み）。編集フォームには写真パネルも入れる
  // （現地で撮り忘れた写真を後から足せるようにするのが主目的）。
  function pointRow(session, loadedId) {
    const imported = !!session.importedAt;
    const hasRaw = (session.summary?.rawLines ?? 0) > 0;
    const photoCount = session.summary?.photoCount || 0;
    const head =
      `<span class="s-no">No.${session.pointNo ?? '—'}</span>` +
      `<span class="s-type ${imported ? 'imported' : ''}">${imported ? '取込' : '記録'}</span>` +
      `<span class="s-label">${escapeMarkup(session.label)}</span>` +
      (photoCount ? `<span class="s-photos">📷${photoCount}</span>` : '');
    const actions = `
      <button class="btn" data-act="load">読込</button>
      <button class="btn" data-act="edit">編集</button>
      <button class="btn" data-act="csv">CSV</button>
      <button class="btn" data-act="gpx">GPX</button>
      <button class="btn" data-act="nmea"${hasRaw ? '' : ' disabled'}>NMEA</button>
      <button class="btn" data-act="json">JSON</button>
      <button class="btn danger" data-act="del">削除</button>`;
    const editForm = `
      <div class="edit-form" hidden>
        <div class="rec-form">
          <input type="text" class="edit-label" placeholder="地点名">
          <input type="text" class="edit-memo" placeholder="メモ（任意）">
        </div>
        ${photos.panelHtml()}
        <div class="s-actions"><button class="btn primary" data-act="save-edit">変更を保存</button></div>
      </div>`;
    return buildRow(session, loadedId, head, actions, editForm);
  }

  // 下書きの行。エクスポートは出さない（確定してから持ち出す）。
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

  return { refresh, refreshStorageWarning, load, confirmDraft, defaultLabel, savedText };
}
