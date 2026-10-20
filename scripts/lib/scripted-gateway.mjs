import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { URL } from 'node:url';

/**
 * A deterministic stand-in for the BharatCode endpoint, over the real wire.
 *
 * The qualification this serves has to exercise the production CLI as a child
 * process, so the model is replaced below the process boundary rather than
 * inside it: the CLI is configured with `BHARATCODE_API_BASE` pointing here, and
 * every request travels through the same HTTP adapter, JSON parsing, schema
 * validation and retry policy a live gateway would meet. Nothing here is
 * injected into the product's process, and no answer is a MergeSutra-owned
 * verdict — the answers are what a model said, and every one of them still has
 * to pass the product's own refusals.
 *
 * The other half of the honesty: this file makes the *workflow* deterministic.
 * Which files get written and what a check command is asked for is scripted
 * here, so the run does not depend on a live model's mood. It buys repeatability,
 * not real-model quality — the model's own competence is issue #35, and no
 * conclusion about it may be drawn from these transcripts.
 */

const FILE_HEADER = /=== FILE (\S+)(?: \(truncated\))? —[^\n]*===/g;
const DIGEST_LINE = /sha256 of the whole file as it is on disk now: ([0-9a-f]{64})/g;

/**
 * The digest the product offered for one path, as the last one it offered.
 *
 * A `WRITE_FILE` must replace the exact bytes that were read, so a scripted
 * answer takes its precondition from the transcript the same way a model has to:
 * by reading the `FILE <path>` section and copying the digest printed under it.
 * A file whose section carried no digest (a truncated read) yields `undefined`,
 * and the caller must send a read instead of a write — there is no way to guess
 * a whole-file digest, and the product refuses a write without one.
 */
export function digestForPath(messages, wantedPath) {
  let digest;
  for (const message of messages) {
    const text = typeof message?.content === 'string' ? message.content : '';
    const headers = [...text.matchAll(FILE_HEADER)].map((match) => ({
      index: match.index ?? 0,
      path: match[1],
    }));
    for (const match of text.matchAll(DIGEST_LINE)) {
      const index = match.index ?? 0;
      const owner = headers.filter((header) => header.index < index).pop();
      if (owner?.path === wantedPath) digest = match[1];
    }
  }
  return digest;
}

/**
 * Start the gateway. `respond(messages, callIndex)` returns the assistant text
 * for one `/chat/completions` request; returning `undefined` means the script ran
 * out, which is answered with a 500 rather than an invented completion.
 */
export async function startScriptedGateway({ model, respond, onCall } = {}) {
  const calls = [];
  let exhausted = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/models') {
      writeJson(res, 200, { object: 'list', data: [{ id: model, object: 'model' }] });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/chat/completions') {
      writeJson(res, 404, { error: { message: `unexpected ${req.method} ${url.pathname}` } });
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 8_000_000) req.destroy();
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        writeJson(res, 400, { error: { message: 'request body was not JSON' } });
        return;
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const index = calls.length;
      calls.push({ model: payload.model, messages, temperature: payload.temperature });
      let text;
      try {
        text = respond ? respond(messages, index) : undefined;
      } catch (error) {
        writeJson(res, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
        return;
      }
      if (typeof text !== 'string') {
        exhausted += 1;
        writeJson(res, 500, {
          error: {
            message: `scripted gateway has no answer for call ${String(index)} (this is a harness fault, not a product one)`,
          },
        });
        return;
      }
      onCall?.(index, text);
      writeJson(res, 200, {
        id: `scripted-${String(index)}`,
        object: 'chat.completion',
        model: payload.model ?? model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  return {
    baseUrl,
    calls,
    get exhausted() {
      return exhausted;
    },
    async close() {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    },
  };
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}
