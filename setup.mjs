import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('.', import.meta.url));
const home = homedir();
const base = path.join(home, 'Library', 'Application Support', 'Rallumi Preview');
const install = path.join(base, 'install');
const tokenFile = path.join(base, 'connection');
const label = 'local.rallumi.preview';
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'));

if (process.argv[2] === 'health') {
  const token = readFileSync(tokenFile, 'utf8').trim();
  try {
    const response = await fetch('http://127.0.0.1:4321/api/health', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok || (await response.json()).app !== 'rallumi-preview') process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
} else {
  const codex = process.argv[2];
  if (!codex || !path.isAbsolute(codex)) throw Error('缺少本机 Codex 路径');

  const paths = {
    ROOM_WORKSPACE: path.join(base, 'workspace'),
    ROOM_DATA: path.join(base, 'data'),
    ROOM_CODEX: codex,
    ROOM_PORT: '4321',
    RALLUMI_TOKEN_FILE: tokenFile,
    CODEX_HOME: codexHome,
    HOME: home,
    LANG: 'en_US.UTF-8',
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
  };
  for (const directory of [base, install, paths.ROOM_WORKSPACE, paths.ROOM_DATA]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(tokenFile)) {
    try {
      writeFileSync(tokenFile, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  for (const entry of ['.agents', 'plugins', 'service']) {
    cpSync(path.join(source, entry), path.join(install, entry), { recursive: true });
  }
  const plugin = path.join(install, 'plugins', 'rallumi');
  const config = {
    mcpServers: {
      rallumi: {
        command: process.execPath,
        args: [path.join(plugin, 'server.mjs')],
        env: { RALLUMI_TOKEN_FILE: tokenFile }
      }
    }
  };
  atomicWrite(path.join(plugin, '.mcp.json'), JSON.stringify(config, null, 2) + '\n');
  const agents = path.join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const string = value => '<string>' + xml(value) + '</string>';
  const env = Object.entries(paths).map(([key,value]) => '<key>' + key + '</key>' + string(value));
  const program = [process.execPath, path.join(install, 'service', 'server.mjs')].map(string);
  atomicWrite(path.join(agents, label + '.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key><array>${program.join('')}</array>
  <key>WorkingDirectory</key>${string(paths.ROOM_WORKSPACE)}
  <key>EnvironmentVariables</key><dict>${env.join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${string(path.join(base, 'service.log'))}
  <key>StandardErrorPath</key>${string(path.join(base, 'service-error.log'))}
</dict></plist>
`);
}

function atomicWrite(destination, data) {
  const temporary = destination + '.' + process.pid + '.tmp';
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, destination);
}
