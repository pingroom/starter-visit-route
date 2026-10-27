import { loadEnvironment, loadConnection, loadInput, loadConfig, routeDirectory } from './config.js';
import { makeClient } from './client.js';
import { connect } from './connect.js';
import { step, localReport } from './engine.js';
import { isId } from './model.js';

const controller = new AbortController();
const stop = () => controller.abort(new Error('Stopped.'));
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await loadEnvironment();
  const [command, argument, ...extra] = process.argv.slice(2);
  if (!['run', 'connect', 'inspect', 'preview', 'status', 'report', 'find', 'recover'].includes(command)
    || extra.length || argument !== undefined && command !== 'recover') throw new Error('Unexpected command or arguments.');
  if (command === 'recover' && !isId(argument)) throw new Error('Supply the exact lowercase Question UUID.');
  if (command === 'preview') { const input = await loadInput(); console.log(JSON.stringify({ routeId: input.routeId, depot: input.depot, stops: input.stops, costUnit: input.costUnit, travel: input.travel }, null, 2)); }
  else if (command === 'connect') await connect(controller.signal);
  else if (['status', 'report'].includes(command)) console.log(JSON.stringify(await localReport(routeDirectory, await loadInput(), { save: command === 'report' }), null, 2));
  else {
    const connection = await loadConnection();
    const client = makeClient({ token: connection.token, signal: controller.signal });
    if (command === 'inspect') {
      const rooms = await client.rooms.list();
      if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
      const room = rooms.find((entry) => entry?.invite_code === connection.room);
      if (!room || room.type !== 'standard' || room.is_public !== false || !Array.isArray(room.members) || room.members.length > 1000) throw new Error('Choose a granted standard private room with visible members.');
      console.log(JSON.stringify({ room: connection.room, people: room.members.filter((member) => isId(member?.user_id)).map((member) => ({ id: member.user_id, name: typeof member.user?.name === 'string' ? member.user.name.slice(0, 80) : null, role: member.role })) }, null, 2));
      console.log('Verify the intended person in the app. Copy their exact member UUID to config.json; names alone do not establish identity.');
    } else {
      const result = await step({ client, ...connection, directory: routeDirectory, input: await loadInput(), config: await loadConfig(),
        command, attachId: command === 'recover' ? argument : undefined, signal: controller.signal });
      console.log(JSON.stringify(result, null, 2));
      if (['expired', 'cancelled', 'invalid_answer'].includes(result.observedStatus) || ['incomplete', 'infeasible'].includes(result.status)) process.exitCode = 2;
      else if (['pending', 'ready'].includes(result.status)) process.exitCode = 3;
      else if (result.status === 'create_unknown') process.exitCode = 4;
    }
  }
} catch (error) {
  if (controller.signal.aborted) { console.log('Stopped. Keep saved state; creation may be uncertain. Run status before continuing.'); process.exitCode = 3; }
  else {
    const safeLocal = error instanceof Error && !('code' in error) && error.name === 'Error';
    console.error(safeLocal ? error.message : 'Operation failed. Check configuration, granted room/scopes, network, and private state. Raw API errors are suppressed.');
    process.exitCode = 1;
  }
} finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
