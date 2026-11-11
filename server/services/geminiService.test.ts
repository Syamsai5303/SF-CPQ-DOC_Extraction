import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'x'.repeat(32);
process.env.ENCRYPTION_KEY ??= '0'.repeat(64);
process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
const { describeGeminiError, isModelSwitchable, parseGeminiError } = await import('./geminiService.ts');

// Error bodies exactly as returned by the Gemini API (Nov 2026).
const retired = new Error('{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.","status":"NOT_FOUND"}}');
const overloaded = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}');
const deadline = new Error('{"error":{"code":504,"message":"Deadline expired before operation could complete.","status":"DEADLINE_EXCEEDED"}}');
const badKey = new Error('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}');
const badRequest = new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}');

test('parses Google JSON errors', () => {
  assert.deepEqual(parseGeminiError(retired).code, 404);
  assert.equal(parseGeminiError(overloaded).status, 'UNAVAILABLE');
  assert.equal(parseGeminiError(new Error('socket hang up')).message, 'socket hang up');
});

test('retired, overloaded and timed-out models trigger a fallback; bad key / bad request do not', () => {
  assert.equal(isModelSwitchable(retired), true);
  assert.equal(isModelSwitchable(overloaded), true);
  assert.equal(isModelSwitchable(deadline), true);
  assert.equal(isModelSwitchable(badKey), false);
  assert.equal(isModelSwitchable(badRequest), false);
});

test("user-facing messages keep Google's explanation instead of a generic one", () => {
  assert.match(describeGeminiError(retired, 'gemini-2.5-flash'), /no longer available to new users/);
  assert.match(describeGeminiError(overloaded, 'gemini-3.8-flash'), /overloaded.*high demand/);
  assert.equal(describeGeminiError(badKey), 'Gemini rejected the API key. Check GEMINI_API_KEY.');
});
