// ============================================================
// 管理者認証（admin.html / bingo-admin.html 共通）
// SUPABASE_URL / SUPABASE_ANON_KEY は config.js で定義されます。
// ============================================================
const ADMIN_TOKEN_KEY = 'quiz_admin_token';

function getAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY);
}

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
  sessionStorage.setItem(ADMIN_TOKEN_KEY, data.access_token);
}

function adminLogout() {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  location.reload();
}

// 各管理画面の JS から呼び出す初期化ヘルパー
// ログイン済みなら onReady() を実行、未ログインならログイン画面を表示
function setupAdminAuth(onReady) {
  const loginScreen   = document.getElementById('login-screen');
  const adminContent  = document.getElementById('admin-content');
  const loginForm     = document.getElementById('login-form');
  const loginError    = document.getElementById('login-error');
  const logoutBtn     = document.getElementById('btn-logout');

  function showLogin() {
    loginScreen.classList.remove('hidden');
    adminContent.classList.add('hidden');
  }

  function showAdmin() {
    loginScreen.classList.add('hidden');
    adminContent.classList.remove('hidden');
    onReady();
  }

  // ログインフォーム送信
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn      = loginForm.querySelector('button[type="submit"]');

    btn.disabled       = true;
    loginError.textContent = '';

    try {
      await adminLogin(email, password);
      showAdmin();
    } catch (err) {
      loginError.textContent = err.message;
      btn.disabled = false;
    }
  });

  // ログアウト
  logoutBtn?.addEventListener('click', () => {
    if (confirm('ログアウトしますか？')) adminLogout();
  });

  // 初期表示
  if (getAdminToken()) {
    showAdmin();
  } else {
    showLogin();
  }
}
