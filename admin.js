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
function renderResultsPreview(answers, correctAnswer) {
  const preview = document.getElementById('admin-preview');
  const resDiv  = document.getElementById('admin-results-preview');
  const rankDiv = document.getElementById('admin-ranking-preview');
  preview.classList.remove('hidden');
  resDiv.classList.remove('hidden');
  rankDiv.classList.add('hidden');

  document.getElementById('adm-res-correct').textContent = correctAnswer;

  const medals  = ['🥇', '🥈', '🥉'];
  const total   = answers.length;
  const podium  = document.getElementById('adm-res-podium');
  podium.innerHTML = '';
  answers.slice(0, 3).forEach((a, i) => {
    const div  = document.createElement('div');
    div.className = `podium-item rank-${i + 1}`;
    const diff = Math.abs(a.value - correctAnswer);
    const pts  = total - i;
    div.innerHTML = `
      <span class="podium-medal">${medals[i]}</span>
      <span class="podium-nick">${escHtml(a.nickname)}</span>
      <span class="podium-value">${a.value}（差：${diff.toFixed(4).replace(/\.?0+$/, '')}）</span>
      <span class="podium-pts">+${pts}pt</span>
    `;
    podium.appendChild(div);
  });

  const list = document.getElementById('adm-res-all-answers');
  list.innerHTML = '';
  answers.forEach((a) => {
    const li   = document.createElement('li');
    const diff = Math.abs(a.value - correctAnswer);
    li.innerHTML = `
      <span>${escHtml(a.nickname)}</span>
      <span>${a.value}</span>
      <span class="answer-diff">差 ${diff.toFixed(4).replace(/\.?0+$/, '')}</span>
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
const phaseBadge = document.getElementById('phase-badge'); // フェーズ表示バッジ
const statusQ    = document.getElementById('status-q');    // 「Q1」などの問題番号表示
const qItems     = document.querySelectorAll('.q-item');   // 問題リストの全行
const btnOpen    = document.getElementById('btn-open');    // 「回答を開始する」ボタン
const btnClose   = document.getElementById('btn-close');   // 「回答を締め切る」ボタン
const btnResults = document.getElementById('btn-results'); // 「回答結果を表示する」ボタン
const btnRanking = document.getElementById('btn-ranking'); // 「総合ランキングを表示する」ボタン
const btnNext    = document.getElementById('btn-next');    // 「次の問題へ」ボタン
const adminMsg   = document.getElementById('admin-msg');   // メッセージ表示エリア

let currentState    = null; // 現在の quiz_state（ボタン有効/無効の判定に使う）
let selectedNum     = null; // 選択中の問題番号
let selectedText    = null; // 選択中の問題文
let selectedCorrect = null; // 選択中の問題の正解値

// ============================================================
// 状態を画面に反映する
//
// フェーズに応じてボタンの有効/無効を切り替える。
// 例：「open（受付中）」のとき「回答を開始する」は押せない（すでに開始済み）
// ============================================================
const PHASE_LABELS = {
  waiting: '待機中', open: '受付中', closed: '締切済',
  results: '結果表示中', ranking: 'ランキング表示中',
};

function applyState(state) {
  currentState = state;
  const phase  = state.phase;

  // フェーズバッジのテキストとスタイルを更新
  phaseBadge.textContent = PHASE_LABELS[phase] ?? phase;
  phaseBadge.className   = `phase-badge phase-${phase}`;

  // 現在の問題番号を表示
  statusQ.textContent    = state.question_number ? `Q${state.question_number}` : '問題未選択';

  // 現在進行中の問題をリストでハイライト
  qItems.forEach((el) => el.classList.toggle('active', Number(el.dataset.num) === state.question_number));

  // フェーズと選択状態に応じてボタンの有効/無効を設定
  btnOpen.disabled    = selectedNum === null || selectedCorrect === null || phase === 'open';
  btnClose.disabled   = phase !== 'open';    // 受付中のときだけ締め切れる
  btnResults.disabled = phase !== 'closed';  // 締切済のときだけ結果を表示できる
  btnRanking.disabled = phase !== 'results'; // 結果表示中のときだけランキングを表示できる
  btnNext.disabled    = phase === 'waiting' || phase === 'open'; // 待機中・受付中は次へ進めない
}

function setMsg(text) { adminMsg.textContent = text; }

// すべてのボタンをまとめて有効/無効にする（通信中は操作を止めるために使う）
function setAllButtonsDisabled(val) {
  [btnOpen, btnClose, btnResults, btnRanking, btnNext].forEach((b) => b.disabled = val);
}

// ============================================================
// 問題クリック → 選択
//
// li.q-item をクリックすると「選択中」の問題として扱う。
// data-num, data-text を JS で読み取り、「回答を開始する」ボタンに渡す。
// ============================================================
qItems.forEach((item) => {
  item.addEventListener('click', () => {
    // 全アイテムから active クラスを外して、クリックされたものだけに付ける
    qItems.forEach((el) => el.classList.remove('active'));
    item.classList.add('active');

    selectedNum  = Number(item.dataset.num);
    selectedText = item.dataset.text;

    // 正解入力欄の値を読み取る（空または数値以外なら null にする）
    const input  = item.querySelector('.correct-val');
    const rawVal = input?.value.trim();
    selectedCorrect = rawVal !== '' && !isNaN(Number(rawVal)) ? Number(rawVal) : null;

    applyState(currentState);
    setMsg(selectedCorrect !== null
      ? `Q${selectedNum} を選択（正解：${selectedCorrect}）`
      : `Q${selectedNum} を選択（正解の値を入力してください）`
    );
  });

  // 正解入力欄に値を入力したらリアルタイムで selectedCorrect を更新する
  const input = item.querySelector('.correct-val');
  input?.addEventListener('input', () => {
    if (selectedNum !== Number(item.dataset.num)) return; // 選択中の問題だけ処理
    const val = input.value.trim();
    selectedCorrect = val !== '' && !isNaN(Number(val)) ? Number(val) : null;
    applyState(currentState);
    setMsg(selectedCorrect !== null
      ? `Q${selectedNum} 正解：${selectedCorrect}`
      : `Q${selectedNum} 正解の値を入力してください`
    );
  });
});

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

    // 1位: N pt, 2位: N-1 pt, … 最下位: 1 pt（N = 回答者数）
    const total = answers.length;
    for (let i = 0; i < total; i++) {
      const pts = total - i; // 1位なら total、最下位なら 1
      const a   = answers[i];
      const p   = await fetchParticipant(a.participant_id);
      // 回答のポイント更新 と 参加者の累計ポイント更新 を並行実行
      await Promise.all([
        patchAnswerPoints(a.id, pts),
        patchParticipantPoints(a.participant_id, (p?.total_points ?? 0) + pts),
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
    qItems.forEach((el) => el.classList.remove('active'));
    setMsg('待機中に戻しました。次の問題を選択してください。');
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// ============================================================
// 初期化（ログイン後に実行）
//
// setupAdminAuth はコールバック関数を受け取り、
// ログインが確認できたタイミングで呼び出す。
// ============================================================
setupAdminAuth(async () => {
  try {
    applyState(await fetchQuizState()); // 現在の状態を取得して画面に反映
  } catch (err) {
    setMsg('初期化失敗：' + err.message);
  }
});
