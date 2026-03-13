'use strict';

var crypto = require('node:crypto');
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

async function fetchEligibleSubmissions(config) {
  var query = [
    'select=id,name,email,message,submitted_at',
    'submitted_at=lte.' + encodeURIComponent(config.acceptanceDeadline.toISOString()),
    'order=submitted_at.asc,id.asc'
  ].join('&');

  return supabaseRequest(config, config.submissionsTable + '?' + query);
}

async function fetchAssignments(config) {
  var query = [
    'select=id,campaign_key,sender_email,sender_name,sender_messages,sender_message_count,recipient_email,recipient_name,shuffle_count,access_token,status,email_subject,email_html,email_text,draft_created_at,resend_email_id,sent_at,last_error',
    'campaign_key=eq.' + encodeURIComponent(config.campaignKey),
    'order=id.asc'
  ].join('&');

  return supabaseRequest(config, config.assignmentsTable + '?' + query);
}

function buildDraftFields(config, assignment) {
  var content = deliveryLib.buildEmailContent({
    senderName: assignment.senderName || assignment.sender_name,
    senderMessages: assignment.senderMessages || assignment.sender_messages,
    senderMessageCount: assignment.senderMessageCount || assignment.sender_message_count,
    recipientName: assignment.recipientName || assignment.recipient_name,
    accessToken: assignment.accessToken || assignment.access_token
  }, {
    sendDate: config.sendDate,
    baseUrl: config.publicSiteUrl
  });

  return {
    email_subject: content.subject,
    email_html: content.html,
    email_text: content.text
  };
}

async function insertAssignments(config, assignments) {
  var now = new Date().toISOString();
  var rows = assignments.map(function (assignment) {
    var draft = buildDraftFields(config, assignment);
    return {
      campaign_key: config.campaignKey,
      sender_email: assignment.senderEmail,
      sender_name: assignment.senderName,
      sender_messages: assignment.senderMessages,
      sender_message_count: assignment.senderMessageCount,
      recipient_email: assignment.recipientEmail,
      recipient_name: assignment.recipientName,
      shuffle_count: assignment.shuffleCount,
      access_token: assignment.accessToken,
      status: 'draft',
      email_subject: draft.email_subject,
      email_html: draft.email_html,
      email_text: draft.email_text,
      draft_created_at: now
    };
  });

  return supabaseRequest(config, config.assignmentsTable, {
    method: 'POST',
    headers: {
      Prefer: 'return=representation'
    },
    body: rows
  });
}

function needsDraftRefresh(assignment) {
  if (!assignment || assignment.status === 'sent' || assignment.status === 'processing') {
    return false;
  }

  if (assignment.status === 'planned') {
    return true;
  }

  return !assignment.email_subject || !assignment.email_html || !assignment.email_text;
}

async function updateAssignmentDraft(config, assignment) {
  var query = 'id=eq.' + encodeURIComponent(String(assignment.id));
  var draft = buildDraftFields(config, assignment);
  var nextStatus = assignment.status === 'planned' ? 'draft' : assignment.status;
  var body = {
    email_subject: draft.email_subject,
    email_html: draft.email_html,
    email_text: draft.email_text,
    draft_created_at: assignment.draft_created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  if (nextStatus) {
    body.status = nextStatus;
  }

  await supabaseRequest(config, config.assignmentsTable + '?' + query, {
    method: 'PATCH',
    headers: {
      Prefer: 'return=minimal'
    },
    body: body
  });
}

function resolveNow(req) {
  var headerNow = req && req.headers ? req.headers['x-force-now'] : '';
  if (headerNow) {
    return new Date(headerNow);
  }
  return new Date();
}

function authorizeRequest(req, config) {
  var authHeader = req && req.headers ? req.headers.authorization : '';
  var expected = 'Bearer ' + config.cronSecret;

  if (authHeader !== expected) {
    throw createRequestError(401, '認証に失敗しました。', 'AUTH_ERROR');
  }
}

function summarize(assignments, planCreated, draftRefreshed) {
  var summary = {
    campaignKey: assignments[0] ? assignments[0].campaign_key : null,
    assignmentCount: assignments.length,
    draftCount: 0,
    processingCount: 0,
    sentCount: 0,
    failedCount: 0,
    planCreated: Boolean(planCreated),
    draftRefreshedCount: draftRefreshed
  };
  var index;

  for (index = 0; index < assignments.length; index += 1) {
    if (assignments[index].status === 'draft' || assignments[index].status === 'planned') {
      summary.draftCount += 1;
    }
    if (assignments[index].status === 'processing') {
      summary.processingCount += 1;
    }
    if (assignments[index].status === 'sent') {
      summary.sentCount += 1;
    }
    if (assignments[index].status === 'failed') {
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
    deliveryLib.assertDraftConfig(config);
    authorizeRequest(req, config);

    var now = resolveNow(req);
    if (String(now) === 'Invalid Date') {
      throw createRequestError(400, '現在時刻ヘッダーが不正です。', 'VALIDATION_ERROR');
    }

    if (now.getTime() < config.acceptanceDeadline.getTime()) {
      writeJson(res, 409, {
        ok: false,
        message: '投稿締切前のため下書きを作成できません。',
        acceptanceDeadline: config.acceptanceDeadline.toISOString()
      });
      return;
    }

    var assignments = await fetchAssignments(config);
    var planCreated = false;

    if (!Array.isArray(assignments) || assignments.length === 0) {
      var submissions = await fetchEligibleSubmissions(config);
      var participants = deliveryLib.buildParticipantGroups(submissions || []);

      if (participants.length < 2) {
        writeJson(res, 409, {
          ok: false,
          message: '一意なメールアドレスが2件未満のため下書きを作成できません。',
          participantCount: participants.length
        });
        return;
      }

      var plannedAssignments = deliveryLib.createAssignments(participants, {
        shuffleCount: config.shuffleCount,
        randomIntFn: function (maxExclusive) {
          return crypto.randomInt(maxExclusive);
        }
      });

      try {
        await insertAssignments(config, plannedAssignments);
        planCreated = true;
      } catch (error) {
        if (error.type !== 'SUPABASE_ERROR' || error.upstreamStatus !== 409) {
          throw error;
        }
      }

      assignments = await fetchAssignments(config);
    }

    var draftRefreshedCount = 0;
    var index;

    for (index = 0; index < assignments.length; index += 1) {
      if (!needsDraftRefresh(assignments[index])) {
        continue;
      }

      await updateAssignmentDraft(config, assignments[index]);
      draftRefreshedCount += 1;
    }

    if (draftRefreshedCount > 0) {
      assignments = await fetchAssignments(config);
    }

    writeJson(res, 200, {
      ok: true,
      message: 'ランダム送信の下書きを準備しました。',
      summary: summarize(assignments, planCreated, draftRefreshedCount)
    });
  } catch (err) {
    console.error('[api/send-random-messages] failed', {
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
