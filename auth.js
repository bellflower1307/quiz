// ============================================================
// 管理者認証（admin.html / bingo-admin.html 共通）
//
// Supabase Auth を使ったメール＋パスワード認証を提供する。
// ログインに成功すると JWT（アクセストークン）を sessionStorage に保存し、
// 管理 API リクエストの Authorization ヘッダーに使用する。
//
// sessionStorage: タブを閉じると消えるブラウザの一時保存領域
//   （localStorage はブラウザを閉じても残るが、sessionStorage は閉じると消える）
//
// SUPABASE_URL / SUPABASE_ANON_KEY は config.js で定義されます。
// ============================================================

const ADMIN_TOKEN_KEY = 'quiz_admin_token'; // sessionStorage に保存するキー名

// 保存済みのアクセストークンを取得する
function getAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY);
}

// Supabase Auth にメール＋パスワードでログインし、トークンを保存する
async function adminLogin(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey':       SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || 'ログインに失敗しました');
  // ログイン成功：JWT アクセストークンを sessionStorage に保存
  sessionStorage.setItem(ADMIN_TOKEN_KEY, data.access_token);
}

// ログアウト：トークンを削除してページをリロードする
function adminLogout() {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  location.reload(); // リロードでログイン画面に戻る
}

// 401（認証切れ）/ 403（権限なし）のとき呼ぶ
// リロードせずにログイン画面だけ表示する（ページ状態を保持するため）
function returnToLogin(message) {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  const loginScreen  = document.getElementById('login-screen');
  const adminContent = document.getElementById('admin-content');
  const loginError   = document.getElementById('login-error');
  if (loginScreen)  loginScreen.classList.remove('hidden');
  if (adminContent) adminContent.classList.add('hidden');
  if (loginError)   loginError.textContent = message ?? 'セッションが切れました。再ログインしてください。';
}

// JWT のペイロード部分をデコードしてメールアドレスを取得する
// JWT の構造: ヘッダー.ペイロード.署名 の3つを "." でつないだ文字列
// ペイロードは Base64 エンコードされた JSON なので atob() でデコードできる
function getAdminEmail() {
  const token = getAdminToken();
  if (!token) return null;
  try {
    // Base64 の URL セーフ文字（- _）を通常の Base64 文字（+ /）に変換してからデコード
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email ?? null;
  } catch {
    return null;
  }
}

// ============================================================
// 各管理画面 JS から呼び出す初期化ヘルパー
//
// 使い方: setupAdminAuth(async () => { /* ログイン後の処理 */ });
//
// ログイン済みなら onReady() を即実行。
// 未ログインならログインフォームを表示して待機する。
// ============================================================
function setupAdminAuth(onReady) {
  // HTML 要素への参照をまとめて取得
  const loginScreen   = document.getElementById('login-screen');
  const adminContent  = document.getElementById('admin-content');
  const loginForm     = document.getElementById('login-form');
  const loginError    = document.getElementById('login-error');
  const logoutBtn     = document.getElementById('btn-logout');
  const authEmailEl   = document.getElementById('auth-email'); // ログイン中メールを表示する場所

  // ログイン画面を表示する
  function showLogin() {
    loginScreen.classList.remove('hidden');
    adminContent.classList.add('hidden');
  }

  // 管理コンテンツを表示してログイン後の初期化を実行する
  function showAdmin() {
    loginScreen.classList.add('hidden');
    adminContent.classList.remove('hidden');
    // ヘッダーにログイン中のメールアドレスを表示する
    if (authEmailEl) authEmailEl.textContent = getAdminEmail() ?? '';
    onReady(); // admin.js または bingo-admin.js に書いた初期化処理を実行
  }

  // ログインフォームの送信イベント
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault(); // フォームのデフォルト送信（ページリロード）を止める
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn      = loginForm.querySelector('button[type="submit"]');

    btn.disabled           = true; // 二重送信を防ぐ
    loginError.textContent = '';   // 前回のエラーメッセージをクリア

    try {
      await adminLogin(email, password);
      showAdmin(); // ログイン成功 → 管理画面を表示
    } catch (err) {
      loginError.textContent = err.message; // エラーメッセージを表示
      btn.disabled = false;
    }
  });

  // ログアウトボタン（?.addEventListener: btn-logout が存在する場合のみ設定）
  logoutBtn?.addEventListener('click', () => {
    if (confirm('ログアウトしますか？')) adminLogout();
  });

  // ページ読み込み時：トークンが残っていれば管理画面を直接表示
  if (getAdminToken()) {
    showAdmin();
  } else {
    showLogin();
  }
}
