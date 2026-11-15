import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { coachContext, runTool } from '../src/coach.ts';
import { emptyState, generate } from '../src/engine/plan.ts';

const TODAY = '2026-11-11';
// A fake Claude API: first request answers with thinking + a move_session tool call, the second with text.
const claude = { requests: [] as any[], headers: [] as any[], fail: 0 };
let fake: Server, app: Server, base: string, dir: string;

before(async () => {
  fake = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    claude.requests.push(body);
    claude.headers.push(req.headers);
    const send = (code: number, data: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (claude.fail) { claude.fail = 0; return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }); }
    const msg = (content: unknown[], stop_reason: string) => send(200, {
      id: `msg_${claude.requests.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const last = body.messages.at(-1);
    const isToolResult = Array.isArray(last.content) && last.content[0]?.type === 'tool_result';
    if (isToolResult) return msg([{ type: 'text', text: 'Moved your long ride to Sunday.' }], 'end_turn');
    const ctx: string = last.content[0].text;
    const id = /id (\S+) \| bike \| Long ride/.exec(ctx)?.[1];
    return msg([
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'text', text: 'Shifting it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'move_session', input: { id, date: '2026-11-15' } },
    ], 'tool_use');
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  delete process.env.ANTHROPIC_API_KEY;
  dir = mkdtempSync(join(tmpdir(), 'tri-coach-'));
  const { createApp } = await import('../src/server.ts');
  app = createApp({ dataDir: dir, today: () => TODAY }).server;
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
after(() => { app.close(); fake.close(); rmSync(dir, { recursive: true, force: true }); });

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() as any };
};

test('coach needs a key, then answers, edits the plan through tools and replays history unchanged', async () => {
  await api('POST', '/api/plan/generate', {});
  assert.equal((await api('POST', '/api/coach', { message: 'hi' })).status, 400);
  await api('PUT', '/api/coach/key', { apiKey: 'sk-test' });
  let { data } = await api('GET', '/api/state');
  assert.equal(data.coach.configured, true);
  assert.ok(!JSON.stringify(data).includes('sk-test'));
  const ride = data.sessions.find((x: any) => x.workout.name === 'Long ride');
  assert.equal(ride.date, '2026-11-14');

  const r = await api('POST', '/api/coach', { message: 'Move my long ride to Sunday please' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.reply, 'Shifting it.\n\nMoved your long ride to Sunday.');
  assert.equal(r.data.changes.length, 1);
  assert.match(r.data.changes[0], /Moved “Long ride” from Sat 2026-11-14 to Sun 2026-11-15/);

  const [first, second] = claude.requests;
  assert.equal(first.model, 'claude-opus-5-5');
  assert.equal(first.fallbacks, 'default');
  assert.deepEqual(first.output_config, { effort: 'medium' });
  assert.match(String(claude.headers[0]['anthropic-beta']), /server-side-fallback-2026-07-01/);
  assert.equal(claude.headers[0].authorization, 'Bearer sk-test');
  assert.ok(first.tools.some((t: any) => t.name === 'replace_workout'));
  assert.match(first.messages[0].content[0].text, /^<context>\nToday: Wed 2026-11-11/);
  assert.equal(first.messages[0].content[1].text, 'Move my long ride to Sunday please');
  // second request: assistant turn replayed verbatim (thinking block + signature), then the tool result
  assert.deepEqual(second.messages[1].content[0], { type: 'thinking', thinking: '', signature: 'sig-abc' });
  assert.equal(second.messages[2].content[0].type, 'tool_result');
  assert.equal(second.messages[2].content[0].tool_use_id, 'toolu_1');

  data = (await api('GET', '/api/state')).data;
  const moved = data.sessions.find((x: any) => x.id === ride.id);
  assert.equal(moved.date, '2026-11-15');
  assert.equal(moved.locked, true);
  assert.deepEqual(data.coach.messages, [
    { role: 'user', text: 'Move my long ride to Sunday please' },
    { role: 'assistant', text: 'Shifting it.\n\nMoved your long ride to Sunday.' },
  ]);
});

test('a rejected key gives a clear error and leaves the conversation untouched; reset clears it', async () => {
  claude.fail = 1;
  const r = await api('POST', '/api/coach', { message: 'why threshold tomorrow?' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /rejected the API key/);
  assert.equal((await api('GET', '/api/state')).data.coach.messages.length, 2);
  await api('DELETE', '/api/coach');
  assert.equal((await api('GET', '/api/state')).data.coach.messages.length, 0);
});

test('coach tools: replace, add, skip, availability + replan, and helpful errors', () => {
  const s = emptyState();
  s.profile = { ...s.profile, ftp: 280, runPower: 340, cssSecPer100: 92 };
  generate(s, TODAY);
  const ctx = coachContext(s, TODAY);
  assert.match(ctx, /bike FTP 280 W/);
  assert.match(ctx, /Sessions 2026-11-09 to 2026-11-22:/);
  const changes: string[] = [];
  const target = s.sessions.find((x) => x.sport === 'bike' && x.date > TODAY)!;
  const out = runTool(s, TODAY, 'replace_workout', { id: target.id, reason: 'legs are fresh', workout: { sport: 'bike', name: '4x8 threshold', blocks: [
    { name: 'Warm-up', repeat: 1, steps: [{ kind: 'warmup', secs: 900, lo: 0.5, hi: 0.75, ramp: true }] },
    { name: 'Threshold', repeat: 4, steps: [{ kind: 'work', secs: 480, lo: 0.97, hi: 1.02 }, { kind: 'recovery', secs: 180, lo: 0.5, hi: 0.55 }] },
    { name: 'Cool-down', repeat: 1, steps: [{ kind: 'cooldown', secs: 480, lo: 0.45, hi: 0.55 }] },
  ] } }, changes);
  assert.match(out, /Threshold 4x\n- 8m 97-102%/);
  assert.equal(target.workout.name, '4x8 threshold');
  assert.equal(target.workout.durationMin, 67);
  assert.equal(target.locked, true);
  assert.match(target.adaptedNote!, /legs are fresh/);
  assert.match(runTool(s, TODAY, 'get_sessions', { from: target.date, to: target.date, detail: true }, changes), /4x8 threshold/);
  runTool(s, TODAY, 'skip_session', { id: target.id }, changes);
  assert.equal(target.status, 'skipped');
  runTool(s, TODAY, 'set_day_availability', { date: '2026-11-18', minutes: 0, note: 'travel' }, changes);
  runTool(s, TODAY, 'replan', { scope: 'future' }, changes);
  assert.ok(!s.sessions.some((x) => x.date === '2026-11-18'), 'replanned around the unavailable day');
  assert.equal(changes.length, 4);
  assert.throws(() => runTool(s, TODAY, 'move_session', { id: 'nope', date: '2026-11-20' }, changes), /No session with id/);
  assert.throws(() => runTool(s, TODAY, 'move_session', { id: target.id, date: 'Sunday' }, changes), /ISO date/);
  assert.match(runTool(s, TODAY, 'get_history', { from: '2020-01-01', to: TODAY }, changes), /No imported activities/);
});
