#!/usr/bin/env node
/**
 * 2st-monitor.js - 2ndstreet監視システム (JavaScript版・VPS完全対応)
 * * 主要改善点:
 * - Playwright Stealth Plugin完全実装
 * - VPS環境での403 Forbidden対策徹底 (Hyper-Stealth)
 * - プロキシローテーション機構 (機能無効化済み)
 * - 人間的振る舞いシミュレーション
 * - DOM安定化・一貫性チェック
 * - 統計ベース動的間隔調整
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// Stealth Plugin適用（最重要）
chromium.use(StealthPlugin());

// ==================== 設定 ====================

const CONFIG = {
  // ChatWork設定
  chatworkToken: process.env.CHATWORK_TOKEN || '987cf44efbf5529a09b1317a85058640',
  
  // プロキシ設定（複数対応）
  proxies: [], // プロキシ機能を無効化
  useProxy: false, // プロキシ機能を無効化
  currentProxyIndex: 0,
  
  // 間隔設定（秒）
  baseInterval: 300,      // 5分（アクティブ時）
  midInterval: 900,       // 15分（中程度）
  slowInterval: 1800,     // 30分（低頻度）
  
  // スリープ設定
  sleepStartHour: 1,
  sleepEndHour: 8,
  
  // Bot対策設定
  consistencyCheckRetries: 3,
  domStabilityTimeout: 15000,
  randomDelayMin: 2500, // わずかに延長
  randomDelayMax: 5500, // わずかに延長
  
  // ファイルパス
  snapshotFile: '2st_snapshot.json',
  statsFile: '2st_stats.json',
  
  // User-Agent（最新Chrome）
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

// 監視URL設定
const URLS = [
  {
    url: 'https://www.2ndstreet.jp/search?category=121001&sortBy=arrival',
    displayName: 'セカンドストリート',
    category: 'カメラ',
    roomId: '385402385',
    urlIndex: 0
  },
  {
    url: 'https://www.2ndstreet.jp/search?category=931010&sortBy=arrival',
    displayName: 'セカンドストリート',
    category: '時計',
    roomId: '408715054',
    urlIndex: 1
  }
];

// ==================== ユーティリティ ====================

/**
 * VPS環境判定（DISPLAY環境変数チェック）
 */
function isHeadlessEnvironment() {
  return !process.env.DISPLAY;
}

/**
 * ランダム遅延（人間的振る舞い）
 */
async function randomDelay(min = CONFIG.randomDelayMin, max = CONFIG.randomDelayMax) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * MD5ハッシュ生成
 */
function md5Hash(text) {
  return crypto.createHash('md5').update(text).digest('hex').substring(0, 8);
}

/**
 * 現在時刻フォーマット
 */
function timestamp() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

// ==================== 統計管理 (変更なし) ====================

class StatsManager {
  constructor() {
    this.stats = null;
  }

  async load() {
    try {
      const data = await fs.readFile(CONFIG.statsFile, 'utf-8');
      this.stats = JSON.parse(data);
    } catch {
      this.stats = {
        hourlyNewItems: Object.fromEntries([...Array(24)].map((_, i) => [i, 0])),
        totalChecks: 0,
        totalNewItems: 0,
        lastNewItemTime: null,
        errorCount: 0,
        lastErrorTime: null
      };
    }
  }

  async save() {
    try {
      await fs.writeFile(CONFIG.statsFile, JSON.stringify(this.stats, null, 2));
    } catch (error) {
      console.error(`⚠️  統計保存失敗: ${error.message}`);
    }
  }

  async update(newItemCount) {
    const currentHour = new Date().getHours();
    this.stats.hourlyNewItems[currentHour] = (this.stats.hourlyNewItems[currentHour] || 0) + newItemCount;
    this.stats.totalChecks += 1;
    this.stats.totalNewItems += newItemCount;

    if (newItemCount > 0) {
      this.stats.lastNewItemTime = new Date().toISOString();
    }

    await this.save();
  }

  async recordError() {
    this.stats.errorCount += 1;
    this.stats.lastErrorTime = new Date().toISOString();
    await this.save();
  }

  getDynamicInterval() {
    const currentHour = new Date().getHours();

    // スリープ時間帯
    if (currentHour >= CONFIG.sleepStartHour && currentHour < CONFIG.sleepEndHour) {
      return null;
    }

    const hourlyData = this.stats.hourlyNewItems;
    const currentHourUpdates = hourlyData[currentHour] || 0;

    const prevHour = (currentHour - 1 + 24) % 24;
    const nextHour = (currentHour + 1) % 24;
    const nearbyUpdates = 
      (hourlyData[prevHour] || 0) + 
      currentHourUpdates + 
      (hourlyData[nextHour] || 0);

    // 最終更新からの経過時間
    let minutesSinceLast = 999;
    if (this.stats.lastNewItemTime) {
      const lastTime = new Date(this.stats.lastNewItemTime);
      minutesSinceLast = (Date.now() - lastTime.getTime()) / 60000;
    }

    // 動的間隔決定
    if (nearbyUpdates >= 5 || minutesSinceLast < 30) {
      return { interval: CONFIG.baseInterval, reason: 'アクティブ時間帯' };
    } else if (nearbyUpdates >= 2 || minutesSinceLast < 120) {
      return { interval: CONFIG.midInterval, reason: '中程度' };
    } else {
      return { interval: CONFIG.slowInterval, reason: '低頻度' };
    }
  }
}

// ==================== スナップショット管理 (変更なし) ====================

class SnapshotManager {
  constructor() {
    this.snapshots = {};
  }

  async load() {
    try {
      const data = await fs.readFile(CONFIG.snapshotFile, 'utf-8');
      this.snapshots = JSON.parse(data);
    } catch {
      this.snapshots = {};
    }
  }

  async save() {
    try {
      await fs.writeFile(CONFIG.snapshotFile, JSON.stringify(this.snapshots, null, 2));
    } catch (error) {
      console.error(`⚠️  スナップショット保存失敗: ${error.message}`);
    }
  }

  normalizeProductKey(product) {
    const combined = `${product.name}_${product.price}`;
    return md5Hash(combined);
  }

  async detectNewProducts(urlKey, products) {
    if (!products || products.length === 0) {
      console.log('    ⚠️  商品リストが空です');
      return [];
    }

    const isFirstRun = !this.snapshots[urlKey];

    if (isFirstRun) {
      const firstKey = this.normalizeProductKey(products[0]);
      this.snapshots[urlKey] = {
        firstProductKey: firstKey,
        firstProductName: products[0].name,
        firstProductPrice: products[0].price,
        timestamp: new Date().toISOString()
      };
      await this.save();

      console.log('    📝 初回実行: 1位を記憶（通知スキップ）');
      console.log(`       商品名: ${products[0].name.substring(0, 50)}`);
      console.log(`       ハッシュ: ${firstKey}`);
      return [];
    }

    const rememberedFirstKey = this.snapshots[urlKey].firstProductKey;
    const rememberedName = this.snapshots[urlKey].firstProductName || '不明';
    const currentFirstKey = this.normalizeProductKey(products[0]);
    const currentFirstName = products[0].name;

    console.log(`    🔍 前回1位: ${rememberedName.substring(0, 50)}`);
    console.log(`    🔍 前回ハッシュ: ${rememberedFirstKey}`);
    console.log(`    🔍 今回1位: ${currentFirstName.substring(0, 50)}`);
    console.log(`    🔍 今回ハッシュ: ${currentFirstKey}`);

    if (currentFirstKey !== rememberedFirstKey) {
      console.log('    🎉 新しい1位を検知！');

      this.snapshots[urlKey] = {
        firstProductKey: currentFirstKey,
        firstProductName: currentFirstName,
        firstProductPrice: products[0].price,
        timestamp: new Date().toISOString()
      };
      await this.save();

      return [products[0]];
    } else {
      console.log('    ✅ 変更なし（1位は同じ）');
      this.snapshots[urlKey].timestamp = new Date().toISOString();
      await this.save();
      return [];
    }
  }
}

// ==================== ChatWork通知 (変更なし) ====================

class ChatWorkNotifier {
  async send(displayName, category, url, products, roomId) {
    if (!products || products.length === 0 || !roomId) {
      return false;
    }

    try {
      let message = '[info]\n';
      message += '━━━━━━━━━━━━━━━━━\n';
      message += `📍 ${displayName} + ${category}\n`;
      message += '━━━━━━━━━━━━━━━━━\n';
      message += `🔗 ${url}\n`;
      message += '━━━━━━━━━━━━━━━━━\n\n';

      products.slice(0, 20).forEach(product => {
        message += `■${product.name}・${product.price}円\n\n`;
      });

      if (products.length > 20) {
        message += `...他${products.length - 20}件\n`;
      }

      message += 'ーーーーーーーーーーー[/info]';

      const response = await axios.post(
        `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
        `body=${encodeURIComponent(message)}`,
        {
          headers: {
            'X-ChatWorkToken': CONFIG.chatworkToken,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: 10000
        }
      );

      if (response.status === 200) {
        console.log(`    ✅ ChatWork通知送信成功 (ルーム: ${roomId})`);
        return true;
      } else {
        console.log(`    ❌ ChatWork通知送信失敗: ${response.status}`);
        return false;
      }
    } catch (error) {
      console.log(`    ❌ ChatWork通知エラー: ${error.message}`);
      return false;
    }
  }
}

// ==================== ブラウザ管理（Bot対策強化版） (変更なし) ====================

class StealthBrowser {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async launch() {
    const isHeadless = isHeadlessEnvironment();
    
    console.log(isHeadless 
      ? '    🖥️  ヘッドレス環境検出（VPS） - headlessモード起動'
      : '    🖥️  デスクトップ環境検出 - GUIモード起動'
    );

    // プロキシ設定はCONFIGで無効化
    const launchOptions = {
      headless: isHeadless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-features=NetworkService',
        '--disable-features=VizDisplayCompositor',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--window-size=1920,1080'
      ]
    };

    if (CONFIG.useProxy && CONFIG.proxies.length > 0) {
      const proxy = CONFIG.proxies[CONFIG.currentProxyIndex % CONFIG.proxies.length];
      launchOptions.proxy = { server: proxy };
      console.log(`    🌐 プロキシ経由: ${proxy}`);
    } else {
      console.log('    🌐 プロキシ不使用: VPSの直接IPでアクセス');
    }

    this.browser = await chromium.launch(launchOptions);

    // コンテキスト作成（高度なステルス設定）
    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: CONFIG.userAgent,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      permissions: ['geolocation'],
      geolocation: { latitude: 35.6762, longitude: 139.6503 }, // 東京
      extraHTTPHeaders: {
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://www.google.com/',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    this.page = await this.context.newPage();

    // 強化版webdriver隠蔽スクリプト
    await this.page.addInitScript(() => {
      // webdriver完全除去
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Chrome runtime偽装
      window.navigator.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };

      // Permissions API偽装
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Plugins偽装
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });

      // Languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['ja', 'en-US', 'en']
      });

      // Platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32'
      });

      // Hardware Concurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8
      });

      // Device Memory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8
      });

      // Battery API除去（ヘッドレス特有）
      if ('getBattery' in navigator) {
        delete navigator.getBattery;
      }
    });

    return this.page;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  // プロキシローテーション (機能は残す)
  rotateProxy() {
    if (!CONFIG.useProxy || CONFIG.proxies.length === 0) return;
    CONFIG.currentProxyIndex = (CONFIG.currentProxyIndex + 1) % CONFIG.proxies.length;
    console.log(`    🔄 プロキシ切り替え: ${CONFIG.proxies[CONFIG.currentProxyIndex]}`);
  }
}

// ==================== スクレイピングコア ====================

class SecondStreetScraper {
  async waitForStableDOM(page, maxAttempts = 3) {
    let previousHTML = null;
    let stableCount = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await page.waitForLoadState('networkidle', { timeout: CONFIG.domStabilityTimeout });
      } catch (error) {
        console.log(`    ⚠️  ネットワークアイドル待機タイムアウト`);
      }

      await randomDelay(2000, 3000);

      const currentHTML = await page.content();

      if (previousHTML === currentHTML) {
        stableCount++;
        console.log(`    ✅ DOM安定確認: ${stableCount}/2`);

        if (stableCount >= 2) {
          console.log(`    ✅ DOM完全安定化（${attempt + 1}回目）`);
          return currentHTML;
        }
      } else {
        stableCount = 0;
        console.log(`    🔄 DOM変化検出 - 再検証中...`);
      }

      previousHTML = currentHTML;
      await randomDelay(1000, 2000);
    }

    throw new Error(`DOM安定化に失敗（${maxAttempts}回試行）`);
  }
  
  /**
   * Bot対策のための人間的なセッション確立行動
   */
  async humanizeSession(page) {
    console.log('    🏃 セッション人間化 (Bot回避行動)...');
    
    // 1. トップページにアクセス
    try {
        await page.goto('https://www.2ndstreet.jp/', { 
          timeout: 45000, 
          waitUntil: 'domcontentloaded' 
        });
        await randomDelay(2000, 4000);
    } catch (error) {
        console.log(`    ⚠️  トップページ初期接続失敗 - 続行`);
    }
    
    // 2. ページをスクロール（Bot回避）
    await page.evaluate(() => {
        window.scrollBy(0, document.body.scrollHeight / 3);
    });
    await randomDelay(1000, 2000);
    
    // 3. ランダムなリンクをクリック（サイト内回遊）
    const randomLinks = await page.$$('a:not([href^="#"]):not([href=""]):not([href*="tel:"]):not([href*="javascript:"])');
    if (randomLinks.length > 5) {
        const randomIndex = Math.floor(Math.random() * 5) + 1; // 1~5番目のリンクをクリック
        const link = randomLinks[randomIndex];
        console.log(`    🖱️  ランダムリンククリック (Index: ${randomIndex})`);
        try {
            await link.click({ timeout: 15000 });
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
            await randomDelay(3000, 5000);
        } catch (e) {
            console.log('    ⚠️  ランダムクリック失敗 - 続行');
        }
    } else {
        console.log('    ⚠️  クリック可能なリンクが少ないためスキップ');
    }
    
    console.log('    ✅ セッション人間化完了');
  }

  async scrapeURL(page, urlConfig) {
    const { url, displayName, category } = urlConfig;

    try {
      console.log(`  🔍 ${displayName} ${category} スクレイピング中...`);

      // Bot対策: 人間的セッション確立
      await this.humanizeSession(page);

      // 検索ページに移動
      const response = await page.goto(url, { 
        timeout: 60000, 
        waitUntil: 'load' 
      });

      const status = response.status();
      console.log(`    📡 ステータスコード: ${status}`);

      if (status === 403) {
        console.log(`    ❌ 403 Forbidden - Bot対策が作動`);
        throw new Error('403_FORBIDDEN');
      }

      if (status !== 200) {
        console.log(`    ❌ HTTPエラー: ${status}`);
        return [];
      }

      // 商品カード待機
      try {
        await page.waitForSelector('.itemCard', { timeout: 10000 });
        console.log(`    ✅ .itemCard セレクタ検出`);
      } catch (error) {
        console.log(`    ❌ .itemCard が見つかりません`);
        return [];
      }

      // DOM安定化待機
      const html = await this.waitForStableDOM(page, 3);

      // HTML解析
      const $ = cheerio.load(html);
      const items = $('.itemCard');
      console.log(`    🛍️  商品カード: ${items.length}個`);

      if (items.length === 0) {
        console.log(`    ⚠️  商品が見つかりません`);
        return [];
      }

      // 商品データ抽出
      const products = [];
      items.each((index, element) => {
        try {
          const nameTag = $(element).find('.itemCard_name');
          const priceTag = $(element).find('.itemCard_price');

          if (!nameTag.length || !priceTag.length) return;

          const productName = nameTag.text().trim();
          const priceText = priceTag.text().trim();

          const priceMatch = priceText.match(/¥\s*([\d,]+)/);
          const price = priceMatch ? priceMatch[1].replace(/,/g, '') : '0';

          if (productName && productName.length >= 3) {
            products.push({ name: productName, price });
          }
        } catch (error) {
          // スキップ
        }
      });

      console.log(`    ✅ ${products.length}件取得`);
      return products;

    } catch (error) {
      if (error.message === '403_FORBIDDEN') {
        throw error; // 403は上位で処理
      }
      console.log(`    ❌ スクレイピングエラー: ${error.message}`);
      return [];
    }
  }

  async verifyWithConsistencyCheck(page, urlConfig, retries = 3) {
    const results = [];

    console.log(`  🔄 一貫性チェック開始（最大${retries}回）`);

    for (let attempt = 0; attempt < retries; attempt++) {
      console.log(`    🔄 試行 ${attempt + 1}/${retries}`);

      try {
        const products = await this.scrapeURL(page, urlConfig);

        if (!products || products.length === 0) {
          console.log(`    ⚠️  商品取得失敗 - スキップ`);
          await randomDelay(3000, 5000);
          continue;
        }

        results.push(products);

        // 2回連続で同じ1位なら採用
        if (attempt > 0 && results.length >= 2) {
          const prevFirst = results[results.length - 2][0];
          const currFirst = results[results.length - 1][0];

          if (prevFirst && currFirst) {
            const prevKey = md5Hash(`${prevFirst.name}_${prevFirst.price}`);
            const currKey = md5Hash(`${currFirst.name}_${currFirst.price}`);

            if (prevKey === currKey) {
              console.log(`    ✅ 一貫性確認: ${attempt + 1}回目で1位が一致`);
              console.log(`       商品: ${currFirst.name.substring(0, 50)}`);
              return results[results.length - 1];
            }
          }
        }

        await randomDelay(3000, 5000);

      } catch (error) {
        if (error.message === '403_FORBIDDEN') {
          throw error; // 403は上位で処理
        }
        console.log(`    ❌ 試行${attempt + 1}失敗: ${error.message}`);
        await randomDelay(5000, 8000);
      }
    }

    console.log(`    ⚠️  一貫性未確認 - 通知スキップ（安全優先）`);
    return [];
  }
}

// ==================== メイン処理・メインループ (変更なし) ====================

async function scrapeAllURLs(statsManager, snapshotManager, notifier) {
  console.log('='.repeat(60));
  console.log(`🔍 2ndstreet スクレイピング開始: ${timestamp()}`);
  console.log('='.repeat(60));

  let allNewProductsCount = 0;
  const scraper = new SecondStreetScraper();
  const browser = new StealthBrowser();

  try {
    const page = await browser.launch();

    for (const urlConfig of URLS) {
      const { displayName, category, url, roomId } = urlConfig;
      const urlKey = `${displayName}_${category}`;

      console.log('\n' + '='.repeat(60));
      console.log(`📍 ${displayName} - ${category}`);
      console.log('='.repeat(60));

      let products = [];
      let retryCount = 0;
      const maxRetries = 2;

      while (retryCount <= maxRetries) {
        try {
          products = await scraper.verifyWithConsistencyCheck(
            page, 
            urlConfig, 
            CONFIG.consistencyCheckRetries
          );
          break; // 成功したらループ脱出

        } catch (error) {
          if (error.message === '403_FORBIDDEN' && retryCount < maxRetries && CONFIG.useProxy) {
            console.log(`    🔄 403エラー - プロキシローテーション実行 (現在は無効のため処理スキップ)`);
            break;
          } else if (error.message === '403_FORBIDDEN' && !CONFIG.useProxy) {
            console.log(`    ❌ 403エラー - プロキシ無効のためリトライスキップ`);
            break;
          } else {
            console.log(`    ❌ リトライ上限到達またはその他エラー`);
            break;
          }
        }
      }

      if (!products || products.length === 0) {
        console.log(`    ⚠️  商品取得失敗 or 一貫性未確認`);
        await randomDelay(5000, 8000);
        continue;
      }

      const newProducts = await snapshotManager.detectNewProducts(urlKey, products);

      if (newProducts && newProducts.length > 0) {
        await notifier.send(displayName, category, url, newProducts, roomId);
        allNewProductsCount += newProducts.length;
      }

      await randomDelay(5000, 8000);
    }

  } catch (error) {
    console.log(`\n❌ 致命的エラー: ${error.message}`);
    console.error(error.stack);
    await statsManager.recordError();
  } finally {
    await browser.close();
  }

  await statsManager.update(allNewProductsCount);

  console.log('\n' + '='.repeat(60));
  console.log(`✅ スクレイピング完了: ${timestamp()}`);
  console.log(`📊 総新商品数: ${allNewProductsCount}件`);
  console.log('='.repeat(60));

  return allNewProductsCount;
}

async function main() {
  const statsManager = new StatsManager();
  await statsManager.load();

  const snapshotManager = new SnapshotManager();
  await snapshotManager.load();

  const notifier = new ChatWorkNotifier();

  const envType = isHeadlessEnvironment() ? 'ヘッドレス環境（VPS）' : 'デスクトップ環境';

  console.log('='.repeat(60));
  console.log('🚀 2ndstreet VPS完全対応版監視システム起動');
  console.log('='.repeat(60));
  console.log(`🖥️  実行環境: ${envType}`);
  console.log(`📍 監視対象: ${URLS.length}サイト`);
  URLS.forEach(config => {
    console.log(`   - ${config.displayName} ${config.category} → ルーム ${config.roomId}`);
  });
  console.log(`⏱️  実行間隔: ${CONFIG.baseInterval}秒〜${CONFIG.slowInterval}秒（統計ベース）`);
  console.log(`😴 スリープ時間: ${CONFIG.sleepStartHour}時〜${CONFIG.sleepEndHour}時`);
  console.log(`🔒 一貫性チェック: ${CONFIG.consistencyCheckRetries}回試行`);
  if (CONFIG.useProxy) {
    console.log(`🌐 プロキシサーバー: ${CONFIG.proxies.length}個登録`);
  } else {
    console.log(`🌐 プロキシ無効化済み: VPSの直接IPを使用`);
  }
  console.log(`💾 スナップショット: ${CONFIG.snapshotFile}`);
  console.log(`📊 統計ファイル: ${CONFIG.statsFile}`);
  console.log('='.repeat(60));
  console.log('Ctrl+C で停止');
  console.log('='.repeat(60));

  while (true) {
    try {
      const currentHour = new Date().getHours();

      // スリープ時間帯チェック
      if (currentHour >= CONFIG.sleepStartHour && currentHour < CONFIG.sleepEndHour) {
        console.log(`\n😴 スリープ時間帯 (${currentHour}時) - 60秒待機\n`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        continue;
      }

      // スクレイピング実行
      await scrapeAllURLs(statsManager, snapshotManager, notifier);

      // 動的間隔計算
      const result = statsManager.getDynamicInterval();

      if (result === null) {
        continue; // スリープ時間帯
      }

      const { interval, reason } = result;

      // 統計表示（10回ごと）
      if (statsManager.stats.totalChecks % 10 === 0) {
        console.log('\n📊 統計情報:');
        console.log(`   チェック回数: ${statsManager.stats.totalChecks}回`);
        console.log(`   新着累計: ${statsManager.stats.totalNewItems}件`);
        console.log(`   エラー回数: ${statsManager.stats.errorCount}回`);

        const hourlyData = statsManager.stats.hourlyNewItems;
        const topHours = Object.entries(hourlyData)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        console.log(`   更新頻度TOP3: ${topHours.map(([h, c]) => `${h}時:${c}件`).join(', ')}`);
      }

      const nextRunTime = new Date(Date.now() + interval * 1000);
      const nextRunStr = nextRunTime.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

      console.log(`\n⏳ 次回実行: ${nextRunStr} (${interval / 60}分後・${reason})\n`);

      await new Promise(resolve => setTimeout(resolve, interval * 1000));

    } catch (error) {
      if (error.message === 'SIGINT') {
        console.log('\n⚠️  停止シグナル受信');
        break;
      }
      console.log(`\n❌ 予期しないエラー: ${error.message}`);
      console.error(error.stack);
      await statsManager.recordError();
      console.log('\n⏳ 60秒後に再試行...\n');
      await new Promise(resolve => setTimeout(resolve, 60000));
    }
  }

  console.log('\n✅ 監視システム終了');
}

// ==================== プロセス終了処理 ====================

process.on('SIGINT', () => {
  console.log('\n⚠️  Ctrl+C検出 - 安全に終了中...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️  SIGTERM受信 - 安全に終了中...');
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// ==================== 起動 ====================

if (require.main === module) {
  main().catch(error => {
    console.error('❌ 致命的エラー:', error);
    process.exit(1);
  });
}

module.exports = { StealthBrowser, SecondStreetScraper, StatsManager, SnapshotManager };