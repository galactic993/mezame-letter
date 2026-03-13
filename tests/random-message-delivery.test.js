'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var deliveryLib = require('../api/_lib/random-message-delivery');
var draftHandler = require('../api/send-random-messages');
var dispatchHandler = require('../api/send-random-message-drafts');

var TRACKED_ENV_KEYS = [
  'CRON_SECRET',
  'RANDOM_MESSAGE_SHUFFLE_COUNT',
  'RANDOM_MESSAGE_SEND_DATE_JST',
  'RANDOM_MESSAGE_SEND_DELAY_MINUTES',
  'RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST',
  'RANDOM_MESSAGE_CAMPAIGN_KEY',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_REPLY_TO_EMAIL',
  'PUBLIC_SITE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SCHEMA',
  'SUPABASE_MESSAGES_TABLE',
  'SUPABASE_DELIVERY_ASSIGNMENTS_TABLE'
];

function createResponseRecorder() {
  var headers = {};
  var rawBody = '';

  return {
    statusCode: 200,
    headers: headers,
    setHeader: function (name, value) {
      headers[name] = value;
    },
    end: function (chunk) {
      rawBody = chunk || '';
    },
    getBody: function () {
      return rawBody;
    }
  };
}

function restoreTrackedEnv(snapshot) {
  var index;
  for (index = 0; index < TRACKED_ENV_KEYS.length; index += 1) {
    var key = TRACKED_ENV_KEYS[index];
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function setTrackedEnv(overrides) {
  var snapshot = {};
  var values = overrides || {};
  var index;

  for (index = 0; index < TRACKED_ENV_KEYS.length; index += 1) {
    var key = TRACKED_ENV_KEYS[index];
    snapshot[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      process.env[key] = values[key];
    } else {
      delete process.env[key];
    }
  }

  return snapshot;
}

async function invokeHandler(handler, request, options) {
  var opts = options || {};
  var req = {
    method: request.method || 'GET',
    headers: request.headers || {},
    body: request.body,
    query: request.query || {}
  };
  var res = createResponseRecorder();
  var envSnapshot = setTrackedEnv(opts.env);
  var originalFetch = global.fetch;
  var originalConsoleError = console.error;

  if (opts.fetchImpl) {
    global.fetch = opts.fetchImpl;
  }
  if (opts.muteConsoleError) {
    console.error = function () {};
  }

  try {
    await handler(req, res);
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
    restoreTrackedEnv(envSnapshot);
  }

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: JSON.parse(res.getBody())
  };
}

test('buildParticipantGroups は同一メールアドレスの投稿を束ねる', function () {
  var groups = deliveryLib.buildParticipantGroups([
    {
      id: 2,
      name: 'Alice',
      email: 'Alice@example.com',
      message: 'ふたつめ',
      submitted_at: '2026-03-10T01:00:00.000Z'
    },
    {
      id: 1,
      name: 'Alice',
      email: ' alice@example.com ',
      message: 'ひとつめ',
      submitted_at: '2026-03-09T01:00:00.000Z'
    },
    {
      id: 3,
      name: 'Bob',
      email: 'bob@example.com',
      message: 'こんにちは',
      submitted_at: '2026-03-08T01:00:00.000Z'
    }
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].email, 'alice@example.com');
  assert.equal(groups[0].submissions.length, 2);
  assert.equal(groups[0].submissions[0].message, 'ひとつめ');
  assert.equal(groups[0].submissions[1].message, 'ふたつめ');
});

test('createAssignments は自己配送なしで 1568 回シャッフル結果を返す', function () {
  var participants = deliveryLib.buildParticipantGroups([
    { id: 1, name: 'Alice', email: 'alice@example.com', message: 'A', submitted_at: '2026-03-10T00:00:00.000Z' },
    { id: 2, name: 'Bob', email: 'bob@example.com', message: 'B', submitted_at: '2026-03-10T00:00:00.000Z' },
    { id: 3, name: 'Carol', email: 'carol@example.com', message: 'C', submitted_at: '2026-03-10T00:00:00.000Z' }
  ]);
  var calls = 0;
  var assignments = deliveryLib.createAssignments(participants, {
    shuffleCount: 1568,
    randomIntFn: function (maxExclusive) {
      calls += 1;
      return maxExclusive - 1;
    }
  });

  assert.equal(assignments.length, 3);
  assert.equal(calls, 1568 * 2);
  assert.notEqual(assignments[0].senderEmail, assignments[0].recipientEmail);
  assert.equal(assignments[0].shuffleCount, 1568);
  assert.match(assignments[0].accessToken, /^[a-f0-9]{48}$/);
  assert.equal(assignments[0].senderMessageCount, 1);
});

test('createAssignments は重複投稿があっても配信本文は最新1件に絞る', function () {
  var participants = deliveryLib.buildParticipantGroups([
    { id: 1, name: 'Alice', email: 'alice@example.com', message: '最初の投稿', submitted_at: '2026-03-10T00:00:00.000Z' },
    { id: 2, name: 'Alice', email: 'alice@example.com', message: '最後の投稿', submitted_at: '2026-03-11T00:00:00.000Z' },
    { id: 3, name: 'Bob', email: 'bob@example.com', message: 'B', submitted_at: '2026-03-10T00:00:00.000Z' }
  ]);
  var assignments = deliveryLib.createAssignments(participants, {
    shuffleCount: 1,
    randomIntFn: function () {
      return 0;
    }
  });

  assert.equal(assignments[0].senderMessageCount, 1);
  assert.equal(assignments[0].senderMessages.length, 1);
  assert.equal(assignments[0].senderMessages[0].message, '最後の投稿');
});

test('resolveCampaignConfig は締切の90分後を既定の送信開始日時にする', function () {
  var config = deliveryLib.resolveCampaignConfig({
    RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST: '2026-03-13T17:30:00+09:00',
    RANDOM_MESSAGE_SEND_DELAY_MINUTES: '90'
  });

  assert.equal(config.sendDate.toISOString(), '2026-03-13T10:00:00.000Z');
  assert.equal(config.sendDelayMinutes, 90);
});

test('buildEmailContent と buildEmailPayload は本文とURLを組み立てる', function () {
  var content = deliveryLib.buildEmailContent({
    senderName: 'Alice',
    senderMessages: [{ id: 1, message: '起きて、光を見て。' }],
    senderMessageCount: 1,
    recipientName: 'Bob',
    accessToken: 'abc123token'
  }, {
    sendDate: new Date('2026-03-13T10:00:00.000Z'),
    baseUrl: 'https://mezame.example.com/'
  });

  var payload = deliveryLib.buildEmailPayload({
    recipientEmail: 'bob@example.com',
    senderName: 'Alice',
    senderMessages: [{ id: 1, message: '起きて、光を見て。' }],
    senderMessageCount: 1,
    recipientName: 'Bob',
    accessToken: 'abc123token'
  }, {
    fromEmail: 'hello@example.com',
    replyToEmail: 'reply@example.com',
    sendDate: new Date('2026-03-13T10:00:00.000Z'),
    baseUrl: 'https://mezame.example.com/'
  });

  assert.equal(content.subject, '【目醒めレター】あなたへ届いたメッセージ');
  assert.match(content.text, /目醒め人から預かったお手紙をお届けします。/);
  assert.match(content.text, /あなたに届いたメッセージ/);
  assert.match(content.text, /起きて、光を見て。/);
  assert.match(content.html, /Message/);
  assert.match(content.html, /起きて、光を見て。/);
  assert.match(content.html, /font-size:24px/);
  assert.match(content.text, /この度はメッセージを送信していただき、ありがとうございました。/);
  assert.match(content.text, /あなたの大切なメッセージも、目醒め人に大切にお届けいたしました。/);
  assert.match(content.html, /目醒め人から預かったお手紙をお届けします。/);
  assert.doesNotMatch(content.text, /Alice/);
  assert.doesNotMatch(content.html, /Alice/);
  assert.doesNotMatch(content.text, /message\.html/);
  assert.doesNotMatch(content.html, /message\.html/);
  assert.equal(payload.from, 'hello@example.com');
  assert.equal(payload.reply_to, 'reply@example.com');
  assert.equal(payload.subject, content.subject);
  assert.equal(payload.html, content.html);
  assert.equal(payload.text, content.text);
});

test('send-random-messages は投稿締切前なら 409 を返す', async function () {
  var result = await invokeHandler(
    draftHandler,
    {
      method: 'GET',
      headers: {
        authorization: 'Bearer top-secret',
        'x-force-now': '2026-03-12T00:00:00.000+09:00'
      }
    },
    {
      env: {
        CRON_SECRET: 'top-secret',
        RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST: '2026-03-12T22:30:00.000+09:00',
        RANDOM_MESSAGE_SEND_DELAY_MINUTES: '90',
        PUBLIC_SITE_URL: 'https://mezame.example.com',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      fetchImpl: async function () {
        throw new Error('fetch should not be called');
      }
    }
  );

  assert.equal(result.statusCode, 409);
  assert.equal(result.body.ok, false);
});

test('send-random-messages は未作成の割り当てを生成して下書きを保存する', async function () {
  var fetchCalls = [];

  var result = await invokeHandler(
    draftHandler,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer top-secret',
        'x-force-now': '2026-03-13T09:30:00.000+09:00'
      }
    },
    {
      env: {
        CRON_SECRET: 'top-secret',
        RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST: '2026-03-11T23:59:59.999+09:00',
        RANDOM_MESSAGE_SEND_DELAY_MINUTES: '90',
        RANDOM_MESSAGE_SHUFFLE_COUNT: '1',
        PUBLIC_SITE_URL: 'https://mezame.example.com',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      muteConsoleError: true,
      fetchImpl: async function (url, options) {
        fetchCalls.push({ url: url, options: options });

        if (/message_delivery_assignments\?/.test(url) && options.method === 'GET') {
          if (fetchCalls.filter(function (entry) {
            return /message_delivery_assignments\?/.test(entry.url) && entry.options.method === 'GET';
          }).length === 1) {
            return {
              ok: true,
              status: 200,
              json: async function () {
                return [];
              }
            };
          }

          return {
            ok: true,
            status: 200,
            json: async function () {
              return [
                {
                  id: 11,
                  campaign_key: '2026-03-13',
                  sender_email: 'alice@example.com',
                  sender_name: 'Alice',
                  sender_messages: [{ id: 1, message: 'A' }],
                  sender_message_count: 1,
                  recipient_email: 'bob@example.com',
                  recipient_name: 'Bob',
                  access_token: 'token-alice',
                  shuffle_count: 1,
                  status: 'draft',
                  email_subject: '【目醒めレター】あなたへ届いたメッセージ',
                  email_html: '<p>html</p>',
                  email_text: 'text'
                },
                {
                  id: 12,
                  campaign_key: '2026-03-13',
                  sender_email: 'bob@example.com',
                  sender_name: 'Bob',
                  sender_messages: [{ id: 2, message: 'B' }],
                  sender_message_count: 1,
                  recipient_email: 'alice@example.com',
                  recipient_name: 'Alice',
                  access_token: 'token-bob',
                  shuffle_count: 1,
                  status: 'draft',
                  email_subject: '【目醒めレター】あなたへ届いたメッセージ',
                  email_html: '<p>html</p>',
                  email_text: 'text'
                }
              ];
            }
          };
        }

        if (/form_submissions\?/.test(url) && options.method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async function () {
              return [
                {
                  id: 1,
                  name: 'Alice',
                  email: 'alice@example.com',
                  message: 'A',
                  submitted_at: '2026-03-10T00:00:00.000Z'
                },
                {
                  id: 2,
                  name: 'Bob',
                  email: 'bob@example.com',
                  message: 'B',
                  submitted_at: '2026-03-10T00:00:00.000Z'
                }
              ];
            }
          };
        }

        if (/message_delivery_assignments$/.test(url) && options.method === 'POST') {
          return {
            ok: true,
            status: 201,
            json: async function () {
              return [];
            }
          };
        }

        if (/message_delivery_assignments\?id=eq\.11/.test(url) && options.method === 'PATCH') {
          return {
            ok: true,
            status: 204,
            json: async function () {
              return [];
            }
          };
        }

        if (/message_delivery_assignments\?id=eq\.12/.test(url) && options.method === 'PATCH') {
          return {
            ok: true,
            status: 204,
            json: async function () {
              return [];
            }
          };
        }

        if (url === 'https://api.resend.com/emails') {
          throw new Error('Resend should not be called while drafting');
        }

        throw new Error('Unexpected fetch call: ' + options.method + ' ' + url);
      }
    }
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.summary.assignmentCount, 2);
  assert.equal(result.body.summary.planCreated, true);
  assert.equal(result.body.summary.draftCount, 2);
  assert.ok(fetchCalls.some(function (entry) {
    return /message_delivery_assignments$/.test(entry.url)
      && entry.options.method === 'POST'
      && /"status":"draft"/.test(entry.options.body)
      && /"email_subject":"【目醒めレター】あなたへ届いたメッセージ"/.test(entry.options.body)
      && /"email_text":"Bob さんへ\\n\\n目醒め人から預かったお手紙をお届けします。\\n\\n────────────\\nあなたに届いたメッセージ\\n────────────\\n\\nA\\n\\nこの度はメッセージを送信していただき、ありがとうございました。\\nあなたの大切なメッセージも、目醒め人に大切にお届けいたしました。"/.test(entry.options.body)
      && /font-size:24px/.test(entry.options.body)
      && !/Alice さんから/.test(entry.options.body);
  }));
});

test('send-random-messages は legacy planned レコードの下書きを補完する', async function () {
  var fetchCalls = [];

  var result = await invokeHandler(
    draftHandler,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer top-secret',
        'x-force-now': '2026-03-13T09:30:00.000+09:00'
      }
    },
    {
      env: {
        CRON_SECRET: 'top-secret',
        RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST: '2026-03-11T23:59:59.999+09:00',
        RANDOM_MESSAGE_SEND_DELAY_MINUTES: '90',
        RANDOM_MESSAGE_SHUFFLE_COUNT: '1',
        PUBLIC_SITE_URL: 'https://mezame.example.com',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      muteConsoleError: true,
      fetchImpl: async function (url, options) {
        fetchCalls.push({ url: url, options: options });

        if (/message_delivery_assignments\?/.test(url) && options.method === 'GET') {
          if (fetchCalls.filter(function (entry) {
            return /message_delivery_assignments\?/.test(entry.url) && entry.options.method === 'GET';
          }).length === 1) {
            return {
              ok: true,
              status: 200,
              json: async function () {
                return [
                  {
                    id: 11,
                    campaign_key: '2026-03-13',
                    sender_name: 'Alice',
                    sender_message_count: 1,
                    recipient_name: 'Bob',
                    access_token: 'token-alice',
                    status: 'planned',
                    email_subject: null,
                    email_html: null,
                    email_text: null,
                    draft_created_at: null
                  }
                ];
              }
            };
          }

          return {
            ok: true,
            status: 200,
            json: async function () {
              return [
                {
                  id: 11,
                  campaign_key: '2026-03-13',
                  sender_name: 'Alice',
                  sender_message_count: 1,
                  recipient_name: 'Bob',
                  access_token: 'token-alice',
                  status: 'draft',
                  email_subject: '【目醒めレター】あなたへ届いたメッセージ',
                  email_html: '<p>html</p>',
                  email_text: 'text',
                  draft_created_at: '2026-03-13T00:00:00.000Z'
                }
              ];
            }
          };
        }

        if (/message_delivery_assignments\?id=eq\.11/.test(url) && options.method === 'PATCH') {
          return {
            ok: true,
            status: 204,
            json: async function () {
              return [];
            }
          };
        }

        throw new Error('Unexpected fetch call: ' + options.method + ' ' + url);
      }
    }
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.summary.draftRefreshedCount, 1);
  assert.ok(fetchCalls.some(function (entry) {
    return /message_delivery_assignments\?id=eq\.11/.test(entry.url)
      && entry.options.method === 'PATCH'
      && /"status":"draft"/.test(entry.options.body)
      && /"email_subject":"【目醒めレター】あなたへ届いたメッセージ"/.test(entry.options.body);
  }));
});

test('send-random-message-drafts は保存済み下書きを送信済みに更新する', async function () {
  var fetchCalls = [];
  var sendCount = 0;

  var result = await invokeHandler(
    dispatchHandler,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer top-secret'
      }
    },
    {
      env: {
        CRON_SECRET: 'top-secret',
        RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST: '2026-03-11T23:59:59.999+09:00',
        RANDOM_MESSAGE_SEND_DELAY_MINUTES: '90',
        RANDOM_MESSAGE_SHUFFLE_COUNT: '1',
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'hello@example.com',
        RESEND_REPLY_TO_EMAIL: 'reply@example.com',
        PUBLIC_SITE_URL: 'https://mezame.example.com',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      muteConsoleError: true,
      fetchImpl: async function (url, options) {
        fetchCalls.push({ url: url, options: options });

        if (/message_delivery_assignments\?/.test(url) && options.method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async function () {
              return [
                {
                  id: 11,
                  campaign_key: '2026-03-13',
                  recipient_email: 'bob@example.com',
                  status: 'draft',
                  email_subject: '件名A',
                  email_html: '<p>A</p>',
                  email_text: 'A'
                },
                {
                  id: 12,
                  campaign_key: '2026-03-13',
                  recipient_email: 'alice@example.com',
                  status: 'draft',
                  email_subject: '件名B',
                  email_html: '<p>B</p>',
                  email_text: 'B'
                }
              ];
            }
          };
        }

        if (/message_delivery_assignments\?id=eq\.11/.test(url) && options.method === 'PATCH') {
          if (options.body.indexOf('"status":"processing"') !== -1) {
            return {
              ok: true,
              status: 200,
              json: async function () {
                return [
                  {
                    id: 11,
                    recipient_email: 'bob@example.com',
                    email_subject: '件名A',
                    email_html: '<p>A</p>',
                    email_text: 'A'
                  }
                ];
              }
            };
          }

          return {
            ok: true,
            status: 204,
            json: async function () {
              return [];
            }
          };
        }

        if (/message_delivery_assignments\?id=eq\.12/.test(url) && options.method === 'PATCH') {
          if (options.body.indexOf('"status":"processing"') !== -1) {
            return {
              ok: true,
              status: 200,
              json: async function () {
                return [
                  {
                    id: 12,
                    recipient_email: 'alice@example.com',
                    email_subject: '件名B',
                    email_html: '<p>B</p>',
                    email_text: 'B'
                  }
                ];
              }
            };
          }

          return {
            ok: true,
            status: 204,
            json: async function () {
              return [];
            }
          };
        }

        if (url === 'https://api.resend.com/emails' && options.method === 'POST') {
          sendCount += 1;
          return {
            ok: true,
            status: 200,
            json: async function () {
              return { id: 'email_' + sendCount };
            }
          };
        }

        throw new Error('Unexpected fetch call: ' + options.method + ' ' + url);
      }
    }
  );

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.summary.assignmentCount, 2);
  assert.equal(sendCount, 2);
  assert.ok(fetchCalls.some(function (entry) {
    return entry.url === 'https://api.resend.com/emails'
      && /"subject":"件名A"/.test(entry.options.body)
      && /"reply_to":"reply@example.com"/.test(entry.options.body);
  }));
});
