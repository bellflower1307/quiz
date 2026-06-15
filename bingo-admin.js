// ============================================================
// ビンゴ抽選管理画面（bingo-admin.html）の動作ロジック
//
// SUPABASE_URL / SUPABASE_ANON_KEY は config.js で定義されます。
// getAdminToken / adminLogout / setupAdminAuth は auth.js で定義されます。
// ============================================================

// ============================================================
// Supabase REST ヘルパー（管理者用）
//
// 管理者 JWT トークンを使って認証付きリクエストを送る。
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

// これまでの抽選済み番号を昇順で全件取得する（初期化時に使う）
async function fetchDraws() {
  return await apiFetch('/rest/v1/draws?select=number&order=drawn_at.asc') ?? [];
}

// 抽選した番号を draws テーブルに INSERT する
async function insertDraw(number) {
  await apiFetch('/rest/v1/draws', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ number }),
  });
}

// 抽選履歴を全件削除する（リセット処理）
// 存在しない UUID を条件に指定することで「全件に一致する」削除を行う
async function deleteAllDraws() {
  await apiFetch('/rest/v1/draws?id=neq.00000000-0000-0000-0000-000000000000', {
    method: 'DELETE',
    headers: { 'Prefer': 'return=minimal' },
  });
}

// ============================================================
// 日付ヘルパー
// 今日の 0:00:00 を ISO8601 形式で返す
// 当日分のカードのみを対象にするためのフィルターに使う
function todayStartISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// ============================================================
// ビンゴ判定ライン（bingo.js と同じ定義）
//
// 管理画面側でもビンゴ・リーチを計算するために同じ定数を持つ。
// カードの 25 マスを 0〜24 のインデックスで管理する。
// ============================================================
const LINES = [
  [0,1,2,3,4], [5,6,7,8,9], [10,11,12,13,14], [15,16,17,18,19], [20,21,22,23,24], // 横5列
  [0,5,10,15,20], [1,6,11,16,21], [2,7,12,17,22], [3,8,13,18,23], [4,9,14,19,24], // 縦5列
  [0,6,12,18,24], [4,8,12,16,20], // 斜め2本
];

// カードの marked 配列をもとにビンゴ数・リーチ数を計算する
function computeCardStatus(marked) {
  const bingos  = LINES.filter(line => line.every(i => marked[i])).length;
  const reaches = LINES.filter(line =>
    !line.every(i => marked[i]) && line.filter(i => marked[i]).length === 4
  ).length;
  return { bingos, reaches };
}

// ============================================================
// 状態
// ============================================================
const drawnSet = new Set(); // 抽選済みの番号を重複なく管理するセット

// ============================================================
// UI 要素への参照
// ============================================================
const btnDraw   = document.getElementById('btn-draw');        // 「次の番号を抽選する」ボタン
const btnReset  = document.getElementById('btn-reset');       // 「抽選をリセットする」ボタン
const currentEl = document.getElementById('ba-current-num'); // 最新抽選番号の表示エリア
const countEl   = document.getElementById('ba-drawn-count'); // 「12 / 75 抽選済み」表示
const msgEl     = document.getElementById('ba-msg');          // メッセージ表示エリア

// ============================================================
// 番号グリッドの描画
//
// 1〜75 の番号を 5列×15行 の表として描画する。
// B=1-15, I=16-30, N=31-45, G=46-60, O=61-75 の列に色分けする。
// ============================================================
const COLUMN_COLORS = ['ba-b', 'ba-i', 'ba-n', 'ba-g', 'ba-o']; // 列ごとの CSS クラス

function buildGrid() {
  const grid = document.getElementById('ba-num-grid');
  grid.innerHTML = '';

  // 行（0〜14）×列（0〜4）でループして 75 マスを生成
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < 5; col++) {
      const num  = col * 15 + row + 1; // B列: 1〜15, I列: 16〜30 … の計算
      const cell = document.createElement('div');
      cell.className   = `ba-num-cell ${COLUMN_COLORS[col]}`;
      cell.id          = `ba-cell-${num}`; // markCell() から参照するための id
      cell.textContent = num;
      grid.appendChild(cell);
    }
  }
}

// 指定番号のマスを「抽選済み」スタイルに変える
function markCell(num) {
  document.getElementById(`ba-cell-${num}`)?.classList.add('drawn');
}

// 抽選済み数の表示とボタンの有効/無効を更新する
function updateCountDisplay() {
  countEl.textContent = `${drawnSet.size} / 75 抽選済み`;
  btnDraw.disabled    = drawnSet.size >= 75; // 75 番まで抽選したらボタンを無効化
}

function setCurrentNum(num) { currentEl.textContent = num ?? '—'; }
function setMsg(text)        { msgEl.textContent = text; }

// ============================================================
// 抽選処理
//
// 未抽選の番号からランダムに1つ選び、DB に保存してグリッドに反映する。
// DB に保存することで Realtime 経由で参加者画面にも通知される。
// ============================================================
async function drawNext() {
  if (drawnSet.size >= 75) return;

  // 未抽選の番号を配列に集めてランダムに1つ選ぶ
  const remaining = [];
  for (let n = 1; n <= 75; n++) if (!drawnSet.has(n)) remaining.push(n);
  const num = remaining[Math.floor(Math.random() * remaining.length)];

  btnDraw.disabled = true; // 二重抽選を防ぐ
  setMsg('抽選中…');
  try {
    await insertDraw(num); // DB に保存（Realtime で参加者へ通知される）
    applyDraw(num);        // 管理画面のグリッドを更新
    setMsg('');
  } catch (err) {
    setMsg('エラー：' + err.message);
    btnDraw.disabled = false;
  }
}

// 抽選番号を管理画面に反映する（DB 保存とは独立して呼び出せる）
function applyDraw(num) {
  drawnSet.add(num);
  markCell(num);
  setCurrentNum(num);
  updateCountDisplay();
  btnDraw.disabled = drawnSet.size >= 75;
}

// ============================================================
// リセット処理
// ============================================================
btnReset.addEventListener('click', async () => {
  if (!confirm('すべての抽選履歴を削除します。よろしいですか？')) return;
  btnReset.disabled = true;
  btnDraw.disabled  = true;
  setMsg('リセット中…');
  try {
    await deleteAllDraws(); // DB の全抽選履歴を削除

    // 画面上の状態もリセット
    drawnSet.clear();
    document.querySelectorAll('.ba-num-cell').forEach(c => c.classList.remove('drawn'));
    setCurrentNum(null);
    updateCountDisplay();
    setMsg('リセットしました。');
  } catch (err) {
    setMsg('エラー：' + err.message);
  } finally {
    // finally: try/catch の結果に関わらず必ず実行される
    btnReset.disabled = false;
    btnDraw.disabled  = false;
  }
});

btnDraw.addEventListener('click', drawNext);

// ============================================================
// Realtime（他端末で抽選された場合も画面を同期する）
//
// 複数の管理端末から同じページを開いていても、
// どちらかで抽選すると両方の画面が更新される。
// ============================================================
function subscribeDraws() {
  const wsUrl = SUPABASE_URL.replace('https://', 'wss://')
    + `/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    // 25 秒ごとにハートビートを送って接続を維持する
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
    }, 25000);

    // draws テーブルの INSERT / DELETE を購読する
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

    if (eventType === 'INSERT' && !drawnSet.has(record.number)) {
      applyDraw(record.number); // 他端末で抽選された番号を反映
    }
    if (eventType === 'DELETE') {
      // リセットされた場合：すべての抽選済み状態を解除
      drawnSet.clear();
      document.querySelectorAll('.ba-num-cell').forEach(c => c.classList.remove('drawn'));
      setCurrentNum(null);
      updateCountDisplay();
    }
  });

  ws.addEventListener('close', () => setTimeout(subscribeDraws, 3000)); // 3 秒後に再接続
}

// ============================================================
// ビンゴ・リーチ通知パネル
//
// 5 秒ごとに DB を確認し、当日分のカードでビンゴ・リーチになった
// 参加者を一覧表示する。
// ============================================================
async function refreshNotifications() {
  let cards;
  try {
    // 当日（0時以降）に作成されたカードを全件取得
    cards = await apiFetch(
      `/rest/v1/cards?select=participant_id,nickname,marked&created_at=gte.${todayStartISO()}&order=created_at.desc`
    ) ?? [];
  } catch {
    return; // 通知の更新失敗は無視（画面を壊さないよう silent に）
  }

  // 同じ参加者がカードを再生成した場合、最新の1枚だけを対象にする
  // （order=created_at.desc なので先頭に最新が来る）
  const seen   = new Set();
  const unique = cards.filter(c => {
    if (seen.has(c.participant_id)) return false;
    seen.add(c.participant_id); return true;
  });

  // ビンゴ・リーチそれぞれの参加者リストを作る
  const bingoPlayers = [];
  const reachPlayers = [];
  for (const c of unique) {
    const { bingos, reaches } = computeCardStatus(c.marked);
    if (bingos  > 0) bingoPlayers.push({ nickname: c.nickname, count: bingos });
    else if (reaches > 0) reachPlayers.push({ nickname: c.nickname, count: reaches });
  }

  // 画面に反映する
  renderNotifySection(
    document.getElementById('ba-bingo-list'),
    '🎉 ビンゴ', bingoPlayers, 'ba-notify-bingo'
  );
  renderNotifySection(
    document.getElementById('ba-reach-list'),
    '🔥 リーチ', reachPlayers, 'ba-notify-reach'
  );
}

// 通知セクション（ビンゴまたはリーチ）を描画するヘルパー
// el: 描画先の要素 / title: 見出し / players: 参加者リスト / cls: CSS クラス名
function renderNotifySection(el, title, players, cls) {
  el.innerHTML = `<p class="ba-notify-title">${title}（${players.length}名）</p>`;
  if (players.length === 0) {
    el.innerHTML += `<p class="ba-notify-empty">なし</p>`;
    return;
  }
  players.forEach(p => {
    const item = document.createElement('div');
    item.className   = `ba-notify-item ${cls}`;
    item.textContent = `${p.nickname}（${p.count}ライン）`;
    el.appendChild(item);
  });
}

// ============================================================
// 初期化（ログイン後に実行）
// ============================================================
setupAdminAuth(async () => {
  buildGrid(); // 1〜75 のグリッドを描画する

  // DB から抽選済み番号を取得して画面に反映する
  try {
    const draws = await fetchDraws();
    let lastNum = null;
    for (const { number } of draws) {
      drawnSet.add(number);
      markCell(number);
      lastNum = number;
    }
    if (lastNum !== null) setCurrentNum(lastNum); // 最後に抽選された番号を表示
    updateCountDisplay();
  } catch (err) {
    setMsg('読み込みエラー：' + err.message);
  }

  subscribeDraws(); // Realtime 購読を開始

  // ビンゴ・リーチ通知を初回表示し、5秒ごとに自動更新する
  await refreshNotifications();
  setInterval(refreshNotifications, 5000);
});
