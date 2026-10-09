/** Runs inside the packaged renderer to exercise the signed PTY helper and
 * IPC-supplied connection without accessing a user's agent account. */
export const packagedTerminalSmokeExpression = `
(async () => {
  const connection = await window.openpond.getConnection();
  const url = new URL('/v1/terminal', connection.serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = btoa(String.fromCharCode(...new TextEncoder().encode(connection.token)))
    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  const socket = new WebSocket(url, ['openpond-terminal', 'openpond-token.' + token]);
  const terminalId = 'packaged-terminal-' + crypto.randomUUID();
  const marker = 'OPENPOND_PTY_SMOKE_COMPLETE';
  const command = connection.platform === 'win32' ? "Write-Output '" + marker + "'" : 'echo ' + marker;
  return new Promise((resolve, reject) => {
    let spawned = false;
    let output = '';
    let completed = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'kill', terminalId }));
      socket.close();
    };
    const fail = message => { cleanup(); reject(new Error(message)); };
    const timer = setTimeout(() => fail('Packaged terminal did not execute its setup command'), 15000);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'start', terminalId, scope: { kind: 'draft', id: terminalId }, cols: 100, rows: 24 }));
    socket.onerror = () => fail('Packaged terminal WebSocket failed');
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        spawned = true;
        socket.send(JSON.stringify({ type: 'input', terminalId, data: command + '\\n', waitForPrompt: true }));
      }
      if (message.type === 'output') output += message.data;
      if (message.type === 'error') return fail(message.message);
      if (message.type === 'exit' && !completed) return fail('Packaged terminal exited before its command completed');
      if (message.type === 'command_end') {
        if (message.exitCode !== 0) return fail('Packaged terminal setup command failed');
        completed = true;
      }
      // PowerShell currently has no shell-integration command_end event.
      if (connection.platform === 'win32' && output.includes('\\r\\n' + marker + '\\r\\n')) completed = true;
      if (completed && output.split(/\\r?\\n/).some(line => line.trim() === marker)) {
        cleanup();
        resolve({ spawned, commandCompleted: true, outputReceived: true });
      }
    };
  });
})()
`;
