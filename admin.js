// SUPABASE_URL / SUPABASE_ANON_KEY は config.js（ビルド時生成）で定義されます。
// ローカル開発時は config.local.js を作成して読み込んでください（.gitignore 済み）。

const BASE_HEADERS = {
  'apikey':        SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type':  'application/json',
};

// ============================================================
// Supabase REST ヘルパー
// ============================================================
async function apiFetch(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: { ...BASE_HEADERS, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fetchQuizState() {
  const rows = await apiFetch('/rest/v1/quiz_state?id=eq.1&select=*');
  return rows?.[0] ?? null;
}

async function patchQuizState(patch) {
  await apiFetch('/rest/v1/quiz_state?id=eq.1', {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

function todayStartISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function fetchAnswers(questionNumber) {
  return apiFetch(
    `/rest/v1/answers?question_number=eq.${questionNumber}&submitted_at=gte.${todayStartISO()}&select=id,participant_id,nickname,value&order=submitted_at.desc`
  );
}

async function patchAnswerPoints(answerId, points) {
  await apiFetch(`/rest/v1/answers?id=eq.${answerId}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ points_earned: points }),
  });
}

async function fetchParticipant(id) {
  const rows = await apiFetch(`/rest/v1/participants?id=eq.${encodeURIComponent(id)}&select=total_points`);
  return rows?.[0] ?? null;
}

async function patchParticipantPoints(id, newTotal) {
  await apiFetch(`/rest/v1/participants?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ total_points: newTotal }),
  });
}

// ============================================================
// UI 要素
// ============================================================
const phaseBadge  = document.getElementById('phase-badge');
const statusQ     = document.getElementById('status-q');
const qItems      = document.querySelectorAll('.q-item');
const btnOpen     = document.getElementById('btn-open');
const btnClose    = document.getElementById('btn-close');
const btnResults  = document.getElementById('btn-results');
const btnRanking  = document.getElementById('btn-ranking');
const btnNext     = document.getElementById('btn-next');
const adminMsg    = document.getElementById('admin-msg');

let currentState    = null;
let selectedNum     = null;
let selectedText    = null;
let selectedCorrect = null; // 選択中の問題の正解値

// ============================================================
// 状態を画面に反映
// ============================================================
const PHASE_LABELS = {
  waiting: '待機中',
  open:    '受付中',
  closed:  '締切済',
  results: '結果表示中',
  ranking: 'ランキング表示中',
};

function applyState(state) {
  currentState = state;
  const phase  = state.phase;

  phaseBadge.textContent = PHASE_LABELS[phase] ?? phase;
  phaseBadge.className   = `phase-badge phase-${phase}`;
  statusQ.textContent    = state.question_number ? `Q${state.question_number}` : '問題未選択';

  // 選択済みの問題のハイライト
  qItems.forEach((el) => el.classList.toggle('active', Number(el.dataset.num) === state.question_number));

  // ボタンの有効/無効
  btnOpen.disabled    = selectedNum === null || selectedCorrect === null || phase === 'open';
  btnClose.disabled   = phase !== 'open';
  btnResults.disabled = phase !== 'closed';
  btnRanking.disabled = phase !== 'results';
  btnNext.disabled    = phase === 'waiting' || phase === 'open';
}

function setMsg(text) { adminMsg.textContent = text; }

function setAllButtonsDisabled(val) {
  [btnOpen, btnClose, btnResults, btnRanking, btnNext].forEach((b) => b.disabled = val);
}

// ============================================================
// 問題クリック → 選択
// ============================================================
qItems.forEach((item) => {
  item.addEventListener('click', () => {
    qItems.forEach((el) => el.classList.remove('active'));
    item.classList.add('active');

    selectedNum  = Number(item.dataset.num);
    selectedText = item.dataset.text;

    const input  = item.querySelector('.correct-val');
    const rawVal = input?.value.trim();
    selectedCorrect = rawVal !== '' && !isNaN(Number(rawVal)) ? Number(rawVal) : null;

    applyState(currentState);
    setMsg(selectedCorrect !== null
      ? `Q${selectedNum} を選択（正解：${selectedCorrect}）`
      : `Q${selectedNum} を選択（正解の値を入力してください）`
    );
  });

  // 正解入力欄が変わったとき選択中なら更新
  const input = item.querySelector('.correct-val');
  input?.addEventListener('input', () => {
    if (selectedNum !== Number(item.dataset.num)) return;
    const val = input.value.trim();
    selectedCorrect = val !== '' && !isNaN(Number(val)) ? Number(val) : null;
    applyState(currentState);
    setMsg(selectedCorrect !== null
      ? `Q${selectedNum} 正解：${selectedCorrect}`
      : 'Q${selectedNum} 正解の値を入力してください'
    );
  });
});

// ============================================================
// ▶ 回答を開始する
// ============================================================
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

// ============================================================
// ■ 回答を締め切る
// ============================================================
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

// ============================================================
// 📊 回答結果を表示する（ポイント計算 → phase=results）
// ============================================================
btnResults.addEventListener('click', async () => {
  setAllButtonsDisabled(true);
  setMsg('ポイントを集計中…');

  try {
    const state   = await fetchQuizState();
    const correct = state.correct_answer;
    const qNum    = state.question_number;

    // 全回答を取得、参加者ごとに最初の回答だけ残す
    const raw  = await fetchAnswers(qNum);
    const seen = new Set();
    const answers = raw.filter((a) => {
      if (seen.has(a.participant_id)) return false;
      seen.add(a.participant_id);
      return true;
    });

    // 正解との差でソート
    answers.sort((a, b) => Math.abs(a.value - correct) - Math.abs(b.value - correct));

    // 上位3名にポイント付与（3pt / 2pt / 1pt）
    const ptMap = [3, 2, 1];
    for (let i = 0; i < Math.min(3, answers.length); i++) {
      const a      = answers[i];
      const pts    = ptMap[i];
      const p      = await fetchParticipant(a.participant_id);
      const newTotal = (p?.total_points ?? 0) + pts;

      await Promise.all([
        patchAnswerPoints(a.id, pts),
        patchParticipantPoints(a.participant_id, newTotal),
      ]);
    }

    await patchQuizState({ phase: 'results' });
    setMsg('集計完了！参加者画面に結果を表示しました。');
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// ============================================================
// 🏆 総合ランキングを表示する
// ============================================================
btnRanking.addEventListener('click', async () => {
  setAllButtonsDisabled(true);
  setMsg('ランキングを表示中…');
  try {
    await patchQuizState({ phase: 'ranking' });
    setMsg('ランキングを表示しました。');
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// ============================================================
// ➡ 次の問題へ（待機中に戻す）
// ============================================================
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
    selectedNum     = null;
    selectedText    = null;
    selectedCorrect = null;
    qItems.forEach((el) => el.classList.remove('active'));
    setMsg('待機中に戻しました。次の問題を選択してください。');
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('エラー：' + err.message);
    applyState(await fetchQuizState());
  }
});

// ============================================================
// 初期化
// ============================================================
(async () => {
  try {
    applyState(await fetchQuizState());
  } catch (err) {
    setMsg('初期化失敗：' + err.message);
  }
})();
