const Imap = require('imap');
const { simpleParser } = require('mailparser');

function isKnownOtpSender(from = '') {
  const fromLower = String(from || '').toLowerCase();
  return (
    fromLower.includes('tm1.openai.com') ||
    fromLower.includes('tm.openai.com') ||
    (fromLower.includes('openai.com') && (fromLower.includes('otp') || fromLower.includes('noreply'))) ||
    fromLower.includes('chatgpt.com')
  );
}

function isVerificationEmailCandidate(subject = '', from = '') {
  const subjectLower = subject.toLowerCase();
  const fromLower = from.toLowerCase();

  const senderIsKnownSource = (
    fromLower.includes('windsurf') ||
    fromLower.includes('codeium') ||
    fromLower.includes('exafunction') ||
    fromLower.includes('tm1.openai.com') ||
    fromLower.includes('tm.openai.com') ||
    fromLower.includes('openai.com') ||
    fromLower.includes('chatgpt')
  );

  if (senderIsKnownSource) {
    return true;
  }

  const subjectLooksLikeVerification = (
    subjectLower.includes('windsurf') ||
    subjectLower.includes('verify') ||
    subjectLower.includes('verification') ||
    subjectLower.includes('chatgpt code') ||
    subjectLower.includes('your code') ||
    subjectLower.includes('code is') ||
    subjectLower.includes('验证码') ||
    subjectLower.includes('otp') ||
    /^\d{6}\s*[-–]/.test(subjectLower)
  );

  return subjectLooksLikeVerification;
}

function buildVerificationSearchCriteria() {
  return [[
    'OR',
    [
      'OR',
      ['SUBJECT', 'Windsurf'],
      ['SUBJECT', 'verification']
    ],
    [
      'OR',
      ['SUBJECT', 'your code'],
      [
        'OR',
        ['SUBJECT', 'ChatGPT code'],
        [
          'OR',
          ['SUBJECT', 'OTP'],
          [
            'OR',
            ['FROM', 'tm1.openai.com'],
            [
              'OR',
              ['FROM', 'tm.openai.com'],
              ['FROM', 'openai.com']
            ]
          ]
        ]
      ]
    ]
  ]];
}

function getJunkCheckThreshold(maxWaitTime) {
  return Math.max(15000, Math.min(30000, Math.floor(maxWaitTime * 0.4)));
}

function mergeCandidateMessageIds(searchResults = [], allResults = [], recentScanLimit = 200) {
  const recentIds = Array.isArray(allResults) && recentScanLimit > 0
    ? allResults.slice(-recentScanLimit)
    : [];

  return Array.from(new Set([...(searchResults || []), ...recentIds]))
    .sort((a, b) => b - a);
}

function buildSearchDebugDescription() {
  return '主题包含 [Windsurf, verification, ChatGPT code, your code, OTP]，发件人包含 [tm1.openai.com, tm.openai.com, openai.com]，并补扫最近邮件';
}

function buildFetchRange(totalMessages, recentScanLimit, oldMailSequenceCutoff = 0) {
  if (!Number.isFinite(totalMessages) || totalMessages <= 0) {
    return null;
  }

  const end = Math.max(1, Math.floor(totalMessages));
  const limit = Math.max(1, Math.floor(recentScanLimit || 1));
  const cutoff = Number.isFinite(oldMailSequenceCutoff) && oldMailSequenceCutoff > 0
    ? Math.floor(oldMailSequenceCutoff)
    : 0;
  const start = Math.max(1, end - limit + 1, cutoff + 1);
  return `${start}:*`;
}

function buildRecentSequenceRange(totalMessages, recentScanLimit) {
  if (!Number.isFinite(totalMessages) || totalMessages <= 0) {
    return null;
  }

  const end = Math.max(1, Math.floor(totalMessages));
  const limit = Math.max(1, Math.floor(recentScanLimit || 1));
  const start = Math.max(1, end - limit + 1);
  return `${start}:${end}`;
}

function buildRecentSequenceNumbers(totalMessages, recentScanLimit) {
  if (!Number.isFinite(totalMessages) || totalMessages <= 0) {
    return [];
  }

  const end = Math.max(1, Math.floor(totalMessages));
  const limit = Math.max(1, Math.floor(recentScanLimit || 1));
  const start = Math.max(1, end - limit + 1);
  const seqNumbers = [];
  for (let seq = end; seq >= start; seq -= 1) {
    seqNumbers.push(seq);
  }
  return seqNumbers;
}

function buildSequenceNumbersToScan(totalMessages, recentScanLimit, oldMailSequenceCutoff = 0) {
  const recentSequenceNumbers = buildRecentSequenceNumbers(totalMessages, recentScanLimit);

  if (!Number.isFinite(oldMailSequenceCutoff) || oldMailSequenceCutoff <= 0) {
    return recentSequenceNumbers;
  }

  return recentSequenceNumbers.filter((seqno) => seqno > oldMailSequenceCutoff);
}

function updateOldMailSequenceCutoff(oldMailSequenceCutoff = 0, seqno, verificationState = {}) {
  const normalizedCutoff = Number.isFinite(oldMailSequenceCutoff) && oldMailSequenceCutoff > 0
    ? Math.floor(oldMailSequenceCutoff)
    : 0;

  if (verificationState?.isFresh !== false) {
    return normalizedCutoff;
  }

  if (!Number.isFinite(seqno) || seqno <= 0) {
    return normalizedCutoff;
  }

  return Math.max(normalizedCutoff, Math.floor(seqno));
}

function getMaxEmailAgeMs(config = {}) {
  const configured = Number(config.maxEmailAgeMs);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return 20 * 60 * 1000;
}

function getMaxScanEmailAgeMs(config = {}) {
  const configured = Number(config.maxScanEmailAgeMs);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return 60 * 60 * 1000;
}

function getStaleTargetSubjectCodeMaxAgeMs(config = {}) {
  const configured = Number(config.staleTargetSubjectCodeMaxAgeMs);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return 45 * 60 * 1000;
}

function classifyVerificationEmail({
  subject = '',
  from = '',
  date,
  now = Date.now(),
  maxEmailAgeMs = getMaxEmailAgeMs(),
  maxScanEmailAgeMs = getMaxScanEmailAgeMs(),
} = {}) {
  const isVerification = isVerificationEmailCandidate(subject, from);
  const emailTimestamp = new Date(date || now).getTime();
  const normalizedTimestamp = Number.isFinite(emailTimestamp) ? emailTimestamp : now;
  const emailAgeMs = Math.max(0, now - normalizedTimestamp);
  const normalizedScanLimit = Number.isFinite(maxScanEmailAgeMs) && maxScanEmailAgeMs > 0
    ? maxScanEmailAgeMs
    : getMaxScanEmailAgeMs();

  return {
    isVerification,
    emailAgeMs,
    isFresh: emailAgeMs <= maxEmailAgeMs,
    isWithinScanWindow: emailAgeMs <= normalizedScanLimit,
  };
}

function extractVerificationCodeFromSubject(subject = '') {
  const subjectText = String(subject || '').trim();
  if (!subjectText) {
    return null;
  }

  const patterns = [
    /^(\d{6})\s*[-–]/,
    /your\s+chatgpt\s+code\s+is\s+(\d{6})/i,
    /your\s+code\s+is\s+(\d{6})/i,
    /verify your email(?: with windsurf)?[\s:-]+(\d{6})/i,
    /verification\s+code[：:\s]+(\d{6})/i,
    /验证码[：:\s]*(\d{6})/i,
    /code is[：:\s]+(\d{6})/i,
    /otp[：:\s]+(\d{6})/i,
    />\s*(\d{6})\s*</,
  ];

  for (const pattern of patterns) {
    const match = subjectText.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function canUseSubjectCodeForTargetEmail({
  subjectCode,
  isTargetEmail,
  emailAgeMs,
  maxEmailAgeMs,
  maxScanEmailAgeMs,
  staleTargetSubjectCodeMaxAgeMs,
} = {}) {
  if (!subjectCode || !isTargetEmail || !Number.isFinite(emailAgeMs)) {
    return false;
  }

  const freshLimit = Number.isFinite(maxEmailAgeMs) && maxEmailAgeMs > 0
    ? maxEmailAgeMs
    : getMaxEmailAgeMs();
  const fallbackLimit = Number.isFinite(staleTargetSubjectCodeMaxAgeMs) && staleTargetSubjectCodeMaxAgeMs > 0
    ? staleTargetSubjectCodeMaxAgeMs
    : getStaleTargetSubjectCodeMaxAgeMs();
  const scanLimit = Number.isFinite(maxScanEmailAgeMs) && maxScanEmailAgeMs > 0
    ? maxScanEmailAgeMs
    : getMaxScanEmailAgeMs();

  return emailAgeMs <= Math.max(freshLimit, fallbackLimit, scanLimit);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTargetEmailRegex(targetEmail) {
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  if (!normalizedTarget) {
    return null;
  }

  return new RegExp(`(?<![a-z0-9._%+-])${escapeRegExp(normalizedTarget)}(?![a-z0-9._%+-])`, 'i');
}

function findTargetEmailMatchSources(targetEmail, { to = '', headersText = '', bodyText = '' } = {}) {
  const targetRegex = buildTargetEmailRegex(targetEmail);
  if (!targetRegex) {
    return [];
  }

  const sources = [];
  if (targetRegex.test(String(to || '').toLowerCase())) {
    sources.push('to');
  }
  if (targetRegex.test(String(headersText || '').toLowerCase())) {
    sources.push('headers');
  }
  if (targetRegex.test(String(bodyText || '').toLowerCase())) {
    sources.push('body');
  }
  return sources;
}

function describeTargetEmailMatch(targetEmail, sourceFields = {}) {
  const sources = findTargetEmailMatchSources(targetEmail, sourceFields);
  return sources.length > 0 ? sources.join(', ') : 'none';
}

function matchesTargetEmail(targetEmail, { to = '', headersText = '', bodyText = '' } = {}) {
  return findTargetEmailMatchSources(targetEmail, { to, headersText, bodyText }).length > 0;
}

function shouldFetchFullMessageForCandidate({ quickTargetMatch, subject = '' } = {}) {
  const subjectCode = extractVerificationCodeFromSubject(subject);
  return !quickTargetMatch || !subjectCode;
}

function toFieldBelongsToDifferentRecipient(to, targetEmail) {
  const toStr = String(to || '').toLowerCase().trim();
  const target = String(targetEmail || '').toLowerCase().trim();
  if (!toStr || !target) return false;

  const targetDomain = target.split('@')[1];
  if (!targetDomain) return false;

  // TO 头包含同域名的不同邮箱 → 这封邮件明确是发给别人的，不能宽松匹配
  if (toStr.includes('@' + targetDomain) && !toStr.includes(target)) {
    return true;
  }
  return false;
}

function analyzeHeaderScanCandidate({
  emailId,
  subject = '',
  from = '',
  to = '',
  date,
  targetEmail = '',
  processedEmails,
  maxEmailAgeMs = getMaxEmailAgeMs(),
  maxScanEmailAgeMs = getMaxScanEmailAgeMs(),
  headerQuickText = '',
} = {}) {
  const verificationState = classifyVerificationEmail({
    subject,
    from,
    date,
    maxEmailAgeMs,
    maxScanEmailAgeMs,
  });
  // 同时检查 TO 和转发相关头部（DELIVERED-TO, X-ORIGINAL-TO 等）
  const targetEmailSources = findTargetEmailMatchSources(targetEmail, {
    to,
    headersText: headerQuickText,
  });
  const isTargetByHeaders = targetEmailSources.length > 0;

  // 对已知 OTP 发件人（如 OpenAI），在目标邮箱未匹配时标记为可宽松匹配
  // 但如果 TO 头明确写了同域名的不同邮箱，说明是发给别的注册任务的，不能宽松匹配
  const knownOtp = isKnownOtpSender(from);
  const subjectCode = extractVerificationCodeFromSubject(subject);
  const isOtherRecipient = toFieldBelongsToDifferentRecipient(to, targetEmail);
  const canRelaxMatch = knownOtp && !isTargetByHeaders && !isOtherRecipient
    && !!subjectCode && verificationState.isFresh;

  return {
    emailId,
    subject,
    from,
    to,
    date,
    verificationState,
    isCandidate: verificationState.isVerification,
    isAlreadyProcessed: Boolean(processedEmails?.has(emailId)),
    isTargetEmail: isTargetByHeaders,
    isKnownOtpSender: knownOtp,
    canRelaxMatch,
    targetEmailSources,
    subjectCode,
  };
}

function shouldSwitchToJunkMailbox({
  currentBox,
  junkBoxChecked,
  elapsed,
  junkCheckThreshold,
  now,
  lastInboxMailAt,
  inboxGracePeriodMs
}) {
  if (currentBox !== 'INBOX' || junkBoxChecked || elapsed < junkCheckThreshold) {
    return false;
  }

  if (Number.isFinite(lastInboxMailAt) && Number.isFinite(now) && (now - lastInboxMailAt) <= inboxGracePeriodMs) {
    return false;
  }

  return true;
}

function summarizeMailboxHeader({ seqno, uid, subject, from, to, date }) {
  const subjectText = subject || '(无主题)';
  const fromText = from || '(未知发件人)';
  const toText = to || '(未知收件人)';
  const dateText = date ? new Date(date).toISOString() : '(未知时间)';
  return `扫描邮件 seq=${seqno} uid=${uid} | 主题=${subjectText} | 发件人=${fromText} | 收件人=${toText} | 时间=${dateText}`;
}

/**
 * 本地邮箱验证码接收器
 */
class EmailReceiver {
  constructor(config, logCallback = null) {
    this.config = config;
    this.log = typeof logCallback === 'function' ? logCallback : console.log;

    // 强制优化为 QQ 邮箱 IMAP 配置
    // 即使外部传入其他 host/port，这里也统一为 QQ 的设置
    this.config.host = 'imap.qq.com';
    this.config.port = 993;
    this.recentScanLimit = Number.isInteger(this.config.recentScanLimit) && this.config.recentScanLimit > 0
      ? this.config.recentScanLimit
      : 200;
    this.maxEmailAgeMs = getMaxEmailAgeMs(this.config);
    this.maxScanEmailAgeMs = getMaxScanEmailAgeMs(this.config);
    this.staleTargetSubjectCodeMaxAgeMs = getStaleTargetSubjectCodeMaxAgeMs(this.config);
    this.inboxGracePeriodMs = Number.isInteger(this.config.inboxGracePeriodMs) && this.config.inboxGracePeriodMs > 0
      ? this.config.inboxGracePeriodMs
      : 15000;
    // notBefore: 仅接受此时间戳之后的邮件（用于 OAuth 阶段过滤掉注册阶段的旧验证码）
    this.notBefore = this.config.notBefore ? new Date(this.config.notBefore).getTime() : null;
    if (this.notBefore && !Number.isFinite(this.notBefore)) {
      this.notBefore = null;
    }
    // 当 notBefore 存在时，只关心最近几分钟的邮件，大幅缩小初始扫描范围加速启动
    if (this.notBefore && this.recentScanLimit > 30) {
      this.recentScanLimit = 30;
    }
  }

  /**
   * 获取所有可用的邮箱列表（用于检测垃圾箱）
   */
  async getMailboxList(imap) {
    return new Promise((resolve) => {
      imap.getBoxes((err, boxes) => {
        if (err) {
          this.log(`获取邮箱列表失败: ${err.message}`);
          resolve([]);
          return;
        }
        
        const boxNames = [];
        const extractBoxNames = (boxes, prefix = '') => {
          for (const name in boxes) {
            const fullName = prefix ? `${prefix}${boxes[name].delimiter || '/'}${name}` : name;
            boxNames.push(fullName);
            if (boxes[name].children) {
              extractBoxNames(boxes[name].children, fullName);
            }
          }
        };
        
        extractBoxNames(boxes);
        resolve(boxNames);
      });
    });
  }

  /**
   * 获取验证码（优化的IMAP实现，支持垃圾箱）
   */
  async getVerificationCode(targetEmail, maxWaitTime = 120000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const junkCheckThreshold = getJunkCheckThreshold(maxWaitTime);
      this.log(`开始通过 IMAP 获取验证码，目标邮箱: ${targetEmail}`);
      this.log(`IMAP 服务器: ${this.config.host}:${this.config.port} (仅支持 QQ 邮箱)`);
      this.log(`最近邮件补扫范围: ${this.recentScanLimit} 封`);
      this.log(`邮件轮询与提取窗口: 最近 ${Math.floor(this.maxScanEmailAgeMs / 60000)} 分钟`);
      if (this.notBefore) {
        this.log(`邮件时间下限: ${new Date(this.notBefore).toISOString()}（忽略此时间之前的邮件）`);
      }
      
      // 创建IMAP连接
      const imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.host,
        port: this.config.port || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 120000, // 连接超时120秒
        authTimeout: 120000, // 认证超时120秒
        keepalive: {
          interval: 10000,
          idleInterval: 300000,
          forceNoop: true
        }
      });

      let checkInterval;
      let isResolved = false;
      let currentBox = null; // 当前打开的邮箱
      let currentBoxMessageCount = 0;
      let junkBoxChecked = false; // 是否已检查过垃圾箱
      let scanInProgress = false;
      let lastInboxMailAt = null;
      const processedEmails = new Set(); // 记录已处理的邮件ID
      const pendingFullMessageFetches = new Set();

      // 清理资源
      const cleanup = () => {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = null;
        }
        pendingFullMessageFetches.clear();
        if (imap.state !== 'disconnected') {
          try {
            imap.end();
          } catch (e) {
            // 忽略关闭错误
          }
        }
      };

      // 处理单封邮件
      const processEmail = async (parsed, emailId) => {
        if (isResolved || processedEmails.has(emailId)) return false;
        
        processedEmails.add(emailId);

        const subject = parsed.subject || '';
        const from = parsed.from?.text || '';
        const to = parsed.to?.text || '';
        const date = parsed.date || new Date();
        const subjectCode = extractVerificationCodeFromSubject(subject);
        const verificationState = classifyVerificationEmail({
          subject,
          from,
          date,
          maxEmailAgeMs: this.maxEmailAgeMs,
          maxScanEmailAgeMs: this.maxScanEmailAgeMs,
        });
        
        this.log(`邮件 #${emailId} - 主题: ${subject}, 发件人: ${from}, 时间: ${date}`);

        // notBefore 过滤：跳过早于指定时间的邮件
        if (this.notBefore) {
          const emailTimestamp = new Date(date).getTime();
          if (Number.isFinite(emailTimestamp) && emailTimestamp < this.notBefore) {
            this.log(`邮件 #${emailId} 早于 notBefore 时间限制，跳过`);
            return false;
          }
        }

        // 检查是否为 Windsurf 或 OpenAI/ChatGPT 验证邮件
        if (!verificationState.isVerification) {
          this.log('不是验证邮件，跳过');
          return false;
        }
        
        const patterns = [
          /following\s+6\s+digit\s+code[^\d]+(\d{6})/i,
          /enter\s+the\s+following[^\d]+(\d{6})/i,
          /verification\s+code[：:\s]+([A-Z0-9]{6})/i,
          /your\s+chatgpt\s+code\s+is\s+(\d{6})/i,
          /your\s+code\s+is\s+(\d{6})/i,
          /code is[：:\s]+([A-Z0-9]{6})/i,
          /your code[：:\s]+([A-Z0-9]{6})/i,
          /code[：:\s]+([A-Z0-9]{6})/i,
          /otp[：:\s]+([A-Z0-9]{6})/i,
          />\s*(\d{6})\s*</,
          /验证码[：:\s]*(\d{6})/,
          /验证码[：:\s]*([A-Z0-9]{6})/,
          /(?<![#&])\b(\d{6})\b/
        ];
        
        // 检查目标邮箱匹配（TO 头 / 转发头 / 邮件内容，任一匹配即可）
        const allHeaders = parsed.headerLines ? parsed.headerLines.map(h => `${h.key}: ${h.line}`).join(' ') : '';
        const bodyText = (parsed.text || '') + ' ' + (parsed.html || '');
        const targetEmailSources = findTargetEmailMatchSources(targetEmail, {
          to,
          headersText: allHeaders,
          bodyText
        });
        const isTargetEmail = targetEmailSources.length > 0;

        let acceptedViaRelaxMatch = false;
        if (isTargetEmail) {
          this.log(`目标邮箱匹配成功: ${targetEmail} (来源: ${targetEmailSources.join(', ')})`);
        } else if (isKnownOtpSender(from) && verificationState.isFresh
          && !toFieldBelongsToDifferentRecipient(to, targetEmail)) {
          this.log(`目标邮箱未匹配，但发件人为已知 OTP 来源 (${from})，尝试宽松匹配提取验证码`);
          acceptedViaRelaxMatch = true;
        } else {
          this.log(`邮件中未找到目标邮箱 ${targetEmail}（来源: none，TO: ${to || '(空)'}），跳过当前邮件`);
          return false;
        }

        const effectiveTargetMatch = isTargetEmail || acceptedViaRelaxMatch;
        if (subjectCode && canUseSubjectCodeForTargetEmail({
          subjectCode,
          isTargetEmail: effectiveTargetMatch,
          emailAgeMs: verificationState.emailAgeMs,
          maxEmailAgeMs: this.maxEmailAgeMs,
          maxScanEmailAgeMs: this.maxScanEmailAgeMs,
          staleTargetSubjectCodeMaxAgeMs: this.staleTargetSubjectCodeMaxAgeMs,
        })) {
          cleanup();
          if (!isResolved) {
            isResolved = true;
            const matchLabel = acceptedViaRelaxMatch ? '（已知 OTP 发件人宽松匹配）' : '';
            this.log(`成功从邮件主题提取验证码: ${subjectCode}${matchLabel}`);
            resolve(subjectCode);
          }
          return true;
        }

        if (!verificationState.isWithinScanWindow) {
          this.log(`验证码候选邮件过旧（${Math.floor(verificationState.emailAgeMs / 1000)}秒前，扫描窗口 ${Math.floor(this.maxScanEmailAgeMs / 60000)} 分钟），跳过提取`);
          return false;
        }

        this.log('主题中未找到验证码，从邮件内容提取');
        
        // 从纯文本提取
        if (parsed.text) {
          for (const pattern of patterns) {
            const match = parsed.text.match(pattern);
            if (match) {
              cleanup();
              if (!isResolved) {
                isResolved = true;
                this.log(`成功从纯文本提取验证码: ${match[1]}`);
                resolve(match[1]);
              }
              return true;
            }
          }
        }
        
        // 从 HTML 原文提取
        if (parsed.html) {
          this.log('纯文本未找到，尝试从HTML原文提取');
          
          // 直接从HTML原文匹配验证码（无需清理HTML标签，速度快）
          for (const pattern of patterns) {
            const match = parsed.html.match(pattern);
            if (match) {
              cleanup();
              if (!isResolved) {
                isResolved = true;
                this.log(`成功从HTML原文提取验证码: ${match[1]}`);
                resolve(match[1]);
              }
              return true;
            }
          }
          
          // 方案3: 如果还是没找到，才进行轻量级HTML清理后再匹配
          this.log('HTML原文未找到，进行轻量级清理后重试');
          const cleanHtml = parsed.html
            .replace(/<style[^>]*>.*?<\/style>/gi, '')
            .replace(/<script[^>]*>.*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
            .replace(/\s+/g, ' ')
            .trim();
          
          for (const pattern of patterns) {
            const match = cleanHtml.match(pattern);
            if (match) {
              cleanup();
              if (!isResolved) {
                isResolved = true;
                this.log(`成功从清理后的HTML提取验证码: ${match[1]}`);
                resolve(match[1]);
              }
              return true;
            }
          }
        }
        
        this.log('未能从邮件中提取验证码');
        return false;
      };

      // 切换到下一个邮箱（垃圾箱）
      const switchToNextBox = async () => {
        if (isResolved || junkBoxChecked) return;
        
        this.log('收件箱未找到验证码，尝试检查垃圾箱...');
        junkBoxChecked = true;
        
        try {
          // 获取所有邮箱列表
          const allBoxes = await this.getMailboxList(imap);
          this.log(`可用邮箱: ${allBoxes.join(', ')}`);
          
          // 查找垃圾邮件文件夹（不包含 Deleted Messages / Trash，那是回收站）
          const junkBoxNames = [
            'Junk',           // QQ邮箱 / 标准命名
            'Spam',           // Gmail
            'Bulk Mail',      // Outlook
            '[Gmail]/Spam',   // Gmail IMAP
            'INBOX.Junk',     // 某些IMAP服务器
            'INBOX.Spam'
          ];
          
          let junkBox = null;
          for (const junkName of junkBoxNames) {
            const match = allBoxes.find(box => box.toLowerCase() === junkName.toLowerCase());
            if (match) {
              junkBox = match;
              break;
            }
          }
          
          if (!junkBox) {
            this.log('未找到垃圾箱，继续等待收件箱...');
            return;
          }
          
          this.log(`找到垃圾箱: ${junkBox}`);
          
          // 关闭当前邮箱
          imap.closeBox((err) => {
            if (err) {
              this.log(`关闭收件箱失败: ${err.message}`);
            }
            
            // 打开垃圾箱
            imap.openBox(junkBox, false, (err, box) => {
              if (err) {
                this.log(`打开垃圾箱失败: ${err.message}`);
                return;
              }
              
              currentBox = junkBox;
              currentBoxMessageCount = box?.messages?.total || 0;
              // 保存 INBOX cutoff，切回时恢复（避免重新扫描已确认的旧邮件）
              savedInboxCutoff = oldMailSequenceCutoff;
              // 重置为 0，避免 INBOX 的高序号在 Junk（少量邮件）中产生无效范围
              oldMailSequenceCutoff = 0;
              lastLoggedCount = -1;
              this.log(`已切换到垃圾箱: ${junkBox}`);
              this.log(`当前邮箱邮件总数: ${currentBoxMessageCount}`);
              
              // 立即检查垃圾箱中的邮件
              checkMail();
              
              // Junk 初扫窗口（10 秒）结束后自动切回 INBOX，
              // 防止验证码邮件在切换期间到达 INBOX 而无法被检测
              const junkScanWindow = 10000;
              setTimeout(() => {
                if (isResolved || currentBox === 'INBOX') return;
                
                scanInProgress = false;
                this.log('垃圾箱初扫完成，切回收件箱继续监听新邮件...');
                
                imap.closeBox((closeErr) => {
                  if (isResolved) return;
                  if (closeErr) {
                    this.log(`关闭垃圾箱失败: ${closeErr.message}`);
                  }
                  
                  imap.openBox('INBOX', false, (openErr, inboxBox) => {
                    if (isResolved) return;
                    if (openErr) {
                      this.log(`重新打开收件箱失败: ${openErr.message}`);
                      return;
                    }
                    
                    currentBox = 'INBOX';
                    currentBoxMessageCount = inboxBox?.messages?.total || 0;
                    // 恢复之前保存的 INBOX cutoff，跳过已扫描过的旧邮件
                    oldMailSequenceCutoff = savedInboxCutoff;
                    lastLoggedCount = -1;
                    this.log(`已切回收件箱，当前邮件总数: ${currentBoxMessageCount}（cutoff 恢复至 ${savedInboxCutoff}）`);
                    
                    checkMail();
                  });
                });
              }, junkScanWindow);
            });
          });
        } catch (error) {
          this.log(`切换垃圾箱失败: ${error.message}`);
        }
      };

      let oldMailSequenceCutoff = 0;
      let savedInboxCutoff = 0;
      let lastLoggedCount = -1;
      let lastProgressLog = 0;
      let lastSearchLogAt = 0;

      // 检查邮件
      const checkMail = () => {
        if (isResolved) return;
        
        const elapsed = Date.now() - startTime;

        if (shouldSwitchToJunkMailbox({
          currentBox,
          junkBoxChecked,
          elapsed,
          junkCheckThreshold,
          now: Date.now(),
          lastInboxMailAt,
          inboxGracePeriodMs: this.inboxGracePeriodMs
        })) {
          switchToNextBox();
        } else if (currentBox === 'INBOX' && !junkBoxChecked && elapsed >= junkCheckThreshold && lastInboxMailAt) {
          this.log(`INBOX 刚收到新邮件，延迟切换垃圾箱 ${Math.ceil(this.inboxGracePeriodMs / 1000)} 秒，优先继续检查收件箱`);
        }

        if (elapsed > maxWaitTime) {
          cleanup();
          if (!isResolved) {
            isResolved = true;
            const msg = '获取验证码超时：在指定时间内未找到有效验证码邮件';
            this.log(msg);
            reject(new Error(msg));
          }
          return;
        }

        if (!currentBox) {
          this.log('等待邮箱打开...');
          return;
        }

        if (scanInProgress) {
          return;
        }

        const now = Date.now();
        if (now - lastSearchLogAt >= 15000) {
          lastSearchLogAt = now;
          this.log(`正在查询内容: ${buildSearchDebugDescription()}（邮箱: ${currentBox}）`);
        }

        const fetchRange = buildFetchRange(
          currentBoxMessageCount,
          this.recentScanLimit,
          oldMailSequenceCutoff
        );
        if (!fetchRange) {
          if (lastLoggedCount !== 0) {
            this.log(`当前邮箱 ${currentBox} 暂无邮件，继续等待验证码`);
            lastLoggedCount = 0;
          }
          if (now - lastProgressLog >= 15000) {
            lastProgressLog = now;
            const waitedSec = Math.floor(elapsed / 1000);
            const remainSec = Math.floor((maxWaitTime - elapsed) / 1000);
            this.log(`仍在等待验证码邮件... 已等待 ${waitedSec}s，剩余 ${remainSec}s（${currentBox}）`);
          }
          return;
        }

        scanInProgress = true;
        const scanLogNow = Date.now();
        if (scanLogNow - lastProgressLog >= 10000 || lastLoggedCount === -1) {
          lastProgressLog = scanLogNow;
          this.log(`正在检查最近邮件序号范围: ${fetchRange}（${currentBox} 已知 ${currentBoxMessageCount} 封，使用 * 自动发现新邮件）`);
        }



        const finishScan = () => {
          scanInProgress = false;
        };

        const roundSeenCandidateUids = new Set();
        let pendingHeaderParsers = 0;
        let headerFetchEnded = false;

        const finalizeHeaderScan = () => {
          if (!headerFetchEnded || pendingHeaderParsers > 0) {
            return;
          }

          finishScan();
          if (roundSeenCandidateUids.size === 0) {
            if (lastLoggedCount !== 0) {
              this.log(`最近 ${this.recentScanLimit} 封邮件内未发现候选验证邮件`);
              lastLoggedCount = 0;
            }
            if (Date.now() - lastProgressLog >= 15000) {
              lastProgressLog = Date.now();
              const waitedSec = Math.floor(elapsed / 1000);
              const remainSec = Math.floor((maxWaitTime - elapsed) / 1000);
              this.log(`仍在等待验证码邮件... 已等待 ${waitedSec}s，剩余 ${remainSec}s（${currentBox}）`);
            }
            return;
          }

          const seenCandidateUids = Array.from(roundSeenCandidateUids);
          if (seenCandidateUids.length !== lastLoggedCount) {
            this.log(`本轮命中候选邮件 ${seenCandidateUids.length} 封，UID: ${seenCandidateUids.join(', ')}`);
            lastLoggedCount = seenCandidateUids.length;
          }
        };

        // 直接抓取最近 N 封邮件头，用 * 自动发现新邮件
        // 额外获取 DELIVERED-TO / X-ORIGINAL-TO / CC，用于匹配 Cloudflare Catch-All 转发后的原始收件人
        const fetch = imap.seq.fetch(fetchRange, {
            bodies: ['HEADER.FIELDS (FROM TO CC SUBJECT DATE DELIVERED-TO X-ORIGINAL-TO X-FORWARDED-TO)'],
            struct: false,
            markSeen: false
        });

        fetch.on('message', (msg, seqno) => {
            // 动态更新已知邮件总数，修复 QQ IMAP mail 事件不触发的问题
            if (seqno > currentBoxMessageCount) {
              currentBoxMessageCount = seqno;
            }
            let emailId = null;
            msg.on('attributes', (attrs) => {
              emailId = attrs.uid;
            });
            
            msg.on('body', (stream, info) => {
              pendingHeaderParsers += 1;
              // 快速解析邮件头
              simpleParser(stream, async (err, parsed) => {
                try {
                  if (err || !emailId || isResolved) return;

                  // 已处理过的邮件静默跳过，避免重复 fetch 和日志刷屏
                  if (processedEmails.has(emailId)) return;
                
                  const subject = parsed.subject || '';
                  const from = parsed.from?.text || '';
                  const to = parsed.to?.text || '';
                  const date = parsed.date || new Date();
                  // 从转发相关头部提取原始收件人（Cloudflare Catch-All 场景）
                  const deliveredTo = (parsed.headers && parsed.headers.get('delivered-to')) || '';
                  const xOriginalTo = (parsed.headers && parsed.headers.get('x-original-to')) || '';
                  const xForwardedTo = (parsed.headers && parsed.headers.get('x-forwarded-to')) || '';
                  const cc = parsed.cc?.text || '';
                  const headerQuickText = [deliveredTo, xOriginalTo, xForwardedTo, cc].filter(Boolean).join(' ');
                  const candidateState = analyzeHeaderScanCandidate({
                    emailId,
                    subject,
                    from,
                    to,
                    date,
                    targetEmail,
                    processedEmails,
                    maxEmailAgeMs: this.maxEmailAgeMs,
                    maxScanEmailAgeMs: this.maxScanEmailAgeMs,
                    headerQuickText,
                  });

                  if (!candidateState.verificationState.isWithinScanWindow) {
                    processedEmails.add(emailId);
                    oldMailSequenceCutoff = Math.max(oldMailSequenceCutoff, seqno);
                    return;
                  }

                  // notBefore 过滤：跳过早于指定时间的邮件（OAuth 阶段避免复用注册阶段的旧验证码）
                  if (this.notBefore) {
                    const emailTimestamp = new Date(date).getTime();
                    if (Number.isFinite(emailTimestamp) && emailTimestamp < this.notBefore) {
                      processedEmails.add(emailId);
                      return;
                    }
                  }

                  if (!candidateState.isCandidate) {
                    processedEmails.add(emailId);
                    return;
                  }

                  this.log(summarizeMailboxHeader({
                    seqno,
                    uid: emailId,
                    subject,
                    from,
                    to,
                    date
                  }));

                  roundSeenCandidateUids.add(emailId);
                  this.log(`命中候选邮件 #${emailId} (seq=${seqno}) - 主题: ${subject}, 收件人: ${to}, 发件人: ${from}`);

                  if (candidateState.isAlreadyProcessed) {
                    return;
                  }

                  if (candidateState.isTargetEmail && canUseSubjectCodeForTargetEmail({
                    subjectCode: candidateState.subjectCode,
                    isTargetEmail: candidateState.isTargetEmail,
                    emailAgeMs: candidateState.verificationState.emailAgeMs,
                    maxEmailAgeMs: this.maxEmailAgeMs,
                    maxScanEmailAgeMs: this.maxScanEmailAgeMs,
                    staleTargetSubjectCodeMaxAgeMs: this.staleTargetSubjectCodeMaxAgeMs,
                  })) {
                    processedEmails.add(emailId);
                    cleanup();
                    if (!isResolved) {
                      isResolved = true;
                      this.log(`成功从邮件主题提取验证码: ${candidateState.subjectCode}`);
                      resolve(candidateState.subjectCode);
                    }
                    return;
                  }

                  // 已知 OTP 发件人（如 OpenAI）宽松匹配：
                  // 转发邮件的 To 头可能被改写为 QQ 邮箱地址，导致目标邮箱匹配失败
                  // 此时如果主题中已有验证码且邮件是新鲜的，直接使用
                  if (candidateState.canRelaxMatch) {
                    processedEmails.add(emailId);
                    this.log(`目标邮箱未在 TO/头部 中匹配，但发件人为已知 OTP 来源 (${from})，邮件新鲜且主题含验证码`);
                    cleanup();
                    if (!isResolved) {
                      isResolved = true;
                      this.log(`通过已知 OTP 发件人宽松匹配，从主题提取验证码: ${candidateState.subjectCode}`);
                      resolve(candidateState.subjectCode);
                    }
                    return;
                  }

                  if (candidateState.isTargetEmail) {
                    this.log(`快速匹配成功，目标邮箱: ${targetEmail} (来源: ${candidateState.targetEmailSources.join(', ')})`);
                  } else {
                    this.log(`快速匹配未命中，目标邮箱: ${targetEmail} (来源: ${describeTargetEmailMatch(targetEmail, { to })}，TO: ${to || '(空)'} )，继续检查完整邮件头和正文`);
                  }
                  
                  if (!shouldFetchFullMessageForCandidate({
                    quickTargetMatch: candidateState.isTargetEmail,
                    subject,
                  })) {
                    processedEmails.add(emailId);
                    return;
                  }

                  if (pendingFullMessageFetches.has(emailId)) {
                    this.log(`邮件 #${emailId} 正在获取完整内容，跳过重复抓取`);
                    return;
                  }

                  // 快速检查无法直接确认时，获取完整邮件体进一步匹配
                  this.log('获取完整邮件进行匹配...');
                  pendingFullMessageFetches.add(emailId);
                  
                  const fullFetch = imap.fetch([emailId], { 
                    bodies: '',
                    markSeen: false
                  });
                  const fetchTimeout = setTimeout(() => {
                    if (pendingFullMessageFetches.has(emailId)) {
                      this.log(`邮件 #${emailId} 获取完整内容超时，移除待处理标记`);
                      pendingFullMessageFetches.delete(emailId);
                    }
                  }, 30000);
                  const clearPendingFullMessageFetch = () => {
                    clearTimeout(fetchTimeout);
                    pendingFullMessageFetches.delete(emailId);
                  };
                  
                  fullFetch.on('message', (fullMsg) => {
                    fullMsg.on('body', (fullStream) => {
                      simpleParser(fullStream, async (err, fullParsed) => {
                        if (err || isResolved) {
                          clearPendingFullMessageFetch();
                          return;
                        }

                        try {
                          await processEmail(fullParsed, emailId);
                        } catch (processError) {
                          this.log(`处理邮件 #${emailId} 失败: ${processError.message}`);
                        } finally {
                          clearPendingFullMessageFetch();
                        }
                      });
                    });
                  });
                  
                  fullFetch.once('error', (err) => {
                    clearPendingFullMessageFetch();
                    this.log(`获取完整邮件失败: ${err.message}`);
                  });

                  fullFetch.once('end', () => {
                    clearPendingFullMessageFetch();
                  });
                } finally {
                  pendingHeaderParsers = Math.max(0, pendingHeaderParsers - 1);
                  finalizeHeaderScan();
                }
              });
            });
          });

        fetch.once('error', (err) => {
          headerFetchEnded = true;
          pendingHeaderParsers = 0;
          finishScan();
          this.log(`获取邮件内容失败: ${err.message}`);
        });
        
        fetch.once('end', () => {
          headerFetchEnded = true;
          finalizeHeaderScan();
        });
      };

      // IMAP连接成功
      imap.once('ready', () => {
        this.log('IMAP 连接成功');
        
        // 打开收件箱（优先检查）
        imap.openBox('INBOX', false, (err, box) => {
          if (err) {
            cleanup();
            if (!isResolved) {
              isResolved = true;
              reject(new Error(`打开邮箱失败: ${err.message}`));
            }
            return;
          }
          
          currentBox = 'INBOX';
          currentBoxMessageCount = box?.messages?.total || 0;
          this.log('收件箱已打开，开始监听验证码邮件...');
          this.log(`目标邮箱: ${targetEmail}`);
          this.log(`最大等待时间: ${maxWaitTime/1000} 秒`);
          this.log(`当前邮箱邮件总数: ${currentBoxMessageCount}`);
          this.log(`提示: 如果收件箱 ${Math.floor(junkCheckThreshold / 1000)} 秒内未找到，将自动检查垃圾箱`);
          
          // 立即检查一次
          checkMail();
          
          // 每2秒检查一次新邮件（更快响应）
          checkInterval = setInterval(checkMail, 2000);
        });
      });

      imap.on('mail', (numNewMsgs) => {
        currentBoxMessageCount += numNewMsgs;
        if (currentBox === 'INBOX') {
          lastInboxMailAt = Date.now();
        }
        this.log(`检测到新邮件 ${numNewMsgs} 封（${currentBox || '初始化'}），当前邮箱总数: ${currentBoxMessageCount}`);
        if (!scanInProgress) {
          checkMail();
        }
      });

      // IMAP连接错误
      imap.once('error', (err) => {
        cleanup();
        if (!isResolved) {
          isResolved = true;
          const msg = `IMAP 连接失败：${err.message}（请检查 QQ 邮箱 IMAP 是否开启、账号/授权码是否正确）`;
          this.log(msg);
          reject(new Error(msg));
        }
      });

      // IMAP连接关闭
      imap.once('end', () => {
        cleanup();
        this.log('IMAP 连接已关闭');
      });

      // 开始连接
      imap.connect();
    });
  }

  /**
   * 测试IMAP连接
   */
  async testConnection() {
    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: this.config.user,
        password: this.config.password,
        host: this.config.host,
        port: this.config.port || 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false }
      });

      imap.once('ready', () => {
        imap.end();
        resolve({ success: true, message: 'IMAP连接成功' });
      });

      imap.once('error', (err) => {
        reject({ success: false, message: `IMAP连接失败: ${err.message}` });
      });

      imap.connect();
    });
  }
}

EmailReceiver.isKnownOtpSender = isKnownOtpSender;
EmailReceiver.toFieldBelongsToDifferentRecipient = toFieldBelongsToDifferentRecipient;
EmailReceiver.isVerificationEmailCandidate = isVerificationEmailCandidate;
EmailReceiver.buildVerificationSearchCriteria = buildVerificationSearchCriteria;
EmailReceiver.getJunkCheckThreshold = getJunkCheckThreshold;
EmailReceiver.mergeCandidateMessageIds = mergeCandidateMessageIds;
EmailReceiver.buildSearchDebugDescription = buildSearchDebugDescription;
EmailReceiver.buildRecentSequenceRange = buildRecentSequenceRange;
EmailReceiver.buildRecentSequenceNumbers = buildRecentSequenceNumbers;
EmailReceiver.buildSequenceNumbersToScan = buildSequenceNumbersToScan;
EmailReceiver.buildFetchRange = buildFetchRange;
EmailReceiver.updateOldMailSequenceCutoff = updateOldMailSequenceCutoff;
EmailReceiver.getMaxEmailAgeMs = getMaxEmailAgeMs;
EmailReceiver.getMaxScanEmailAgeMs = getMaxScanEmailAgeMs;
EmailReceiver.getStaleTargetSubjectCodeMaxAgeMs = getStaleTargetSubjectCodeMaxAgeMs;
EmailReceiver.classifyVerificationEmail = classifyVerificationEmail;
EmailReceiver.extractVerificationCodeFromSubject = extractVerificationCodeFromSubject;
EmailReceiver.canUseSubjectCodeForTargetEmail = canUseSubjectCodeForTargetEmail;
EmailReceiver.summarizeMailboxHeader = summarizeMailboxHeader;
EmailReceiver.buildTargetEmailRegex = buildTargetEmailRegex;
EmailReceiver.findTargetEmailMatchSources = findTargetEmailMatchSources;
EmailReceiver.describeTargetEmailMatch = describeTargetEmailMatch;
EmailReceiver.matchesTargetEmail = matchesTargetEmail;
EmailReceiver.shouldFetchFullMessageForCandidate = shouldFetchFullMessageForCandidate;
EmailReceiver.analyzeHeaderScanCandidate = analyzeHeaderScanCandidate;
EmailReceiver.shouldSwitchToJunkMailbox = shouldSwitchToJunkMailbox;

module.exports = EmailReceiver;
