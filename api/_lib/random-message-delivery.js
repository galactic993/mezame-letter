'use strict';

var crypto = require('node:crypto');

var DEFAULT_CAMPAIGN_KEY = '2026-03-13';
var DEFAULT_ACCEPTANCE_DEADLINE_JST = '2026-03-11T23:59:59.999+09:00';
var DEFAULT_SEND_DATE_JST = '2026-03-13T00:00:00+09:00';
var DEFAULT_SEND_DELAY_MINUTES = 90;
var DEFAULT_SHUFFLE_COUNT = 1568;

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeEmail(value) {
  return normalizeString(value).toLowerCase();
}

function compareIso(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function buildParticipantGroups(rows) {
  var groupsByEmail = new Map();
  var index;

  for (index = 0; index < rows.length; index += 1) {
    var row = rows[index] || {};
    var email = normalizeEmail(row.email);

    if (!email) {
      continue;
    }

    if (!groupsByEmail.has(email)) {
      groupsByEmail.set(email, {
        email: email,
        name: normalizeString(row.name) || email,
        submissions: []
      });
    }

    var group = groupsByEmail.get(email);
    if (!group.name && row.name) {
      group.name = normalizeString(row.name);
    }

    group.submissions.push({
      id: row.id == null ? null : row.id,
      submittedAt: row.submitted_at || null,
      message: normalizeString(row.message)
    });
  }

  var groups = Array.from(groupsByEmail.values());
  groups.sort(function (left, right) {
    return left.email.localeCompare(right.email);
  });

  for (index = 0; index < groups.length; index += 1) {
    groups[index].submissions.sort(function (left, right) {
      var submittedAtDiff = compareIso(left.submittedAt, right.submittedAt);
      if (submittedAtDiff !== 0) {
        return submittedAtDiff;
      }
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
  }

  return groups;
}

function sattoloShuffle(items, randomIntFn) {
  var result = items.slice();
  var index;

  for (index = result.length - 1; index > 0; index -= 1) {
    var swapIndex = randomIntFn(index);
    var tmp = result[index];
    result[index] = result[swapIndex];
    result[swapIndex] = tmp;
  }

  return result;
}

function createAssignments(participants, options) {
  var opts = options || {};
  var shuffleCount = opts.shuffleCount == null ? DEFAULT_SHUFFLE_COUNT : Number(opts.shuffleCount);
  var randomIntFn = opts.randomIntFn;
  var iteration;
  var recipients = participants.slice();
  var assignments = [];
  var index;

  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error('ランダム送信には2件以上の一意なメールアドレスが必要です。');
  }

  if (!Number.isInteger(shuffleCount) || shuffleCount <= 0) {
    throw new Error('shuffleCount は正の整数である必要があります。');
  }

  if (typeof randomIntFn !== 'function') {
    throw new Error('randomIntFn が必要です。');
  }

  for (iteration = 0; iteration < shuffleCount; iteration += 1) {
    recipients = sattoloShuffle(participants, randomIntFn);
  }

  for (index = 0; index < participants.length; index += 1) {
    if (participants[index].email === recipients[index].email) {
      throw new Error('自己配送を回避できませんでした。');
    }

    assignments.push({
      senderEmail: participants[index].email,
      senderName: participants[index].name,
      senderMessages: participants[index].submissions,
      senderMessageCount: participants[index].submissions.length,
      recipientEmail: recipients[index].email,
      recipientName: recipients[index].name,
      shuffleCount: shuffleCount,
      accessToken: createAccessToken()
    });
  }

  return assignments;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMessageListHtml(messages) {
  return messages.map(function (entry, index) {
    var lines = escapeHtml(entry.message || '').replace(/\r?\n/g, '<br>');
    return '<section style="margin:0 0 24px;">'
      + '<p style="margin:0 0 8px;font-size:13px;color:#8a7e72;">メッセージ ' + (index + 1) + '</p>'
      + '<div style="padding:16px 18px;border-radius:14px;background:#f6efe7;color:#2d1f12;line-height:1.9;">' + lines + '</div>'
      + '</section>';
  }).join('');
}

function formatMessageListText(messages) {
  return messages.map(function (entry, index) {
    return [
      'メッセージ ' + (index + 1),
      entry.message || ''
    ].join('\n');
  }).join('\n\n');
}

function resolveBaseUrl(value) {
  var normalized = normalizeString(value);

  if (!normalized) {
    return '';
  }

  return normalized.replace(/\/+$/, '');
}

function createAccessToken() {
  return crypto.randomBytes(24).toString('hex');
}

function buildAccessUrl(token, config) {
  var baseUrl = resolveBaseUrl(config.baseUrl);

  if (!baseUrl) {
    throw new Error('PUBLIC_SITE_URL が設定されていません。');
  }

  return baseUrl + '/message.html?token=' + encodeURIComponent(token);
}

function formatJstDateLabel(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

function buildEmailPayload(assignment, config) {
  var fromEmail = normalizeString(config.fromEmail);
  var replyToEmail = normalizeString(config.replyToEmail);
  var sendDate = config.sendDate instanceof Date ? config.sendDate : parseDateOrThrow(config.sendDate, 'sendDate');
  var senderName = normalizeString(assignment.senderName) || '目醒め人';
  var sendDateLabel = formatJstDateLabel(sendDate);
  var accessUrl = buildAccessUrl(assignment.accessToken, {
    baseUrl: config.baseUrl
  });
  var messageCountLabel = assignment.senderMessageCount > 1
    ? senderName + ' さんから届いた ' + assignment.senderMessageCount + ' 通のメッセージ'
    : senderName + ' さんから届いたメッセージ';
  var textBody = [
    assignment.recipientName + ' さんへ',
    '',
    sendDateLabel + 'の目醒めレターが届いています。',
    messageCountLabel + ' は、下の専用ページから受け取れます。',
    '',
    accessUrl,
    '',
    'このURLはあなた専用です。このメールは目醒めレター企画のランダム送信でお届けしています。'
  ].join('\n');

  var htmlBody = [
    '<div style="font-family:\'Noto Sans JP\',\'Hiragino Sans\',sans-serif;background:#0a0a2e;padding:32px 16px;color:#e8e0d8;">',
    '<div style="max-width:640px;margin:0 auto;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:32px 24px;">',
    '<p style="margin:0 0 12px;font-size:14px;letter-spacing:0.08em;color:#d4a574;">MEZAME LETTER</p>',
    '<h1 style="margin:0 0 16px;font-family:\'Noto Serif JP\',serif;font-size:28px;line-height:1.4;color:#f8f1ea;">あなた宛ての目醒めレターが届いています</h1>',
    '<p style="margin:0 0 24px;line-height:1.9;">' + escapeHtml(assignment.recipientName) + ' さんへ。<br>' + escapeHtml(sendDateLabel) + 'に循環する ' + escapeHtml(messageCountLabel) + ' は、専用ページで開封できます。</p>',
    '<p style="margin:0 0 24px;"><a href="' + escapeHtml(accessUrl) + '" style="display:inline-block;padding:14px 22px;border-radius:999px;background:#d4a574;color:#171127;text-decoration:none;font-weight:700;">メッセージをひらく</a></p>',
    '<p style="margin:0 0 16px;font-size:14px;line-height:1.8;color:#d9d0c6;">ボタンが開けない場合は、こちらのURLをブラウザに貼り付けてください。</p>',
    '<p style="margin:0 0 24px;font-size:13px;line-height:1.8;word-break:break-all;color:#f3eadf;">' + escapeHtml(accessUrl) + '</p>',
    '<p style="margin:24px 0 0;font-size:13px;line-height:1.8;color:#bfb4aa;">このURLは受信者ごとに個別発行されています。</p>',
    '</div>',
    '</div>'
  ].join('');

  var payload = {
    from: fromEmail,
    to: [assignment.recipientEmail],
    subject: '【目醒めレター】あなたへ届いたメッセージ',
    html: htmlBody,
    text: textBody
  };

  if (replyToEmail) {
    payload.reply_to = replyToEmail;
  }

  return payload;
}

function parseDateOrThrow(value, label) {
  var parsed = new Date(value);

  if (String(parsed) === 'Invalid Date') {
    throw new Error(label + ' の日付形式が不正です。');
  }

  return parsed;
}

function parsePositiveInteger(value, label) {
  var parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(label + ' は0以上の整数である必要があります。');
  }

  return parsed;
}

function resolveCampaignConfig(env) {
  var runtimeEnv = env || process.env;
  var shuffleCount = runtimeEnv.RANDOM_MESSAGE_SHUFFLE_COUNT || DEFAULT_SHUFFLE_COUNT;
  var acceptanceDeadline = parseDateOrThrow(
    runtimeEnv.RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST || DEFAULT_ACCEPTANCE_DEADLINE_JST,
    'RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST'
  );
  var sendDelayMinutes = parsePositiveInteger(
    runtimeEnv.RANDOM_MESSAGE_SEND_DELAY_MINUTES || DEFAULT_SEND_DELAY_MINUTES,
    'RANDOM_MESSAGE_SEND_DELAY_MINUTES'
  );
  var sendDate = runtimeEnv.RANDOM_MESSAGE_SEND_DATE_JST
    ? parseDateOrThrow(runtimeEnv.RANDOM_MESSAGE_SEND_DATE_JST, 'RANDOM_MESSAGE_SEND_DATE_JST')
    : new Date(acceptanceDeadline.getTime() + sendDelayMinutes * 60 * 1000);

  return {
    campaignKey: runtimeEnv.RANDOM_MESSAGE_CAMPAIGN_KEY || DEFAULT_CAMPAIGN_KEY,
    acceptanceDeadline: acceptanceDeadline,
    sendDate: sendDate,
    sendDelayMinutes: sendDelayMinutes,
    shuffleCount: Number(shuffleCount),
    resendApiKey: normalizeString(runtimeEnv.RESEND_API_KEY),
    resendFromEmail: normalizeString(runtimeEnv.RESEND_FROM_EMAIL),
    resendReplyToEmail: normalizeString(runtimeEnv.RESEND_REPLY_TO_EMAIL),
    publicSiteUrl: resolveBaseUrl(runtimeEnv.PUBLIC_SITE_URL || runtimeEnv.SITE_URL || runtimeEnv.APP_BASE_URL),
    cronSecret: normalizeString(runtimeEnv.CRON_SECRET),
    supabaseUrl: normalizeString(runtimeEnv.SUPABASE_URL),
    supabaseServiceRoleKey: normalizeString(runtimeEnv.SUPABASE_SERVICE_ROLE_KEY),
    supabaseSchema: normalizeString(runtimeEnv.SUPABASE_SCHEMA) || 'public',
    submissionsTable: normalizeString(runtimeEnv.SUPABASE_MESSAGES_TABLE) || 'form_submissions',
    assignmentsTable: normalizeString(runtimeEnv.SUPABASE_DELIVERY_ASSIGNMENTS_TABLE) || 'message_delivery_assignments'
  };
}

function assertRequiredConfig(config) {
  var missing = [];

  if (!config.resendApiKey) {
    missing.push('RESEND_API_KEY');
  }
  if (!config.resendFromEmail) {
    missing.push('RESEND_FROM_EMAIL');
  }
  if (!config.cronSecret) {
    missing.push('CRON_SECRET');
  }
  if (!config.publicSiteUrl) {
    missing.push('PUBLIC_SITE_URL');
  }
  if (!config.supabaseUrl) {
    missing.push('SUPABASE_URL');
  }
  if (!config.supabaseServiceRoleKey) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (!Number.isInteger(config.shuffleCount) || config.shuffleCount <= 0) {
    missing.push('RANDOM_MESSAGE_SHUFFLE_COUNT');
  }

  if (missing.length > 0) {
    var configError = new Error('必要な環境変数が不足しています: ' + missing.join(', '));
    configError.statusCode = 500;
    configError.type = 'CONFIG_ERROR';
    throw configError;
  }
}

module.exports = {
  DEFAULT_ACCEPTANCE_DEADLINE_JST: DEFAULT_ACCEPTANCE_DEADLINE_JST,
  DEFAULT_CAMPAIGN_KEY: DEFAULT_CAMPAIGN_KEY,
  DEFAULT_SEND_DELAY_MINUTES: DEFAULT_SEND_DELAY_MINUTES,
  DEFAULT_SEND_DATE_JST: DEFAULT_SEND_DATE_JST,
  DEFAULT_SHUFFLE_COUNT: DEFAULT_SHUFFLE_COUNT,
  assertRequiredConfig: assertRequiredConfig,
  buildAccessUrl: buildAccessUrl,
  buildEmailPayload: buildEmailPayload,
  buildParticipantGroups: buildParticipantGroups,
  createAssignments: createAssignments,
  normalizeEmail: normalizeEmail,
  normalizeString: normalizeString,
  resolveCampaignConfig: resolveCampaignConfig
};
