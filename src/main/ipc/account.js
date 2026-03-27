/**
 * Account IPC Handlers
 * Handles: Account CRUD, login, token, switch, credits, payment/bind-card
 */
const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// Module-local state
let batchTokenCancelled = false;

function isOperationAllowed(operation, state) {
  if (state.isForceUpdateActive || state.isMaintenanceModeActive || state.isApiUnavailable) {
    const allowedOperations = ['check-for-updates', 'open-download-url', 'get-file-paths'];
    if (!allowedOperations.includes(operation)) {
      console.log(`操作被阻止: ${operation} (状态: 强制更新=${state.isForceUpdateActive}, 维护=${state.isMaintenanceModeActive}, API不可用=${state.isApiUnavailable})`);
      return false;
    }
  }
  return true;
}

// 检测 Chrome 浏览器路径
function detectChromePath() {
  const fsSync = require('fs');
  const platform = os.platform();

  if (platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ];
    return paths.find(p => fsSync.existsSync(p)) || null;
  } else if (platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    ];
    return paths.find(p => fsSync.existsSync(p)) || null;
  }
  const paths = ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'];
  return paths.find(p => fsSync.existsSync(p)) || null;
}

// 浏览器方式获取支付链接（当API需要Captcha时的回退方案）
async function getPaymentLinkViaBrowser(email, password) {
  let browser = null;
  let page = null;
  const fsSync = require('fs');

  try {
    console.log('[绑卡链接-浏览器] 启动浏览器方式获取支付链接...');

    const connectOptions = {
      headless: false,
      fingerprint: true,
      turnstile: true,
      tf: true,
      timeout: 120000,
      userDataDir: path.join(os.tmpdir(), 'windsurf-tool-chrome', `bindcard_${Date.now()}`),
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-sync',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain'
      ]
    };

    const chromePath = detectChromePath();
    if (chromePath) {
      connectOptions.executablePath = chromePath;
    }

    console.log('[绑卡链接-浏览器] 正在启动 Chrome...');
    const { connect } = require('puppeteer-real-browser');
    const response = await connect(connectOptions);
    browser = response.browser;
    page = response.page;

    let capturedPaymentLink = null;

    page.on('response', async (res) => {
      try {
        if (res.url().includes('SubscribeToPlan') && res.status() === 200) {
          const buf = await res.buffer();
          const text = buf.toString('utf-8');
          if (text.includes('https://checkout.stripe.com')) {
            const start = text.indexOf('https://checkout.stripe.com');
            let end = start;
            while (end < text.length && text.charCodeAt(end) >= 32 && !' \n\r\t'.includes(text[end])) {
              end++;
            }
            capturedPaymentLink = text.substring(start, end);
            console.log('[绑卡链接-浏览器] 成功拦截到支付链接');
          }
        }
      } catch (e) { /* ignore */ }
    });

    // 1. 登录 Windsurf
    console.log('[绑卡链接-浏览器] 打开登录页面...');
    await page.goto('https://windsurf.com/account/login', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // 填写邮箱
    const emailInput = await page.$('input[type="email"], input[name="email"], input[id="email"]');
    if (emailInput) {
      await emailInput.click({ clickCount: 3 });
      await emailInput.type(email, { delay: 50 });
      console.log('[绑卡链接-浏览器] 已填写邮箱');
    } else {
      throw new Error('未找到邮箱输入框');
    }

    // 填写密码
    const passwordInput = await page.$('input[type="password"], input[name="password"]');
    if (passwordInput) {
      await passwordInput.click({ clickCount: 3 });
      await passwordInput.type(password, { delay: 50 });
      console.log('[绑卡链接-浏览器] 已填写密码');
    } else {
      throw new Error('未找到密码输入框');
    }

    // 等待 Turnstile 验证完成
    console.log('[绑卡链接-浏览器] 等待 Turnstile 验证...');
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const turnstileOk = await page.evaluate(() => {
        const iframe = document.querySelector('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]');
        if (!iframe) return 'no-turnstile';
        const input = document.querySelector('input[name="cf-turnstile-response"], [name="cf-turnstile-response"]');
        if (input && input.value) return 'solved';
        return 'pending';
      });
      console.log(`[绑卡链接-浏览器] Turnstile 状态: ${turnstileOk}`);
      if (turnstileOk === 'solved' || turnstileOk === 'no-turnstile') break;
    }

    // 点击登录按钮
    await new Promise(r => setTimeout(r, 1000));
    const loginClicked = await page.evaluate(() => {
      const submitBtn = document.querySelector('button[type="submit"]');
      if (submitBtn) { submitBtn.click(); return 'submit'; }
      const buttons = Array.from(document.querySelectorAll('button'));
      const keywords = ['log in', 'sign in', 'login', 'signin', 'continue'];
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase().trim();
        if (keywords.some(kw => text.includes(kw))) { btn.click(); return text; }
      }
      return null;
    });
    if (loginClicked) {
      console.log(`[绑卡链接-浏览器] 已点击登录按钮: "${loginClicked}"`);
    } else {
      await page.keyboard.press('Enter');
      console.log('[绑卡链接-浏览器] 使用回车提交登录');
    }

    // 等待登录完成
    console.log('[绑卡链接-浏览器] 等待登录跳转...');
    let loginSuccess = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const currentUrl = page.url();
      const bodyText = await page.evaluate(() => (document.body?.innerText || '').trim().substring(0, 100));
      console.log(`[绑卡链接-浏览器] URL: ${currentUrl} | 页面: ${bodyText.substring(0, 50)}`);

      if (!currentUrl.includes('/login')) {
        console.log('[绑卡链接-浏览器] 登录跳转成功');
        loginSuccess = true;
        break;
      }
      if (bodyText.toLowerCase().includes('redirecting')) {
        console.log('[绑卡链接-浏览器] 检测到 Redirecting，登录已成功，直接导航到计划页');
        loginSuccess = true;
        break;
      }
    }

    if (!loginSuccess) {
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 300) || '');
      console.log('[绑卡链接-浏览器] 登录可能失败，页面内容:', pageText.substring(0, 200));
      throw new Error('登录超时，可能验证码未通过或账号密码错误');
    }

    // 2. 导航到 pricing 页面
    await new Promise(r => setTimeout(r, 1000));
    console.log('[绑卡链接-浏览器] 打开 pricing 页面...');
    await page.goto('https://windsurf.com/pricing', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // 3. 点击 "Start Free Trial" 按钮
    console.log('[绑卡链接-浏览器] 查找 Start Free Trial 按钮...');
    for (let attempt = 0; attempt < 5; attempt++) {
      const trialClicked = await page.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
        const keywords = ['start free trial', 'start trial', 'free trial', 'try pro', 'try for free'];
        for (const el of allEls) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (keywords.some(kw => text.includes(kw))) {
            el.click();
            return text;
          }
        }
        return null;
      });
      if (trialClicked) {
        console.log(`[绑卡链接-浏览器] 已点击: "${trialClicked}"`);
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
      console.log(`[绑卡链接-浏览器] 未找到 Trial 按钮，重试 (${attempt + 2}/5)...`);
    }

    // 4. 等待 Captcha 弹窗出现，等 Turnstile 自动验证
    await new Promise(r => setTimeout(r, 3000));
    console.log('[绑卡链接-浏览器] 等待 Turnstile Captcha 验证...');
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));

      // 检查页面是否已跳转到 Stripe
      const currentUrl = page.url();
      if (currentUrl.includes('checkout.stripe.com')) {
        capturedPaymentLink = currentUrl;
        console.log('[绑卡链接-浏览器] 页面已跳转到 Stripe');
        break;
      }

      // 检查 Turnstile 状态
      const status = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const hasCaptchaText = body.includes('captcha') || body.includes('Captcha') || body.includes('complete the captcha');
        const iframe = document.querySelector('iframe[src*="turnstile"], iframe[src*="challenges.cloudflare.com"]');
        const solved = document.querySelector('input[name="cf-turnstile-response"]');
        const hasSolvedToken = solved && solved.value && solved.value.length > 10;
        return { hasCaptchaText, hasIframe: !!iframe, hasSolvedToken };
      });
      console.log(`[绑卡链接-浏览器] Captcha状态: ${JSON.stringify(status)}`);

      // Turnstile 已验证通过
      if (status.hasSolvedToken) {
        console.log('[绑卡链接-浏览器] Turnstile 已验证通过，等待 2 秒后点击 Continue...');
        await new Promise(r => setTimeout(r, 2000));
        
        for (let clickAttempt = 0; clickAttempt < 3; clickAttempt++) {
          const continueClicked = await page.evaluate(() => {
            const allEls = Array.from(document.querySelectorAll('button, a, [role="button"]'));
            const keywords = ['continue', 'submit', 'proceed', 'confirm'];
            for (const el of allEls) {
              const text = (el.textContent || '').toLowerCase().trim();
              if (keywords.some(kw => text === kw || text.includes(kw)) && !el.disabled) {
                el.click();
                return text;
              }
            }
            return null;
          });
          if (continueClicked) {
            console.log(`[绑卡链接-浏览器] 已点击: "${continueClicked}" (第${clickAttempt + 1}次)`);
          }
          await new Promise(r => setTimeout(r, 2000));
          
          const url = page.url();
          if (url.includes('checkout.stripe.com')) {
            capturedPaymentLink = url;
            break;
          }
        }
        await new Promise(r => setTimeout(r, 3000));
        const afterUrl = page.url();
        if (afterUrl.includes('checkout.stripe.com')) {
          capturedPaymentLink = afterUrl;
          console.log('[绑卡链接-浏览器] 成功跳转到 Stripe');
        }
        break;
      }
    }

    // 如果还没拿到，再等一会看网络拦截
    if (!capturedPaymentLink) {
      console.log('[绑卡链接-浏览器] 继续等待 Stripe 链接...');
      for (let i = 0; i < 10 && !capturedPaymentLink; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const currentUrl = page.url();
        if (currentUrl.includes('checkout.stripe.com')) {
          capturedPaymentLink = currentUrl;
          console.log('[绑卡链接-浏览器] 检测到 Stripe 跳转');
          break;
        }
      }
    }

    if (capturedPaymentLink) {
      console.log('[绑卡链接-浏览器] 成功获取支付链接');
      return { success: true, paymentLink: capturedPaymentLink };
    }

    return { success: false, error: '浏览器方式超时：未能获取到支付链接，请手动操作' };

  } catch (error) {
    console.error('[绑卡链接-浏览器] 失败:', error.message);
    return { success: false, error: `浏览器方式失败: ${error.message}` };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
    // 清理临时目录
    try {
      const fsSync = require('fs');
      const tmpDirs = fsSync.readdirSync(path.join(os.tmpdir(), 'windsurf-tool-chrome'));
      for (const dir of tmpDirs) {
        if (dir.startsWith('bindcard_')) {
          fsSync.rmSync(path.join(os.tmpdir(), 'windsurf-tool-chrome', dir), { recursive: true, force: true });
        }
      }
    } catch (e) { /* ignore */ }
  }
}

function registerHandlers(mainWindow, deps) {
  const { ACCOUNTS_FILE, accountsFileLock, appRoot, state, accountService } = deps;

  // ==================== 账号 CRUD ====================

  // 读取账号列表
  ipcMain.handle('get-accounts', async () => {
    try {
      const accounts = await accountService.getAll();
      console.log(`📖 读取账号列表: ${accounts.length} 个账号`);
      return { success: true, accounts };
    } catch (error) {
      console.error('读取账号文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 读取账号列表（别名，用于兼容）
  ipcMain.handle('load-accounts', async () => {
    try {
      const accounts = await accountService.getAll();
      return { success: true, accounts };
    } catch (error) {
      console.error('读取账号文件失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 添加账号
  ipcMain.handle('add-account', async (event, account) => {
    if (!isOperationAllowed('add-account', state)) {
      return { success: false, error: '当前状态下无法执行此操作' };
    }

    try {
      if (!account || !account.email || !account.password) {
        return { success: false, error: '账号数据不完整，缺少邮箱或密码' };
      }

      const accountsFilePath = path.normalize(ACCOUNTS_FILE);
      let accounts = await accountService.getAll();

      if (!Array.isArray(accounts)) {
        console.warn('账号文件格式错误，尝试从备份恢复');
        try {
          const backupData = await fs.readFile(accountsFilePath + '.backup', 'utf-8');
          accounts = JSON.parse(backupData);
          console.log('已从备份恢复账号数据');
        } catch (backupError) {
          console.error('备份文件也损坏，重置为空数组');
          accounts = [];
        }
      }

      const normalizedEmail = account.email.toLowerCase().trim();
      const existingAccount = accounts.find(acc =>
        acc.email && acc.email.toLowerCase().trim() === normalizedEmail
      );
      if (existingAccount) {
        return { success: false, error: `账号 ${account.email} 已存在` };
      }

      account.id = Date.now().toString();
      account.createdAt = new Date().toISOString();
      accounts.push(account);

      if (accounts.length > 0) {
        try {
          await fs.writeFile(accountsFilePath + '.backup', JSON.stringify(accounts, null, 2), { encoding: 'utf-8' });
        } catch (backupError) {
          console.warn('创建备份失败:', backupError.message);
        }
      }

      await accountService.save(accounts);
      console.log(`账号已添加: ${account.email} (总数: ${accounts.length})`);

      return { success: true, account };
    } catch (error) {
      console.error('添加账号失败:', error);
      return { success: false, error: `添加失败: ${error.message}` };
    }
  });

  // 更新账号
  ipcMain.handle('update-account', async (event, accountUpdate) => {
    try {
      let accounts = await accountService.getAll();

      if (!Array.isArray(accounts)) {
        return { success: false, error: '账号文件格式错误' };
      }

      const index = accounts.findIndex(acc => acc.id === accountUpdate.id);
      if (index === -1) {
        return { success: false, error: '账号不存在' };
      }

      accounts[index] = { ...accounts[index], ...accountUpdate, updatedAt: new Date().toISOString() };

      await accountService.save(accounts);
      console.log(`账号已更新: ${accounts[index].email} (总数: ${accounts.length})`);

      return {
        success: true,
        message: '账号更新成功',
        account: accounts[index]
      };
    } catch (error) {
      console.error('更新账号失败:', error);
      return { success: false, error: `更新失败: ${error.message}` };
    }
  });

  // 更新账号密码 - 仅修改本地保存的密码
  ipcMain.handle('update-account-password', async (event, { accountId, newPassword }) => {
    try {
      let accounts = await accountService.getAll();

      if (!Array.isArray(accounts)) {
        return { success: false, error: '账号文件格式错误' };
      }

      const index = accounts.findIndex(acc => acc.id === accountId);
      if (index === -1) {
        return { success: false, error: '账号不存在' };
      }

      accounts[index].password = newPassword;
      accounts[index].updatedAt = new Date().toISOString();

      await accountService.save(accounts);
      console.log(`账号密码已更新: ${accounts[index].email}`);

      return { success: true, message: '密码修改成功' };
    } catch (error) {
      console.error('修改密码失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 更新账号备注
  ipcMain.handle('update-account-note', async (event, accountId, note) => {
    try {
      let accounts = await accountService.getAll();

      if (!Array.isArray(accounts)) {
        return { success: false, error: '账号文件格式错误' };
      }

      const index = accounts.findIndex(acc => acc.id === accountId);
      if (index === -1) {
        return { success: false, error: '账号不存在' };
      }

      accounts[index].note = note;
      accounts[index].updatedAt = new Date().toISOString();

      await accountService.save(accounts);
      console.log(`账号备注已更新: ${accounts[index].email} -> ${note || '(空)'}`);

      return { success: true, message: '备注保存成功' };
    } catch (error) {
      console.error('保存备注失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 删除账号
  ipcMain.handle('delete-account', async (event, accountId) => {
    if (!isOperationAllowed('delete-account', state)) {
      return { success: false, error: '当前状态下无法执行此操作' };
    }

    try {
      let accounts = await accountService.getAll();

      if (!Array.isArray(accounts)) {
        return { success: false, error: '账号文件格式错误' };
      }

      const index = accounts.findIndex(acc => acc.id === accountId);
      if (index === -1) {
        return { success: false, error: '账号不存在' };
      }

      const deletedEmail = accounts[index].email;
      accounts.splice(index, 1);

      await accountService.save(accounts);
      console.log(`账号已删除: ${deletedEmail} (剩余: ${accounts.length})`);

      return { success: true };
    } catch (error) {
      console.error('删除账号失败:', error);
      return { success: false, error: `删除失败: ${error.message}` };
    }
  });

  // 删除全部账号
  ipcMain.handle('delete-all-accounts', async () => {
    try {
      let oldCount = 0;
      try {
        const accounts = await accountService.getAll();
        oldCount = accounts.length;
      } catch (e) {
        // 忽略读取错误
      }

      await accountService.deleteAll();
      console.log(`已删除全部账号 (共 ${oldCount} 个)`);
      return { success: true };
    } catch (error) {
      console.error('删除全部账号失败:', error);
      return { success: false, error: `删除失败: ${error.message}` };
    }
  });

  // ==================== 积分/Token ====================

  // 刷新账号积分信息
  ipcMain.handle('refresh-account-credits', async (event, account) => {
    try {
      console.log(`[刷新积分] 开始刷新账号 ${account.email} 的积分信息...`);
      
      const AccountQuery = require(path.join(appRoot, 'js', 'accountQuery'));
      const CONSTANTS = require(path.join(appRoot, 'js', 'constants'));
      const axios = require('axios');
      
      if (!account.refreshToken) {
        return { success: false, error: '账号缺少 refreshToken，无法刷新' };
      }
      
      let accessToken;
      let newTokenData = null;
      const now = Date.now();
      const tokenExpired = !account.idToken || !account.idTokenExpiresAt || now >= account.idTokenExpiresAt;
      
      if (tokenExpired) {
        console.log(`[刷新积分] Token已过期，正在刷新...`);
        try {
          const response = await axios.post(
            CONSTANTS.WORKER_URL,
            {
              grant_type: 'refresh_token',
              refresh_token: account.refreshToken,
              api_key: CONSTANTS.FIREBASE_API_KEY
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              timeout: CONSTANTS.REQUEST_TIMEOUT
            }
          );
          
          accessToken = response.data.id_token;
          newTokenData = {
            idToken: response.data.id_token,
            idTokenExpiresAt: now + (parseInt(response.data.expires_in) * 1000),
            refreshToken: response.data.refresh_token
          };
          console.log(`[刷新积分] Token刷新成功`);
        } catch (tokenError) {
          console.error(`[刷新积分] Token刷新失败:`, tokenError.message);
          
          if (account.email && account.password) {
            console.log(`[刷新积分] 尝试使用邮箱密码重新登录...`);
            const AccountLogin = require(path.join(appRoot, 'js', 'accountLogin'));
            const loginBot = new AccountLogin();
            
            const loginResult = await loginBot.loginAndGetTokens({ 
              email: account.email, 
              password: account.password 
            });
            
            if (loginResult.success && loginResult.account) {
              accessToken = loginResult.account.idToken;
              newTokenData = {
                idToken: loginResult.account.idToken,
                idTokenExpiresAt: loginResult.account.idTokenExpiresAt,
                refreshToken: loginResult.account.refreshToken,
                apiKey: loginResult.account.apiKey,
                name: loginResult.account.name,
                apiServerUrl: loginResult.account.apiServerUrl
              };
              console.log(`[刷新积分] 重新登录成功`);
            } else {
              throw new Error(loginResult.error || '重新登录失败');
            }
          } else {
            throw new Error(`Token刷新失败: ${tokenError.message}`);
          }
        }
      } else {
        accessToken = account.idToken;
        console.log(`[刷新积分] 使用本地Token`);
      }
      
      console.log(`[刷新积分] 正在查询账号使用情况...`);
      const usageResponse = await axios.post(
        'https://web-backend.windsurf.com/exa.seat_management_pb.SeatManagementService/GetPlanStatus',
        { auth_token: accessToken },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': accessToken,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'x-client-version': 'Chrome/JsCore/11.0.0/FirebaseCore-web'
          },
          timeout: CONSTANTS.REQUEST_TIMEOUT
        }
      );
      
      const planStatus = usageResponse.data.planStatus || usageResponse.data;
      const promptCredits = Math.round((planStatus.availablePromptCredits || 0) / 100);
      const flowCredits = Math.round((planStatus.availableFlowCredits || 0) / 100);
      const flexCredits = Math.round((planStatus.availableFlexCredits || 0) / 100);
      const totalCredits = promptCredits + flowCredits + flexCredits;
      const usedPromptCredits = Math.round((planStatus.usedPromptCredits || 0) / 100);
      const monthlyFlowCredits = planStatus.planInfo?.monthlyFlowCredits || 0;
      const usedFlowCredits = Math.round(Math.max(0, monthlyFlowCredits - (planStatus.availableFlowCredits || 0)) / 100);
      const usedFlexCredits = Math.round((planStatus.usedFlexCredits || 0) / 100);
      const usedUsageCredits = Math.round((planStatus.usedUsageCredits || 0) / 100);
      const usedCredits = usedPromptCredits + usedFlowCredits + usedFlexCredits + usedUsageCredits;
      const usagePercentage = totalCredits > 0 ? Math.round((usedCredits / totalCredits) * 100) : 0;
      const planName = planStatus.planInfo?.planName || 'Free';
      const expiresAt = planStatus.planEnd || planStatus.expiresAt || null;
      
      console.log(`[刷新积分] 查询成功: ${planName}, 积分: ${totalCredits}, 使用率: ${usagePercentage}%`);
      
      const updateData = {
        id: account.id,
        type: planName,
        credits: totalCredits,
        usedCredits: usedCredits,
        totalCredits: totalCredits,
        usage: usagePercentage,
        queryUpdatedAt: new Date().toISOString()
      };
      
      if (expiresAt) {
        updateData.expiresAt = expiresAt;
      }
      
      if (newTokenData) {
        updateData.idToken = newTokenData.idToken;
        updateData.idTokenExpiresAt = newTokenData.idTokenExpiresAt;
        updateData.refreshToken = newTokenData.refreshToken;
        if (newTokenData.apiKey) updateData.apiKey = newTokenData.apiKey;
        if (newTokenData.name) updateData.name = newTokenData.name;
        if (newTokenData.apiServerUrl) updateData.apiServerUrl = newTokenData.apiServerUrl;
      }
      
      await accountService.update(account.id, updateData);
      
      return {
        success: true,
        subscriptionType: planName,
        credits: totalCredits,
        usedCredits: usedCredits,
        usage: usagePercentage,
        expiresAt: expiresAt,
        message: '账号信息已刷新'
      };
    } catch (error) {
      console.error('刷新账号信息失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  // 复制到剪贴板
  ipcMain.handle('copy-to-clipboard', async (event, text) => {
    try {
      const { clipboard } = require('electron');
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      console.error('复制到剪贴板失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 批量获取所有账号Token
  ipcMain.handle('batch-get-all-tokens', async (event) => {
    try {
      console.log('[批量获取Token] 开始批量获取所有账号Token...');
      batchTokenCancelled = false;
      
      const accountsFilePath = path.normalize(ACCOUNTS_FILE);
      const accounts = await accountService.getAll();
      
      const now = Date.now();
      const accountsNeedToken = [];
      const accountsSkipped = [];
      
      accounts.forEach(acc => {
        if (!acc.email || !acc.password) return;
        const tokenExpired = !acc.idToken || !acc.idTokenExpiresAt || now >= acc.idTokenExpiresAt;
        if (tokenExpired) {
          accountsNeedToken.push(acc);
          const reason = !acc.idToken ? 'Token不存在' : !acc.idTokenExpiresAt ? '缺少过期时间' : 'Token已过期';
          console.log(`[批量获取Token] ${acc.email} - ${reason}`);
        } else {
          accountsSkipped.push(acc);
          const expiresIn = Math.round((acc.idTokenExpiresAt - now) / 1000 / 60);
          console.log(`[批量获取Token] ⊘ ${acc.email} - Token有效 (${expiresIn}分钟后过期)`);
        }
      });
      
      if (accountsNeedToken.length === 0) {
        return {
          success: false,
          error: `没有需要获取Token的账号（${accountsSkipped.length}个账号Token都有效）`
        };
      }
      
      console.log(`[批量获取Token] 需要获取: ${accountsNeedToken.length}个, 跳过: ${accountsSkipped.length}个`);
      
      const AccountLogin = require(path.join(appRoot, 'js', 'accountLogin'));
      const results = [];
      let successCount = 0;
      let failCount = 0;
      
      for (let i = 0; i < accountsNeedToken.length; i++) {
        if (batchTokenCancelled) {
          console.log('[批量获取Token] 用户取消操作');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('batch-token-complete', {
              total: accountsNeedToken.length, successCount, failCount, cancelled: true, results
            });
          }
          break;
        }
        
        const account = accountsNeedToken[i];
        
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('batch-token-progress', {
            current: i + 1, total: accountsNeedToken.length, email: account.email, status: 'processing'
          });
        }
        
        try {
          console.log(`[批量获取Token] [${i + 1}/${accountsNeedToken.length}] 处理账号: ${account.email}`);
          const loginBot = new AccountLogin();
          
          const logCallback = (message) => {
            console.log(`[批量获取Token] [${account.email}] ${message}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('batch-token-log', { email: account.email, message });
            }
          };
          
          const result = await loginBot.loginAndGetTokens(account, logCallback);
          
          if (result.success && result.account) {
            const index = accounts.findIndex(acc => acc.id === account.id || acc.email === account.email);
            if (index !== -1) {
              const safeAccountData = {
                email: result.account.email || '',
                name: result.account.name || '',
                apiKey: result.account.apiKey || '',
                refreshToken: result.account.refreshToken || '',
                idToken: result.account.idToken || '',
                idTokenExpiresAt: result.account.idTokenExpiresAt || 0,
                apiServerUrl: result.account.apiServerUrl || ''
              };
              accounts[index] = {
                ...accounts[index],
                ...safeAccountData,
                id: accounts[index].id,
                createdAt: accounts[index].createdAt
              };
            }
            
            successCount++;
            results.push({ email: account.email, success: true });
            
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('batch-token-progress', {
                current: i + 1, total: accountsNeedToken.length, email: account.email, status: 'success'
              });
            }
            console.log(`[批量获取Token] [${i + 1}/${accountsNeedToken.length}] 成功: ${account.email}`);
          } else {
            failCount++;
            results.push({ email: account.email, success: false, error: result.error });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('batch-token-progress', {
                current: i + 1, total: accountsNeedToken.length, email: account.email, status: 'failed', error: result.error
              });
            }
            console.log(`[批量获取Token] [${i + 1}/${accountsNeedToken.length}] 失败: ${account.email} - ${result.error}`);
          }
          
          if (i < accountsNeedToken.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } catch (error) {
          failCount++;
          results.push({ email: account.email, success: false, error: error.message });
          console.error(`[批量获取Token] [${i + 1}/${accountsNeedToken.length}] 异常: ${account.email}`, error);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('batch-token-progress', {
              current: i + 1, total: accountsNeedToken.length, email: account.email, status: 'failed', error: error.message
            });
          }
        }
      }
      
      await accountService.save(accounts);
      console.log(`[批量获取Token] 账号列表已更新到文件`);
      
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('batch-token-complete', {
          total: accountsNeedToken.length, successCount, failCount, results
        });
      }
      
      console.log(`[批量获取Token] 完成！成功: ${successCount}, 失败: ${failCount}, 取消: ${batchTokenCancelled}`);
      
      return {
        success: true,
        cancelled: batchTokenCancelled,
        total: accountsNeedToken.length,
        successCount, failCount, results
      };
    } catch (error) {
      console.error('[批量获取Token] 失败:', error);
      return { success: false, cancelled: batchTokenCancelled, error: error.message };
    }
  });

  // 取消批量获取Token
  ipcMain.handle('cancel-batch-get-tokens', async () => {
    console.log('[批量获取Token] 收到取消请求');
    batchTokenCancelled = true;
    return { success: true };
  });

  // ==================== 登录/Token获取 ====================

  // 获取当前登录信息（从 vscdb 读取）
  ipcMain.handle('get-current-login', async () => {
    try {
      const { AccountSwitcher } = require(path.join(appRoot, 'js', 'accountSwitcher'));
      const account = await AccountSwitcher.getCurrentAccount();
      
      if (account) {
        return {
          success: true,
          email: account.email,
          name: account.name,
          apiKey: account.apiKey,
          planName: account.planName
        };
      }
      
      return { success: false };
    } catch (error) {
      console.error('获取当前登录信息失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 登录并获取 Token（用于导入的账号）
  ipcMain.handle('login-and-get-tokens', async (event, account) => {
    try {
      const { email, password, id } = account;
      
      if (!email || !password) {
        return { success: false, error: '邮箱或密码不能为空' };
      }
      
      console.log(`[登录获取Token] 开始为账号 ${email} 获取 Token...`);
      
      const AccountLogin = require(path.join(appRoot, 'js', 'accountLogin'));
      const loginBot = new AccountLogin();
      
      const logCallback = (message) => {
        console.log(`[登录获取Token] ${message}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('login-log', message);
        }
      };
      
      const result = await loginBot.loginAndGetTokens(account, logCallback);
      
      if (result.success && result.account) {
        const accountsFilePath = path.normalize(ACCOUNTS_FILE);
        const accounts = await accountService.getAll();

        const index = accounts.findIndex(acc => acc.id === id || acc.email === email);
        if (index !== -1) {
          accounts[index] = {
            ...accounts[index],
            ...result.account,
            id: accounts[index].id,
            createdAt: accounts[index].createdAt
          };

          await accountService.save(accounts);
          console.log(`[登录获取Token] 账号 ${email} 的 Token 已更新到文件`);
        }
      }
      
      return result;
    } catch (error) {
      console.error('[登录获取Token] 失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 获取账号Token（统一使用AccountLogin模块）
  ipcMain.handle('get-account-token', async (event, credentials) => {
    try {
      const { email, password } = credentials;
      
      if (!email || !password) {
        return { success: false, error: '邮箱或密码不能为空' };
      }
      
      console.log(`开始获取账号 ${email} 的token...`);
      console.log(`当前平台: ${process.platform}`);
      
      const AccountLogin = require(path.join(appRoot, 'js', 'accountLogin'));
      const loginBot = new AccountLogin();
      
      const logCallback = (message) => {
        console.log(`[Token获取] ${message}`);
      };
      
      const result = await loginBot.loginAndGetTokens({ email, password }, logCallback);
      
      if (result.success && result.account) {
        const safeAccount = JSON.parse(JSON.stringify({
          email: result.account.email || '',
          name: result.account.name || '',
          apiKey: result.account.apiKey || '',
          refreshToken: result.account.refreshToken || '',
          idToken: result.account.idToken || '',
          idTokenExpiresAt: result.account.idTokenExpiresAt || 0,
          apiServerUrl: result.account.apiServerUrl || ''
        }));
        
        return {
          success: true,
          token: safeAccount.apiKey,
          email: safeAccount.email,
          password: password,
          username: safeAccount.name,
          apiKey: safeAccount.apiKey,
          refreshToken: safeAccount.refreshToken,
          account: safeAccount
        };
      }
      
      return result;
    } catch (error) {
      console.error('获取token失败:', error);
      return { success: false, error: error.message };
    }
  });

  // ==================== 账号切换 ====================

  // 切换账号
  ipcMain.handle('switch-account', async (event, account) => {
    if (!isOperationAllowed('switch-account', state)) {
      return { success: false, error: '当前状态下无法执行此操作' };
    }
    try {
      const { AccountSwitcher } = require(path.join(appRoot, 'js', 'accountSwitcher'));
      
      const result = await AccountSwitcher.switchAccount(account, (log) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('switch-log', log);
        }
      });
      
      return result;
    } catch (error) {
      console.error('切换账号失败:', error);
      return { success: false, error: error.message };
    }
  });

  // 获取当前 Windsurf 登录的账号
  ipcMain.handle('get-current-windsurf-account', async () => {
    try {
      const CurrentAccountDetector = require(path.join(appRoot, 'js', 'currentAccountDetector'));
      const account = await CurrentAccountDetector.getCurrentAccount();
      return account;
    } catch (error) {
      console.error('获取当前 Windsurf 账号失败:', error);
      return null;
    }
  });

  // ==================== 支付/绑卡 ====================

  // 获取绑卡/支付链接
  ipcMain.handle('get-payment-link', async (event, { email, password }) => {
    const axios = require('axios');
    const CONSTANTS = require(path.join(appRoot, 'js', 'constants'));
    
    const FIREBASE_LOGIN_URL = CONSTANTS.WORKER_URL + '/login';
    const WINDSURF_API_BASE = 'https://web-backend.windsurf.com';
    const PRICE_ID = 'price_1NuJObFKuRRGjKOFJVUbaIsJ';
    const SUCCESS_URL = 'https://windsurf.com/billing/payment-success?plan_tier=pro';
    const CANCEL_URL = 'https://windsurf.com/plan?plan_cancelled=true&plan_tier=pro';
    
    function encodeVarint(value) {
      const result = [];
      while (value > 0x7f) {
        result.push((value & 0x7f) | 0x80);
        value = value >>> 7;
      }
      result.push(value & 0x7f);
      return Buffer.from(result);
    }
    
    function encodeStringField(fieldNumber, value) {
      const tag = (fieldNumber << 3) | 2;
      const data = Buffer.from(value, 'utf-8');
      return Buffer.concat([Buffer.from([tag]), encodeVarint(data.length), data]);
    }
    
    function encodeVarintField(fieldNumber, value) {
      const tag = (fieldNumber << 3) | 0;
      return Buffer.concat([Buffer.from([tag]), encodeVarint(value)]);
    }
    
    try {
      console.log(`[绑卡链接] 开始获取账号 ${email} 的支付链接...`);
      
      const FIREBASE_DIRECT_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONSTANTS.FIREBASE_API_KEY}`;
      const loginAttempts = [
        { name: 'Firebase 直连', url: FIREBASE_DIRECT_URL, body: { email, password, returnSecureToken: true } },
        { name: '中转服务器', url: FIREBASE_LOGIN_URL, body: { email, password, api_key: CONSTANTS.FIREBASE_API_KEY, returnSecureToken: true } }
      ];
      
      let loginResponse = null;
      let lastLoginError = null;
      
      for (const attempt of loginAttempts) {
        try {
          console.log(`[绑卡链接] 尝试 ${attempt.name}...`);
          loginResponse = await axios.post(attempt.url, attempt.body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
          });
          if (loginResponse.status === 200 && loginResponse.data.idToken) {
            console.log(`[绑卡链接] ${attempt.name} 登录成功`);
            break;
          }
          loginResponse = null;
        } catch (err) {
          const isNetworkError = err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET';
          console.log(`[绑卡链接] ${attempt.name} 失败: ${err.message}${isNetworkError ? '，尝试下一个' : ''}`);
          lastLoginError = err;
          if (isNetworkError) continue;
          throw err;
        }
      }
      
      if (!loginResponse || !loginResponse.data.idToken) {
        return { success: false, error: '登录失败，请检查账号密码' };
      }
      
      const idToken = loginResponse.data.idToken;
      console.log(`[绑卡链接] 登录成功`);
      
      const protobufData1 = encodeStringField(1, idToken);
      try {
        await axios.post(
          `${WINDSURF_API_BASE}/exa.seat_management_pb.SeatManagementService/GetCurrentUser`,
          protobufData1,
          {
            headers: {
              'Content-Type': 'application/proto',
              'connect-protocol-version': '1',
              'Origin': 'https://windsurf.com'
            },
            timeout: 30000
          }
        );
        console.log(`[绑卡链接] 获取用户信息成功`);
      } catch (e) {
        console.error(`[绑卡链接] 步骤2-获取用户信息失败: ${e.response?.status || e.message}`, e.response?.data ? Buffer.from(e.response.data).toString('utf-8').substring(0, 200) : '');
        throw e;
      }
      
      try {
        await axios.post(
          `${WINDSURF_API_BASE}/exa.seat_management_pb.SeatManagementService/GetPreapprovalForUser`,
          protobufData1,
          {
            headers: {
              'Content-Type': 'application/proto',
              'connect-protocol-version': '1',
              'Origin': 'https://windsurf.com'
            },
            timeout: 30000
          }
        );
        console.log(`[绑卡链接] 获取预批准成功`);
      } catch (e) {
        console.error(`[绑卡链接] 步骤3-获取预批准失败: ${e.response?.status || e.message}`, e.response?.data ? Buffer.from(e.response.data).toString('utf-8').substring(0, 200) : '');
        throw e;
      }
      
      const subscribeData = Buffer.concat([
        encodeStringField(1, idToken),
        encodeStringField(2, PRICE_ID),
        encodeStringField(4, SUCCESS_URL),
        encodeStringField(5, CANCEL_URL),
        encodeVarintField(8, 2),
        encodeVarintField(9, 1)
      ]);
      
      const subscribeResponse = await axios.post(
        `${WINDSURF_API_BASE}/exa.seat_management_pb.SeatManagementService/SubscribeToPlan`,
        subscribeData,
        {
          headers: {
            'Content-Type': 'application/proto',
            'connect-protocol-version': '1',
            'Origin': 'https://windsurf.com'
          },
          timeout: 30000,
          responseType: 'arraybuffer'
        }
      );
      
      if (subscribeResponse.status !== 200) {
        return { success: false, error: '获取支付链接失败（可能已是Pro账号）' };
      }
      
      let responseText;
      try {
        responseText = Buffer.from(subscribeResponse.data).toString('base64');
        responseText = Buffer.from(responseText, 'base64').toString('utf-8');
      } catch {
        responseText = Buffer.from(subscribeResponse.data).toString('utf-8');
      }
      
      const rawText = Buffer.from(subscribeResponse.data).toString('utf-8');
      
      if (rawText.includes('https://checkout.stripe.com')) {
        const start = rawText.indexOf('https://checkout.stripe.com');
        let end = start;
        while (end < rawText.length && rawText.charCodeAt(end) >= 32 && !' \n\r\t'.includes(rawText[end])) {
          end++;
        }
        const paymentLink = rawText.substring(start, end);
        console.log(`[绑卡链接] 成功获取支付链接`);
        return { success: true, paymentLink };
      }
      
      return { success: false, error: '未找到支付链接（可能已是Pro账号）' };
      
    } catch (error) {
      const errStatus = error.response?.status || 'N/A';
      const errBody = error.response?.data ? Buffer.from(error.response.data).toString('utf-8').substring(0, 300) : '';
      console.error(`[绑卡链接] 获取失败: ${error.message} | HTTP ${errStatus} | ${errBody}`);
      
      if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ECONNRESET') {
        return { 
          success: false, 
          error: '网络连接失败，请尝试：\n1. 关闭代理/VPN 后重试\n2. 或更换代理节点\n3. 检查网络连接是否正常' 
        };
      }
      
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        return { 
          success: false, 
          error: '连接超时，请尝试：\n1. 关闭代理/VPN 后重试\n2. 或更换代理节点\n3. 稍后再试' 
        };
      }
      
      if (error.response) {
        if (error.response.status === 409) {
          return { success: false, error: '该账号已开通过试用Pro，无法再次获取绑卡链接' };
        }
        if (error.response.status === 400) {
          const errBodyStr = error.response.data ? Buffer.from(error.response.data).toString('utf-8') : '';
          if (errBodyStr.includes('captcha required')) {
            console.log('[绑卡链接] 需要Captcha验证，自动切换到浏览器方式获取支付链接...');
            try {
              const browserResult = await getPaymentLinkViaBrowser(email, password);
              return browserResult;
            } catch (browserError) {
              console.error('[绑卡链接] 浏览器方式也失败:', browserError.message);
              return { success: false, error: `需要Captcha验证，浏览器方式也失败: ${browserError.message}` };
            }
          }
          return { success: false, error: '账号已是Pro，无需绑卡' };
        }
      }
      return { success: false, error: error.message };
    }
  });

  // 自动填写支付表单
  ipcMain.handle('auto-fill-payment', async (event, { paymentLink, card, billing }) => {
    let browser = null;
    
    try {
      console.log('[自动填写] 开始自动填写支付表单...');
      
      const fsSync = require('fs');
      
      let puppeteer;
      try {
        const resourcesPath = process.resourcesPath || path.join(appRoot, '..');
        const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'rebrowser-puppeteer-core');
        if (fsSync.existsSync(unpackedPath)) {
          puppeteer = require(unpackedPath);
        } else {
          puppeteer = require('rebrowser-puppeteer-core');
        }
      } catch (e) {
        try {
          puppeteer = require('puppeteer-core');
        } catch (e2) {
          return { success: false, error: '未安装 puppeteer，请检查依赖是否完整' };
        }
      }
      const platform = os.platform();
      
      let chromePath = null;
      if (platform === 'darwin') {
        const possiblePaths = [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
        ];
        chromePath = possiblePaths.find(p => fsSync.existsSync(p));
      } else if (platform === 'win32') {
        const possiblePaths = [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
        ];
        chromePath = possiblePaths.find(p => fsSync.existsSync(p));
      } else {
        const possiblePaths = [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium'
        ];
        chromePath = possiblePaths.find(p => fsSync.existsSync(p));
      }
      
      if (!chromePath) {
        return { success: false, error: '未找到 Chrome 浏览器，请确保已安装' };
      }
      
      console.log('[自动填写] Chrome 路径:', chromePath);
      
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: false,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-infobars',
          '--start-maximized'
        ]
      });
      
      const page = await browser.newPage();
      const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      const sendLog = (msg) => {
        console.log(msg);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto-fill-log', msg);
        }
      };
      
      sendLog('[自动填写] 打开支付页面...');
      await page.goto(paymentLink, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      sendLog('[自动填写] 等待页面完全加载...');
      await delay(2000);

      sendLog('[自动填写] 等待支付表单加载...');
      try {
        await page.waitForSelector('button[data-testid="card-accordion-item-button"]', { timeout: 15000, visible: true });
        sendLog('[自动填写] 支付表单已加载');
      } catch (e) {
        sendLog('[自动填写] 等待超时，继续尝试...');
      }

      await delay(1000);
      
      sendLog('[自动填写] 点击银行卡选项...');
      try {
        const clicked = await page.evaluate(() => {
          const selectors = [
            'button[data-testid="card-accordion-item-button"]',
            'button[aria-label*="银行卡"]',
            'button[aria-label*="Card"]',
            '[class*="Accordion"] button',
            'input[type="radio"][value*="card"]',
            'label:has(input[type="radio"])',
          ];
          
          for (const sel of selectors) {
            try {
              const el = document.querySelector(sel);
              if (el) { el.click(); return sel; }
            } catch (e) {}
          }
          
          const allElements = document.querySelectorAll('button, div[role="button"], label, [class*="Accordion"]');
          for (const el of allElements) {
            if (el.textContent && el.textContent.includes('银行卡')) {
              el.click();
              return 'text:银行卡';
            }
          }
          return null;
        });
        
        if (clicked) {
          sendLog(`[自动填写] 已点击: ${clicked}`);
        } else {
          sendLog('[自动填写] 未找到银行卡选项，尝试直接填写');
        }
        await delay(1500);
      } catch (e) {
        sendLog('[自动填写] 点击失败: ' + e.message);
      }
      
      await delay(1500);
      
      sendLog('[自动填写] 填写卡片信息...');
      
      let cardFilled = false, expFilled = false, cvvFilled = false;

      const cardSelectors = [
        'input[name="cardnumber"]', 'input[autocomplete="cc-number"]',
        'input[data-elements-stable-field-name="cardNumber"]',
        'input[name="number"]', 'input[placeholder*="card number" i]',
        'input[placeholder*="1234" i]', 'input[aria-label*="Card number" i]'
      ];
      const expSelectors = [
        'input[name="exp-date"]', 'input[autocomplete="cc-exp"]',
        'input[data-elements-stable-field-name="cardExpiry"]',
        'input[name="expiry"]', 'input[placeholder*="MM" i]',
        'input[aria-label*="expir" i]'
      ];
      const cvvSelectors = [
        'input[name="cvc"]', 'input[autocomplete="cc-csc"]',
        'input[data-elements-stable-field-name="cardCvc"]',
        'input[name="cvv"]', 'input[placeholder*="CVC" i]',
        'input[placeholder*="CVV" i]', 'input[aria-label*="CVC" i]',
        'input[aria-label*="security code" i]'
      ];

      for (let retry = 0; retry < 3; retry++) {
        const frames = page.frames();
        sendLog(`[自动填写] 第${retry + 1}次尝试，找到 ${frames.length} 个 frame`);
        
        for (const frame of frames) {
          try {
            const frameUrl = frame.url();
            if (!cardFilled) {
              for (const sel of cardSelectors) {
                try {
                  const el = await frame.$(sel);
                  if (el) {
                    await el.click();
                    await delay(200);
                    for (const ch of card.cardNumber) {
                      await el.type(ch, { delay: 30 });
                    }
                    sendLog(`[自动填写] ✓ 卡号已填写 (frame: ${frameUrl.substring(0, 60)})`);
                    cardFilled = true;
                    break;
                  }
                } catch (e) {}
              }
            }
            
            if (!expFilled) {
              for (const sel of expSelectors) {
                try {
                  const el = await frame.$(sel);
                  if (el) {
                    await el.click();
                    await delay(200);
                    await el.type(`${card.month}${card.year}`, { delay: 30 });
                    sendLog('[自动填写] ✓ 有效期已填写');
                    expFilled = true;
                    break;
                  }
                } catch (e) {}
              }
            }
            
            if (!cvvFilled) {
              const cvv3 = String(card.cvv).padStart(3, '0');
              for (const sel of cvvSelectors) {
                try {
                  const el = await frame.$(sel);
                  if (el) {
                    await el.click();
                    await delay(200);
                    await el.type(cvv3, { delay: 30 });
                    sendLog(`[自动填写] ✓ CVV已填写`);
                    cvvFilled = true;
                    break;
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
        
        if (cardFilled && expFilled && cvvFilled) break;
        sendLog(`[自动填写] 卡片填写不完整(卡号=${cardFilled},有效期=${expFilled},CVV=${cvvFilled})，等待重试...`);
        await delay(2000);
      }
      
      sendLog(`[自动填写] 卡片结果: 卡号=${cardFilled}, 有效期=${expFilled}, CVV=${cvvFilled}`);
      
      sendLog('[自动填写] 填写账单信息...');
      try {
        await page.type('input[name="billingName"], input[placeholder*="Name"]', billing.name, { delay: 30 });
        sendLog('[自动填写] ✓ 姓名已填写');
      } catch (e) {}
      
      try {
        await page.select('select[name="billingCountry"]', billing.country);
      } catch (e) {}
      
      await delay(1000);
      
      try {
        const province = billing.province || billing.state;
        if (province) {
          sendLog(`[自动填写] 选择省份: ${province}`);
          await page.select('select[id="billingAdministrativeArea"], select[name="billingAdministrativeArea"]', province);
          sendLog('[自动填写] ✓ 省份已选择');
        }
      } catch (e) {
        sendLog('[自动填写] 省份选择失败: ' + e.message);
      }
      
      try {
        if (billing.city) {
          await page.type('input[name="billingLocality"], input[id="billingLocality"]', billing.city, { delay: 30 });
          sendLog('[自动填写] ✓ 城市已填写');
        }
      } catch (e) {}
      
      try {
        if (billing.district) {
          await page.type('input[id="billingDependentLocality"], input[name="billingDependentLocality"]', billing.district, { delay: 30 });
          sendLog('[自动填写] ✓ 地区已填写');
        }
      } catch (e) {}
      
      try {
        if (billing.address) {
          await page.type('input[name="billingAddressLine1"], input[id="billingAddressLine1"]', billing.address, { delay: 30 });
          sendLog('[自动填写] ✓ 地址已填写');
        }
      } catch (e) {}
      
      try {
        if (billing.address2) {
          await page.type('input[id="billingAddressLine2"], input[name="billingAddressLine2"]', billing.address2, { delay: 30 });
        }
      } catch (e) {}
      
      try {
        if (billing.postalCode) {
          await page.type('input[name="billingPostalCode"], input[id="billingPostalCode"]', billing.postalCode, { delay: 30 });
          sendLog('[自动填写] ✓ 邮编已填写');
        }
      } catch (e) {}
      
      await delay(1500);

      sendLog('[自动填写] 查找提交按钮...');
      const submitClicked = await page.evaluate(() => {
        const allEls = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const keywords = ['subscribe', '订阅', 'start trial', 'start free trial', 'pay', 'submit', 'confirm'];
        for (const el of allEls) {
          const text = (el.textContent || '').toLowerCase().trim();
          if (keywords.some(kw => text.includes(kw)) && !el.disabled) {
            el.click();
            return text;
          }
        }
        return null;
      });

      if (submitClicked) {
        sendLog(`[自动填写] ✓ 已点击提交按钮: "${submitClicked}"`);
      } else {
        sendLog('[自动填写] 未找到提交按钮，请手动点击');
      }

      sendLog('[自动填写] 填写完成');
      return { success: true };
      
    } catch (error) {
      console.error('[自动填写] 失败:', error.message);
      if (browser) {
        try { await browser.close(); } catch (e) {}
      }
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerHandlers };
