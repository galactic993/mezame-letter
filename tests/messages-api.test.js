'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var handler = require('../api/messages');

var TRACKED_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_MESSAGES_TABLE',
  'SUPABASE_SCHEMA',
  'ALLOWED_ORIGINS'
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
  for (var i = 0; i < TRACKED_ENV_KEYS.length; i++) {
    var key = TRACKED_ENV_KEYS[i];
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function setTrackedEnv(overrides) {
  var snapshot = {};

  for (var i = 0; i < TRACKED_ENV_KEYS.length; i++) {
    var key = TRACKED_ENV_KEYS[i];
    snapshot[key] = process.env[key];
  }

  var values = overrides || {};
  for (var j = 0; j < TRACKED_ENV_KEYS.length; j++) {
    var envKey = TRACKED_ENV_KEYS[j];
    if (Object.prototype.hasOwnProperty.call(values, envKey)) {
      process.env[envKey] = values[envKey];
    } else {
      delete process.env[envKey];
    }
  }

  return snapshot;
}

async function invokeHandler(request, options) {
  var opts = options || {};
  var req = {
    method: request.method || 'POST',
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

  var parsedBody;
  try {
    parsedBody = JSON.parse(res.getBody());
  } catch (_) {
    parsedBody = null;
  }

  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: parsedBody
  };
}

test('GETは405を返す', async function () {
  var result = await invokeHandler({ method: 'GET' });

  assert.equal(result.statusCode, 405);
  assert.equal(result.body.ok, false);
  assert.match(result.body.message, /POST/);
});

test('バリデーションエラー時は400を返す', async function () {
  var fetchCalls = 0;
  var result = await invokeHandler(
    {
      method: 'POST',
      body: {
        name: 'Alice',
        email: 'not-an-email',
        message: 'hello'
      }
    },
    {
      env: {
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      fetchImpl: async function () {
        fetchCalls += 1;
        throw new Error('fetch should not be called for validation errors');
      }
    }
  );

  assert.equal(result.statusCode, 400);
  assert.equal(result.body.ok, false);
  assert.match(result.body.message, /メールアドレス/);
  assert.equal(fetchCalls, 0);
});

test('正常系ではSupabaseへ保存し201を返す', async function () {
  var capturedRequest = null;
  var result = await invokeHandler(
    {
      method: 'POST',
      headers: {
        'user-agent': 'test-agent/1.0'
      },
      body: {
        name: ' Alice ',
        email: ' ALICE@EXAMPLE.COM ',
        message: ' hello world '
      }
    },
    {
      env: {
        SUPABASE_URL: 'https://project.supabase.co/',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
        SUPABASE_MESSAGES_TABLE: 'form_submissions',
        SUPABASE_SCHEMA: 'public'
      },
      fetchImpl: async function (url, options) {
        capturedRequest = {
          url: url,
          options: options
        };

        return {
          ok: true,
          json: async function () {
            return [{ id: 42 }];
          }
        };
      }
    }
  );

  assert.equal(result.statusCode, 201);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.id, 42);
  assert.ok(capturedRequest);
  assert.equal(capturedRequest.url, 'https://project.supabase.co/rest/v1/form_submissions');
  assert.equal(capturedRequest.options.method, 'POST');

  var payload = JSON.parse(capturedRequest.options.body);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].name, 'Alice');
  assert.equal(payload[0].email, 'alice@example.com');
  assert.equal(payload[0].message, 'hello world');
  assert.equal(payload[0].source, 'mezame-letter');
  assert.equal(payload[0].user_agent, 'test-agent/1.0');
  assert.equal(capturedRequest.options.headers.Authorization, 'Bearer service-role-key');
});

test('Supabase一時障害(5xx)は502を返す', async function () {
  var result = await invokeHandler(
    {
      method: 'POST',
      body: {
        name: 'Alice',
        email: 'alice@example.com',
        message: 'hello'
      }
    },
    {
      env: {
        SUPABASE_URL: 'https://project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key'
      },
      muteConsoleError: true,
      fetchImpl: async function () {
        return {
          ok: false,
          status: 503,
          text: async function () {
            return 'upstream unavailable';
          }
        };
      }
    }
  );

  assert.equal(result.statusCode, 502);
  assert.equal(result.body.ok, false);
  assert.match(result.body.message, /サーバー/);
});
