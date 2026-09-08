import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Storage {
  home: string;
  indexDb: string;
  configJson: string;
  logsDir: string;
  projectDir(projectId: string): string;
  memoriesDir(projectId: string): string;
  memoryFile(projectId: string, name: string): string;
  memoryIndexMd(projectId: string): string;
}

export function resolveStorage(): Storage {
  const home = process.env.LTM_HOME ?? join(homedir(), '.long-term-memory');
  return {
    home,
    indexDb: join(home, 'index.db'),
    configJson: join(home, 'config.json'),
    logsDir: join(home, 'logs'),
    projectDir: (projectId) => join(home, 'projects', projectId),
    memoriesDir: (projectId) => join(home, 'projects', projectId, 'memories'),
    memoryFile: (projectId, name) => join(home, 'projects', projectId, 'memories', `${name}.md`),
    memoryIndexMd: (projectId) => join(home, 'projects', projectId, 'MEMORY.md'),
  };
}
