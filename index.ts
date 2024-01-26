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
const additionalModulePaths = {
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

// Get a list of depenencies for the specied `moduleName`. This uses the
// `npm-remote-ls` package - had to do this as a process call rather than inline
// API call since the API doesn't support some options that are available to the
// command execution.
// TODO: this package is not maintained since a long time now, so we need to find
// a better approach
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
  const packageList: string[] = JSON.parse(procStdOut.replace(/'/g, '"'));
  forcedInfo(`Found dependency list: ${packageList}`);

  return packageList;
}

async function saveSqlScripts({ tmpDir, moduleStorageTableName, loadModuleLines, createMleObjects, dropMleObjects }){
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
  const allUnreplacedModules = [];

  for (let pkgVer of packageList) {
    const packageInfo = splitPackageVersion(pkgVer);
    logger.info(`Processing ${packageInfo.name}@${packageInfo.version}`);

    const createModuleStatement = `create or replace mle module ${packageInfo.name}
language javascript
version '${packageInfo.version}'
using blob(
  select module_content
  from ${moduleStorageTableName}
  where module_name = '${packageInfo.name}'
  and module_version = '${packageInfo.version}'
)
/`;
    createStatements.push(createModuleStatement);

    const dropModuleStatement = `drop mle module ${packageInfo.name};`;
    dropStatements.push(dropModuleStatement);

    envImports.push(`'${packageInfo.name}' module ${packageInfo.name}`);

    // https://bun.sh/guides/http/fetch
    const moduleResponse = await fetch(`https://cdn.jsdelivr.net/npm/${packageInfo.originalName}@${packageInfo.version}/+esm`);
    let moduleText = await moduleResponse.text();

    // For each of the known dependencies, check for a reference in the file being
    // processed. References go into module in the format: /npm/module_name@version/+esm
    for (let pkgVer of packageList){
      const substitutePackageInfo = splitPackageVersion(pkgVer);

      // don't do anything on self
      if (substitutePackageInfo.name !== packageInfo.name){
        // logger.info(`Substituting ${substitutePackageInfo.name}`);
        moduleText = moduleText.replaceAll(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}/+esm`, substitutePackageInfo.name);
      }

      // Loop over additional module paths to see if references exist in the current
      // file being processed. Fall back to an empty array to gracefully continue
      // through.
      for (let override of additionalModulePaths[substitutePackageInfo.originalName] || []){
        const originalModuleText = moduleText;
        moduleText = moduleText.replaceAll(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}${override.relativePath}`, override.moduleName);

        // Was our module modified with a substition? If yes it means one of our
        // overrides was specified in this file - and we need to track that in our
        // module imports/environment
        if (originalModuleText != moduleText) {
          envImports.push(`'${override.moduleName}' module ${override.moduleName}`);
          // TODO: Restructure the program so we can handle the fetch of this
          // additional module
          logger.warn(`Additional module ${override.moduleName} needs be manually downloaded: https://cdn.jsdelivr.net/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}${override.relativePath}`);
        }
      }
    }

    // Write the file out
    const moduleFilePath = join(jsPath, `${packageInfo.name}.js`);
    await writeFile(moduleFilePath, moduleText);

    const loadModuleLine = `loadModule("${moduleFilePath}", "${packageInfo.name}", "${packageInfo.version}");`;
    moduleScriptLines.push(loadModuleLine);

    // Do a check on the module we saved to see if we missed and dependency references.
    // This will be typically referenced in the format `/npm/package@1.0.0/+esm`.
    const moduleSpecifier = new RegExp("\\/npm\\/.+?\\/\\+esm", "g");
    const unreplacedModules = Array.from(moduleText.matchAll(moduleSpecifier));

    if (unreplacedModules.length >= 1){
      allUnreplacedModules.push({"name": packageInfo.name, "unreplacedList": unreplacedModules});
    }

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
