// ============================================================
// クイズ参加者画面（index.html）の動作ロジック
//
// SUPABASE_URL / SUPABASE_ANON_KEY は config.js（ビルド時自動生成）で定義される。
// ローカル開発時は config.local.js を作成して読み込む（.gitignore 済み）。
// ============================================================

// Supabase への API リクエストに必要な共通ヘッダー
// apikey: 誰でも使えるキー（公開しても問題ない読み取り専用の識別子）
// Authorization: Bearer の後に同じキーを渡すことで anon ロールで認証する
const BASE_HEADERS = {
  'apikey':        SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type':  'application/json',
};

// ============================================================
// 参加者情報（localStorage に永続化）
//
// localStorage はブラウザに情報を保存する仕組み。
// ページを閉じても消えないので、再アクセス時に同じ参加者として復元できる。
// ============================================================
let participantId   = localStorage.getItem('quiz_participant_id'); // ランダムなUUID（内部管理用）
let nickname        = localStorage.getItem('quiz_nickname');       // テーブル番号（表示用）
let submittedAnswer = null; // 現在の問題で送信した値（null = まだ未回答）

// ============================================================
// Supabase REST API ヘルパー関数
//
// fetch() はブラウザ内蔵の HTTP 通信関数。
// async/await を使って非同期処理（通信の完了を待つ）を書きやすくしている。
// ============================================================
async function apiFetch(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...opts, // opts の内容をここに展開（メソッドや body など）
    headers: { ...BASE_HEADERS, ...(opts.headers || {}) }, // 共通ヘッダー＋追加ヘッダーをマージ
  });
  if (!res.ok) {
    // HTTP エラー（4xx / 5xx）のとき例外を投げる
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  // レスポンスボディをテキストで取得し、中身があれば JSON に変換して返す
  // （Supabase は INSERT 成功時に空ボディを返すことがあるため res.json() を直接使わない）
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// quiz_state テーブルから現在のクイズ状態を取得する
// id=1 の行が常に「現在の状態」を表す唯一の行
async function fetchQuizState() {
  const rows = await apiFetch(
    '/rest/v1/quiz_state?id=eq.1&select=question_number,question_text,correct_answer,phase'
  );
  return rows?.[0] ?? null; // 配列の先頭を返す。なければ null
}

// participants テーブルに参加者情報を登録（すでに存在すれば更新しない）
// resolution=merge-duplicates: 同じ id が既にあれば何もしない
async function upsertParticipant(id, nick) {
  await apiFetch('/rest/v1/participants', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id, nickname: nick, total_points: 0 }),
  });
}

// answers テーブルに回答を INSERT する
// 同じ参加者が複数回送信した場合、最後の行をポイント計算に使う（admin.js 側で制御）
async function insertAnswer(questionNumber, value) {
  await apiFetch('/rest/v1/answers', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' }, // レスポンスボディ不要（軽量化）
    body: JSON.stringify({
      question_number: questionNumber,
      participant_id:  participantId,
      nickname,
      value,
    }),
  });
}

// 今日の 0:00:00 を ISO8601 形式で返す（例："2025-06-01T00:00:00.000Z"）
// DB のフィルターに使い、前日以前のテストデータを除外する
function todayStartISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// 指定した問題番号の今日の回答一覧を取得する
// order=submitted_at.desc: 新しい回答が先に来る（重複排除のため）
async function fetchAnswers(questionNumber) {
  return apiFetch(
    `/rest/v1/answers?question_number=eq.${questionNumber}&submitted_at=gte.${todayStartISO()}&select=participant_id,nickname,value,points_earned&order=submitted_at.desc`
  );
}

// 今日の総合ランキングを計算して返す
// participants テーブルは累積なので、answers テーブルから当日分を集計し直す
async function fetchRanking() {
  const rows = await apiFetch(
    `/rest/v1/answers?submitted_at=gte.${todayStartISO()}&select=participant_id,nickname,points_earned`
  ) ?? [];

  // Map を使って参加者ごとに合計ポイントを集める
  // Map: キーと値のペアを管理するデータ構造（オブジェクトの高機能版）
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.participant_id)) {
      map.set(row.participant_id, { id: row.participant_id, nickname: row.nickname, total_points: 0 });
    }
    map.get(row.participant_id).total_points += row.points_earned;
  }
  // ポイント降順にソートして上位 20 名を返す
  return [...map.values()].sort((a, b) => b.total_points - a.total_points).slice(0, 20);
}

// ============================================================
// Supabase Realtime（リアルタイム更新の購読）
//
// WebSocket: ブラウザとサーバーが常時接続し、サーバー側の変化を
// 即座にブラウザへ通知する仕組み（ページの自動更新に使う）。
// quiz_state テーブルの変更を受け取るたびに onChange を呼び出す。
// ============================================================
function subscribeQuizState(onChange) {
  // https:// を wss:// に変換して WebSocket 接続先 URL を作る
  const wsUrl = SUPABASE_URL.replace('https://', 'wss://')
    + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    // 接続が切れないよう 25 秒ごとに「生存確認」を送る（ハートビート）
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
    }, 25000);

    // quiz_state テーブルのすべての変更イベントを購読する
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
    // quiz_state の変更通知だけを処理する
    if (msg.event === 'postgres_changes' && msg.payload?.data?.table === 'quiz_state') {
      onChange(msg.payload.data.record); // 変更後のレコードを渡す
    }
  });

  // 接続が切れたら 3 秒後に再接続する
  ws.addEventListener('close', () => setTimeout(() => subscribeQuizState(onChange), 3000));
}

// ============================================================
// 画面管理
//
// 7 つの画面（screen）を定義し、showScreen(名前) で切り替える。
// "hidden" クラスが付いていると display:none で非表示になる（style.css 参照）。
// ============================================================
const SCREENS = ['nickname', 'waiting', 'question', 'submitted', 'closed', 'results', 'ranking'];

function showScreen(name) {
  SCREENS.forEach((s) => {
    // 指定した名前と一致する画面だけ表示し、他は hidden にする
    document.getElementById(`${s}-screen`).classList.toggle('hidden', s !== name);
  });
}

let currentQuestionNumber = null; // 現在表示中の問題番号

// quiz_state の内容をもとに適切な画面を表示する
async function applyState(state) {
  if (!state) { showScreen('waiting'); return; }

  const { phase, question_number, question_text, correct_answer } = state;

  // 問題が切り替わったら回答状態をリセットする
  if (question_number !== currentQuestionNumber) {
    currentQuestionNumber = question_number;
    submittedAnswer = null;
    resetAnswerForm();
  }

  // フェーズ（状態）に応じて画面を切り替える
  switch (phase) {
    case 'waiting': // 出題者が次の問題を選んでいる
      showScreen('waiting');
      break;

    case 'open': // 回答受付中
      if (submittedAnswer !== null) {
        showScreen('submitted'); // すでに回答済み
      } else {
        document.getElementById('q-number').textContent = question_number;
        document.getElementById('q-text').textContent   = question_text;
        showScreen('question'); // 回答フォームを表示
      }
      break;

    case 'closed': // 回答締め切り済み
      showScreen(submittedAnswer !== null ? 'submitted' : 'closed');
      break;

    case 'results': // 結果発表
      await renderResults(question_number, correct_answer);
      showScreen('results');
      break;

    case 'ranking': // 総合ランキング
      await renderRanking();
      showScreen('ranking');
      break;

    default:
      showScreen('waiting');
  }

  // 待機画面にテーブル番号を表示する
  document.getElementById('waiting-nickname').textContent = nickname ? `参加中：${nickname}` : '';
}

// ============================================================
// ニックネーム（テーブル番号）登録
// ============================================================
document.getElementById('nickname-form').addEventListener('submit', async (e) => {
  e.preventDefault(); // フォームのデフォルト送信（ページリロード）を止める
  const nick = document.getElementById('nickname-input').value.trim();
  if (!nick) return;

  const btn = e.target.querySelector('button');
  btn.disabled = true; // 二重送信を防ぐ

  // 初回のみ UUID を生成してローカルに保存する
  if (!participantId) participantId = crypto.randomUUID();
  nickname = nick;
  localStorage.setItem('quiz_participant_id', participantId);
  localStorage.setItem('quiz_nickname', nickname);

  try {
    await upsertParticipant(participantId, nickname); // DB に参加者登録
    const state = await fetchQuizState();             // 現在のクイズ状態を取得
    await applyState(state);                          // 適切な画面へ遷移
  } catch (err) {
    console.error(err);
    btn.disabled = false;
  }
});

// ============================================================
// 回答送信
// ============================================================
document.getElementById('answer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = document.getElementById('answer-input').value.trim();
  const msgEl = document.getElementById('answer-message');

  // 入力値のバリデーション（空または数値以外は弾く）
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
    await insertAnswer(currentQuestionNumber, Number(raw)); // DB に回答を保存
    submittedAnswer = Number(raw);
    showScreen('submitted');
  } catch (err) {
    console.error(err);
    msgEl.textContent = '送信に失敗しました。もう一度お試しください。';
    msgEl.className = 'message error';
    btn.disabled = false;
  }
});

// 回答フォームを初期状態に戻す（問題が変わったときに呼ぶ）
function resetAnswerForm() {
  document.getElementById('answer-input').value = '';
  document.getElementById('answer-message').textContent = '';
  document.getElementById('answer-message').className = 'message';
  document.getElementById('submit-btn').disabled = false;
}

// ============================================================
// 結果画面のレンダリング
//
// 全回答を取得して「正解との差」でソートし、上位3名に表彰台を表示する。
// 同じ参加者が複数回回答した場合は最後の回答（desc 順の先頭）のみ使う。
// ============================================================
async function renderResults(questionNumber, correctAnswer) {
  document.getElementById('res-q-number').textContent = questionNumber;
  document.getElementById('res-correct').textContent  = correctAnswer;

  const raw  = await fetchAnswers(questionNumber);

  // 参加者ごとに最初に現れた行（＝最新の回答）だけを残す重複排除
  const seen    = new Set();
  const answers = raw.filter((a) => {
    if (seen.has(a.participant_id)) return false;
    seen.add(a.participant_id);
    return true;
  });

  // 正解との差が小さい順にソート
  answers.sort((a, b) => Math.abs(a.value - correctAnswer) - Math.abs(b.value - correctAnswer));

  // タイを考慮したランク・ポイント付与（admin.js と同じロジック）
  const total = answers.length;
  let idx = 0;
  while (idx < total) {
    const diff = Math.abs(answers[idx].value - correctAnswer);
    let end = idx;
    while (end < total && Math.abs(answers[end].value - correctAnswer) === diff) end++;
    const rank = idx + 1;
    const pts  = total - idx;
    for (let k = idx; k < end; k++) { answers[k].rank = rank; answers[k].pts = pts; }
    idx = end;
  }

  // 表彰台（rank 1〜3 に該当する人を全員表示）
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const podium = document.getElementById('res-podium');
  podium.innerHTML = '';
  answers.filter(a => a.rank <= 3).forEach((a) => {
    const div = document.createElement('div');
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

  // 自分の回答と獲得ポイントを表示
  const myBox = document.getElementById('res-my-answer');
  if (submittedAnswer !== null) {
    const me = answers.find((a) => a.participant_id === participantId);
    if (me) {
      const tie       = answers.filter(x => x.rank === me.rank).length > 1 ? 'タイ ' : '';
      const medalLabel = MEDAL[me.rank] ? `${MEDAL[me.rank]} ` : '';
      myBox.textContent = `あなたの回答：${submittedAnswer}　→　${medalLabel}${tie}${me.rank}位（+${me.pts}pt）`;
      myBox.classList.remove('hidden');
    } else {
      myBox.classList.add('hidden');
    }
  } else {
    myBox.classList.add('hidden');
  }

  // 全回答一覧を生成
  const list = document.getElementById('res-all-answers');
  list.innerHTML = '';
  answers.forEach((a) => {
    const li   = document.createElement('li');
    const diff = Math.abs(a.value - correctAnswer);
    const isMe = a.participant_id === participantId;
    const tie  = answers.filter(x => x.rank === a.rank).length > 1 ? '（タイ）' : '';
    if (isMe) li.classList.add('is-me');
    li.innerHTML = `
      <span>${a.rank}位${tie} ${escHtml(a.nickname)}${isMe ? '（自分）' : ''}</span>
      <span>${a.value}</span>
      <span class="answer-diff">差 ${diff.toFixed(4).replace(/\.?0+$/, '')} +${a.pts}pt</span>
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

// XSS（クロスサイトスクリプティング）対策：
// ユーザー入力の文字列を HTML として解釈させないようにエスケープする。
// 例：<script> → &lt;script&gt; として無害化する
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// 初期化（ページ読み込み時に実行）
//
// (async () => { ... })() は「即時実行の非同期関数」。
// await を使いたいので async 関数にしている。
// ============================================================
(async () => {
  // URL に ?reset が付いていたら localStorage をクリアして入力画面へ
  // 例：https://example.com/?reset でアクセスするとテーブル番号からやり直せる
  if (new URLSearchParams(location.search).has('reset')) {
    localStorage.removeItem('quiz_participant_id');
    localStorage.removeItem('quiz_nickname');
    participantId = null;
    nickname      = null;
    // ブラウザの履歴を書き換えて URL から ?reset を消す（リロード時に再実行されないよう）
    history.replaceState(null, '', location.pathname);
  }

  // テーブル番号未入力の場合はニックネーム入力画面を表示して終了
  if (!participantId || !nickname) {
    showScreen('nickname');
    return;
  }

  // 既存参加者の場合：現在のクイズ状態を取得して適切な画面へ遷移
  try {
    const state = await fetchQuizState();
    await applyState(state);
  } catch {
    showScreen('waiting');
  }

  // Realtime 購読を開始：出題者が状態を変えるたびに画面が自動切替わる
  subscribeQuizState((record) => applyState(record));
})();
