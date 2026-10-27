import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { makeClient } from './client.js';
import { readJson, atomicJson, acquireLock } from './storage.js';
import { credentialDirectory, validateConnection } from './config.js';

export async function connect(signal) {
  const release = await acquireLock(credentialDirectory);
  try {
    signal?.throwIfAborted();
    if (await readJson(join(credentialDirectory, 'credentials.json'), 32768) !== null) throw new Error('Saved connection already exists. Keep it to resume visit routing; archive deliberately before reconnecting.');
    const client = makeClient({ signal, pairing: true });
    let pending = await readJson(join(credentialDirectory, 'pairing.json'), 65536);
    if (pending?.phase === 'creating') throw new Error('Pairing creation is uncertain. Keep .pingroom/pairing.json and inspect Connected Agents. Resolve or revoke any created robot before archiving this file for an intentional new setup.');
    if (pending === null) {
      const createdAt = Date.now();
      // A lost registration or pairing response does not prove creation failed.
      // Persist intent before either POST, and never replay that intent.
      await atomicJson(credentialDirectory, 'pairing.json', { phase: 'creating', createdAt }, 65536);
      signal?.throwIfAborted();
      const pairing = await client.auth.startPairing({ agent_label: 'Visit route' });
      pending = { pairing, token: client.getToken(), createdAt };
      await atomicJson(credentialDirectory, 'pairing.json', pending, 65536);
    }
    if (typeof pending.token !== 'string' || !pending.token || !Number.isSafeInteger(pending.createdAt)
      || !Number.isInteger(pending.pairing?.expires_in) || pending.pairing.expires_in < 1 || pending.pairing.expires_in > 3600) throw new Error('Saved pairing is malformed; inspect it before reconnecting.');
    const remaining = Math.min(pending.pairing.expires_in, Math.floor((pending.createdAt + pending.pairing.expires_in * 1000 - Date.now()) / 1000));
    if (remaining <= 0) throw new Error('Saved pairing expired. Resolve or revoke the old robot in Connected Agents and confirm it is no longer usable before archiving only .pingroom/pairing.json for an intentional new setup.');
    const url = new URL(pending.pairing.pair_browser_url ?? pending.pairing.pair_url);
    if (!['https://pingroom.io', 'https://api.pingroom.io'].includes(url.origin) || url.username || url.password) throw new Error('Unexpected pairing URL.');
    client.setToken(pending.token);
    console.log('Install PingRoom: https://pingroom.io/i');
    console.log(`Approve this connection and choose the participant's private room: ${url.href}`);
    const approved = await client.auth.waitForPairing({ ...pending.pairing, expires_in: remaining }, { signal });
    const connection = validateConnection({ token: approved.credential, room: (approved.home_room ?? approved.room)?.invite_code });
    await atomicJson(credentialDirectory, 'credentials.json', connection, 32768);
    await rm(join(credentialDirectory, 'pairing.json'));
    console.log('Saved private connection. Run npm run inspect to identify the participant.');
  } finally { await release(); }
}
