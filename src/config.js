import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readText, readJson } from './storage.js';
import { ROOM, validateInput, validateConfig } from './model.js';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const credentialDirectory = join(root, '.pingroom');
export const routeDirectory = join(root, '.route');

export async function loadEnvironment(env = process.env, path = join(root, '.env')) {
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) return;
  const text = await readText(path, 16384);
  if (text !== null) for (const [key, value] of Object.entries(parseEnv(text))) if (env[key] === undefined) env[key] = value;
}
export function validateConnection(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.token !== 'string'
    || !/^[^\s\x00-\x1f\x7f]{1,8192}$/.test(raw.token) || typeof raw.room !== 'string' || !ROOM.test(raw.room.toUpperCase())) throw new Error('Set a complete PINGROOM_TOKEN and PINGROOM_ROOM pair, or connect first.');
  return { token: raw.token, room: raw.room.toUpperCase() };
}
export async function loadConnection(directory = credentialDirectory, env = process.env) {
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) return validateConnection({ token: env.PINGROOM_TOKEN, room: env.PINGROOM_ROOM });
  return validateConnection(await readJson(join(directory, 'credentials.json'), 32768));
}
export async function loadInput() {
  const input = await readJson(join(root, 'route.json'), 65536);
  if (input === null) throw new Error('Copy examples/route.json to route.json, then adapt it before starting.');
  return validateInput(input);
}
export async function loadConfig() {
  const config = await readJson(join(root, 'config.json'), 16384);
  if (config === null) throw new Error('Copy config.example.json to config.json and set the participant UUID.');
  return validateConfig(config);
}
