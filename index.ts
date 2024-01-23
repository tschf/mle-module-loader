import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { program } from "commander";

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
  let envImports = [];

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

    for (let pkgVer of packageList){
      const substitutePackageInfo = splitPackageVersion(pkgVer);

      // don't do anything on self
      if (substitutePackageInfo.name !== packageInfo.name){
        // console.log(`Substituting ${substitutePackageInfo.name}`);
        moduleText = moduleText.replace(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}/+esm`, substitutePackageInfo.name);
      }
    }

    const fileContents = `${fileHeader}\n${moduleText}\n/\n`;
    await writeFile(join(pkgTmpDir, `${packageInfo.name}.sql`), fileContents);

  }

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
