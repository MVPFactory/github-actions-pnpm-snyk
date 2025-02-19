import { NpmPackageLock } from './processPnpmLockfile';

import * as writeFileAtomic from 'write-file-atomic';

export async function writeNpmPackageLock(packageLock: NpmPackageLock, filename: string) {
  const json = JSON.stringify(packageLock, null, 4);
  await writeFileAtomic(filename, json, (err?: Error) => { if (err) { throw err; } });
}
