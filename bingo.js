// SUPABASE_URL / SUPABASE_ANON_KEY は config.js で定義されます。

const BASE_HEADERS = {
  'apikey':        SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type':  'application/json',
};

// ============================================================
// 参加者情報（クイズアプリと共有）
// ============================================================
const participantId = localStorage.getItem('quiz_participant_id');
const nickname      = localStorage.getItem('quiz_nickname');

// ============================================================
// ビンゴ定数
// ============================================================
// 各列の数字範囲（標準ビンゴ: B=1-15, I=16-30, N=31-45, G=46-60, O=61-75）
const COLUMNS = [
  { min: 1,  max: 15 },
  { min: 16, max: 30 },
  { min: 31, max: 45 },
  { min: 46, max: 60 },
  { min: 61, max: 75 },
];

// 判定ライン（行・列・対角線）
const LINES = [
  [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24], // 行
  [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24], // 列
  [0,6,12,18,24], [4,8,12,16,20],                                                   // 斜め
];

const FREE_INDEX = 12; // 中央マス

// ============================================================
// カード生成（5×5、行優先で格納）
// ============================================================
function generateNumbers() {
  const nums = [];
  for (const col of COLUMNS) {
    const pool = Array.from({ length: col.max - col.min + 1 }, (_, i) => i + col.min);
    // Fisher-Yates shuffle → 先頭5つを取得
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    nums.push(pool.slice(0, 5)); // 各列5つ
  }
  // 行優先に変換: [row0col0, row0col1, ..., row4col4]
  const card = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      card.push(nums[col][row]);
    }
  }
  return card;
}

function initialMarked() {
  const m = Array(25).fill(false);
  m[FREE_INDEX] = true; // FREE マスは最初からマーク
  return m;
}

// ============================================================
// ビンゴ判定
// ============================================================
function checkStatus(marked) {
  const bingos  = LINES.filter(line => line.every(i => marked[i])).length;
  const reaches = LINES.filter(line =>
    !line.every(i => marked[i]) && line.filter(i => marked[i]).length === 4
  ).length;
  return { bingos, reaches };
}

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

async function fetchMyCard() {
  const rows = await apiFetch(
    `/rest/v1/cards?participant_id=eq.${encodeURIComponent(participantId)}&order=created_at.desc&limit=1`
  );
  return rows?.[0] ?? null;
}

async function saveCard(numbers, marked) {
  const rows = await apiFetch('/rest/v1/cards', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify({ participant_id: participantId, nickname, numbers, marked }),
  });
  return rows?.[0] ?? null;
}

async function updateMarked(cardId, marked) {
  await apiFetch(`/rest/v1/cards?id=eq.${cardId}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ marked }),
  });
}

async function fetchAllDraws() {
  return apiFetch('/rest/v1/draws?select=number&order=drawn_at.asc') ?? [];
}

// ============================================================
// Supabase Realtime（draws テーブルの INSERT を購読）
// ============================================================
function subscribeDraws(onDraw) {
  const wsUrl = SUPABASE_URL.replace('https://', 'wss://')
    + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
    }, 25000);

    ws.send(JSON.stringify({
      topic: 'realtime:public:draws',
      event: 'phx_join',
      payload: {
        config: {
          broadcast: { self: false },
          presence: { key: '' },
          postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'draws' }],
        },
      },
      ref: '1',
    }));
  });

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'postgres_changes' && msg.payload?.data?.table === 'draws') {
      onDraw(msg.payload.data.record.number);
    }
  });

  ws.addEventListener('close', () => setTimeout(() => subscribeDraws(onDraw), 3000));
}

// ============================================================
// UI
// ============================================================
const screens = {
  login:    document.getElementById('bingo-login-screen'),
  generate: document.getElementById('bingo-generate-screen'),
  card:     document.getElementById('bingo-card-screen'),
};

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

// カード状態（グローバル）
let cardId  = null;
let numbers = null; // int[25]
let marked  = null; // bool[25]

// ============================================================
// グリッド描画
// ============================================================
function renderGrid(animate = false, justMarkedIndex = -1) {
  const grid = document.getElementById('bingo-grid');
  grid.innerHTML = '';

  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';
    cell.dataset.index = i;

    if (i === FREE_INDEX) {
      cell.classList.add('free');
      cell.textContent = 'FREE';
    } else {
      cell.textContent = numbers[i];
    }

    if (marked[i]) cell.classList.add('marked');
    if (animate && i === justMarkedIndex) cell.classList.add('just-marked');

    grid.appendChild(cell);
  }
}

function updateStatusBadge() {
  const badge = document.getElementById('bingo-status-badge');
  const { bingos, reaches } = checkStatus(marked);

  if (bingos > 0) {
    badge.textContent  = `🎉 BINGO！（${bingos}ライン）`;
    badge.className    = 'bingo-status-badge bingo';
    badge.classList.remove('hidden');
  } else if (reaches > 0) {
    badge.textContent  = `🔥 リーチ！（${reaches}ライン）`;
    badge.className    = 'bingo-status-badge reach';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function showLastDraw(num) {
  const box = document.getElementById('last-draw-box');
  document.getElementById('last-draw-num').textContent = num;
  box.classList.remove('hidden');
}

// ============================================================
// 抽選番号が来たときの処理
// ============================================================
async function applyDraw(num, save = true) {
  let changed     = false;
  let changedIndex = -1;

  for (let i = 0; i < 25; i++) {
    if (numbers[i] === num && !marked[i]) {
      marked[i]    = true;
      changed       = true;
      changedIndex  = i;
      break;
    }
  }

  showLastDraw(num);

  if (changed) {
    renderGrid(true, changedIndex);
    updateStatusBadge();
    if (save && cardId) await updateMarked(cardId, marked);
  }
}

// ============================================================
// カード生成ボタン
// ============================================================
document.getElementById('btn-generate').addEventListener('click', async () => {
  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = '生成中…';

  numbers = generateNumbers();
  marked  = initialMarked();

  try {
    const saved = await saveCard(numbers, marked);
    cardId = saved.id;
    startCardScreen();
    // 既存の抽選番号をすべて適用
    const draws = await fetchAllDraws();
    for (const { number } of draws) await applyDraw(number, false);
    // まとめて保存
    if (draws.length > 0 && cardId) await updateMarked(cardId, marked);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'カードをランダム生成する';
  }
});

function startCardScreen() {
  document.getElementById('bingo-player-name').textContent = `テーブル：${nickname}`;
  renderGrid();
  updateStatusBadge();
  showScreen('card');
}

// ============================================================
// 初期化
// ============================================================
(async () => {
  if (!participantId || !nickname) {
    showScreen('login');
    return;
  }

  // 既存カードを確認
  try {
    const card = await fetchMyCard();
    if (card) {
      cardId  = card.id;
      numbers = card.numbers;
      marked  = card.marked;
      startCardScreen();
      // 保存後に追加された抽選を反映
      const draws = await fetchAllDraws();
      for (const { number } of draws) await applyDraw(number, false);
      if (cardId) await updateMarked(cardId, marked);
    } else {
      document.getElementById('bingo-nickname-label').textContent = `テーブル：${nickname}`;
      showScreen('generate');
    }
  } catch (err) {
    console.error(err);
    document.getElementById('bingo-nickname-label').textContent = `テーブル：${nickname}`;
    showScreen('generate');
  }

  // Realtime 購読（カードの有無に関わらず開始）
  subscribeDraws((num) => applyDraw(num, true));
})();
