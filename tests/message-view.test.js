'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var handler = require('../api/message-view');

var TRACKED_ENV_KEYS = [
  'CRON_SECRET',
  'PUBLIC_SITE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SCHEMA',
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
  TRACKED_ENV_KEYS.forEach(function (key) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
      return;
    }

    process.env[key] = snapshot[key];
  });
}

function setTrackedEnv(overrides) {
  var snapshot = {};
  var values = overrides || {};

  TRACKED_ENV_KEYS.forEach(function (key) {
    snapshot[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      process.env[key] = values[key];
      return;
    }

    delete process.env[key];
  });

  return snapshot;
}

async function invokeHandler(request, options) {
  var opts = options || {};
  var req = {
    method: request.method || 'GET',
    headers: request.headers || {},
    query: request.query || {}
  };
  var res = createResponseRecorder();
  var envSnapshot = setTrackedEnv(opts.env);
  var originalFetch = global.fetch;

  if (opts.fetchImpl) {
    global.fetch = opts.fetchImpl;
  }

  try {
    await handler(req, res);
  } finally {
    global.fetch = originalFetch;
    restoreTrackedEnv(envSnapshot);
  }

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: JSON.parse(res.getBody())
  };
}

test('message-view は token がないと 400 を返す', async function () {
  var result = await invokeHandler(
    {
      method: 'GET',
      query: {}
    },
    {
      env: {
        CRON_SECRET: 'top-secret',
        PUBLIC_SITE_URL: 'https://mezame.example.com',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      }
    }
  );

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.ok, false);
});

test('message-view は token からメッセージを返して開封時刻を更新する', async function () {
  var fetchCalls = [];

  var result = await invokeHandler(
    {
      method: 'GET',
      query: {
        token: 'token-alice'
      }
    },
    {
      env: {
        CRON_SECRET: 'top-secret',
        PUBLIC_SITE_URL: 'https://mezame.example.com',
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      fetchImpl: async function (url, options) {
        fetchCalls.push({ url: url, options: options });

        if (/access_token=eq\.token-alice/.test(url) && options.method === 'GET') {
          return {
            ok: true,
            status: 200,
            json: async function () {
              return [
                {
                  id: 11,
                  campaign_key: '2026-03-13',
                  sender_messages: [{ id: 1, message: '起きて、光を見て。' }],
                  sender_message_count: 1,
                  recipient_name: 'Bob',
                  opened_at: null,
                  view_count: 0
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
  assert.equal(result.body.ok, true);
  assert.equal(result.body.recipientName, 'Bob');
  assert.equal(result.body.messages.length, 1);
  assert.match(fetchCalls[1].options.body, /"view_count":1/);
});
