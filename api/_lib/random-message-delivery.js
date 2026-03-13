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
    var deliverableMessages = selectDeliverableMessages(participants[index].submissions);

    if (participants[index].email === recipients[index].email) {
      throw new Error('自己配送を回避できませんでした。');
    }

    assignments.push({
      senderEmail: participants[index].email,
      senderName: participants[index].name,
      senderMessages: deliverableMessages,
      senderMessageCount: deliverableMessages.length,
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

function selectDeliverableMessages(messages) {
  var normalizedMessages = Array.isArray(messages) ? messages.filter(function (entry) {
    return normalizeString(entry && entry.message);
  }) : [];

  if (normalizedMessages.length === 0) {
    return [{
      id: null,
      submittedAt: null,
      message: ''
    }];
  }

  return [normalizedMessages[normalizedMessages.length - 1]];
}

function getPrimaryMessageText(messages) {
  var deliverableMessages = selectDeliverableMessages(messages);
  return normalizeString(deliverableMessages[0] && deliverableMessages[0].message);
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

function buildEmailContent(assignment, config) {
  var sendDate = config.sendDate instanceof Date ? config.sendDate : parseDateOrThrow(config.sendDate, 'sendDate');
  var sendDateLabel = formatJstDateLabel(sendDate);
  var messageText = getPrimaryMessageText(assignment.senderMessages);
  var messageHtml = escapeHtml(messageText).replace(/\r?\n/g, '<br>');
  var subject = '【目醒めレター】あなたへ届いたメッセージ';
  var textBody = [
    assignment.recipientName + ' さんへ',
    '',
    sendDateLabel + 'の目醒めレターが届いています。',
    '',
    messageText,
    '',
    'このメールは目醒めレター企画のランダム送信でお届けしています。'
  ].join('\n');

  var htmlBody = [
    '<div style="font-family:\'Noto Sans JP\',\'Hiragino Sans\',sans-serif;background:#0a0a2e;padding:32px 16px;color:#e8e0d8;">',
    '<div style="max-width:640px;margin:0 auto;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:32px 24px;">',
    '<p style="margin:0 0 12px;font-size:14px;letter-spacing:0.08em;color:#d4a574;">MEZAME LETTER</p>',
    '<h1 style="margin:0 0 16px;font-family:\'Noto Serif JP\',serif;font-size:28px;line-height:1.4;color:#f8f1ea;">あなた宛ての目醒めレターが届いています</h1>',
    '<p style="margin:0 0 24px;line-height:1.9;">' + escapeHtml(assignment.recipientName) + ' さんへ。<br>' + escapeHtml(sendDateLabel) + 'の目醒めレターをお届けします。</p>',
    '<section style="margin:0 0 24px;">'
      + '<p style="margin:0 0 8px;font-size:13px;color:#d9d0c6;">あなたに届いたメッセージ</p>'
      + '<div style="padding:16px 18px;border-radius:14px;background:#f6efe7;color:#2d1f12;line-height:1.9;">' + messageHtml + '</div>'
      + '</section>',
    '<p style="margin:24px 0 0;font-size:13px;line-height:1.8;color:#bfb4aa;">このメールは目醒めレター企画のランダム送信でお届けしています。</p>',
    '</div>',
    '</div>'
  ].join('');

  return {
    subject: subject,
    html: htmlBody,
    text: textBody
  };
}

function buildEmailPayload(assignment, config) {
  var fromEmail = normalizeString(config.fromEmail);
  var replyToEmail = normalizeString(config.replyToEmail);
  var content = buildEmailContent(assignment, config);
  var payload = {
    from: fromEmail,
    to: [assignment.recipientEmail],
    subject: content.subject,
    html: content.html,
    text: content.text
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

function createConfigAssertion(requiredEntries) {
  return function assertConfig(config) {
    var missing = [];
    var index;

    for (index = 0; index < requiredEntries.length; index += 1) {
      if (!requiredEntries[index].isValid(config)) {
        missing.push(requiredEntries[index].name);
      }
    }

    if (missing.length > 0) {
      var configError = new Error('必要な環境変数が不足しています: ' + missing.join(', '));
      configError.statusCode = 500;
      configError.type = 'CONFIG_ERROR';
      throw configError;
    }
  };
}

var assertSupabaseConfig = createConfigAssertion([
  {
    name: 'SUPABASE_URL',
    isValid: function (config) {
      return Boolean(config.supabaseUrl);
    }
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    isValid: function (config) {
      return Boolean(config.supabaseServiceRoleKey);
    }
  }
]);

var assertDraftConfig = createConfigAssertion([
  {
    name: 'CRON_SECRET',
    isValid: function (config) {
      return Boolean(config.cronSecret);
    }
  },
  {
    name: 'PUBLIC_SITE_URL',
    isValid: function (config) {
      return Boolean(config.publicSiteUrl);
    }
  },
  {
    name: 'RANDOM_MESSAGE_SHUFFLE_COUNT',
    isValid: function (config) {
      return Number.isInteger(config.shuffleCount) && config.shuffleCount > 0;
    }
  },
  {
    name: 'SUPABASE_URL',
    isValid: function (config) {
      return Boolean(config.supabaseUrl);
    }
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    isValid: function (config) {
      return Boolean(config.supabaseServiceRoleKey);
    }
  }
]);

var assertDispatchConfig = createConfigAssertion([
  {
    name: 'CRON_SECRET',
    isValid: function (config) {
      return Boolean(config.cronSecret);
    }
  },
  {
    name: 'PUBLIC_SITE_URL',
    isValid: function (config) {
      return Boolean(config.publicSiteUrl);
    }
  },
  {
    name: 'RANDOM_MESSAGE_SHUFFLE_COUNT',
    isValid: function (config) {
      return Number.isInteger(config.shuffleCount) && config.shuffleCount > 0;
    }
  },
  {
    name: 'RESEND_API_KEY',
    isValid: function (config) {
      return Boolean(config.resendApiKey);
    }
  },
  {
    name: 'RESEND_FROM_EMAIL',
    isValid: function (config) {
      return Boolean(config.resendFromEmail);
    }
  },
  {
    name: 'SUPABASE_URL',
    isValid: function (config) {
      return Boolean(config.supabaseUrl);
    }
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    isValid: function (config) {
      return Boolean(config.supabaseServiceRoleKey);
    }
  }
]);

var assertRequiredConfig = assertDispatchConfig;

module.exports = {
  DEFAULT_ACCEPTANCE_DEADLINE_JST: DEFAULT_ACCEPTANCE_DEADLINE_JST,
  DEFAULT_CAMPAIGN_KEY: DEFAULT_CAMPAIGN_KEY,
  DEFAULT_SEND_DELAY_MINUTES: DEFAULT_SEND_DELAY_MINUTES,
  DEFAULT_SEND_DATE_JST: DEFAULT_SEND_DATE_JST,
  DEFAULT_SHUFFLE_COUNT: DEFAULT_SHUFFLE_COUNT,
  assertDispatchConfig: assertDispatchConfig,
  assertDraftConfig: assertDraftConfig,
  assertRequiredConfig: assertRequiredConfig,
  assertSupabaseConfig: assertSupabaseConfig,
  buildEmailContent: buildEmailContent,
  buildAccessUrl: buildAccessUrl,
  buildEmailPayload: buildEmailPayload,
  buildParticipantGroups: buildParticipantGroups,
  createAssignments: createAssignments,
  getPrimaryMessageText: getPrimaryMessageText,
  normalizeEmail: normalizeEmail,
  normalizeString: normalizeString,
  resolveCampaignConfig: resolveCampaignConfig
};
