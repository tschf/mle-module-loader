import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

async function app(){
  const pkgTmpDir = await mkdtemp(join(tmpdir(), "linkedom-"))

  const proc = Bun.spawn(["bunx", "npm-remote-ls", "linkedom", "--development", "false", "--flatten", "--optional", "false"], {})

  const processStdOut = await new Response(proc.stdout).text();
  const packageList = JSON.parse(processStdOut.replace(/'/g, '"'));
  console.log(packageList);

  let installLines = "set define off\n\n";
  let removeLines = "";
  let envImports = [];

  for (let pkgVer of packageList) {
    // if (pkgVer === "linkedom@0.16.8"){
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
        console.log(`Substituting ${substitutePackageInfo.name}`);
        moduleText = moduleText.replace(`/npm/${substitutePackageInfo.originalName}@${substitutePackageInfo.version}/+esm`, substitutePackageInfo.name);
      }
    }

    const fileContents = `${fileHeader}\n${moduleText}\n/\n`;
    await writeFile(join(pkgTmpDir, `${packageInfo.name}.sql`), fileContents);

  }

  installLines += `\n@@linkedom_env.sql\n`;
  removeLines += `drop mle env linkedom_env;\n`;
  const envContents = `create or replace mle env linkedom_env\nimports (\n${envImports.join(",\n")}\n);`;

  await writeFile(join(pkgTmpDir, `_install.sql`), installLines);
  await writeFile(join(pkgTmpDir, `_remove.sql`), removeLines);
  console.log("Writing to linkedom_env.sql");
  await writeFile(join(pkgTmpDir, `linkedom_env.sql`), envContents);

  console.log(`Scripts written to ${pkgTmpDir}. Ready to compile to the DB`);

}

app();
