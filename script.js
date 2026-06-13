// SUPABASE_URL / SUPABASE_ANON_KEY は config.js（ビルド時生成）で定義されます。
// ローカル開発時は config.local.js を作成して読み込んでください（.gitignore 済み）。

const BASE_HEADERS = {
  'apikey':        SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type':  'application/json',
};

// ============================================================
// 参加者情報（localStorage に永続化）
// ============================================================
let participantId   = localStorage.getItem('quiz_participant_id');
let nickname        = localStorage.getItem('quiz_nickname');
let submittedAnswer = null; // 現在の問題で送信した値

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
  const rows = await apiFetch(
    '/rest/v1/quiz_state?id=eq.1&select=question_number,question_text,correct_answer,phase'
  );
  return rows?.[0] ?? null;
}

async function upsertParticipant(id, nick) {
  await apiFetch('/rest/v1/participants', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id, nickname: nick, total_points: 0 }),
  });
}

async function insertAnswer(questionNumber, value) {
  await apiFetch('/rest/v1/answers', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      question_number: questionNumber,
      participant_id:  participantId,
      nickname,
      value,
    }),
  });
}

function todayStartISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

async function fetchAnswers(questionNumber) {
  return apiFetch(
    `/rest/v1/answers?question_number=eq.${questionNumber}&submitted_at=gte.${todayStartISO()}&select=participant_id,nickname,value,points_earned&order=submitted_at.desc`
  );
}

async function fetchRanking() {
  return apiFetch('/rest/v1/participants?select=id,nickname,total_points&order=total_points.desc&limit=20');
}

// ============================================================
// Supabase Realtime（quiz_state の変更を購読）
// ============================================================
function subscribeQuizState(onChange) {
  const wsUrl = SUPABASE_URL.replace('https://', 'wss://')
    + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
    }, 25000);

    ws.send(JSON.stringify({
      topic: 'realtime:public:quiz_state',
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { self: false },
          presence: { key: '' },
          postgres_changes: [{ event: '*', schema: 'public', table: 'quiz_state' }],
        },
      },
      ref: '1',
    }));
  });

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'postgres_changes' && msg.payload?.data?.table === 'quiz_state') {
      onChange(msg.payload.data.record);
    }
  });

  ws.addEventListener('close', () => setTimeout(() => subscribeQuizState(onChange), 3000));
}

// ============================================================
// 画面管理
// ============================================================
const SCREENS = ['nickname', 'waiting', 'question', 'submitted', 'closed', 'results', 'ranking'];

function showScreen(name) {
  SCREENS.forEach((s) => {
    document.getElementById(`${s}-screen`).classList.toggle('hidden', s !== name);
  });
}

let currentQuestionNumber = null;

async function applyState(state) {
  if (!state) { showScreen('waiting'); return; }

  const { phase, question_number, question_text, correct_answer } = state;

  // 問題が切り替わったらリセット
  if (question_number !== currentQuestionNumber) {
    currentQuestionNumber = question_number;
    submittedAnswer = null;
    resetAnswerForm();
  }

  switch (phase) {
    case 'waiting':
      showScreen('waiting');
      break;

    case 'open':
      if (submittedAnswer !== null) {
        showScreen('submitted');
      } else {
        document.getElementById('q-number').textContent = question_number;
        document.getElementById('q-text').textContent   = question_text;
        showScreen('question');
      }
      break;

    case 'closed':
      showScreen(submittedAnswer !== null ? 'submitted' : 'closed');
      break;

    case 'results':
      await renderResults(question_number, correct_answer);
      showScreen('results');
      break;

    case 'ranking':
      await renderRanking();
      showScreen('ranking');
      break;

    default:
      showScreen('waiting');
  }

  document.getElementById('waiting-nickname').textContent = nickname ? `参加中：${nickname}` : '';
}

// ============================================================
// ニックネーム登録
// ============================================================
document.getElementById('nickname-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nick = document.getElementById('nickname-input').value.trim();
  if (!nick) return;

  const btn = e.target.querySelector('button');
  btn.disabled = true;

  if (!participantId) participantId = crypto.randomUUID();
  nickname = nick;
  localStorage.setItem('quiz_participant_id', participantId);
  localStorage.setItem('quiz_nickname', nickname);

  try {
    await upsertParticipant(participantId, nickname);
    const state = await fetchQuizState();
    await applyState(state);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
  }
});

// ============================================================
// テーブル番号変更（localStorage をクリアしてニックネーム画面へ）
// ============================================================
document.getElementById('btn-change-nickname').addEventListener('click', () => {
  localStorage.removeItem('quiz_participant_id');
  localStorage.removeItem('quiz_nickname');
  participantId   = null;
  nickname        = null;
  submittedAnswer = null;
  document.getElementById('nickname-input').value = '';
  showScreen('nickname');
});

// ============================================================
// 回答送信
// ============================================================
document.getElementById('answer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = document.getElementById('answer-input').value.trim();
  const msgEl = document.getElementById('answer-message');

  if (raw === '' || isNaN(Number(raw))) {
    msgEl.textContent = '数値を入力してください。';
    msgEl.className = 'message error';
    return;
  }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  msgEl.textContent = '送信中…';
  msgEl.className = 'message';

  try {
    await insertAnswer(currentQuestionNumber, Number(raw));
    submittedAnswer = Number(raw);
    showScreen('submitted');
  } catch (err) {
    console.error(err);
    msgEl.textContent = '送信に失敗しました。もう一度お試しください。';
    msgEl.className = 'message error';
    btn.disabled = false;
  }
});

function resetAnswerForm() {
  document.getElementById('answer-input').value = '';
  document.getElementById('answer-message').textContent = '';
  document.getElementById('answer-message').className = 'message';
  document.getElementById('submit-btn').disabled = false;
}

// ============================================================
// 結果画面のレンダリング
// ============================================================
async function renderResults(questionNumber, correctAnswer) {
  document.getElementById('res-q-number').textContent = questionNumber;
  document.getElementById('res-correct').textContent  = correctAnswer;

  const raw     = await fetchAnswers(questionNumber);
  // 参加者ごとに最初の回答だけ残す
  const seen    = new Set();
  const answers = raw.filter((a) => {
    if (seen.has(a.participant_id)) return false;
    seen.add(a.participant_id);
    return true;
  });
  // 正解との差順にソート
  answers.sort((a, b) => Math.abs(a.value - correctAnswer) - Math.abs(b.value - correctAnswer));

  // 表彰台（上位3名）
  const medals  = ['🥇', '🥈', '🥉'];
  const ptLabels = ['+3pt', '+2pt', '+1pt'];
  const podium  = document.getElementById('res-podium');
  podium.innerHTML = '';
  answers.slice(0, 3).forEach((a, i) => {
    const div = document.createElement('div');
    div.className = `podium-item rank-${i + 1}`;
    const diff = Math.abs(a.value - correctAnswer);
    div.innerHTML = `
      <span class="podium-medal">${medals[i]}</span>
      <span class="podium-nick">${escHtml(a.nickname)}</span>
      <span class="podium-value">${a.value}（差：${diff.toFixed(4).replace(/\.?0+$/, '')}）</span>
      <span class="podium-pts">${ptLabels[i]}</span>
    `;
    podium.appendChild(div);
  });

  // 自分の回答
  const myBox = document.getElementById('res-my-answer');
  if (submittedAnswer !== null) {
    const myRank = answers.findIndex((a) => a.participant_id === participantId);
    const pts    = myRank === 0 ? 3 : myRank === 1 ? 2 : myRank === 2 ? 1 : 0;
    myBox.textContent = pts > 0
      ? `あなたの回答：${submittedAnswer}　→　${['🥇 1位', '🥈 2位', '🥉 3位'][myRank]}（+${pts}pt）`
      : `あなたの回答：${submittedAnswer}　（${myRank + 1}位）`;
    myBox.classList.remove('hidden');
  } else {
    myBox.classList.add('hidden');
  }

  // 全回答一覧
  const list = document.getElementById('res-all-answers');
  list.innerHTML = '';
  answers.forEach((a) => {
    const li   = document.createElement('li');
    const diff = Math.abs(a.value - correctAnswer);
    const isMe = a.participant_id === participantId;
    if (isMe) li.classList.add('is-me');
    li.innerHTML = `
      <span>${escHtml(a.nickname)}${isMe ? '（自分）' : ''}</span>
      <span>${a.value}</span>
      <span class="answer-diff">差 ${diff.toFixed(4).replace(/\.?0+$/, '')}</span>
    `;
    list.appendChild(li);
  });
}

// ============================================================
// ランキング画面のレンダリング
// ============================================================
async function renderRanking() {
  const participants = await fetchRanking();
  const list = document.getElementById('ranking-list');
  list.innerHTML = '';

  if (!participants.length) {
    list.innerHTML = '<li style="color:#a0aec0;text-align:center">データがありません</li>';
    return;
  }

  participants.forEach((p, i) => {
    const li   = document.createElement('li');
    const isMe = p.id === participantId;
    li.innerHTML = `
      <span class="rank-num">${i + 1}</span>
      <span class="rank-nick">${escHtml(p.nickname)}${isMe ? ' <span class="rank-me-badge">自分</span>' : ''}</span>
      <span class="rank-pts">${p.total_points}pt</span>
    `;
    list.appendChild(li);
  });
}

// ============================================================
// ユーティリティ
// ============================================================
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// 初期化
// ============================================================
(async () => {
  if (!participantId || !nickname) {
    showScreen('nickname');
    return;
  }
  try {
    const state = await fetchQuizState();
    await applyState(state);
  } catch {
    showScreen('waiting');
  }
  subscribeQuizState((record) => applyState(record));
})();
