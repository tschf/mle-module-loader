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

async function app(moduleName: string){
  // Create a temp directory. We use the prefix of the module name we are processing
  // e.g. With module linkedom, it becomes something like `/tmp/linkedom-0kePoK`
  const pkgTmpDir = await mkdtemp(join(tmpdir(), `${moduleName}-`));

  // We will store all the raw JS modules we download in a `js` folder, so create
  // that directory
  await mkdir(join(pkgTmpDir, "js"));

  // Did as a process instead of using the API direct as some of the flags exposed
  // in the command don't seem to be exposed to the API, such as excluding development
  // dependencies.
  const proc = Bun.spawn(["bunx", "npm-remote-ls", moduleName, "--development", "false", "--flatten", "--optional", "false"], {})

  const processStdOut = await new Response(proc.stdout).text();

  // The output of the command quotes using single quotes instead of double quotes
  // which is not valid JSON, so we need to replac those characters.
  const packageList = JSON.parse(processStdOut.replace(/'/g, '"'));
  forcedInfo(`Found dependency list: ${packageList}`);

  let installLines = "set define off\n\n";
  let removeLines = "";
  const envImports = [];
  const allUnreplacedModules = [];

  for (let pkgVer of packageList) {
    const packageInfo = splitPackageVersion(pkgVer);
    installLines += `@@${packageInfo.name}.sql\n`;
    removeLines += `drop mle module ${packageInfo.name};\n`;
    envImports.push(`'${packageInfo.name}' module ${packageInfo.name}`);

    logger.info(`Name=${packageInfo.name} & Version=${packageInfo.version}`);

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

    // After doing the replace, search the contents to make sure there doesn't
    // still exist any strings with /npm/package@1.0.0/+esm.
    const moduleSpecifier = new RegExp("\\/npm\\/.+?\\/\\+esm", "g");
    const unreplacedModules = Array.from(moduleText.matchAll(moduleSpecifier));

    if (unreplacedModules.length >= 1){
      allUnreplacedModules.push({"name": packageInfo.name, "unreplacedList": unreplacedModules});
    }
    await writeFile(join(pkgTmpDir, "js", `${packageInfo.name}.js`), moduleText);
  }

  // Something went wrong, and there are still some /npm/module@ver/+esm references
  // in the module being output.
  if (allUnreplacedModules.length >= 1){
    const asString = allUnreplacedModules.map(obj => { return `${obj.name}: ${obj.unreplacedList.join(", ")}` })
    logger.warn(`Not all modules were updated correctly. Please review\n${asString.join("\n")}`);
  }

  installLines += `\n@@${moduleName}_env.sql\n`;
  removeLines += `drop mle env ${moduleName}_env;\n`;
  const envContents = `create or replace mle env ${moduleName}_env\nimports (\n${envImports.join(",\n")}\n);`;

  await writeFile(join(pkgTmpDir, `_install.sql`), installLines);
  await writeFile(join(pkgTmpDir, `_remove.sql`), removeLines);
  logger.info(`Writing to ${moduleName}_env.sql`);
  await writeFile(join(pkgTmpDir, `${moduleName}_env.sql`), envContents);

  forcedInfo(`Scripts written to ${pkgTmpDir}. Ready to compile to the DB`);

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
