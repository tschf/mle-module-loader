/**
 * Object details that process a module.
 *
 */
export type ProcessModuleDetails = {
  moduleName: string,
  originalModuleName: string,
  moduleVersion: string,
  modulePath?: string,
  outputPath: string,
  packageList: string[],
  moduleStorageTableName: string,
  createStatements: string[],
  dropStatements: string[],
  envImports: string[],
  loadModuleLines: string[],
  allUnreplacedModules: any[]
};

/**
 * Object detail to write SQL scripts out to the file system.
 *
 * @typeParam tmpDir - The base directory where the files get saved to
 * @typeParam moduleStorageTableName - The table the the third party library JS files getting loaded into
 * @typeParam loadModuleLines - A list of lines to get appended to the moduelLoader.js file.
 * @typeParam createMleObjects - The list of DDL statements to create mle modules and the environment
 * @typeParam dropMleObjects -  The list of DDL statements to drop mle modules and the environment
 */
export type SaveScriptDetails = {
  tmpDir: string,
  moduleStorageTableName: string,
  loadModuleLines: string[],
  createMleObjects: string[],
  dropMleObjects: string[]
};

/**
 * A module and corresponding placeholders that weren't substituted
 *
 * @typeParam name - The name of the module being processed
 * @typeParam unreplacedList - The list of placeholders in the module that weren't replaced. Usually these are in the format `/npm/module@version/+esm`
 */
export type UnreplacedModule = {
  name: string,
  unreplacedList: string[]
};

/**
 * The details of an additional path in for the specified module. Usually modules
 * refer to the index.ts, but there are some modules that have different entry points.
 *
 * @typeParam moduleName - The name that should be used for the module name in
 *   the substitution. It shoule be different from the key.
 * @typeParam relativePath - The relative path to the library. This is the path
 *   that appears in the URL after the version e.g. module@1.0.0/<relativePath>
 */
type AdditionalModuleLibrary = {
  relativePath: string,
  moduleName: string
};

/**
 * Dynamic structure of all the modules that have a seconary entry point and require
 * an additional module to be loaded.
 *
 * @typeParam module - The name of the undelying module that has a second entry point
 *   library.
 */
export type AdditionalModuelPaths = {
  [module: string]: AdditionalModuleLibrary[]
};