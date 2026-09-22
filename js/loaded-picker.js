// 読込データの地点セレクタ。
// 一覧タブは調査日（1日）までしか並べないので、「その日のどの地点を見るか」は
// データを使う側＝解析タブ・地図タブで選ぶ。両タブに同じセレクタを置き、
// どちらで切り替えても読込データそのものが入れ替わる（見た目だけの切り替えにしない）。
import { $, escapeMarkup, draftHeadText } from './view-utils.js';
import { isConfirmed } from './storage.js';

// storage: IndexedDB ラッパ
// ids:     セレクタを置く <select> の id（解析タブ・地図タブ）
// onPick:  選ばれた地点 id を読込データにする（list-ui.js の loadSession）
export function initLoadedPicker({ storage, ids, onPick }) {
  const selects = ids.map((id) => $(id));
  for (const el of selects) {
    el.addEventListener('change', () => {
      if (el.value) onPick(el.value);
    });
  }

  const optionText = (session) =>
    isConfirmed(session)
      ? `No.${session.pointNo} ${session.label || ''}`.trim()
      : `下書き ${draftHeadText(session)}`;

  // 読込データが変わるたびに、その調査日の地点を並べ直す。
  // 選ぶものが1つしかない日では出さない（選択肢のないセレクタは邪魔なだけ）。
  async function sync(entry) {
    const surveyId = entry?.session?.surveyId || null;
    let sessions = surveyId ? (await storage.getSessionsBySurvey(surveyId)).filter(isConfirmed) : [];
    // 下書きは調査日の地点一覧に入らないので、読み込んでいるときだけ先頭に足す
    // （選択状態を表せないと「今どれを見ているのか」が消えてしまう）
    if (entry && !sessions.some((s) => s.id === entry.session.id)) sessions = [entry.session, ...sessions];
    const html = sessions
      .map((s) => `<option value="${escapeMarkup(s.id)}">${escapeMarkup(optionText(s))}</option>`)
      .join('');
    for (const el of selects) {
      el.innerHTML = html;
      if (entry) el.value = entry.session.id;
      el.hidden = sessions.length < 2;
    }
  }

  return { sync };
}
