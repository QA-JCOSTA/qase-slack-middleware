/**
 * server.js
 * Qase Webhooks -> Slack
 *
 * Vercel-safe version:
 * - Waits for processing before returning 200 on /qase/webhook
 * - Exports Express app for serverless deployment
 * - Still supports local run with app.listen(...)
 */

require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const VERSION =
  'QASE->SLACK v21 (VERCEL SAFE + SINGLE MESSAGE + SUMMARY + SNAPSHOT TITLE + AGGREGATE + NO REASON)';

const REQUIRED_ENVS = ['SLACK_WEBHOOK_URL', 'QASE_API_TOKEN', 'QASE_PROJECT_CODE'];

function missingEnvs() {
  return REQUIRED_ENVS.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
}

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const QASE_API_TOKEN = process.env.QASE_API_TOKEN;
const QASE_PROJECT_CODE = process.env.QASE_PROJECT_CODE;
const PORT = Number(process.env.PORT || 3000);

const QASE_BASE = 'https://api.qase.io/v1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
const log = (...args) => console.log(`[${ts()}]`, ...args);

const DISCLAIMER =
  'Important: Not all failed tests indicate a software defect. Some failures can be caused by temporary environment issues (e.g., slow response times, network instability, third-party outages, or test runner constraints) and may require a rerun to confirm.';

function qaseHeaders() {
  return {
    'Content-Type': 'application/json',
    Token: QASE_API_TOKEN,
  };
}

// Denmark date (DD/MM/YYYY) + English "Week X"
function formatRunDateDenmarkWithWeek() {
  const now = new Date();

  const partsDate = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(now);

  const dd = partsDate.find((p) => p.type === 'day')?.value;
  const mm = partsDate.find((p) => p.type === 'month')?.value;
  const yyyy = partsDate.find((p) => p.type === 'year')?.value;
  const date = `${dd}/${mm}/${yyyy}`;

  const partsYMD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const y = Number(partsYMD.find((p) => p.type === 'year')?.value);
  const m = Number(partsYMD.find((p) => p.type === 'month')?.value);
  const d = Number(partsYMD.find((p) => p.type === 'day')?.value);

  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);

  return `${date} - Week ${week}`;
}

async function qaseGet(path) {
  const url = `${QASE_BASE}${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: qaseHeaders(),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const msg = json?.errorMessage || json?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    err.url = url;
    throw err;
  }

  return json;
}

/* ---------------- STATUS ---------------- */

const STATUS = {
  PASSED: 'passed',
  FAILED: 'failed',
  FLAKY: 'flaky',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
  INVALID: 'invalid',
};

function normalizeStatus(raw) {
  if (raw === null || raw === undefined) return STATUS.BLOCKED;

  if (typeof raw === 'object') {
    const candidate =
      raw.status ??
      raw.name ??
      raw.title ??
      raw.value ??
      raw.result ??
      raw.state ??
      raw.code ??
      raw.id ??
      raw.status_id ??
      raw.statusId;

    if (candidate !== undefined && candidate !== null) {
      return normalizeStatus(candidate);
    }

    return STATUS.BLOCKED;
  }

  if (typeof raw === 'number') {
    if (raw === 1) return STATUS.PASSED;
    if (raw === 2) return STATUS.FAILED;
    if (raw === 3) return STATUS.BLOCKED;
    if (raw === 4) return STATUS.SKIPPED;
    if (raw === 5) return STATUS.INVALID;
    if (raw === 6) return STATUS.FLAKY;
    return STATUS.BLOCKED;
  }

  const s = String(raw).toLowerCase().trim();

  if (s === 'passed' || s === 'pass') return STATUS.PASSED;
  if (s === 'failed' || s === 'fail') return STATUS.FAILED;
  if (s === 'flaky' || s === 'unstable') return STATUS.FLAKY;
  if (s === 'skipped' || s === 'skiped' || s === 'skip' || s === 'untested') return STATUS.SKIPPED;
  if (s === 'invalid') return STATUS.INVALID;

  if (
    s === 'blocked' ||
    s.includes('block') ||
    s.includes('cancel') ||
    s.includes('abort') ||
    s.includes('queue') ||
    s.includes('progress') ||
    s === 'running'
  ) {
    return STATUS.BLOCKED;
  }

  return STATUS.BLOCKED;
}

function statusEmoji(status) {
  if (status === STATUS.PASSED) return ':white_check_mark:';
  if (status === STATUS.FAILED) return ':x:';
  if (status === STATUS.FLAKY) return ':warning:';
  if (status === STATUS.SKIPPED) return ':arrow_right:';
  if (status === STATUS.INVALID) return ':question:';
  return ':no_entry_sign:';
}

function statusRank(s) {
  if (s === STATUS.FAILED) return 0;
  if (s === STATUS.INVALID) return 1;
  if (s === STATUS.BLOCKED) return 2;
  if (s === STATUS.SKIPPED) return 3;
  if (s === STATUS.FLAKY) return 4;
  return 5;
}

/* ---------------- TITLE helpers ---------------- */

function extractCaseId(r) {
  const v =
    r?.case_id ??
    r?.caseId ??
    r?.case?.id ??
    r?.case?.case_id ??
    r?.testcase?.id ??
    r?.testCaseId ??
    r?.relations?.case_id ??
    null;

  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function resultSuffix(r) {
  const bits = [];

  const param = r?.param || r?.params || r?.parameters;
  if (param && typeof param === 'string') bits.push(param);

  if (param && typeof param === 'object') {
    const s = JSON.stringify(param);
    if (s && s !== '{}' && s !== 'null') bits.push(s);
  }

  const browser = r?.browser || r?.metadata?.browser;
  if (browser) bits.push(browser);

  const env = r?.environment || r?.metadata?.env;
  if (env) bits.push(env);

  const suffix = bits.filter(Boolean).join(' | ').trim();
  return suffix ? ` — ${suffix}` : '';
}

function isBadTitle(t) {
  const s = String(t || '').trim();
  if (!s) return true;

  const low = s.toLowerCase();
  return (
    low.startsWith('error:') ||
    low.includes('expect(') ||
    low.includes('tohavescreenshot') ||
    low.includes("snapshot doesn't exist") ||
    low.includes('compounderror') ||
    low.includes('received:') ||
    low.includes('expected:') ||
    low.includes('stack trace') ||
    low.includes('end of error message')
  );
}

function cleanupSnapshotDerivedTitle(s) {
  let t = String(s || '').trim();
  t = t.replace(/^.*?(?:-snapshots|__snapshots__)[/\\]/i, '');
  t = t.replace(/\.(png|jpg|jpeg|webp)$/i, '');
  t = t.replace(/-(chromium|firefox|webkit)(-darwin|-linux|-win32)?$/i, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t || null;
}

function snapshotIdToUrl(snapshotId) {
  const s = String(snapshotId || '').trim();
  if (!s) return null;
  if ((s.match(/_/g) || []).length < 3) return null;

  const parts = s.split('_');
  if (parts.length < 4) return null;

  const domainPart = parts[0];
  const lang = parts[1];
  const region = parts[2];
  const pathParts = parts.slice(3);

  if (!/^[a-z]{2}$/i.test(lang)) return null;
  if (!/^[a-z]{2,5}(-[a-z]{2,5})?$/i.test(region)) return null;
  if (!/^[a-z0-9-]+$/i.test(domainPart)) return null;

  const domain = domainPart.replace(/-/g, '.');
  const path = pathParts.join('_').replace(/_/g, '/');
  if (!path) return null;

  return `https://${domain}/${lang}/${region}/${path}`;
}

function formatVisualTitleFromUrl(url) {
  if (!url) return null;
  return `Visual Regression Test - ${url} renders correctly (entire scrollable page)`;
}

function titleFromErrorText(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.replace(/\r/g, '\n');

  const vr = t.match(/(Visual Regression Test\s*-\s*[^\n]+)/i);
  if (vr && vr[1]) {
    const out = vr[1].trim().slice(0, 260);
    if (out && !isBadTitle(out)) return out;
  }

  const sn = t.match(/Snapshot name:\s*([^\n]+)/i) || t.match(/Snapshot:\s*([^\n]+)/i);
  if (sn && sn[1]) {
    const cleaned = cleanupSnapshotDerivedTitle(sn[1]);
    if (cleaned && !isBadTitle(cleaned)) {
      const url = snapshotIdToUrl(cleaned);
      if (url) return formatVisualTitleFromUrl(url);
      return cleaned.slice(0, 260);
    }
  }

  const pathMatch = t.match(/(?:__snapshots__|[-_]snapshots)[/\\]([^\n]+?\.(png|jpg|jpeg|webp))/i);
  if (pathMatch && pathMatch[1]) {
    const cleaned = cleanupSnapshotDerivedTitle(pathMatch[1]);
    if (cleaned && !isBadTitle(cleaned)) {
      const url = snapshotIdToUrl(cleaned);
      if (url) return formatVisualTitleFromUrl(url);
      return cleaned.slice(0, 260);
    }
  }

  return null;
}

function bestTitleFromResult(r) {
  const candidates = [
    r?.case?.title,
    r?.case_title,
    r?.testcase_title,
    r?.test_title,
    r?.test?.title,
    r?.test?.name,
    r?.title,
    r?.name,
    r?.automation?.title,
  ].filter((x) => typeof x === 'string' && x.trim());

  if (candidates.length) {
    const c = candidates[0].trim();
    const url = snapshotIdToUrl(c);
    if (url) return formatVisualTitleFromUrl(url);
    return c;
  }

  const fromStack = titleFromErrorText(r?.stacktrace);
  if (fromStack) return fromStack;

  const fromComment = titleFromErrorText(r?.comment);
  if (fromComment) return fromComment;

  if (r?.id) return `Test result #${r.id}`;
  if (r?.hash) return `Test ${String(r.hash).slice(0, 10)}`;
  return 'Unknown test';
}

/* ---------------- Failure inference ---------------- */

function inferFailedFromResult(r) {
  const comment = typeof r?.comment === 'string' ? r.comment : '';
  const stack = typeof r?.stacktrace === 'string' ? r.stacktrace : '';

  const hasErrorWord =
    /error|exception|timeout|failed|failure|compounderror|tohavescreenshot|snapshot/i.test(comment) ||
    /error|exception|timeout|failed|failure|compounderror|tohavescreenshot|snapshot/i.test(stack);

  const hasAssertion =
    /expect\(|expected:\s*\d+|received:\s*\d+|assert/i.test(comment) ||
    /expect\(|expected:\s*\d+|received:\s*\d+|assert/i.test(stack);

  const hasAttachments = Array.isArray(r?.attachments) && r.attachments.length > 0;

  return Boolean(hasErrorWord || hasAssertion || hasAttachments);
}

function inferFlakyFromResult(r) {
  if (!r || typeof r !== 'object') return false;

  if (r.is_flaky === true || r.flaky === true) return true;

  const retryCount =
    Number(r.retries) ||
    Number(r.retry) ||
    Number(r.retry_count) ||
    Number(r.retest) ||
    Number(r.retest_count) ||
    0;

  const attempts =
    (Array.isArray(r.retries) && r.retries) ||
    (Array.isArray(r.retry_results) && r.retry_results) ||
    (Array.isArray(r.attempts) && r.attempts) ||
    (Array.isArray(r.results) && r.results) ||
    [];

  if (attempts.length) {
    const statuses = attempts
      .map((a) => normalizeStatus(a?.status ?? a?.status_id ?? a?.statusId ?? a?.result ?? a?.state))
      .filter(Boolean);

    const hasFail = statuses.includes(STATUS.FAILED) || statuses.includes(STATUS.INVALID);
    const hasPass = statuses.includes(STATUS.PASSED);
    if (hasFail && hasPass) return true;
  }

  if (retryCount > 0) return true;

  const comment = typeof r.comment === 'string' ? r.comment : '';
  const stack = typeof r.stacktrace === 'string' ? r.stacktrace : '';
  if (/retry|re-?run|rerun|flaky/i.test(comment) || /retry|re-?run|rerun|flaky/i.test(stack)) {
    return true;
  }

  return false;
}

/* ---------------- Slack ---------------- */

async function sendToSlack(payload) {
  log('[SLACK] Sending message...');
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const txt = await res.text().catch(() => '');
  log(`[SLACK] HTTP ${res.status} ok=${res.ok} body=${(txt || '').slice(0, 200)}`);

  if (!res.ok) {
    throw new Error(`Slack webhook failed: HTTP ${res.status}`);
  }
}

/* ---------------- Qase ---------------- */

async function fetchRunMeta(runId) {
  const path = `/run/${encodeURIComponent(QASE_PROJECT_CODE)}/${encodeURIComponent(runId)}?include=cases`;
  const json = await qaseGet(path);
  return json?.result || null;
}

async function fetchAllResultsPage(limit, offset) {
  const path = `/result/${encodeURIComponent(QASE_PROJECT_CODE)}?limit=${limit}&offset=${offset}`;
  const json = await qaseGet(path);
  return json?.result || null;
}

async function fetchResultsForRunStrict(runId, startedAtUnix, options = {}) {
  const { limit = 100, maxPages = 50, maxAttempts = 8, waitMs = 3000 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`[QASE] Fetch attempt ${attempt}/${maxAttempts} for run ${runId}...`);

    let offset = 0;
    let pages = 0;
    let collected = [];

    while (pages < maxPages) {
      pages++;
      log(`[QASE] Page ${pages}/${maxPages} (limit=${limit}, offset=${offset})...`);

      const page = await fetchAllResultsPage(limit, offset);
      const entities = Array.isArray(page?.entities) ? page.entities : [];
      if (!entities.length) break;

      const matches = entities.filter((e) => Number(e.run_id) === Number(runId));
      if (matches.length) collected.push(...matches);

      const hasRunMatches = collected.length > 0;

      const minCreated = entities
        .map((e) => e.created || e.created_at || e.timestamp || e.time)
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b)[0];

      if (hasRunMatches && startedAtUnix && minCreated && minCreated < startedAtUnix) {
        log('[QASE] Found run results and reached older pages. Stopping pagination.');
        break;
      }

      offset += limit;
    }

    if (collected.length) {
      const seen = new Set();
      const uniq = [];

      for (const r of collected) {
        const key =
          r.id ??
          r.hash ??
          `${r.run_id}:${extractCaseId(r) || 'nocase'}:${String(r.status)}:${r.end_time || r.created || r.created_at || ''}`;

        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(r);
      }

      log(`[QASE] Results for run ${runId}: ${uniq.length} found.`);
      return uniq;
    }

    log(`[QASE] No results yet for run ${runId}. Waiting ${waitMs}ms...`);
    await sleep(waitMs);
  }

  return [];
}

const caseTitleCache = new Map();

async function fetchCaseTitle(caseId) {
  if (!caseId) return null;
  if (caseTitleCache.has(caseId)) return caseTitleCache.get(caseId);

  const json = await qaseGet(`/case/${encodeURIComponent(QASE_PROJECT_CODE)}/${encodeURIComponent(caseId)}`);
  const t =
    json?.result?.title && String(json.result.title).trim()
      ? String(json.result.title).trim()
      : `Case #${caseId}`;

  caseTitleCache.set(caseId, t);
  return t;
}

/* ---------------- aggregation ---------------- */

function mergeKeyForResult(r) {
  const caseId = extractCaseId(r);
  if (caseId) return `case:${caseId}`;
  if (r?.hash) return `hash:${r.hash}`;
  if (r?.id) return `id:${r.id}`;

  const title = bestTitleFromResult(r) || 'unknown';
  const browser = r?.browser || r?.metadata?.browser || '';
  const env = r?.environment || r?.metadata?.env || '';
  const param = typeof r?.param === 'string' ? r.param : '';
  return `title:${title}|browser:${browser}|env:${env}|param:${param}`;
}

function pickBetterTitle(a, b) {
  const aBad = isBadTitle(a);
  const bBad = isBadTitle(b);

  if (aBad && !bBad) return b;
  if (!aBad && bBad) return a;

  if (!aBad && !bBad) return String(b).length > String(a).length ? b : a;
  return String(b).length < String(a).length ? b : a;
}

function combineStatus(existing, incoming) {
  if (!existing) return incoming;

  const ex = existing === STATUS.INVALID ? STATUS.FAILED : existing;
  const inc = incoming === STATUS.INVALID ? STATUS.FAILED : incoming;

  if (ex === STATUS.FLAKY || inc === STATUS.FLAKY) return STATUS.FLAKY;

  const passFailCombo =
    (ex === STATUS.PASSED && inc === STATUS.FAILED) || (ex === STATUS.FAILED && inc === STATUS.PASSED);

  if (passFailCombo) return STATUS.FLAKY;

  return statusRank(inc) < statusRank(ex) ? incoming : existing;
}

/* ---------------- processing queue-safe per runId ---------------- */

const processingByRunId = new Map();

async function processRunCompleted(projectCode, runId) {
  if (processingByRunId.has(runId)) {
    log(`[QASE] Run ${runId} already processing. Ignoring duplicate run.completed.`);
    return processingByRunId.get(runId);
  }

  const p = (async () => {
    const runLink = `https://app.qase.io/run/${projectCode}/dashboard/${runId}`;
    log(`[QASE] Run completed: ${runId}`);

    const runMeta = await fetchRunMeta(runId).catch((e) => {
      log(`[QASE] Failed to fetch run meta: ${e.message}`);
      return null;
    });

    let startedAtUnix = 0;
    if (runMeta?.start_time && typeof runMeta.start_time === 'string') {
      const ms = Date.parse(runMeta.start_time);
      if (Number.isFinite(ms)) startedAtUnix = Math.floor(ms / 1000);
    } else {
      startedAtUnix = Number(runMeta?.created) || Number(runMeta?.created_at) || 0;
    }

    const runCases = Array.isArray(runMeta?.cases) ? runMeta.cases : [];
    const caseMap = new Map();

    for (const c of runCases) {
      const cid = Number(c?.case_id ?? c?.id ?? c?.case?.id);
      if (!Number.isFinite(cid) || cid <= 0) continue;

      const title =
        typeof c?.title === 'string' && c.title.trim()
          ? c.title.trim()
          : typeof c?.case?.title === 'string' && c.case.title.trim()
            ? c.case.title.trim()
            : null;

      const st = normalizeStatus(c?.status ?? c?.status_id ?? c?.result ?? c?.state);
      caseMap.set(cid, { title, status: st });
    }

    const results = await fetchResultsForRunStrict(runId, startedAtUnix, {
      limit: 100,
      maxPages: 50,
      maxAttempts: 8,
      waitMs: 3000,
    });

    if (!results.length) {
      await sendToSlack({
        text:
          `*Automation Regression Tests*\n\n` +
          `Project: *${projectCode}*\n` +
          `Date: *${formatRunDateDenmarkWithWeek()}*\n` +
          `Browsers: Chrome, Edge, Firefox, Safari, Mobile(webkit)\n\n` +
          `Run link: ${runLink}\n\n` +
          `No results returned from Qase API.`,
      });

      return;
    }

    const aggregated = new Map();

    for (const r of results) {
      const caseId = extractCaseId(r);

      let status = normalizeStatus(r?.status ?? r?.status_id ?? r?.statusId ?? r?.result ?? r?.state);
      if (status === STATUS.INVALID && inferFailedFromResult(r)) status = STATUS.FAILED;

      if (caseId && caseMap.has(caseId)) {
        const s2 = caseMap.get(caseId)?.status;
        if (s2 && s2 !== STATUS.INVALID) status = s2;
        if (status === STATUS.INVALID && s2 === STATUS.FAILED) status = STATUS.FAILED;
      }

      if (inferFlakyFromResult(r)) {
        status = STATUS.FLAKY;
      }

      let title;
      if (caseId) {
        title = caseMap.get(caseId)?.title || null;
        if (!title || String(title).trim().toLowerCase().startsWith('case #')) {
          title = await fetchCaseTitle(caseId).catch(() => `Case #${caseId}`);
        }
      } else {
        title = bestTitleFromResult(r);
      }

      const urlFromTitle = snapshotIdToUrl(title);
      if (urlFromTitle) title = formatVisualTitleFromUrl(urlFromTitle);

      title = `${title}${resultSuffix(r)}`;

      const key = mergeKeyForResult(r);
      const existing = aggregated.get(key);

      if (!existing) {
        aggregated.set(key, { title, status });
      } else {
        const mergedStatus = combineStatus(existing.status, status);
        const betterTitle = pickBetterTitle(existing.title, title);
        aggregated.set(key, { title: betterTitle, status: mergedStatus });
      }
    }

    const lines = Array.from(aggregated.values());

    const counts = {
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      blocked: 0,
      invalid: 0,
    };

    for (const l of lines) {
      if (l.status === STATUS.PASSED) counts.passed++;
      else if (l.status === STATUS.FAILED) counts.failed++;
      else if (l.status === STATUS.FLAKY) counts.flaky++;
      else if (l.status === STATUS.SKIPPED) counts.skipped++;
      else if (l.status === STATUS.INVALID) counts.invalid++;
      else counts.blocked++;
    }

    const order = {
      failed: 0,
      invalid: 1,
      blocked: 2,
      flaky: 3,
      skipped: 4,
      passed: 5,
    };

    lines.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

    await sendToSlack({
      text:
        `*Automation Regression Tests*\n\n` +
        `Project: *${projectCode}* | Run: *${runId}*\n` +
        `Date: *${formatRunDateDenmarkWithWeek()}*\n` +
        `Browsers: Chrome, Edge, Firefox, Safari, Mobile(webkit)\n\n` +
        `Passed: *${counts.passed}* | Failed: *${counts.failed}* | Flaky: *${counts.flaky}* | ` +
        `Skipped: *${counts.skipped}* | Blocked: *${counts.blocked}* | Invalid: *${counts.invalid}*\n\n` +
        `_${DISCLAIMER}_\n\n` +
        `*Test case results (${lines.length}):*\n` +
        lines.map((l) => `${statusEmoji(l.status)} ${l.title} — *${l.status}*`).join('\n'),
    });

    log(`[DONE] Run ${runId} processed. lines=${lines.length}`);
  })();

  processingByRunId.set(runId, p);
  p.finally(() => processingByRunId.delete(runId));
  return p;
}

/* ---------------- routes ---------------- */

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

app.post('/qase/webhook', async (req, res) => {
  try {
    const missing = missingEnvs();
    if (missing.length) {
      log(`Webhook processing error: Missing env vars: ${missing.join(', ')}`);
      return res.status(500).json({
        ok: false,
        error: `Missing env vars: ${missing.join(', ')}`,
      });
    }

    const eventName = req.body?.event_name;
    const projectCode = req.body?.project_code || QASE_PROJECT_CODE;

    log(`\n[INCOMING] POST /qase/webhook event=${eventName}`);

    if (eventName === 'run.started') {
      const runId = req.body?.payload?.id;
      if (runId) log(`[QASE] Run started: ${runId}`);
      return res.status(200).json({ ok: true, ignored: false, event: eventName });
    }

    if (eventName !== 'run.completed') {
      return res.status(200).json({ ok: true, ignored: true, event: eventName });
    }

    const runId = req.body?.payload?.id;
    if (!runId) {
      log('[QASE] Missing payload.id (runId).');
      return res.status(400).json({
        ok: false,
        error: 'Missing payload.id (runId)',
      });
    }

    await processRunCompleted(projectCode, runId);

    return res.status(200).json({
      ok: true,
      processed: true,
      runId,
    });
  } catch (err) {
    log('Webhook processing error:', {
      message: err.message,
      url: err.url,
      status: err.status,
    });

    return res.status(500).json({
      ok: false,
      error: err.message || 'Internal server error',
    });
  }
});

/* ---------------- local + export ---------------- */

if (require.main === module) {
  log(`SLACK_WEBHOOK_URL configured: ${Boolean(SLACK_WEBHOOK_URL)}`);
  log(`=== MIDDLEWARE VERSION: ${VERSION} ===`);
  log(`Middleware running on port ${PORT}`);
  log(`SLACK_WEBHOOK_URL: ${SLACK_WEBHOOK_URL}`);

  const missing = missingEnvs();
  if (missing.length) {
    log(`[WARN] Missing env vars: ${missing.join(', ')}`);
  }

  app.listen(PORT, () => {
    log(`HTTP server listening on port ${PORT}`);
  });
}

module.exports = app;