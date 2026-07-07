/**
 * server.js
 * Qase Webhooks -> Slack
 *
 * Fixes:
 * - Fetches Qase results directly by run id using ?run=<runId>
 * - Counts raw test executions for Slack result totals
 * - Keeps attention list grouped by unique test case
 * - Does not send misleading Slack message when Qase API returns no results
 * - Vercel-safe: waits for processing before returning 200
 * - Treats flaky tests as passed
 */

require('dotenv').config();

const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const VERSION = 'QASE->SLACK v32 (FLAKY COUNTS AS PASSED)';

const REQUIRED_ENVS = ['SLACK_WEBHOOK_URL', 'QASE_API_TOKEN', 'QASE_PROJECT_CODE'];

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const QASE_API_TOKEN = process.env.QASE_API_TOKEN;
const QASE_PROJECT_CODE = process.env.QASE_PROJECT_CODE;
const PORT = Number(process.env.PORT || 3000);

const QASE_BASE = 'https://api.qase.io/v1';

const STATUS = {
  PASSED: 'passed',
  FAILED: 'failed',
  FLAKY: 'flaky',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
  INVALID: 'invalid',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', 'Z');

const log = (...args) => {
  console.log(`[${ts()}]`, ...args);
};

function missingEnvs() {
  return REQUIRED_ENVS.filter((key) => {
    return !process.env[key] || String(process.env[key]).trim() === '';
  });
}

function qaseHeaders() {
  return {
    'Content-Type': 'application/json',
    Token: QASE_API_TOKEN,
  };
}

/* ---------------- URL / REPORT HELPERS ---------------- */

function findFirstUrlDeep(value, matcher, depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return matcher.test(trimmed) ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstUrlDeep(item, matcher, depth + 1);

      if (found) {
        return found;
      }
    }

    return null;
  }

  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const found = findFirstUrlDeep(value[key], matcher, depth + 1);

      if (found) {
        return found;
      }
    }
  }

  return null;
}

function extractQasePublicReportUrl(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const directCandidates = [
    payload.public_report_url,
    payload.publicReportUrl,
    payload.public_url,
    payload.publicUrl,
    payload.report_url,
    payload.reportUrl,
    payload.share_url,
    payload.shareUrl,
    payload.shared_url,
    payload.sharedUrl,
    payload.public_link,
    payload.publicLink,
    payload.url,
    payload.link,

    payload.result?.public_report_url,
    payload.result?.publicReportUrl,
    payload.result?.public_url,
    payload.result?.publicUrl,
    payload.result?.report_url,
    payload.result?.reportUrl,
    payload.result?.share_url,
    payload.result?.shareUrl,
    payload.result?.shared_url,
    payload.result?.sharedUrl,
    payload.result?.public_link,
    payload.result?.publicLink,
    payload.result?.url,
    payload.result?.link,

    payload.result?.report?.public_url,
    payload.result?.report?.publicUrl,
    payload.result?.report?.url,
    payload.result?.share?.url,
    payload.result?.public?.url,
  ];

  for (const candidate of directCandidates) {
    if (
      typeof candidate === 'string' &&
      /^https:\/\/app\.qase\.io\/public\/report\//i.test(candidate.trim())
    ) {
      return candidate.trim();
    }
  }

  return findFirstUrlDeep(payload, /^https:\/\/app\.qase\.io\/public\/report\//i);
}

function formatReportLine(reportLink) {
  if (!reportLink) {
    return '';
  }

  return `*Automation Test Run Report:* <${reportLink}|Open report>\n\n`;
}

function formatRunDateDenmarkWithWeek() {
  const now = new Date();

  const partsDate = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Copenhagen',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(now);

  const dd = partsDate.find((part) => part.type === 'day')?.value;
  const mm = partsDate.find((part) => part.type === 'month')?.value;
  const yyyy = partsDate.find((part) => part.type === 'year')?.value;

  const date = `${dd}/${mm}/${yyyy}`;

  const partsYMD = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const y = Number(partsYMD.find((part) => part.type === 'year')?.value);
  const m = Number(partsYMD.find((part) => part.type === 'month')?.value);
  const d = Number(partsYMD.find((part) => part.type === 'day')?.value);

  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay() || 7;

  dt.setUTCDate(dt.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);

  return `${date} - Week ${week}`;
}

/* ---------------- QASE API ---------------- */

async function qaseGet(path) {
  const url = `${QASE_BASE}${path}`;

  log(`[QASE] GET ${path}`);

  const res = await fetch(url, {
    method: 'GET',
    headers: qaseHeaders(),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const message = json?.errorMessage || json?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(message);

    err.status = res.status;
    err.body = json;
    err.url = url;

    throw err;
  }

  return json;
}

async function makeRunPublic(projectCode, runId) {
  const url = `${QASE_BASE}/run/${encodeURIComponent(projectCode)}/${encodeURIComponent(
    runId
  )}/public`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: qaseHeaders(),
    body: JSON.stringify({
      status: true,
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const message = json?.errorMessage || json?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(message);

    err.status = res.status;
    err.body = json;
    err.url = url;

    throw err;
  }

  const publicUrl = extractQasePublicReportUrl(json);

  if (!publicUrl) {
    log(
      '[QASE] makeRunPublic response did not include public URL:',
      JSON.stringify(json, null, 2).slice(0, 4000)
    );
  }

  return publicUrl;
}

async function fetchRunMeta(runId) {
  const path = `/run/${encodeURIComponent(QASE_PROJECT_CODE)}/${encodeURIComponent(
    runId
  )}?include=cases`;

  const json = await qaseGet(path);

  return json?.result || null;
}

async function fetchAllResultsPage(limit, offset, runId) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (runId) {
    params.set('run', String(runId));
  }

  const path = `/result/${encodeURIComponent(QASE_PROJECT_CODE)}?${params.toString()}`;
  const json = await qaseGet(path);

  return json?.result || null;
}

async function fetchResultsForRunStrict(runId, _startedAtUnix, options = {}) {
  const {
    limit = 100,
    maxPages = 30,
    maxAttempts = 30,
    waitMs = 10000,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`[QASE] Fetch attempt ${attempt}/${maxAttempts} for run ${runId}...`);

    let offset = 0;
    let pages = 0;
    const collected = [];

    while (pages < maxPages) {
      pages++;

      log(
        `[QASE] Page ${pages}/${maxPages} for run=${runId}, limit=${limit}, offset=${offset}...`
      );

      const page = await fetchAllResultsPage(limit, offset, runId);
      const entities = Array.isArray(page?.entities) ? page.entities : [];

      log(`[QASE] Page ${pages} returned ${entities.length} entities.`);

      if (!entities.length) {
        break;
      }

      collected.push(...entities);

      if (entities.length < limit) {
        break;
      }

      offset += limit;
    }

    if (collected.length) {
      const seen = new Set();
      const unique = [];

      for (const result of collected) {
        const key =
          result.id ??
          result.hash ??
          `${result.run_id || result.runId || result.run?.id || runId}:${
            extractCaseId(result) || 'nocase'
          }:${String(result.status ?? result.status_id ?? result.statusId ?? '')}:${
            result.end_time || result.created || result.created_at || result.hash || ''
          }`;

        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        unique.push(result);
      }

      log(`[QASE] Results for run ${runId}: ${unique.length} found.`);

      return unique;
    }

    log(`[QASE] No results yet for run ${runId}. Waiting ${waitMs}ms...`);

    await sleep(waitMs);
  }

  log(`[QASE] No results returned for run ${runId} after polling.`);

  return [];
}

const caseTitleCache = new Map();

async function fetchCaseTitle(caseId) {
  if (!caseId) {
    return null;
  }

  if (caseTitleCache.has(caseId)) {
    return caseTitleCache.get(caseId);
  }

  const json = await qaseGet(
    `/case/${encodeURIComponent(QASE_PROJECT_CODE)}/${encodeURIComponent(caseId)}`
  );

  const title =
    json?.result?.title && String(json.result.title).trim()
      ? String(json.result.title).trim()
      : `Case #${caseId}`;

  caseTitleCache.set(caseId, title);

  return title;
}

/* ---------------- STATUS HELPERS ---------------- */

function normalizeStatus(raw) {
  if (raw === null || raw === undefined) {
    return STATUS.BLOCKED;
  }

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
    if (raw === 6) return STATUS.PASSED;

    return STATUS.BLOCKED;
  }

  const status = String(raw).toLowerCase().trim();

  if (status === 'passed' || status === 'pass') return STATUS.PASSED;
  if (status === 'failed' || status === 'fail') return STATUS.FAILED;
  if (status === 'flaky' || status === 'unstable') return STATUS.PASSED;
  if (
    status === 'skipped' ||
    status === 'skiped' ||
    status === 'skip' ||
    status === 'untested'
  ) {
    return STATUS.SKIPPED;
  }
  if (status === 'invalid') return STATUS.INVALID;

  if (
    status === 'blocked' ||
    status.includes('block') ||
    status.includes('cancel') ||
    status.includes('abort') ||
    status.includes('queue') ||
    status.includes('progress') ||
    status === 'running'
  ) {
    return STATUS.BLOCKED;
  }

  return STATUS.BLOCKED;
}

function statusEmoji(status) {
  if (status === STATUS.PASSED) return '✅';
  if (status === STATUS.FAILED) return '❌';
  if (status === STATUS.FLAKY) return '⚠️';
  if (status === STATUS.SKIPPED) return '↪️';
  if (status === STATUS.INVALID) return '❓';

  return '⛔';
}

function statusRank(status) {
  if (status === STATUS.FAILED) return 0;
  if (status === STATUS.INVALID) return 1;
  if (status === STATUS.BLOCKED) return 2;
  if (status === STATUS.FLAKY) return 3;
  if (status === STATUS.SKIPPED) return 4;

  return 5;
}

/* ---------------- TITLE HELPERS ---------------- */

function extractCaseId(result) {
  const value =
    result?.case_id ??
    result?.caseId ??
    result?.case?.id ??
    result?.case?.case_id ??
    result?.testcase?.id ??
    result?.testCaseId ??
    result?.relations?.case_id ??
    null;

  const id = Number(value);

  return Number.isFinite(id) && id > 0 ? id : null;
}

function resultSuffix(result) {
  const bits = [];
  const param = result?.param || result?.params || result?.parameters;

  if (param && typeof param === 'string') {
    if (!/chrome|chromium|edge|firefox|safari|webkit|mobile|browser/i.test(param)) {
      bits.push(param);
    }
  }

  if (param && typeof param === 'object') {
    const cleanParam = { ...param };

    delete cleanParam.browser;
    delete cleanParam.Browser;
    delete cleanParam.browserName;
    delete cleanParam.browser_name;
    delete cleanParam.project;
    delete cleanParam.Project;
    delete cleanParam.projectName;
    delete cleanParam.project_name;
    delete cleanParam.device;
    delete cleanParam.Device;
    delete cleanParam.platform;
    delete cleanParam.environment;
    delete cleanParam.env;

    const serialized = JSON.stringify(cleanParam);

    if (serialized && serialized !== '{}' && serialized !== 'null') {
      bits.push(serialized);
    }
  }

  const suffix = bits.filter(Boolean).join(' | ').trim();

  return suffix ? ` — ${suffix}` : '';
}

function isBadTitle(title) {
  const value = String(title || '').trim();

  if (!value) {
    return true;
  }

  const lower = value.toLowerCase();

  return (
    lower.startsWith('error:') ||
    lower.includes('expect(') ||
    lower.includes('tohavescreenshot') ||
    lower.includes("snapshot doesn't exist") ||
    lower.includes('compounderror') ||
    lower.includes('received:') ||
    lower.includes('expected:') ||
    lower.includes('stack trace') ||
    lower.includes('end of error message')
  );
}

function cleanupSnapshotDerivedTitle(value) {
  let title = String(value || '').trim();

  title = title.replace(/^.*?(?:-snapshots|__snapshots__)[/\\]/i, '');
  title = title.replace(/\.(png|jpg|jpeg|webp)$/i, '');
  title = title.replace(/-(chromium|firefox|webkit)(-darwin|-linux|-win32)?$/i, '');
  title = title.replace(/\s+/g, ' ').trim();

  return title || null;
}

function snapshotIdToUrl(snapshotId) {
  const value = String(snapshotId || '').trim();

  if (!value) {
    return null;
  }

  if ((value.match(/_/g) || []).length < 3) {
    return null;
  }

  const parts = value.split('_');

  if (parts.length < 4) {
    return null;
  }

  const domainPart = parts[0];
  const lang = parts[1];
  const region = parts[2];
  const pathParts = parts.slice(3);

  if (!/^[a-z]{2}$/i.test(lang)) {
    return null;
  }

  if (!/^[a-z]{2,5}(-[a-z]{2,5})?$/i.test(region)) {
    return null;
  }

  if (!/^[a-z0-9-]+$/i.test(domainPart)) {
    return null;
  }

  const domain = domainPart.replace(/-/g, '.');
  const path = pathParts.join('_').replace(/_/g, '/');

  if (!path) {
    return null;
  }

  return `https://${domain}/${lang}/${region}/${path}`;
}

function formatVisualTitleFromUrl(url) {
  if (!url) {
    return null;
  }

  return `Visual Regression Test - ${url} renders correctly (entire scrollable page)`;
}

function titleFromErrorText(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const normalizedText = text.replace(/\r/g, '\n');

  const visualRegressionTitle = normalizedText.match(/(Visual Regression Test\s*-\s*[^\n]+)/i);

  if (visualRegressionTitle && visualRegressionTitle[1]) {
    const output = visualRegressionTitle[1].trim().slice(0, 260);

    if (output && !isBadTitle(output)) {
      return output;
    }
  }

  const snapshotName =
    normalizedText.match(/Snapshot name:\s*([^\n]+)/i) ||
    normalizedText.match(/Snapshot:\s*([^\n]+)/i);

  if (snapshotName && snapshotName[1]) {
    const cleaned = cleanupSnapshotDerivedTitle(snapshotName[1]);

    if (cleaned && !isBadTitle(cleaned)) {
      const url = snapshotIdToUrl(cleaned);

      if (url) {
        return formatVisualTitleFromUrl(url);
      }

      return cleaned.slice(0, 260);
    }
  }

  const pathMatch = normalizedText.match(
    /(?:__snapshots__|[-_]snapshots)[/\\]([^\n]+?\.(png|jpg|jpeg|webp))/i
  );

  if (pathMatch && pathMatch[1]) {
    const cleaned = cleanupSnapshotDerivedTitle(pathMatch[1]);

    if (cleaned && !isBadTitle(cleaned)) {
      const url = snapshotIdToUrl(cleaned);

      if (url) {
        return formatVisualTitleFromUrl(url);
      }

      return cleaned.slice(0, 260);
    }
  }

  return null;
}

function bestTitleFromResult(result) {
  const candidates = [
    result?.case?.title,
    result?.case_title,
    result?.testcase_title,
    result?.test_title,
    result?.test?.title,
    result?.test?.name,
    result?.title,
    result?.name,
    result?.automation?.title,
  ].filter((candidate) => typeof candidate === 'string' && candidate.trim());

  if (candidates.length) {
    const title = candidates[0].trim();
    const url = snapshotIdToUrl(title);

    if (url) {
      return formatVisualTitleFromUrl(url);
    }

    return title;
  }

  const fromStack = titleFromErrorText(result?.stacktrace);

  if (fromStack) {
    return fromStack;
  }

  const fromComment = titleFromErrorText(result?.comment);

  if (fromComment) {
    return fromComment;
  }

  if (result?.id) {
    return `Test result #${result.id}`;
  }

  if (result?.hash) {
    return `Test ${String(result.hash).slice(0, 10)}`;
  }

  return 'Unknown test';
}

/* ---------------- FAILURE / FLAKY INFERENCE ---------------- */

function inferFailedFromResult(result) {
  const comment = typeof result?.comment === 'string' ? result.comment : '';
  const stack = typeof result?.stacktrace === 'string' ? result.stacktrace : '';

  const hasErrorWord =
    /error|exception|timeout|failed|failure|compounderror|tohavescreenshot|snapshot/i.test(
      comment
    ) ||
    /error|exception|timeout|failed|failure|compounderror|tohavescreenshot|snapshot/i.test(stack);

  const hasAssertion =
    /expect\(|expected:\s*\d+|received:\s*\d+|assert/i.test(comment) ||
    /expect\(|expected:\s*\d+|received:\s*\d+|assert/i.test(stack);

  const hasAttachments = Array.isArray(result?.attachments) && result.attachments.length > 0;

  return Boolean(hasErrorWord || hasAssertion || hasAttachments);
}

function inferFlakyFromResult(result) {
  if (!result || typeof result !== 'object') {
    return false;
  }

  if (result.is_flaky === true || result.flaky === true) {
    return true;
  }

  const retryCount =
    Number(result.retries) ||
    Number(result.retry) ||
    Number(result.retry_count) ||
    Number(result.retest) ||
    Number(result.retest_count) ||
    0;

  const attempts =
    (Array.isArray(result.retries) && result.retries) ||
    (Array.isArray(result.retry_results) && result.retry_results) ||
    (Array.isArray(result.attempts) && result.attempts) ||
    (Array.isArray(result.results) && result.results) ||
    [];

  if (attempts.length) {
    const statuses = attempts
      .map((attempt) => {
        return normalizeStatus(
          attempt?.status ??
            attempt?.status_id ??
            attempt?.statusId ??
            attempt?.result ??
            attempt?.state
        );
      })
      .filter(Boolean);

    const hasFail = statuses.includes(STATUS.FAILED) || statuses.includes(STATUS.INVALID);
    const hasPass = statuses.includes(STATUS.PASSED);

    if (hasFail && hasPass) {
      return true;
    }
  }

  if (retryCount > 0) {
    return true;
  }

  const comment = typeof result.comment === 'string' ? result.comment : '';
  const stack = typeof result.stacktrace === 'string' ? result.stacktrace : '';

  if (
    /retry|re-?run|rerun|flaky/i.test(comment) ||
    /retry|re-?run|rerun|flaky/i.test(stack)
  ) {
    return true;
  }

  return false;
}

/* ---------------- AGGREGATION ---------------- */

function mergeKeyForResult(result) {
  const caseId = extractCaseId(result);

  if (caseId) {
    return `case:${caseId}`;
  }

  if (result?.hash) {
    return `hash:${result.hash}`;
  }

  if (result?.id) {
    return `id:${result.id}`;
  }

  const title = bestTitleFromResult(result) || 'unknown';
  const env = result?.environment || result?.metadata?.env || '';
  const param = typeof result?.param === 'string' ? result.param : '';

  return `title:${title}|env:${env}|param:${param}`;
}

function pickBetterTitle(currentTitle, incomingTitle) {
  const currentBad = isBadTitle(currentTitle);
  const incomingBad = isBadTitle(incomingTitle);

  if (currentBad && !incomingBad) {
    return incomingTitle;
  }

  if (!currentBad && incomingBad) {
    return currentTitle;
  }

  if (!currentBad && !incomingBad) {
    return String(incomingTitle).length > String(currentTitle).length
      ? incomingTitle
      : currentTitle;
  }

  return String(incomingTitle).length < String(currentTitle).length
    ? incomingTitle
    : currentTitle;
}

function combineStatus(existingStatus, incomingStatus) {
  if (!existingStatus) {
    return incomingStatus;
  }

  const existing = existingStatus === STATUS.INVALID ? STATUS.FAILED : existingStatus;
  const incoming = incomingStatus === STATUS.INVALID ? STATUS.FAILED : incomingStatus;

  const passFailCombo =
    (existing === STATUS.PASSED && incoming === STATUS.FAILED) ||
    (existing === STATUS.FAILED && incoming === STATUS.PASSED);

  if (passFailCombo) {
    return STATUS.PASSED;
  }

  return statusRank(incoming) < statusRank(existing) ? incomingStatus : existingStatus;
}

function countExecutionStatuses(executionStatuses) {
  const counts = {
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    blocked: 0,
    invalid: 0,
  };

  for (const status of executionStatuses) {
    if (status === STATUS.PASSED) counts.passed++;
    else if (status === STATUS.FAILED) counts.failed++;
    else if (status === STATUS.FLAKY) counts.passed++;
    else if (status === STATUS.SKIPPED) counts.skipped++;
    else if (status === STATUS.INVALID) counts.invalid++;
    else counts.blocked++;
  }

  return counts;
}

function getCountsTotal(counts) {
  return (
    counts.passed +
    counts.failed +
    counts.flaky +
    counts.skipped +
    counts.blocked +
    counts.invalid
  );
}

/* ---------------- SLACK ---------------- */

async function sendToSlack(payload) {
  log('[SLACK] Sending message...');

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text().catch(() => '');

  log(`[SLACK] HTTP ${res.status} ok=${res.ok} body=${(text || '').slice(0, 200)}`);

  if (!res.ok) {
    throw new Error(`Slack webhook failed: HTTP ${res.status}`);
  }
}

function buildSlackMessage({
  projectCode,
  reportLink,
  counts,
  totalExecutions,
  uniqueCaseCount,
  lines,
}) {
  const passed = counts.passed;
  const passRate = totalExecutions > 0 ? Math.round((passed / totalExecutions) * 100) : 0;

  const hasFailedLike = counts.failed > 0 || counts.invalid > 0 || counts.blocked > 0;

  let statusText;

  if (hasFailedLike) {
    statusText = '❌ Attention required';
  } else {
    statusText = '✅ Passed';
  }

  const importantLines = lines.filter((line) => {
    return [STATUS.FAILED, STATUS.BLOCKED, STATUS.INVALID].includes(line.status);
  });

  const attentionSummary =
    importantLines.length > 0
      ? `*Tests requiring attention:*\n${importantLines
          .map((line) => {
            return `${statusEmoji(line.status)} ${line.title} — *${line.status}*`;
          })
          .join('\n')}`
      : 'All test executions passed successfully.';

  const disclaimer =
    'Important: Not all failed tests indicate a software defect. Some failures can be caused by temporary environment issues, slow response times, network instability, third-party outages, or test runner constraints and may require a rerun to confirm.';

  return (
    `*Automation Regression Tests*\n\n` +
    formatReportLine(reportLink) +
    `Project: *${projectCode}*\n` +
    `Date: *${formatRunDateDenmarkWithWeek()}*\n` +
    `Browsers: Chrome, Edge, Firefox, Safari, Mobile(webkit)\n\n` +
    `*Status:* ${statusText}\n` +
    `*Result:* ${passed}/${totalExecutions} test executions passed — ${passRate}%\n\n` +
    `*Test status overview:*\n` +
    `✅ Passed: *${counts.passed}*\n` +
    `❌ Failed: *${counts.failed}*\n` +
    `⚠️ Flaky: *${counts.flaky}*\n` +
    `↪️ Skipped: *${counts.skipped}*\n` +
    `⛔ Blocked: *${counts.blocked}*\n\n` +
    `Unique Qase test cases grouped for attention: *${uniqueCaseCount}*\n\n` +
    `_${disclaimer}_\n\n` +
    attentionSummary
  );
}

/* ---------------- PROCESSING ---------------- */

const processingByRunId = new Map();

async function processRunCompleted(projectCode, runId) {
  if (processingByRunId.has(runId)) {
    log(`[QASE] Run ${runId} already processing. Ignoring duplicate run.completed.`);
    return processingByRunId.get(runId);
  }

  const processingPromise = (async () => {
    const privateRunLink = `https://app.qase.io/run/${projectCode}/dashboard/${runId}`;
    let qaseReportLink = privateRunLink;

    log(`[QASE] Run completed: ${runId}`);

    const publicRunLink = await makeRunPublic(projectCode, runId).catch((err) => {
      log(`[QASE] Failed to make run public: ${err.message}`);
      return null;
    });

    if (publicRunLink) {
      qaseReportLink = publicRunLink;
      log(`[QASE] Public report link: ${publicRunLink}`);
    } else {
      log(`[QASE] Falling back to private run link: ${privateRunLink}`);
    }

    const runMeta = await fetchRunMeta(runId).catch((err) => {
      log(`[QASE] Failed to fetch run meta: ${err.message}`);
      return null;
    });

    let startedAtUnix = 0;

    if (runMeta?.start_time && typeof runMeta.start_time === 'string') {
      const ms = Date.parse(runMeta.start_time);

      if (Number.isFinite(ms)) {
        startedAtUnix = Math.floor(ms / 1000);
      }
    } else {
      startedAtUnix = Number(runMeta?.created) || Number(runMeta?.created_at) || 0;
    }

    const runCases = Array.isArray(runMeta?.cases) ? runMeta.cases : [];
    const caseMap = new Map();

    for (const c of runCases) {
      const caseId = Number(c?.case_id ?? c?.id ?? c?.case?.id);

      if (!Number.isFinite(caseId) || caseId <= 0) {
        continue;
      }

      const title =
        typeof c?.title === 'string' && c.title.trim()
          ? c.title.trim()
          : typeof c?.case?.title === 'string' && c.case.title.trim()
            ? c.case.title.trim()
            : null;

      const status = normalizeStatus(c?.status ?? c?.status_id ?? c?.result ?? c?.state);

      caseMap.set(caseId, {
        title,
        status,
      });
    }

    const results = await fetchResultsForRunStrict(runId, startedAtUnix, {
      limit: 100,
      maxPages: 30,
      maxAttempts: 30,
      waitMs: 10000,
    });

    if (!results.length) {
      log(`[QASE] No results returned for run ${runId}. Slack notification skipped.`);

      return;
    }

    const aggregated = new Map();
    const executionStatuses = [];

    for (const result of results) {
      const caseId = extractCaseId(result);

      let status = normalizeStatus(
        result?.status ??
          result?.status_id ??
          result?.statusId ??
          result?.result ??
          result?.state
      );

      const isFlaky = inferFlakyFromResult(result);

      if (isFlaky) {
        status = STATUS.PASSED;
      } else if (status === STATUS.INVALID && inferFailedFromResult(result)) {
        status = STATUS.FAILED;
      }

      if (caseId && caseMap.has(caseId)) {
        const caseStatus = caseMap.get(caseId)?.status;

        if (isFlaky) {
          status = STATUS.PASSED;
        } else if (caseStatus && caseStatus !== STATUS.INVALID && status !== STATUS.PASSED) {
          status = caseStatus;
        }

        if (status === STATUS.INVALID && caseStatus === STATUS.FAILED) {
          status = STATUS.FAILED;
        }
      }

      executionStatuses.push(status);

      let title;

      if (caseId) {
        title = caseMap.get(caseId)?.title || null;

        if (!title || String(title).trim().toLowerCase().startsWith('case #')) {
          title = await fetchCaseTitle(caseId).catch(() => `Case #${caseId}`);
        }
      } else {
        title = bestTitleFromResult(result);
      }

      const urlFromTitle = snapshotIdToUrl(title);

      if (urlFromTitle) {
        title = formatVisualTitleFromUrl(urlFromTitle);
      }

      const titleWithSuffix = `${title}${resultSuffix(result)}`;
      const key = mergeKeyForResult(result);
      const existing = aggregated.get(key);

      if (!existing) {
        aggregated.set(key, {
          title: titleWithSuffix,
          status,
        });
      } else {
        aggregated.set(key, {
          title: pickBetterTitle(existing.title, titleWithSuffix),
          status: combineStatus(existing.status, status),
        });
      }
    }

    const lines = Array.from(aggregated.values());

    const order = {
      failed: 0,
      invalid: 1,
      blocked: 2,
      flaky: 3,
      skipped: 4,
      passed: 5,
    };

    lines.sort((a, b) => {
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    });

    const counts = countExecutionStatuses(executionStatuses);
    const totalExecutions = getCountsTotal(counts);
    const uniqueCaseCount = lines.length;

    log(
      `[QASE] Run ${runId} summary: executions=${totalExecutions}, uniqueCases=${uniqueCaseCount}, passed=${counts.passed}, failed=${counts.failed}, flaky=${counts.flaky}, skipped=${counts.skipped}, blocked=${counts.blocked}, invalid=${counts.invalid}`
    );

    const slackText = buildSlackMessage({
      projectCode,
      reportLink: qaseReportLink,
      counts,
      totalExecutions,
      uniqueCaseCount,
      lines,
    });

    await sendToSlack({
      text: slackText,
    });

    log(
      `[DONE] Run ${runId} processed. executions=${totalExecutions}, uniqueCases=${uniqueCaseCount}`
    );
  })();

  processingByRunId.set(runId, processingPromise);

  processingPromise.finally(() => {
    processingByRunId.delete(runId);
  });

  return processingPromise;
}

/* ---------------- ROUTES ---------------- */

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

      if (runId) {
        log(`[QASE] Run started: ${runId}`);
      }

      return res.status(200).json({
        ok: true,
        ignored: false,
        event: eventName,
      });
    }

    if (eventName !== 'run.completed') {
      return res.status(200).json({
        ok: true,
        ignored: true,
        event: eventName,
      });
    }

    const runId = req.body?.payload?.id;

    if (!runId) {
      log('[QASE] Missing payload.id / runId.');

      return res.status(400).json({
        ok: false,
        error: 'Missing payload.id / runId',
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

/* ---------------- LOCAL + EXPORT ---------------- */

if (require.main === module) {
  log(`SLACK_WEBHOOK_URL configured: ${Boolean(SLACK_WEBHOOK_URL)}`);
  log(`=== MIDDLEWARE VERSION: ${VERSION} ===`);
  log(`Middleware running on port ${PORT}`);

  const missing = missingEnvs();

  if (missing.length) {
    log(`[WARN] Missing env vars: ${missing.join(', ')}`);
  }

  app.listen(PORT, () => {
    log(`HTTP server listening on port ${PORT}`);
  });
}

module.exports = app;