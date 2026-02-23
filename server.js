/**
 * server.js
 * Qase Webhooks -> Slack
 *
 * v18:
 * - FIX: snapshot-id parsing supports regions like "int" (3 letters) => en_int
 * - Converts snapshot-id like "www-kompan-com_en_int_data-ethics"
 *   into: "Visual Regression Test - https://www.kompan.com/en/int/data-ethics renders correctly (entire scrollable page)"
 * - Still: no failure reason in Slack
 * - Aggregates results by case_id/hash/id so you don’t get duplicates
 */

require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const VERSION =
  'QASE->SLACK v18 (FIX SNAPSHOT en_int -> URL TITLE + AGGREGATE BY HASH + NO REASON)';

const REQUIRED_ENVS = ['SLACK_WEBHOOK_URL', 'QASE_API_TOKEN', 'QASE_PROJECT_CODE'];
function missingEnvs() {
  return REQUIRED_ENVS.filter((k) => !process.env[k] || String(process.env[k]).trim() === '');
}

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const QASE_API_TOKEN = process.env.QASE_API_TOKEN;
const QASE_PROJECT_CODE = process.env.QASE_PROJECT_CODE;
const PORT = Number(process.env.PORT || 3000);

const QASE_BASE = 'https://api.qase.io/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
const log = (...a) => console.log(`[${ts()}]`, ...a);

function qaseHeaders() {
  return { 'Content-Type': 'application/json', Token: QASE_API_TOKEN };
}
// Denmark date (DD/MM/YYYY) + English "Week X"
function formatRunDateDenmarkWithWeek() {
  const now = new Date();

  // ✅ Date in Denmark time, forced to DD/MM/YYYY (English-style separators)
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

  // ✅ Compute ISO week number based on Denmark-local date
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
  const day = dt.getUTCDay() || 7; // Mon=1..Sun=7
  dt.setUTCDate(dt.getUTCDate() + 4 - day); // move to Thursday
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);

  return `${date} - Week ${week}`;
}
async function qaseGet(path) {
  const url = `${QASE_BASE}${path}`;
  const res = await fetch(url, { method: 'GET', headers: qaseHeaders() });
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
    if (candidate !== undefined && candidate !== null) return normalizeStatus(candidate);
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

/**
 * FIXED: snapshot-id -> URL
 * Supports:
 *  - www-kompan-com_en_int_data-ethics  (region=3 letters)
 *  - kompan-com_en_us_some-path         (domain without www-)
 *
 * Format expected: <domainPart>_<lang>_<region>_<path...>
 * domainPart uses "-" as "." (e.g. www-kompan-com -> www.kompan.com)
 */
function snapshotIdToUrl(snapshotId) {
  const s = String(snapshotId || '').trim();
  if (!s) return null;

  // must contain 3 underscores at least: domain_lang_region_path
  if ((s.match(/_/g) || []).length < 3) return null;

  const parts = s.split('_');
  if (parts.length < 4) return null;

  const domainPart = parts[0];
  const lang = parts[1];
  const region = parts[2];
  const pathParts = parts.slice(3);

  // lang usually 2 letters; region can be 2-5 (int/us/dk/de-de etc -> we keep it permissive)
  if (!/^[a-z]{2}$/i.test(lang)) return null;
  if (!/^[a-z]{2,5}(-[a-z]{2,5})?$/i.test(region)) return null;

  // domainPart like www-kompan-com or kompan-com
  if (!/^[a-z0-9-]+$/i.test(domainPart)) return null;

  const domain = domainPart.replace(/-/g, '.');

  // path may include hyphens; if underscores appear in pathParts, treat as "/" separators
  let path = pathParts.join('_').replace(/_/g, '/');
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

  // Best: already contains "Visual Regression Test - ..."
  const vr = t.match(/(Visual Regression Test\s*-\s*[^\n]+)/i);
  if (vr && vr[1]) {
    const out = vr[1].trim().slice(0, 260);
    if (out && !isBadTitle(out)) return out;
  }

  // Snapshot name: xxx
  const sn = t.match(/Snapshot name:\s*([^\n]+)/i);
  if (sn && sn[1]) {
    const cleaned = cleanupSnapshotDerivedTitle(sn[1]);
    if (cleaned && !isBadTitle(cleaned)) {
      const url = snapshotIdToUrl(cleaned);
      if (url) return formatVisualTitleFromUrl(url);
      return cleaned.slice(0, 260);
    }
  }

  // Snapshot path
  const sp = t.match(/Snapshot:\s*([^\n]+)/i);
  if (sp && sp[1]) {
    const cleaned = cleanupSnapshotDerivedTitle(sp[1]);
    if (cleaned && !isBadTitle(cleaned)) {
      const url = snapshotIdToUrl(cleaned);
      if (url) return formatVisualTitleFromUrl(url);
      return cleaned.slice(0, 260);
    }
  }

  // Look for __snapshots__ path
  const pathMatch = t.match(/(?:__snapshots__|[-_]snapshots)[/\\]([^\n]+?\.(png|jpg|jpeg|webp))/i);
  if (pathMatch && pathMatch[1]) {
    const cleaned = cleanupSnapshotDerivedTitle(pathMatch[1]);
    if (cleaned && !isBadTitle(cleaned)) {
      const url = snapshotIdToUrl(cleaned);
      if (url) return formatVisualTitleFromUrl(url);
      return cleaned.slice(0, 260);
    }
  }

  // Footer short title
  const footer = t.match(/Footer (validation|links) (failed|failure)[^\n]*/i);
  if (footer && footer[0]) {
    const out = footer[0].trim().slice(0, 180);
    if (out && !isBadTitle(out)) return out;
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

  // last resort
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

/* ---------------- Slack ---------------- */
async function sendToSlack(payload) {
  log(`[SLACK] Sending message...`);
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const txt = await res.text().catch(() => '');
  log(`[SLACK] HTTP ${res.status} ok=${res.ok} body=${(txt || '').slice(0, 200)}`);
  if (!res.ok) throw new Error(`Slack webhook failed: HTTP ${res.status}`);
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
        log(`[QASE] Found run results and reached older pages. Stopping pagination.`);
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
  return `nocase:${Math.random().toString(16).slice(2)}`;
}

function pickBetterTitle(a, b) {
  const aBad = isBadTitle(a);
  const bBad = isBadTitle(b);

  if (aBad && !bBad) return b;
  if (!aBad && bBad) return a;

  if (!aBad && !bBad) return String(b).length > String(a).length ? b : a;
  return String(b).length < String(a).length ? b : a;
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
    await sendToSlack({
      text:
        `*Automation Regression Tests*\n\n` +
        `Project: *${projectCode}*\n\n` +
        //`Run link: ${runLink}\n\n` +
    `Date: *${formatRunDateDenmarkWithWeek()}*\n\n` +
        `Collecting results...`,
    });

    log(`[QASE] Fetching run meta for ${runId} (include=cases)...`);
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
    log(`[QASE] Run cases from /run include=cases: ${runCases.length}`);

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

    log(`[QASE] Fetching results list for run ${runId}...`);
    const results = await fetchResultsForRunStrict(runId, startedAtUnix, {
      limit: 100,
      maxPages: 50,
      maxAttempts: 8,
      waitMs: 3000,
    });

    if (!results.length) {
      log(`[QASE] No results returned for run ${runId}. Nothing else to send.`);
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

      let title;
      if (caseId) {
        title = caseMap.get(caseId)?.title || null;
        if (!title || String(title).trim().toLowerCase().startsWith('case #')) {
          title = await fetchCaseTitle(caseId).catch(() => `Case #${caseId}`);
        }
      } else {
        title = bestTitleFromResult(r);
      }

      // EXTRA FIX: if title itself is a snapshot-id, convert it too
      const urlFromTitle = snapshotIdToUrl(title);
      if (urlFromTitle) title = formatVisualTitleFromUrl(urlFromTitle);

      title = `${title}${resultSuffix(r)}`;

      const key = mergeKeyForResult(r);
      const existing = aggregated.get(key);

      if (!existing) {
        aggregated.set(key, { title, status });
      } else {
        const worseStatus = statusRank(status) < statusRank(existing.status) ? status : existing.status;
        const betterTitle = pickBetterTitle(existing.title, title);
        aggregated.set(key, { title: betterTitle, status: worseStatus });
      }
    }

    const lines = Array.from(aggregated.values());

    const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0, blocked: 0, invalid: 0 };
    for (const l of lines) {
      if (l.status === STATUS.PASSED) counts.passed++;
      else if (l.status === STATUS.FAILED) counts.failed++;
      else if (l.status === STATUS.FLAKY) counts.flaky++;
      else if (l.status === STATUS.SKIPPED) counts.skipped++;
      else if (l.status === STATUS.INVALID) counts.invalid++;
      else counts.blocked++;
    }

    const order = { failed: 0, invalid: 1, blocked: 2, flaky: 3, skipped: 4, passed: 5 };
    lines.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

    await sendToSlack({
      text:
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
app.get('/health', (_req, res) => res.status(200).send('ok'));

app.post('/qase/webhook', async (req, res) => {
  res.status(200).json({ ok: true });

  try {
    const missing = missingEnvs();
    if (missing.length) {
      log(`Webhook processing error: Missing env vars: ${missing.join(', ')}`);
      return;
    }

    const eventName = req.body?.event_name;
    const projectCode = req.body?.project_code || QASE_PROJECT_CODE;

    log(`\n[INCOMING] POST /qase/webhook event=${eventName}`);

    if (eventName === 'run.started') {
      const runId = req.body?.payload?.id;
      const title = req.body?.payload?.title || '';
      const env = req.body?.payload?.environment || '';
      if (runId) log(`[QASE] Run started: ${runId} | title="${title}" | env="${env}"`);
      return;
    }

    if (eventName !== 'run.completed') return;

    const runId = req.body?.payload?.id;
    if (!runId) {
      log('[QASE] Missing payload.id (runId).');
      return;
    }

    log(
      `[QASE] Webhook run.completed received: run=${runId} payload.status="${req.body?.payload?.status || ''}"`
    );

    processRunCompleted(projectCode, runId).catch((e) => {
      log(`[ERROR] Run ${runId} processing failed: ${e.message}`);
    });
  } catch (err) {
    log('Webhook processing error:', { message: err.message, url: err.url, status: err.status });
  }
});

app.listen(PORT, () => {
  log(`=== MIDDLEWARE VERSION: ${VERSION} ===`);
  log(`Middleware running on port ${PORT}`);
  const missing = missingEnvs();
  if (missing.length) log(`[WARN] Missing env vars: ${missing.join(', ')}`);
});