import type {
  AdditionalModuelPaths,
  ProcessModuleDetails,
  SaveScriptDetails,
  UnreplacedModule
} from './lib/types';

import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { program } from "commander";

import { logger, forcedInfo } from "./logger";

// Most of the time there is a single module entry point, but some modules have
// secondary entrypoint. This object is to configure any such cases. The structure
// of this object is:
// "Key" = the node module name
// "Value->relativePath" = the path to the entrypoint
// "Value->moduleName" = The name referenced in the scripts and how it gets compiled in the DB
const additionalModulePaths: AdditionalModuelPaths = {
  "entities": [
    {
      "relativePath": "lib/decode.js/+esm",
      "moduleName": "entities_decode"
    }
  ]
};

function splitPackageVersion(pkgVer: string){

  const nameVerSplit: Array<string> = pkgVer.split("@");

  // replace hyphens in the name so it works in the database.
  const targetName = nameVerSplit[0].replace(/-/g, "_");

  return {
    "originalName": nameVerSplit[0],
    "name": targetName,
    "version": nameVerSplit[1]
  };
}

/**
 * Get a list of depenencies for the specied `moduleName`. This uses the
 * `npm-remote-ls` package - had to do this as a process call rather than inline
 * API call since the API doesn't support some options that are available to the
 * command execution.
 *
 * @privateRemarks
 *
 * The `npm-remote-ls` package is not maintained since a long time now, so we need
 * to find a better approach to get this data.
 *
 * @param moduleName - The module to generate the scipts for
 * @returns The full list of dependencies for the specified `moduleName`. Excludes
 *   dev dependencies
 */
async function getDependencies(moduleName: string): Promise<string[]>{
  // Did as a process instead of using the API direct as some of the flags exposed
  // in the command don't seem to be exposed to the API, such as excluding development
  // dependencies.
  const command = `bunx npm-remote-ls ${moduleName} --development false --flatten --optional false`;
  logger.info(`Command to be run: ${command}`);

  const proc = Bun.spawn(command.split(" "), {})
  const procStdOut = await new Response(proc.stdout).text();

  // The output of the command quotes using single quotes instead of double quotes
  // which is not valid JSON, so we need to replace `'` with `"`
  logger.info(`Command output: ${procStdOut}`)
  const packageList: string[] = JSON.parse(procStdOut.replace(/'/g, '"'));
  forcedInfo(`Found dependency list: ${packageList}`);

  return packageList;
}

/**
 * Write out the DDL to the filesystem so the scripts can be executed, ready to
 * be used.
 *
 * @param tmpDir - The base directory where the files get saved to
 * @param moduleStorageTableName - The table the the third party library JS files getting loaded into
 * @param loadModuleLines - A list of lines to get appended to the moduelLoader.js file.
 * @param createMleObjects - The list of DDL statements to create mle modules and the environment
 * @param dropMleObjects -  The list of DDL statements to drop mle modules and the environment
 */
async function saveSqlScripts({ tmpDir, moduleStorageTableName, loadModuleLines, createMleObjects, dropMleObjects }: SaveScriptDetails){
  // Get the contents of the module loader script (that loads the modules into a table)
  // Before copying it, we will update all the data. Doing this so we can write
  // out in one hit - rather than using the file writer to write line by line.
  const moduleScriptTemplate = Bun.file(join(import.meta.dir, "dist", "moduleLoader.js"));
  const moduleScriptContent = await moduleScriptTemplate.text();

  // Set up the target file (where were we copy the template script to) and write
  // out the template + all the function calls to load each JS file
  const moduleScriptPath = join(tmpDir, "moduleLoader.js");

  const targetTableAssignment = `var targetTableName = "${moduleStorageTableName}";`;

  // The contents of the module script should be the existing contents, appended
  // with the variable that specified the target table and then all the lines that
  // load a specific module into the table e.g. `loadModuleContent(..).
  // Separated by a blank lines so viewing the file is nicer to read.
  const orderedModuleScriptContent = [
    moduleScriptContent,
    targetTableAssignment,
    ...loadModuleLines
  ].join("\n");

  const moduleScript = Bun.file(moduleScriptPath);
  await Bun.write(moduleScript, orderedModuleScriptContent);
  logger.info(`Written module script to ${moduleScriptPath}`);

  // Create installer script - this esentially works through the following components:
  // * Create table
  // * Load module JS files into that table
  // * Define the corresponding MLE modules
  // * Define the MLE environment which includes all the imports for the above modules
  // * Drop the table
  const createTableStatement = `create table ${moduleStorageTableName} (
  module_name varchar2(200),
  module_version varchar2(10),
  module_content blob
);`;
  const runScriptStatement = `script ${moduleScriptPath}`;
  const dropTableStatement = `drop table ${moduleStorageTableName} purge;`

  const orderedInstallStatements = [
    createTableStatement,
    runScriptStatement,
    ...createMleObjects,
    dropTableStatement
  ].join("\n\n");

  const installScript = Bun.file(join(tmpDir, "install.sql"));
  await Bun.write(installScript, orderedInstallStatements);

  const removeScript = Bun.file(join(tmpDir, "remove.sql"));
  await Bun.write(removeScript, dropMleObjects.join("\n"));
}

function getModuleStorageTableName(): string {
  // We need to declare a variable for the table name where we load the modules
  // to as an intermediary step before creating the module. To avoid any clashes,
  // we are generating a random tokn to append to the string `module_loader_`.
  // note: The table spec specifies columns "module_version", "module_name" and
  // "module_content". This table ultimately gets dropped at the end of the process
  // via install.sql
  const randomToken = (Math.random() + 1).toString(36).substring(5);
  const moduleStorageTableName = `module_loader_${randomToken}`;
  logger.info(`Table to load modules to "${moduleStorageTableName}"`);

  return moduleStorageTableName;
}

/**
 * Saves the module to the file system. After fetching the module, loops through
 * the other depencies to update any import statements. By default the import statements
 * use the `/npm/module@version/+esm` syntax. When we compile them into the database,
 * they get their simple module name - so these references need to be updated.
 *
 * @param moduleName - The module name as it is compiled to the database
 * @param originalModuleName - The original module name. Key difference is could
 *   contain hyphens (-), but module name in the db replaced it to underscore (_)
 * @param moduleVersion - The version of the module
 * @param modulePath - Custom path to a source file in the URL. Mose modules
 *   don't specify a path, and use the `index.ts` but there are some that have a
 *   secondary reference file, so thie caters to those
 * @param outputPath - The path where the module script (the JS file) gets saved to
 * @param packageList - The full package list of depenencies of the primary module being processed
 * @param moduleStorageTableName - The table name where the module source will get
 *   loaded into
 * @param createStatements - All the create statement (mle module and mle env DDL's)
 * @param dropStatements - All the drop statements (mle module and mle env DDL's)
 * @param envImports - All the modules that need to be specified on the import
 *  statement for the environment DDL
 * @param loadModuleLines - The lines that get added to the loadModule.js SQLcl script
 *   file
 * @param allUnreplacedModules - Any module that didn't get replaced. Most likely
 *   scenario is it is a custom path that hasn't been accounted for.
 */
async function processModule({
  moduleName,
  originalModuleName,
  moduleVersion,
  modulePath,
  outputPath,
  packageList,
  moduleStorageTableName,
  createStatements,
  dropStatements,
  envImports,
  loadModuleLines,
  allUnreplacedModules }
  :
   ProcessModuleDetails){

  const requestUrl =
  modulePath
    ? `https://cdn.jsdelivr.net/npm/${originalModuleName}@${moduleVersion}/${modulePath}`
    : `https://cdn.jsdelivr.net/npm/${originalModuleName}@${moduleVersion}/+esm`;
  logger.info(`Processing ${moduleName} from ${requestUrl}`);

  // https://bun.sh/guides/http/fetch
  const moduleResponse = await fetch(requestUrl);
  let moduleText = await moduleResponse.text();

  for(let pkgVer of packageList){
    const substitutePackageInfo = splitPackageVersion(pkgVer);

    // Only do a substitution in the module if it's not the current module being
    // processed
    if (substitutePackageInfo.name !== moduleName){
      logger.info(`Updating references to ${substitutePackageInfo.name} in ${moduleName} (if any)`);
      moduleText = moduleText.replaceAll(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}/+esm`, substitutePackageInfo.name);
    }

    // For our "known" modules with additional file paths, do a replacement on
    // those in our file
    for (let override of additionalModulePaths[substitutePackageInfo.originalName] || []){
      const originalModuleText = moduleText;
      moduleText = moduleText.replaceAll(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}/${override.relativePath}`, override.moduleName);

      // Was our module modified with a substition? If yes it means one of our
      // overrides was specified in this file - and we need to track that in our
      // module imports/environment
      if (originalModuleText != moduleText){
        await processModule({
          moduleName: override.moduleName,
          originalModuleName: substitutePackageInfo.originalName,
          modulePath: override.relativePath,
          moduleVersion: substitutePackageInfo.version,
          packageList,
          moduleStorageTableName,
          createStatements,
          dropStatements,
          outputPath,
          envImports,
          loadModuleLines,
          allUnreplacedModules
        });
      }
    }
  }

  // Write the file out to our tmpDir/js
  // Write the file out
  const moduleFilePath = join(outputPath, `${moduleName}.js`);
  await writeFile(moduleFilePath, moduleText);

  // Set up line to load the module into our table
  const loadModuleLine = `loadModule("${moduleFilePath}", "${moduleName}", "${moduleVersion}");`;
  loadModuleLines.push(loadModuleLine);

  // DDL to create the module (we later push into install.sql)
  const createModuleStatement = `create or replace mle module ${moduleName}
language javascript
version '${moduleVersion}'
using blob(
  select module_content
  from ${moduleStorageTableName}
  where module_name = '${moduleName}'
  and module_version = '${moduleVersion}'
)
/`;
  createStatements.push(createModuleStatement);

  // DDL to drop the module (we later push into remove.sql)
  const dropModuleStatement = `drop mle module ${moduleName};`;
  dropStatements.push(dropModuleStatement);

  envImports.push(`'${moduleName}' module ${moduleName}`);

  // Do a check on the module we saved to see if we missed and dependency references.
  // This will be typically referenced in the format `/npm/package@1.0.0/+esm`.
  const moduleSpecifier = new RegExp("\\/npm\\/.+?\\/\\+esm", "g");
  const unreplacedModules = Array.from(moduleText.matchAll(moduleSpecifier));

  if (unreplacedModules.length >= 1){
    allUnreplacedModules.push({"name": moduleName, "unreplacedList": unreplacedModules});
  }
}

async function app(moduleName: string){

  const pkgTmpDir = await mkdtemp(join(tmpdir(), `${moduleName}-`));
  const moduleStorageTableName = getModuleStorageTableName();

  // We will store all the raw JS modules we download in a `js` folder, so create
  // that directory
  const jsPath = join(pkgTmpDir, "js");
  await mkdir(jsPath);

  const moduleScriptLines: string[] = [];
  let installLines = "";
  // Push each create statement into an array
  const createStatements: string[] = [];

  // Get the list of package this `moduleName` depends on.
  const packageList: string[] = await getDependencies(moduleName);

  let removeLines = "";
  const dropStatements: string[] = [];
  const envImports: string[] = [];

  // We need an array to keep track of modules that weren't replace. After we do
  // the replace, we search the module text again to look for references to a module
  // which is typically in the format `/npm/modual@version/+esm`. The main case
  // for this is if a module provides a separately pathed module.
  const allUnreplacedModules: UnreplacedModule[] = [];

  for (let pkgVer of packageList) {
    const packageInfo = splitPackageVersion(pkgVer);
    logger.info(`Processing ${packageInfo.name}@${packageInfo.version}`);

    await processModule({
      moduleName: packageInfo.name,
      originalModuleName: packageInfo.originalName,
      moduleVersion: packageInfo.version,
      packageList,
      moduleStorageTableName,
      createStatements,
      dropStatements,
      outputPath: jsPath,
      envImports,
      loadModuleLines: moduleScriptLines,
      allUnreplacedModules
    });

  }

  const createEnvStatement = `create or replace mle env ${moduleName}_env
imports (
  ${envImports.join(",\n  ")}
);`;
  createStatements.push(createEnvStatement);

  // Something went wrong, and there are still some /npm/module@ver/+esm references
  // in the module being output.
  if (allUnreplacedModules.length >= 1){
    const asString = allUnreplacedModules.map(obj => { return `${obj.name}: ${obj.unreplacedList.join(", ")}` })
    logger.warn(`Not all modules were updated correctly. Please review\n${asString.join("\n")}`);
  }

  const dropEnvStatement = `drop mle env ${moduleName}_env;\n`;
  dropStatements.push(dropEnvStatement);

  await saveSqlScripts({
    tmpDir: pkgTmpDir,
    moduleStorageTableName,
    loadModuleLines: moduleScriptLines,
    createMleObjects: createStatements,
    dropMleObjects: dropStatements
  });

  logger.info(`Dependency download complete. Files located at ${pkgTmpDir}`);
  forcedInfo(`Run ${pkgTmpDir}/install.sql in SQLcl to compile MLE objects to the database.`);
}

program
  .name("mle-module-loader")
  // TODO: Hard-coded linkedom for development. Remove once MVP complete
  .requiredOption("-n, --name <moduleName>", "NPM module name", "linkedom")
  .option("-v, --verbose", "Verbose", false)
  .version("1.0.0")

program.parse();

const opts = program.opts();

// If running in verbose mode, change the default log level (warn) so that we get
// all info messages
if (opts.verbose){
  logger.level = "info";
}

app(opts.name);
