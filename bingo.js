// ============================================================
// ビンゴ参加者画面（bingo.html）の動作ロジック
//
// SUPABASE_URL / SUPABASE_ANON_KEY は config.js で定義されます。
// ============================================================

// Supabase への API リクエストに必要な共通ヘッダー
const BASE_HEADERS = {
  'apikey':        SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type':  'application/json',
};

// ============================================================
// 参加者情報（ビンゴ専用 localStorage キー）
//
// クイズ（quiz_participant_id / quiz_nickname）とは別のキーで管理する。
// これにより、クイズとビンゴで別々のテーブル番号を設定できる。
// ============================================================
let participantId = localStorage.getItem('bingo_participant_id');
let nickname      = localStorage.getItem('bingo_nickname');

// ============================================================
// ビンゴカードの定数
//
// 標準的なビンゴカードの列定義：
//   B列: 1〜15、I列: 16〜30、N列: 31〜45、G列: 46〜60、O列: 61〜75
// 各列から5つをランダムに選んで 5×5 のカードを作る。
// ============================================================
const COLUMNS = [
  { min: 1,  max: 15 },
  { min: 16, max: 30 },
  { min: 31, max: 45 },
  { min: 46, max: 60 },
  { min: 61, max: 75 },
];

// ビンゴになる12通りのライン（インデックスで表現）
// カードのマスを左上から右に向かって 0〜24 の番号で管理する：
//   0  1  2  3  4
//   5  6  7  8  9
//  10 11 12 13 14
//  15 16 17 18 19
//  20 21 22 23 24
const LINES = [
  [0,1,2,3,4],         // 1行目（横）
  [5,6,7,8,9],         // 2行目（横）
  [10,11,12,13,14],    // 3行目（横）
  [15,16,17,18,19],    // 4行目（横）
  [20,21,22,23,24],    // 5行目（横）
  [0,5,10,15,20],      // 1列目（縦）B
  [1,6,11,16,21],      // 2列目（縦）I
  [2,7,12,17,22],      // 3列目（縦）N
  [3,8,13,18,23],      // 4列目（縦）G
  [4,9,14,19,24],      // 5列目（縦）O
  [0,6,12,18,24],      // 左上→右下（斜め）
  [4,8,12,16,20],      // 右上→左下（斜め）
];

const FREE_INDEX = 12; // 中央のFREEマスのインデックス

// ============================================================
// カード生成
// ============================================================

// 各列からランダムに5つの数値を選び、5×5 の配列（25要素）を作る
function generateNumbers() {
  const nums = [];
  for (const col of COLUMNS) {
    // その列の全数値を配列にして…
    const pool = Array.from({ length: col.max - col.min + 1 }, (_, i) => i + col.min);
    // Fisher-Yates シャッフルでランダムに並び替えて…
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    nums.push(pool.slice(0, 5)); // 先頭5つを選ぶ
  }
  // nums[列][行] → card[行×5+列] に並び替えて1次元配列にする
  const card = [];
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 5; col++)
      card.push(nums[col][row]);
  return card;
}

// 初期のマーク状態（25マス全て false、中央の FREE だけ true）
function initialMarked() {
  const m = Array(25).fill(false);
  m[FREE_INDEX] = true;
  return m;
}

// ============================================================
// ビンゴ・リーチ判定
// ============================================================

// marked 配列をもとに「何ライン揃っているか」「リーチが何本あるか」を返す
function checkStatus(marked) {
  // every: ライン上の全マスが marked=true ならビンゴ
  const bingos  = LINES.filter(line => line.every(i => marked[i])).length;
  // filter(...).length === 4: 5マス中4マスが marked ならリーチ
  const reaches = LINES.filter(line =>
    !line.every(i => marked[i]) && line.filter(i => marked[i]).length === 4
  ).length;
  return { bingos, reaches };
}

// ============================================================
// Supabase REST API ヘルパー
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

// 自分の最新カードを1件取得する（カードが複数ある場合は最新を使う）
async function fetchMyCard() {
  const rows = await apiFetch(
    `/rest/v1/cards?participant_id=eq.${encodeURIComponent(participantId)}&order=created_at.desc&limit=1`
  );
  return rows?.[0] ?? null;
}

// 新しいカードを DB に保存して、保存結果（id 付き）を返す
async function saveCard(numbers, marked) {
  const rows = await apiFetch('/rest/v1/cards', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' }, // 保存したレコードを返してもらう
    body: JSON.stringify({ participant_id: participantId, nickname, numbers, marked }),
  });
  return rows?.[0] ?? null;
}

// カードのマーク状態を更新する（抽選番号が出るたびに呼ぶ）
async function updateMarked(cardId, marked) {
  await apiFetch(`/rest/v1/cards?id=eq.${cardId}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ marked }),
  });
}

// これまでに抽選されたすべての番号を取得する（カード生成直後のキャッチアップ用）
async function fetchAllDraws() {
  return await apiFetch('/rest/v1/draws?select=number&order=drawn_at.asc') ?? [];
}

// ============================================================
// Supabase Realtime（抽選番号のリアルタイム受信）
//
// 管理者が番号を抽選するたびに draws テーブルに INSERT される。
// WebSocket でその変化を受け取り、カードを自動更新する。
// ============================================================
function subscribeDraws(onDraw) {
  const wsUrl = SUPABASE_URL.replace('https://', 'wss://')
    + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    // 25 秒ごとにハートビート（接続維持のための空メッセージ）を送る
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
    }, 25000);

    // draws テーブルへの INSERT だけを購読する
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
    // draws テーブルへの INSERT 通知を受け取ったら onDraw を呼ぶ
    if (msg.event === 'postgres_changes' && msg.payload?.data?.table === 'draws')
      onDraw(msg.payload.data.record.number);
  });

  // 接続が切れたら 3 秒後に自動再接続
  ws.addEventListener('close', () => setTimeout(() => subscribeDraws(onDraw), 3000));
}

// ============================================================
// 画面管理
//
// bingo-login / bingo-generate / bingo-card の3画面を切り替える
// ============================================================
const screens = {
  login:    document.getElementById('bingo-login-screen'),
  generate: document.getElementById('bingo-generate-screen'),
  card:     document.getElementById('bingo-card-screen'),
};

function showScreen(name) {
  // 指定した名前と一致する画面だけ表示し、他は hidden にする
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

// 現在のカード情報（JS 内で保持）
let cardId  = null; // DB の cards テーブルの id
let numbers = null; // 25マスの数値配列
let marked  = null; // 25マスの true/false 配列

// ============================================================
// グリッド描画
// ============================================================

// numbers と marked をもとにビンゴカードを再描画する
// animate=true のとき、justMarkedIndex のマスにアニメーションを付ける
function renderGrid(animate = false, justMarkedIndex = -1) {
  const grid = document.getElementById('bingo-grid');
  grid.innerHTML = ''; // 一度クリアしてから再生成

  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';

    if (i === FREE_INDEX) {
      cell.classList.add('free');
      cell.textContent = 'FREE';
    } else {
      cell.textContent = numbers[i];
    }

    if (marked[i]) cell.classList.add('marked');           // 済みマスを青くする
    if (animate && i === justMarkedIndex) cell.classList.add('just-marked'); // ポップアニメ
    grid.appendChild(cell);
  }
}

// リーチ・ビンゴ状態バッジを更新する
function updateStatusBadge() {
  const badge = document.getElementById('bingo-status-badge');
  const { bingos, reaches } = checkStatus(marked);

  if (bingos > 0) {
    badge.textContent = `🎉 BINGO！（${bingos}ライン）`;
    badge.className   = 'bingo-status-badge bingo';
    badge.classList.remove('hidden');
  } else if (reaches > 0) {
    badge.textContent = `🔥 リーチ！（${reaches}ライン）`;
    badge.className   = 'bingo-status-badge reach';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden'); // 何もなければ非表示
  }
}

// 最新の抽選番号を表示する
function showLastDraw(num) {
  document.getElementById('last-draw-num').textContent = num;
  document.getElementById('last-draw-box').classList.remove('hidden');
}

// ============================================================
// 抽選番号の適用
//
// 抽選番号がカード上にあればマークし、DB を更新する。
// save=false のときは DB 更新をスキップ（初回キャッチアップ時に使う）。
// ============================================================
async function applyDraw(num, save = true) {
  let changed = false, changedIndex = -1;

  for (let i = 0; i < 25; i++) {
    if (numbers[i] === num && !marked[i]) {
      marked[i] = true;
      changed = true;
      changedIndex = i;
      break;
    }
  }

  showLastDraw(num); // 抽選番号を表示（マスが変化しなくても表示する）

  if (changed) {
    renderGrid(true, changedIndex); // アニメーション付きで再描画
    updateStatusBadge();            // リーチ・ビンゴ判定を更新
    if (save && cardId) await updateMarked(cardId, marked); // DB に保存
  }
}

// ============================================================
// テーブル番号フォームの送信処理
// ============================================================
document.getElementById('bingo-nickname-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nick = document.getElementById('bingo-nickname-input').value.trim();
  if (!nick) return;

  const btn = e.target.querySelector('button');
  btn.disabled = true;

  // 初回のみ UUID を生成（クイズとは別の UUID を使う）
  if (!participantId) participantId = crypto.randomUUID();
  nickname = nick;
  localStorage.setItem('bingo_participant_id', participantId);
  localStorage.setItem('bingo_nickname', nickname);

  await startApp(); // カードの確認・表示処理へ
  btn.disabled = false;
});

// ============================================================
// カード生成ボタンの処理
// ============================================================
document.getElementById('btn-generate').addEventListener('click', async () => {
  const btn = document.getElementById('btn-generate');
  btn.disabled = true;
  btn.textContent = '生成中…';

  numbers = generateNumbers(); // ランダムなカードを生成
  marked  = initialMarked();   // 初期マーク状態（FREE のみ）

  try {
    const saved = await saveCard(numbers, marked); // DB に保存して id を取得
    cardId = saved.id;
    startCardScreen();

    // 生成時点までに抽選済みの番号を一括適用する（遅れて参加した場合の対応）
    const draws = await fetchAllDraws();
    for (const { number } of draws) await applyDraw(number, false); // DB 更新はまとめて最後に
    if (draws.length > 0 && cardId) await updateMarked(cardId, marked);
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'カードをランダム生成する';
  }
});

// カード画面を表示する（テーブル番号とグリッドを設定）
function startCardScreen() {
  document.getElementById('bingo-player-name').textContent = `テーブル：${nickname}`;
  renderGrid();
  updateStatusBadge();
  showScreen('card');
}

// ============================================================
// アプリ本体の起動（テーブル番号確定後に呼ぶ）
//
// 既存カードがあれば表示、なければカード生成画面へ。
// 起動後は Realtime で抽選番号を購読し続ける。
// ============================================================
async function startApp() {
  try {
    const card = await fetchMyCard(); // 自分の最新カードを取得

    if (card) {
      // 既存カードがある → そのまま表示
      cardId  = card.id;
      numbers = card.numbers;
      marked  = card.marked;
      startCardScreen();

      // 現在までに抽選された番号を再適用（画面を再開いた場合のキャッチアップ）
      const draws = await fetchAllDraws();
      for (const { number } of draws) await applyDraw(number, false);
      if (cardId) await updateMarked(cardId, marked);
    } else {
      // カード未生成 → 生成画面へ
      document.getElementById('bingo-nickname-label').textContent = `テーブル：${nickname}`;
      showScreen('generate');
    }
  } catch (err) {
    console.error(err);
    document.getElementById('bingo-nickname-label').textContent = `テーブル：${nickname}`;
    showScreen('generate');
  }

  // Realtime 購読を開始（以降は抽選のたびに applyDraw が自動で呼ばれる）
  subscribeDraws((num) => applyDraw(num, true));
}

// ============================================================
// 初期化（ページ読み込み時に実行）
// ============================================================
(async () => {
  // URL に ?reset が付いていたら localStorage をクリアして入力画面へ
  if (new URLSearchParams(location.search).has('reset')) {
    localStorage.removeItem('bingo_participant_id');
    localStorage.removeItem('bingo_nickname');
    participantId = null;
    nickname      = null;
    history.replaceState(null, '', location.pathname);
  }

  if (!participantId || !nickname) {
    showScreen('login'); // テーブル番号未入力 → 入力画面へ
    return;
  }
  await startApp(); // テーブル番号が保存済み → 直接起動
})();
