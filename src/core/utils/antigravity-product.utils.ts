import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type AntigravityProductId = 'antigravity-ide' | 'antigravity';

export interface AntigravityProduct {
  id: AntigravityProductId;
  displayName: string;
  executablePath?: string;
  processName: string;
  dataPath: string;
  stateDbPath: string;
  storageJsonPath: string;
}

interface ProductDefinition {
  id: AntigravityProductId;
  displayName: string;
  processName: string;
  dataPath: string;
  executableCandidates: string[];
  storageJsonRelativePath: string[];
}

/** Resolves one coherent product identity for every account-switch operation. */
export function detectAntigravityProduct(): AntigravityProduct {
  const definitions = getProductDefinitions();
  const currentExe = normalizePath(process.execPath);
  const currentProduct = definitions.find(definition =>
    definition.executableCandidates.some(candidate => normalizePath(candidate) === currentExe)
    || path.basename(process.execPath).toLowerCase() === definition.processName.toLowerCase()
  );

  if (currentProduct) {
    return materialize(currentProduct, findExecutable(currentProduct) || process.execPath);
  }

  const installedWithData = definitions.find(definition =>
    !!findExecutable(definition) && fs.existsSync(getStateDbPath(definition))
  );
  if (installedWithData) {
    return materialize(installedWithData, findExecutable(installedWithData));
  }

  const installed = definitions.find(definition => !!findExecutable(definition));
  if (installed) {
    return materialize(installed, findExecutable(installed));
  }

  const withData = definitions.find(definition => fs.existsSync(getStateDbPath(definition)));
  return materialize(withData || definitions[0]);
}

function getProductDefinitions(): ProductDefinition[] {
  const homeDir = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    return [
      {
        id: 'antigravity-ide', displayName: 'Antigravity IDE', processName: 'Antigravity IDE.exe',
        dataPath: path.join(appData, 'Antigravity IDE'),
        executableCandidates: [
          path.join(localAppData, 'Programs', 'Antigravity IDE', 'Antigravity IDE.exe'),
          path.join(programFiles, 'Antigravity IDE', 'Antigravity IDE.exe'),
        ],
        storageJsonRelativePath: ['User', 'globalStorage', 'storage.json'],
      },
      {
        id: 'antigravity', displayName: 'Antigravity', processName: 'Antigravity.exe',
        dataPath: path.join(appData, 'Antigravity'),
        executableCandidates: [
          path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
          path.join(programFiles, 'Antigravity', 'Antigravity.exe'),
        ],
        storageJsonRelativePath: ['storage.json'],
      },
    ];
  }

  if (process.platform === 'darwin') {
    return [{
      id: 'antigravity', displayName: 'Antigravity', processName: 'Antigravity',
      dataPath: path.join(homeDir, 'Library', 'Application Support', 'Antigravity'),
      executableCandidates: ['/Applications/Antigravity.app/Contents/MacOS/Antigravity'],
      storageJsonRelativePath: ['storage.json'],
    }];
  }

  const configHome = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  return [{
    id: 'antigravity', displayName: 'Antigravity', processName: 'Antigravity',
    dataPath: path.join(configHome, 'Antigravity'), executableCandidates: [],
    storageJsonRelativePath: ['storage.json'],
  }];
}

function materialize(definition: ProductDefinition, executablePath?: string): AntigravityProduct {
  return {
    id: definition.id,
    displayName: definition.displayName,
    executablePath,
    processName: definition.processName,
    dataPath: definition.dataPath,
    stateDbPath: getStateDbPath(definition),
    storageJsonPath: path.join(definition.dataPath, ...definition.storageJsonRelativePath),
  };
}

function getStateDbPath(definition: ProductDefinition): string {
  return path.join(definition.dataPath, 'User', 'globalStorage', 'state.vscdb');
}

function findExecutable(definition: ProductDefinition): string | undefined {
  return definition.executableCandidates.find(candidate => fs.existsSync(candidate));
}

function normalizePath(value: string): string {
  return path.resolve(value).toLowerCase();
}
