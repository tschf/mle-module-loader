import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { program } from "commander";

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
  const pkgTmpDir = await mkdtemp(join(tmpdir(), `${moduleName}-`))

  // Did as a process instead of using the API direct as some of the flags exposed
  // in the command don't seem to be exposed to the API, such as excluding development
  // dependencies.
  const proc = Bun.spawn(["bunx", "npm-remote-ls", moduleName, "--development", "false", "--flatten", "--optional", "false"], {})

  const processStdOut = await new Response(proc.stdout).text();

  // The output of the command quotes using single quotes instead of double quotes
  // which is not valid JSON, so we need to replac those characters.
  const packageList = JSON.parse(processStdOut.replace(/'/g, '"'));
  console.log(packageList);

  let installLines = "set define off\n\n";
  let removeLines = "";
  const envImports = [];
  const allUnreplacedModules = [];

  for (let pkgVer of packageList) {
    const packageInfo = splitPackageVersion(pkgVer);
    installLines += `@@${packageInfo.name}.sql\n`;
    removeLines += `drop mle module ${packageInfo.name};\n`;
    envImports.push(`'${packageInfo.name}' module ${packageInfo.name}`);

    const fileHeader = `create or replace mle module ${packageInfo.name}\nlanguage javascript\nversion '${packageInfo.version}'\nas\n\n`;

    console.log(`Name=${packageInfo.name} & Version=${packageInfo.version}`);

    // https://bun.sh/guides/http/fetch
    const moduleResponse = await fetch(`https://cdn.jsdelivr.net/npm/${packageInfo.originalName}@${packageInfo.version}/+esm`);
    let moduleText = await moduleResponse.text();

    // For each of the known dependencies, check for a reference in the file being
    // processed.
    for (let pkgVer of packageList){
      const substitutePackageInfo = splitPackageVersion(pkgVer);

      // don't do anything on self
      if (substitutePackageInfo.name !== packageInfo.name){
        // console.log(`Substituting ${substitutePackageInfo.name}`);
        moduleText = moduleText.replaceAll(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}/+esm`, substitutePackageInfo.name);
      }

      for (let override of additionalModulePaths[substitutePackageInfo.originalName] || []){
        const originalModuleText = moduleText;
        moduleText = moduleText.replaceAll(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}${override.relativePath}`, override.moduleName);

        if (originalModuleText != moduleText) {
          envImports.push(`'${override.moduleName}' module ${override.moduleName}`);
          console.warn(`Additional module ${override.moduleName} needs be manually downloaded: https://cdn.jsdelivr.net/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}${override.relativePath}`);
        }
      }
    }

    // After doing the replace, search the contents to make sure there doesn't
    // still exist any strings with /npm/package@1.0.0/+esm.
    const moduleSpecifier = new RegExp("\\/npm\\/.+?\\/\\+esm", "g");
    const unreplacedModules = Array.from(moduleText.matchAll(moduleSpecifier));
    // allUnreplacedModules.push(...unreplacedModules);
    if (unreplacedModules.length >= 1){
      allUnreplacedModules.push({"name": packageInfo.name, "unreplacedList": unreplacedModules});
    }
    const fileContents = `${fileHeader}\n${moduleText}\n/\n`;
    await writeFile(join(pkgTmpDir, `${packageInfo.name}.sql`), fileContents);

  }


  if (allUnreplacedModules.length >= 1){
    const asString = allUnreplacedModules.map(obj => { return `${obj.name}: ${obj.unreplacedList.join(", ")}` })
    console.warn(`Not all modules were updated correctly. Please review\n${asString.join("\n")}`);
  }
  // console.log(allUnreplacedModules[0]);

  installLines += `\n@@${moduleName}_env.sql\n`;
  removeLines += `drop mle env ${moduleName}_env;\n`;
  const envContents = `create or replace mle env ${moduleName}_env\nimports (\n${envImports.join(",\n")}\n);`;

  await writeFile(join(pkgTmpDir, `_install.sql`), installLines);
  await writeFile(join(pkgTmpDir, `_remove.sql`), removeLines);
  console.log(`Writing to ${moduleName}_env.sql`);
  await writeFile(join(pkgTmpDir, `${moduleName}_env.sql`), envContents);

  console.log(`Scripts written to ${pkgTmpDir}. Ready to compile to the DB`);

}

program
  .name("mle-module-loader")
  // TODO: Hard-coded linkedom for development. Remove once MVP complete
  .requiredOption("-n, --name <moduleName>", "NPM module name", "linkedom")
  .version("1.0.0")

program.parse();

const opts = program.opts();

app(opts.name);
