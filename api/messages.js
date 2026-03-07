'use strict';

var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var DEFAULT_TABLE_NAME = 'form_submissions';

function readJsonBody(req) {
  if (!req || req.body == null) {
    return null;
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return null;
    }
  }

  if (typeof req.body === 'object') {
    return req.body;
  }

  return null;
}

function validationError(message) {
  var err = new Error(message);
  err.statusCode = 400;
  err.type = 'VALIDATION_ERROR';
  return err;
}

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function validatePayload(payload) {
  if (!payload) {
    throw validationError('送信データが不正です。');
  }

  var name = normalizeString(payload.name);
  var email = normalizeString(payload.email).toLowerCase();
  var message = normalizeString(payload.message);

  if (!name) {
    throw validationError('お名前を入力してください。');
  }
  if (!email) {
    throw validationError('メールアドレスを入力してください。');
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw validationError('正しいメールアドレスを入力してください。');
  }
  if (!message) {
    throw validationError('メッセージを入力してください。');
  }

  if (name.length > 80) {
    throw validationError('お名前は80文字以内で入力してください。');
  }
  if (email.length > 254) {
    throw validationError('メールアドレスが長すぎます。');
  }
  if (message.length > 5000) {
    throw validationError('メッセージは5000文字以内で入力してください。');
  }

  return {
    name: name,
    email: email,
    message: message
  };
}

function isAllowedOrigin(req) {
  var allowlist = process.env.ALLOWED_ORIGINS;
  if (!allowlist) {
    return true;
  }

  var origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  var allowedOrigins = allowlist.split(',').map(function (item) {
    return item.trim();
  }).filter(Boolean);

  return allowedOrigins.indexOf(origin) !== -1;
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function insertToSupabase(record) {
  var supabaseUrl = process.env.SUPABASE_URL;
  var serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var tableName = process.env.SUPABASE_MESSAGES_TABLE || DEFAULT_TABLE_NAME;
  var schemaName = process.env.SUPABASE_SCHEMA || 'public';

  if (!supabaseUrl || !serviceRoleKey) {
    var configError = new Error('Supabaseの環境変数が不足しています。');
    configError.statusCode = 500;
    configError.type = 'CONFIG_ERROR';
    throw configError;
  }

  var endpoint = supabaseUrl.replace(/\/$/, '') + '/rest/v1/' + encodeURIComponent(tableName);
  var headers = {
    apikey: serviceRoleKey,
    Authorization: 'Bearer ' + serviceRoleKey,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    'Content-Profile': schemaName
  };

  var response = await fetch(endpoint, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify([record])
  });

  if (!response.ok) {
    var errorText;
    try {
      errorText = await response.text();
    } catch (_) {
      errorText = '';
    }

    var upstreamError = new Error('Supabaseへの保存に失敗しました。');
    upstreamError.statusCode = response.status >= 500 ? 502 : 500;
    upstreamError.type = 'SUPABASE_ERROR';
    upstreamError.upstreamStatus = response.status;
    upstreamError.details = errorText;
    throw upstreamError;
  }

  var rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    writeJson(res, 405, {
      ok: false,
      message: 'POSTメソッドのみ利用できます。'
    });
    return;
  }

  if (!isAllowedOrigin(req)) {
    writeJson(res, 403, {
      ok: false,
      message: 'この送信元からのアクセスは許可されていません。'
    });
    return;
  }

  try {
    var payload = readJsonBody(req);
    var validated = validatePayload(payload);

    var inserted = await insertToSupabase({
      name: validated.name,
      email: validated.email,
      message: validated.message,
      source: 'mezame-letter',
      submitted_at: new Date().toISOString(),
      user_agent: normalizeString(req.headers['user-agent']).slice(0, 512)
    });

    writeJson(res, 201, {
      ok: true,
      id: inserted && inserted.id ? inserted.id : null,
      message: '保存に成功しました。'
    });
  } catch (err) {
    if (err && err.type === 'VALIDATION_ERROR') {
      writeJson(res, err.statusCode || 400, {
        ok: false,
        message: err.message
      });
      return;
    }

    console.error('[api/messages] submit failed', {
      type: err && err.type,
      statusCode: err && err.statusCode,
      upstreamStatus: err && err.upstreamStatus,
      message: err && err.message,
      details: err && err.details
    });

    writeJson(res, err && err.statusCode ? err.statusCode : 500, {
      ok: false,
      message: 'サーバーでエラーが発生しました。時間をおいて再度お試しください。'
    });
  }
};
