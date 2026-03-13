'use strict';

var deliveryLib = require('./_lib/random-message-delivery');

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function createRequestError(statusCode, message, type) {
  var error = new Error(message);
  error.statusCode = statusCode;
  error.type = type || 'REQUEST_ERROR';
  return error;
}

function getSupabaseHeaders(config, extraHeaders) {
  var headers = {
    apikey: config.supabaseServiceRoleKey,
    Authorization: 'Bearer ' + config.supabaseServiceRoleKey,
    'Content-Type': 'application/json',
    'Content-Profile': config.supabaseSchema
  };

  return Object.assign(headers, extraHeaders || {});
}

async function supabaseRequest(config, path, options) {
  var opts = options || {};
  var url = config.supabaseUrl.replace(/\/$/, '') + '/rest/v1/' + path.replace(/^\//, '');
  var response = await fetch(url, {
    method: opts.method || 'GET',
    headers: getSupabaseHeaders(config, opts.headers),
    body: opts.body == null ? undefined : JSON.stringify(opts.body)
  });

  if (!response.ok) {
    var details = '';
    try {
      details = await response.text();
    } catch (_) {
      details = '';
    }

    var error = new Error('Supabase リクエストに失敗しました。');
    error.statusCode = response.status >= 500 ? 502 : 500;
    error.type = 'SUPABASE_ERROR';
    error.upstreamStatus = response.status;
    error.details = details;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function readToken(req) {
  var query = req && req.query ? req.query : {};
  var token = deliveryLib.normalizeString(query.token);

  if (!token) {
    throw createRequestError(400, 'token が必要です。', 'VALIDATION_ERROR');
  }

  return token;
}

async function fetchAssignmentByToken(config, token) {
  var query = [
    'select=id,campaign_key,sender_name,sender_messages,sender_message_count,recipient_name,opened_at,view_count',
    'access_token=eq.' + encodeURIComponent(token),
    'limit=1'
  ].join('&');

  var rows = await supabaseRequest(config, config.assignmentsTable + '?' + query);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function markAssignmentOpened(config, assignment) {
  var now = new Date().toISOString();
  var query = 'id=eq.' + encodeURIComponent(String(assignment.id));

  await supabaseRequest(config, config.assignmentsTable + '?' + query, {
    method: 'PATCH',
    headers: {
      Prefer: 'return=minimal'
    },
    body: {
      opened_at: assignment.opened_at || now,
      view_count: Number(assignment.view_count || 0) + 1,
      updated_at: now
    }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    writeJson(res, 405, {
      ok: false,
      message: 'GET メソッドのみ利用できます。'
    });
    return;
  }

  try {
    var token = readToken(req);
    var config = deliveryLib.resolveCampaignConfig(process.env);
    deliveryLib.assertRequiredConfig(config);

    var assignment = await fetchAssignmentByToken(config, token);
    if (!assignment) {
      writeJson(res, 404, {
        ok: false,
        message: 'メッセージが見つかりませんでした。'
      });
      return;
    }

    await markAssignmentOpened(config, assignment);

    writeJson(res, 200, {
      ok: true,
      campaignKey: assignment.campaign_key,
      recipientName: assignment.recipient_name,
      senderName: assignment.sender_name,
      senderMessageCount: assignment.sender_message_count,
      openedAt: assignment.opened_at,
      messages: Array.isArray(assignment.sender_messages) ? assignment.sender_messages : []
    });
  } catch (err) {
    writeJson(res, err && err.statusCode ? err.statusCode : 500, {
      ok: false,
      message: err && err.message ? err.message : 'サーバーでエラーが発生しました。'
    });
  }
};
