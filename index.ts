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
      "relativePath": "/lib/decode.js/+esm",
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

async function saveFiles({ tmpDir, loadModuleLines, createMleObjects, dropMleObjects, envImports }){
  // Get the contents of the module loader script (that loads the modules into a table)
  // Before copying it, we will update all the data. Doing this so we can write
  // out in one hit - rather than using the file writer to write line by line.
  const moduleScriptTemplate = Bun.file(join(import.meta.dir, "dist", "moduleLoader.js"));
  let moduleScriptContent = await moduleScriptTemplate.text();

  // Set up the target file (where were we copy the template script to) and write
  // out the template + all the function calls to load each JS file
  const moduleScriptPath = join(tmpDir, "moduleLoader.js");

  // We need to declare a variable for the table name where we load the modules
  // to as an intermediary step before creating the module. To avoid any clashes,
  // we are generating a random tokn to append to the string `module_loader_`.
  // note: The table spec specifies columns "module_version", "module_name" and
  // "module_content". This table ultimately gets dropped at the end of the process
  // via install.sql
  const randomToken = (Math.random() + 1).toString(36).substring(5);
  const moduleStorageTableName = `module_loader_${randomToken}`;
  logger.info(`Table to load modules to "${moduleStorageTableName}"`);
  moduleScriptContent += `var targetTableName = "${moduleStorageTableName}";\n\n`;

  moduleScriptContent += loadModuleLines;

  const moduleScript = Bun.file(moduleScriptPath);
  await Bun.write(moduleScript, moduleScriptContent);
  logger.info(`Written module script to ${moduleScriptPath}`);

  // Create installer script - this esentially works through the following components:
  // * Create table
  // * Load module JS files into that table
  // * Define the corresponding MLE modules
  // * Define the MLE environment which includes all the imports for the above modules
  // * Drop the table
  let installLines = "";
  installLines += `create table ${moduleStorageTableName} (
  module_name varchar2(200),
  module_version varchar2(10),
  module_content blob
);\n\n`;
  installLines += `script ${moduleScriptPath}\n\n`;
  createMleObjects = createMleObjects.replaceAll("xxTARGET_TABLExx", moduleStorageTableName);
  installLines += createMleObjects;
  installLines += `drop table ${moduleStorageTableName} purge;\n`

  const installScript = Bun.file(join(tmpDir, "install.sql"));
  await Bun.write(installScript, installLines);

  const removeScript = Bun.file(join(tmpDir, "remove.sql"));
  await Bun.write(removeScript, dropMleObjects);
}

async function app(moduleName: string){

  const pkgTmpDir = await mkdtemp(join(tmpdir(), `${moduleName}-`));

  // We will store all the raw JS modules we download in a `js` folder, so create
  // that directory
  const jsPath = join(pkgTmpDir, "js");
  await mkdir(jsPath);

  let moduleScriptLines = "";
  let installLines = "";

  // Get the list of package this `moduleName` depends on.
  const packageList: string[] = await getDependencies(moduleName);

  let removeLines = "";
  const envImports = [];

  // We need an array to keep track of modules that weren't replace. After we do
  // the replace, we search the module text again to look for references to a module
  // which is typically in the format `/npm/modual@version/+esm`. The main case
  // for this is if a module provides a separately pathed module.
  const allUnreplacedModules = [];

  for (let pkgVer of packageList) {
    const packageInfo = splitPackageVersion(pkgVer);
    logger.info(`Processing {packageInfo.name}@${packageInfo.version}`);

    installLines += `create or replace mle module ${packageInfo.name}
language javascript
version '${packageInfo.version}'
using blob(select module_content from xxTARGET_TABLExx where module_name = '${packageInfo.name}' and module_version = '${packageInfo.version}')
/\n\n`;
    removeLines += `drop mle module ${packageInfo.name};\n`;
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
    moduleScriptLines += `loadModule("${moduleFilePath}", "${packageInfo.name}", "${packageInfo.version}");\n`;

    // Do a check on the module we saved to see if we missed and dependency references.
    // This will be typically referenced in the format `/npm/package@1.0.0/+esm`.
    const moduleSpecifier = new RegExp("\\/npm\\/.+?\\/\\+esm", "g");
    const unreplacedModules = Array.from(moduleText.matchAll(moduleSpecifier));

    if (unreplacedModules.length >= 1){
      allUnreplacedModules.push({"name": packageInfo.name, "unreplacedList": unreplacedModules});
    }

  }

  installLines += `create or replace mle env ${moduleName}_env\nimports (\n${envImports.join(",\n")}\n);\n\n`;

  // Something went wrong, and there are still some /npm/module@ver/+esm references
  // in the module being output.
  if (allUnreplacedModules.length >= 1){
    const asString = allUnreplacedModules.map(obj => { return `${obj.name}: ${obj.unreplacedList.join(", ")}` })
    logger.warn(`Not all modules were updated correctly. Please review\n${asString.join("\n")}`);
  }

  removeLines += `drop mle env ${moduleName}_env;\n`;

  saveFiles({
    tmpDir: pkgTmpDir,
    loadModuleLines: moduleScriptLines,
    createMleObjects: installLines,
    dropMleObjects: removeLines,
    envImports
  });

  // installOutput.write(installLines);
  // installOutput.write(`${envContents}\n\n`);
  // installOutput.write(`);
  // await writeFile(join(pkgTmpDir, `remove.sql`), removeLines);

  forcedInfo(`Run ${pkgTmpDir}/install.sql to compile MLE objects to the database.`);

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
