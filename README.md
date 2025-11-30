# 🚀 2ndstreet監視システム JavaScript版（VPS完全対応）

## 📋 概要

セカンドストリートの新着商品を自動監視し、ChatWorkに通知するシステムです。  
**VPS環境での403 Forbidden対策を徹底実装**したプロダクション級のスクレイパーです。

### ✨ 主な特徴

- ✅ **Bot対策強化**: Playwright Stealth Plugin完全実装
- ✅ **VPS最適化**: ヘッドレス環境での安定動作
- ✅ **プロキシローテーション**: 403エラー時の自動切り替え
- ✅ **DOM安定化**: 複数回検証による一貫性チェック
- ✅ **統計学習**: 時間帯別の動的間隔調整
- ✅ **Docker対応**: 簡単デプロイ・運用管理

---

## 🛠️ セットアップ（3ステップ）

### 方法1: Docker使用（推奨）

```bash
# 1. リポジトリクローン
git clone <your-repo-url>
cd 2ndstreet-monitor

# 2. 環境変数設定（.env作成）
cat << EOF > .env
CHATWORK_TOKEN=your_chatwork_token_here
USE_PROXY=true
PROXY_LIST=http://proxy1:8080,http://proxy2:8080
EOF

# 3. Docker起動
docker-compose up -d

# ログ確認
docker-compose logs -f
```

### 方法2: ローカル実行

```bash
# 1. Node.js 18+インストール確認
node -v  # v18.0.0以上

# 2. 依存関係インストール
npm install

# 3. Playwrightブラウザインストール
npx playwright install chromium
npx playwright install-deps chromium

# 4. 環境変数設定
export CHATWORK_TOKEN="your_token_here"
export USE_PROXY=true
export PROXY_LIST="http://162.43.73.18:8080"

# 5. 実行
node 2st-monitor.js
```

---

## ⚙️ 設定

### 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `CHATWORK_TOKEN` | ChatWork APIトークン | ※必須 |
| `USE_PROXY` | プロキシ使用ON/OFF | `true` |
| `PROXY_LIST` | プロキシサーバー（カンマ区切り） | `http://162.43.73.18:8080` |

### config.json編集

より詳細な設定は `config.json` で変更可能:

```json
{
  "scraping": {
    "intervals": {
      "base": 300,     // アクティブ時: 5分
      "mid": 900,      // 中程度: 15分
      "slow": 1800     // 低頻度: 30分
    },
    "sleep": {
      "startHour": 1,  // スリープ開始時刻
      "endHour": 8     // スリープ終了時刻
    }
  }
}
```

---

## 🔒 Bot対策実装詳細

### 1. Stealth Plugin（最重要）

```javascript
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
```

- `navigator.webdriver` 完全除去
- Chrome runtime偽装
- Canvas/WebGL Fingerprint対策

### 2. 人間的振る舞いシミュレーション

- ランダム遅延注入（2〜5秒）
- トップページ経由アクセス
- Google Referer偽装

### 3. プロキシローテーション

```javascript
// 403エラー発生時
if (status === 403) {
  browser.rotateProxy();  // 自動切り替え
  await browser.relaunch();
}
```

### 4. DOM安定化チェック

```javascript
// 2回連続で同じHTMLを検証
await waitForStableDOM(page, maxAttempts=3);
```

### 5. 一貫性チェック

```javascript
// 3回スクレイピングして2回連続で1位が一致したら採用
await verifyWithConsistencyCheck(page, urlConfig, retries=3);
```

---

## 📊 統計管理

システムは自動的に以下を学習します:

- **時間帯別更新頻度**: 0〜23時の新着商品数
- **最終更新時刻**: 最後に新商品が見つかった時刻
- **エラー率**: 403エラーの発生回数

### 動的間隔調整ロジック

```
もし (直近3時間で5件以上の更新) または (30分以内に更新)
  → 5分間隔 (アクティブ)
もし (直近3時間で2件以上の更新) または (2時間以内に更新)
  → 15分間隔 (中程度)
それ以外
  → 30分間隔 (低頻度)
```

---

## 🐳 Docker運用

### よく使うコマンド

```bash
# 起動
docker-compose up -d

# 停止
docker-compose down

# 再起動
docker-compose restart

# ログ確認
docker-compose logs -f

# コンテナ内シェル
docker-compose exec 2st-monitor sh

# データファイル確認
cat 2st_snapshot.json
cat 2st_stats.json
```

### データ永続化

以下のファイルはホストにマウントされ、コンテナ再起動後も保持されます:

- `2st_snapshot.json`: 前回取得した商品データ
- `2st_stats.json`: 統計情報

---

## 🚨 トラブルシューティング

### 1. 403 Forbiddenが頻発する

**原因**: Bot対策に検知されている

**対処法**:
```bash
# プロキシを追加
export PROXY_LIST="http://proxy1:8080,http://proxy2:8080,http://proxy3:8080"

# 間隔を長くする（config.json）
"base": 600,  # 5分→10分
```

### 2. 商品が取得できない

**原因**: DOM安定化タイムアウト

**対処法**:
```json
// config.json
"consistency": {
  "retries": 5,  // 3→5回に増やす
  "domStabilityTimeout": 20000  // 15秒→20秒
}
```

### 3. Dockerコンテナが停止する

**原因**: メモリ不足

**対処法**:
```yaml
# docker-compose.yml
deploy:
  resources:
    limits:
      memory: 2G  # 1G→2Gに増やす
```

### 4. Playwrightインストールエラー（ローカル実行時）

**Ubuntu/Debian**:
```bash
sudo apt-get update
sudo apt-get install -y \
  libnss3 libatk-bridge2.0-0 libdrm2 libgbm1 \
  libasound2 libxkbcommon0
```

**CentOS/RHEL**:
```bash
sudo yum install -y \
  nss atk-bridge at-spi2-atk libdrm libgbm \
  alsa-lib libxkbcommon
```

---

## 📈 監視例（ログ出力）

<img width="1366" height="768" alt="image" src="https://github.com/user-attachments/assets/c0a6d866-c125-4762-9735-327da82e9ff2" />

```
============================================================
🚀 2ndstreet VPS完全対応版監視システム起動
============================================================
🖥️  実行環境: ヘッドレス環境（VPS）
📍 監視対象: 2サイト
   - セカンドストリート カメラ → ルーム 385402385
   - セカンドストリート 時計 → ルーム 408715054
⏱️  実行間隔: 300秒〜1800秒（統計ベース）
😴 スリープ時間: 1時〜8時
🔒 一貫性チェック: 3回試行
🌐 プロキシサーバー: 1個登録
============================================================

🔍 2ndstreet スクレイピング開始: 2025-11-30 14:30:00
============================================================
    🖥️  ヘッドレス環境検出（VPS） - headlessモード起動
    🌐 プロキシ経由: http://162.43.73.18:8080

============================================================
📍 セカンドストリート - カメラ
============================================================
  🔄 一貫性チェック開始（最大3回）
    🔄 試行 1/3
  🔍 セカンドストリート カメラ スクレイピング中...
    📡 ステータスコード: 200
    ✅ .itemCard セレクタ検出
    ✅ DOM安定確認: 1/2
    ✅ DOM安定確認: 2/2
    ✅ DOM完全安定化（2回目）
    🛍️  商品カード: 48個
    ✅ 48件取得
    🔄 試行 2/3
    ✅ 一貫性確認: 2回目で1位が一致
       商品: Canon EOS R5 ボディ
    🔍 前回1位: Canon EOS R6 Mark II
    🔍 前回ハッシュ: a3f5d2c1
    🔍 今回1位: Canon EOS R5 ボディ
    🔍 今回ハッシュ: b7e9f4d2
    🎉 新しい1位を検知！
    ✅ ChatWork通知送信成功 (ルーム: 385402385)

✅ スクレイピング完了: 2025-11-30 14:35:22
📊 総新商品数: 1件
============================================================

📊 統計情報:
   チェック回数: 120回
   新着累計: 15件
   エラー回数: 2回
   更新頻度TOP3: 14時:5件, 10時:3件, 16時:2件

⏳ 次回実行: 2025-11-30 14:40:22 (5分後・アクティブ時間帯)
```

---

## 🔧 カスタマイズ

### 監視URL追加

`config.json` の `urls` 配列に追加:

```json
{
  "url": "https://www.2ndstreet.jp/search?category=XXXXX&sortBy=arrival",
  "displayName": "セカンドストリート",
  "category": "新カテゴリ",
  "roomId": "YOUR_ROOM_ID",
  "urlIndex": 2
}
```

### プロキシ追加

```bash
# 環境変数
export PROXY_LIST="http://proxy1:8080,http://proxy2:8080,http://proxy3:8080"
```

---

## 📝 ライセンス

MIT License

---

## 🙋 サポート

質問・不具合報告は Issue でお願いします。

---

## 🚀 今後の拡張予定

- [ ] Slack通知対応
- [ ] Discord Webhook対応
- [ ] 複数サイト対応（楽天、メルカリ等）
- [ ] Web UI管理画面
- [ ] データベース連携（PostgreSQL）
- [ ] Kubernetes対応

---

**Happy Scraping! 🎉**
