// SUPABASE_URL / SUPABASE_ANON_KEY は config.js で定義されます。
// getAdminToken / adminLogout / setupAdminAuth は auth.js で定義されます。

// ============================================================
// Supabase REST ヘルパー
// ============================================================
function adminHeaders() {
  return {
    'apikey':        SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${getAdminToken()}`,
    'Content-Type':  'application/json',
  };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, {
    ...opts,
    headers: { ...adminHeaders(), ...(opts.headers || {}) },
  });
  if (!res.ok) {
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

async function fetchDraws() {
  return await apiFetch('/rest/v1/draws?select=number&order=drawn_at.asc') ?? [];
}

async function insertDraw(number) {
  await apiFetch('/rest/v1/draws', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ number }),
  });
}

async function deleteAllDraws() {
  await apiFetch('/rest/v1/draws?id=neq.00000000-0000-0000-0000-000000000000', {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}

// ============================================================
// 状態
// ============================================================
const drawnSet = new Set();

// ============================================================
// UI 要素
// ============================================================
const btnDraw   = document.getElementById('btn-draw');
const btnReset  = document.getElementById('btn-reset');
const currentEl = document.getElementById('ba-current-num');
const countEl   = document.getElementById('ba-drawn-count');
const msgEl     = document.getElementById('ba-msg');

// ============================================================
// 番号グリッドの描画
// ============================================================
const COLUMN_COLORS = ['ba-b', 'ba-i', 'ba-n', 'ba-g', 'ba-o'];

function buildGrid() {
  const grid = document.getElementById('ba-num-grid');
  grid.innerHTML = '';
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < 5; col++) {
      const num  = col * 15 + row + 1;
      const cell = document.createElement('div');
      cell.className  = `ba-num-cell ${COLUMN_COLORS[col]}`;
      cell.id         = `ba-cell-${num}`;
      cell.textContent = num;
      grid.appendChild(cell);
    }
  }
}

function markCell(num) {
  document.getElementById(`ba-cell-${num}`)?.classList.add('drawn');
}

function updateCountDisplay() {
  countEl.textContent = `${drawnSet.size} / 75 抽選済み`;
  btnDraw.disabled    = drawnSet.size >= 75;
}

function setCurrentNum(num) { currentEl.textContent = num ?? '—'; }
function setMsg(text)        { msgEl.textContent = text; }

// ============================================================
// 抽選
// ============================================================
async function drawNext() {
  if (drawnSet.size >= 75) return;
  const remaining = [];
  for (let n = 1; n <= 75; n++) if (!drawnSet.has(n)) remaining.push(n);
  const num = remaining[Math.floor(Math.random() * remaining.length)];

  btnDraw.disabled = true;
  setMsg('抽選中…');
  try {
    await insertDraw(num);
    applyDraw(num);
    setMsg('');
  } catch (err) {
    setMsg('エラー：' + err.message);
    btnDraw.disabled = false;
  }
}

function applyDraw(num) {
  drawnSet.add(num);
  markCell(num);
  setCurrentNum(num);
  updateCountDisplay();
  btnDraw.disabled = drawnSet.size >= 75;
}

// ============================================================
// リセット
// ============================================================
btnReset.addEventListener('click', async () => {
  if (!confirm('すべての抽選履歴を削除します。よろしいですか？')) return;
  btnReset.disabled = true;
  btnDraw.disabled  = true;
  setMsg('リセット中…');
  try {
    await deleteAllDraws();
    drawnSet.clear();
    document.querySelectorAll('.ba-num-cell').forEach(c => c.classList.remove('drawn'));
    setCurrentNum(null);
    updateCountDisplay();
    setMsg('リセットしました。');
  } catch (err) {
    setMsg('エラー：' + err.message);
  } finally {
    btnReset.disabled = false;
    btnDraw.disabled  = false;
  }
});

btnDraw.addEventListener('click', drawNext);

// ============================================================
// Realtime（他端末で抽選された場合も同期）
// ============================================================
function subscribeDraws() {
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
          broadcast: { self: false }, presence: { key: '' },
          postgres_changes: [{ event: '*', schema: 'public', table: 'draws' }],
        },
      },
      ref: '1',
    }));
  });

  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event !== 'postgres_changes') return;
    const { eventType, table, record } = msg.payload?.data ?? {};
    if (table !== 'draws') return;
    if (eventType === 'INSERT' && !drawnSet.has(record.number)) applyDraw(record.number);
    if (eventType === 'DELETE') {
      drawnSet.clear();
      document.querySelectorAll('.ba-num-cell').forEach(c => c.classList.remove('drawn'));
      setCurrentNum(null);
      updateCountDisplay();
    }
  });

  ws.addEventListener('close', () => setTimeout(subscribeDraws, 3000));
}

// ============================================================
// 初期化（ログイン後に実行）
// ============================================================
setupAdminAuth(async () => {
  buildGrid();
  try {
    const draws = await fetchDraws();
    let lastNum = null;
    for (const { number } of draws) {
      drawnSet.add(number);
      markCell(number);
      lastNum = number;
    }
    if (lastNum !== null) setCurrentNum(lastNum);
    updateCountDisplay();
  } catch (err) {
    setMsg('読み込みエラー：' + err.message);
  }
  subscribeDraws();
});
