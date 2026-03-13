'use strict';

var deliveryLib = require('./_lib/random-message-delivery');

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
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

async function fetchAssignments(config) {
  var query = [
    'select=id,campaign_key,sender_name,sender_messages,sender_message_count,recipient_email,recipient_name,access_token,status,email_subject,email_html,email_text,resend_email_id,sent_at,last_error',
    'campaign_key=eq.' + encodeURIComponent(config.campaignKey),
    'order=id.asc'
  ].join('&');

  return supabaseRequest(config, config.assignmentsTable + '?' + query);
}

async function claimAssignment(config, assignmentId) {
  var query = [
    'id=eq.' + encodeURIComponent(String(assignmentId)),
    'status=in.(draft,planned,failed)'
  ].join('&');

  var rows = await supabaseRequest(config, config.assignmentsTable + '?' + query, {
    method: 'PATCH',
    headers: {
      Prefer: 'return=representation'
    },
    body: {
      status: 'processing',
      last_error: null,
      delivery_started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  });

  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function markAssignmentSent(config, assignmentId, resendEmailId) {
  var query = 'id=eq.' + encodeURIComponent(String(assignmentId));
  var body = {
    status: 'sent',
    resend_email_id: resendEmailId || null,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null
  };

  await supabaseRequest(config, config.assignmentsTable + '?' + query, {
    method: 'PATCH',
    headers: {
      Prefer: 'return=minimal'
    },
    body: body
  });
}

async function markAssignmentFailed(config, assignmentId, errorMessage) {
  var query = 'id=eq.' + encodeURIComponent(String(assignmentId));
  await supabaseRequest(config, config.assignmentsTable + '?' + query, {
    method: 'PATCH',
    headers: {
      Prefer: 'return=minimal'
    },
    body: {
      status: 'failed',
      last_error: String(errorMessage || '').slice(0, 2000),
      updated_at: new Date().toISOString()
    }
  });
}

function buildStoredEmailPayload(config, assignment) {
  var subject = deliveryLib.normalizeString(assignment.email_subject);
  var html = deliveryLib.normalizeString(assignment.email_html);
  var text = deliveryLib.normalizeString(assignment.email_text);

  if (!subject || !html || !text) {
    throw new Error('メール下書きが未作成のため送信できません。');
  }

  var payload = {
    from: config.resendFromEmail,
    to: [assignment.recipient_email],
    subject: subject,
    html: html,
    text: text
  };

  if (config.resendReplyToEmail) {
    payload.reply_to = config.resendReplyToEmail;
  }

  return payload;
}

async function sendViaResend(config, assignment) {
  var response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.resendApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(buildStoredEmailPayload(config, assignment))
  });

  if (!response.ok) {
    var details = '';
    try {
      details = await response.text();
    } catch (_) {
      details = '';
    }

    var error = new Error('Resend 送信に失敗しました。' + (details ? ' ' + details : ''));
    error.statusCode = response.status >= 500 ? 502 : 500;
    error.type = 'RESEND_ERROR';
    error.upstreamStatus = response.status;
    throw error;
  }

  return response.json();
}

function authorizeRequest(req, config) {
  var authHeader = req && req.headers ? req.headers.authorization : '';
  var expected = 'Bearer ' + config.cronSecret;

  if (authHeader !== expected) {
    throw createRequestError(401, '認証に失敗しました。', 'AUTH_ERROR');
  }
}

function summarize(assignments, sendResults) {
  var summary = {
    campaignKey: assignments[0] ? assignments[0].campaign_key : null,
    assignmentCount: assignments.length,
    sentCount: 0,
    failedCount: 0,
    skippedCount: 0
  };
  var index;

  for (index = 0; index < assignments.length; index += 1) {
    if (assignments[index].status === 'sent') {
      summary.sentCount += 1;
      continue;
    }

    if (assignments[index].status === 'failed') {
      summary.failedCount += 1;
      continue;
    }

    if (assignments[index].status === 'processing') {
      summary.skippedCount += 1;
    }
  }

  for (index = 0; index < sendResults.length; index += 1) {
    if (sendResults[index].status === 'sent') {
      summary.sentCount += 1;
      continue;
    }

    if (sendResults[index].status === 'failed') {
      summary.failedCount += 1;
    }
  }

  return summary;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    writeJson(res, 405, {
      ok: false,
      message: 'GET または POST メソッドのみ利用できます。'
    });
    return;
  }

  try {
    var config = deliveryLib.resolveCampaignConfig(process.env);
    deliveryLib.assertDispatchConfig(config);
    authorizeRequest(req, config);

    var assignments = await fetchAssignments(config);
    var sendResults = [];
    var index;

    for (index = 0; index < assignments.length; index += 1) {
      if (assignments[index].status === 'sent') {
        continue;
      }

      var claimed = await claimAssignment(config, assignments[index].id);
      if (!claimed) {
        continue;
      }

      try {
        var resendResponse = await sendViaResend(config, claimed);
        await markAssignmentSent(config, claimed.id, resendResponse && resendResponse.id);
        sendResults.push({
          id: claimed.id,
          status: 'sent'
        });
      } catch (sendError) {
        await markAssignmentFailed(config, claimed.id, sendError.message);
        sendResults.push({
          id: claimed.id,
          status: 'failed',
          message: sendError.message
        });
      }
    }

    writeJson(res, 200, {
      ok: true,
      message: '下書きメールの送信処理を実行しました。',
      summary: summarize(assignments, sendResults),
      results: sendResults
    });
  } catch (err) {
    console.error('[api/send-random-message-drafts] failed', {
      type: err && err.type,
      statusCode: err && err.statusCode,
      upstreamStatus: err && err.upstreamStatus,
      message: err && err.message,
      details: err && err.details
    });

    writeJson(res, err && err.statusCode ? err.statusCode : 500, {
      ok: false,
      message: err && err.message ? err.message : 'サーバーでエラーが発生しました。'
    });
  }
};
