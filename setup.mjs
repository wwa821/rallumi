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
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(home, '.codex'));

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
      env: paths
    }
  }
};
atomicWrite(path.join(plugin, '.mcp.json'), JSON.stringify(config, null, 2) + '\n');
function atomicWrite(destination, data) {
  const temporary = destination + '.' + process.pid + '.tmp';
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, destination);
}
