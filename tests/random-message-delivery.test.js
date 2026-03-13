'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var deliveryLib = require('../api/_lib/random-message-delivery');
var handler = require('../api/send-random-messages');

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

async function invokeHandler(request, options) {
  var opts = options || {};
  var req = {
    method: request.method || 'GET',
    headers: request.headers || {},
    body: request.body
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
});

test('resolveCampaignConfig は締切の90分後を既定の送信開始日時にする', function () {
  var config = deliveryLib.resolveCampaignConfig({
    RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST: '2026-03-13T17:30:00+09:00',
    RANDOM_MESSAGE_SEND_DELAY_MINUTES: '90'
  });

  assert.equal(config.sendDate.toISOString(), '2026-03-13T10:00:00.000Z');
  assert.equal(config.sendDelayMinutes, 90);
});

test('buildEmailPayload は送信日を本文に反映する', function () {
  var payload = deliveryLib.buildEmailPayload({
    senderName: 'Alice',
    senderMessages: [{ id: 1, message: '起きて' }],
    senderMessageCount: 1,
    recipientEmail: 'bob@example.com',
    recipientName: 'Bob'
  }, {
    fromEmail: 'hello@example.com',
    replyToEmail: 'reply@example.com',
    sendDate: new Date('2026-03-13T10:00:00.000Z')
  });

  assert.equal(payload.from, 'hello@example.com');
  assert.equal(payload.reply_to, 'reply@example.com');
  assert.match(payload.text, /2026年3月13日/);
  assert.match(payload.html, /2026年3月13日/);
});

test('send-random-messages は送信日前なら 409 を返す', async function () {
  var result = await invokeHandler(
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
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'hello@example.com',
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

test('send-random-messages は未作成の割り当てを生成して送信済みに更新する', async function () {
  var fetchCalls = [];
  var sendCount = 0;

  var result = await invokeHandler(
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
        RESEND_API_KEY: 're_test',
        RESEND_FROM_EMAIL: 'hello@example.com',
        RESEND_REPLY_TO_EMAIL: 'reply@example.com',
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
                  shuffle_count: 1,
                  status: 'planned'
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
                  shuffle_count: 1,
                  status: 'planned'
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
          if (options.body.indexOf('"status":"processing"') !== -1) {
            return {
              ok: true,
              status: 200,
              json: async function () {
                return [
                  {
                    id: 11,
                    sender_name: 'Alice',
                    sender_messages: [{ id: 1, message: 'A' }],
                    sender_message_count: 1,
                    recipient_email: 'bob@example.com',
                    recipient_name: 'Bob'
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
                    sender_name: 'Bob',
                    sender_messages: [{ id: 2, message: 'B' }],
                    sender_message_count: 1,
                    recipient_email: 'alice@example.com',
                    recipient_name: 'Alice'
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
  assert.equal(result.body.summary.planCreated, true);
  assert.equal(sendCount, 2);
});
