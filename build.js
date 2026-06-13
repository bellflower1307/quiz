// Vercel のビルド時に環境変数から config.js を生成するスクリプト
const fs = require('fs');

const url  = process.env.SUPABASE_URL;
const key  = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('ERROR: SUPABASE_URL または SUPABASE_ANON_KEY が設定されていません。');
  process.exit(1);
}

const content = `// このファイルはビルド時に自動生成されます。編集しないでください。
const SUPABASE_URL      = '${url}';
const SUPABASE_ANON_KEY = '${key}';
`;

fs.writeFileSync('config.js', content);
console.log('config.js を生成しました。');
