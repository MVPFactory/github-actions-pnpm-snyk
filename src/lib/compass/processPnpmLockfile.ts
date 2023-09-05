import { ResolvedDependencies, PackageSnapshots } from "@pnpm/lockfile-file";
import { DEPENDENCIES_FIELDS } from "@pnpm/types";
import readYamlFile from "read-yaml-file";

interface PnpmPackageLock {
  dependencies?: ResolvedDependencies;
  devDependencies?: ResolvedDependencies;
  optionalDependencies?: ResolvedDependencies;
  lockfileVersion: number;
  packages: PackageSnapshots;
  specifiers: ResolvedDependencies;
}

export interface NpmPackageLock {
  requires?: boolean;
  lockfileVersion: number;
  dependencies: NpmLockedPackageDependencyMap;
}

export interface NpmLockedPackageDependency {
  version?: string;
  resolved?: string;
  from?: string;
  integrity?: string;
  dev?: boolean;
  requires?: NpmLockedPackageRequiresMap;
  dependencies?: NpmLockedPackageSubDependencyMap;
}

export interface NpmLockedPackageDependencyMap {
  [name: string]: NpmLockedPackageDependency;
}

export interface NpmLockedPackageRequiresMap {
  [name: string]: string;
}

export interface NpmLockedPackageSubDependency {
  version: string;
  resolved?: string;
  integrity?: string;
}

export interface NpmLockedPackageSubDependencyMap {
  [name: string]: NpmLockedPackageSubDependency;
}

enum PnpmPackageDescType {
  Version,
  Github,
  Uri,
}

interface PnpmPackageDesc {
  type: PnpmPackageDescType;
  fullName: string;
  name: string;
  version: string;
  extra?: string;
}

export async function processPnpmLockfile(
  lockfilePath: string
): Promise<NpmPackageLock> {
  const lockfile = await readPnpmLockfile(lockfilePath);
  if (lockfile === null) {
    throw new Error(`Failed to load pnpm lock file ${lockfilePath}`);
  }

  return processLockfile(lockfile);
}

async function readPnpmLockfile(
  lockfilePath: string
): Promise<PnpmPackageLock | null> {
  try {
    return await readYamlFile<PnpmPackageLock>(lockfilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return null;
  }
}

function getGithubPackageDesc(uri: string): PnpmPackageDesc {
  const result = /^github.com\/([^/]+\/([^/]+))\/([0-9a-f]{40})$/.exec(uri);
  if (result === null) {
    throw new Error(`Error parsing github URI ${uri}`);
  }
  const versionUri = `github:${result[1]}#${result[3]}`;
  const name = result[2];
  return {
    type: PnpmPackageDescType.Github,
    fullName: uri,
    name,
    version: versionUri,
  };
}

// Package names look like:
//   /@pnpm/error/1.0.0
//   /@pnpm/lockfile-file/1.1.3_@pnpm+logger@2.1.1
//   /@emotion/core/10.0.14_react@16.8.6
//   /@uc/modal-loader/0.7.1_2eb23211954108c6f87c7fe8e90d1312
//   npm.example.com/axios/0.19.0
//   npm.example.com/@sentry/node/5.1.0_@other@1.2.3
//   github.com/LewisArdern/eslint-plugin-angularjs-security-rules/41da01727c87119bd523e69e22af2d04ab558ec9
function getPathPackageDesc(fullName: string): PnpmPackageDesc {
  if (!fullName.startsWith("github.com/")) {
    const result = /^[^/]*\/((?:@[^/]+\/)?[^/]+)\/(.*)$/.exec(fullName);
    if (result === null) {
      throw new Error(`Error parsing package name ${fullName}`);
    }

    let type;
    if (fullName.startsWith("/")) {
      type = PnpmPackageDescType.Version;
    } else {
      type = PnpmPackageDescType.Uri;
    }

    const name = result[1];
    const version = result[2];
    let versionNumber;
    let extra;
    const firstUnderscore = version.indexOf("_");
    if (firstUnderscore !== -1) {
      versionNumber = version.substr(0, firstUnderscore);
      extra = version.substr(firstUnderscore + 1);
    } else {
      versionNumber = version;
    }
    return { type, fullName: fullName, name, version: versionNumber, extra };
  } else {
    return getGithubPackageDesc(fullName);
  }
}

// A package in the 'dependencies' section of the lockfile
function getDependencyPackageDesc(
  name: string,
  version: string
): PnpmPackageDesc {
  if (/^\d/.test(version)) {
    return getPathPackageDesc(["", name, version].join("/"));
  } else {
    return getPathPackageDesc(version);
  }
}

function getPackage(
  lockfile: PnpmPackageLock,
  packageDesc: PnpmPackageDesc,
  remove: boolean
): NpmLockedPackageDependency {
  const snapshot = lockfile.packages?.[packageDesc.fullName];
  if (snapshot === undefined) {
    throw new Error(`Failed to lookup ${packageDesc.fullName} in packages`);
  }

  let dep: NpmLockedPackageDependency;
  dep = { version: packageDesc.version };

  if (
    packageDesc.type === PnpmPackageDescType.Github &&
    snapshot.name !== undefined
  ) {
    if (lockfile.specifiers[snapshot.name] !== undefined) {
      dep.from = lockfile.specifiers[snapshot.name];
    }
  }

  if ("integrity" in snapshot.resolution) {
    dep.integrity = snapshot.resolution.integrity;
  }

  if (snapshot.dependencies !== undefined) {
    dep.requires = snapshot.dependencies;
  }

  if (snapshot.dev === true) {
    dep.dev = snapshot.dev;
  }

  if (remove) {
    delete lockfile.packages[packageDesc.fullName];
  }
  return dep;
}

function getSubDependencyFromDependency(
  dep: NpmLockedPackageDependency
): NpmLockedPackageSubDependency {
  const subDep = { version: dep.version } as NpmLockedPackageSubDependency;
  if (dep.resolved !== undefined) {
    subDep.resolved = dep.resolved;
  }
  if (dep.integrity !== undefined) {
    subDep.integrity = dep.integrity;
  }
  return subDep;
}

function processLockfile(lockfile: PnpmPackageLock): NpmPackageLock {
  const deps = {} as NpmLockedPackageDependencyMap;
  const subdeps = {} as NpmLockedPackageDependencyMap;

  // establish precedence of direct dependencies that would exist in node_modules root
  for (const depType of DEPENDENCIES_FIELDS) {
    let depsMap = lockfile[depType];
    if (depsMap !== undefined) {
      for (const [name, version] of Object.entries(depsMap)) {
        const packageDesc = getDependencyPackageDesc(name, version);
        deps[packageDesc.name] = getPackage(lockfile, packageDesc, true);
      }
    }
  }

  // process remaining packages, which must be secondary dependencies
  for (const [key, _] of Object.entries(lockfile.packages)) {
    const packageDesc = getPathPackageDesc(key);
    const pkg = getPackage(lockfile, packageDesc, false);
    if (deps[packageDesc.name] !== undefined) {
      subdeps[packageDesc.fullName] = pkg;
    } else {
      deps[packageDesc.name] = pkg;
    }
  }

  // add required subdependencies from the 'requires' of dependencies
  for (const [key, val] of Object.entries(deps)) {
    if (val.requires !== undefined) {
      for (let [name, version] of Object.entries(val.requires)) {
        const packageDesc = getDependencyPackageDesc(name, version);
        // secondary dependencies are declared in the 'dependencies' of a package
        if (packageDesc.fullName in subdeps) {
          const dep = subdeps[packageDesc.fullName];
          if (val.dependencies === undefined) {
            val.dependencies = {};
          }
          val.dependencies[name] = getSubDependencyFromDependency(dep);
        } else {
          const dep = deps[name];
          if (dep.version !== packageDesc.version) {
            throw new Error(
              `Failed to lookup ${packageDesc.fullName} in dependencies; used by ${key}`
            );
          }
        }

        // remove any extraneous info from the name in 'requires'
        if (
          packageDesc.extra !== undefined ||
          packageDesc.type === PnpmPackageDescType.Uri
        ) {
          val.requires[name] = packageDesc.version;
        }
      }
    }
  }
  return { requires: true, lockfileVersion: 1, dependencies: deps };
}
