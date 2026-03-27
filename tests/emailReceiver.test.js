const test = require('node:test');
const assert = require('node:assert/strict');

const EmailReceiver = require('../src/emailReceiver');

test('buildVerificationSearchCriteria includes ChatGPT/OpenAI verification subjects', () => {
  assert.equal(typeof EmailReceiver.buildVerificationSearchCriteria, 'function');

  const criteriaText = JSON.stringify(EmailReceiver.buildVerificationSearchCriteria());

  assert.match(criteriaText, /ChatGPT code/);
  assert.match(criteriaText, /tm1\.openai\.com/);
  assert.match(criteriaText, /tm\.openai\.com/);
  assert.match(criteriaText, /verification/i);
});

test('isVerificationEmailCandidate recognizes ChatGPT code emails', () => {
  assert.equal(typeof EmailReceiver.isVerificationEmailCandidate, 'function');

  assert.equal(
    EmailReceiver.isVerificationEmailCandidate(
      'Your ChatGPT code is 541624',
      'OpenAI <otp@tm1.openai.com>'
    ),
    true
  );
});

test('isVerificationEmailCandidate recognizes tm.openai.com sender', () => {
  assert.equal(
    EmailReceiver.isVerificationEmailCandidate(
      'Your ChatGPT code is 216236',
      'noreply <noreply@tm.openai.com>'
    ),
    true
  );
});

test('isVerificationEmailCandidate accepts known OpenAI sender regardless of subject', () => {
  assert.equal(
    EmailReceiver.isVerificationEmailCandidate(
      'Some unusual subject',
      'notifications@openai.com'
    ),
    true
  );
});

test('isVerificationEmailCandidate accepts subject-only verification from unknown sender', () => {
  assert.equal(
    EmailReceiver.isVerificationEmailCandidate(
      '123456 - Verify your email',
      'unknown@example.com'
    ),
    true
  );

  assert.equal(
    EmailReceiver.isVerificationEmailCandidate(
      'Your OTP code',
      'noreply@some-service.com'
    ),
    true
  );
});

test('isVerificationEmailCandidate rejects OpenAI billing notifications', () => {
  assert.equal(typeof EmailReceiver.isVerificationEmailCandidate, 'function');

  assert.equal(
    EmailReceiver.isVerificationEmailCandidate(
      '您的OpenAI Ireland Limited自动付款设置发生了更改',
      'service@intl.paypal.com'
    ),
    false
  );
});

test('mergeCandidateMessageIds keeps latest mailbox messages even when subject search misses', () => {
  assert.equal(typeof EmailReceiver.mergeCandidateMessageIds, 'function');

  assert.deepEqual(
    EmailReceiver.mergeCandidateMessageIds([], [11, 12, 13, 14], 3),
    [14, 13, 12]
  );
});

test('mergeCandidateMessageIds deduplicates and prioritizes newest uids', () => {
  assert.equal(typeof EmailReceiver.mergeCandidateMessageIds, 'function');

  assert.deepEqual(
    EmailReceiver.mergeCandidateMessageIds([4, 7], [5, 6, 7, 8], 3),
    [8, 7, 6, 4]
  );
});

test('buildSearchDebugDescription exposes current subject and sender filters', () => {
  assert.equal(typeof EmailReceiver.buildSearchDebugDescription, 'function');

  const text = EmailReceiver.buildSearchDebugDescription();

  assert.match(text, /Windsurf/);
  assert.match(text, /ChatGPT code/);
  assert.match(text, /OTP/);
  assert.match(text, /tm1\.openai\.com/i);
});

test('buildRecentSequenceRange returns latest mailbox window', () => {
  assert.equal(typeof EmailReceiver.buildRecentSequenceRange, 'function');

  assert.equal(EmailReceiver.buildRecentSequenceRange(0, 200), null);
  assert.equal(EmailReceiver.buildRecentSequenceRange(10, 200), '1:10');
  assert.equal(EmailReceiver.buildRecentSequenceRange(350, 200), '151:350');
});

test('summarizeMailboxHeader formats scanned email preview', () => {
  assert.equal(typeof EmailReceiver.summarizeMailboxHeader, 'function');

  const text = EmailReceiver.summarizeMailboxHeader({
    seqno: 88,
    uid: 1234,
    subject: 'Your ChatGPT code is 541624',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: 'p19av3o32c@dawei2000.xyz',
    date: '2026-03-24T10:00:00.000Z'
  });

  assert.match(text, /seq=88/);
  assert.match(text, /uid=1234/);
  assert.match(text, /ChatGPT code/);
  assert.match(text, /otp@tm1\.openai\.com/);
});

test('matchesTargetEmail accepts exact recipient and rejects other inbox aliases', () => {
  assert.equal(typeof EmailReceiver.matchesTargetEmail, 'function');

  assert.equal(
    EmailReceiver.matchesTargetEmail('p19av3o32c@dawei2000.xyz', {
      to: 'p19av3o32c@dawei2000.xyz',
      headersText: '',
      bodyText: ''
    }),
    true
  );

  assert.equal(
    EmailReceiver.matchesTargetEmail('dyny8pqs1cn@dawei2000.xyz', {
      to: 'p19av3o32c@dawei2000.xyz',
      headersText: '',
      bodyText: ''
    }),
    false
  );
});

test('buildTargetEmailRegex and matchesTargetEmail avoid substring false positives', () => {
  assert.equal(typeof EmailReceiver.buildTargetEmailRegex, 'function');

  const regex = EmailReceiver.buildTargetEmailRegex('test@example.com');
  assert.equal(regex.test('test@example.com'), true);
  assert.equal(regex.test('contest@example.com'), false);
  assert.equal(regex.test('test@example.com.cn'), false);

  assert.equal(
    EmailReceiver.matchesTargetEmail('test@example.com', {
      to: 'contest@example.com',
      headersText: '',
      bodyText: ''
    }),
    false
  );
});

test('matchesTargetEmail accepts forwarded target in headers or body', () => {
  assert.equal(typeof EmailReceiver.matchesTargetEmail, 'function');

  assert.equal(
    EmailReceiver.matchesTargetEmail('dyny8pqs1cn@dawei2000.xyz', {
      to: '123456789@qq.com',
      headersText: 'Delivered-To: dyny8pqs1cn@dawei2000.xyz X-Original-To: dyny8pqs1cn@dawei2000.xyz',
      bodyText: ''
    }),
    true
  );

  assert.equal(
    EmailReceiver.matchesTargetEmail('dyny8pqs1cn@dawei2000.xyz', {
      to: '123456789@qq.com',
      headersText: '',
      bodyText: 'Forwarded message for dyny8pqs1cn@dawei2000.xyz'
    }),
    true
  );
});

test('findTargetEmailMatchSources reports where the forwarded address was found', () => {
  assert.equal(typeof EmailReceiver.findTargetEmailMatchSources, 'function');
  assert.equal(typeof EmailReceiver.describeTargetEmailMatch, 'function');

  const sources = EmailReceiver.findTargetEmailMatchSources('dyny8pqs1cn@dawei2000.xyz', {
    to: '123456789@qq.com',
    headersText: 'Delivered-To: dyny8pqs1cn@dawei2000.xyz',
    bodyText: 'Please verify dyny8pqs1cn@dawei2000.xyz now'
  });

  assert.deepEqual(sources, ['headers', 'body']);
  assert.equal(
    EmailReceiver.describeTargetEmailMatch('dyny8pqs1cn@dawei2000.xyz', {
      to: '123456789@qq.com',
      headersText: 'Delivered-To: dyny8pqs1cn@dawei2000.xyz',
      bodyText: 'Please verify dyny8pqs1cn@dawei2000.xyz now'
    }),
    'headers, body'
  );
});

test('shouldFetchFullMessageForCandidate only fetches full message when subject lacks a direct code', () => {
  assert.equal(typeof EmailReceiver.shouldFetchFullMessageForCandidate, 'function');

  assert.equal(
    EmailReceiver.shouldFetchFullMessageForCandidate({
      quickTargetMatch: false,
      subject: '541624 - Verify your email address'
    }),
    true
  );

  assert.equal(
    EmailReceiver.shouldFetchFullMessageForCandidate({
      quickTargetMatch: true,
      subject: '541624 - Verify your email address'
    }),
    false
  );

  assert.equal(
    EmailReceiver.shouldFetchFullMessageForCandidate({
      quickTargetMatch: true,
      subject: 'Your ChatGPT code is 541624'
    }),
    false
  );
});

test('buildRecentSequenceNumbers returns newest-first sequence numbers', () => {
  assert.equal(typeof EmailReceiver.buildRecentSequenceNumbers, 'function');

  assert.deepEqual(EmailReceiver.buildRecentSequenceNumbers(0, 5), []);
  assert.deepEqual(EmailReceiver.buildRecentSequenceNumbers(3, 5), [3, 2, 1]);
  assert.deepEqual(EmailReceiver.buildRecentSequenceNumbers(8, 3), [8, 7, 6]);
});

test('buildSequenceNumbersToScan excludes already-confirmed old sequence range', () => {
  assert.equal(typeof EmailReceiver.buildSequenceNumbersToScan, 'function');

  assert.deepEqual(EmailReceiver.buildSequenceNumbersToScan(8, 3, 0), [8, 7, 6]);
  assert.deepEqual(EmailReceiver.buildSequenceNumbersToScan(8, 5, 6), [8, 7]);
  assert.deepEqual(EmailReceiver.buildSequenceNumbersToScan(8, 5, 8), []);
});

test('buildFetchRange uses star to discover new messages beyond known count', () => {
  assert.equal(typeof EmailReceiver.buildFetchRange, 'function');

  // No messages: null
  assert.equal(EmailReceiver.buildFetchRange(0, 200, 0), null);

  // Basic: 350 messages, scan 200, no cutoff → 151:*
  assert.equal(EmailReceiver.buildFetchRange(350, 200, 0), '151:*');

  // Small mailbox: 10 messages, scan 200 → 1:*
  assert.equal(EmailReceiver.buildFetchRange(10, 200, 0), '1:*');

  // With cutoff: 11526 messages, scan 200, cutoff at 11525 → 11526:*
  assert.equal(EmailReceiver.buildFetchRange(11526, 200, 11525), '11526:*');

  // Cutoff beyond recent start: cutoff wins
  assert.equal(EmailReceiver.buildFetchRange(8, 5, 6), '7:*');

  // Cutoff equals total: start = cutoff+1 = total+1, but still returns range
  assert.equal(EmailReceiver.buildFetchRange(8, 5, 8), '9:*');
});

test('updateOldMailSequenceCutoff only moves forward for stale candidates', () => {
  assert.equal(typeof EmailReceiver.updateOldMailSequenceCutoff, 'function');

  assert.equal(
    EmailReceiver.updateOldMailSequenceCutoff(0, 120, { isFresh: false }),
    120
  );

  assert.equal(
    EmailReceiver.updateOldMailSequenceCutoff(120, 118, { isFresh: false }),
    120
  );

  assert.equal(
    EmailReceiver.updateOldMailSequenceCutoff(120, 140, { isFresh: true }),
    120
  );
});

test('getMaxEmailAgeMs defaults to 20 minutes and accepts override', () => {
  assert.equal(typeof EmailReceiver.getMaxEmailAgeMs, 'function');

  assert.equal(EmailReceiver.getMaxEmailAgeMs({}), 20 * 60 * 1000);
  assert.equal(EmailReceiver.getMaxEmailAgeMs({ maxEmailAgeMs: 5 * 60 * 1000 }), 5 * 60 * 1000);
});

test('getMaxScanEmailAgeMs defaults to 60 minutes and accepts override', () => {
  assert.equal(typeof EmailReceiver.getMaxScanEmailAgeMs, 'function');

  assert.equal(EmailReceiver.getMaxScanEmailAgeMs({}), 60 * 60 * 1000);
  assert.equal(EmailReceiver.getMaxScanEmailAgeMs({ maxScanEmailAgeMs: 30 * 60 * 1000 }), 30 * 60 * 1000);
});

test('getStaleTargetSubjectCodeMaxAgeMs defaults to 45 minutes and accepts override', () => {
  assert.equal(typeof EmailReceiver.getStaleTargetSubjectCodeMaxAgeMs, 'function');

  assert.equal(EmailReceiver.getStaleTargetSubjectCodeMaxAgeMs({}), 45 * 60 * 1000);
  assert.equal(
    EmailReceiver.getStaleTargetSubjectCodeMaxAgeMs({ staleTargetSubjectCodeMaxAgeMs: 30 * 60 * 1000 }),
    30 * 60 * 1000
  );
});

test('classifyVerificationEmail keeps candidate detection independent from age window', () => {
  assert.equal(typeof EmailReceiver.classifyVerificationEmail, 'function');

  const staleVerification = EmailReceiver.classifyVerificationEmail({
    subject: 'Your ChatGPT code is 541624',
    from: 'OpenAI <otp@tm1.openai.com>',
    date: '2026-03-24T11:31:57.000Z',
    now: new Date('2026-03-24T12:22:00.000Z').getTime(),
    maxEmailAgeMs: 10 * 60 * 1000
  });

  assert.equal(staleVerification.isVerification, true);
  assert.equal(staleVerification.isFresh, false);
  assert.equal(staleVerification.isWithinScanWindow, true);
  assert.equal(staleVerification.emailAgeMs > 10 * 60 * 1000, true);

  const freshVerification = EmailReceiver.classifyVerificationEmail({
    subject: 'Your ChatGPT code is 541624',
    from: 'OpenAI <otp@tm1.openai.com>',
    date: '2026-03-24T12:15:00.000Z',
    now: new Date('2026-03-24T12:22:00.000Z').getTime(),
    maxEmailAgeMs: 10 * 60 * 1000
  });

  assert.equal(freshVerification.isVerification, true);
  assert.equal(freshVerification.isFresh, true);
  assert.equal(freshVerification.isWithinScanWindow, true);
});

test('classifyVerificationEmail excludes emails outside the latest one-hour scan window', () => {
  assert.equal(typeof EmailReceiver.classifyVerificationEmail, 'function');

  const oldVerification = EmailReceiver.classifyVerificationEmail({
    subject: 'Your ChatGPT code is 541624',
    from: 'OpenAI <otp@tm1.openai.com>',
    date: '2026-03-24T10:30:00.000Z',
    now: new Date('2026-03-24T12:22:00.000Z').getTime(),
    maxEmailAgeMs: 20 * 60 * 1000,
    maxScanEmailAgeMs: 60 * 60 * 1000,
  });

  assert.equal(oldVerification.isVerification, true);
  assert.equal(oldVerification.isFresh, false);
  assert.equal(oldVerification.isWithinScanWindow, false);
});

test('extractVerificationCodeFromSubject supports Windsurf and ChatGPT subjects', () => {
  assert.equal(typeof EmailReceiver.extractVerificationCodeFromSubject, 'function');

  assert.equal(
    EmailReceiver.extractVerificationCodeFromSubject('313935 - Verify your Email with Windsurf'),
    '313935'
  );

  assert.equal(
    EmailReceiver.extractVerificationCodeFromSubject('Your ChatGPT code is 362229'),
    '362229'
  );

  assert.equal(
    EmailReceiver.extractVerificationCodeFromSubject('普通通知邮件'),
    null
  );
});

test('canUseSubjectCodeForTargetEmail allows bounded stale fallback for exact target email', () => {
  assert.equal(typeof EmailReceiver.canUseSubjectCodeForTargetEmail, 'function');

  assert.equal(
    EmailReceiver.canUseSubjectCodeForTargetEmail({
      subjectCode: '362229',
      isTargetEmail: true,
      emailAgeMs: 32 * 60 * 1000,
      maxEmailAgeMs: 20 * 60 * 1000,
      maxScanEmailAgeMs: 60 * 60 * 1000,
      staleTargetSubjectCodeMaxAgeMs: 45 * 60 * 1000,
    }),
    true
  );

  assert.equal(
    EmailReceiver.canUseSubjectCodeForTargetEmail({
      subjectCode: '362229',
      isTargetEmail: true,
      emailAgeMs: 50 * 60 * 1000,
      maxEmailAgeMs: 20 * 60 * 1000,
      maxScanEmailAgeMs: 60 * 60 * 1000,
      staleTargetSubjectCodeMaxAgeMs: 45 * 60 * 1000,
    }),
    true
  );

  assert.equal(
    EmailReceiver.canUseSubjectCodeForTargetEmail({
      subjectCode: '362229',
      isTargetEmail: true,
      emailAgeMs: 61 * 60 * 1000,
      maxEmailAgeMs: 20 * 60 * 1000,
      maxScanEmailAgeMs: 60 * 60 * 1000,
      staleTargetSubjectCodeMaxAgeMs: 45 * 60 * 1000,
    }),
    false
  );

  assert.equal(
    EmailReceiver.canUseSubjectCodeForTargetEmail({
      subjectCode: '362229',
      isTargetEmail: false,
      emailAgeMs: 10 * 60 * 1000,
      maxEmailAgeMs: 20 * 60 * 1000,
      maxScanEmailAgeMs: 60 * 60 * 1000,
      staleTargetSubjectCodeMaxAgeMs: 45 * 60 * 1000,
    }),
    false
  );
});

test('analyzeHeaderScanCandidate keeps candidate visibility even after processing', () => {
  assert.equal(typeof EmailReceiver.analyzeHeaderScanCandidate, 'function');

  const processedEmails = new Set([13263]);
  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 13263,
    subject: 'Your ChatGPT code is 362229',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: 'pdx4ijkb5pct@dawei2000.xyz',
    date: '2026-03-24T12:22:10.000Z',
    targetEmail: 'h23aey9l@dawei2000.xyz',
    processedEmails,
    maxEmailAgeMs: 20 * 60 * 1000,
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isAlreadyProcessed, true);
  assert.equal(state.isTargetEmail, false);
  assert.equal(state.subjectCode, '362229');
});

test('analyzeHeaderScanCandidate identifies exact target recipient from quick headers', () => {
  assert.equal(typeof EmailReceiver.analyzeHeaderScanCandidate, 'function');

  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 20001,
    subject: 'Your ChatGPT code is 921270',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: 'oimmt82vqzh@dawei2000.xyz',
    date: '2026-03-24T12:54:12.000Z',
    targetEmail: 'oimmt82vqzh@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isAlreadyProcessed, false);
  assert.equal(state.isTargetEmail, true);
  assert.deepEqual(state.targetEmailSources, ['to']);
});

test('analyzeHeaderScanCandidate marks emails outside the latest one-hour scan window', () => {
  assert.equal(typeof EmailReceiver.analyzeHeaderScanCandidate, 'function');

  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 20002,
    subject: 'Your ChatGPT code is 921270',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: 'oimmt82vqzh@dawei2000.xyz',
    date: '2026-03-24T10:54:12.000Z',
    targetEmail: 'oimmt82vqzh@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
    maxScanEmailAgeMs: 60 * 60 * 1000,
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.verificationState.isWithinScanWindow, false);
});

test('shouldSwitchToJunkMailbox waits when inbox just received new mail', () => {
  assert.equal(typeof EmailReceiver.shouldSwitchToJunkMailbox, 'function');

  assert.equal(
    EmailReceiver.shouldSwitchToJunkMailbox({
      currentBox: 'INBOX',
      junkBoxChecked: false,
      elapsed: 31000,
      junkCheckThreshold: 30000,
      now: 200000,
      lastInboxMailAt: 195000,
      inboxGracePeriodMs: 15000
    }),
    false
  );

  assert.equal(
    EmailReceiver.shouldSwitchToJunkMailbox({
      currentBox: 'INBOX',
      junkBoxChecked: false,
      elapsed: 31000,
      junkCheckThreshold: 30000,
      now: 200000,
      lastInboxMailAt: 100000,
      inboxGracePeriodMs: 15000
    }),
    true
  );

  assert.equal(
    EmailReceiver.shouldSwitchToJunkMailbox({
      currentBox: 'INBOX',
      junkBoxChecked: false,
      elapsed: 31000,
      junkCheckThreshold: 30000,
      now: 200000,
      lastInboxMailAt: null,
      inboxGracePeriodMs: 15000
    }),
    true
  );
});

test('getJunkCheckThreshold switches early so junk mailbox gets more time', () => {
  assert.equal(typeof EmailReceiver.getJunkCheckThreshold, 'function');

  assert.equal(EmailReceiver.getJunkCheckThreshold(120000), 30000);
  assert.equal(EmailReceiver.getJunkCheckThreshold(60000), 24000);
  assert.equal(EmailReceiver.getJunkCheckThreshold(20000), 15000);
});

// ========== isKnownOtpSender ==========

test('isKnownOtpSender recognizes OpenAI OTP senders', () => {
  assert.equal(typeof EmailReceiver.isKnownOtpSender, 'function');

  assert.equal(EmailReceiver.isKnownOtpSender('OpenAI <otp@tm1.openai.com>'), true);
  assert.equal(EmailReceiver.isKnownOtpSender('noreply <noreply@tm.openai.com>'), true);
  assert.equal(EmailReceiver.isKnownOtpSender('otp@chatgpt.com'), true);
  assert.equal(EmailReceiver.isKnownOtpSender('noreply@openai.com'), true);
});

test('isKnownOtpSender rejects non-OTP OpenAI senders', () => {
  assert.equal(EmailReceiver.isKnownOtpSender('billing@openai.com'), false);
  assert.equal(EmailReceiver.isKnownOtpSender('support@openai.com'), false);
});

test('isKnownOtpSender rejects unrelated senders', () => {
  assert.equal(EmailReceiver.isKnownOtpSender('noreply@windsurf.com'), false);
  assert.equal(EmailReceiver.isKnownOtpSender('service@paypal.com'), false);
  assert.equal(EmailReceiver.isKnownOtpSender(''), false);
});

// ========== analyzeHeaderScanCandidate with headerQuickText ==========

test('analyzeHeaderScanCandidate matches target email via DELIVERED-TO header', () => {
  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 30001,
    subject: 'Your ChatGPT code is 541624',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: '123456789@qq.com',
    date: new Date().toISOString(),
    targetEmail: 'abc123@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
    headerQuickText: 'abc123@dawei2000.xyz',
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isTargetEmail, true);
  assert.equal(state.subjectCode, '541624');
  assert.equal(state.canRelaxMatch, false);
});

test('analyzeHeaderScanCandidate enables canRelaxMatch when TO is QQ forwarding address (not same domain)', () => {
  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 30002,
    subject: 'Your ChatGPT code is 541624',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: '123456789@qq.com',
    date: new Date().toISOString(),
    targetEmail: 'abc123@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
    headerQuickText: '',
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isTargetEmail, false);
  assert.equal(state.isKnownOtpSender, true);
  assert.equal(state.canRelaxMatch, true);
  assert.equal(state.subjectCode, '541624');
});

test('analyzeHeaderScanCandidate BLOCKS canRelaxMatch when TO is a different email on same domain', () => {
  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 30006,
    subject: 'Your ChatGPT code is 487464',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: 'k5mdhklt@dawei2000.xyz',
    date: new Date().toISOString(),
    targetEmail: 'jynmwcq5tyhl@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
    headerQuickText: '',
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isTargetEmail, false);
  assert.equal(state.isKnownOtpSender, true);
  assert.equal(state.canRelaxMatch, false);
});

test('analyzeHeaderScanCandidate does NOT enable canRelaxMatch for non-OTP senders', () => {
  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 30003,
    subject: '313935 - Verify your Email with Windsurf',
    from: 'noreply@windsurf.com',
    to: '123456789@qq.com',
    date: new Date().toISOString(),
    targetEmail: 'abc123@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
    headerQuickText: '',
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isTargetEmail, false);
  assert.equal(state.isKnownOtpSender, false);
  assert.equal(state.canRelaxMatch, false);
});

test('analyzeHeaderScanCandidate does NOT enable canRelaxMatch when subject has no code', () => {
  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 30004,
    subject: 'Your ChatGPT verification',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: '123456789@qq.com',
    date: new Date().toISOString(),
    targetEmail: 'abc123@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
    headerQuickText: '',
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isTargetEmail, false);
  assert.equal(state.isKnownOtpSender, true);
  assert.equal(state.canRelaxMatch, false);
  assert.equal(state.subjectCode, null);
});

// ========== toFieldBelongsToDifferentRecipient ==========

test('toFieldBelongsToDifferentRecipient detects same-domain different recipient', () => {
  assert.equal(typeof EmailReceiver.toFieldBelongsToDifferentRecipient, 'function');

  // TO 是同域名的不同邮箱 → 属于其他收件人
  assert.equal(
    EmailReceiver.toFieldBelongsToDifferentRecipient('k5mdhklt@dawei2000.xyz', 'jynmwcq5tyhl@dawei2000.xyz'),
    true
  );

  // TO 就是目标邮箱 → 不属于其他收件人
  assert.equal(
    EmailReceiver.toFieldBelongsToDifferentRecipient('jynmwcq5tyhl@dawei2000.xyz', 'jynmwcq5tyhl@dawei2000.xyz'),
    false
  );

  // TO 是 QQ 邮箱（不同域名）→ 不属于其他收件人（可能是转发）
  assert.equal(
    EmailReceiver.toFieldBelongsToDifferentRecipient('123456789@qq.com', 'jynmwcq5tyhl@dawei2000.xyz'),
    false
  );

  // TO 为空 → 不属于其他收件人
  assert.equal(
    EmailReceiver.toFieldBelongsToDifferentRecipient('', 'jynmwcq5tyhl@dawei2000.xyz'),
    false
  );
});

test('analyzeHeaderScanCandidate does NOT enable canRelaxMatch for stale emails', () => {
  const now = Date.now();
  const staleDate = new Date(now - 25 * 60 * 1000).toISOString();

  const state = EmailReceiver.analyzeHeaderScanCandidate({
    emailId: 30005,
    subject: 'Your ChatGPT code is 541624',
    from: 'OpenAI <otp@tm1.openai.com>',
    to: '123456789@qq.com',
    date: staleDate,
    targetEmail: 'abc123@dawei2000.xyz',
    processedEmails: new Set(),
    maxEmailAgeMs: 20 * 60 * 1000,
    headerQuickText: '',
  });

  assert.equal(state.isCandidate, true);
  assert.equal(state.isTargetEmail, false);
  assert.equal(state.isKnownOtpSender, true);
  assert.equal(state.canRelaxMatch, false);
  assert.equal(state.verificationState.isFresh, false);
});
