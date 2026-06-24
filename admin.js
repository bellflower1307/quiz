// ============================================================
// クイズ管理画面（admin.html）の動作ロジック
//
// SUPABASE_URL / SUPABASE_ANON_KEY は config.js で定義されます。
// getAdminToken / adminLogout / setupAdminAuth は auth.js で定義されます。
// ============================================================

// ============================================================
// Supabase REST ヘルパー（管理者用）
//
// 参加者画面（script.js）と異なり、ログイン済みの JWT トークンを
// Authorization ヘッダーに使用する。トークンは毎回 getAdminToken() で
// 取得することで、ログアウト後に古いトークンが使われるのを防ぐ。
// ============================================================
function adminHeaders() {
  return {
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${getAdminToken()}`, // 毎回最新のトークンを取得
    'Content-Type':  'application/json',
  };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: { ...adminHeaders(), ...(opts.headers || {}) },
  });
  if (!res.ok) {
    // 401（認証切れ）/ 403（権限なし）のとき、ログイン画面に戻す
    if (res.status === 401 || res.status === 403) {
      returnToLogin();
      throw new Error('認証エラー：再ログインしてください。');
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// quiz_state テーブルの id=1 の行を取得する
async function fetchQuizState() {
  const rows = await apiFetch('/rest/v1/quiz_state?id=eq.1&select=*');
  return rows?.[0] ?? null;
}

// quiz_state テーブルの id=1 の行を部分更新する（PATCH = 指定したフィールドだけ更新）
async function patchQuizState(patch) {
  await apiFetch('/rest/v1/quiz_state?id=eq.1', {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' }, // レスポンスボディ不要（軽量化）
    body: JSON.stringify(patch),
  });
}

// 今日の 0:00:00 を ISO8601 形式で返す（前日以前のデータを除外するために使う）
function todayStartISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// 指定した問題番号の今日の回答を取得する（新しい順 = 最後に送信した回答が先頭）
async function fetchAnswers(questionNumber) {
  return apiFetch(
    `/rest/v1/answers?question_number=eq.${questionNumber}&submitted_at=gte.${todayStartISO()}&select=id,participant_id,nickname,value&order=submitted_at.desc`
  );
}

// 回答にポイントを書き込む（上位3名が確定した後に呼ぶ）
async function patchAnswerPoints(answerId, points) {
  await apiFetch(`/rest/v1/answers?id=eq.${answerId}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ points_earned: points }),
  });
}

// participants テーブルから参加者の現在の累計ポイントを取得する
async function fetchParticipant(id) {
  const rows = await apiFetch(`/rest/v1/participants?id=eq.${encodeURIComponent(id)}&select=total_points`);
  return rows?.[0] ?? null;
}

// participants テーブルの累計ポイントを更新する
async function patchParticipantPoints(id, newTotal) {
  await apiFetch(`/rest/v1/participants?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ total_points: newTotal }),
  });
}

// ============================================================
// タイを考慮したランク・ポイント計算（admin/preview 共通ヘルパー）
//
// answers は「正解との差」昇順でソート済みであること。
// 同差の参加者には同じ rank と pts を付与し、
// 次のグループの rank はタイ人数分だけ飛ばす。
// ============================================================
function assignRanksAndPoints(answers, correct, total) {
  let idx = 0;
  while (idx < total) {
    const diff = Math.abs(answers[idx].value - correct);
    // 同差のグループの末尾を探す
    let end = idx;
    while (end < total && Math.abs(answers[end].value - correct) === diff) end++;
    // このグループの rank = idx+1、pts = total - idx（グループ先頭の順位相当）
    const rank = idx + 1;
    const pts  = total - idx;
    for (let k = idx; k < end; k++) {
      answers[k].rank = rank;
      answers[k].pts  = pts;
    }
    idx = end;
  }
}

// 当日の answers から参加者ごとのポイントを集計してランキングを返す
async function fetchRanking() {
  const rows = await apiFetch(
    `/rest/v1/answers?submitted_at=gte.${todayStartISO()}&select=participant_id,nickname,points_earned`
  ) ?? [];
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.participant_id)) {
      map.set(row.participant_id, { nickname: row.nickname, total_points: 0 });
    }
    map.get(row.participant_id).total_points += row.points_earned;
  }
  return [...map.values()].sort((a, b) => b.total_points - a.total_points);
}

// XSS 対策：ユーザー入力を HTML として解釈させないようにエスケープする
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================================
// プレビュー描画
// ============================================================

// 結果プレビューを描画する（btnResults 押下後に呼ぶ）
// answers には assignRanksAndPoints で .rank / .pts が付与済みであること
function renderResultsPreview(answers, correctAnswer) {
  const preview = document.getElementById('admin-preview');
  const resDiv  = document.getElementById('admin-results-preview');
  const rankDiv = document.getElementById('admin-ranking-preview');
  preview.classList.remove('hidden');
  resDiv.classList.remove('hidden');
  rankDiv.classList.add('hidden');

  document.getElementById('adm-res-correct').textContent = correctAnswer;

  // 表彰台（rank 1〜3 に該当する人を全員表示）
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const podium = document.getElementById('adm-res-podium');
  podium.innerHTML = '';
  answers.filter(a => a.rank <= 3).forEach((a) => {
    const div  = document.createElement('div');
    div.className = `podium-item rank-${Math.min(a.rank, 3)}`;
    const diff = Math.abs(a.value - correctAnswer);
    div.innerHTML = `
      <span class="podium-medal">${MEDAL[a.rank] ?? ''}</span>
      <span class="podium-nick">${escHtml(a.nickname)}</span>
      <span class="podium-value">${a.value}（差：${diff.toFixed(4).replace(/\.?0+$/, '')}）</span>
      <span class="podium-pts">+${a.pts}pt</span>
    `;
    podium.appendChild(div);
  });

  const list = document.getElementById('adm-res-all-answers');
  list.innerHTML = '';
  answers.forEach((a) => {
    const li   = document.createElement('li');
    const diff = Math.abs(a.value - correctAnswer);
    const tie  = answers.filter(x => x.rank === a.rank).length > 1 ? '（タイ）' : '';
    li.innerHTML = `
      <span>${a.rank}位${tie} ${escHtml(a.nickname)}</span>
      <span>${a.value}</span>
      <span class="answer-diff">差 ${diff.toFixed(4).replace(/\.?0+$/, '')} +${a.pts}pt</span>
    `;
    list.appendChild(li);
  });
}

// ランキングプレビューを描画する（btnRanking 押下後に呼ぶ）
async function renderRankingPreview() {
  const preview = document.getElementById('admin-preview');
  const resDiv  = document.getElementById('admin-results-preview');
  const rankDiv = document.getElementById('admin-ranking-preview');
  preview.classList.remove('hidden');
  resDiv.classList.add('hidden');
  rankDiv.classList.remove('hidden');

  const participants = await fetchRanking();
  const list = document.getElementById('adm-ranking-list');
  list.innerHTML = '';
  if (!participants.length) {
    list.innerHTML = '<li style="color:#a0aec0;text-align:center">データがありません</li>';
    return;
  }
  participants.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="rank-num">${i + 1}</span>
      <span class="rank-nick">${escHtml(p.nickname)}</span>
      <span class="rank-pts">${p.total_points}pt</span>
    `;
    list.appendChild(li);
  });
}

// ============================================================
// UI 要素への参照
//
// document.getElementById() で HTML の要素を取得して変数に入れておくと
// 後から何度でも使い回せる（毎回検索するより効率的）
// ============================================================
// ============================================================
// 景品 API 関数
// ============================================================

// prizes テーブルから全景品を display_order 昇順で取得する
async function fetchPrizes() {
  return apiFetch('/rest/v1/prizes?select=*&order=display_order.asc') ?? [];
}

// prizes テーブルを全件削除する（「景品選択を開始する」押下時に既存データをリセット）
async function deleteAllPrizes() {
  // id=not.is.null → 「id が null でない行すべて」= 全件削除
  // bigint・UUID どちらの型でも動作する
  await apiFetch('/rest/v1/prizes?id=not.is.null', {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}

// 景品名の配列を prizes テーブルに一括 INSERT する
async function insertPrizes(names) {
  const rows = names.map((name, i) => ({
    name,
    display_order: i + 1,
    is_taken: false,
    taken_by: null,
  }));
  await apiFetch('/rest/v1/prizes', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify(rows),
  });
}

// 指定した景品を「取得済み」に更新する
async function updatePrizeTaken(id, takenBy) {
  await apiFetch(`/rest/v1/prizes?id=eq.${id}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_taken: true, taken_by: takenBy }),
  });
}

const phaseBadge = document.getElementById('phase-badge');
const statusQ    = document.getElementById('status-q');
const btnOpen    = document.getElementById('btn-open');
const btnClose   = document.getElementById('btn-close');
const btnResults = document.getElementById('btn-results');
const btnRanking = document.getElementById('btn-ranking');
const btnPrizes  = document.getElementById('btn-prizes');
const btnNext    = document.getElementById('btn-next');
const adminMsg   = document.getElementById('admin-msg');
const qList      = document.getElementById('q-list');

let currentState    = null;
let selectedNum     = null;
let selectedText    = null;
let selectedCorrect = null;

// 現在の全問題行を取得（動的に増減するので都度取得する）
function getQItems() { return [...qList.querySelectorAll('.q-item')]; }

// ============================================================
// 状態を画面に反映する
// ============================================================
const PHASE_LABELS = {
  waiting: '待機中', open: '受付中', closed: '締切済',
  results: '結果表示中', ranking: 'ランキング表示中', prizes: '景品選択中',
};

function applyState(state) {
  currentState = state;
  const phase  = state.phase;
  phaseBadge.textContent = PHASE_LABELS[phase] ?? phase;
  phaseBadge.className   = `phase-badge phase-${phase}`;
  statusQ.textContent    = state.question_number ? `Q${state.question_number}` : '問題未選択';
  getQItems().forEach((el) => el.classList.toggle('active', Number(el.dataset.num) === state.question_number));
  btnOpen.disabled    = selectedNum === null || !selectedText || selectedCorrect === null || phase === 'open';
  btnClose.disabled   = phase !== 'open';
  btnResults.disabled = phase !== 'closed';
  btnRanking.disabled = phase !== 'results';
  // ranking または prizes フェーズのときだけ「景品選択を開始する」を押せる
  btnPrizes.disabled  = phase !== 'ranking' && phase !== 'prizes';
  btnNext.disabled    = phase === 'waiting' || phase === 'open';
  // prizes フェーズのときだけ管理者景品グリッドを表示する
  document.getElementById('admin-prize-section').classList.toggle('hidden', phase !== 'prizes');
}

function setMsg(text) { adminMsg.textContent = text; }

function setAllButtonsDisabled(val) {
  [btnOpen, btnClose, btnResults, btnRanking, btnPrizes, btnNext].forEach((b) => b.disabled = val);
}

// ============================================================
// 問題の動的追加・削除
// ============================================================

// 選択中の問題から問題文・正解を読み取るヘルパー
function readSelectedInputs(item) {
  selectedText    = item.querySelector('.q-text-input')?.value.trim() || null;
  const rawVal    = item.querySelector('.correct-val')?.value.trim();
  selectedCorrect = rawVal !== '' && !isNaN(Number(rawVal)) ? Number(rawVal) : null;
}

function selectedMsg() {
  if (!selectedText)    return `Q${selectedNum} を選択（問題文を入力してください）`;
  if (!selectedCorrect) return `Q${selectedNum} を選択（正解の値を入力してください）`;
  return `Q${selectedNum} を選択（問題文・正解入力済み）`;
}

// 問題番号バッジと data-num を 1 から振り直す
function renumberQuestions() {
  getQItems().forEach((el, i) => {
    const n = i + 1;
    el.dataset.num = n;
    el.querySelector('.q-num-badge').textContent = n;
    // 選択中の問題が番号変更で追えなくなるのを防ぐ
    if (el.classList.contains('active')) selectedNum = n;
  });
}

// 問題行を1つ生成して q-list に追加し、イベントも登録する
function addQuestion() {
  const num  = getQItems().length + 1;
  const item = document.createElement('li');
  item.className    = 'q-item';
  item.dataset.num  = num;
  item.innerHTML = `
    <div class="q-item-top">
      <span class="q-num-badge">${num}</span>
      <input type="text" class="q-text-input" placeholder="問題文を入力してください" />
      <button type="button" class="btn-delete-question" title="この問題を削除">✕</button>
    </div>
    <div class="correct-input-wrap">
      <label>正解：</label>
      <input type="number" class="correct-val" step="any" placeholder="数値" />
    </div>
  `;

  // li 全体クリック → 選択
  item.addEventListener('click', () => {
    getQItems().forEach((el) => el.classList.remove('active'));
    item.classList.add('active');
    selectedNum = Number(item.dataset.num);
    readSelectedInputs(item);
    applyState(currentState);
    setMsg(selectedMsg());
  });

  // 問題文・正解入力 → リアルタイム反映
  item.querySelector('.q-text-input').addEventListener('input', () => {
    if (selectedNum !== Number(item.dataset.num)) return;
    readSelectedInputs(item);
    applyState(currentState);
    setMsg(selectedMsg());
  });
  item.querySelector('.correct-val').addEventListener('input', () => {
    if (selectedNum !== Number(item.dataset.num)) return;
    readSelectedInputs(item);
    applyState(currentState);
    setMsg(selectedMsg());
  });

  // 削除ボタン
  item.querySelector('.btn-delete-question').addEventListener('click', (e) => {
    e.stopPropagation(); // li のクリックイベントへ伝播しないようにする
    if (getQItems().length <= 1) { setMsg('問題は最低1つ必要です。'); return; }
    if (selectedNum === Number(item.dataset.num)) {
      // 削除する問題が選択中の場合は選択を解除する
      selectedNum = null; selectedText = null; selectedCorrect = null;
    }
    item.remove();
    renumberQuestions();
    applyState(currentState);
    setMsg('問題を削除しました。');
  });

  qList.appendChild(item);
}

// 「問題を追加する」ボタン
document.getElementById('btn-add-question').addEventListener('click', () => {
  addQuestion();
  setMsg(`Q${getQItems().length} を追加しました。問題文と正解を入力してください。`);
});

// 初期表示：4問を生成する
for (let i = 0; i < 4; i++) addQuestion();

// ============================================================
// ボタンイベント
// ============================================================

// 「回答を開始する」→ quiz_state を open フェーズに更新
// 参加者画面が Realtime で変化を受け取り、自動で回答フォームに切り替わる
btnOpen.addEventListener('click', async () => {
  if (selectedNum === null || selectedCorrect === null) return;
  setAllButtonsDisabled(true);
  setMsg('開始中…');
  try {
    await patchQuizState({
      question_number: selectedNum,
      question_text:   selectedText,
      correct_answer:  selectedCorrect,
      is_open:         true,
      phase:           'open',
    });
    setMsg(`Q${selectedNum} の回答受付を開始しました。`);
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// 「回答を締め切る」→ quiz_state を closed フェーズに更新
btnClose.addEventListener('click', async () => {
  setAllButtonsDisabled(true);
  setMsg('締め切り中…');
  try {
    await patchQuizState({ is_open: false, phase: 'closed' });
    setMsg('回答を締め切りました。「結果を表示」でポイント集計できます。');
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// 「回答結果を表示する」→ ポイントを集計して results フェーズへ
// 1位: 参加者数pt、2位: 参加者数-1pt、…最下位: 1pt（全員にポイント付与）
btnResults.addEventListener('click', async () => {
  setAllButtonsDisabled(true);
  setMsg('ポイントを集計中…');
  try {
    const state   = await fetchQuizState();
    const correct = state.correct_answer;
    const qNum    = state.question_number;

    // 今日の回答を全件取得（最新の回答が先頭）
    const raw  = await fetchAnswers(qNum);

    // 参加者ごとに最初の行（＝最後に送信した回答）だけ残す
    const seen = new Set();
    const answers = raw.filter((a) => {
      if (seen.has(a.participant_id)) return false;
      seen.add(a.participant_id); return true;
    });

    // 正解との差が小さい順にソート
    answers.sort((a, b) => Math.abs(a.value - correct) - Math.abs(b.value - correct));

    // タイを考慮したランク・ポイント付与
    // 差が等しい参加者は同順位・同ポイントにする
    // 例）5人中 2位タイが2人 → 両者に 4pt（2位相当）を付与し、次の人は 4位（2pt）
    const total = answers.length;
    assignRanksAndPoints(answers, correct, total);

    for (const a of answers) {
      const p = await fetchParticipant(a.participant_id);
      await Promise.all([
        patchAnswerPoints(a.id, a.pts),
        patchParticipantPoints(a.participant_id, (p?.total_points ?? 0) + a.pts),
      ]);
    }

    await patchQuizState({ phase: 'results' });
    setMsg('集計完了！参加者画面に結果を表示しました。');
    applyState(await fetchQuizState());
    renderResultsPreview(answers, correct);
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// 「総合ランキングを表示する」→ ranking フェーズへ
btnRanking.addEventListener('click', async () => {
  setAllButtonsDisabled(true);
  setMsg('ランキングを表示中…');
  try {
    await patchQuizState({ phase: 'ranking' });
    setMsg('ランキングを表示しました。');
    applyState(await fetchQuizState());
    await renderRankingPreview();
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// 管理者の景品グリッドを描画する（prizes フェーズ中に呼ぶ）
// 景品をクリックすると「取得済み」にしてグリッドを再描画する
async function renderAdminPrizeGrid() {
  const prizes = await fetchPrizes();
  const grid   = document.getElementById('admin-prize-grid');
  grid.innerHTML = '';
  prizes.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'prize-item' + (p.is_taken ? ' taken' : '');
    card.innerHTML = `
      <span>${escHtml(p.name)}</span>
      ${p.is_taken ? `<span class="prize-taken-by">✓ ${escHtml(p.taken_by ?? '')}</span>` : ''}
    `;
    if (!p.is_taken) {
      card.addEventListener('click', async () => {
        // 取得したテーブル番号を入力してもらう
        const who = prompt(`「${p.name}」を取得するテーブル番号を入力してください。`);
        if (who === null || who.trim() === '') return; // キャンセルまたは空は無視
        try {
          await updatePrizeTaken(p.id, who.trim());
          await renderAdminPrizeGrid(); // グリッドを再描画
        } catch (err) {
          setMsg('エラー：' + err.message);
        }
      });
    }
    grid.appendChild(card);
  });
}

// 「景品選択を開始する」→ 景品を DB に保存して prizes フェーズへ
btnPrizes.addEventListener('click', async () => {
  // 景品設定パネルの入力欄から景品名を収集する
  const names = [...document.querySelectorAll('.prize-setup-row input')]
    .map(el => el.value.trim())
    .filter(Boolean); // 空文字は除外
  if (!names.length) {
    setMsg('景品リストが空です。景品リスト設定で景品を追加してください。');
    return;
  }
  setAllButtonsDisabled(true);
  setMsg('景品データを保存中…');
  try {
    await deleteAllPrizes();    // 既存の景品を全削除（前回の残りを消す）
    await insertPrizes(names);  // 新しい景品を登録
    await patchQuizState({ phase: 'prizes' });
    setMsg('景品選択を開始しました。');
    applyState(await fetchQuizState());
    await renderAdminPrizeGrid();
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// 「次の問題へ（待機中に戻す）」→ waiting フェーズへリセット
btnNext.addEventListener('click', async () => {
  setAllButtonsDisabled(true);
  setMsg('待機中に戻しています…');
  try {
    await patchQuizState({
      question_number: 0,
      question_text:   '',
      correct_answer:  null,
      is_open:         false,
      phase:           'waiting',
    });
    // 選択状態もリセット
    selectedNum = null; selectedText = null; selectedCorrect = null;
    getQItems().forEach((el) => el.classList.remove('active'));
    setMsg('待機中に戻しました。次の問題を選択してください。');
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// ============================================================
// 問題メモ機能
//
// メモは localStorage の 'quiz_admin_memos' キーに JSON 配列で保存する。
// GitHub には一切アップロードされない。
// ============================================================
const MEMO_KEY = 'quiz_admin_memos';

// localStorage からメモ一覧を読み込む
function loadMemos() {
  try { return JSON.parse(localStorage.getItem(MEMO_KEY)) ?? []; }
  catch { return []; }
}

// メモ一覧を localStorage に書き込む
function saveMemos() {
  const texts = [...document.querySelectorAll('.memo-textarea')]
    .map(el => el.value);
  localStorage.setItem(MEMO_KEY, JSON.stringify(texts));
}

// メモ行を1つ生成して memo-list に追加する
function addMemo(text = '') {
  const memoList = document.getElementById('memo-list');
  const row = document.createElement('div');
  row.className = 'memo-row';
  row.innerHTML = `
    <textarea class="memo-textarea" rows="2" placeholder="問題文をここにメモしておく（自動保存・GitHub非公開）">${escHtml(text)}</textarea>
    <div class="memo-actions">
      <button type="button" class="btn-memo-copy">→ 選択中の問題へ</button>
      <button type="button" class="btn-memo-delete">✕</button>
    </div>
  `;

  // 入力のたびに自動保存
  row.querySelector('.memo-textarea').addEventListener('input', saveMemos);

  // 選択中の問題の問題文入力欄にコピーする
  row.querySelector('.btn-memo-copy').addEventListener('click', () => {
    if (selectedNum === null) { setMsg('先に問題を選択してください。'); return; }
    const activeItem = getQItems().find(el => Number(el.dataset.num) === selectedNum);
    if (!activeItem) return;
    const textInput = activeItem.querySelector('.q-text-input');
    textInput.value = row.querySelector('.memo-textarea').value;
    // 入力イベントを手動で発火して selectedText を更新する
    textInput.dispatchEvent(new Event('input'));
    setMsg(`Q${selectedNum} の問題文をメモからコピーしました。`);
  });

  // このメモ行を削除する
  row.querySelector('.btn-memo-delete').addEventListener('click', () => {
    row.remove();
    saveMemos();
  });

  memoList.appendChild(row);
}

// 「メモを追加する」ボタン
document.getElementById('btn-add-memo').addEventListener('click', () => {
  addMemo();
  saveMemos();
});

// ページ読み込み時に保存済みメモを復元する（setupAdminAuth の外で実行してよい）
loadMemos().forEach(text => addMemo(text));
// メモが0件のときは空のメモを1つ表示する
if (loadMemos().length === 0) addMemo();

// ============================================================
// 景品設定パネル（localStorage に自動保存）
//
// 景品名リストは 'quiz_admin_prizes' キーで保存。
// GitHub には一切アップロードされない。
// ============================================================
const PRIZE_KEY = 'quiz_admin_prizes';

// localStorage から景品名リストを読み込む
function loadPrizeSetup() {
  try { return JSON.parse(localStorage.getItem(PRIZE_KEY)) ?? []; }
  catch { return []; }
}

// 景品設定リストを localStorage に保存する
function savePrizeSetup() {
  const names = [...document.querySelectorAll('.prize-setup-row input')]
    .map(el => el.value);
  localStorage.setItem(PRIZE_KEY, JSON.stringify(names));
}

// 景品設定行を1つ生成して prize-setup-list に追加する
function addPrizeItem(text = '') {
  const list = document.getElementById('prize-setup-list');
  const row  = document.createElement('div');
  row.className = 'prize-setup-row';
  row.innerHTML = `
    <input type="text" placeholder="景品名（例：Amazonギフト券 500円）" value="${escHtml(text)}" />
    <button type="button" class="btn-delete-prize" title="削除">✕</button>
  `;
  row.querySelector('input').addEventListener('input', savePrizeSetup);
  row.querySelector('.btn-delete-prize').addEventListener('click', () => {
    row.remove();
    savePrizeSetup();
  });
  list.appendChild(row);
}

// 「景品を追加する」ボタン
document.getElementById('btn-add-prize-item').addEventListener('click', () => {
  addPrizeItem();
  savePrizeSetup();
});

// ページ読み込み時に保存済み景品設定を復元する
const savedPrizes = loadPrizeSetup();
if (savedPrizes.length) {
  savedPrizes.forEach(text => addPrizeItem(text));
} else {
  // 初回は空の行を3つ表示する
  for (let i = 0; i < 3; i++) addPrizeItem();
}

// ============================================================
// 初期化（ログイン後に実行）
//
// setupAdminAuth はコールバック関数を受け取り、
// ログインが確認できたタイミングで呼び出す。
// ============================================================
setupAdminAuth(async () => {
  try {
    const state = await fetchQuizState();
    applyState(state); // 現在の状態を取得して画面に反映
    // prizes フェーズでログインした場合はグリッドも復元する
    if (state?.phase === 'prizes') await renderAdminPrizeGrid();
  } catch (err) {
    setMsg('初期化失敗：' + err.message);
  }
});
